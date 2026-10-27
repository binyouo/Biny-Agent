/**
 * Source-selected pure redaction/schema regression, not a storage integration test.
 * Never imports recorder/events/secrets modules or constructs a recorder/Host.
 * Trusted host bindings are node:util.isDeepStrictEqual and the installed Zod library;
 * VM deadlines and the reviewed AST closure are guardrails, not a security sandbox.
 * Run under an outer process watchdog as well (including source parsing/type stripping).
 * Candidate-only safety policy checks for the NEW optional field: the baseline has no
 * toolCallPersistence helper, so this fixture must not run against that baseline or
 * be described as demonstrating a preexisting privacy leak. The separate conversion
 * fixture demonstrates the original metadata loss. No baseline overlay/fallback/skip.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import { z } from "zod";

// This optional harness selector is a repository path, never credential/config data.
const root = process.env.BINY_TOOL_METADATA_SOURCE_ROOT ?? process.cwd();
const directCalls = new Set(["redactSensitiveValueInternal", "redactSecrets", "isSensitiveFieldName", "redactSensitiveValue", "isDeepStrictEqual", "redactToolCallForPersistence"]);
const methods: Readonly<Record<string, readonly string[]>> = {
  message: ["map", "every"], messages: ["map"], value: ["map", "replace", "slice"], normalized: ["endsWith"],
  ancestors: ["has", "add", "delete"], Array: ["isArray"],
  Object: ["entries", "fromEntries", "map"],
  beginPattern: ["exec"], endPattern: ["exec"], legacyQuotedPattern: ["exec"], completeQuotedPattern: ["exec"],
  parts: ["push", "join"], legacySpans: ["push"], completeSpans: ["push"], quotedParts: ["push", "join"],
  z: ["object", "literal", "string", "unknown", "record", "boolean", "optional", "passthrough"],
};
function receiverRoot(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    || ts.isCallExpression(expression)) return receiverRoot(expression.expression);
  return "<unreviewed>";
}
function select(relative: string, names: readonly string[]): string {
  const file = path.join(root, relative);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
        && node.declarationList.declarations[0]!.name.getText(source) === name);
    assert.equal(matches.length, 1, `unique selected declaration: ${name}`);
    const declaration = matches[0]!;
    let regexCount = 0;
    function audit(node: ts.Node): void {
      assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
        && !ts.isAwaitExpression(node) && !ts.isYieldExpression(node)
        && !ts.isTaggedTemplateExpression(node) && !ts.isClassDeclaration(node));
      if (ts.isIdentifier(node)) assert.ok(!["process", "globalThis", "require", "eval", "Function", "fetch", "constructor", "__proto__", "prototype"].includes(node.text));
      if (ts.isRegularExpressionLiteral(node)) {
        regexCount++;
        assert.ok(name === "redactSecrets" || name === "isSensitiveFieldName", "regex literals only in actual pure redactors");
      }
      if (ts.isNewExpression(node)) assert.ok(ts.isIdentifier(node.expression)
        && node.expression.text === "WeakSet" && name === "redactSensitiveValue", "only reviewed WeakSet constructor");
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee)) assert.ok(directCalls.has(callee.text), `unreviewed direct call: ${callee.text}`);
        else {
          assert.ok(ts.isPropertyAccessExpression(callee), "computed or dynamic call rejected");
          const receiver = receiverRoot(callee.expression);
          // isSensitiveFieldName's string normalization is the only toLowerCase chain.
          assert.ok(methods[receiver]?.includes(callee.name.text)
            || name === "isSensitiveFieldName" && receiver === "value" && callee.name.text === "toLowerCase",
          `unreviewed method: ${receiver}.${callee.name.text}`);
        }
      }
      ts.forEachChild(node, audit);
    }
    audit(declaration);
    assert.equal(regexCount, name === "redactSecrets" ? 8 : name === "isSensitiveFieldName" ? 1 : 0);
    return declaration.getText(source).replace(/^export\s+/u, "");
  }).join("\n");
}
const selected = [
  select("src/utils/redaction.ts", ["redactSecrets"]),
  select("src/utils/secrets.ts", ["redactSensitiveValue", "redactSensitiveValueInternal", "isSensitiveFieldName"]),
  select("src/session/toolCallPersistence.ts", ["redactToolCallForPersistence", "projectCheckpointToolMetadata"]),
  select("src/session/recorder.ts", ["redactAgentMessage"]),
  select("src/session/turnStore.ts", ["isAgentMessage", "isUserContent", "isToolResultContent"]),
  select("src/session/events.ts", ["agentToolCallContentSchema"]),
].join("\n");
const context = createContext({ isDeepStrictEqual, z }, { codeGeneration: { strings: false, wasm: false } });
new Script(stripTypeScriptTypes(selected, { mode: "strip" })).runInContext(context, { timeout: 1000 });

interface Part {
  type: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  invalid?: boolean;
  text?: string;
  providerMetadata?: Record<string, unknown>;
}
interface Message {
  role: string;
  content: Part[];
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
  stopReason?: string;
}
interface Redacted {
  output: Message[];
  unchangedInput: boolean;
  ownMetadata: boolean[][];
}
function invoke<T>(body: string, input: unknown): T {
  // JSON construction inside the realm keeps strict structural equality meaningful.
  // Only synthetic data crosses this boundary, never callbacks/host object prototypes.
  Object.assign(context, { inputJSON: JSON.stringify(input) });
  const encoded: unknown = new Script(`(() => { const input = JSON.parse(inputJSON); ${body} })()`)
    .runInContext(context, { timeout: 1000 });
  assert.equal(typeof encoded, "string");
  return JSON.parse(encoded as string) as T;
}
function redact(messages: Message[]): Redacted {
  const before = structuredClone(messages);
  const result = invoke<Redacted>(`
    const before = JSON.stringify(input);
    const output = input.map(message => redactAgentMessage(message));
    return JSON.stringify({output, unchangedInput: before === JSON.stringify(input),
      ownMetadata: output.map(message => message.content.map(part => Object.hasOwn(part, 'providerMetadata')))
    });`, messages);
  assert.equal(result.unchangedInput, true, "actual selected functions must not mutate VM input");
  assert.deepEqual(messages, before, "host fixture remains unchanged");
  return result;
}
const metadata = { google: { thoughtSignature: "fixture-opaque-signature" }, fixtureVendor: { nested: ["safe", { marker: 3 }] } };
function call(args: Record<string, unknown>, extra: Partial<Part> = {}): Part {
  return { type: "toolCall", id: "fixture-call", name: "inspect", arguments: args, invalid: true, ...extra };
}
function history(part: Part): Message[] {
  return [
    { role: "assistant", content: [part], timestamp: 123, stopReason: "tool-calls" },
    { role: "toolResult", toolCallId: "fixture-call", toolName: "inspect", content: [{ type: "text", text: "fixture done" }], details: { count: 1 }, isError: false },
  ];
}
function assertPair(result: Redacted, expectedArguments: Record<string, unknown>): void {
  assert.deepEqual(result.output.map(message => message.role), ["assistant", "toolResult"]);
  const part = result.output[0]!.content[0]!;
  assert.equal(part.id, "fixture-call");
  assert.equal(part.name, "inspect");
  assert.equal(part.invalid, true);
  assert.deepEqual(part.arguments, expectedArguments);
  assert.equal(result.output[0]!.timestamp, 123);
  assert.equal(result.output[0]!.stopReason, "tool-calls");
  assert.deepEqual(result.output[1], history(call({}))[1]);
  assert.equal(result.output[1]!.toolCallId, part.id);
}

test("unchanged metadata survives structural comparison with real default-redactor copies", () => {
  const args = { nested: { values: [1, false, null, "ordinary"] } };
  const result = redact(history(call(args, { providerMetadata: metadata })));
  assertPair(result, args);
  assert.deepEqual(result.output[0]!.content[0]!.providerMetadata, metadata);
  assert.deepEqual(result.ownMetadata[0], [true]);
});

test("redacted arguments omit metadata but preserve sanitized call and matching result", () => {
  const result = redact(history(call({ nested: { password: "fixture-value", count: 2 } }, { providerMetadata: metadata })));
  assertPair(result, { nested: { password: "[redacted]", count: 2 } });
  assert.deepEqual(result.ownMetadata[0], [false]);
  assert.equal(result.output[0]!.content[0]!.providerMetadata, undefined);
});

test("redacted metadata omits the entire record, not merely the changed provider field", () => {
  const result = redact(history(call({ count: 2 }, {
    providerMetadata: { ...metadata, fixtureVendor: { apiKey: "fixture-value", marker: "safe" } },
  })));
  assertPair(result, { count: 2 });
  assert.deepEqual(result.ownMetadata[0], [false]);
  assert.equal(result.output[0]!.content[0]!.providerMetadata, undefined);
});

test("opaque signature values still pass through real default text redaction", () => {
  const result = redact(history(call({}, {
    providerMetadata: { fixtureVendor: { signature: "password=fixture-value" } },
  })));
  assertPair(result, {});
  assert.deepEqual(result.ownMetadata[0], [false]);
});

test("old missing metadata preserves exact old call shape, while empty record stays present", () => {
  const old = history(call({ path: "fixture.txt" }));
  const absent = redact(old);
  assert.deepEqual(absent.output, old);
  assert.deepEqual(absent.ownMetadata[0], [false]);
  const empty = redact(history(call({}, { providerMetadata: {} })));
  assert.deepEqual(empty.output[0]!.content[0]!.providerMetadata, {});
  assert.deepEqual(empty.ownMetadata[0], [true]);
});

test("actual tool-call schema accepts old/record JSON shapes and rejects malformed metadata", () => {
  const parse = (value: unknown) => invoke<{ success: boolean; data?: Part }>(`
    const result = agentToolCallContentSchema.safeParse(input);
    return JSON.stringify(result.success ? {success:true,data:result.data} : {success:false});`, value);
  const old = call({});
  assert.deepEqual(parse(old), { success: true, data: old });
  for (const providerMetadata of [{}, metadata, { arbitraryNamespace: { marker: "safe" } }]) {
    const part = call({}, { providerMetadata });
    assert.deepEqual(parse(part), { success: true, data: part });
  }
  for (const providerMetadata of [null, [], [metadata], "fixture", 7, true]) {
    assert.equal(parse({ ...old, providerMetadata }).success, false);
  }
});

test("existing reasoning policy remains text-sensitive and retains redacted metadata on unchanged text", () => {
  const result = redact([{ role: "assistant", content: [
    { type: "reasoning", text: "ordinary", providerMetadata: metadata },
    { type: "reasoning", text: "password=fixture-value", providerMetadata: metadata },
    { type: "reasoning", text: "ordinary", providerMetadata: { fixtureVendor: { apiKey: "fixture-value" } } },
  ] }]);
  assert.deepEqual(result.output[0]!.content, [
    { type: "reasoning", text: "ordinary", providerMetadata: metadata },
    { type: "reasoning", text: "password=[redacted]" },
    { type: "reasoning", text: "ordinary", providerMetadata: { fixtureVendor: { apiKey: "[redacted]" } } },
  ]);
  // Existing reasoning keeps an own undefined field until JSON serialization; do not change it here.
  assert.deepEqual(result.ownMetadata[0], [true, true, true]);
});

test("checkpoint projection changes only unsafe new metadata and leaves old payload fields intact", () => {
  const safe = call({ nested: [1, { marker: "safe" }] }, { id: "safe", providerMetadata: metadata });
  const sensitiveArgs = call({ password: "fixture-value", count: 3 }, { id: "args", providerMetadata: metadata });
  const sensitiveMetadata = call({ path: "fixture.txt" }, { id: "metadata", providerMetadata: { fixtureVendor: { apiKey: "fixture-value" } } });
  const sensitiveSignature = call({}, { id: "signature", providerMetadata: { fixtureVendor: { signature: "password=fixture-value" } } });
  const unsigned = call({ password: "fixture-old-value" }, { id: "unsigned" });
  const reasoning = { type: "reasoning", text: "password=fixture-reasoning", providerMetadata: { fixtureVendor: { apiKey: "fixture-old-value" } } };
  const input = [
    { role: "assistant", content: [safe, sensitiveArgs, sensitiveMetadata, sensitiveSignature, unsigned, reasoning,
      { type: "text", text: "password=fixture-text" }], timestamp: 123, stopReason: "tool-calls", fixtureExtra: { password: "fixture-extra" } },
    { role: "toolResult", toolCallId: "args", toolName: "inspect", content: [{ type: "text", text: "password=fixture-result" }], details: { password: "fixture-details" }, isError: true },
    { role: "user", content: "password=fixture-user" },
  ];
  const before = structuredClone(input);
  const result = invoke<{ output: unknown; ownMetadata: boolean[]; unchangedInput: boolean }>(`
    const before = JSON.stringify(input);
    const output = projectCheckpointToolMetadata(input);
    return JSON.stringify({output, unchangedInput: before === JSON.stringify(input),
      ownMetadata: output[0].content.map(part => Object.hasOwn(part, 'providerMetadata'))});`, input);
  const omitMetadata = ({ providerMetadata: _metadata, ...part }: Part): Part => part;
  assert.deepEqual(result.output, [
    { ...input[0], content: [safe, omitMetadata(sensitiveArgs), omitMetadata(sensitiveMetadata),
      omitMetadata(sensitiveSignature), unsigned, reasoning, { type: "text", text: "password=fixture-text" }] },
    input[1], input[2],
  ]);
  assert.deepEqual(result.ownMetadata, [true, false, false, false, false, true, false]);
  assert.equal(result.unchangedInput, true);
  assert.deepEqual(input, before);
  // The same actual helper backs canonical history, which DOES redact arguments.
  const canonical = redact(history(sensitiveArgs));
  assert.deepEqual(canonical.output[0]!.content[0]!.arguments, { password: "[redacted]", count: 3 });
  assert.deepEqual(canonical.ownMetadata[0], [false]);
});

test("checkpoint projection preserves empty metadata and unsigned legacy messages", () => {
  const input = history(call({ password: "fixture-old-value" }));
  const result = invoke<{ output: unknown; unchangedInput: boolean; ownMetadata: boolean }>(`
    const before = JSON.stringify(input);
    const output = projectCheckpointToolMetadata(input);
    return JSON.stringify({output, unchangedInput: before === JSON.stringify(input),
      ownMetadata: Object.hasOwn(output[0].content[0], 'providerMetadata')});`, input);
  assert.deepEqual(result.output, input);
  assert.equal(result.unchangedInput, true);
  assert.equal(result.ownMetadata, false);
  const empty = history(call({}, { providerMetadata: {} }));
  assert.deepEqual(invoke<unknown>("return JSON.stringify(projectCheckpointToolMetadata(input));", empty), empty);
});

test("actual checkpoint message validator agrees on optional tool metadata record shape", () => {
  const accepts = (part: unknown) => invoke<boolean>("return JSON.stringify(isAgentMessage({role:'assistant',content:[input]}));", part);
  assert.equal(accepts(call({})), true);
  for (const providerMetadata of [{}, metadata, { arbitraryNamespace: { marker: "safe" } }]) {
    assert.equal(accepts(call({}, { providerMetadata })), true);
  }
  for (const providerMetadata of [null, [], [metadata], "fixture", 7, true]) {
    assert.equal(accepts({ ...call({}), providerMetadata }), false);
  }
  for (const message of [
    { role: "user", content: "fixture" },
    { role: "user", content: [{ type: "text", text: "fixture" }] },
    history(call({}))[1],
    { role: "assistant", content: [{ type: "reasoning", text: "fixture", providerMetadata: metadata }] },
  ]) assert.equal(invoke<boolean>("return JSON.stringify(isAgentMessage(input));", message), true);
});

test("TurnStore save statically wires payload.messages to the pure projection", () => {
  // Inspect syntax only: neither this class nor save/load/file APIs are evaluated.
  const file = path.join(root, "src/session/turnStore.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const classes = source.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === "TurnStore");
  assert.equal(classes.length, 1);
  const saves = classes[0]!.members.filter(ts.isMethodDeclaration).filter(node => node.name.getText(source) === "save");
  assert.equal(saves.length, 1);
  const body = saves[0]!.body;
  assert.ok(body);
  const payloads = body.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations]).filter(node => node.name.getText(source) === "payload");
  assert.equal(payloads.length, 1);
  const initializer = payloads[0]!.initializer;
  assert.ok(initializer && ts.isObjectLiteralExpression(initializer));
  const fields = initializer.properties.filter(ts.isPropertyAssignment).filter(node => node.name.getText(source) === "messages");
  assert.equal(fields.length, 1);
  const projection = fields[0]!.initializer;
  assert.ok(ts.isCallExpression(projection) && ts.isIdentifier(projection.expression));
  assert.equal(projection.expression.text, "projectCheckpointToolMetadata");
  assert.equal(projection.arguments.length, 1);
  assert.equal(projection.arguments[0]!.getText(source), "messages");
  const imports = source.statements.filter(ts.isImportDeclaration).filter(node =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./toolCallPersistence.js");
  assert.equal(imports.length, 1);
  const bindings = imports[0]!.importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  assert.ok(bindings.elements.some(item => item.name.text === "projectCheckpointToolMetadata" && !item.propertyName));
});
