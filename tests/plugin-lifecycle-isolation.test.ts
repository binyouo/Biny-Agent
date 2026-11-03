import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginLifecycleRegistry,
  type PluginAfterTurnContext,
  type PluginBeforeTurnContext,
  type PluginMcpToolCaller
} from "../src/extensions/pluginLifecycle.js";

test("beforeTurn gives each plugin its own context while retaining execution bindings", async () => {
  const registry = new PluginLifecycleRegistry();
  const controller = new AbortController();
  const context: PluginBeforeTurnContext = {
    workspaceRoot: "/fixture/project", sessionId: "original-session", userMessage: "original message",
    useMemories: true, contributeMemories: false, signal: controller.signal
  };
  const callMcpTool: PluginMcpToolCaller = async () => "original caller";
  let observed: PluginBeforeTurnContext | undefined;
  registry.register({ beforeTurn(input) {
    input.sessionId = "other-session";
    input.userMessage = "changed message";
    input.contributeMemories = true;
    input.callMcpTool = async () => "changed caller";
  } });
  registry.register({ beforeTurn(input) {
    observed = input;
    return `${input.sessionId}: ${input.userMessage}`;
  } });

  assert.deepEqual(await registry.beforeTurn(context, callMcpTool), ["original-session: original message"]);
  assert.equal(observed?.contributeMemories, false);
  assert.equal(observed?.signal, controller.signal);
  assert.equal(observed?.callMcpTool, callMcpTool);
  assert.equal(context.sessionId, "original-session");
  assert.equal(context.userMessage, "original message");
  assert.equal(context.contributeMemories, false);
});

test("afterTurn cannot change another plugin's history or the caller's terminal outcome", async () => {
  const registry = new PluginLifecycleRegistry();
  const controller = new AbortController();
  const context: PluginAfterTurnContext = {
    workspaceRoot: "/fixture/project", sessionId: "original-session", userMessage: "original message",
    useMemories: true, contributeMemories: false, signal: controller.signal,
    outcome: {
      status: "completed", stopReason: "model_stop", steps: 1, output: "original answer",
      affectedTodoIds: ["todo-original"],
      usage: { operation: "agent", modelAlias: "test", provider: "test", model: "test", totalTokens: 12, pricingKnown: false }
    },
    messages: [{ id: "message-original", role: "assistant", content: "original answer" }]
  };
  const callMcpTool: PluginMcpToolCaller = async () => "original caller";
  let observed: PluginAfterTurnContext | undefined;
  registry.register({ afterTurn(input) {
    input.sessionId = "other-session";
    input.messages[0]!.content = "changed history";
    input.outcome.status = "failed";
    input.outcome.output = "changed answer";
    input.outcome.affectedTodoIds!.push("todo-other");
    input.outcome.usage!.totalTokens = 999;
    input.callMcpTool = async () => "changed caller";
  } });
  registry.register({ afterTurn(input) { observed = input; } });

  await registry.afterTurn(context, callMcpTool);
  for (const actual of [observed, context]) {
    assert.equal(actual?.sessionId, "original-session");
    assert.deepEqual(actual?.messages, [{ id: "message-original", role: "assistant", content: "original answer" }]);
    assert.deepEqual(actual?.outcome, {
      status: "completed", stopReason: "model_stop", steps: 1, output: "original answer",
      affectedTodoIds: ["todo-original"],
      usage: { operation: "agent", modelAlias: "test", provider: "test", model: "test", totalTokens: 12, pricingKnown: false }
    });
  }
  assert.equal(observed?.signal, controller.signal);
  assert.equal(observed?.callMcpTool, callMcpTool);
});
