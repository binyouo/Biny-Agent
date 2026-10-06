/** anyOf alternatives are conjunctive with the validator's existing sibling constraints. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { JsonAnyOfSchema, JsonObjectSchema, JsonSchema } from "../src/tools/schema.js";

const objectChoice = {
  type: "object", properties: { path: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1, maximum: 3 } },
  required: ["path"], additionalProperties: false, anyOf: [{ type: "object" }]
} satisfies JsonObjectSchema & JsonAnyOfSchema;

const cases: Array<{ label: string; schema: JsonSchema; invalid: unknown; valid: unknown; error: string }> = [
  { label: "object type", schema: { ...objectChoice, anyOf: [{ type: "string" }, { type: "object" }] }, invalid: "fixture", valid: { path: "fixture" }, error: "arguments must be an object" },
  { label: "required property", schema: objectChoice, invalid: {}, valid: { path: "fixture" }, error: "arguments.path is required" },
  { label: "property type", schema: objectChoice, invalid: { path: 7 }, valid: { path: "fixture" }, error: "arguments.path must be a string" },
  { label: "property range", schema: objectChoice, invalid: { path: "fixture", count: 0 }, valid: { path: "fixture", count: 1 }, error: "arguments.count must be >= 1" },
  { label: "closed properties", schema: objectChoice, invalid: { path: "fixture", extra: true }, valid: { path: "fixture" }, error: "arguments.extra is not allowed" },
  { label: "string type", schema: { type: "string", anyOf: [{ type: "number" }, { type: "string" }] }, invalid: 1, valid: "value", error: "arguments must be a string" },
  { label: "string minimum length", schema: { type: "string", minLength: 2, anyOf: [{ type: "string" }] }, invalid: "a", valid: "ab", error: "arguments must contain at least 2 character(s)" },
  { label: "string maximum length", schema: { type: "string", maxLength: 2, anyOf: [{ type: "string" }] }, invalid: "abc", valid: "ab", error: "arguments must contain at most 2 character(s)" },
  { label: "string enum", schema: { type: "string", enum: ["allowed"], anyOf: [{ type: "string" }] }, invalid: "other", valid: "allowed", error: "arguments must be one of: allowed" },
  { label: "number type", schema: { type: "number", anyOf: [{ type: "string" }, { type: "number" }] }, invalid: "1", valid: 1, error: "arguments must be a number" },
  { label: "number minimum", schema: { type: "number", minimum: 1, anyOf: [{ type: "number" }] }, invalid: 0, valid: 1, error: "arguments must be >= 1" },
  { label: "number maximum", schema: { type: "number", maximum: 3, anyOf: [{ type: "number" }] }, invalid: 4, valid: 3, error: "arguments must be <= 3" },
  { label: "integer constraint", schema: { type: "integer", anyOf: [{ type: "number" }] }, invalid: 1.5, valid: 1, error: "arguments must be an integer" },
  { label: "boolean type", schema: { type: "boolean", anyOf: [{ type: "string" }, { type: "boolean" }] }, invalid: "true", valid: true, error: "arguments must be a boolean" },
  { label: "array type", schema: { type: "array", anyOf: [{ type: "object" }, { type: "array" }] }, invalid: {}, valid: [], error: "arguments must be an array" },
  { label: "array minimum items", schema: { type: "array", minItems: 1, anyOf: [{ type: "array" }] }, invalid: [], valid: [1], error: "arguments must contain at least 1 item(s)" },
  { label: "array maximum items", schema: { type: "array", maxItems: 1, anyOf: [{ type: "array" }] }, invalid: [1, 2], valid: [1], error: "arguments must contain at most 1 item(s)" },
  { label: "array item constraint", schema: { type: "array", items: { type: "integer", minimum: 1 }, anyOf: [{ type: "array" }] }, invalid: [0], valid: [1], error: "arguments[0] must be >= 1" },
  { label: "nested property choice", schema: { type: "object", properties: { payload: objectChoice }, required: ["payload"] }, invalid: { payload: {} }, valid: { payload: { path: "fixture" } }, error: "arguments.payload.path is required" },
  { label: "nested item choice", schema: { type: "array", items: objectChoice }, invalid: [{}], valid: [{ path: "fixture" }], error: "arguments[0].path is required" },
  { label: "choice branch siblings", schema: { anyOf: [{ type: "integer", minimum: 2, anyOf: [{ type: "number" }] }, { type: "string", enum: ["allowed"] }] }, invalid: 1, valid: 2, error: "arguments must match one of the allowed types" }
];

for (const { label, schema, invalid, valid, error } of cases) {
  test(`anyOf retains ${label}`, async () => {
    const { validateJsonSchema } = await import("../src/tools/schema.js");
    assert.deepEqual(validateJsonSchema(schema, invalid), { ok: false, errors: [error] });
    assert.deepEqual(validateJsonSchema(schema, valid), { ok: true, errors: [] });
  });
}

test("anyOf still requires a branch match when base constraints pass", async () => {
  const { validateJsonSchema } = await import("../src/tools/schema.js");
  const schema = { type: "number", minimum: 0, anyOf: [{ type: "number", maximum: 1 }, { type: "number", minimum: 3 }] } satisfies JsonSchema;
  assert.deepEqual(validateJsonSchema(schema, 2), { ok: false, errors: ["arguments must match one of the allowed types"] });
  for (const value of [0, 1, 3, 4]) assert.deepEqual(validateJsonSchema(schema, value), { ok: true, errors: [] });
  assert.deepEqual(validateJsonSchema({ anyOf: [] }, 0), { ok: false, errors: ["arguments must match one of the allowed types"] });
});

test("anyOf retains both branch and sibling failure diagnostics at a custom path", async () => {
  const { validateJsonSchema } = await import("../src/tools/schema.js");
  const schema = { type: "number", minimum: 1, anyOf: [{ type: "number", minimum: 2 }] } satisfies JsonSchema;
  assert.deepEqual(validateJsonSchema(schema, 0, "input.count"), {
    ok: false, errors: ["input.count must match one of the allowed types", "input.count must be >= 1"]
  });
});

test("normalization preserves anyOf siblings without changing schemas or open input", async () => {
  const { normalizeToolParameters, openAiCompatibleToolParameters, validateJsonSchema } = await import("../src/tools/schema.js");
  const schema = { ...objectChoice, additionalProperties: true };
  const before = structuredClone(schema);
  const input = { path: "fixture", count: 2, scope: "keep", nested: { extra: true } };
  const inputBefore = structuredClone(input);
  for (const normalized of [normalizeToolParameters("Inspect", schema), openAiCompatibleToolParameters("Inspect", schema)]) {
    assert.deepEqual(validateJsonSchema(normalized, input), { ok: true, errors: [] });
    assert.equal(validateJsonSchema(normalized, { count: 2 }).ok, false);
  }
  assert.deepEqual(schema, before);
  assert.deepEqual(input, inputBefore);
});

test("the native ComputerAction value remains a pure string/number/boolean union", async () => {
  const { createComputerUseTools } = await import("../src/tools/computerUse.js");
  const { validateJsonSchema } = await import("../src/tools/schema.js");
  // Read the registered schema only. No native transport is resolved or executed.
  const action = createComputerUseTools({ endpoint: "/unused-anyof-fixture", token: "fixture" }).find(tool => tool.name === "ComputerAction");
  assert.ok(action);
  const base = { pid: 1, windowId: "1", action: "set_value", captureId: "fixture", elementToken: "fixture" };
  for (const value of ["", "text", 0, 0.5, -1, true, false]) {
    assert.deepEqual(validateJsonSchema(action.parameters, { ...base, value }), { ok: true, errors: [] });
  }
  for (const value of [null, [], {}, undefined]) assert.equal(validateJsonSchema(action.parameters, { ...base, value }).ok, false);
});

test("the raw coordinator rejects anyOf sibling violations before resolution and permission", async () => {
  const [{ z }, { ToolExecutionCoordinator }, { defaultConfig }, { PermissionManager }, { SessionRecorder }, { ensureAgentDirs }, { ToolRegistry }] = await Promise.all([
    import("zod"), import("../src/agent/toolExecutionCoordinator.js"), import("../src/config/schema.js"),
    import("../src/permission/PermissionManager.js"), import("../src/session/recorder.js"), import("../src/session/store.js"), import("../src/tools/registry.js")
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-anyof-coordinator-"));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.permission.mode = "ask";
  const recorder = new SessionRecorder(root, "anyof-validation");
  const registry = new ToolRegistry();
  const resolved: unknown[] = [];
  const executed: unknown[] = [];
  const permissionIds: string[] = [];
  registry.register({
    name: "Inspect", description: "In-memory MCP-style parameter validation fixture", parameters: objectChoice,
    schema: z.unknown(), risk: "execute",
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
    const tool = coordinator.createAgentTools().find(entry => entry.name === "Inspect");
    assert.ok(tool);
    const invalidResults = [];
    for (const [id, input] of [
      ["missing", {}], ["wrong-type", { path: 7 }], ["bound", { path: "fixture", count: 0 }], ["extra", { path: "fixture", scope: "forbidden" }]
    ] as const) invalidResults.push(await tool.execute(id, input));
    const valid = { path: "fixture", count: 2 };
    const result = await tool.execute("valid", valid);
    assert.deepEqual(executed, [valid], "only a valid fake call may execute; malformed inputs must not reach the tool");
    assert.deepEqual(resolved, [valid]);
    assert.deepEqual(permissionIds, ["valid"]);
    assert.equal(result.isError, false);
    assert.equal(invalidResults.every(entry => entry.isError === true), true);
  } finally {
    await coordinator.waitForIdle();
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});
