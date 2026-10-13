import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Source is data. No product module, SDK, Recorder, Host or SQLite is imported.
const root = process.env.BINY_MCP_RECOVERY_SOURCE_ROOT ?? process.cwd();
const source = (file: string): ts.SourceFile => ts.createSourceFile(file,
  readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const resolverFile = source("src/session/capabilityOutcomeResolver.ts");
const storeFile = source("src/runtime/CapabilityStore.ts");
const mcpFile = source("src/extensions/mcp.ts");
const coordinatorFile = source("src/agent/toolExecutionCoordinator.ts");
const replayFile = source("src/session/replay.ts");
const adapterFile = source("src/agent/core/vercelModelAdapter.ts");
const utilsFile = source("src/agent/core/vercelAgentUtils.ts");

function declaration(file: ts.SourceFile, name: string): string {
  const matches = file.statements.filter(node =>
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name);
  assert.equal(matches.length, 1, `one top-level declaration: ${name}`);
  return matches[0]!.getText(file).replace(/^export\s+/u, "");
}

function nestedVariable(file: ts.SourceFile, owner: string, name: string): string {
  const parent = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === owner);
  assert.ok(parent && ts.isFunctionDeclaration(parent));
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parent);
  assert.equal(matches.length, 1, `one nested declaration: ${owner}.${name}`);
  return `const ${matches[0]!.getText(file)};`;
}

// Select only the adapter's ordinary tool-result object expression, not the
// enclosing module or boundComputerFrames/model/SDK path.
const adapterOwner = adapterFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "toModelMessages");
assert.ok(adapterOwner);
const adapterReturns: ts.ObjectLiteralExpression[] = [];
const visitAdapter = (node: ts.Node): void => {
  if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)
    && node.expression.getText(adapterFile).includes("output: message.isError")) adapterReturns.push(node.expression);
  ts.forEachChild(node, visitAdapter);
};
visitAdapter(adapterOwner);
assert.equal(adapterReturns.length, 1);
const program = [
  declaration(storeFile, "CapabilityIdempotencyConflictError"),
  declaration(resolverFile, "CapabilityOutcomeResolver"),
  declaration(mcpFile, "isRecord"), declaration(mcpFile, "truncateUtf8"),
  `const ${mcpFile.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => ts.isIdentifier(node.name) && node.name.text === "maxResourceTextBytes")!.getText(mcpFile)};`,
  declaration(mcpFile, "normalizeMcpResult"),
  declaration(coordinatorFile, "readStringField"), declaration(coordinatorFile, "failedToolResultMessage"),
  declaration(replayFile, "stringifyResult"), declaration(replayFile, "completeCanonicalStepResults"),
  declaration(utilsFile, "stringify"),
  `function projectFlat(event) {
    const messages = [];
    const appendMessage = message => messages.push(message);
    const openCalls = new Map([[event.toolCallId, {}]]);
    ${nestedVariable(replayFile, "projectSessionConversation", "appendToolResult")}
    appendToolResult(event, event.toolCallId);
    return { message: messages[0], remaining: openCalls.size };
  }`,
  `function adapt(message) { return ${adapterReturns[0]!.getText(adapterFile)}; }`,
  "globalThis.api = { CapabilityOutcomeResolver, CapabilityIdempotencyConflictError, normalizeMcpResult, failedToolResultMessage, completeCanonicalStepResults, projectFlat, adapt };"
].join("\n");
const compiled = ts.transpileModule(program, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const context = vm.createContext({ Buffer: { byteLength: Buffer.byteLength } }, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(compiled.outputText, context, { timeout: 1_000 });
type ExecutionStatus = "succeeded" | "failed" | "cancelled" | "unknown";
interface Outcome {
  executionStatus: ExecutionStatus;
  result: unknown;
  evidence?: string;
  outcomeUnknownReason?: string;
}
interface Resolver {
  resolve: (call: unknown) => Outcome | undefined;
  redactionOptionsFor: (result: unknown) => { context?: "mcp-result" };
}
interface ToolMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}
interface ProjectedEvent {
  type: string;
  message?: { role: string; isError?: boolean };
}
interface AdapterMessage {
  role: "tool";
  content: [{ type: "tool-result"; output: { type: "error-text" | "text" | "content"; value: unknown } }];
}
const api = context.api as {
  CapabilityOutcomeResolver: new (getStore: () => unknown) => Resolver;
  CapabilityIdempotencyConflictError: new (operation: string) => Error;
  normalizeMcpResult: (result: unknown) => unknown;
  failedToolResultMessage: (result: unknown) => string | undefined;
  completeCanonicalStepResults: (events: unknown[]) => ProjectedEvent[];
  projectFlat: (event: unknown) => { message: ToolMessage; remaining: number };
  adapt: (message: unknown) => AdapterMessage;
};
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const registration = { ownerType: "host", ownerId: "host", capabilityName: "host:mcp:mcp_fixture_lookup" };
const call = { tool: "mcp_fixture_lookup", sessionId: "session", turnId: "turn", toolCallId: "call", operationId: "operation", request: {} };

function resolveRequired(resolver: Resolver): Outcome {
  const outcome = resolver.resolve(call);
  assert.ok(outcome);
  return outcome;
}

function fixture(result: unknown, registrationValue: unknown = registration, status = "result", dispatchState = "dispatched") {
  const invocation = { invocationId: "invocation", registrationId: "registration", status, dispatchState, result };
  const requests: unknown[] = [];
  const resolver = new api.CapabilityOutcomeResolver(() => ({
    findHostToolInvocation: (input: unknown) => { requests.push(input); return invocation; },
    get: (id: string) => { assert.equal(id, "registration"); return registrationValue; }
  }));
  return { resolver, invocation, requests };
}

const errorCases = [
  { name: "structured text", value: { isError: true, content: [{ type: "text", text: "calendar missing" }], structuredContent: { code: "MISSING" } } },
  { name: "structured no text", value: { isError: true, content: [], structuredContent: { code: "MISSING" } } },
  { name: "text only", value: { isError: true, content: [{ type: "text", text: "calendar missing" }] } },
  { name: "mixed content", value: { isError: true, content: [{ type: "text", text: "calendar missing" }, { type: "image", data: "AAAA", mimeType: "image/png" }] } },
  { name: "empty content envelope", value: { isError: true, content: [] } },
  { name: "empty text envelope", value: { isError: true, content: [{ type: "text", text: "" }] } }
];
for (const example of errorCases) test(`MCP recovery agrees with live classification: ${example.name}`, () => {
  const payload = api.normalizeMcpResult(example.value);
  const original = JSON.stringify(payload);
  assert.ok(api.failedToolResultMessage(payload));
  const f = fixture(payload);
  const outcome = resolveRequired(f.resolver);
  assert.equal(outcome.executionStatus, "failed");
  assert.equal(outcome.result, payload);
  assert.equal(outcome.evidence, "capability:invocation");
  assert.equal(f.requests[0], call);
  assert.deepEqual(json(f.resolver.redactionOptionsFor(payload)), { context: "mcp-result" });
  assert.deepEqual(json(f.resolver.redactionOptionsFor(structuredClone(payload))), {});
  const flat = api.projectFlat({ type: "tool_result", tool: call.tool, toolCallId: call.toolCallId, ...outcome });
  assert.equal(flat.message.isError, true);
  assert.equal(flat.message.details, payload);
  assert.equal(flat.remaining, 0);
  assert.equal(api.adapt(flat.message).content[0].output.type, "error-text");
  assert.equal(JSON.stringify(payload), original);
});

for (const error of ["", "business error data", true]) test(`successful structured error data keeps existing live contract: ${String(error)}`, () => {
  const payload = api.normalizeMcpResult({ isError: false, content: [], structuredContent: { error } });
  assert.ok(api.failedToolResultMessage(payload));
  assert.equal(resolveRequired(fixture(payload).resolver).executionStatus, "failed");
});

test("successful structured isError data keeps existing live contract", () => {
  const payload = api.normalizeMcpResult({ isError: false, content: [], structuredContent: { isError: true } });
  assert.ok(api.failedToolResultMessage(payload));
  assert.equal(resolveRequired(fixture(payload).resolver).executionStatus, "failed");
});

test("successful values and unrelated failure-like signals retain the narrow recovery scope", () => {
  for (const payload of ["ok", null, [], { items: [1], nextPageToken: "ordinary-cursor" }, { error: false }, { isError: false },
    { status: "failed" }, { exitCode: 1 }, { approved: false }, { error: 1 }, { error: {} }, { result: { error: "nested" } },
    { isError: false, structuredContent: { error: "child state is data" }, content: [] }]) {
    const f = fixture(payload);
    const outcome = resolveRequired(f.resolver);
    assert.equal(outcome.executionStatus, "succeeded");
    assert.equal(outcome.result, payload);
  }
});

test("only the exact host MCP registration gains error classification and object trust", () => {
  const payload = { error: true };
  for (const other of [null, { ...registration, ownerType: "client" }, { ...registration, ownerId: "other" },
    { ...registration, capabilityName: "host:plugin:mcp_fixture_lookup" }, { ...registration, capabilityName: "host:mcpish:lookup" }]) {
    // Defensive resolver isolation. Real findHostToolInvocation also rejects a client owner.
    const f = fixture(payload, other);
    assert.equal(resolveRequired(f.resolver).executionStatus, "succeeded");
    assert.deepEqual(json(f.resolver.redactionOptionsFor(payload)), {});
  }
  const resolver = new api.CapabilityOutcomeResolver(() => undefined);
  assert.equal(resolver.resolve(call), undefined);
  const absent = new api.CapabilityOutcomeResolver(() => ({ findHostToolInvocation: () => undefined }));
  assert.equal(absent.resolve(call), undefined);
});

test("non-result and conflict paths keep existing conservative outcomes", () => {
  for (const [status, dispatch, expected] of [["failed", "dispatched", "failed"], ["cancelled", "not_dispatched", "cancelled"],
    ["cancelled", "dispatched", "unknown"], ["running", "dispatched", "unknown"], ["unknown", "dispatched", "unknown"]]) {
    assert.equal(resolveRequired(fixture({ error: true }, registration, status, dispatch).resolver).executionStatus, expected);
  }
  const conflict = new api.CapabilityOutcomeResolver(() => ({ findHostToolInvocation: () => { throw new api.CapabilityIdempotencyConflictError("operation"); } }));
  assert.equal(resolveRequired(conflict).outcomeUnknownReason, "operation_identity_ambiguous");
  const failure = new Error("read failure");
  const failing = new api.CapabilityOutcomeResolver(() => ({ findHostToolInvocation: () => { throw failure; } }));
  assert.throws(() => failing.resolve(call), error => error === failure);
});

for (const status of ["succeeded", "failed", "cancelled", "unknown", undefined]) test(`flat projection uses explicit status only: ${String(status)}`, () => {
  const payload = { error: "payload does not override durable status", status: "failed" };
  const event = { type: "tool_result", tool: "TaskStatus", toolCallId: "status-call", result: payload, ...(status === undefined ? {} : { executionStatus: status }) };
  const projected = api.projectFlat(event).message;
  assert.equal(projected.details, payload);
  if (status === undefined) assert.equal(Object.hasOwn(projected, "isError"), false);
  else assert.equal(projected.isError, status !== "succeeded");
  assert.equal(api.adapt(projected).content[0].output.type, status !== undefined && status !== "succeeded" ? "error-text" : "text");
  if (status !== undefined) {
    const assistant = { type: "agent_message", message: { role: "assistant", content: [{ type: "toolCall", id: event.toolCallId, name: event.tool, arguments: {} }] } };
    const canonical = api.completeCanonicalStepResults([assistant, event]);
    assert.equal(canonical[1]?.message?.isError, projected.isError);
  }
});

test("an existing canonical result keeps its own protocol flag", () => {
  const assistant = { type: "agent_message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: call.tool, arguments: {} }] } };
  const canonical = { type: "agent_message", message: { role: "toolResult", toolCallId: "call", toolName: call.tool, content: [], isError: true } };
  const events = api.completeCanonicalStepResults([assistant, canonical, { type: "tool_result", tool: call.tool, toolCallId: "call", result: {}, executionStatus: "succeeded" }]);
  assert.equal(events.length, 3);
  assert.equal(events[1], canonical);
});
