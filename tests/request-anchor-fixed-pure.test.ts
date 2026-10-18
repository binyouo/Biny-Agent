import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { projectMessageSentAt } from "../src/agent/modelMessages.js";

// Request logic is extracted; the shared send-time formatter is pure. No SDK, storage, or model is imported.
const root = process.env.BINY_ANCHOR_SOURCE_ROOT ?? process.cwd();
const sourcePath = process.env.BINY_ANCHOR_SOURCE ?? path.join(root, "src/agent/context/requestAnchor.ts");
const baselinePath = process.env.BINY_ANCHOR_BASELINE;
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
function functions(source: ts.SourceFile, names: readonly string[]): ts.FunctionDeclaration[] {
  return names.map(name => one(source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name), name));
}
function guard(nodes: readonly ts.Node[], source: ts.SourceFile): void {
  const calls = new Set([
    "createHash", "createHash(\"sha256\").update", "createHash(\"sha256\").update(JSON.stringify(value)).digest",
    "JSON.stringify", "hash", "requestFingerprintHash", "fixedRequestFingerprint", "requestFingerprints",
    "context.tools.map", "context.messages.map", "anchor.messageFingerprints.some", "context.messages.slice",
    "projectMessageSentAt", "estimateMessageTokens", "messages.reduce", "messageTokenCost", "estimateTokens", "Math.ceil", "Buffer.byteLength"
  ]);
  const visit = (node: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isNewExpression(node)
      && !ts.isAwaitExpression(node) && !ts.isTaggedTemplateExpression(node), "no external execution boundary");
    if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(source)),
      "unreviewed call: " + node.expression.getText(source));
    ts.forEachChild(node, visit);
  };
  nodes.forEach(visit);
}
const tokenSource = parse(path.join(root, "src/agent/context/tokenUsage.ts"));
const tokenNodes = functions(tokenSource, ["estimateTokens", "messageTokenCost", "estimateMessageTokens"]);
guard(tokenNodes, tokenSource);
const tokenText = tokenNodes.map(node => node.getText(tokenSource).replace(/^export /u, "")).join("\n");
function program(file: string): string {
  const source = parse(file);
  const allowedNames = ["requestFingerprints", "anchoredRequestTokens", "requestFingerprintHash", "fixedRequestFingerprint"];
  const nodes = source.statements.filter(ts.isFunctionDeclaration);
  for (const node of nodes) assert.ok(node.name && allowedNames.includes(node.name.text), "known functions only");
  functions(source, ["requestFingerprints", "anchoredRequestTokens"]);
  guard(nodes, source);
  const text = [tokenText, ...nodes.map(node => node.getText(source).replace(/^export /u, "")),
    "({ requestFingerprints, anchoredRequestTokens, estimateMessageTokens });"].join("\n");
  const compiled = ts.transpileModule(text, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return compiled.outputText;
}
const selectedProgram = program(sourcePath);
const baselineProgram = baselinePath === undefined ? undefined : program(baselinePath);

// Fixture-facing plain-data shapes only; normal CI checks actual product types.
interface Model { provider: string; providerAlias?: string; modelId: string; vercelOptions?: Record<string, unknown> }
interface Message { role: string; content: string | Array<Record<string, unknown>>; [key: string]: unknown }
interface Tool { name: string; description: string; parameters: Record<string, unknown>; [key: string]: unknown }
interface Context { systemPrompt?: string; messages: Message[]; tools: Tool[] }
interface Fingerprints { fixedFingerprint: string; messageFingerprints: string[] }
interface Anchor extends Fingerprints { inputTokens: number; measuredAt: string }
interface Api {
  requestFingerprints(model: Model, context: Context, identity?: string): Fingerprints;
  anchoredRequestTokens(anchor: Anchor | undefined, model: Model, context: Context, identity?: string): number | undefined;
  estimateMessageTokens(messages: Message[]): number;
}
function fixture(code = selectedProgram) {
  const counts = { hashes: 0, json: 0 };
  const api = runInNewContext(code, {
    projectMessageSentAt,
    createHash: (algorithm: string) => { assert.equal(algorithm, "sha256"); counts.hashes++; return createHash(algorithm); },
    JSON: Object.freeze({ stringify: (value: unknown) => { counts.json++; return JSON.stringify(value); } }),
    Buffer: Object.freeze({ byteLength: (value: string, encoding: BufferEncoding) => Buffer.byteLength(value, encoding) })
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Api;
  return { api, counts, reset: () => { counts.hashes = 0; counts.json = 0; } };
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}
const model: Model = { provider: "fixture", providerAlias: "default", modelId: "small",
  vercelOptions: { maxOutputTokens: 1_024, providerOptions: { fixture: { mode: "plain" } } } };
const tool = (name: string): Tool => ({ name, description: name + " description", parameters: { type: "object", properties: {} } });
const context = (messages: Message[] = [{ role: "user", content: "hello" }]): Context => ({
  systemPrompt: "stable rules", messages, tools: [tool("Read")]
});
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function producer(f: ReturnType<typeof fixture>, m: Model, c: Context, identity?: string): Fingerprints {
  const before = JSON.stringify([m, c]);
  freeze(m); freeze(c);
  f.reset();
  const result = f.api.requestFingerprints(m, c, identity);
  // Explicit stable serialization contract, independently hashed by Node.
  const expected = {
    fixedFingerprint: hash([identity, m.provider, m.providerAlias, m.modelId, m.vercelOptions, c.systemPrompt ?? "",
      c.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))]),
    messageFingerprints: c.messages.map(message => hash(message))
  };
  assert.equal(JSON.stringify(result), JSON.stringify(expected), "producer values AND property ordering remain unchanged");
  assert.equal(f.counts.hashes, c.messages.length + 1, "producer still fingerprints the complete request once");
  assert.equal(f.counts.json, c.messages.length + 1, "producer serialization is not duplicated");
  if (baselineProgram !== undefined) {
    const original = fixture(baselineProgram);
    assert.equal(JSON.stringify(result), JSON.stringify(original.api.requestFingerprints(m, c, identity)), "actual baseline producer byte-equivalence");
  }
  assert.equal(JSON.stringify([m, c]), before, "producer does not mutate frozen inputs");
  return result;
}
function anchor(f: ReturnType<typeof fixture>, m: Model, c: Context, inputTokens = 100, identity?: string): Anchor {
  return { ...producer(f, m, c, identity), inputTokens, measuredAt: "2026-10-13T00:00:00.000Z" };
}
function check(f: ReturnType<typeof fixture>, a: Anchor | undefined, m: Model, c: Context, expected: number | undefined, identity?: string): void {
  // Every tested candidate context also has its complete producer checked.
  producer(f, m, c, identity);
  const before = JSON.stringify([a, m, c]);
  freeze(a); freeze(m); freeze(c);
  f.reset();
  assert.equal(f.api.anchoredRequestTokens(a, m, c, identity), expected);
  if (baselineProgram !== undefined) {
    const original = fixture(baselineProgram);
    assert.equal(original.api.anchoredRequestTokens(a, m, c, identity), expected, "baseline and candidate return equal values");
  }
  assert.equal(JSON.stringify([a, m, c]), before, "consumer does not mutate frozen inputs");
}

for (const length of [1_000, 5_000]) {
  test("changed discovered tools skip message hashing for " + length + " normal messages", () => {
    const f = fixture();
    const original = context(Array.from({ length }, (_, index) => ({ role: index % 2 ? "assistant" : "user",
      content: index % 2 ? [{ type: "text", text: "response " + index }] : "request " + index })));
    const a = anchor(f, model, original);
    const next = { ...original, tools: [...original.tools, tool("WebFetch")] };
    check(f, a, model, next, undefined);
    console.log(JSON.stringify({ case: "new tool", messages: length, ...f.counts }));
    assert.deepEqual(f.counts, { hashes: 1, json: 1 }, "fixed mismatch needs only its fixed fingerprint");
  });
}

test("every fixed identity component preserves nonmatch without scanning messages", () => {
  const changes: Array<{ m?: Model; c?: Partial<Context>; identity?: string }> = [
    { m: { ...model, provider: "other" } }, { m: { ...model, providerAlias: "other" } },
    { m: { ...model, modelId: "other" } }, { m: { ...model, vercelOptions: { maxOutputTokens: 2_048 } } },
    { c: { systemPrompt: "new system" } }, { identity: "configuration-b" },
    { c: { tools: [tool("Read"), tool("Write")] } },
    { c: { tools: [{ ...tool("Read"), description: "new description" }] } },
    { c: { tools: [{ ...tool("Read"), parameters: { type: "object", required: ["path"] } }] } }
  ];
  for (const change of changes) {
    const f = fixture(); const original = context(); const a = anchor(f, model, original, 100, "configuration-a");
    check(f, a, change.m ?? model, { ...original, ...change.c }, undefined, change.identity ?? "configuration-a");
    assert.deepEqual(f.counts, { hashes: 1, json: 1 });
  }
  const f = fixture(); const original = { ...context(), tools: [tool("Read"), tool("Write")] };
  const a = anchor(f, model, original);
  check(f, a, model, { ...original, tools: [...original.tools].reverse() }, undefined);
  assert.deepEqual(f.counts, { hashes: 1, json: 1 }, "ordered schemas stay part of fixed identity");
});

test("matching requests still hash every message once without a duplicate fixed hash", () => {
  const f = fixture(); const original = context(); const a = anchor(f, model, original);
  const tail: Message[] = [
    { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "toolCall", id: "call", name: "Read", arguments: { path: "file" } }] },
    { role: "toolResult", toolName: "Read", toolCallId: "call", content: [{ type: "text", text: "结果" }] },
    { role: "user", content: [{ type: "image", data: "inert-data", mimeType: "image/png" }, { type: "audio", data: "inert", mimeType: "audio/wav" }] }
  ];
  const next = { ...original, messages: [...original.messages, ...tail] };
  const expected = 100 + f.api.estimateMessageTokens(tail);
  check(f, a, model, next, expected);
  assert.equal(f.counts.hashes, next.messages.length + 1, "matching path retains original whole map");
  assert.equal(f.counts.json, next.messages.length + 2, "one extra JSON operation comes only from the real tail tool-call estimator");
  check(f, a, model, original, 100);
  assert.deepEqual(f.counts, { hashes: 2, json: 2 });
});

test("no anchor is still zero work and zero measured usage remains valid", () => {
  const f = fixture(); const original = context();
  check(f, undefined, model, original, undefined);
  assert.deepEqual(f.counts, { hashes: 0, json: 0 });
  const a = anchor(f, model, original, 0);
  check(f, a, model, original, 0);
  assert.deepEqual(f.counts, { hashes: 2, json: 2 });
});

test("shorter input and changed old messages retain the full matching-fixed map", () => {
  const f = fixture();
  const original = context([{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "second" }] }]);
  const a = anchor(f, model, original);
  for (const next of [
    { ...original, messages: original.messages.slice(0, 1) },
    { ...original, messages: [{ role: "user", content: "changed" }, original.messages[1]!] },
    { ...original, messages: [original.messages[0]!, { role: "assistant", content: [{ type: "text", text: "changed" }] }] }
  ]) {
    check(f, a, model, next, undefined);
    assert.deepEqual(f.counts, { hashes: next.messages.length + 1, json: next.messages.length + 1 });
  }
});

test("empty prefixes, optional identity fields and ordinary metadata keep their serialized meaning", () => {
  const f = fixture(); const minimal: Model = { provider: "fixture", modelId: "small" };
  const empty: Context = { messages: [], tools: [] };
  const a = anchor(f, minimal, empty, 0);
  check(f, a, minimal, { ...empty, systemPrompt: "" }, 0);
  assert.deepEqual(f.counts, { hashes: 1, json: 1 });
  const message: Message = { role: "user", content: "visible", originalContent: "canonical", timestamp: 0 };
  const next = { ...empty, messages: [message] };
  check(f, a, minimal, next, f.api.estimateMessageTokens(next.messages));
  assert.deepEqual(f.counts, { hashes: 2, json: 2 });
  const previous = anchor(f, minimal, next);
  check(f, previous, minimal, { ...next, messages: [{ ...message, originalContent: "changed canonical" }] }, undefined);
  assert.deepEqual(f.counts, { hashes: 2, json: 2 }, "whole message shape remains fingerprinted");
});

test("non-fingerprint tool fields do not change identity and subsequent calls do not cache", () => {
  const f = fixture(); const original = context(); const a = anchor(f, model, original);
  check(f, a, model, { ...original, tools: [{ ...original.tools[0]!, label: "display-only" }] }, 100);
  assert.deepEqual(f.counts, { hashes: 2, json: 2 });
  check(f, a, model, { ...original, tools: [tool("Write")] }, undefined);
  assert.deepEqual(f.counts, { hashes: 1, json: 1 });
  check(f, a, model, original, 100);
  assert.deepEqual(f.counts, { hashes: 2, json: 2 });
});
