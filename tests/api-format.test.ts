import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fetchModelCatalogSnapshot, ModelCatalogRequestError, parseModelCatalog } from "../src/ai/modelCatalog.js";
import { providerDefinition } from "../src/ai/provider.js";
import type { CatalogProviderRequest } from "../src/ai/types.js";
import { apiFormatForConnection, apiFormatOption, apiFormatOptions, apiFormatOptionsForConnection, recommendedApiFormat } from "../src/desktop/renderer/src/providerCatalog.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { modelCatalogCacheKey } from "../src/llm/ModelsStore.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";

test("内置厂商自动路由与可覆盖范围", () => {
  assert.equal(recommendedApiFormat("anthropic"), "anthropic_messages");
  assert.equal(recommendedApiFormat("openai-codex"), "responses");
  assert.equal(recommendedApiFormat("deepseek"), "chat_completions");
  assert.equal(recommendedApiFormat("kimi", "anthropic"), "anthropic_messages");
  assert.deepEqual(apiFormatOptionsForConnection("deepseek").map((item) => item.id), ["chat_completions"]);
});

// ---------- 渲染层：格式选项与回显折回 ----------

test("apiFormatOptions: 四种格式各自绑定 (protocol, apiBackend) 对", () => {
  const byId = new Map(apiFormatOptions.map((option) => [option.id, option]));
  assert.equal(apiFormatOptions.length, 4);
  assert.equal(byId.get("chat_completions")?.protocol, "openai-compatible");
  assert.equal(byId.get("chat_completions")?.apiBackend, "chat_completions");
  assert.equal(byId.get("responses")?.apiBackend, "responses");
  assert.equal(byId.get("anthropic_messages")?.protocol, "anthropic");
  assert.equal(byId.get("anthropic_messages")?.apiBackend, "anthropic_messages");
  assert.equal(byId.get("google_generative_ai")?.apiBackend, "google_generative_ai");
  // Gemini 格式带官方默认端点，其余格式靠用户填中转地址。
  assert.equal(byId.get("google_generative_ai")?.defaultBaseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(byId.get("chat_completions")?.defaultBaseUrl, undefined);
});

test("apiFormatForConnection: apiBackend 优先，老配置按 protocol 折回", () => {
  assert.equal(apiFormatForConnection("openai-compatible", "responses"), "responses");
  assert.equal(apiFormatForConnection("openai-compatible", "google_generative_ai"), "google_generative_ai");
  assert.equal(apiFormatForConnection("openai-compatible", "anthropic_messages"), "anthropic_messages");
  // 老的 anthropic 连接只存了 protocol，没有 apiBackend，也要回显成 Anthropic Messages。
  assert.equal(apiFormatForConnection("anthropic", undefined), "anthropic_messages");
  assert.equal(apiFormatForConnection("openai-compatible", undefined), "chat_completions");
  assert.equal(apiFormatForConnection("openai-compatible", "chat_completions"), "chat_completions");
  // 未知格式 id 兜底到 chat_completions。
  assert.equal(apiFormatOption("nonsense" as never).id, "chat_completions");
});

test("apiFormatOptionsForConnection: 已连接的兼容 Provider 也能修改请求格式", () => {
  assert.deepEqual(
    apiFormatOptionsForConnection("openai-compatible", "openai-compatible", "https://gateway.example/v1").map((option) => option.id),
    ["chat_completions", "responses"]
  );
  assert.deepEqual(
    apiFormatOptionsForConnection("openai-compatible", "openai-compatible", undefined).map((option) => option.id),
    ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"]
  );
  assert.deepEqual(
    apiFormatOptionsForConnection("anthropic", "anthropic", "https://api.anthropic.com").map((option) => option.id),
    ["anthropic_messages"]
  );
});

test("resolveProviderRequestRoute: 模型覆盖优先于 Provider，再回退到定义", () => {
  const definition = providerDefinition("openai-compatible");
  const provider = { type: "openai-compatible", baseUrl: "https://gateway.example/v1", apiBackend: "responses" } as const;
  assert.deepEqual(resolveProviderRequestRoute(undefined, provider, definition), {
    apiBackend: "responses",
    protocol: "openai-compatible",
    source: "provider"
  });
  assert.deepEqual(resolveProviderRequestRoute({ apiBackend: "chat_completions" }, provider, definition), {
    apiBackend: "chat_completions",
    protocol: "openai-compatible",
    source: "model"
  });
  assert.equal(resolveProviderRequestRoute(undefined, { type: "openai-compatible", baseUrl: "https://gateway.example/v1" }, definition).apiBackend, "chat_completions");
});

// ---------- 主进程：目录拉取的鉴权与 id 形状 ----------

test("parseModelCatalog: 从 name 取 id 时剥掉 models/ 资源前缀", () => {
  const entries = parseModelCatalog(
    {
      data: [
        { id: "gpt-4o" },
        { name: "models/gemini-2.5-pro" },
        { id: "models/claude-x", name: "models/claude-x" },
        { other: true }
      ]
    },
    "test",
    "openai-compatible"
  );
  // 有显式 id 时原样保留（id 本来就应是请求用形状）；只有 name 时剥前缀。
  assert.deepEqual(entries.map((entry) => entry.id), ["gpt-4o", "gemini-2.5-pro", "models/claude-x"]);
});

function catalogRequest(apiBackend?: string): CatalogProviderRequest {
  return {
    alias: "custom",
    config: {
      type: "openai-compatible",
      baseUrl: "https://gateway.example/v1beta",
      apiKey: "test-key",
      ...(apiBackend ? { apiBackend } : {})
    },
    definition: providerDefinition("openai-compatible")
  };
}

test("fetchModelCatalogSnapshot: google_generative_ai 用 x-goog-api-key，默认走 Bearer", async () => {
  const seen: Array<{ url: string; auth?: string; goog?: string }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(input), auth: headers.Authorization, goog: headers["x-goog-api-key"] });
    return new Response(JSON.stringify({ data: [{ name: "models/gemini-2.5-pro" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const google = await fetchModelCatalogSnapshot(catalogRequest("google_generative_ai"), undefined, {}, fetcher);
  assert.equal(seen[0]?.goog, "test-key");
  assert.equal(seen[0]?.auth, undefined);
  assert.equal(seen[0]?.url, "https://gateway.example/v1beta/models");
  // 目录里的资源名剥掉 models/ 前缀后才是可请求的模型 id。
  assert.deepEqual(google.models?.map((model) => model.id), ["gemini-2.5-pro"]);

  seen.length = 0;
  await fetchModelCatalogSnapshot(catalogRequest(), undefined, {}, fetcher);
  assert.equal(seen[0]?.auth, "Bearer test-key");
  assert.equal(seen[0]?.goog, undefined);
});

test("fetchModelCatalogSnapshot: 公开 OpenCode 目录不要求聊天 API Key", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    return Response.json({ data: [{ id: "glm-5.3-flash" }] });
  }) as typeof fetch;
  const result = await fetchModelCatalogSnapshot({
    alias: "opencode-go",
    config: {
      type: "openai-compatible",
      baseUrl: "https://opencode.ai/zen/go/v1",
      requiresApiKey: true
    },
    definition: providerDefinition("openai-compatible")
  }, undefined, {}, fetcher);
  assert.equal(called, true);
  assert.deepEqual(result.models?.map((model) => model.id), ["glm-5.3-flash"]);
});

test("fetchModelCatalogSnapshot: 保留 HTTP 状态、请求地址和服务商错误正文", async () => {
  const fetcher = (async () => Response.json({ error: { message: "Insufficient balance" } }, { status: 402 })) as typeof fetch;
  await assert.rejects(
    fetchModelCatalogSnapshot(catalogRequest(), undefined, {}, fetcher),
    (error: unknown) => error instanceof ModelCatalogRequestError
      && error.statusCode === 402
      && error.url === "https://gateway.example/v1beta/models"
      && error.responseBody?.includes("Insufficient balance") === true
  );
});

test("parseModelCatalog: 接受服务商常见的数字字符串元数据", () => {
  const [model] = parseModelCatalog({
    data: [{ id: "gateway-model", context_window: "131072", max_input_tokens: "120000" }]
  }, "gateway", "openai-compatible");
  assert.equal(model?.contextWindow, 131_072);
  assert.equal(model?.maxInputTokens, 120_000);
});

test("modelCatalogCacheKey: 同一主机的不同模型目录路径使用不同缓存键", () => {
  const zen = modelCatalogCacheKey("opencode", {
    type: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/v1"
  });
  const go = modelCatalogCacheKey("opencode", {
    type: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go/v1"
  });
  assert.notEqual(zen, go);
});

// ---------- 桌面端：连接回显携带 apiBackend ----------

test("workspaceSnapshot 区分连接默认与模型单独覆盖", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "biny-api-format-data-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-api-format-workspace-"));
  try {
    const storage = new DesktopUserDataStore(dataRoot);
    await storage.initialize();
    const state = new DesktopStateStore(path.join(dataRoot, "desktop-state.json"));
    await state.load();
    const credentials = new Map<string, string>();
    const configStore = createFileConfigStore(dataRoot, {
      globalDir: dataRoot,
      credentialStore: {
        persistent: true,
        get: async (account) => credentials.get(account),
        set: async (account, value) => { credentials.set(account, value); },
        delete: async (account) => { credentials.delete(account); }
      }
    });
    await configStore.save({
      ...defaultConfig,
      defaultModel: "gemini-pro",
      web: {
        ...defaultConfig.web,
        search: { ...defaultConfig.web.search, provider: "google" }
      },
      providers: {
        gemini: {
          type: "openai-compatible",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "g-key",
          apiBackend: "google_generative_ai"
        },
        legacy: {
          type: "openai-compatible",
          baseUrl: "https://legacy.example/v1",
          apiKey: "l-key"
        }
      },
      models: {
        "gemini-pro": { provider: "gemini", model: "gemini-2.5-pro", headers: { "X-Test-Model": "old" } },
        "legacy-claude": { provider: "legacy", model: "claude-sonnet", apiBackend: "anthropic_messages" }
      }
    });
    const projects = new DesktopProjectService(state, storage, configStore);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const project = await projects.createProject(workspaceRoot);
    const snapshot = await agents.workspaceSnapshot(project.id);
    const gemini = snapshot.connections.find((connection) => connection.providerAlias === "gemini");
    const legacy = snapshot.connections.find((connection) => connection.providerAlias === "legacy");
    assert.equal(gemini?.apiBackend, "google_generative_ai");
    // 模型单独覆盖不能伪装成连接默认，否则自动模式无法如实回显。
    assert.equal(legacy?.apiBackend, undefined);
    assert.equal(JSON.stringify(snapshot).includes("g-key"), false);
    assert.equal(await agents.readModelApiKey(project.id, "gemini"), "g-key");

    // 一笔设置事务必须同时保留能力、请求格式、profile 和明确清空的 Header。
    const upsert = {
      alias: "gemini-pro",
      providerAlias: "gemini",
      providerType: "openai-compatible",
      model: "gemini-2.5-pro",
      supportsTools: false,
      supportsThinking: false,
      supportsVision: false,
      apiBackend: "chat_completions" as const,
      headers: {},
      modelProfile: { contextWindow: 64_000, capabilities: { tools: false, reasoning: false, vision: false } }
    };
    const prepared = await agents.prepareSettingsConfig(project.id, {
      expectedPreferenceRevision: 0,
      models: { upserts: [upsert], removeAliases: [], modelProfiles: { gemini: { "gemini-2.5-pro": upsert.modelProfile } } }
    });
    await configStore.save(prepared.after);
    const saved = await configStore.load(workspaceRoot);
    assert.equal(saved.providers.gemini?.modelProfiles?.["gemini-2.5-pro"]?.capabilities?.tools, false);
    assert.equal(saved.providers.gemini?.modelProfiles?.["gemini-2.5-pro"]?.capabilities?.reasoning, false);
    assert.equal(saved.providers.gemini?.modelProfiles?.["gemini-2.5-pro"]?.capabilities?.vision, false);
    assert.equal(saved.models["gemini-pro"]?.apiBackend, "chat_completions");
    assert.deepEqual(saved.models["gemini-pro"]?.headers, {});
    assert.equal(saved.providers.gemini?.apiBackend, "google_generative_ai", "model override must not change connection default");
    assert.equal(saved.providers.gemini?.modelProfiles?.["gemini-2.5-pro"]?.contextWindow, 64_000);
    const reset = await agents.prepareSettingsConfig(project.id, {
      expectedPreferenceRevision: 0,
      models: {
        upserts: [{ ...upsert, apiBackend: undefined, modelProfile: undefined }],
        removeAliases: [],
        modelProfiles: { gemini: {} }
      }
    });
    assert.equal(reset.after.models["gemini-pro"]?.apiBackend, undefined);
    assert.deepEqual(reset.after.providers.gemini?.modelProfiles, {});
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
