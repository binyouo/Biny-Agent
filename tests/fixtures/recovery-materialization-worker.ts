/** Real process-crash fixture. All providers and tools are local injected stand-ins. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { AgentSession } from "../../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamEvent } from "../../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../../src/config/schema.js";
import { PermissionManager } from "../../src/permission/PermissionManager.js";
import { readSessionEvents } from "../../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../../src/session/recorder.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const [root, sessionId, crashAtText, marker] = process.argv.slice(2);
assert.ok(root && sessionId && crashAtText && marker);
const crashAt = Number(crashAtText);
const config = configSchema.parse({ ...defaultConfig,
  activity: { ...defaultConfig.activity, enabled: false }, diagnostics: { ...defaultConfig.diagnostics, enabled: false },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }, crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
  context: { ...defaultConfig.context, maxInputTokens: 1_000_000,
    memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }, identity: { ...defaultConfig.context.identity, enabled: false } }
});
let counting = false;
let persisted = 0;
let providerCalls = 0;
let messages: AgentMessage[] = [];
const sink = { appendSessionEvent(input: { event: unknown }) {
  const event = input.event as SessionEvent;
  if (!counting || event.type !== "agent_message") return;
  const toolMessage = event.message.role === "toolResult" || event.message.content.some(part => part.type === "toolCall");
  if (!toolMessage) return;
  persisted += 1;
  if (persisted === crashAt) {
    // recordAndFlush invokes the sink only after fsync. No private function is patched.
    writeFileSync(marker, JSON.stringify({ persisted, event, providerCalls }));
    process.kill(process.pid, "SIGKILL");
  }
} };
const agent = new AgentSession({ workspaceRoot: root, recorder: new SessionRecorder(root, undefined, undefined, sink),
  runtimeEventSink: sink, config, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission),
  model: { provider: "synthetic", modelId: "crash-recovery", supportsTools: true, stream: async context => {
    providerCalls += 1;
    messages = structuredClone(context.messages);
    return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "Recovered safely" }; yield { type: "finish", reason: "stop" }; })();
  } }
});
try {
  await agent.initialize();
  await agent.resume(sessionId);
  counting = true;
  const outcomes = [];
  for await (const event of agent.continueInterruptedTurn({ emotionAnalysis: false })) if (event.type === "done") outcomes.push(event.outcome);
  assert.equal(crashAt, 0, "expected process kill at materialization commit");
  await writeFile(marker, JSON.stringify({ persisted, providerCalls, messages, outcomes, events: await readSessionEvents(agent.getInfo().sessionFile) }));
} finally { await agent.close(); }
