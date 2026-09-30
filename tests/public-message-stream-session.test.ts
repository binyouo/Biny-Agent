/** 真正的 AgentSession 流式入口：跨工具步、延迟尾部及中断后重试均使用独立过滤状态。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig, configSchema } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function withAgent(model: AgentModel, run: (agent: AgentSession) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-stream-session-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const tools = new ToolRegistry();
  tools.registerBuiltinTool({ name: "Read", label: "Read", description: "Read a test value", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }] }; } });
  const config = configSchema.parse({ ...defaultConfig, context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } } });
  const agent = new AgentSession({ workspaceRoot: root, config, model, toolRegistry: tools, permissionManager: new PermissionManager(config.permission), recorder });
  try { await agent.initialize(); await run(agent); }
  finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
}

test("actual streaming resets after tool steps and releases a deferred canonical tail exactly once", async () => {
  let requests = 0;
  const tail = " ".repeat(300) + "final answer";
  const model: AgentModel = {
    provider: "test", modelId: "stream-projection", supportsTools: true,
    async stream() {
      requests += 1;
      const events: ModelStreamEvent[] = requests === 1 ? [
        { type: "text-delta", text: "Step one\n<think>private" },
        { type: "tool-call", id: "read", name: "Read", arguments: {} },
        { type: "finish", reason: "tool-calls" }
      ] : requests === 2 ? [
        { type: "text-delta", text: "Next step\n<bin" },
        { type: "text-delta", text: "y_notification>private</biny_notification>\n" },
        { type: "text-delta", text: tail },
        { type: "finish", reason: "stop" }
      ] : requests === 3 ? [
        { type: "text-delta", text: "Fresh reply" },
        { type: "finish", reason: "stop" }
      ] : [
        { type: "text-delta", text: "A<bin<biny_notification>x" },
        { type: "text-delta", text: "</biny_notification>y_notification>private" },
        { type: "finish", reason: "stop" }
      ];
      return (async function* () { yield* events; })();
    }
  };
  await withAgent(model, async (agent) => {
    let visible = "";
    let outcome = "";
    for await (const event of agent.prompt("Read the value", { confirmPermission: async () => ({ approved: true, scope: "once" }), emotionAnalysis: false })) {
      if (event.type === "assistant.delta") visible += event.content;
      if (event.type === "done") { assert.equal(event.outcome.status, "completed"); outcome = event.outcome.output; }
    }
    assert.equal(visible, "Step one\nNext step\n\n" + tail);
    assert.equal(outcome, "Next step\n\n" + tail);
    assert.doesNotMatch(visible, /private|biny_notification|<think/u);
    let fresh = "";
    for await (const event of agent.prompt("Again", { emotionAnalysis: false })) {
      if (event.type === "assistant.delta") fresh += event.content;
    }
    assert.equal(fresh, "Fresh reply");
    let joined = "";
    for await (const event of agent.prompt("Check a fragmented notification", { emotionAnalysis: false })) {
      if (event.type === "assistant.delta") joined += event.content;
      if (event.type === "done") assert.equal(event.outcome.output, "A");
    }
    assert.equal(joined, "A", "removing an inner notification cannot expose an assembled outer tag");
    assert.equal(requests, 4);
  });
});

test("an interrupted hidden envelope cannot swallow or leak into the next prompt", async () => {
  const controller = new AbortController();
  let requests = 0;
  const model: AgentModel = {
    provider: "test", modelId: "stream-interruption", supportsTools: false,
    async stream() {
      requests += 1;
      const current = requests;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (current === 1) {
          yield { type: "text-delta", text: "Before interruption\n" };
          yield { type: "text-delta", text: "<thinking>private interrupted text" };
          controller.abort(new Error("test interruption"));
          controller.signal.throwIfAborted();
        }
        yield { type: "text-delta", text: "After interruption" };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  await withAgent(model, async (agent) => {
    let visible = "";
    let status = "";
    for await (const event of agent.prompt("Start", { abortSignal: controller.signal, emotionAnalysis: false })) {
      if (event.type === "assistant.delta") visible += event.content;
      if (event.type === "done") status = event.outcome.status;
    }
    assert.equal(status, "cancelled");
    assert.doesNotMatch(visible, /private|thinking/u);
    let next = "";
    for await (const event of agent.prompt("Restart", { emotionAnalysis: false })) {
      if (event.type === "assistant.delta") next += event.content;
    }
    assert.equal(next, "After interruption");
  });
});
