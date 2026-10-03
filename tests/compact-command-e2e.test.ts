import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-compact-command-"));
const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
let runtime: InteractiveAgentRuntime | undefined;
try {
  const config = structuredClone(defaultConfig);
  config.defaultModel = "test-model";
  config.providers = { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { "test-model": { ...defaultConfig.models[defaultConfig.defaultModel]!, provider: "local", model: "test-model" } };
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.compaction.enabled = false;
  config.heartbeat.enabled = false;
  await ensureAgentDirs(root);
  let invalidSummary = true;
  const model: AgentModel = {
    provider: "compact-test", modelId: "test-model",
    stream: async (context, options) => {
      const isSummary = context.systemPrompt?.includes("durable context checkpoint") === true;
      const text = isSummary ? checkpoint(invalidSummary) : "Recorded the request.";
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        options?.signal?.throwIfAborted();
        yield { type: "start" };
        yield { type: "text-delta", text };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 } };
      })();
    }
  };
  const recorder = new SessionRecorder(root, "compact-e2e");
  const agent = new AgentSession({
    workspaceRoot: root, config, model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder
  });
  await agent.initialize();
  const services = { agent, close: async () => await agent.close() } as unknown as CommandRuntime;
  runtime = new InteractiveAgentRuntime(services);
  const events: AgentHostEvent[] = [];
  runtime.subscribe((update) => {
    if (update.event?.type.startsWith("compact.")) events.push(update.event);
  });
  await agent.runTask("Keep the unfinished task and verified sources.");
  const before = await replaySession(recorder.filePath);

  // Given 一段真实落盘的对话，When 摘要引用缺失，Then 拒绝并保留消息与压缩边界。
  await assert.rejects(executeRuntimeCommand(runtime, services, "/compact", "desktop"), /invalid_evidence/u);
  const rejected = await replaySession(recorder.filePath);
  assert.deepEqual(rejected.messages, before.messages);
  assert.equal(rejected.contextCheckpoint, undefined);
  assert.equal(rejected.contextState?.compactionFailure?.kind, "invalid_evidence");
  assert.deepEqual(events.map((event) => event.type), ["compact.started", "compact.failed"]);
  assert.deepEqual(runtime.getSnapshot().state, { kind: "idle" });

  // When 同一命令收到有效来源摘要，Then 结果、checkpoint 与 replay 使用同一持久事实。
  invalidSummary = false;
  events.length = 0;
  const result = await executeRuntimeCommand(runtime, services, "/compact", "desktop");
  assert.deepEqual(result?.compaction, { outcome: "compacted" });
  assert.match(result?.content ?? "", /Compacted 2 messages/u);
  const replay = await replaySession(recorder.filePath);
  assert.equal(replay.messages.length, 0);
  assert.equal(replay.messageTree.length, 2);
  assert.equal(replay.contextCheckpoint?.firstKeptMessageIndex, 2);
  assert.deepEqual(replay.contextCheckpoint?.state?.goal, ["Keep the unfinished task and verified sources."]);
  assert.equal(replay.contextCheckpoint?.evidence?.some((claim) => claim.references.some((source) => source.messageId !== undefined)), true);
  assert.deepEqual(events.map((event) => event.type), ["compact.started", "compact.completed"]);
  await agent.resume("compact-e2e");
  const unchanged = await executeRuntimeCommand(runtime, services, "/compact", "desktop");
  assert.deepEqual(unchanged?.compaction, { outcome: "unchanged" });
  const stored = await readSessionEvents(recorder.filePath);
  assert.equal(stored.filter((event) => event.type === "context_checkpoint").length, 1);
  assert.deepEqual(runtime.getSnapshot().state, { kind: "idle" });
  console.log("compact command e2e tests passed");
} finally {
  await runtime?.close();
  if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
  await rm(root, { recursive: true, force: true });
}

function checkpoint(invalid: boolean): string {
  const citation = invalid ? "" : " <!-- evidence:m0 -->";
  return [
    "## Goal", `- Keep the unfinished task and verified sources.${citation}`,
    "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
    "## All User Messages", `- Keep the unfinished task and verified sources.${citation}`,
    "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
  ].join("\n");
}
