/** In-memory provider streams must hand off only complete, validated tool inputs. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { InvalidToolInputError, jsonSchema } from "ai";
import { toolCallRepair } from "../src/agent/core/toolCallRepair.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { JsonObjectSchema } from "../src/tools/schema.js";
import type { JSONSchema7, LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentEvent, AgentTool } from "../src/agent/core/types.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
type Transport = "direct" | "compatible";
type Call = { id: string; name?: string; input: string };

function fixture(calls: Call[], options: { transport?: Transport; noArguments?: boolean; failure?: boolean; disconnected?: boolean; agentTool?: AgentTool; parameters?: AgentTool["parameters"]; finishGate?: Promise<void> } = {}) {
  const executions: Array<{ id: string; args: Record<string, unknown> }> = [];
  const events: AgentEvent[] = [];
  let requests = 0;
  const tool: AgentTool = options.agentTool ?? {
    name: "Inspect", description: "Inspect an in-memory fixture",
    parameters: options.parameters ?? (options.noArguments ? { type: "object", properties: {}, additionalProperties: false } : {
      type: "object", properties: { path: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1 } },
      required: ["path"], additionalProperties: false
    }),
    execute: async (id, args) => { executions.push({ id, args }); return { content: [], terminate: true }; }
  };
  const direct: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "fixture", supportedUrls: {},
    doGenerate: async () => { throw new Error("Unexpected generate"); },
    doStream: async () => {
      requests++;
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const call of calls) controller.enqueue({ type: "tool-call", toolCallId: call.id, toolName: call.name ?? "Inspect", input: call.input });
        await options.finishGate;
        if (options.disconnected) { controller.error(new Error("fixture connection lost")); return; }
        if (options.failure) controller.enqueue({ type: "error", error: new Error("fixture provider failed") });
        controller.enqueue({ type: "finish", finishReason: { unified: options.failure ? "error" : "tool-calls", raw: undefined }, usage });
        controller.close();
      } }) };
    }
  };
  const compatible = () => createVercelLanguageModel({
    providerAlias: "fixture", providerType: "openai-compatible", authMode: "api-key", api: "chat_completions",
    modelId: "fixture", supportsReasoning: false, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {},
    fetcher: async () => {
      requests++;
      return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
        const send = (value: unknown) => {
          const bytes = new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
          // Split actual UTF-8 bytes and SSE/JSON syntax, not just logical argument deltas.
          for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
        };
        const delta = (toolCalls: unknown[]) => send({ choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
        calls.forEach((call, index) => delta([{ index, id: call.id, type: "function", function: { name: call.name ?? "Inspect", arguments: "" } }]));
        // Interleave separate IDs, including splits inside escaped JSON and surrogate pairs.
        for (let offset = 0; offset < Math.max(0, ...calls.map(call => call.input.length)); offset += 2) {
          calls.forEach((call, index) => {
            if (offset < call.input.length) delta([{ index, function: { arguments: call.input.slice(offset, offset + 2) } }]);
          });
        }
        await options.finishGate;
        if (options.disconnected) { controller.error(new Error("fixture connection lost")); return; }
        if (options.failure) send({ error: { message: "fixture provider failed", type: "fixture_error" } });
        else send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    }
  });
  const provider = options.transport === "compatible" ? compatible() : direct;
  const done = (async () => {
    for await (const event of vercelAgentLoopContinue(
      { messages: [{ role: "user", content: "Inspect" }], tools: [tool] },
      { model: { provider: "openai-compatible", modelId: "fixture" }, vercelModel: provider, tools: [tool], maxSteps: 2, maxRetries: 0, shouldStopAfterTurn: options.agentTool ? async () => true : undefined }
    )) events.push(event);
  })();
  return { executions, events, done, requests: () => requests };
}

for (const transport of ["direct", "compatible"] as const) {
  for (const [label, input] of [
    ["empty required arguments", ""],
    ["missing required property", "{}"],
    ["numeric bound violation", '{"path":"fixture","count":0}'],
    ["top-level null", "null"],
    ["top-level array", "[]"],
    ["incomplete JSON", '{"path":"unfinished'],
    ["invalid repaired value", '{"filepath":"fixture","count":"0"}']
  ]) {
    test(`${transport}: ${label} never reach tool execution`, async () => {
      const run = fixture([{ id: "invalid", input: input! }], { transport });
      await run.done;
      assert.deepEqual(run.executions, []);
      assert.equal(run.requests(), 1, "invalid input must stop rather than request the same call again");
      assert.equal(run.events.filter(event => event.type === "tool_execution_start").length, 0);
      assert.equal(run.events.some(event => event.type === "error" && event.fatal), true);
    });
  }

  for (const [name, input] of [["Unavailable", "{}"], ["inspect", '{"path":"incomplete']]) {
    test(`${transport}: malformed or unknown tool ${name} stays rejected`, async () => {
      const run = fixture([{ id: "invalid-name", name, input: input! }], { transport });
      await run.done;
      assert.deepEqual(run.executions, []);
      assert.equal(run.requests(), 1);
      assert.equal(run.events.some(event => event.type === "error" && event.fatal), true);
    });
  }

  test(`${transport}: interrupted provider streams do not execute or replay tools`, async () => {
    const run = fixture([{ id: "interrupted", input: '{"path":"fixture"}' }], { transport, disconnected: true });
    await run.done;
    assert.deepEqual(run.executions, []);
    assert.equal(run.requests(), 1);
    assert.equal(run.events.some(event => event.type === "error" && event.fatal), true);
  });

  test(`${transport}: known-tool argument repair is revalidated before execution`, async () => {
    const run = fixture([{ id: "repaired", input: '{"filepath":"fixture","count":"2"}' }], { transport });
    await run.done;
    assert.deepEqual(run.executions, [{ id: "repaired", args: { path: "fixture", count: 2 } }]);
    assert.equal(run.requests(), 1);
    assert.equal(run.events.some(event => event.type === "error"), false);
  });

  test(`${transport}: mixed calls validate and repair independently without duplicating IDs`, async () => {
    const run = fixture([
      { id: "valid", input: '{"path":"first"}' },
      { id: "invalid", input: '{"count":0}' },
      { id: "repaired", name: "inspect", input: '{"filepath":"second","count":"2"}' }
    ], { transport });
    await run.done;
    assert.deepEqual(run.executions, [
      { id: "valid", args: { path: "first" } },
      { id: "repaired", args: { path: "second", count: 2 } }
    ]);
    assert.deepEqual(run.events.filter(event => event.type === "tool_execution_start").map(event => event.toolCallId), ["valid", "repaired"]);
    assert.equal(run.requests(), 1);
  });

  test(`${transport}: legitimate empty arguments execute exactly once`, async () => {
    const run = fixture([{ id: "empty", input: "" }], { transport, noArguments: true });
    await run.done;
    assert.deepEqual(run.executions, [{ id: "empty", args: {} }]);
    assert.equal(run.requests(), 1);
    assert.equal(run.events.some(event => event.type === "error"), false);
  });

  test(`${transport}: terminal provider failure never releases queued tools`, async () => {
    const run = fixture([{ id: "failed", input: '{"path":"fixture"}' }], { transport, failure: true });
    await run.done;
    assert.deepEqual(run.executions, []);
    assert.equal(run.requests(), 1);
    assert.equal(run.events.some(event => event.type === "error" && event.fatal), true);
  });

  test(`${transport}: interleaved fragmented Unicode calls wait for completion and execute once`, async () => {
    let finish!: () => void;
    const finishGate = new Promise<void>(resolve => { finish = resolve; });
    const expected = [{ id: "first", args: { path: "文件🦋\\quoted\"\n", count: 2 } }, { id: "second", args: { path: "second☃", count: 3 } }];
    const run = fixture(expected.map(call => ({ id: call.id, input: JSON.stringify(call.args) })), { transport, finishGate });
    try {
      // Allow provider deltas and SDK transformations to drain before the terminal chunk.
      for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(run.executions, [], "complete JSON alone cannot release tool execution before provider completion");
    } finally {
      finish();
      await run.done;
    }
    assert.deepEqual(run.executions, expected);
    assert.equal(run.requests(), 1);
    assert.equal(run.events.filter(event => event.type === "tool_execution_start").length, 2);
    assert.equal(run.events.some(event => event.type === "error"), false);
  });
}

for (const mode of ["raw-validation", "approved", "denied", "budget", "collision"] as const) {
  test(`main coordinator retains ${mode} after SDK repair`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-stream-validation-"));
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "ask";
    const recorder = new SessionRecorder(root, "validation");
    const registry = new ToolRegistry();
    const resolved: unknown[] = [];
    const executed: unknown[] = [];
    let permissionRequests = 0;
    registry.register({
      name: "Inspect", description: "Fake in-memory write with normal admission",
      parameters: { type: "object", properties: { path: { type: "string" }, count: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false },
      schema: z.object({ path: z.string(), count: z.number().int().min(1).optional() }),
      risk: "write",
      resolveExecution(args) {
        resolved.push(args);
        return { approvalRule: "Inspect", async execute() { executed.push(args); return { ok: true }; } };
      }
    });
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot: root, config, recorder, toolRegistry: registry,
      confirmPermission: async () => { permissionRequests++; return { approved: mode === "approved" }; }
    }, new PermissionManager(config.permission), () => undefined, () => ({}), undefined,
    { maxToolCalls: 1, maxRepeatedActions: 10, initialToolCallCount: mode === "budget" ? 1 : 0 });
    const agentTool = coordinator.createAgentTools().find(tool => tool.name === "Inspect")!;
    try {
      if (mode === "raw-validation") {
        const result = await agentTool.execute("raw-invalid", {});
        assert.equal(result.isError, true, "the coordinator independently rejects invalid arguments even without the SDK fix");
        assert.deepEqual(resolved, []);
        assert.deepEqual(executed, []);
        assert.equal(permissionRequests, 0);
      } else if (mode === "collision") {
        const run = fixture([{ id: "ambiguous-original", input: '{"filepath":"one","path":"two","count":"2"}' }], { agentTool });
        await run.done;
        assert.deepEqual(resolved, []);
        assert.deepEqual(executed, []);
        assert.equal(permissionRequests, 0);
        assert.equal(run.requests(), 1);
        assert.equal(run.events.some(event => event.type === "tool_execution_start"), false);
      } else {
        const run = fixture([{ id: "original-call-id", input: '{"filepath":"fixture","count":"2"}' }], { agentTool });
        await run.done;
        assert.equal(run.requests(), 1);
        assert.deepEqual(run.events.filter(event => event.type === "tool_execution_start").map(event => event.toolCallId), ["original-call-id"]);
        assert.deepEqual(resolved, mode === "budget" ? [] : [{ path: "fixture", count: 2 }]);
        assert.deepEqual(executed, mode === "approved" ? [{ path: "fixture", count: 2 }] : []);
        assert.equal(permissionRequests, mode === "budget" ? 0 : 1);
        const result = run.events.find(event => event.type === "tool_execution_end");
        assert.equal(result?.type === "tool_execution_end" ? result.result.isError : undefined, mode !== "approved");
        if (mode === "budget") assert.equal(coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 2);
      }
    } finally {
      await coordinator.waitForIdle();
      await recorder.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}


const openInput = {
  path: "fixture", count: "2", scope: "only-this-folder", dryRun: true, filepath: "independent metadata",
  nested: { label: "keep", scope: "nested-folder", dryRun: true, filepath: "nested metadata" }
};
const repairedOpenInput = { ...openInput, count: 2 };
function openParameters(additionalProperties: unknown): JsonObjectSchema {
  const open = additionalProperties === undefined ? {} : { additionalProperties };
  return {
    type: "object", required: ["path"],
    properties: {
      path: { type: "string" }, count: { type: "integer", minimum: 1 },
      nested: { type: "object", properties: { label: { type: "string" } }, ...open }
    }, ...open
  } as JsonObjectSchema;
}
async function repairInput(parameters: AgentTool["parameters"], input: Record<string, unknown>) {
  return await toolCallRepair({
    toolCall: { type: "tool-call", toolCallId: "original", toolName: "Inspect", input: JSON.stringify(input) },
    tools: { Inspect: { inputSchema: jsonSchema(parameters as JSONSchema7) } }, inputSchema: async () => parameters as JSONSchema7,
    instructions: undefined, system: undefined, messages: [],
    error: new InvalidToolInputError({ toolName: "Inspect", toolInput: JSON.stringify(input), cause: new Error("fixture validation") })
  });
}

for (const [label, openness] of [["default-open", undefined], ["explicitly-open", true], ["schema-valued", {}]] as const) {
  test(`direct repair preserves top-level and nested ${label} inputs including alias-looking extras`, async () => {
    const result = await repairInput(openParameters(openness), openInput);
    assert.ok(result);
    assert.equal(result.toolCallId, "original");
    assert.deepEqual(JSON.parse(result.input), repairedOpenInput);
  });
  for (const transport of ["direct", "compatible"] as const) {
    test(`${transport}: ${label} repair keeps every permitted field`, async () => {
      const run = fixture([{ id: "open", input: JSON.stringify(openInput) }], { transport, parameters: openParameters(openness) });
      await run.done;
      assert.deepEqual(run.executions, [{ id: "open", args: repairedOpenInput }]);
      assert.equal(run.requests(), 1);
    });
  }
  test(`MCP-style coordinator receives complete ${label} repaired arguments after permission`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-open-tool-validation-"));
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "ask";
    const recorder = new SessionRecorder(root, "open-validation");
    const registry = new ToolRegistry();
    const resolved: unknown[] = [];
    const executed: unknown[] = [];
    const permissionIds: string[] = [];
    registry.register({
      name: "Inspect", description: "Fake MCP-style open schema", parameters: openParameters(openness), schema: z.unknown(), risk: "execute",
      resolveExecution(args) {
        resolved.push(args);
        return { approvalRule: "Inspect", async execute() { executed.push(args); return { ok: true }; } };
      }
    }, "mcp");
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot: root, config, recorder, toolRegistry: registry,
      confirmPermission: async request => { permissionIds.push(request.toolCallId); return { approved: true }; }
    }, new PermissionManager(config.permission), () => undefined);
    try {
      const agentTool = coordinator.createAgentTools().find(tool => tool.name === "Inspect")!;
      const run = fixture([{ id: "open-original", input: JSON.stringify(openInput) }], { agentTool });
      await run.done;
      assert.deepEqual(resolved, [repairedOpenInput]);
      assert.deepEqual(permissionIds, ["open-original"]);
      assert.deepEqual(executed, [repairedOpenInput]);
      assert.equal(run.requests(), 1);
    } finally {
      await coordinator.waitForIdle();
      await recorder.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

const closedParameters: AgentTool["parameters"] = {
  type: "object", properties: { path: { type: "string" }, count: { type: "integer" } }, required: ["path"], additionalProperties: false
};
for (const [label, input] of [
  ["alias before canonical", { filepath: "one", path: "two", count: "2" }],
  ["canonical before alias", { path: "two", filepath: "one", count: "2" }],
  ["two aliases", { filepath: "one", filename: "two", count: "2" }]
] as const) {
  test(`direct repair rejects closed-schema ${label} collision instead of guessing`, async () => {
    assert.equal(await repairInput(closedParameters, input), null);
  });
  for (const transport of ["direct", "compatible"] as const) {
    test(`${transport}: closed-schema ${label} collision stays rejected`, async () => {
      const run = fixture([{ id: "collision", input: JSON.stringify(input) }], { transport, parameters: closedParameters });
      await run.done;
      assert.deepEqual(run.executions, []);
      assert.equal(run.requests(), 1);
    });
  }
}

test("direct repair keeps established unambiguous closed-schema alias and forbidden-extra behavior", async () => {
  const result = await repairInput(closedParameters, { filepath: "fixture", count: "2", forbidden: true });
  assert.ok(result);
  assert.deepEqual(JSON.parse(result.input), { path: "fixture", count: 2 });
});

for (const transport of ["direct", "compatible"] as const) {
  test(`${transport}: invalid nested open input is rejected without recursive guessing`, async () => {
    const parameters = openParameters(true);
    const run = fixture([{ id: "nested-invalid", input: JSON.stringify({ ...openInput, nested: { label: [], scope: "keep" } }) }], { transport, parameters });
    await run.done;
    assert.deepEqual(run.executions, []);
    assert.equal(run.requests(), 1);
  });
}

for (const shape of [
  { patternProperties: { "^scope": { type: "string" } } },
  { anyOf: [{ properties: { scope: { type: "string" } } }] },
  { $ref: "#/definitions/input", definitions: { input: { type: "object", properties: { scope: { type: "string" } }, additionalProperties: true } } }
]) {
  const parameters = { ...closedParameters, ...shape } as AgentTool["parameters"];
  test(`direct repair declines complex schema ${Object.keys(shape)[0]} rather than rewriting unfamiliar constraints`, async () => {
    assert.equal(await repairInput(parameters, { path: "fixture", count: "2", scope: "only-here" }), null);
  });
  for (const transport of ["direct", "compatible"] as const) {
    test(`${transport}: complex schema ${Object.keys(shape)[0]} fails closed without lossy repair`, async () => {
      const run = fixture([{ id: "complex", input: '{"path":"fixture","count":"2","scope":"only-here"}' }], { transport, parameters });
      await run.done;
      assert.deepEqual(run.executions, []);
      assert.equal(run.requests(), 1);
    });
  }
}


for (const [label, properties, input] of [
  ["normalized schema keys", { fooBar: { type: "string" }, foo_bar: { type: "string" } }, { "FOO-BAR": "ambiguous" }],
  ["multiple alias destinations", { maxResults: { type: "integer" }, lineCount: { type: "integer" } }, { maxcount: 2 }]
] as const) {
  const parameters: AgentTool["parameters"] = { type: "object", properties, additionalProperties: false };
  test(`direct repair rejects ambiguous ${label}`, async () => {
    assert.equal(await repairInput(parameters, input), null);
  });
  for (const transport of ["direct", "compatible"] as const) {
    test(`${transport}: ambiguous ${label} never select a field by insertion order`, async () => {
      const run = fixture([{ id: "ambiguous-schema", input: JSON.stringify(input) }], { transport, parameters });
      await run.done;
      assert.deepEqual(run.executions, []);
      assert.equal(run.requests(), 1);
    });
  }
}

const exactKeyParameters: AgentTool["parameters"] = {
  type: "object", properties: { fooBar: { type: "string" }, foo_bar: { type: "string" }, count: { type: "integer" } }, additionalProperties: false
};
const exactKeyInput = { fooBar: "first", foo_bar: "second", count: "2" };
test("direct repair preserves exact declared keys even when their normalized forms collide", async () => {
  const result = await repairInput(exactKeyParameters, exactKeyInput);
  assert.ok(result);
  assert.deepEqual(JSON.parse(result.input), { ...exactKeyInput, count: 2 });
});
for (const transport of ["direct", "compatible"] as const) {
  test(`${transport}: exact declared keys retain precedence over normalized matches`, async () => {
    const run = fixture([{ id: "exact-keys", input: JSON.stringify(exactKeyInput) }], { transport, parameters: exactKeyParameters });
    await run.done;
    assert.deepEqual(run.executions, [{ id: "exact-keys", args: { ...exactKeyInput, count: 2 } }]);
    assert.equal(run.requests(), 1);
  });
}
