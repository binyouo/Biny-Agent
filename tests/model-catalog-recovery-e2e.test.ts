/** 目录来源升级后，真实回合须恢复当前端点容量，再记录预算；旧缓存隔离测试未覆盖发送链路。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { FileModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";

test("invalidated catalog is fetched before a turn budgets and persists the gateway model context", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-catalog-recovery-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const requests: string[] = [];
  const validators: unknown[] = [];
  const requestWindows: Array<number | undefined> = [];
  let runtime: CommandRuntime | undefined;
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === "/v1/models") {
      validators.push(request.headers["if-none-match"]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gateway-chat", context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000 }] }));
    } else if (request.url === "/v1/chat/completions") {
      requestWindows.push(runtime?.agent.getInfo().contextWindow);
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const config = configSchema.parse({ ...defaultConfig, defaultModel: "selected",
      providers: { gateway: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false } },
      models: { selected: { provider: "gateway", model: "gateway-chat" } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      checkpoints: { enabled: false },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const modelsStore = new FileModelsStore();
    await modelsStore.write("gateway", { sourceKey: "gateway::old-source", etag: '"obsolete"',
      models: [{ id: "gateway-chat", displayName: "Chat", provider: "gateway", contextWindow: 500_000, capabilities: {}, reasoningEfforts: [] }] });
    runtime = await createCommandRuntime(workspace, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    const sessionFile = runtime.agent.getInfo().sessionFile;
    for (let turn = 0; turn < 2; turn++) {
      const outcome = await runtime.agent.runTask("Reply briefly", { abortSignal: AbortSignal.timeout(15_000),
        capabilitySelection: { tools: [], skills: "none" }, emotionAnalysis: false });
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    }
    await runtime.close(); runtime = undefined;
    const events = await readSessionEvents(sessionFile);
    // user_message 先保存上一轮预算；本轮组装后的预算由 assistant contextState 持久化。
    const replies = events.filter(e => e.type === "assistant_message" && e.content === "Done.");
    assert.equal(replies.length, 2);
    for (const reply of replies) {
      assert.equal(reply.contextState?.budget.contextWindow, 1_000_000, "the completed request must use the current catalog, not the 32K fallback or invalid old limits");
      assert.equal(reply.contextState?.budget.maxTokens, 950_000);
      assert.equal(reply.contextState?.budget.contextWindowIsFallback, false);
    }
    assert.deepEqual(requestWindows, [1_000_000, 1_000_000]);
    assert.deepEqual(requests, ["/v1/models", "/v1/chat/completions", "/v1/chat/completions"]);
    assert.deepEqual(validators, [undefined], "invalid cache validators must not cross source identity");
    const stored = await modelsStore.read(modelCatalogCacheKey("gateway", config.providers.gateway!));
    assert.equal(stored?.models[0]?.contextWindow, 1_000_000);
    assert.equal(config.models.selected!.contextWindow, undefined, "recovery does not write a user override");
  } finally {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
