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
import { readAttachment, saveAttachment } from "../src/attachments/store.js";

for (const legacyVersion of ["v2", "v3"] as const)
for (const mode of ["unknown", "supported", "disabled"] as const) test(`旧目录的默认 vision=false 失效后，回合按实际能力发送并持久化图片 version=${legacyVersion} mode=${mode}`, { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-catalog-recovery-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const requests: string[] = [];
  const validators: unknown[] = [];
  const requestWindows: Array<number | undefined> = [];
  const requestBodies: string[] = [];
  let runtime: CommandRuntime | undefined;
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === "/v1/models") {
      validators.push(request.headers["if-none-match"]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gateway-chat", context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000,
        modalities: mode === "unknown" ? undefined : { input: ["text", "image"], output: ["text"] } }] }));
    } else if (request.url === "/v1/chat/completions") {
      requestWindows.push(runtime?.agent.getInfo().contextWindow);
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        requestBodies.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const config = configSchema.parse({ ...defaultConfig, defaultModel: "selected",
      providers: { gateway: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false,
        modelProfiles: { "gateway-chat": { capabilities: { vision: mode === "disabled" ? false : undefined } } } } },
      models: { selected: { provider: "gateway", model: "gateway-chat" } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      checkpoints: { enabled: false },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      activity: { ...defaultConfig.activity, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const modelsStore = new FileModelsStore();
    // 旧目录无法区分服务商声明的 false 与 Biny 补出的 false，按历史键格式构造落盘数据。
    const provider = config.providers.gateway!;
    const legacyIdentity = legacyVersion === "v2" ? `${provider.type}\u0000${provider.baseUrl}`
      : JSON.stringify([provider.type, provider.protocol ?? null, provider.baseUrl]);
    let legacyHash = 2166136261;
    for (const character of legacyIdentity) {
      legacyHash ^= character.codePointAt(0) ?? 0;
      legacyHash = Math.imul(legacyHash, 16777619);
    }
    const oldKey = `gateway::${legacyVersion}::${(legacyHash >>> 0).toString(16).padStart(8, "0")}`;
    const oldEntry = { sourceKey: oldKey, etag: '"obsolete"',
      models: [{ id: "gateway-chat", displayName: "Chat", provider: "gateway", contextWindow: 500_000, capabilities: { vision: false }, reasoningEfforts: [] }] };
    await modelsStore.write(oldKey, oldEntry);
    await modelsStore.write("gateway", oldEntry);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
    const reference = await saveAttachment(workspace, "screen.png", "image/png", Buffer.from(png, "base64"));
    const attachment = await readAttachment(workspace, reference);
    assert.ok(attachment);
    runtime = await createCommandRuntime(workspace, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    const sessionFile = runtime.agent.getInfo().sessionFile;
    for (let turn = 0; turn < 2; turn++) {
      const outcome = await runtime.agent.runTask("Reply briefly", { abortSignal: AbortSignal.timeout(15_000),
        attachments: [attachment], capabilitySelection: { tools: [], skills: "none" }, emotionAnalysis: false });
      assert.equal(outcome.status, mode === "disabled" ? "failed" : "completed", JSON.stringify(outcome));
      if (mode === "disabled") assert.match(outcome.error ?? "", /图片输入/u);
    }
    await runtime.close(); runtime = undefined;
    const events = await readSessionEvents(sessionFile);
    if (mode === "disabled") {
      assert.equal(requestBodies.length, 0, "用户禁用后不得发送模型请求");
      assert.equal(events.filter(e => e.type === "error").length, 2);
      const inputs = events.filter(e => e.type === "user_message");
      assert.equal(inputs.length, 2);
      for (const input of inputs) assert.deepEqual(input.attachments, [reference]);
      return;
    }
    // user_message 先保存上一轮预算；本轮组装后的预算由 assistant contextState 持久化。
    const replies = events.filter(e => e.type === "assistant_message" && e.content === "Done.");
    assert.equal(replies.length, 2);
    for (const reply of replies) {
      assert.equal(reply.contextState?.budget.contextWindow, 1_000_000, "the completed request must use the current catalog, not the 32K fallback or invalid old limits");
      assert.equal(reply.contextState?.budget.maxTokens, 950_000);
      assert.equal(reply.contextState?.budget.contextWindowIsFallback, false);
    }
    assert.deepEqual(requestWindows, [1_000_000, 1_000_000]);
    for (const body of requestBodies) {
      const request = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
      const input = request.messages.filter(message => message.role === "user").at(-1);
      assert.ok(Array.isArray(input?.content));
      assert.deepEqual(input.content.filter(part => part.type === "image_url"), [
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }
      ], "请求必须使用原生图片 part，不能只拼接字节文本");
    }
    const inputs = events.filter(e => e.type === "user_message");
    assert.equal(inputs.length, 2);
    for (const input of inputs) assert.deepEqual(input.attachments, [reference]);
    assert.ok(!JSON.stringify(events).includes(png), "持久事件只保存引用");
    assert.deepEqual(requests, ["/v1/models", "/v1/chat/completions", "/v1/chat/completions"]);
    assert.deepEqual(validators, [undefined], "invalid cache validators must not cross source identity");
    const stored = await modelsStore.read(modelCatalogCacheKey("gateway", config.providers.gateway!));
    assert.equal(stored?.models[0]?.contextWindow, 1_000_000);
    assert.equal(stored?.models[0]?.capabilities.vision, mode === "unknown" ? undefined : true, "缓存必须保留声明与未知的区别");
    assert.equal(config.models.selected!.contextWindow, undefined, "recovery does not write a user override");
  } finally {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
