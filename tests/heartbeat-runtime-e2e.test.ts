/** 真实 Runtime、HTTP provider 协议和 session 落盘；不调用真实模型或用户配置。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { listAllSessionFiles } from "../src/session/store.js";
import { TodoStore } from "../src/session/todoStore.js";
import { readSessionEvents } from "../src/session/events.js";
import { buildSessionTimeline, listChangedFiles } from "../src/desktop/renderer/src/sessionTimeline.js";
const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-runtime-"));
const oldAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "global");
let runtime: CommandRuntime | undefined;
let failure = true;
let written = false;
let quietHeartbeat = true;
const prompts: string[] = [];
const models: string[] = [];
const notifications: string[] = [];
const provider = createServer((req, res) => { void (async () => {
  let source = "";
  for await (const chunk of req) source += String(chunk);
  const body = JSON.parse(source) as { model: string; messages: unknown[]; tools?: unknown[] };
  models.push(body.model);
  prompts.push(JSON.stringify(body.messages));
  if (failure) { res.writeHead(400); res.end(JSON.stringify({ error: { message: "test provider failure" } })); return; }
  const auxiliary = !body.tools?.length;
  const delta = auxiliary ? { content: JSON.stringify({ skillIds: [] }) } : written ? {
    content: quietHeartbeat
      ? "HEARTBEAT_OK\n<biny_notification>HEARTBEAT_OK</biny_notification>"
      : "需要主人决定是否继续。\n<biny_notification>有一项任务等待主人决定</biny_notification>"
  } : { tool_calls: [{ index: 0, id: "write-note", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "note.md", content: "已完成本地检查。" }) } }] };
  const finish = auxiliary || written ? "stop" : "tool_calls";
  if (!auxiliary) written = true;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }, "[DONE]"].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
})().catch(error => { res.writeHead(500); res.end(String(error)); }); });
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
try {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const config = configSchema.parse({ ...defaultConfig,
    defaultModel: "main", toolModel: "tool",
    providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: {
      main: { provider: "test", model: "main-model", capabilities: { tools: true, reasoning: false, streaming: true } },
      tool: { provider: "test", model: "tool-model", capabilities: { tools: true, reasoning: false, streaming: true } }
    },
    thinking: { ...defaultConfig.thinking, enabled: false },
    chat: { ...defaultConfig.chat, defaultToolSelection: "all" },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  });
  runtime = await createCommandRuntime(workspace, { configStore: { load: async () => config, save: async () => undefined } });
  runtime.setOwnerNotificationSink?.(async text => { notifications.push(text); });
  const goalSessionId = "heartbeat-review-goal";
  runtime.sessionGoals.set(goalSessionId, "Review the blocked deployment decision");
  runtime.taskRuns.create({ taskRunId: "heartbeat-review-task-run", sessionId: goalSessionId, task: { prompt: "Check the deployment report" } });
  const goalTodos = new TodoStore(workspace, goalSessionId);
  await goalTodos.replace([{ content: "Wait for owner decision", status: "pending" }]);
  assert.equal(prompts.length, 0, "关闭心跳的 Runtime 启动不能自行生成日记");
  assert.equal(await runtime.heartbeat.triggerNow(), false);
  assert.match(runtime.heartbeat.status().lastError ?? "", /test provider failure/);
  assert.ok(prompts.some(prompt => prompt.includes("ACTIVE TASK REVIEW")
    && prompt.includes("Review the blocked deployment decision")
    && prompt.includes("Check the deployment report")
    && prompt.includes("Wait for owner decision")), "heartbeat reviews durable goals and their pending checklist items");
  assert.equal(runtime.sessionGoals.get(goalSessionId)?.status, "active", "reviewing a goal does not change its status");
  assert.deepEqual(goalTodos.list(), [{ content: "Wait for owner decision", status: "pending" }], "reviewing tasks does not edit their checklist");
  assert.ok(models.includes("tool-model") && models.includes("main-model"), "a tool-model provider failure retries the untouched heartbeat with the primary model");
  failure = false;
  assert.equal(await runtime.heartbeat.triggerNow(), true);
  const files = await listAllSessionFiles();
  const events = (await Promise.all(files.map(file => readSessionEvents(file)))).flat();
  assert.equal(await readFile(path.join(workspace, "note.md"), "utf8"), "已完成本地检查。");
  assert.ok(models.includes("tool-model"), "ordinary heartbeat checks use the tool model");
  assert.deepEqual(notifications, [], "HEARTBEAT_OK must stay silent even when the model adds a notification block");
  const heartbeatFile = files.find(file => file.endsWith("/heartbeat.jsonl"));
  assert.ok(heartbeatFile, "heartbeat uses its own persisted session");
  const heartbeatEvents = await readSessionEvents(heartbeatFile);
  assert.ok(heartbeatEvents.some(event => event.type === "user_message" && event.metadata?.source === "heartbeat"));
  for (const type of ["user_message", "assistant_message", "tool_call", "tool_result", "error"]) assert.ok(events.some(event => event.type === type), type);
  const outputs = buildSessionTimeline(events, []).flatMap(listChangedFiles);
  assert.deepEqual(outputs, [{ path: "note.md", operation: "write", status: "completed" }]);
  assert.equal(events.some(event => event.type === "message_metadata" && event.metadata.diaryPath), false);
  assert.equal(runtime.hasBackgroundWork(), false);
  quietHeartbeat = false;
  assert.equal(await runtime.heartbeat.triggerNow(), true);
  assert.deepEqual(notifications, ["有一项任务等待主人决定"], "attention-worthy heartbeat notifications reach the configured sink");
  await writeFile(path.join(process.env.BINY_AGENT_DIR!, "HEARTBEAT.md"), "DAILY DIARY TIME: write the diary.");
  quietHeartbeat = true;
  written = false;
  assert.equal(await runtime.heartbeat.triggerNow(), true);
  assert.ok(models.includes("main-model"), "diary heartbeats use the current primary model");
  const laterFiles = await listAllSessionFiles();
  assert.ok(laterFiles.some(file => file.endsWith("/heartbeat.jsonl")), "later heartbeat turns stay in the dedicated session");
  const interactive = new InteractiveAgentRuntime(runtime);
  const routeStart = models.length;
  const routed = interactive.submitPrompt("Run this check through the tool model", [], {
    runId: "tool-model-route-run", messageId: "tool-model-route-message", turnId: "tool-model-route-turn"
  }, undefined, { tools: "none", skills: "none" }, "tool");
  assert.equal((await routed.completion).status, "completed");
  assert.equal(models[routeStart], "tool-model", "an explicit per-run tool route must override the chat session model");
  await interactive.close();
  runtime = undefined;
} finally {
  await runtime?.close();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("heartbeat runtime e2e tests passed");
