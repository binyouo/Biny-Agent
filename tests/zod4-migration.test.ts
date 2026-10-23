import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import ts from "typescript";
import { z } from "zod";

// Extract audited pure declarations, not module imports: config/tool modules also
// reach filesystem, Host and native adapters. New declarations are never auto-run.
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}
function declaration(file: string, name: string): string {
  const ast = source(file);
  const statement = ast.statements.find((entry) => ts.isFunctionDeclaration(entry) ? entry.name?.text === name
    : ts.isVariableStatement(entry) && entry.declarationList.declarations.some((item) => item.name.getText(ast) === name));
  assert.ok(statement, `Missing audited declaration ${file}:${name}`);
  return statement.getText(ast).replace(/^export /, "");
}
function declarations(file: string, names: string[]): string {
  return names.map((name) => declaration(file, name)).join("\n");
}
function property(file: string, name: string, key: string): string {
  const ast = source(file);
  const statement = ast.statements.find((entry) => ts.isVariableStatement(entry)
    && entry.declarationList.declarations.some((item) => item.name.getText(ast) === name));
  assert.ok(statement && ts.isVariableStatement(statement));
  let expression = statement.declarationList.declarations.find((item) => item.name.getText(ast) === name)?.initializer;
  while (expression && ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    if (expression.expression.getText(ast) === "z.object") {
      const shape = expression.arguments[0];
      assert.ok(shape && ts.isObjectLiteralExpression(shape));
      const field = shape.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(ast) === key);
      assert.ok(field && ts.isPropertyAssignment(field), `Missing audited field ${name}.${key}`);
      return field.initializer.getText(ast);
    }
    expression = expression.expression.expression;
  }
  throw new Error(`Expected object schema ${name}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compile(body: string, names: string[]): Record<string, unknown> {
  // Erase types only. Unsupported transform-only syntax must fail rather than
  // silently rewriting the audited declarations before they are evaluated.
  const js = stripTypeScriptTypes(`function buildSchemas(z) {\n${body}\nreturn {${names.join(",")}};\n}`, { mode: "strip" });
  const result: unknown = new Function("z", `${js}\nreturn buildSchemas(z);`)(z);
  assert.ok(isRecord(result));
  return result;
}
function schema(bundle: Record<string, unknown>, name: string): z.ZodType {
  const value = bundle[name];
  assert.ok(value instanceof z.ZodType, `Expected schema ${name}`);
  return value;
}
function call(bundle: Record<string, unknown>, name: string, ...args: unknown[]): unknown {
  const fn = bundle[name];
  assert.equal(typeof fn, "function");
  assert.ok(typeof fn === "function");
  const result: unknown = Reflect.apply(fn, undefined, args);
  return result;
}
function assertIndependent(left: unknown, right: unknown): void {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return;
  assert.notEqual(left, right, "Separate parses must not share mutable defaults");
  if (Array.isArray(left) && Array.isArray(right)) left.forEach((value, index) => assertIndependent(value, right[index]));
  else if (isRecord(left) && isRecord(right)) for (const key of Object.keys(left)) assertIndependent(left[key], right[key]);
}

const memoryNames = ["embeddingModelRefSchema", "rawMemoryPolicySchema", "memoryPolicySchema", "globalPersonalizationUpdateSchema"];
const activityNames = ["defaultActivitySettings", "normalizeActivitySettingsValue", "deprecatedActivitySettingKeys", "stripDeprecatedActivitySettings", "activitySettingsObjectSchema", "activitySettingsInputSchema", "activitySettingsPatchSchema", "activitySettingsSchema"];
const configNames = ["permissionSchema", "compactionSchema", "capabilityDefaultSelectionSchema", "chatResponseSettingsSchema", "skillExtractionSchema", "chatParamsSchema", "crystalThresholdSchema", "crystalSettingsSchema", "mcpServerSchema", "defaultSubagentAllowedTools", "subagentToolNameSchema", "skillActivationMapSchema", "skillProjectOverridesSchema", "extensionsSchema", "webSearchSchema", "webCookiesSchema", "webFetchSchema", "hookSchema", "hooksSchema", "diagnosticsSchema", "webSchema", "identityPolicySchema", "contextSchema", "reasoningEffortSchema", "modelThinkingSchema"];
const setup = [
  declarations("llm/embedding/types.ts", ["localEmbeddingModelIds", "defaultLocalEmbeddingModel", "defaultEmbeddingModelRef"]),
  declarations("extensions/skillRoots.ts", ["PROJECT_SKILL_ROOT_CONVENTIONS", "DEFAULT_PROJECT_SKILL_PATHS"]),
  declarations("personalization/index.ts", memoryNames),
  declarations("activity/settings.ts", activityNames),
  declarations("computer/protocol.ts", ["computerAppSchema", "computerSettingsSchema"]),
  declarations("config/schema.ts", configNames),
  declaration("desktop/electron/main/settingsSaveInputSchema.ts", "memorySettingsSchema"),
  `const settingsPatch = z.object({${["memory", "compaction", "chatParams"].map((key) => `${key}:${property("desktop/electron/main/settingsSaveInputSchema.ts", "settingsSaveInputSchema", key)}`).join(",")}}).strict();`,
  `const configuredComputerSchema = ${property("config/schema.ts", "canonicalConfigSchema", "computer")};`
].join("\n");
const defaults = compile(setup, [...memoryNames, ...activityNames, ...configNames, "settingsPatch", "configuredComputerSchema"]);
const patch = schema(defaults, "activitySettingsPatchSchema");
for (const [input, expected] of [
  [{}, {}], [{ enabled: false }, { enabled: false }], [{ enabled: undefined }, { enabled: undefined }],
  [{ captureDebounceMs: 0 }, { captureDebounceMs: 0 }], [{ ocrLanguages: [" en-US "] }, { ocrLanguages: ["en-US"] }],
  [{ outputDirectory: " /synthetic/path " }, { outputDirectory: "/synthetic/path" }],
  [{ sensitiveApplications: [] }, { sensitiveApplications: [] }]
]) assert.deepEqual(patch.parse(input), expected);
for (const input of [null, [], { unknown: true }, { enabled: null }, { captureDebounceMs: -1 }, { captureDebounceMs: 30_001 }, { ocrLanguages: [] }]) assert.equal(patch.safeParse(input).success, false);
for (const name of ["settingsPatch", "globalPersonalizationUpdateSchema"]) {
  const update = schema(defaults, name);
  assert.deepEqual(update.parse({}), {});
  for (const key of name === "settingsPatch" ? ["memory", "compaction", "chatParams"] : ["memory"]) {
    assert.deepEqual(update.parse({ [key]: undefined }), { [key]: undefined });
    assert.equal(update.safeParse({ [key]: null }).success, false);
    const expanded = update.parse({ [key]: {} });
    assert.ok(isRecord(expanded) && isRecord(expanded[key]) && Object.keys(expanded[key]).length > 0);
  }
  assert.doesNotThrow(() => z.toJSONSchema(update, { io: "input" }));
}
for (const name of ["permissionSchema", "chatParamsSchema", "crystalSettingsSchema", "extensionsSchema", "hooksSchema", "diagnosticsSchema", "webSchema", "activitySettingsSchema", "memoryPolicySchema", "configuredComputerSchema"]) {
  const current = schema(defaults, name);
  const first = current.parse(undefined), second = current.parse(undefined);
  assert.deepEqual(first, second);
  assertIndependent(first, second);
}
const contextDefault = schema(defaults, "contextSchema").parse(undefined);
assert.ok(isRecord(contextDefault) && isRecord(contextDefault.memory));
assert.equal(contextDefault.memory.sleepEnabled, true);
assert.equal(contextDefault.memory.sleepTime, "03:00");
assert.equal(contextDefault.memory.llmBatchSize, 20);
const thinking = schema(defaults, "modelThinkingSchema");
assert.equal(thinking.safeParse({ mapping: { high: "high" }, budgetTokens: { high: 1024 } }).success, true);
assert.equal(thinking.safeParse({ mapping: { other: "high" } }).success, false);
const nestedSubagent = compile(`${setup}\nconst nestedSubagent = ${property("config/schema.ts", "extensionsSchema", "subagent")};`, ["nestedSubagent"]);
assertIndependent(schema(nestedSubagent, "nestedSubagent").parse(undefined), schema(nestedSubagent, "nestedSubagent").parse(undefined));

const computerNames = ["windowTargetSchema", "computerWaitSchema", "computerObservationOptions", "validateObservationOptions", "windowObserveSchema", "computerActionPayload", "validateComputerAction", "computerActionPayloadSchema", "computerActionObjectSchema", "computerActionSchema", "computerSequenceSchema"];
const computer = compile(declarations("computer/protocol.ts", computerNames), computerNames);
const identity = { pid: 1, windowId: "1", captureId: "synthetic" };
const actionCases: [Record<string, unknown>, boolean][] = [
  [{ action: "click" }, false], [{ action: "click", x: 1, y: 2 }, true], [{ action: "click", x: 1 }, false],
  [{ action: "type_text", text: "" }, true], [{ action: "type_text", text: "a", inputMethod: "ax" }, false],
  [{ action: "type_text", text: "a", inputMethod: "ax", elementToken: "t" }, true],
  [{ action: "press_key", key: "Enter" }, true], [{ action: "press_key" }, false],
  [{ action: "scroll", direction: "down", x: 1, y: 2 }, true],
  [{ action: "set_value", elementToken: "t", value: false }, true],
  [{ action: "select_text", elementToken: "t", matchText: "a", text: "b" }, false]
];
for (const [action, valid] of actionCases) {
  assert.equal(schema(computer, "computerActionSchema").safeParse({ ...identity, ...action }).success, valid);
  assert.equal(schema(computer, "computerSequenceSchema").safeParse({ ...identity, actions: [action] }).success, valid);
}
const sequence = schema(computer, "computerSequenceSchema");
assert.equal(sequence.safeParse({ ...identity, actions: [{ action: "click", x: 1, y: 2 }, { action: "click", x: 1, y: 2 }] }).success, false);
assert.equal(sequence.safeParse({ ...identity, actions: [{ action: "click", x: 1, y: 2 }, { action: "press_key", key: "Enter" }] }).success, true);
assert.equal(sequence.safeParse({ ...identity, actions: [{ action: "click", x: 1, y: 2 }, { action: "type_text", text: "x", elementToken: "stale" }] }).success, false);
assert.equal(sequence.safeParse({ ...identity, actions: [] }).success, false);
assert.equal(sequence.safeParse({ ...identity, actions: Array(6).fill({ action: "press_key", key: "Enter" }) }).success, false);
assert.equal(schema(computer, "windowObserveSchema").safeParse({ pid: 1, windowId: "1", content: "image", waitFor: { text: "x" } }).success, false);

const toolNames = ["hashlineEditsSchema", "deleteFileArgsSchema", "moveFileArgsSchema", "hashlineEditArgsSchema", "stringEditArgsSchema"];
const helperNames = ["isSchemaRecord", "normalizeDisjointUnions"];
const validatorNames = ["normalizeToolParameters", "normalizeSchemaNode", "openAiCompatibleToolParameters", "omitEmptyRequired", "validateJsonSchema", "validateValue", "validateObject", "validateString", "validateNumber", "validateArray"];
const tools = compile([
  declarations("tools/file/editFile.ts", toolNames), declaration("tools/file/applyPatch.ts", "patchArgsSchema"),
  declarations("tools/zodToolInput.ts", helperNames), declarations("tools/schema.ts", validatorNames)
].join("\n"), [...toolNames, "patchArgsSchema", ...helperNames, ...validatorNames]);
// Guard actual integration without importing the SDK or replacing its projection.
const bridgeAst = source("tools/zodToolInput.ts");
let bridgeConnected = false, objectEnvelope = false;
function inspectBridge(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(bridgeAst) === "generated") {
    const initializer = node.initializer;
    const expression = initializer && ts.isAsExpression(initializer) ? initializer.expression : initializer;
    bridgeConnected = Boolean(expression && ts.isCallExpression(expression) && expression.expression.getText(bridgeAst) === "normalizeDisjointUnions"
      && expression.arguments[0]?.getText(bridgeAst) === "zodSchema(schema, { useReferences: false }).jsonSchema");
  }
  if (ts.isBinaryExpression(node) && node.left.getText(bridgeAst) === "parameters" && ts.isObjectLiteralExpression(node.right)) {
    const fields = node.right.properties;
    objectEnvelope = fields.some((field) => ts.isSpreadAssignment(field) && field.expression.getText(bridgeAst) === "generated")
      && fields.some((field) => ts.isPropertyAssignment(field) && field.name.getText(bridgeAst) === "type" && ts.isStringLiteral(field.initializer) && field.initializer.text === "object")
      && fields.some((field) => ts.isPropertyAssignment(field) && field.name.getText(bridgeAst) === "anyOf" && field.initializer.getText(bridgeAst) === "generated.anyOf");
  }
  ts.forEachChild(node, inspectBridge);
}
inspectBridge(bridgeAst);
assert.ok(bridgeConnected, "The SDK projection must pass through disjoint-union normalization");
assert.ok(objectEnvelope, "Root unions must retain the model-facing object envelope and sibling constraints");
const cases: Record<string, [unknown, boolean][]> = {
  hashlineEditArgsSchema: [
    [{ operation: "delete", path: "x" }, true], [{ operation: "move", path: "x", to: "y" }, true],
    [{ operation: "update", path: "x", edits: [{ op: "replace", pos: "1#abc", lines: ["a"] }] }, true],
    [{ operation: "update", path: "x", edits: [{ op: "append", lines: [] }, { op: "prepend", lines: ["b"] }] }, true],
    [{ operation: "move", path: "x" }, false], [{ operation: "delete", path: "x", to: "y" }, false],
    [{ operation: "update", path: "x", edits: [{ op: "replace", lines: [] }] }, false],
    [{ operation: "update", path: "x", edits: [{ lines: [] }] }, false], [{ operation: "update", path: "x", edits: [] }, false]
  ],
  stringEditArgsSchema: [[{ path: "x", old_string: "a", new_string: "b" }, true], [{ operation: "delete", path: "x" }, true], [{ operation: "move", path: "x" }, false]],
  patchArgsSchema: [
    [{ callId: "a", operation: { type: "create_file", path: "x", diff: "+a" } }, true],
    [{ callId: "a", operation: { type: "update_file", path: "x", diff: "@@\n-a\n+b" } }, true],
    [{ callId: "a", operation: { type: "delete_file", path: "x" } }, true],
    [{ callId: "a", operation: { type: "delete_file", path: "x", diff: "bad" } }, false],
    [{ callId: "a", operation: { type: "create_file", path: "x" } }, false],
    [{ callId: "a", operation: { path: "x", diff: "+a" } }, false]
  ]
};
for (const [name, inputs] of Object.entries(cases)) {
  const local = schema(tools, name);
  const projected = call(tools, "normalizeDisjointUnions", z.toJSONSchema(local, { target: "draft-7", io: "input", reused: "inline" }));
  for (const [input, valid] of inputs) {
    assert.equal(local.safeParse(input).success, valid);
    const result = call(tools, "validateJsonSchema", projected, input);
    assert.ok(isRecord(result));
    assert.equal(result.ok, valid);
    if (name === "patchArgsSchema") {
      const normalized = call(tools, "normalizeToolParameters", name, projected);
      const wire = call(tools, "openAiCompatibleToolParameters", name, normalized);
      const wireResult = call(tools, "validateJsonSchema", wire, input);
      assert.ok(isRecord(wireResult));
      assert.equal(wireResult.ok, valid);
    }
  }
}
const branch = (tag: string) => ({ type: "object", properties: { kind: { type: "string", const: tag } }, required: ["kind"], additionalProperties: false });
for (const invalid of [
  { oneOf: [branch("a"), branch("a")] }, { oneOf: [branch("a"), { ...branch("b"), required: [] }] },
  { oneOf: [branch("a"), { ...branch("b"), properties: { kind: { type: "string" } } }] },
  { oneOf: [branch("a"), { ...branch("b"), properties: { kind: { type: "number", const: 2 } } }] },
  { oneOf: [{ ...branch("a"), $ref: "#/definitions/x" }, branch("b")] },
  { oneOf: [branch("a"), { ...branch("b"), properties: { kind: { type: "string", const: "b", $ref: "#/definitions/x" } } }] },
  { oneOf: [branch("a"), true] }, { oneOf: [branch("a"), { type: "string", const: "b" }] },
  { oneOf: [branch("a"), branch("b")], anyOf: [] }
]) assert.throws(() => call(tools, "normalizeDisjointUnions", invalid), /unsupported oneOf/);
const literals = { type: "object", properties: { value: { type: "string", default: { oneOf: [true, false] }, const: { oneOf: [1, 2] }, examples: [{ oneOf: [] }] } }, default: { oneOf: [] } };
assert.deepEqual(call(tools, "normalizeDisjointUnions", literals), literals);
const ordinary = { anyOf: [branch("a"), branch("b")] };
assert.deepEqual(call(tools, "normalizeDisjointUnions", ordinary), ordinary);
for (const kind of ["array", "set"] as const) {
  let elementCalls = 0;
  const item = z.string().superRefine(() => { elementCalls += 1; });
  const result = kind === "array" ? z.array(item).max(2).safeParse(["a", "b", "c"]) : z.set(item).max(2).safeParse(new Set(["a", "b", "c"]));
  assert.equal(result.success, false);
  assert.equal(elementCalls, 0, "Patched Zod must reject oversized collections before element parsing");
}
console.log("Zod 4 migration pure regression fixtures passed");
