import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { CODEX_OAUTH_TOKEN_ENDPOINT } from "../src/llm/subscriptionAuth.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";

function chatResponse(response: ServerResponse, delta: Record<string, unknown>, reason: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: reason }] }
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}

function auxiliaryResponse(response: ServerResponse): void {
  const text = JSON.stringify({ tools: ["Read"] });
  const message = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "fixture-response", created_at: 1, model: "fixture-aux", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: "fixture-response", created_at: 1, model: "fixture-aux", status: "completed", output: [message], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

test("真实 Runtime 辅助 OAuth 续期持久化到凭据存储，后续回合复用新令牌并保持稳定工具事件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tool-oauth-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "note.txt"), "fixture-local-note");
  const credentials = new Map<string, string>();
  const configRoot = path.join(root, "config");
  const configStore = createFileConfigStore(workspace, { globalDir: configRoot, credentialStore: {
    persistent: true,
    get: async (account) => credentials.get(account),
    set: async (account, value) => { credentials.set(account, value); },
    delete: async (account) => { credentials.delete(account); }
  } });
  const calls: string[] = [];
  const serverFailures: string[] = [];
  let mainRequests = 0;
  let auxiliaryRequests = 0;
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    calls.push(request.url!);
    if (request.url === "/oauth/token") {
      assert.equal(new URLSearchParams(raw).get("refresh_token"), "fixture-refresh-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "fixture-renewed-access", refresh_token: "fixture-renewed-refresh", expires_in: 3600 }));
      return;
    }
    const body = JSON.parse(raw) as { model: string };
    if (body.model === "fixture-aux") {
      auxiliaryRequests++;
      assert.equal(request.headers.authorization, "Bearer fixture-renewed-access");
      const persisted = await configStore.load();
      assert.equal(persisted.providers.subscription?.apiKey, "fixture-renewed-access", "模型请求之前必须保存续期凭据");
      assert.equal(persisted.providers.subscription?.oauth?.refreshToken, "fixture-renewed-refresh");
      auxiliaryResponse(response);
      return;
    }
    const step = mainRequests++ % 3;
    if (step === 0 || step === 1) {
      const name = step === 0 ? "ToolSearch" : "Read";
      const args = step === 0 ? { query: `inspect note contents, pass ${String(mainRequests)}` } : { path: "note.txt" };
      chatResponse(response, { tool_calls: [{ index: 0, id: `fixture-${String(mainRequests)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    } else chatResponse(response, { content: "Completed local inspection." }, "stop");
  })().catch((error: unknown) => {
    serverFailures.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === CODEX_OAUTH_TOKEN_ENDPOINT) return await nativeFetch(`${origin}/oauth/token`, init);
    assert.equal(new URL(url).origin, origin, "测试只允许访问本地 HTTP 夹具");
    return await nativeFetch(input, init);
  };
  let runtime: CommandRuntime | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("OAuth Runtime fixture exceeded its deadline.")), 15_000);
  try {
    await configStore.save(configSchema.parse({
      ...defaultConfig,
      defaultModel: "chat", toolModel: "subscription",
      providers: {
        local: { type: "openai-compatible", baseUrl: `${origin}/chat/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } },
        subscription: { type: "openai-codex", baseUrl: `${origin}/aux/v1`, apiKey: "fixture-expired-access", requiresApiKey: false, authMode: "oauth-bearer", oauth: { provider: "openai-codex", refreshToken: "fixture-refresh-token", expiresAt: 1 } }
      },
      models: { chat: { provider: "local", model: "fixture-chat" }, subscription: { provider: "subscription", model: "fixture-aux" } },
      thinking: { enabled: false, effort: "medium" },
      permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
      extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      checkpoints: { enabled: false },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    }));
    runtime = await createCommandRuntime(workspace, { configStore });
    const sessionFile = runtime.agent.getInfo().sessionFile;
    for (let pass = 0; pass < 2; pass++) {
      const outcome = await runtime.agent.runTask("Inspect the local note through capability discovery", {
        abortSignal: controller.signal, capabilitySelection: { tools: ["ToolSearch"], skills: "none" }, emotionAnalysis: false
      });
      assert.deepEqual(serverFailures, [], "真实请求前应已将轮换凭据保存到存储");
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    }
    assert.equal(auxiliaryRequests, 2);
    assert.equal(calls.filter((call) => call === "/oauth/token").length, 1, "后续辅助模型工厂必须读取已轮换凭据");
    await runtime.close();
    runtime = undefined;
    const events = await readSessionEvents(sessionFile);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "ToolSearch").length, 2);
    assert.equal(events.filter((event) => event.type === "tool_call" && event.tool === "Read").length, 2);
    assert.equal(events.filter((event) => event.type === "turn_status" && event.status === "completed").length, 2);
    assert.equal(JSON.stringify(events).includes("fixture-renewed-refresh"), false);
    const document = await readFile(path.join(configRoot, "config.json"), "utf8");
    assert.equal(document.includes("fixture-renewed-access"), false);
    assert.equal(document.includes("fixture-renewed-refresh"), false);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await runtime?.close();
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
