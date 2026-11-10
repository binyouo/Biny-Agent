/** 真实 Runtime、HTTP provider 协议和 session 落盘；不调用真实模型或用户配置。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { FileModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { listAllSessionFiles } from "../src/session/store.js";
import { TodoStore } from "../src/session/todoStore.js";
import { readSessionEvents } from "../src/session/events.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline, listChangedFiles } from "../src/desktop/renderer/src/sessionTimeline.js";
const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-runtime-"));
const oldAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "global");
let runtime: CommandRuntime | undefined;
let failure = true;
let failToolOnly = false;
let written = false;
let toolCalls = 0;
let quietHeartbeat = true;
const prompts: string[] = [];
const models: string[] = [];
const agentModels: string[] = [];
const notifications: string[] = [];
const provider = createServer((req, res) => { void (async () => {
  let source = "";
  for await (const chunk of req) source += String(chunk);
  const body = JSON.parse(source) as { model: string; messages: unknown[]; tools?: unknown[] };
  models.push(body.model);
  if (req.headers["x-biny-operation"] === "agent") agentModels.push(body.model);
  prompts.push(JSON.stringify(body.messages));
  if (failure || (failToolOnly && body.model === "tool-model")) { res.writeHead(400); res.end(JSON.stringify({ error: { message: "test provider failure" } })); return; }
  const auxiliary = !body.tools?.length;
  const delta = auxiliary ? { content: JSON.stringify({ skillIds: [] }) } : written ? {
    content: quietHeartbeat
      ? "HEARTBEAT_OK\n<biny_notification>HEARTBEAT_OK</biny_notification>"
      : "需要主人决定是否继续。\n<biny_notification>有一项任务等待主人决定</biny_notification>"
  } : { tool_calls: [{ index: 0, id: `write-note-${++toolCalls}`, type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "note.md", content: "已完成本地检查。" }) } }] };
  const finish = auxiliary || written ? "stop" : "tool_calls";
  if (!auxiliary) written = true;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end([{ choices: [{ index: 0, delta, finish_reason: null }] }, {
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 1_234, completion_tokens: 12, total_tokens: 1_246 }
  }, "[DONE]"].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
})().catch(error => { res.writeHead(500); res.end(String(error)); }); });

function assertRequestModel(events: SessionEvent[], alias: string, model: string, contextWindow: number, inputTokens = 1_234): void {
  const event = events.findLast(event => event.type === "assistant_message" && event.usage?.operation === "agent");
  assert.ok(event?.type === "assistant_message" && event.contextState && event.usage);
  assert.equal(event.contextState.budget.contextWindow, contextWindow, "the persisted request uses its actual model catalog capacity");
  assert.equal(event.contextState.budget.contextWindowIsFallback, false);
  assert.equal(event.contextState.budget.modelAlias, alias);
  assert.equal(event.contextState.promptModel, model);
  assert.equal(event.usage.modelAlias, alias, "usage follows the current request even when the heartbeat session is reused");
  assert.equal(event.usage.model, model);
  assert.equal(event.usage.inputTokens, inputTokens);
}
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
  const sourceKey = modelCatalogCacheKey("test", config.providers.test!);
  await new FileModelsStore().write(sourceKey, { sourceKey, models: [
    { id: "main-model", displayName: "Main", provider: "test", contextWindow: 1_048_576, maxInputTokens: 1_048_576, maxOutputTokens: 128_000, capabilities: {}, reasoningEfforts: [] },
    { id: "tool-model", displayName: "Tool", provider: "test", contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: {}, reasoningEfforts: [] }
  ] });
  runtime = await createCommandRuntime(workspace, { configStore: { load: async () => config, save: async () => undefined } });
  assert.equal(runtime.agent.getInfo().contextWindow, 1_048_576);
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
  const heartbeatFile = files.find(file => /^heartbeat-.+\.jsonl$/u.test(path.basename(file)));
  assert.ok(heartbeatFile, "heartbeat uses its own persisted session");
  const heartbeatEvents = await readSessionEvents(heartbeatFile);
  assertRequestModel(heartbeatEvents, "tool", "tool-model", 1_000_000, 2_468);
  assert.ok(heartbeatEvents.some(event => event.type === "user_message" && event.metadata?.source === "heartbeat"));
  for (const type of ["user_message", "assistant_message", "tool_call", "tool_result", "error"]) assert.ok(events.some(event => event.type === type), type);
  const outputs = buildSessionTimeline(events, []).flatMap(listChangedFiles);
  assert.deepEqual(outputs, [{ path: "note.md", operation: "write", status: "completed" }]);
  assert.equal(events.some(event => event.type === "message_metadata" && event.metadata.diaryPath), false);
  assert.equal(runtime.hasBackgroundWork(), false);
  failToolOnly = true;
  assert.equal(await runtime.heartbeat.triggerNow(), true, "an untouched failed tool request may use the primary model");
  assertRequestModel(await readSessionEvents(heartbeatFile), "main", "main-model", 1_048_576);
  failToolOnly = false;
  quietHeartbeat = false;
  assert.equal(await runtime.heartbeat.triggerNow(), true);
  assert.deepEqual(notifications, ["有一项任务等待主人决定"], "attention-worthy heartbeat notifications reach the configured sink");
  await writeFile(path.join(process.env.BINY_AGENT_DIR!, "HEARTBEAT.md"), "DAILY DIARY TIME: write the diary.");
  quietHeartbeat = true;
  written = false;
  assert.equal(await runtime.heartbeat.triggerNow(), true);
  assert.ok(models.includes("main-model"), "diary heartbeats use the current primary model");
  assertRequestModel(await readSessionEvents(heartbeatFile), "main", "main-model", 1_048_576, 2_468);
  assert.equal(config.defaultModel, "main", "background runs must not save their temporary model selection");
  const laterFiles = await listAllSessionFiles();
  assert.ok(laterFiles.includes(heartbeatFile), "later heartbeat turns stay in the dedicated session");
  const interactive = new InteractiveAgentRuntime(runtime);
  const contextUpdates: Extract<AgentHostEvent, { type: "context.updated" }>[] = [];
  const unsubscribe = interactive.subscribe(update => {
    if (update.event?.type === "context.updated") contextUpdates.push(update.event);
  });
  const routeStart = models.length;
  const routed = interactive.submitPrompt("Run this check through the tool model", [], {
    runId: "tool-model-route-run", messageId: "tool-model-route-message", turnId: "tool-model-route-turn"
  }, undefined, { tools: "none", skills: "none" }, "tool");
  assert.equal((await routed.completion).status, "completed");
  assert.equal(models[routeStart], "tool-model", "an explicit per-run tool route must override the chat session model");
  assertRequestModel(await readSessionEvents(runtime.agent.getSessionRecorder().filePath), "tool", "tool-model", 1_000_000);
  assert.equal(contextUpdates.at(-1)?.context.budget.modelAlias, "tool");
  assert.equal(contextUpdates.at(-1)?.context.budget.contextWindow, 1_000_000);
  assert.equal(contextUpdates.at(-1)?.context.budget.source, "provider");
  const normalStart = agentModels.length;
  const normal = interactive.submitPrompt("Continue with the normal chat model", [], undefined, undefined, { tools: "none", skills: "none" });
  assert.equal((await normal.completion).status, "completed");
  assert.equal(agentModels[normalStart], "main-model");
  assertRequestModel(await readSessionEvents(runtime.agent.getSessionRecorder().filePath), "main", "main-model", 1_048_576);
  assert.equal(contextUpdates.at(-1)?.context.budget.modelAlias, "main");
  unsubscribe();
  await interactive.close();
  runtime = undefined;
  await writeFile(path.join(process.env.BINY_AGENT_DIR!, "HEARTBEAT.md"), "Check quietly.");
  const beforeRestart = await readSessionEvents(heartbeatFile);
  config.toolModel = undefined;
  config.models = { obsolete: { provider: "test", model: "workbuddy-ai/deepseek-v4.1-flash" }, ...config.models };
  runtime = await createCommandRuntime(workspace, { configStore: { load: async () => config, save: async () => undefined } });
  const restartStart = agentModels.length;
  const restartPromptStart = prompts.length;
  assert.equal(await runtime.heartbeat.triggerNow(), true, runtime.heartbeat.status().lastError);
  assert.ok(prompts.slice(restartPromptStart).some(prompt => prompt.includes("需要主人决定是否继续")), "the next request restores earlier heartbeat conversation context");
  const restartedFiles = (await listAllSessionFiles()).filter(file => /^heartbeat-.+\.jsonl$/u.test(path.basename(file)));
  assert.deepEqual(restartedFiles, [heartbeatFile], "rebuilding a Runtime reuses the same durable heartbeat session");
  const afterRestart = await readSessionEvents(heartbeatFile);
  assert.deepEqual(afterRestart.slice(0, beforeRestart.length), beforeRestart, "reuse preserves the original event log");
  assert.ok(afterRestart.length > beforeRestart.length);
  assert.equal(agentModels[restartStart], "main-model", "automatic selection does not pick the first obsolete configured model");
  assertRequestModel(afterRestart, "main", "main-model", 1_048_576);
} finally {
  await runtime?.close();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("heartbeat runtime e2e tests passed");
