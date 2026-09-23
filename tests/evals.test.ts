import assert from "node:assert/strict";
import { readFile, writeFile, unlink, symlink } from "node:fs/promises";
import path from "node:path";
import { compareReports, formatComparison, runEvalSuite, summarize } from "../src/evals/runner.js";
import { builtinEvalTasks } from "../src/evals/suite.js";
import type { EvalReport, EvalTask, EvalTaskResult } from "../src/evals/types.js";

async function main(): Promise<void> {
  await testRunsFixtureAndVerifies();
  await testFailureIsAttributedNotSwallowed();
  await testFixtureCannotEscapeWorkspace();
  testSummaryWithholdsCostWhenPricingIsIncomplete();
  testComparisonRejectsDifferentTasks();
  await testBuiltinVerifierRejectsTampering();
  testBuiltinTasksAreWellFormed();
  console.log("eval tests passed");
}

const passingTask: EvalTask = {
  id: "writes-file",
  prompt: "irrelevant for the fake runner",
  fixture: [{ path: "src/seed.txt", content: "seed\n" }],
  verify: "test -f done.txt && grep -q seed src/seed.txt"
};

async function testRunsFixtureAndVerifies(): Promise<void> {
  let seenFixture = "";
  const report = await runEvalSuite({
    suite: "test",
    label: "candidate",
    model: "fake",
    tasks: [passingTask],
    run: async (workspaceRoot) => {
      // fixture 必须在 agent 跑之前就位，否则任务从一开始就是错的。
      seenFixture = await readFile(path.join(workspaceRoot, "src/seed.txt"), "utf8");
      await (await import("node:fs/promises")).writeFile(path.join(workspaceRoot, "done.txt"), "ok");
      return { steps: 4, totalTokens: 100, costUsd: 0.01, pricingKnown: true };
    }
  });
  assert.equal(seenFixture, "seed\n");
  assert.equal(report.results[0]?.passed, true);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.passRate, 1);
  assert.equal(report.summary.totalCostUsd, 0.01);
}

/** 崩溃和"做错了"必须能区分，否则真正的回归会被混进噪声里。 */
async function testFailureIsAttributedNotSwallowed(): Promise<void> {
  const report = await runEvalSuite({
    suite: "test",
    label: "baseline",
    model: "fake",
    tasks: [
      passingTask,
      { ...passingTask, id: "verification-fails" },
      { ...passingTask, id: "runner-throws" }
    ],
    run: async (workspaceRoot, task) => {
      if (task.id === "runner-throws") throw new Error("provider exploded");
      if (task.id === "verification-fails") return { steps: 1, pricingKnown: false };
      await (await import("node:fs/promises")).writeFile(path.join(workspaceRoot, "done.txt"), "ok");
      return { steps: 2, pricingKnown: false };
    }
  });
  const byId = new Map(report.results.map((result) => [result.taskId, result]));
  assert.equal(byId.get("writes-file")?.passed, true);
  assert.equal(byId.get("verification-fails")?.passed, false);
  assert.equal(/Verification failed/.test(byId.get("verification-fails")?.failure ?? ""), true);
  assert.equal(byId.get("runner-throws")?.passed, false);
  assert.equal(byId.get("runner-throws")?.failure, "provider exploded");
  assert.equal(report.summary.passRate, 1 / 3);
}

/** fixture 来自评测定义，但写到工作区外会污染跑评测的机器且极难排查。 */
async function testFixtureCannotEscapeWorkspace(): Promise<void> {
  const report = await runEvalSuite({
    suite: "test",
    label: "escape",
    model: "fake",
    tasks: [{ ...passingTask, id: "escaping", fixture: [{ path: "../escaped.txt", content: "x" }] }],
    run: async () => ({ steps: 0, pricingKnown: false })
  });
  assert.equal(report.results[0]?.passed, false);
  assert.equal(/escapes the eval workspace/.test(report.results[0]?.failure ?? ""), true);
}

/** 任一任务缺价格就不报总成本：偏低的假数字比没有数字更容易误导决策。 */
function testSummaryWithholdsCostWhenPricingIsIncomplete(): void {
  const results: EvalTaskResult[] = [
    { taskId: "a", passed: true, durationMs: 10, metrics: { steps: 1, totalTokens: 10, costUsd: 0.5, pricingKnown: true } },
    { taskId: "b", passed: false, durationMs: 10, metrics: { steps: 2, totalTokens: 20, pricingKnown: false } }
  ];
  const summary = summarize(results);
  assert.equal(summary.pricingKnown, false);
  assert.equal(summary.totalCostUsd, undefined);
  assert.equal(summary.totalTokens, 30, "token totals stay available even when pricing does not");
  assert.equal(summary.totalSteps, 3);
}

/** 总指标只允许在相同任务集上比较，增删任务必须明确拒绝。 */
function testComparisonRejectsDifferentTasks(): void {
  const baseline = report("baseline", [
    { id: "shared-regressed", passed: true },
    { id: "shared-improved", passed: false },
    { id: "only-in-baseline", passed: true }
  ]);
  const candidate = report("candidate", [
    { id: "shared-regressed", passed: false },
    { id: "shared-improved", passed: true },
    { id: "only-in-candidate", passed: true }
  ]);
  assert.throws(() => compareReports(baseline, candidate), /task sets differ/i);
  const matchingCandidate = report("candidate", [
    { id: "shared-regressed", passed: false },
    { id: "shared-improved", passed: true },
    { id: "only-in-baseline", passed: true }
  ]);
  const comparison = compareReports(baseline, matchingCandidate);
  assert.deepEqual(comparison.newlyPassing, ["shared-improved"]);
  assert.deepEqual(comparison.newlyFailing, ["shared-regressed"]);
  const text = formatComparison(comparison);
  assert.equal(text.includes("newly failing: shared-regressed"), true);
  assert.throws(() => compareReports(baseline, { ...matchingCandidate, suite: "other" }), /suite/i);
  assert.throws(() => compareReports(baseline, report("duplicate", [
    { id: "shared-regressed", passed: true }, { id: "shared-regressed", passed: true }
  ])), /duplicate/i);
  const falsifiedSummary = { ...matchingCandidate, summary: { ...matchingCandidate.summary, passRate: 1 } };
  assert.equal(compareReports(baseline, falsifiedSummary).passRateDelta, 0);
}

async function testBuiltinVerifierRejectsTampering(): Promise<void> {
  for (const mode of ["broken", "test-overwritten", "test-deleted", "test-symlink", "test-mutated-during-verification", "fixed"] as const) {
    const result = await runEvalSuite({
      suite: "test", label: mode, model: "fake", tasks: [builtinEvalTasks[0]!],
      run: async (root) => {
        if (mode === "test-overwritten") await writeFile(path.join(root, "test.js"), "process.exit(0);\n");
        if (mode === "test-deleted" || mode === "test-symlink") await unlink(path.join(root, "test.js"));
        if (mode === "test-symlink") {
          await writeFile(path.join(root, "fake.js"), "process.exit(0);\n");
          await symlink("fake.js", path.join(root, "test.js"));
        }
        if (mode === "fixed") await writeFile(path.join(root, "sum.js"), "export function sum(values) { return values.reduce((a, b) => a + b, 0); }\n");
        if (mode === "test-mutated-during-verification") await writeFile(path.join(root, "sum.js"), 'import { writeFileSync } from "node:fs"; writeFileSync("test.js", "process.exit(0)"); export function sum(values) { return values.reduce((a, b) => a + b, 0); }\n');
        return { steps: 1, pricingKnown: false };
      }
    });
    assert.equal(result.results[0]?.passed, mode === "fixed", mode);
    assert.equal(result.results[0]?.metrics.steps, 1, "验收失败仍需保留已经消耗的运行指标");
    if (mode.startsWith("test-")) assert.match(result.results[0]?.failure ?? "", /protected fixture/i);
  }
}

function testBuiltinTasksAreWellFormed(): void {
  const ids = new Set<string>();
  for (const task of builtinEvalTasks) {
    assert.equal(ids.has(task.id), false, `duplicate eval task id: ${task.id}`);
    ids.add(task.id);
    assert.equal(task.verify.trim().length > 0, true, `${task.id} needs an executable verification`);
    assert.equal(task.fixture.length > 0, true, `${task.id} needs a fixture`);
    for (const file of task.fixture) {
      assert.equal(file.path.startsWith("/"), false, `${task.id} fixture must use relative paths`);
      assert.equal(file.path.includes(".."), false, `${task.id} fixture must not traverse upward`);
    }
  }
}

function report(label: string, tasks: Array<{ id: string; passed: boolean }>): EvalReport {
  const results: EvalTaskResult[] = tasks.map((task) => ({
    taskId: task.id,
    passed: task.passed,
    durationMs: 100,
    metrics: { steps: 1, totalTokens: 10, costUsd: 0.1, pricingKnown: true }
  }));
  return { suite: "test", label, startedAt: "2026-01-01T00:00:00.000Z", model: "fake", results, summary: summarize(results) };
}

await main();
