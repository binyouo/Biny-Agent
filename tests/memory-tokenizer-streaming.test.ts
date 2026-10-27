/** Pure source-selected tokenizer controls; no product imports or storage access. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/agent/context/memoryFormat.ts", "utf8");
const parsed = ts.createSourceFile("memoryFormat.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const declarations = parsed.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "tokenizeMemoryText");
assert.equal(declarations.length, 1);
const declaration = declarations[0]!;
assert.ok(declaration.body);
const exportToken = declaration.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
assert.ok(exportToken);
const selected = source.slice(declaration.getStart(parsed), exportToken.getStart(parsed))
  + source.slice(exportToken.end, declaration.end);
const compiled = ts.transpileModule(selected, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal(compiled.diagnostics?.length ?? 0, 0);
assert.doesNotMatch(compiled.outputText, /\b(?:require|import)\s*\(/u);

// Frozen pre-change algorithm: an output oracle and a positive observer control.
const legacy = String.raw`
function tokenizeMemoryText(value, maxTokens = 64) {
  const lower = value.toLowerCase();
  const ascii = lower.split(/[^a-z0-9_$./-]+/).filter((term) => term.length >= 2);
  const cjk = [];
  for (const run of lower.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) cjk.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) cjk.push(run.slice(index, index + 2));
  }
  return [...new Set([...ascii, ...cjk])].slice(0, maxTokens);
}`;

interface Observation {
  tokens: string[];
  maxPushReceiverLength: number;
  arrayIterableLength: number;
  arrayIterableCalls: number;
  absentIterableCalls: number;
  otherIterableCalls: number;
}

function evaluate(code: string, value: string, cap?: number, observe = false): Observation {
  assert.ok(value.length <= 30_000, "fixtures stay within the bounded pure-test budget");
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  // Hooks affect this disposable realm only. No host functions/prototypes enter it.
  // Counts describe intermediate collections, not heap bytes or elapsed time.
  const script = new vm.Script(`"use strict";
    ${code}
    let maxPushReceiverLength = 0, arrayIterableLength = 0;
    let arrayIterableCalls = 0, absentIterableCalls = 0, otherIterableCalls = 0;
    const originalPush = Array.prototype.push, OriginalSet = Set;
    let tokens;
    try {
      if (${observe}) {
        Array.prototype.push = function (...items) {
          const length = Reflect.apply(originalPush, this, items);
          maxPushReceiverLength = Math.max(maxPushReceiverLength, this.length);
          return length;
        };
        globalThis.Set = class extends OriginalSet {
          constructor(iterable) {
            if (Array.isArray(iterable)) {
              arrayIterableCalls++;
              arrayIterableLength = Math.max(arrayIterableLength, iterable.length);
            } else if (iterable === undefined) absentIterableCalls++;
            else otherIterableCalls++;
            super(iterable);
          }
        };
      }
      tokens = tokenizeMemoryText(${JSON.stringify(value)}, ${cap === undefined ? "undefined" : String(cap)});
    } finally {
      Array.prototype.push = originalPush;
      globalThis.Set = OriginalSet;
    }
    JSON.stringify({ tokens, maxPushReceiverLength, arrayIterableLength,
      arrayIterableCalls, absentIterableCalls, otherIterableCalls });`);
  const encoded: unknown = script.runInContext(context, { timeout: 1_000 });
  assert.equal(typeof encoded, "string");
  return JSON.parse(encoded as string) as Observation;
}

const fixtures = [
  "", " \n\t!?", "a Z 0 _ $ . / -", "AA aa Bb 12 _x $y ./ -- /path/file.ts",
  "aa:bb;cc,dd!ee?ff\\gg\"hh'ii@jj#kk%ll&mm(nn)oo[pp]qq{rr}ss=tt+uu|vv<ww>xx~yy`zz",
  "甲", "甲乙", "甲乙丙 甲乙 甲 乙", "甲乙甲乙、甲乙丙；甲乙甲乙",
  "中文 First 第二 ALPHA first 甲乙 beta", "İİ KK ABC ÄßΣ 中文😀甲\ud800乙\udfff丙",
  "\u303f\u3040\u3041\u30fe\u30ff\u3100 \u33ff\u3400\u3401\u4dbe\u4dbf\u4dc0",
  "\u4dff\u4e00\u4e01\u9ffe\u9fff\ua000 \uf8ff\uf900\uf901\ufafe\ufaff\ufb00",
  "あいう カキク 一二三 㐀㐁㐂 豈更車",
  `${Array.from({ length: 90 }, (_, index) => `term${index}`).join(" ")} 中文部署回滚`,
  `${"甲".repeat(29_990)} 部署回滚`,
  `${"aa ".repeat(9_990)}tail 中文`
];
const caps = [undefined, 0, -0, 1, 2, 24, 64, 30_000, -1, -2, -30_000, 0.9, 2.9, -1.9, NaN, Infinity, -Infinity];

test("tokenizer retains exact legacy ordering, boundaries, case folding and slice semantics", () => {
  for (const [index, value] of fixtures.entries()) {
    for (const cap of caps) {
      assert.deepEqual(evaluate(compiled.outputText, value, cap).tokens, evaluate(legacy, value, cap).tokens,
        `fixture ${index}, cap ${String(cap)}`);
    }
  }
});

test("independent expected tokens retain ASCII-first, singleton and overlapping CJK behavior", () => {
  assert.deepEqual(evaluate(compiled.outputText, "甲乙丙 ALPHA beta alpha 甲、乙").tokens,
    ["alpha", "beta", "甲乙", "乙丙", "甲", "乙"]);
  const body = `${"甲".repeat(29_990)} 部署回滚`;
  assert.deepEqual(evaluate(compiled.outputText, body, 30_000).tokens, ["甲甲", "部署", "署回", "回滚"]);
  const mixed = `${Array.from({ length: 70 }, (_, index) => `term${index}`).join(" ")} 部署回滚`;
  assert.equal(evaluate(compiled.outputText, mixed).tokens.length, 64);
  assert.ok(!evaluate(compiled.outputText, mixed).tokens.includes("部署"));
  assert.ok(evaluate(compiled.outputText, mixed, 30_000).tokens.includes("部署"));
});

test("repeated CJK terms no longer accumulate duplicate intermediate collections", () => {
  const body = "甲".repeat(30_000);
  const expected = ["甲甲"];
  // Verify output without instrumentation before checking observer evidence.
  assert.deepEqual(evaluate(legacy, body, 30_000).tokens, expected);
  assert.deepEqual(evaluate(compiled.outputText, body, 30_000).tokens, expected);
  const before = evaluate(legacy, body, 30_000, true);
  const after = evaluate(compiled.outputText, body, 30_000, true);
  assert.deepEqual(before, { tokens: expected, maxPushReceiverLength: 29_999,
    arrayIterableLength: 29_999, arrayIterableCalls: 1, absentIterableCalls: 0, otherIterableCalls: 0 });
  assert.deepEqual(after, { tokens: expected, maxPushReceiverLength: 0,
    arrayIterableLength: 0, arrayIterableCalls: 0, absentIterableCalls: 1, otherIterableCalls: 0 });
  assert.deepEqual(evaluate(compiled.outputText, "甲乙 ALPHA").tokens, ["alpha", "甲乙"],
    "a fresh uninstrumented realm remains independent of the observer");
});
