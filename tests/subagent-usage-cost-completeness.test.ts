import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read source, but execute only the complete pure aggregation/accounting functions.
// No Worker, AgentSession, provider, Host, persistence or budget guard is imported.
const root = new URL("../", import.meta.url);
function functions(file: string, names: string[]): string {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name && names.includes(node.name.text));
  assert.deepEqual(selected.map(node => node.name!.text).sort(), [...names].sort(), file);
  return selected.map(node => node.getText(source).replace(/^export /u, "")).join("\n");
}
const code = [
  functions("src/extensions/subagent.ts", ["sumNativeUsage", "sumUsageField"]),
  functions("src/session/metadata.ts", ["usageSnapshot", "readReportedCacheUsage", "reportedCacheTokenValue", "readReportedCacheRates"]),
  functions("src/observability/usage.ts", [
    "createSessionUsage", "calculateUsageCost", "calculateCacheHitRate", "summarizeUsage",
    "foldReportedCacheCounts", "projectedCacheRate", "weightedProjectedCacheRate", "sumReportedCacheUsage",
    "summarizeReportedCacheUsage", "formatReportedCacheCount", "formatUsageSummary", "sumSessionUsage", "sumDefined"
  ]),
  "({sumNativeUsage, createSessionUsage, summarizeUsage, formatUsageSummary})"
].join("\n");
interface Counts {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
}
interface RecordUsage extends Counts { pricingKnown: boolean; costUsd?: number }
interface Summary extends RecordUsage { calls: number }
interface Identity {
  modelAlias: string; provider: string; model: string;
  pricing: { inputPerMillionTokens: number; outputPerMillionTokens: number; cacheReadPerMillionTokens: number; cacheWritePerMillionTokens: number };
}
const accounting = runInNewContext(stripTypeScriptTypes(code, { mode: "strip" }), {}, {
  timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
}) as {
  sumNativeUsage(usages: readonly Counts[]): Counts;
  createSessionUsage(usage: Counts, operation: "subagent", identity: Identity): RecordUsage;
  summarizeUsage(records: RecordUsage[]): Summary;
  formatUsageSummary(summary: Summary): string;
};
const identity: Identity = {
  modelAlias: "synthetic", provider: "synthetic", model: "synthetic",
  pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2, cacheReadPerMillionTokens: 0.5, cacheWritePerMillionTokens: 1.5 }
};
const full: Counts = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0 };
const zero: Counts = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const summary = (usages: Counts[]) => accounting.summarizeUsage([
  accounting.createSessionUsage(accounting.sumNativeUsage(usages), "subagent", identity)
]);
function knownCost(usages: Counts[], expected: number): Summary {
  const result = summary(usages);
  assert.equal(result.pricingKnown, true);
  assert.ok(result.costUsd !== undefined && Math.abs(result.costUsd - expected) < 1e-15);
  return result;
}

for (const field of ["inputTokens", "outputTokens"] as const) {
  for (const position of [0, 1, 2]) {
    test(`missing ${field} at position ${position} keeps aggregate cost unknown`, () => {
      const partial = { ...full };
      delete partial[field];
      delete partial.totalTokens;
      const usages = [full, zero];
      usages.splice(position, 0, partial);
      const aggregate = accounting.sumNativeUsage(usages);
      assert.equal(aggregate[field], undefined);
      // This change does not redefine the existing partial total-token display.
      assert.equal(aggregate.totalTokens, 110);
      const result = summary(usages);
      assert.equal(result.pricingKnown, false);
      assert.equal(result.costUsd, undefined);
      assert.match(accounting.formatUsageSummary(result), /Cost: unknown/u);
      const persisted: Counts = JSON.parse(JSON.stringify(aggregate));
      assert.equal(accounting.createSessionUsage(persisted, "subagent", identity).pricingKnown, false);
    });
  }
}
test("both totals missing beside a complete request remain unknown", () => {
  assert.equal(summary([full, {}]).pricingKnown, false);
});
test("empty aggregation invents no totals", () => {
  assert.equal(accounting.sumNativeUsage([]).inputTokens, undefined);
  assert.equal(summary([]).pricingKnown, false);
});
test("a single empty usage remains unknown", () => {
  assert.equal(summary([{}]).pricingKnown, false);
});
test("a single partial usage remains unknown", () => {
  assert.equal(summary([{ outputTokens: 20 }]).pricingKnown, false);
});
test("all partial requests remain unknown", () => {
  assert.equal(summary([{ outputTokens: 10 }, { outputTokens: 20 }]).pricingKnown, false);
});
test("complementary missing totals cannot manufacture complete usage", () => {
  assert.equal(summary([{ inputTokens: 100 }, { outputTokens: 20 }]).pricingKnown, false);
});
test("three complete requests retain their measured totals and cost", () => {
  assert.equal(knownCost([full, full, full], 0.00036).totalTokens, 330);
});
test("explicit zero totals remain complete and priced", () => {
  knownCost([zero, zero], 0);
});
test("explicit zeros beside a complete request preserve its cost", () => {
  knownCost([full, zero], 0.00012);
});
test("the existing partial total-token field does not affect complete input/output pricing", () => {
  const usages = [full, { inputTokens: 100, outputTokens: 10 }];
  knownCost(usages, 0.00024);
  assert.equal(accounting.sumNativeUsage(usages).totalTokens, 110);
});
test("optional cache and reasoning aggregation retain their existing semantics", () => {
  const result = accounting.sumNativeUsage([
    { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30, reasoningTokens: 3 },
    { inputTokens: 100, outputTokens: 10 }
  ]);
  assert.equal(result.cacheReadTokens, 30);
  assert.equal(result.reasoningTokens, 3);
  assert.equal(result.cacheWriteTokens, undefined);
});
test("complete cache categories retain their configured pricing", () => {
  knownCost([{ inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 20 }, zero], 0.00011);
});
test("nested aggregation cannot recover a missing total from another complete request", () => {
  assert.equal(summary([accounting.sumNativeUsage([full, { outputTokens: 20 }]), full]).pricingKnown, false);
});
