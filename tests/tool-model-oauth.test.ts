import assert from "node:assert/strict";
import test from "node:test";
import { LoadAPIKeyError } from "@ai-sdk/provider";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, ProviderConfig } from "../src/config/schema.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { createModelSettings, createProviderCredentialPersistence } from "../src/llm/modelFactory.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { CODEX_OAUTH_TOKEN_ENDPOINT } from "../src/llm/subscriptionAuth.js";
import { resolveToolModelCandidates } from "../src/llm/toolModel.js";
import { generateToolModelText, toolModelFailureScope } from "../src/llm/toolModelRequest.js";

const accessToken = "fixture-access-token";
const refreshToken = "fixture-refresh-token";
const renewedAccessToken = "fixture-renewed-access-token";
const renewedRefreshToken = "fixture-renewed-refresh-token";

function configuration(overrides: Partial<ProviderConfig> = {}): AgentConfig {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "subscription",
    providers: {
      subscription: {
        type: "openai-codex", baseUrl: "https://subscription.example.test/v1", requiresApiKey: false,
        apiKey: accessToken, authMode: "oauth-bearer",
        oauth: { provider: "openai-codex", refreshToken, expiresAt: 1 },
        ...overrides
      }
    },
    models: { subscription: { provider: "subscription", model: "fixture-model" } },
    thinking: { enabled: false, effort: "medium" }
  });
}

function textResponse(text: string): Response {
  const message = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "fixture-response", created_at: 1, model: "fixture-model", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: "fixture-response", created_at: 1, model: "fixture-model", status: "completed", output: [message], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function tokenResponse(): Response {
  return Response.json({ access_token: renewedAccessToken, refresh_token: renewedRefreshToken, expires_in: 3600 });
}

test("OAuth 缺少访问和刷新令牌时，免 API key 配置也不能使模型可用", () => {
  const config = configuration({ apiKey: undefined, oauth: { provider: "openai-codex", expiresAt: Date.now() + 3_600_000 } });
  assert.equal(new ProviderRegistry(config).require("subscription").isConfigured(), false);
  assert.deepEqual(resolveToolModelCandidates(config), []);
  assert.throws(() => createModelSettings(config), /subscription.*登录.*缺失/u);
});

test("已过期且无法续期的 OAuth 模型不进入自动候选，报错指出具体连接", () => {
  const config = configuration({ oauth: { provider: "openai-codex", expiresAt: 1 } });
  assert.deepEqual(resolveToolModelCandidates(config), []);
  assert.throws(() => createModelSettings(config), /subscription.*登录.*过期.*重新登录/u);
});

test("访问令牌仍有效时辅助请求不刷新登录", async () => {
  const config = configuration({ oauth: { provider: "openai-codex", expiresAt: Date.now() + 3_600_000 } });
  const calls: string[] = [];
  const model = createModelSettings(config, "subscription", async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${accessToken}`);
    return textResponse("ready");
  }).model;
  assert.equal((await generateNativeText(model, [{ role: "user", content: "fixture" }])).text, "ready");
  assert.deepEqual(calls, ["https://subscription.example.test/v1/responses"]);
});

test("辅助模型先续期过期 OAuth，再使用新令牌请求并保存轮换后的凭据", async () => {
  const config = configuration();
  const calls: string[] = [];
  const saved: ProviderConfig[] = [];
  const model = createModelSettings(config, "subscription", async (input, init) => {
    calls.push(String(input));
    if (String(input) === CODEX_OAUTH_TOKEN_ENDPOINT) {
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), refreshToken);
      return tokenResponse();
    }
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${renewedAccessToken}`) return Response.json({ error: { code: "invalid_token" } }, { status: 401 });
    assert.equal(saved.length, 1, "轮换的刷新令牌必须在模型请求前持久化");
    return textResponse("renewed");
  }, { write: async (alias, previous, renewed) => {
    assert.equal(alias, "subscription");
    assert.equal(previous.apiKey, accessToken);
    saved.push(renewed);
    return renewed;
  } }).model;
  assert.equal((await generateNativeText(model, [{ role: "user", content: "fixture" }])).text, "renewed");
  assert.deepEqual(calls, [CODEX_OAUTH_TOKEN_ENDPOINT, "https://subscription.example.test/v1/responses"]);
  assert.equal(saved[0]?.apiKey, renewedAccessToken);
  assert.equal(saved[0]?.oauth?.refreshToken, renewedRefreshToken);
  assert.equal(config.providers.subscription?.apiKey, accessToken, "不得修改调用方持有的配置快照");
});

test("只有刷新令牌的 OAuth 仍能恢复访问令牌", async () => {
  const config = configuration({ apiKey: undefined });
  assert.equal(resolveToolModelCandidates(config).length, 1);
  const calls: string[] = [];
  const model = createModelSettings(config, "subscription", async (input, init) => {
    calls.push(String(input));
    if (String(input) === CODEX_OAUTH_TOKEN_ENDPOINT) return tokenResponse();
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${renewedAccessToken}`);
    return textResponse("restored");
  }).model;
  assert.equal((await generateNativeText(model, [{ role: "user", content: "fixture" }])).text, "restored");
  assert.deepEqual(calls, [CODEX_OAUTH_TOKEN_ENDPOINT, "https://subscription.example.test/v1/responses"]);
});

test("同一 Provider 的并行辅助请求共用一次续期，后续请求不再用旧令牌", async () => {
  const config = configuration();
  let refreshes = 0;
  const providers = new ProviderRegistry(config, [], undefined, undefined, async (input, init) => {
    if (String(input) === CODEX_OAUTH_TOKEN_ENDPOINT) { refreshes++; return tokenResponse(); }
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${renewedAccessToken}`);
    return textResponse("ready");
  });
  const first = providers.createModelSettings().model;
  const second = providers.createModelSettings().model;
  const messages = [{ role: "user" as const, content: "fixture" }];
  await Promise.all([generateNativeText(first, messages), generateNativeText(second, messages)]);
  await generateNativeText(first, messages);
  assert.equal(refreshes, 1);
});

test("刷新授权被拒绝时跳过整个连接，不发送过期令牌，仍可使用其他自动候选", async () => {
  const config = configuration();
  const calls: string[] = [];
  const model = createModelSettings(config, "subscription", async (input) => {
    calls.push(String(input));
    return Response.json({ error: { code: "invalid_grant" } }, { status: 401 });
  }).model;
  const healthy = createModelSettings(configuration({ apiKey: "fixture-healthy", oauth: { provider: "openai-codex", expiresAt: Date.now() + 3_600_000 } }), "subscription", async () => textResponse("healthy")).model;
  const result = await generateToolModelText([{ model, failureDomain: "expired" }, { model, failureDomain: "expired" }, { model: healthy, failureDomain: "healthy" }], [{ role: "user", content: "fixture" }]);
  assert.equal(result.text, "healthy");
  assert.deepEqual(calls, [CODEX_OAUTH_TOKEN_ENDPOINT]);
  assert.equal(result.attempts.length, 2);
});

test("显式 OAuth 候选刷新授权失效时保留具体连接错误，不改用其他账户", async () => {
  const model = createModelSettings(configuration(), "subscription", async () => Response.json({ error: "invalid_grant" }, { status: 400 })).model;
  await assert.rejects(generateToolModelText([{ model, failureDomain: "pinned" }], [{ role: "user", content: "fixture" }]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(String(error.cause), /subscription.*登录.*重新登录/u);
    return true;
  });
});

test("SDK 缺少 key 的错误归属连接，允许自动候选继续", () => {
  const error = new LoadAPIKeyError({ message: "Provider API key is missing." });
  assert.equal(toolModelFailureScope(error), "connection");
});

test("OAuth 续期网络故障不跨账户，取消不发模型请求", async () => {
  const network = new TypeError("fixture network failure");
  const model = createModelSettings(configuration(), "subscription", async () => { throw network; }).model;
  await assert.rejects(generateToolModelText([{ model, failureDomain: "first" }], [{ role: "user", content: "fixture" }]), /网络请求失败/u);
  const controller = new AbortController();
  let started!: () => void;
  const refreshing = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const cancelled = createModelSettings(configuration(), "subscription", async (input, init) => {
    calls.push(String(input));
    started();
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  }).model;
  const request = generateNativeText(cancelled, [{ role: "user", content: "fixture" }], { signal: controller.signal });
  const rejected = assert.rejects(request, { name: "AbortError" });
  await refreshing;
  controller.abort();
  await rejected;
  assert.deepEqual(calls, [CODEX_OAUTH_TOKEN_ENDPOINT]);
});

test("续期已返回轮换令牌时，取消仍保存已确认的新凭据并阻止模型请求", async () => {
  const controller = new AbortController();
  const saved: ProviderConfig[] = [];
  const calls: string[] = [];
  const model = createModelSettings(configuration(), "subscription", async (input) => {
    calls.push(String(input));
    controller.abort();
    return tokenResponse();
  }, { write: async (_alias, _previous, renewed) => { saved.push(renewed); return renewed; } }).model;
  assert.ok(model.prepareTextRequest);
  await assert.rejects(model.prepareTextRequest(controller.signal), { name: "AbortError" });
  assert.equal(saved[0]?.oauth?.refreshToken, renewedRefreshToken);
  assert.deepEqual(calls, [CODEX_OAUTH_TOKEN_ENDPOINT]);
});

test("续期只保存凭据，保留并发保存的模型选择；旧回合后续请求读取轮换凭据", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-oauth-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = new Map<string, string>();
  const store = createFileConfigStore(root, { globalDir: root, credentialStore: {
    persistent: true, get: async (account) => values.get(account),
    set: async (account, value) => { values.set(account, value); }, delete: async (account) => { values.delete(account); }
  } });
  const config = configuration();
  config.models.other = { provider: "subscription", model: "fixture-next-model" };
  await store.save(config);
  const credentials = createProviderCredentialPersistence(store, root);
  let refreshes = 0;
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === CODEX_OAUTH_TOKEN_ENDPOINT) {
      refreshes++;
      await updateConfig(store, root, (current) => ({ ...current, defaultModel: "other", toolModel: "other" }));
      return tokenResponse();
    }
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${renewedAccessToken}`);
    assert.equal(JSON.parse(String(init?.body)).model, "fixture-model", "凭据读取不得带入下个回合的模型选择");
    return textResponse("ready");
  };
  for (let index = 0; index < 2; index++) {
    const model = createModelSettings(config, "subscription", fetcher, credentials).model;
    assert.equal((await generateNativeText(model, [{ role: "user", content: "fixture" }])).text, "ready");
  }
  assert.equal(refreshes, 1);
  const persisted = await store.load();
  assert.equal(persisted.defaultModel, "other");
  assert.equal(persisted.toolModel, "other");
  assert.equal(persisted.providers.subscription?.oauth?.refreshToken, renewedRefreshToken);
  assert.equal(config.defaultModel, "subscription");
  assert.equal(config.providers.subscription?.apiKey, accessToken);

  await updateConfig(store, root, (current) => ({ ...current, providers: { ...current.providers, subscription: { ...current.providers.subscription!, oauth: { ...current.providers.subscription!.oauth!, expiresAt: 1 } } } }));
  const changed = createModelSettings(config, "subscription", async () => {
    await updateConfig(store, root, (current) => ({ ...current, providers: { ...current.providers, subscription: { ...current.providers.subscription!, apiKey: "fixture-external-login" } } }));
    return tokenResponse();
  }, credentials).model;
  await assert.rejects(generateNativeText(changed, [{ role: "user", content: "fixture" }]), /subscription.*凭据.*已改变/u);
  assert.equal((await store.load()).providers.subscription?.apiKey, "fixture-external-login", "续期写入不能覆盖其它客户端新保存的登录");
});

test("辅助任务复用聊天模型时仍持久化续期，主请求随后读取新凭据而不重复续期", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-oauth-active-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = new Map<string, string>();
  const store = createFileConfigStore(root, { globalDir: root, credentialStore: {
    persistent: true, get: async (account) => values.get(account),
    set: async (account, value) => { values.set(account, value); }, delete: async (account) => { values.delete(account); }
  } });
  const config = configuration();
  config.models.other = { provider: "subscription", model: "fixture-next-model" };
  await store.save(config);
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let refreshes = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === CODEX_OAUTH_TOKEN_ENDPOINT) {
      refreshes++;
      await updateConfig(store, root, (current) => ({ ...current, defaultModel: "other", toolModel: "other" }));
      return tokenResponse();
    }
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${renewedAccessToken}`);
    assert.equal((await store.load()).providers.subscription?.apiKey, renewedAccessToken);
    return textResponse("ready");
  };
  const manager = await ModelManager.create(root, config, store);
  await generateNativeText(manager.getModel(), [{ role: "user", content: "fixture" }]);
  await manager.preparePrompt(undefined, false);
  assert.equal(manager.getInfo().modelAlias, "subscription", "同回合不能带入并发保存的新聊天选择");
  const streamed = await manager.getModelSettings().vercelModel!.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }] });
  for await (const part of streamed.stream) assert.notEqual(part.type, "error");
  assert.equal(refreshes, 1);
  await manager.preparePrompt();
  assert.equal(manager.getInfo().modelAlias, "other", "下一回合仍需读取并发保存的新模型选择");

  const primaryConfig = configuration();
  primaryConfig.models.other = { provider: "subscription", model: "fixture-next-model" };
  await store.save(primaryConfig);
  const primary = await ModelManager.create(root, primaryConfig, store);
  await primary.preparePrompt(undefined, false);
  assert.equal(primary.getInfo().modelAlias, "subscription");
  await primary.preparePrompt();
  assert.equal(primary.getInfo().modelAlias, "other", "聊天续期同样不能提前确认后续模型选择的配置版本");
});
