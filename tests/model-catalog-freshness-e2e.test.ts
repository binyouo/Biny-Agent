/** 已知容量也须在新回合采用其他客户端刷新的目录，且不覆盖用户的明确容量。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { FileModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

for (const capacityOverride of [undefined, 64_000]) {
  test(`新回合使用已刷新的同来源目录，容量覆盖=${capacityOverride ?? "自动"}`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-catalog-freshness-"));
    const previousRoot = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "global");
    const requests: string[] = [];
    const requestWindows: Array<number | undefined> = [];
    const requestBodies: Array<{ model: string; max_tokens?: number }> = [];
    let runtime: CommandRuntime | undefined;
    const server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(500);
        response.end("A fresh local catalog must not require a network refresh.");
        return;
      }
      requestWindows.push(runtime?.agent.getInfo().contextWindow);
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        requestBodies.push(JSON.parse(body) as { model: string; max_tokens?: number });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":2,"total_tokens":22}}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const config = configSchema.parse({ ...defaultConfig, defaultModel: "selected",
        providers: { gateway: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false,
          modelProfiles: { "gateway-chat": { contextWindow: capacityOverride } } } },
        models: { selected: { provider: "gateway", model: "gateway-chat" } },
        thinking: { ...defaultConfig.thinking, enabled: false },
        extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
        checkpoints: { enabled: false },
        context: { ...defaultConfig.context, identity: { enabled: false, userEnabled: false },
          memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
        activity: { ...defaultConfig.activity, enabled: false },
        heartbeat: { ...defaultConfig.heartbeat, enabled: false }
      });
      const modelsStore = new FileModelsStore();
      const sourceKey = modelCatalogCacheKey("gateway", config.providers.gateway!);
      const checkedAt = Date.now();
      await modelsStore.write(sourceKey, { sourceKey, checkedAt, models: [{
        id: "gateway-chat", displayName: "Chat", provider: "gateway", contextWindow: 200_000,
        maxOutputTokens: 4_000, capabilities: { tools: true }, reasoningEfforts: []
      }] });
      runtime = await createCommandRuntime(workspace, {
        configStore: { load: async () => structuredClone(config), save: async () => undefined }
      });
      assert.equal(runtime.agent.getInfo().contextWindow, capacityOverride ?? 200_000);
      const sessionFile = runtime.agent.getInfo().sessionFile;
      // 独立 store 模拟另一客户端刷新相同连接，不通过当前 Runtime 的模型管理器写入。
      await new FileModelsStore().write(sourceKey, { sourceKey, checkedAt: checkedAt + 1, models: [{
        id: "gateway-chat", displayName: "Chat", provider: "gateway", contextWindow: 1_000_000,
        maxOutputTokens: 12_000, capabilities: { tools: true }, reasoningEfforts: []
      }] });
      const outcome = await runtime.agent.runTask("Reply briefly", { abortSignal: AbortSignal.timeout(15_000),
        capabilitySelection: { tools: [], skills: "none" }, emotionAnalysis: false });
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      await runtime.close();
      runtime = undefined;
      const events = await readSessionEvents(sessionFile);
      const replies = events.filter(event => event.type === "assistant_message" && event.content === "Done.");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.contextState?.budget.contextWindow, capacityOverride ?? 1_000_000);
      assert.equal(replies[0]?.contextState?.budget.maxTokens, capacityOverride === undefined ? 950_000 : 60_800);
      assert.equal(replies[0]?.contextState?.budget.contextWindowIsFallback, false);
      assert.deepEqual(requestWindows, [capacityOverride ?? 1_000_000]);
      assert.deepEqual(requestBodies.map(body => ({ model: body.model, max_tokens: body.max_tokens })), [
        { model: "gateway-chat", max_tokens: 12_000 }
      ], "目录更新同时进入真实请求设置，不能只更新可见预算");
      assert.deepEqual(requests, ["/v1/chat/completions"]);
      assert.equal(config.models.selected!.contextWindow, undefined, "自动目录不能变成别名容量覆盖");
      assert.equal(config.providers.gateway!.modelProfiles?.["gateway-chat"]?.contextWindow, capacityOverride);
    } finally {
      await runtime?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousRoot;
      await removeTestRoot(root, { recursive: true, force: true });
    }
  });
}
