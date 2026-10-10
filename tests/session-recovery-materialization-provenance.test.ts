import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

const config = configSchema.parse({ ...defaultConfig,
  activity: { ...defaultConfig.activity, enabled: false }, diagnostics: { ...defaultConfig.diagnostics, enabled: false },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }, crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
  context: { ...defaultConfig.context, maxInputTokens: 1_000_000,
    memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }, identity: { ...defaultConfig.context.identity, enabled: false } }
});
const opaque = { token: "business-token", password: "business-password", nextPageToken: "opaque-next-page", body: "Bearer fixture-business-value" };

for (const scenario of ["opaque", "generic", "unknown", "mutated-cache"] as const) {
  test(`public continuation preserves physical ${scenario} evidence through completion and next cold provider`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-materialization-provenance-"));
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root, "provenance");
    recorder.setRuntimeContext({ runId: "original", turnId: "owner" });
    await recorder.recordAndFlush({ type: "user_message", content: "Inspect durable facts", messageId: "user" });
    await recorder.recordAndFlush({ type: "tool_call", tool: "native_probe", toolCallId: "probe", sequence: 1, args: { value: "input" },
      reasoningBlocks: [{ text: "signed durable thought", providerOptions: { fixture: { signature: "fixture-signature" } } }] });
    await recorder.recordAndFlush({ type: "tool_execution", tool: "native_probe", toolCallId: "probe", sequence: 1,
      operationId: "native-operation", state: scenario === "unknown" ? "running" : "succeeded", retrySafety: scenario === "unknown" ? "unsafe" : "safe" });
    if (scenario !== "unknown") await recorder.recordAndFlush({ type: "tool_result", tool: "native_probe", toolCallId: "probe", sequence: 1,
      operationId: "native-operation", executionStatus: "succeeded", result: opaque }, undefined, scenario === "generic" ? {} : { context: "mcp-result" });
    const events = await readSessionEvents(recorder.filePath);
    const original = replaySessionEvents(events, { sessionId: "provenance" });
    const expectedResult = original.messages.find(message => message.role === "toolResult");
    assert.ok(expectedResult?.role === "toolResult");
    if (scenario === "generic") {
      assert.notDeepEqual(expectedResult.details, opaque);
      assert.doesNotMatch(JSON.stringify(expectedResult), /business-token|business-password/u);
    } else if (scenario !== "unknown") assert.deepEqual(expectedResult.details, opaque);
    await new TurnStore(root, "provenance").save("Inspect durable facts", "Synthetic system", original.messages, 1, undefined, undefined, undefined, recorder.runtimeHighWater(), "owner");
    await recorder.close();
    let requests = 0;
    let actual: AgentMessage[] = [];
    const make = () => new AgentSession({ workspaceRoot: root, config, recorder: new SessionRecorder(root),
      toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission),
      model: { provider: "synthetic", modelId: scenario, supportsTools: true, stream: async context => {
        requests += 1; actual = structuredClone(context.messages);
        return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "Completed from durable evidence" }; yield { type: "finish", reason: "stop" }; })();
      } }
    });
    const agent = make();
    try {
      await agent.initialize(); await agent.resume("provenance");
      if (scenario === "mutated-cache") {
        const cached = await readSessionEvents(agent.getInfo().sessionFile);
        const result = cached.find(event => event.type === "tool_result");
        assert.ok(result?.type === "tool_result");
        result.result = { invented: "NEVER_DURABLE" };
      }
      let status: string | undefined;
      let blockedReason: string | undefined;
      for await (const event of agent.continueInterruptedTurn({ emotionAnalysis: false })) if (event.type === "done") {
        status = event.outcome.status; blockedReason = event.outcome.blockedReason;
      }
      if (scenario === "unknown") {
        assert.equal(status, "blocked");
        assert.equal(blockedReason, "unsafe_action_required");
        assert.equal(requests, 0);
        const physical = await readFile(agent.getInfo().sessionFile, "utf8");
        assert.doesNotMatch(physical, /"type":"agent_message"/u);
        assert.ok(await new TurnStore(root, "provenance").load());
        return;
      }
      assert.equal(status, "completed");
      assert.deepEqual(actual.find(message => message.role === "assistant"), original.messages.find(message => message.role === "assistant"));
      assert.deepEqual(resultBody(actual.find(message => message.role === "toolResult")), resultBody(expectedResult));
      const physical = await readFile(agent.getInfo().sessionFile, "utf8");
      assert.doesNotMatch(physical, /NEVER_DURABLE/u);
      assert.match(physical, /fixture-signature/u);
    } finally { await agent.close(); }
    const cold = make();
    try {
      await cold.initialize();
      const replay = await cold.resume("provenance");
      assert.deepEqual(resultBody(replay.messages.find(message => message.role === "toolResult")), resultBody(expectedResult));
      assert.equal((await cold.runTask("Next task", { emotionAnalysis: false })).status, "completed");
      assert.deepEqual(resultBody(actual.find(message => message.role === "toolResult")), resultBody(expectedResult));
      assert.equal(requests, 2);
      assert.equal(await new TurnStore(root, "provenance").load(), undefined);
    } finally { await cold.close(); await rm(root, { recursive: true, force: true }); }
  });
}

function resultBody(message: AgentMessage | undefined) {
  assert.ok(message?.role === "toolResult");
  return { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, details: message.details };
}
