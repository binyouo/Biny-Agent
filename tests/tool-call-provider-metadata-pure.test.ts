/** Only selected pure declarations run. No product/provider module is imported. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_TOOL_METADATA_SOURCE_ROOT ?? process.cwd();
const require = createRequire(import.meta.url);
const googleSource = path.resolve(path.dirname(require.resolve("@ai-sdk/google")), "../src/convert-to-google-messages.ts");
const directCalls = new Set([
  "isRecord", "providerMetadata", "stringify", "fromVercelFinishReason", "fromVercelUsage",
  "orderHistoricalPatchResults", "boundComputerFrames", "projectMessageSentAt", "assistantSnapshot",
  "emptyAssistant", "errorMessage", "parseWidgetPreview", "String", "readProviderOpts", "injectSkipSignature",
  "resolveFullMediaType", "convertToBase64", "resolveProviderReference", "isFullMediaType", "secureJsonParse",
  "appendToolResultParts", "appendLegacyToolResultParts", "onWarning"
]);
// Calls must be native operations on these reviewed local roots, not arbitrary imported APIs.
const propertyCalls: Readonly<Record<string, readonly string[]>> = {
  Array: ["isArray", "from"], Date: ["now", "parse"], Number: ["isFinite"], JSON: ["stringify"],
  Buffer: ["byteLength"], performance: ["now"], content: ["push", "map"],
  state: ["clear", "values", "map", "set", "get", "delete", "some", "push"],
  messages: ["map"], message: ["map", "some", "join"], ordered: ["push"], patchResults: ["push"],
  orderHistoricalPatchResults: ["map"], part: ["map", "join"],
  "<array>": ["reverse", "map"], "<date>": ["toISOString"],
  providerOptionsNames: ["includes"], contents: ["push"], parts: ["push"],
  missingSignatureToolNames: ["push"], uniqueToolNames: ["map", "join"],
  systemInstructionParts: ["push", "map", "join"], lastContent: ["push"], "<encoder>": ["encode"],
};
function receiverRoot(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return receiverRoot(expression.expression);
  if (ts.isCallExpression(expression)) return receiverRoot(expression.expression);
  if (ts.isArrayLiteralExpression(expression)) return "<array>";
  if (ts.isNewExpression(expression) && expression.expression.getText() === "Date") return "<date>";
  if (ts.isNewExpression(expression) && expression.expression.getText() === "TextEncoder") return "<encoder>";
  if (ts.isParenthesizedExpression(expression)) return receiverRoot(expression.expression);
  return "<unreviewed>";
}
function select(file: string, names: readonly string[], google = false): string {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
        && node.declarationList.declarations[0]!.name.getText(source) === name);
    assert.equal(matches.length, 1, `unique actual declaration: ${name}`);
    const declaration = matches[0]!;
    function audit(node: ts.Node): void {
      assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isAwaitExpression(node)
        && !ts.isYieldExpression(node) && !ts.isTaggedTemplateExpression(node) && !ts.isClassDeclaration(node));
      if (ts.isIdentifier(node)) assert.ok(!["process", "globalThis", "require", "eval", "Function", "fetch"].includes(node.text));
      if (ts.isNewExpression(node)) {
        assert.ok(ts.isIdentifier(node.expression) && (node.expression.text === "Date"
          || google && ["Set", "UnsupportedFunctionalityError", "TextEncoder"].includes(node.expression.text)), "reviewed constructor only");
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee)) assert.ok(directCalls.has(callee.text), `unreviewed call ${callee.text}`);
        else {
          assert.ok(ts.isPropertyAccessExpression(callee), `unreviewed computed call ${callee.getText(source)}`);
          const receiver = receiverRoot(callee.expression);
          // Local array map/filter chains in the converter stay on their original root.
          const allowed = propertyCalls[receiver];
          assert.ok(allowed?.includes(callee.name.text)
            || google && callee.getText(source) === "part.data.url.toString"
            || google && receiver === "content" && callee.name.text === "filter"
            || google && receiver === "contents" && callee.name.text === "unshift",
          `unreviewed method ${receiver}.${callee.name.text}`);
        }
      }
      ts.forEachChild(node, audit);
    }
    audit(declaration);
    return declaration.getText(source).replace(/^export\s+/u, "");
  }).join("\n");
}

/** Select only the real successful-return suffix, not the async repair algorithm or SDK. */
function repairReturnProjection(): string {
  const file = path.join(root, "src/agent/core/toolCallRepair.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(ts.isVariableStatement)
    .filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(node => [...node.declarationList.declarations]).filter(node => node.name.getText(source) === "toolCallRepair");
  assert.equal(declarations.length, 1);
  const callback = declarations[0]!.initializer;
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const tries = callback.body.statements.filter(ts.isTryStatement);
  assert.equal(tries.length, 1);
  const statements = [...tries[0]!.tryBlock.statements];
  const negated = (node: ts.Expression, name: string) => ts.isPrefixUnaryExpression(node)
    && node.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(node.operand) && node.operand.text === name;
  const guards = statements.filter((node): node is ts.IfStatement => ts.isIfStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    && negated(node.expression.left, "renamed") && negated(node.expression.right, "changed"));
  assert.equal(guards.length, 1);
  const guard = guards[0]!;
  assert.ok(ts.isReturnStatement(guard.thenStatement) && guard.thenStatement.expression?.kind === ts.SyntaxKind.NullKeyword
    && guard.elseStatement === undefined, "actual unchanged-call guard");
  const suffix = statements.slice(statements.indexOf(guard));
  assert.ok(suffix.length === 2 || suffix.length === 3, "guard directly precedes return or metadata destructure+return");
  if (suffix.length === 3) {
    const statement = suffix[1]!;
    assert.ok(ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1);
    const declaration = statement.declarationList.declarations[0]!;
    assert.ok(ts.isObjectBindingPattern(declaration.name) && declaration.name.elements.length === 2);
    const [metadata, rest] = declaration.name.elements;
    assert.equal(metadata!.propertyName?.getText(source), "providerMetadata");
    assert.equal(metadata!.name.getText(source), "_originalMetadata");
    assert.ok(rest!.dotDotDotToken && rest!.name.getText(source) === "call");
    assert.equal(declaration.initializer?.getText(source), "toolCall");
  }
  assert.ok(ts.isReturnStatement(suffix.at(-1)!));
  function audit(node: ts.Node): void {
    assert.ok(!ts.isNewExpression(node) && !ts.isAwaitExpression(node) && !ts.isYieldExpression(node)
      && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isTaggedTemplateExpression(node));
    if (ts.isCallExpression(node)) assert.equal(node.expression.getText(source), "JSON.stringify", "only actual input serialization runs");
    ts.forEachChild(node, audit);
  }
  suffix.forEach(audit);
  return `function repairSuccessProjection(toolCall, toolName, input, renamed, changed) {\n${suffix.map(node => node.getText(source)).join("\n")}\n}`;
}
const source = [
  select(path.join(root, "src/agent/core/vercelAgentLoop.ts"), ["assistantFromStep", "assistantSnapshot", "handleVercelStreamPart", "emptyAssistant"]),
  select(path.join(root, "src/agent/core/vercelModelAdapter.ts"), ["toModelMessages", "orderHistoricalPatchResults", "fromVercelUsage", "fromVercelFinishReason"]),
  select(path.join(root, "src/agent/core/vercelAgentUtils.ts"), ["isRecord", "providerMetadata", "stringify"]),
  select(path.join(root, "src/agent/modelMessages.ts"), ["projectMessageSentAt"]),
  select(path.join(root, "src/computer/modelFrames.ts"), ["boundComputerFrames"]),
  select(path.join(root, "src/computer/protocol.ts"), ["maxComputerImageBytes"]),
  select(googleSource, ["SKIP_THOUGHT_SIGNATURE_VALIDATOR", "convertToGoogleMessages"], true),
  repairReturnProjection()
].join("\n");
let unexpectedCalls = 0;
function unexpected(): never { unexpectedCalls++; throw new Error("Unreviewed fixture branch"); }
const bindings = {
  errorMessage: unexpected, parseWidgetPreview: unexpected, WIDGET_MAX_HTML_LENGTH: 0,
  Buffer: { byteLength: unexpected }, performance: { now: () => 0 },
  UnsupportedFunctionalityError: class { constructor() { unexpected(); } },
  TextEncoder: class { constructor() { unexpected(); } },
  resolveFullMediaType: unexpected, convertToBase64: unexpected, resolveProviderReference: unexpected,
  isFullMediaType: unexpected, secureJsonParse: unexpected, appendToolResultParts: unexpected,
  appendLegacyToolResultParts: unexpected
};
const context = createContext(bindings, { codeGeneration: { strings: false, wasm: false } });
new Script(stripTypeScriptTypes(source, { mode: "strip" })).runInContext(context, { timeout: 1000 });
interface Call { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; invalid?: boolean; providerMetadata?: Record<string, unknown> }
interface Assistant { role: "assistant"; content: Array<Call | { type: "text" | "reasoning"; text: string; providerMetadata?: Record<string, unknown> }>; timestamp?: number }
interface InputCall { type: string; toolCallId?: string; input?: unknown; providerOptions?: Record<string, unknown> }
interface InputMessage { role: string; content: InputCall[] }
interface GooglePrompt { contents: Array<{ role: string; parts: Array<{ functionCall?: { id: string; name: string; args: unknown }; thoughtSignature?: string }> }> }
function invoke<T>(expression: string, input: unknown): T {
  Object.assign(context, { input });
  const result: unknown = new Script(expression).runInContext(context, { timeout: 1000 });
  assert.equal(unexpectedCalls, 0);
  return structuredClone(result) as T;
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
const metadata = (label: string) => ({ google: { thoughtSignature: `fixture-${label}-signature` }, fixtureOther: { marker: label } });
const calls = ["a", "b"].map(label => ({ type: "tool-call", toolCallId: `call-${label}`, toolName: "inspect",
  input: { path: `${label}.txt` }, providerMetadata: metadata(label) }));
const step = { content: [calls[0]!, { type: "text", text: "Between" }, calls[1]!], finishReason: "tool-calls",
  usage: { inputTokens: 1, outputTokens: 2, inputTokenDetails: {}, outputTokenDetails: {} } };
freeze(step);
const canonical = () => invoke<Assistant>("assistantFromStep(input)", step);
const convert = (message: Assistant) => invoke<InputMessage[]>("toModelMessages([input])", message);
const modelParts = (value: GooglePrompt) => value.contents.flatMap(item => item.parts).filter(part => part.functionCall);

test("canonical calls retain separate metadata and translate it to providerOptions", () => {
  const before = structuredClone(step);
  const message = canonical();
  const stored = message.content.filter((part): part is Call => part.type === "toolCall");
  assert.deepEqual(stored.map(part => [part.id, part.arguments, part.providerMetadata]), [
    ["call-a", { path: "a.txt" }, metadata("a")], ["call-b", { path: "b.txt" }, metadata("b")]
  ]);
  assert.deepEqual(message.content.map(part => part.type), ["toolCall", "text", "toolCall"]);
  const input = convert(message)[0]!.content.filter(part => part.type === "tool-call");
  assert.deepEqual(input.map(part => [part.toolCallId, part.input, part.providerOptions]), [
    ["call-a", { path: "a.txt" }, metadata("a")], ["call-b", { path: "b.txt" }, metadata("b")]
  ]);
  assert.ok(input.every(part => !Object.hasOwn(part, "providerMetadata")));
  assert.deepEqual(step, before);
});

test("already canonical metadata survives the independent input conversion boundary", () => {
  const message: Assistant = { role: "assistant", content: [{ type: "toolCall", id: "manual", name: "inspect",
    arguments: {}, providerMetadata: metadata("manual") }] };
  freeze(message);
  assert.deepEqual(convert(message)[0]!.content[0]!.providerOptions, metadata("manual"));
});

test("actual Google converter keeps original signatures instead of needing its fallback", () => {
  const original = calls.map(call => ({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName,
    input: call.input, providerOptions: call.providerMetadata }));
  const run = (content: unknown, isGemini3Model = true) => invoke<GooglePrompt>(
    "convertToGoogleMessages([{role:'assistant',content:input.content}], {isGemini3Model:input.isGemini3Model})",
    { content, isGemini3Model });
  const direct = modelParts(run(original));
  const replay = modelParts(run(convert(canonical())[0]!.content));
  assert.deepEqual(replay, direct);
  assert.deepEqual(replay.map(part => part.thoughtSignature), ["fixture-a-signature", "fixture-b-signature"]);
  const unsigned = original.map(({ providerOptions: _metadata, ...call }) => call);
  assert.deepEqual(modelParts(run(unsigned)).map(part => part.thoughtSignature),
    ["skip_thought_signature_validator", "skip_thought_signature_validator"]);
  assert.ok(modelParts(run(unsigned, false)).every(part => part.thoughtSignature === undefined));
});

test("streamed calls and snapshots keep per-call metadata and reset at the next step", () => {
  const result = invoke<{ events: Array<{ event: { providerMetadata?: unknown }; message: Assistant }>; snapshot: Assistant; reset: Assistant }>(`(() => {
    const state = {currentText:'', currentReasoning:new Map(), currentToolCalls:[], widgetInputs:new Map(), tools:[]};
    handleVercelStreamPart(state, {type:'start-step'});
    const events = input.flatMap(part => handleVercelStreamPart(state,part));
    const snapshot = assistantSnapshot(state);
    handleVercelStreamPart(state, {type:'start-step'});
    return {events,snapshot,reset:assistantSnapshot(state)};
  })()`, calls);
  assert.ok(result.events.every(item => !Object.hasOwn(item.event, "providerMetadata")), "public tool-call event shape remains unchanged");
  assert.deepEqual(result.events[1]!.message.content.map(part => part.providerMetadata), [metadata("a"), metadata("b")]);
  assert.deepEqual(result.snapshot.content.map(part => part.providerMetadata), [metadata("a"), metadata("b")]);
  assert.deepEqual(result.reset.content, []);
});

test("old absent metadata shapes, invalid flags and historical patch projection are unchanged", () => {
  const message = invoke<Assistant>("assistantFromStep(input)", { ...step, content: [
    { type: "tool-call", toolCallId: "old", toolName: "inspect", input: {}, invalid: true }
  ] });
  assert.deepEqual(message.content, [{ type: "toolCall", id: "old", name: "inspect", arguments: {}, invalid: true }]);
  assert.deepEqual(convert(message)[0]!.content, [{ type: "tool-call", toolCallId: "old", toolName: "inspect", input: {} }]);
  const history = [{ role: "assistant", content: [{ type: "toolCall", id: "patch", name: "apply_patch", arguments: { diff: "fixture" }, providerMetadata: metadata("patch") }] },
    { role: "toolResult", toolCallId: "patch", toolName: "apply_patch", content: [{ type: "text", text: "done" }] },
    { role: "toolResult", toolCallId: "other", toolName: "inspect", isError: true, content: [{ type: "text", text: "error" }] }];
  const historical = invoke<Array<{ role: string; content: Array<{ type: string; text?: string; output?: { type: string } }> }>>("toModelMessages(input)", history);
  assert.deepEqual(historical.map(item => item.role), ["assistant", "tool", "assistant"]);
  assert.equal(historical[0]!.content[0]!.text, 'Historical file patch request: {"diff":"fixture"}');
  assert.equal(historical[1]!.content[0]!.output?.type, "error-text");
  assert.equal(historical[2]!.content[0]!.text, "Historical file patch result (completed): done");
  const native = invoke<InputMessage[]>("toModelMessages(input, true)", history);
  assert.equal(native[0]!.content[0]!.type, "tool-call");
  assert.equal(native[0]!.content[0]!.toolCallId, "patch");
  assert.deepEqual(native[0]!.content[0]!.input, { diff: "fixture" });
});

test("empty metadata and reasoning stay distinct; Google namespace fallback is preserved", () => {
  const signed = { role: "assistant", content: [
    { type: "reasoning", text: "fixture reasoning", providerMetadata: { fixture: { signature: "reasoning" } } },
    { type: "toolCall", id: "empty", name: "inspect", arguments: {}, providerMetadata: {} }
  ] };
  const input = invoke<InputMessage[]>("toModelMessages([input])", signed)[0]!.content;
  assert.deepEqual(input[0]!.providerOptions, { fixture: { signature: "reasoning" } });
  assert.deepEqual(input[1]!.providerOptions, {});
  for (const namespace of ["google", "googleVertex", "vertex"]) {
    const result = invoke<GooglePrompt>("convertToGoogleMessages(input, {isGemini3Model:true})", [{ role: "assistant", content: [
      { type: "tool-call", toolCallId: "fallback", toolName: "inspect", input: {},
        providerOptions: { [namespace]: { thoughtSignature: "fixture-namespace-signature" } } }
    ] }]);
    assert.equal(modelParts(result)[0]!.thoughtSignature, "fixture-namespace-signature");
  }
});

test("actual repair return suffix drops original metadata only on successful local rewrites", () => {
  for (const metadataPresent of [false, true]) {
    for (const renamed of [false, true]) {
      for (const changed of [false, true]) {
        const original = { type: "tool-call", toolCallId: "repair-fixture", toolName: "read",
          input: '{ "filepath": "fixture.txt" }', providerExecuted: false, dynamic: false,
          ...(metadataPresent ? { providerMetadata: metadata("repair") } : {}) };
        const input = { toolCall: original, toolName: renamed ? "Read" : "read",
          repairedInput: changed ? { path: "fixture.txt" } : { filepath: "fixture.txt" }, renamed, changed };
        const before = structuredClone(input);
        freeze(input);
        const result = invoke<Record<string, unknown> | null>(
          "repairSuccessProjection(input.toolCall,input.toolName,input.repairedInput,input.renamed,input.changed)", input);
        if (!renamed && !changed) assert.equal(result, null);
        else {
          assert.deepEqual(result, { type: "tool-call", toolCallId: "repair-fixture", toolName: input.toolName,
            input: JSON.stringify(input.repairedInput), providerExecuted: false, dynamic: false });
          assert.ok(!Object.hasOwn(result!, "providerMetadata"));
        }
        assert.deepEqual(input, before);
      }
    }
  }
  // This deliberately does not run name matching, schema coercion, SDK error taxonomy or async repair.
});

test("non-record input normalization drops metadata in completed and streamed calls", () => {
  const parts = ["{invalid-json", null, ["fixture"], 42].map((input, index) => ({
    type: "tool-call", toolCallId: `normalized-${index}`, toolName: "inspect", input,
    invalid: true, providerMetadata: metadata(`normalized-${index}`)
  }));
  const before = structuredClone(parts);
  freeze(parts);
  const completed = invoke<Assistant>("assistantFromStep(input)", { ...step, content: parts });
  const streamed = invoke<Assistant>(`(() => {
    const state = {currentText:'', currentReasoning:new Map(), currentToolCalls:[], widgetInputs:new Map(), tools:[]};
    for (const part of input) handleVercelStreamPart(state,part);
    return assistantSnapshot(state);
  })()`, parts);
  for (const [message, completedStep] of [[completed, true], [streamed, false]] as const) {
    assert.deepEqual(message.content, parts.map(part => ({ type: "toolCall", id: part.toolCallId,
      name: part.toolName, arguments: {}, ...(completedStep ? { invalid: true } : {}) })));
    assert.ok(message.content.every(part => !Object.hasOwn(part, "providerMetadata")));
    assert.deepEqual(convert(message)[0]!.content, parts.map(part => ({ type: "tool-call",
      toolCallId: part.toolCallId, toolName: part.toolName, input: {} })));
  }
  assert.deepEqual(parts, before);
});

test("record inputs retain metadata even when SDK marks the call invalid", () => {
  const parts = [{ type: "tool-call", toolCallId: "record-invalid", toolName: "inspect",
    input: { path: "fixture.txt" }, invalid: true, providerMetadata: metadata("record-invalid") }];
  const before = structuredClone(parts);
  freeze(parts);
  const completed = invoke<Assistant>("assistantFromStep(input)", { ...step, content: parts });
  const streamed = invoke<Assistant>(`(() => {
    const state = {currentText:'', currentReasoning:new Map(), currentToolCalls:[], widgetInputs:new Map(), tools:[]};
    for (const part of input) handleVercelStreamPart(state,part);
    return assistantSnapshot(state);
  })()`, parts);
  for (const [message, completedStep] of [[completed, true], [streamed, false]] as const) {
    assert.deepEqual(message.content, [{ type: "toolCall", id: "record-invalid", name: "inspect",
      arguments: { path: "fixture.txt" }, ...(completedStep ? { invalid: true } : {}),
      providerMetadata: metadata("record-invalid") }]);
    assert.deepEqual(convert(message)[0]!.content, [{ type: "tool-call", toolCallId: "record-invalid",
      toolName: "inspect", input: { path: "fixture.txt" }, providerOptions: metadata("record-invalid") }]);
  }
  assert.deepEqual(parts, before);
});
