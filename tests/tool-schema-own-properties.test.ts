/** JSON object members, not JavaScript prototype members, determine tool argument validity. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentEvent, AgentTool } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { normalizeToolParameters, validateJsonSchema, type JsonObjectSchema, type JsonSchema } from "../src/tools/schema.js";

const closed: JsonObjectSchema = {
  type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false
};
// Include every built-in Object.prototype property, including shadowed hasOwnProperty.
const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
const transported = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const specialInput = (key: string, value: unknown): Record<string, unknown> => transported(Object.fromEntries([[key, value]]));
const declared = (key: string): JsonObjectSchema => ({
  type: "object", properties: Object.fromEntries([[key, { type: "string", minLength: 1 }]]),
  required: [key], additionalProperties: false
});

for (const key of prototypeNames) {
  test(`closed JSON schema rejects undeclared own ${key}`, () => {
    const input = transported({ path: "fixture", ...specialInput(key, "extra") });
    assert.equal(Object.hasOwn(input, key), true, "the test must contain a transported own JSON member");
    assert.deepEqual(validateJsonSchema(closed, input), { ok: false, errors: [`arguments.${key} is not allowed`] });
  });

  test(`required ${key} cannot be satisfied by Object.prototype`, () => {
    assert.deepEqual(validateJsonSchema(declared(key), transported({})), { ok: false, errors: [`arguments.${key} is required`] });
  });

  test(`explicit own ${key} remains supported and its value is validated`, () => {
    const parameters = declared(key);
    const valid = specialInput(key, "explicit");
    assert.deepEqual(validateJsonSchema(parameters, valid), { ok: true, errors: [] });
    assert.deepEqual(validateJsonSchema(parameters, specialInput(key, 123)), { ok: false, errors: [`arguments.${key} must be a string`] });
    assert.deepEqual(validateJsonSchema(parameters, specialInput(key, "")), { ok: false, errors: [`arguments.${key} must contain at least 1 character(s)`] });
    const normalized = normalizeToolParameters("special", parameters);
    assert.equal(Object.hasOwn(normalized.properties!, key), true);
    assert.deepEqual(validateJsonSchema(normalized, valid), { ok: true, errors: [] });
  });
}

test("ordinary unexpected keys remain rejected with normal required and type diagnostics", () => {
  assert.deepEqual(validateJsonSchema(closed, transported({ path: "fixture", unexpected: 1 })), {
    ok: false, errors: ["arguments.unexpected is not allowed"]
  });
  assert.deepEqual(validateJsonSchema(closed, transported({ path: 123 })), { ok: false, errors: ["arguments.path must be a string"] });
  assert.deepEqual(validateJsonSchema(closed, transported({})), { ok: false, errors: ["arguments.path is required"] });
});

test("closed objects without properties reject prototype-looking own keys", () => {
  for (const key of prototypeNames) {
    assert.deepEqual(validateJsonSchema({ type: "object", additionalProperties: false }, specialInput(key, "extra")), {
      ok: false, errors: [`arguments.${key} is not allowed`]
    });
  }
});

test("required-only special keys require an own member even in an open object", () => {
  for (const key of prototypeNames) {
    const parameters: JsonObjectSchema = { type: "object", required: [key] };
    assert.deepEqual(validateJsonSchema(parameters, transported({})), { ok: false, errors: [`arguments.${key} is required`] });
    assert.deepEqual(validateJsonSchema(parameters, specialInput(key, "present")), { ok: true, errors: [] });
  }
});

test("nested objects and array items use the same own-member rules and preserve paths", () => {
  const parameters: JsonObjectSchema = {
    type: "object", properties: { payload: closed, list: { type: "array", items: declared("constructor") } }
  };
  assert.deepEqual(validateJsonSchema(parameters, transported({ payload: { path: "fixture", toString: "extra" }, list: [{}] }), "input"), {
    ok: false, errors: ["input.payload.toString is not allowed", "input.list[0].constructor is required"]
  });
});

test("null-prototype arguments and property dictionaries preserve explicitly declared special keys", () => {
  const properties: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>;
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of prototypeNames) {
    properties[key] = { type: "string" };
    input[key] = "explicit";
  }
  const parameters: JsonObjectSchema = { type: "object", properties, required: [...prototypeNames], additionalProperties: false };
  assert.deepEqual(validateJsonSchema(parameters, input), { ok: true, errors: [] });
  assert.deepEqual(validateJsonSchema(normalizeToolParameters("dictionary", parameters), input), { ok: true, errors: [] });
  Reflect.deleteProperty(input, "constructor");
  assert.deepEqual(validateJsonSchema(parameters, input), { ok: false, errors: ["arguments.constructor is required"] });
});

test("own enumerable extras remain permitted by default and explicit open object schemas", () => {
  const input = transported(Object.fromEntries(prototypeNames.map(key => [key, "extra"])));
  for (const parameters of [{ type: "object" }, { type: "object", additionalProperties: true }] satisfies JsonObjectSchema[]) {
    assert.deepEqual(validateJsonSchema(parameters, input), { ok: true, errors: [] });
  }
});

test("in-memory inherited argument members do not stand in for missing JSON members", () => {
  // This characterizes the helper's object boundary, not transported class/proxy support.
  const input = Object.create({ path: "inherited" }) as Record<string, unknown>;
  assert.deepEqual(validateJsonSchema(closed, input), { ok: false, errors: ["arguments.path is required"] });
  input.path = "own";
  assert.deepEqual(validateJsonSchema(closed, input), { ok: true, errors: [] });
});

test("a properties dictionary's inherited entries cannot declare allowed JSON members", () => {
  let inheritedReads = 0;
  const prototype = Object.defineProperty({}, "phantom", { get() { inheritedReads++; return { type: "string" }; } });
  const properties = Object.create(prototype) as Record<string, JsonSchema>;
  properties.path = { type: "string" };
  assert.deepEqual(validateJsonSchema({ ...closed, properties }, transported({ path: "fixture", phantom: "extra" })), {
    ok: false, errors: ["arguments.phantom is not allowed"]
  });
  assert.equal(inheritedReads, 0);
});

async function coordinatorFixture(parameters: JsonObjectSchema, approved = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-schema-own-properties-"));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.permission.mode = "ask";
  const recorder = new SessionRecorder(root, "own-properties");
  const registry = new ToolRegistry();
  const resolved: unknown[] = [];
  const executions: unknown[] = [];
  const permissionIds: string[] = [];
  registry.register({
    name: "mcp_fixture_inspect", description: "In-memory MCP-style JSON argument boundary", parameters,
    schema: z.unknown(), risk: "execute",
    resolveExecution(args) {
      resolved.push(args);
      return {
        approvalRule: "mcp:fixture:inspect",
        async execute() { executions.push(args); return { ok: true }; }
      };
    }
  }, "mcp");
  const coordinator = new ToolExecutionCoordinator({
    workspaceRoot: root, config, recorder, toolRegistry: registry,
    confirmPermission: async request => { permissionIds.push(request.toolCallId); return { approved, scope: "once" }; }
  }, new PermissionManager(config.permission), () => undefined, () => ({}), undefined, { maxToolCalls: 10, maxRepeatedActions: 10 });
  const agentTool = coordinator.createAgentTools().find(tool => tool.name === "mcp_fixture_inspect")!;
  return {
    coordinator, agentTool, resolved, executions, permissionIds,
    async close() { await coordinator.waitForIdle(); await recorder.close(); await rm(root, { recursive: true, force: true }); }
  };
}

for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
  test(`MCP-style coordinator rejects extra ${key} before resolution, approval and execution`, async () => {
    const fixture = await coordinatorFixture(closed);
    try {
      const result = await fixture.agentTool.execute("invalid-extra", transported({ path: "fixture", ...specialInput(key, "extra") }));
      assert.equal(result.isError, true);
      assert.deepEqual(result.details, { error: `Invalid tool arguments for mcp_fixture_inspect: arguments.${key} is not allowed`, validation: true });
      assert.deepEqual(fixture.resolved, []);
      assert.deepEqual(fixture.permissionIds, []);
      assert.deepEqual(fixture.executions, []);
      assert.equal(fixture.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 1);
    } finally { await fixture.close(); }
  });

  test(`MCP-style coordinator rejects missing required ${key} before any side-effect preparation`, async () => {
    const fixture = await coordinatorFixture(declared(key));
    try {
      const result = await fixture.agentTool.execute("missing-special", transported({}));
      assert.equal(result.isError, true);
      assert.deepEqual(fixture.resolved, []);
      assert.deepEqual(fixture.permissionIds, []);
      assert.deepEqual(fixture.executions, []);
    } finally { await fixture.close(); }
  });

  test(`MCP-style coordinator retains normal approval for explicitly declared ${key}`, async () => {
    for (const approved of [true, false]) {
      const fixture = await coordinatorFixture(declared(key), approved);
      const input = specialInput(key, "explicit");
      try {
        const result = await fixture.agentTool.execute("valid-special", input);
        assert.equal(result.isError, !approved);
        assert.deepEqual(fixture.resolved, [input]);
        assert.deepEqual(fixture.permissionIds, ["valid-special"]);
        assert.deepEqual(fixture.executions, approved ? [input] : []);
        assert.equal(fixture.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 1);
      } finally { await fixture.close(); }
    }
  });
}

async function runSdk(agentTool: AgentTool, input: Record<string, unknown>) {
  const events: AgentEvent[] = [];
  let requests = 0;
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "fixture", supportedUrls: {},
    doGenerate: async () => { throw new Error("Unexpected generate"); },
    doStream: async () => {
      requests++;
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "tool-call", toolCallId: "sdk-original", toolName: agentTool.name, input: JSON.stringify(input) });
        controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }
        } });
        controller.close();
      } }) };
    }
  };
  for await (const event of vercelAgentLoopContinue(
    { messages: [{ role: "user", content: "Inspect the in-memory fixture" }], tools: [agentTool] },
    { model: { provider: "fixture", modelId: "fixture" }, vercelModel: provider, tools: [agentTool], maxSteps: 1, maxRetries: 0, shouldStopAfterTurn: async () => true }
  )) events.push(event);
  return { events, requests };
}

for (const key of ["constructor", "toString", "hasOwnProperty"]) {
  test(`SDK and MCP-style coordinator reject undeclared ${key} without execution or replay`, async () => {
    const fixture = await coordinatorFixture(closed);
    try {
      const run = await runSdk(fixture.agentTool, transported({ path: "fixture", ...specialInput(key, "extra") }));
      assert.deepEqual(fixture.resolved, []);
      assert.deepEqual(fixture.permissionIds, []);
      assert.deepEqual(fixture.executions, []);
      assert.equal(run.requests, 1);
      assert.equal(run.events.some(event => event.type === "tool_execution_start"), false);
      assert.equal(run.events.some(event => event.type === "error" && event.fatal), true);
    } finally { await fixture.close(); }
  });

  test(`SDK rejects missing required ${key} before resolution and approval`, async () => {
    const invalid = await coordinatorFixture(declared(key));
    try {
      const run = await runSdk(invalid.agentTool, transported({}));
      assert.deepEqual(invalid.resolved, []);
      assert.deepEqual(invalid.permissionIds, []);
      assert.deepEqual(invalid.executions, []);
      assert.equal(run.requests, 1);
      assert.equal(run.events.some(event => event.type === "error" && event.fatal), true);
    } finally { await invalid.close(); }
  });

  test(`SDK preserves normal approval and denial for valid declared ${key}`, async () => {
    for (const approved of [true, false]) {
      const valid = await coordinatorFixture(declared(key), approved);
      const input = specialInput(key, "explicit");
      try {
        const run = await runSdk(valid.agentTool, input);
        assert.deepEqual(valid.resolved, [input]);
        assert.deepEqual(valid.permissionIds, ["sdk-original"]);
        assert.deepEqual(valid.executions, approved ? [input] : []);
        assert.equal(run.requests, 1);
        assert.equal(run.events.filter(event => event.type === "tool_execution_start").length, 1);
        const end = run.events.find(event => event.type === "tool_execution_end");
        assert.equal(end?.type === "tool_execution_end" ? end.result.isError : undefined, !approved);
      } finally { await valid.close(); }
    }
  });
}

test("MCP-style coordinator accepts null-prototype arguments and schema dictionaries after approval", async () => {
  const properties = Object.create(null) as Record<string, JsonSchema>;
  for (const key of ["constructor", "hasOwnProperty"]) properties[key] = { type: "string" };
  const input = Object.assign(Object.create(null) as Record<string, unknown>, { constructor: "explicit", hasOwnProperty: "shadowed" });
  const fixture = await coordinatorFixture({ type: "object", properties, required: ["constructor", "hasOwnProperty"], additionalProperties: false });
  try {
    const result = await fixture.agentTool.execute("null-prototype", input);
    assert.equal(result.isError, false);
    assert.deepEqual(fixture.permissionIds, ["null-prototype"]);
    assert.deepEqual(fixture.executions, [input]);
  } finally { await fixture.close(); }
});

for (const additionalProperties of [undefined, true]) {
  test(`SDK and MCP-style coordinator preserve permitted own extras when openness is ${String(additionalProperties)}`, async () => {
    const fixture = await coordinatorFixture({ ...closed, additionalProperties });
    const input = transported({ path: "fixture", constructor: "metadata", toString: "metadata", hasOwnProperty: "metadata", unexpected: "metadata" });
    try {
      const run = await runSdk(fixture.agentTool, input);
      assert.deepEqual(fixture.resolved, [input]);
      assert.deepEqual(fixture.permissionIds, ["sdk-original"]);
      assert.deepEqual(fixture.executions, [input]);
      assert.equal(run.requests, 1);
    } finally { await fixture.close(); }
  });
}

test("SDK's independent forbidden __proto__ parsing boundary stays rejected before the coordinator", async () => {
  // The helper/coordinator support a declared own __proto__; this SDK parser does not transport it.
  const fixture = await coordinatorFixture(declared("__proto__"));
  try {
    const run = await runSdk(fixture.agentTool, specialInput("__proto__", "explicit"));
    assert.deepEqual(fixture.resolved, []);
    assert.deepEqual(fixture.permissionIds, []);
    assert.deepEqual(fixture.executions, []);
    assert.equal(run.requests, 1);
    assert.equal(run.events.some(event => event.type === "error" && event.fatal), true);
  } finally { await fixture.close(); }
});
