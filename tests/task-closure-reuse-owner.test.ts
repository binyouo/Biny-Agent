/** Verify TaskClosure ownership across reuse awaits without importing product modules. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read source as data. Never import TaskClosure or its real verification/store dependencies.
const source = readFileSync(new URL("../src/runtime/TaskClosure.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function runTaskClosure(");
const end = source.indexOf("\n/**\n * 只批准当前 Attempt", start);
const helpers = source.indexOf("function cancelCurrentTask(");
assert.ok(start >= 0 && end > start && helpers > end, "audited source boundaries must still exist");
const extracted = (source.slice(start, end) + "\n" + source.slice(helpers))
  .replace("export async function runTaskClosure(", "async function runTaskClosure(");
assert.doesNotMatch(extracted, /\b(?:import|require)\s*(?:\(|["'{*])/,
  "source-only fixture must not gain a module dependency");
const compiled = ts.transpileModule(extracted, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true
});
assert.deepEqual(compiled.diagnostics?.filter((entry) => entry.category === ts.DiagnosticCategory.Error), []);

// Only the state used by the audited reuse path is represented here.
interface Evidence { status: string; marker: string }
interface Artifacts {
  output: string;
  definitionFingerprint: string;
  artifactFingerprint: string;
  repairScope: { enforcement: string; changedPaths: string[]; violationPaths: string[] };
}
interface Attempt { attemptId: string; taskRunId: string; status: string; verification: Evidence; artifacts: Artifacts }
interface Task { taskRunId: string; status: string; revision: number; task: string; attempts: Attempt[] }
interface TransitionInput { attemptId: string; verification: Evidence; artifacts: Artifacts }
interface Result { status: string; output?: string; evidence?: Evidence; reason?: string }
interface Calls {
  reuse: number; executor: number; executeAttempt: number; unexpected: string[];
  transitions: Array<{ id: string; status: string; input: TransitionInput }>;
  writes: Task[];
}
const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const terminal = (status: string) => ["completed", "failed", "incomplete", "blocked", "policy_denied", "budget_exhausted", "aborted", "cancelled"].includes(status);
const cases = [
  "unchanged", "cancelled", "replaced-running", "newer-completed", "same-completed",
  "conflicting-verification", "conflicting-artifacts", "blocked", "queued", "missing"
];

async function exercise(compiled: string, scenario: string) {
  const calls: Calls = { reuse: 0, executor: 0, executeAttempt: 0, unexpected: [], transitions: [], writes: [] };
  const unexpected = (name: string) => (..._args: unknown[]) => { calls.unexpected.push(name); throw new Error(`Unexpected dependency: ${name}`); };
  let release!: (value: boolean) => void;
  let entered!: () => void;
  const deferred = new Promise<boolean>((resolve) => { release = resolve; });
  const reachedReuse = new Promise<void>((resolve) => { entered = resolve; });
  const definition = { prompt: "inert fixture", verification: { objective: "inert", maxAttempts: 1, artifactPaths: [], allowedRepairPaths: [] } };
  const evidence = { status: "passed", marker: "original-evidence" };
  const artifacts: Artifacts = {
    output: "original-output", definitionFingerprint: "definition", artifactFingerprint: "artifact",
    repairScope: { enforcement: "post_execution_change_guard", changedPaths: [], violationPaths: [] }
  };
  let task: Task | undefined = { taskRunId: "task", status: "verifying", revision: 1, task: "fixture-definition", attempts: [
    { attemptId: "attempt-1", taskRunId: "task", status: "verifying", verification: evidence, artifacts }
  ] };
  const taskRuns = {
    get(id: string) { assert.equal(id, "task"); return clone(task); },
    latestEvent(id: string) { assert.equal(id, "task"); return undefined; },
    createAttempt: unexpected("createAttempt"),
    prepareVerificationRepair: unexpected("prepareVerificationRepair"),
    transition(id: string, status: string, input: TransitionInput) {
      assert.equal(id, "task");
      assert.equal(status, "completed", "only the audited completion operation is modeled");
      calls.transitions.push(clone({ id, status, input }));
      const current = task;
      if (!current) throw new Error("missing task");
      const latest = current.attempts.at(-1);
      if (!latest || latest.attemptId !== input.attemptId) throw new Error("stale attempt");
      if (current.status === "completed") {
        // Mirrors assertCompatibleTerminalEvidence for the only two fields supplied here.
        for (const key of ["verification", "artifacts"] as const) {
          if (latest[key] !== undefined && input[key] !== undefined
            && JSON.stringify(latest[key]) !== JSON.stringify(input[key])) {
            throw new Error(`Terminal TaskAttempt ${latest.attemptId} ${key} cannot be overwritten.`);
          }
        }
      } else if (current.status !== "running" && current.status !== "verifying") {
        throw new Error("fixture only models running/verifying to completed");
      }
      task = { ...current, status, revision: current.revision + 1, attempts: [
        ...current.attempts.slice(0, -1), { ...latest, ...clone(input), status }
      ] };
      calls.writes.push(clone(task));
      return clone(task);
    }
  };
  const fakes = {
    isTaskRunTerminal: terminal,
    readTaskDefinition(value: unknown) { assert.equal(value, "fixture-definition"); return definition; },
    canReuseTaskVerification(input: { evidence: Evidence; workspaceRoot: string }) {
      calls.reuse += 1;
      assert.equal(input.evidence.status, "passed");
      assert.equal(input.workspaceRoot, "inert://no-filesystem");
      entered();
      return deferred;
    },
    isTaskVerificationEvidence: (value: unknown) => typeof value === "object" && value !== null
      && "status" in value && ["passed", "failed", "blocked", "cancelled"].some((status) => status === value.status),
    isTaskVerificationApproval: unexpected("isTaskVerificationApproval"),
    readWorkerAttemptCheckpoint: unexpected("readWorkerAttemptCheckpoint"),
    planReviewResultSchema: { parse: unexpected("review.parse"), safeParse: unexpected("review.safeParse") },
    captureTaskWorkspaceSnapshot: unexpected("captureTaskWorkspaceSnapshot"),
    compareTaskWorkspaceSnapshots: unexpected("compareTaskWorkspaceSnapshots"),
    fingerprintTaskArtifacts: unexpected("fingerprintTaskArtifacts"),
    fingerprintTaskVerificationDefinitions: unexpected("fingerprintTaskVerificationDefinitions"),
    matchingTaskVerificationApproval: unexpected("matchingTaskVerificationApproval"),
    pendingTaskVerificationApproval: unexpected("pendingTaskVerificationApproval"),
    taskVerificationFingerprint: unexpected("taskVerificationFingerprint"),
    verifyTaskCandidate: unexpected("verifyTaskCandidate")
  };
  // No import hook, require, process, timers, console, filesystem, network, Worker,
  // or command capability is supplied to the audited product functions.
  type Input = {
    taskRuns: typeof taskRuns; taskRunId: string; workspaceRoot: string; ignore: string[];
    executor: () => never; executeAttempt: () => Promise<never>;
  };
  const runTaskClosure = runInNewContext(`${compiled}\nrunTaskClosure;`, fakes, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
  }) as (input: Input) => Promise<Result>;
  const pending = runTaskClosure({
    taskRuns, taskRunId: "task", workspaceRoot: "inert://no-filesystem", ignore: [],
    executor: () => { calls.executor += 1; throw new Error("executor must not run"); },
    executeAttempt: async () => { calls.executeAttempt += 1; throw new Error("worker must not run"); }
  });
  await reachedReuse;
  const current = task;
  assert.ok(current);
  const first = current.attempts[0];
  assert.ok(first);
  if (["cancelled", "blocked", "queued"].includes(scenario)) {
    task = { ...current, status: scenario, attempts: [{ ...first, status: scenario }] };
  } else if (scenario === "missing") {
    task = undefined;
  } else if (["replaced-running", "newer-completed"].includes(scenario)) {
    const status = scenario === "newer-completed" ? "completed" : "running";
    task = { ...current, status, attempts: [...current.attempts, {
      attemptId: "attempt-2", taskRunId: "task", status,
      artifacts: { ...artifacts, output: "newer-output" }, verification: { status: "passed", marker: "newer-evidence" }
    }] };
  } else if (["same-completed", "conflicting-verification", "conflicting-artifacts"].includes(scenario)) {
    const latest = { ...first, status: "completed" };
    if (scenario === "conflicting-verification") latest.verification = { status: "passed", marker: "different-evidence" };
    if (scenario === "conflicting-artifacts") latest.artifacts = { ...artifacts, output: "different-output" };
    task = { ...current, status: "completed", attempts: [latest] };
  }
  const beforeResolution = clone(task);
  release(true);
  let result: Result | undefined;
  let error: unknown;
  try { result = await pending; } catch (caught) { error = caught; }
  assert.equal(calls.reuse, 1);
  assert.equal(calls.executor, 0);
  assert.equal(calls.executeAttempt, 0);
  assert.deepEqual(calls.unexpected, []);
  return { result, error, calls, beforeResolution, afterResolution: clone(task) };
}

test("reused verification requires current ownership and compatible terminal evidence", async (t) => {
  for (const scenario of cases) {
    await t.test(scenario, async () => {
      const { result, error, calls, beforeResolution, afterResolution } = await exercise(compiled.outputText, scenario);
      if (scenario.startsWith("conflicting-")) {
        assert.equal(result, undefined, "conflicting terminal evidence must not produce completed");
        assert.match(String(error), /cannot be overwritten/);
        assert.equal(calls.transitions.length, 1);
        assert.equal(calls.writes.length, 0);
        assert.deepEqual(afterResolution, beforeResolution);
      } else if (scenario === "unchanged" || scenario === "same-completed") {
        assert.equal(error, undefined);
        assert.ok(result);
        assert.equal(result.status, "completed");
        assert.equal(result.output, "original-output");
        assert.equal(result.evidence?.marker, "original-evidence");
        assert.equal(afterResolution?.status, "completed");
        if (scenario === "unchanged") {
          assert.equal(calls.transitions.length, 1);
          assert.equal(calls.writes.length, 1);
        } else {
          assert.ok(beforeResolution);
          assert.ok(afterResolution);
          // Identical concurrent completion may be an idempotent no-op or append an event.
          const { revision: _beforeRevision, ...beforeState } = beforeResolution;
          const { revision: _afterRevision, ...afterState } = afterResolution;
          assert.deepEqual(afterState, beforeState);
          assert.deepEqual(result.evidence, beforeResolution.attempts.at(-1)?.verification);
          assert.equal(result.output, beforeResolution.attempts.at(-1)?.artifacts.output);
        }
      } else {
        assert.equal(error, undefined);
        assert.ok(result);
        assert.equal(result.status, "cancelled");
        assert.equal(result.output, undefined, "must not return stale output");
        assert.equal(result.evidence, undefined, "must not return stale evidence");
        assert.equal(calls.transitions.length, 0);
        assert.equal(calls.writes.length, 0);
        assert.deepEqual(afterResolution, beforeResolution);
      }
    });
  }
});
