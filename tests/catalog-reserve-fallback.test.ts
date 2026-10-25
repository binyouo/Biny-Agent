import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

// Read the checkout under test; never import its provider/auth/network module graph.
const sourcePath = path.join(process.cwd(), "src/ai/modelCatalog.ts");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = [
  "parseModelCatalog", "isRecord", "stringValue", "formatCodexModelName", "numberValue",
  "nonNegativeInteger", "booleanValue", "modelMetadataSources", "firstValue", "firstString",
  "firstNumber", "firstBoolean", "firstArray", "parseThinkingLevelMap", "parseLimits",
  "firstNonNegativeInteger", "modalityCapability", "isReasoningEffort"
] as const;
const selected = names.map(name => {
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `exactly one complete declaration: ${name}`);
  const declaration = matches[0]!;
  assert.ok(declaration.body, `complete body: ${name}`);
  const visit = (node: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isAwaitExpression(node),
      `unexpected effect in ${name}`);
    if (ts.isNewExpression(node)) {
      assert.ok(ts.isIdentifier(node.expression) && node.expression.text === "Set",
        `unreviewed constructor in ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return declaration.getText(source).replace(/^export /u, "");
}).join("\n");
// The false inference flag makes this dependency unreachable; fail rather than
// accidentally invoking a real model-family heuristic if the parser changes.
const code = stripTypeScriptTypes(`${selected}
function inferReasoningEfforts() { throw new Error("unexpected reasoning inference"); }
const input = JSON.parse(inputJson);
const before = JSON.stringify(input);
const entries = parseModelCatalog(input, "fixture", "openai-compatible", false);
JSON.stringify({ entries, unchanged: before === JSON.stringify(input) });`, { mode: "strip" });
const script = new Script(code, { filename: "catalog-reserve-fallback-pure.js" });

interface Entry {
  id: string;
  displayName: string;
  provider: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limits?: Record<string, number>;
  capabilities: Record<string, boolean | string[]>;
  reasoningEfforts: string[];
  reasoningEffortsSource?: string;
  thinkingLevelMap?: Record<string, string | null>;
}
function parse(input: unknown): Entry[] {
  const context = createContext({ inputJson: JSON.stringify(input) }, {
    codeGeneration: { strings: false, wasm: false }
  });
  // The parser invocation itself, not just function creation, is timeout-bound.
  const encoded: unknown = script.runInContext(context, { timeout: 1000 });
  assert.equal(typeof encoded, "string");
  const result = JSON.parse(encoded as string) as { entries: Entry[]; unchanged: boolean };
  assert.equal(result.unchanged, true, "parsing does not mutate its input");
  return result.entries;
}
function entry(fields: Record<string, unknown>): Entry {
  const entries = parse({ data: [{ id: "fixture-model", ...fields }] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, "fixture-model");
  return entries[0]!;
}
const reserves = [
  ["reasoningReserveTokens", "reasoning_reserve_tokens"],
  ["toolSchemaReserveTokens", "tool_schema_reserve_tokens"],
  ["systemPromptReserveTokens", "system_prompt_reserve_tokens"],
  ["protocolSafetyMarginTokens", "protocol_safety_margin_tokens"]
] as const;
const invalids: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null], ["nonnumeric string", "unknown"], ["negative", -1],
  ["fraction", 1.5], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1]
];

for (const [camel, snake] of reserves) {
  for (const [label, invalid] of invalids) {
    test(`${camel}: invalid ${label} falls through to same-source alias`, () => {
      assert.equal(entry({ [camel]: invalid, [snake]: 2048 }).limits?.[camel], 2048);
    });
    test(`${camel}: invalid ${label} falls through to nested limits`, () => {
      assert.equal(entry({ [camel]: invalid, limits: { [snake]: "2048" } }).limits?.[camel], 2048);
    });
  }
  test(`${camel}: zero is a valid winner in either spelling and nested metadata`, () => {
    assert.equal(entry({ [camel]: 0, [snake]: 2048, limits: { [camel]: 4096 } }).limits?.[camel], 0);
    assert.equal(entry({ [snake]: "0", metadata: { [camel]: 2048 } }).limits?.[camel], 0);
    assert.equal(entry({ [camel]: null, metadata: { [snake]: 0 }, limits: { [camel]: 2048 } }).limits?.[camel], 0);
  });
  test(`${camel}: valid source and alias precedence is retained`, () => {
    assert.equal(entry({ [camel]: 128, [snake]: 256, metadata: { [camel]: 512 } }).limits?.[camel], 128);
    assert.equal(entry({ [snake]: 256, metadata: { [camel]: 512 } }).limits?.[camel], 256);
    assert.equal(entry({ metadata: { [snake]: 512 }, limits: { [camel]: 1024 } }).limits?.[camel], 512);
    assert.equal(entry({ metadata: { [camel]: null, [snake]: 512 }, limits: { [camel]: 1024 } }).limits?.[camel], 512);
  });
  test(`${camel}: numeric strings and safe integer boundaries retain their values`, () => {
    for (const value of [" 2048 ", "00012", Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
      assert.equal(entry({ [camel]: value }).limits?.[camel], Number(value));
    }
  });
  test(`${camel}: all-invalid candidates omit limits rather than inventing zero`, () => {
    assert.equal(entry({ [camel]: null, [snake]: "bad", metadata: { [camel]: -1 },
      limits: { [camel]: 1.5, [snake]: Number.MAX_SAFE_INTEGER + 1 } }).limits, undefined);
  });
}

test("all supported nested sources retain ordered reserve fallback", () => {
  for (const nested of ["metadata", "model_info", "modelInfo", "limits", "capabilities", "reasoning", "model"]) {
    for (const [camel, snake] of reserves) {
      assert.equal(entry({ [camel]: null, [nested]: { [snake]: 2048 } }).limits?.[camel], 2048);
    }
  }
  const fields = Object.fromEntries(reserves.map(([camel], index) => [camel, index * 128]));
  assert.deepEqual(entry({ limits: fields }).limits, fields);
});

test("reserve correction preserves positive-only input limits and ordinary catalog fields", () => {
  const model = entry({
    display_name: "Fixture Model", context_window: null, contextWindow: "8192",
    maxInputTokens: 0, max_input_tokens: "4096", max_tokens: 0, max_output_tokens: "1024",
    supports_tools: "bad", supportsTools: false, supports_streaming: false,
    supports_vision: true, reasoning_efforts: ["low", "high", "bogus"],
    protocolSafetyMarginTokens: null, protocol_safety_margin_tokens: 2048
  });
  assert.deepEqual(model, {
    id: "fixture-model", displayName: "Fixture Model", provider: "fixture", contextWindow: 8192,
    maxInputTokens: 4096, maxOutputTokens: 1024,
    limits: { maxInputTokens: 4096, protocolSafetyMarginTokens: 2048 },
    capabilities: { tools: false, vision: true, streaming: false },
    reasoningEfforts: ["low", "high"], reasoningEffortsSource: "declared"
  });
  assert.equal(entry({ maxInputTokens: 0, max_input_tokens: -1 }).limits, undefined);
});

test("unknown, hidden and malformed entries retain parser behavior", () => {
  assert.deepEqual(parse(null), []);
  assert.deepEqual(parse({ data: [null, 1, {}, { id: "hidden", visibility: "hidden" }] }), []);
  assert.equal(parse({ models: [{ name: "models/fixture" }] })[0]?.id, "fixture");
  const plain = entry({});
  assert.equal(plain.limits, undefined);
  assert.deepEqual(plain.reasoningEfforts, []);
  assert.deepEqual(entry({ thinking_level_map: { off: "none", high: "deep" } }).thinkingLevelMap,
    { off: "none", high: "deep" });
});

test("declared service tiers retain built-in Set deduplication", () => {
  assert.deepEqual(entry({ service_tiers: ["priority", "default", "priority", null] }).capabilities.serviceTiers,
    ["priority"]);
  assert.equal(entry({ service_tiers: ["default"] }).capabilities.serviceTiers, undefined);
});
