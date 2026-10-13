import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Parse source as text. Execute only the actual pure summary declaration;
// never import the runtime, SDK, prompt cache constructors, or filesystem sinks.
const root = process.env.BINY_REQUEST_SUMMARY_SOURCE_ROOT ?? process.cwd();
const summaryPath = process.env.BINY_REQUEST_SUMMARY_SOURCE ?? path.join(root, "src/observability/modelRequests.ts");
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
function types(source: ts.SourceFile, names: readonly string[]): string[] {
  return names.map(name => one(source.statements.filter((node): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === name), name)
    .getText(source).replace(/^export /u, ""));
}
const source = parse(summaryPath);
const summary = one(source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "summarizeModelRequests"), "actual summary function");
const guard = (node: ts.Node): void => {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && !ts.isNewExpression(node) && !ts.isAwaitExpression(node) && !ts.isTaggedTemplateExpression(node), "no external execution boundary");
  if (ts.isCallExpression(node)) assert.equal(node.expression.getText(source), "Math.max", "only numeric Math.max calls are allowed");
  ts.forEachChild(node, guard);
};
guard(summary);
const core = parse(path.join(root, "src/agent/core/types.ts"));
const prompt = parse(path.join(root, "src/llm/promptCache.ts"));
const declarations = [
  ...types(prompt, ["PromptPrefixChangeReason", "PromptEpochReason", "PromptEpoch", "PromptRequestShapeChangeReason", "PromptShapeStatus", "PromptShapeDiagnostic"]),
  ...types(core, ["AgentStopReason", "AgentUsage", "ModelRequestOperation", "ModelRequestErrorCode", "ModelRequestErrorPhase", "ModelRequestContext", "ModelRequestAttempt", "ModelRequestMetrics"]),
  ...types(source, ["ModelRequestSummary"]),
  summary.getText(source).replace(/^export /u, "")
].join("\n");
const compiled = ts.transpileModule(`${declarations}\nsummarizeModelRequests;`, {
  reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

// This small fixture-facing shape is only a test convenience. The complete actual
// production types above are extracted too, and checked separately by the reviewed
// local static runner. CI also typechecks the complete production module normally.
type Reason = "stop" | "length" | "tool-calls" | "error" | "aborted" | "other";
interface Metric {
  requestId: string; provider: string; modelId: string; startedAt: string; durationMs: number;
  attempts: Array<{ attempt: number; durationMs: number; willRetry: boolean }>;
  eventCount: number; finishReason?: Reason; error?: string;
  timeToFirstEventMs?: number; timeToFirstOutputMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}
interface Summary {
  calls: number; succeeded: number; failed: number; totalAttempts: number; retries: number; totalDurationMs: number;
  averageDurationMs?: number; averageTimeToFirstEventMs?: number; averageTimeToFirstOutputMs?: number;
}
const summarize = runInNewContext(compiled.outputText, {}, { timeout: 1_000,
  contextCodeGeneration: { strings: false, wasm: false } }) as (records: readonly Metric[]) => Summary;
const metric = (overrides: Partial<Metric> = {}): Metric => ({
  requestId: "request", provider: "fixture", modelId: "fixture", startedAt: "2026-10-13T00:00:00.000Z",
  durationMs: 100, attempts: [{ attempt: 1, durationMs: 100, willRetry: false }], eventCount: 1,
  finishReason: "stop", ...overrides
});
const plain = (value: Summary): Summary => ({ ...value });
const empty: Summary = { calls: 0, succeeded: 0, failed: 0, totalAttempts: 0, retries: 0, totalDurationMs: 0,
  averageDurationMs: undefined, averageTimeToFirstEventMs: undefined, averageTimeToFirstOutputMs: undefined };

test("empty request summary retains unknown averages", () => {
  assert.deepEqual(plain(summarize([])), empty);
});

test("a normal SDK error finish without an error field counts as failure", () => {
  const record = metric({ finishReason: "error" });
  assert.equal(record.error, undefined);
  assert.deepEqual(plain(summarize([record])), { ...empty, calls: 1, failed: 1, totalAttempts: 1,
    totalDurationMs: 100, averageDurationMs: 100 });
});

test("existing diagnostic errors retain presence semantics including empty text", () => {
  for (const error of ["provider failed", ""]) {
    const result = summarize([metric({ error, finishReason: "stop" })]);
    assert.equal(result.failed, 1);
    assert.equal(result.succeeded, 0);
  }
});

test("error field plus error finish count only once", () => {
  const result = summarize([metric({ error: "failed", finishReason: "error" })]);
  assert.equal(result.calls, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.succeeded, 0);
});

test("all other finish reasons and absent reason retain the existing contract", () => {
  for (const finishReason of ["stop", "length", "tool-calls", "aborted", "other", undefined] as const) {
    const result = summarize([metric({ finishReason })]);
    assert.equal(result.failed, 0, String(finishReason));
    assert.equal(result.succeeded, 1, String(finishReason));
  }
});

test("mixed failures change classification only, preserving timing and retry arithmetic", () => {
  const result = summarize([
    metric({ durationMs: 100, timeToFirstEventMs: 10, timeToFirstOutputMs: 20 }),
    metric({ finishReason: "error", durationMs: 300, timeToFirstOutputMs: 40,
      attempts: [{ attempt: 1, durationMs: 20, willRetry: true }, { attempt: 2, durationMs: 280, willRetry: false }] }),
    metric({ error: "transport failed", finishReason: undefined, durationMs: -5, timeToFirstEventMs: -2, attempts: [] }),
    metric({ finishReason: "length", durationMs: 200, timeToFirstEventMs: 50 })
  ]);
  assert.deepEqual(plain(result), { calls: 4, succeeded: 2, failed: 2, totalAttempts: 4, retries: 1,
    totalDurationMs: 600, averageDurationMs: 150, averageTimeToFirstEventMs: 20, averageTimeToFirstOutputMs: 30 });
});

test("zero durations and no attempts do not create retries or invented latency", () => {
  assert.deepEqual(plain(summarize([metric({ durationMs: 0, attempts: [], timeToFirstOutputMs: 0 })])), {
    ...empty, calls: 1, succeeded: 1, averageDurationMs: 0, averageTimeToFirstOutputMs: 0
  });
});

test("classification does not mutate records, attempts or reported usage", () => {
  const record = metric({ finishReason: "error", usage: { inputTokens: 100, outputTokens: 2, totalTokens: 102 } });
  const before = JSON.stringify(record);
  const attempts = record.attempts;
  const usage = record.usage;
  attempts.forEach(Object.freeze); Object.freeze(attempts); Object.freeze(usage); Object.freeze(record);
  const records = Object.freeze([record]);
  summarize(records);
  assert.equal(JSON.stringify(record), before);
  assert.equal(record.attempts, attempts);
  assert.equal(record.usage, usage);
  assert.equal(record.error, undefined, "summary must not invent an error diagnostic");
});
