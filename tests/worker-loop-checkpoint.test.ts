import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { prepareSubagentTask, runSubagentTask, type SubagentOptions } from "../src/extensions/subagent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolAccesses } from "../src/tools/access.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";

test("worker cold continuation retains settled tool history and never rewrites the completed effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-loop-"));
  let writes = 0;
  let requests = 0;
  const registry = registryWithWrite(root, async () => { writes += 1; await writeFile(path.join(root, "artifact.txt"), "candidate"); });
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async (context) => {
      requests += 1;
      if (requests === 2) throw new Error("provider disappeared after the tool result");
      if (requests === 3) {
        assert.ok(context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "write-once"), "cold continuation must carry the persisted tool result");
        return response("candidate ready");
      }
      return toolCall();
    }
  };
  const options = workerOptions(root, registry, model);
  try {
    await assert.rejects(runSubagentTask(options, "produce candidate", undefined, "workspace", undefined, { taskId: "attempt-one", persistenceRoot: root }), /provider disappeared/u);
    assert.equal(writes, 1);
    assert.equal(await runSubagentTask(options, "produce candidate", undefined, "workspace", undefined, { taskId: "attempt-one", persistenceRoot: root, resume: true }), "candidate ready");
    assert.equal(writes, 1);
    assert.equal(requests, 3);
    assert.equal(await readFile(path.join(root, "artifact.txt"), "utf8"), "candidate");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker refuses to continue an interrupted dispatched write and changed capability policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-unknown-"));
  const controller = new AbortController();
  let requests = 0;
  const registry = registryWithWrite(root, async () => {
    await writeFile(path.join(root, "artifact.txt"), "effect happened");
    controller.abort(new Error("lost outcome"));
    throw controller.signal.reason;
  });
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async () => { requests += 1; return toolCall(); }
  };
  const options = workerOptions(root, registry, model);
  try {
    await assert.rejects(runSubagentTask(options, "produce candidate", controller.signal, "workspace", undefined, { taskId: "attempt-two", persistenceRoot: root }));
    const beforeResume = requests;
    await assert.rejects(runSubagentTask(options, "produce candidate", undefined, "workspace", undefined, { taskId: "attempt-two", persistenceRoot: root, resume: true }), /unknown|unsafe/u);
    assert.equal(requests, beforeResume);
    options.config.extensions.subagent.allowedTools = [];
    await assert.rejects(runSubagentTask(options, "produce candidate", undefined, "workspace", undefined, { taskId: "attempt-two", persistenceRoot: root, resume: true }), /unknown|policy|identity/u);
    assert.equal(requests, beforeResume);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replay preserves committed tool results when a canonical step was only partly written", () => {
  const replay = replaySessionEvents([
    { type: "user_message", content: "produce candidate" },
    { type: "tool_call", tool: "Write", toolCallId: "write-once", args: { path: "artifact.txt" } },
    { type: "tool_result", tool: "Write", toolCallId: "write-once", executionStatus: "succeeded", result: { written: true } },
    { type: "agent_message", message: { role: "assistant", content: [{ type: "toolCall", id: "write-once", name: "Write", arguments: { path: "artifact.txt" } }], stopReason: "tool-calls" } }
  ]);
  assert.deepEqual(replay.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
  assert.equal(replay.messages.at(-1)?.role === "toolResult" && replay.messages.at(-1)?.toolCallId, "write-once");
});

test("a final assistant committed before the completion checkpoint is recovered without another provider request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-final-window-"));
  let requests = 0;
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async () => { requests += 1; return response("durable final handoff"); }
  };
  const options = workerOptions(root, registryWithWrite(root, async () => assert.fail("no write expected")), model);
  const execution = { taskId: "final-window", persistenceRoot: root };
  try {
    assert.equal(await runSubagentTask(options, "inspect", undefined, "workspace", undefined, execution), "durable final handoff");
    const turns = new TurnStore(root, workerSessionId(execution.taskId));
    const saved = (await turns.load())!;
    const facts = saved.facts as Record<string, unknown>;
    await turns.save(saved.prompt, saved.systemPrompt, saved.messages, saved.completedSteps,
      { ...facts, status: "running", output: undefined }, undefined, undefined, saved.runtimeHighWater);
    assert.equal(await runSubagentTask(options, "inspect", undefined, "workspace", undefined, { ...execution, resume: true }), "durable final handoff");
    assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("safe interrupted reads produce recovery results while step budgets and child identities remain bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-safe-read-"));
  let requests = 0;
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async (context) => {
      requests += 1;
      if (requests === 1) throw new Error("provider disappeared");
      assert.ok(context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "interrupted-read"));
      return response("read can be retried");
    }
  };
  const options = workerOptions(root, registryWithWrite(root, async () => assert.fail("no write expected")), model);
  const execution = { taskId: "read-window", persistenceRoot: root };
  try {
    await assert.rejects(runSubagentTask(options, "inspect", undefined, "workspace", undefined, execution));
    const recorder = new SessionRecorder(root, workerSessionId(execution.taskId));
    const checkpoint = (await new TurnStore(root, recorder.sessionId).load())!;
    recorder.setRuntimeContext({ runId: "interrupted-request", turnId: checkpoint.turnId! });
    await recorder.recordAndFlush({ type: "tool_call", tool: "Read", toolCallId: "interrupted-read", sequence: 1, args: { path: "artifact.txt" } });
    await recorder.recordAndFlush({ type: "tool_execution", tool: "Read", toolCallId: "interrupted-read", sequence: 1, operationId: `${recorder.sessionId}/interrupted-read`, state: "running", retrySafety: "safe" });
    await recorder.close();
    assert.equal(await runSubagentTask(options, "inspect", undefined, "workspace", undefined, { ...execution, resume: true }), "read can be retried");
    const events = await readSessionEvents(sessionFilePath(root, workerSessionId(execution.taskId)));
    assert.equal(events.filter((event) => event.type === "tool_result" && event.recovered).length, 1);
    assert.notEqual(workerSessionId("read-window"), workerSessionId("other-worker"));
    options.config.extensions.subagent.maxSteps = 1;
    const exhausted = { taskId: "budget-window", persistenceRoot: root };
    const failing: AgentModel = { ...model, stream: async () => { requests += 1; throw new Error("no response"); } };
    options.getModelSettings = () => ({ model: failing, contextWindow: undefined });
    await assert.rejects(runSubagentTask(options, "inspect", undefined, "workspace", undefined, exhausted));
    const count = requests;
    await assert.rejects(runSubagentTask(options, "inspect", undefined, "workspace", undefined, { ...exhausted, resume: true }), /budget/u);
    assert.equal(requests, count);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("child writers are mutually exclusive and truncated JSONL tails are repaired before continuation appends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-tail-"));
  let requests = 0;
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async () => { requests += 1; if (requests === 1) throw new Error("interrupted request"); return response("restored"); }
  };
  const options = workerOptions(root, registryWithWrite(root, async () => assert.fail("no write expected")), model);
  const execution = { taskId: "tail-worker", persistenceRoot: root };
  let prepared: Awaited<ReturnType<typeof prepareSubagentTask>> | undefined;
  try {
    prepared = await prepareSubagentTask(options, "inspect", "workspace", undefined, execution);
    await assert.rejects(prepareSubagentTask(options, "inspect", "workspace", undefined, { ...execution, resume: true }), /owned|leased/u);
    await assert.rejects(prepared.run());
    await prepared.close();
    prepared = undefined;
    const file = sessionFilePath(root, workerSessionId(execution.taskId));
    await appendFile(file, '{"type":"tool_call","tool":');
    assert.equal(await runSubagentTask(options, "inspect", undefined, "workspace", undefined, { ...execution, resume: true }), "restored");
    assert.ok((await readSessionEvents(file)).some((event) => event.type === "turn_status" && event.status === "completed"));
    assert.equal(requests, 2);
  } finally { await prepared?.close(); await rm(root, { recursive: true, force: true }); }
});

test("canonical partial parallel steps recover only missing results and preserve signed reasoning", () => {
  const replay = replaySessionEvents([
    { type: "user_message", content: "inspect two files" },
    { type: "tool_call", tool: "Read", toolCallId: "read-one", args: { path: "one" } },
    { type: "tool_call", tool: "Read", toolCallId: "read-two", args: { path: "two" } },
    { type: "tool_result", tool: "Read", toolCallId: "read-one", executionStatus: "succeeded", result: "first" },
    { type: "tool_result", tool: "Read", toolCallId: "read-two", executionStatus: "succeeded", result: "second" },
    { type: "agent_message", message: { role: "assistant", content: [
      { type: "reasoning", text: "inspect", providerMetadata: { anthropic: { signature: "signed-reasoning" } } },
      { type: "toolCall", id: "read-one", name: "Read", arguments: { path: "one" } },
      { type: "toolCall", id: "read-two", name: "Read", arguments: { path: "two" } }
    ], stopReason: "tool-calls" } },
    { type: "agent_message", message: { role: "toolResult", toolCallId: "read-one", toolName: "Read", content: [{ type: "text", text: "first" }] } }
  ]);
  assert.deepEqual(replay.messages.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult"]);
  assert.equal(replay.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "read-one").length, 1);
  const assistant = replay.messages[1];
  assert.ok(assistant?.role === "assistant" && assistant.content.some((part) => part.type === "reasoning" && part.providerMetadata?.anthropic !== undefined));
});

test("prepared workers keep their admitted tool and budget policy while queued", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-policy-"));
  let writes = 0;
  let requests = 0;
  const registry = registryWithWrite(root, async () => { writes += 1; });
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async () => { requests += 1; return requests === 1 ? toolCall() : response("done"); }
  };
  const options = workerOptions(root, registry, model);
  const prepared = await prepareSubagentTask(options, "inspect", "workspace", undefined, { taskId: "queued-policy", persistenceRoot: root });
  try {
    options.config.extensions.subagent.allowedTools = [];
    options.config.extensions.subagent.maxSteps = 0;
    registry.unregister("Write");
    assert.equal(await prepared.run(), "done");
    assert.equal(writes, 1);
    assert.equal(requests, 2);
  } finally { await prepared.close(); await rm(root, { recursive: true, force: true }); }
});

test("a safe checkpoint refuses capability policy changes without spending a new model request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-policy-change-"));
  let requests = 0;
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async () => { requests += 1; throw new Error("provider interrupted"); }
  };
  const options = workerOptions(root, registryWithWrite(root, async () => assert.fail("no write expected")), model);
  const execution = { taskId: "changed-policy", persistenceRoot: root };
  try {
    await assert.rejects(runSubagentTask(options, "inspect", undefined, "workspace", undefined, execution), /provider interrupted/u);
    options.config.permission.mode = "ask";
    await assert.rejects(runSubagentTask(options, "inspect", undefined, "workspace", undefined, { ...execution, resume: true }), /policy changed/u);
    options.config.permission.mode = "full-access";
    options.config.extensions.subagent.maxSteps += 1;
    await assert.rejects(runSubagentTask(options, "inspect", undefined, "workspace", undefined, { ...execution, resume: true }), /policy changed/u);
    assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function workerOptions(root: string, registry: ToolRegistry, model: AgentModel): SubagentOptions {
  const config = structuredClone(defaultConfig);
  config.extensions.subagent.allowedTools = ["Write"];
  config.extensions.subagent.maxSteps = 6;
  return { workspaceRoot: root, config, toolRegistry: registry, getAccessMode: () => "workspace", getModelSettings: () => ({ model, contextWindow: undefined }) };
}

function registryWithWrite(root: string, execute: () => Promise<void>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerBuiltinTool({ name: "Write", description: "Write a candidate", capability: "filesystem.write", risk: "write",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    schema: z.object({ path: z.string() }),
    resolveExecution: () => ({ accesses: ToolAccesses.writeFile(path.join(root, "artifact.txt")), description: "Write candidate", approvalRule: "Write",
      execute: async () => { await execute(); return { written: true }; }
    })
  });
  return registry;
}

async function* toolCall(): AsyncGenerator<ModelStreamEvent> {
  yield { type: "start" };
  yield { type: "tool-call", id: "write-once", name: "Write", arguments: { path: "artifact.txt" } };
  yield { type: "finish", reason: "tool-calls" };
}

async function* response(text: string): AsyncGenerator<ModelStreamEvent> {
  yield { type: "start" };
  yield { type: "text-delta", text };
  yield { type: "finish", reason: "stop" };
}
