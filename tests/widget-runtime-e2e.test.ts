import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost, connectRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import { agentDir } from "../src/session/store.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { RuntimeHostEventJournal } from "../src/runtime/host/journal.js";
import { runtimeHostEventHistoryLimit, runtimeHostJournalFile } from "../src/runtime/host/protocol.js";

for (const cancelled of [false, true]) test(`真实 Runtime/HTTP 参数流 ${cancelled ? "取消" : "完成"} 保留执行与持久化边界`, { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-widget-runtime-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const args = { title: "平方", html: '<input type="range"><output>4</output><script>window.square=x=>x*x</script>' };
  let release!: () => void;
  const previewSeen = new Promise<void>(resolve => { release = resolve; });
  let releaseSecond!: () => void;
  const secondSeen = new Promise<void>(resolve => { releaseSecond = resolve; });
  let requests = 0;
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    requests++;
    assert.ok(requests <= 2);
    if (requests === 1) {
      assert.match(JSON.stringify(body.tools), /WidgetRenderer/);
      const json = JSON.stringify(args);
      const split = json.indexOf("<script>");
      send({ tool_calls: [{ index: 0, id: "widget-call", type: "function", function: { name: "WidgetRenderer", arguments: json.slice(0, split) } }] });
      await previewSeen;
      if (cancelled) { response.end(); return; }
      // 这里只模拟 provider 的帧间隔（覆盖 150ms 节流），成功条件仍是 socket 预览事件。
      await new Promise(resolve => setTimeout(resolve, 160));
      send({ tool_calls: [{ index: 0, function: { arguments: json.slice(split, -2) } }] });
      await secondSeen;
      send({ tool_calls: [{ index: 0, function: { arguments: json.slice(-2) } }] });
      send({}, "tool_calls");
    } else { send({ content: "拖动滑块查看平方。" }); send({}, "stop"); }
    response.end("data: [DONE]\n\n");
  })().catch(error => { response.destroy(error as Error); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
  let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
  let runId: string | undefined;
  const timer = setTimeout(() => { release(); releaseSecond(); if (runId) void client?.cancelRunRequest(runId, "cancelled"); }, 5_000);
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const config = configSchema.parse({ ...defaultConfig, defaultModel: "fixture", toolModel: undefined,
      providers: { fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "fixture-chat", capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
      extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      checkpoints: { enabled: false },
      activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const canonical = await realpath(workspace);
    host = await startRuntimeHost(canonical, resourceRegistry => createInteractiveAgentHost(canonical, { resourceRegistry, configStore: { load: async () => config, save: async () => undefined } }), { createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); } });
    client = await connectRuntimeHost(canonical, { surface: "desktop", clientId: "widget-test" });
    assert.ok(client);
    const file = client.getSnapshot().info.sessionFile;
    const observed: AgentHostEvent[] = [];
    client.subscribe(update => {
      const event = update.event;
      if (!event) return;
      observed.push(event);
      if (event.type === "tool.input" && (event.args as { html?: string }).html?.includes("<output>")) {
        assert.equal(observed.some(item => item.type === "tool.started"), false, "完整参数到达前不得执行工具");
        if ((event.args as { html?: string }).html?.includes("<script>")) releaseSecond();
        if (cancelled) void client!.cancelRunRequest(event.runId, "cancelled", event.sessionId).then(release);
        else release();
      }
    });
    const run = client.submitPrompt("可视化平方", [], undefined, undefined, { tools: ["WidgetRenderer", "WidgetReadme"], skills: "none" });
    runId = run.runId;
    const outcome = await run.completion;
    assert.ok(observed.some(event => event.type === "tool.input"));
    assert.equal(outcome.status, cancelled ? "cancelled" : "completed");
    await client.close(); client = undefined;
    await host.close(); host = undefined;
    if (!cancelled) {
      const journalPath = path.join(agentDir(canonical), "runs", runtimeHostJournalFile);
      const journal = new RuntimeHostEventJournal(journalPath, runtimeHostEventHistoryLimit);
      const restored = await journal.initialize();
      await journal.close();
      const previews = restored.records.flatMap(record => record.update.event?.type === "tool.input" ? [record.update.event] : []);
      assert.ok(previews.length >= 2);
      assert.ok(previews.slice(0, -1).every(event => Object.keys(event.args as object).length === 0), "旧预览只保留序号与身份");
      const observedPreviews = observed.filter((event): event is Extract<AgentHostEvent, { type: "tool.input" }> => event.type === "tool.input");
      assert.deepEqual(previews.at(-1)?.args, observedPreviews.at(-1)?.args, "journal 解码恢复最新完整预览");
      assert.deepEqual(restored.records.map(record => record.sequence), Array.from({ length: restored.records.length }, (_, index) => index + 1));
      const raw = await readFile(journalPath, "utf8");
      assert.ok(raw.split("\n").filter(Boolean).length >= restored.records.length, "预览增量不丢失传输序号");
    }
    const persisted = await readSessionEvents(file);
    assert.equal(persisted.some(event => String(event.type) === "tool.input"), false, "预览不是持久化执行事实");
    const results = persisted.filter(event => event.type === "tool_result" && event.tool === "WidgetRenderer");
    const calls = persisted.filter(event => event.type === "tool_call" && event.tool === "WidgetRenderer");
    assert.equal(results.length, cancelled ? 0 : 1);
    assert.equal(calls.length, cancelled ? 0 : 1);
    if (!cancelled) {
      const result = results[0]; assert.ok(result?.type === "tool_result");
      const artifact = result.result as Record<string, unknown>;
      assert.deepEqual({ kind: artifact.kind, title: artifact.title, html: artifact.html }, { kind: "widget", ...args });
      assert.equal(buildSessionTimeline(persisted, []).flatMap(turn => turn.tools).find(tool => tool.tool === "WidgetRenderer")?.status, "success");
    }
  } finally {
    clearTimeout(timer); release(); releaseSecond(); await client?.close(); await host?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
