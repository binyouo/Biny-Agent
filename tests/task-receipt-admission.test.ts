/** Real closure/store/communication/SQLite and command verification; Runtime admission is extracted, not a full Host launch. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore, type TaskRunWithAttempts } from "../src/runtime/TaskRunStore.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { runTaskClosure, type TaskClosureResult } from "../src/runtime/TaskClosure.js";
import { evaluateTaskRetry } from "../src/runtime/TaskRetryPolicy.js";
import { isTaskVerificationEvidence, taskCheckToolCallId, type TaskCommandExecutor, type TaskVerificationContract } from "../src/runtime/taskVerification.js";

const source = await readFile(new URL("../src/runtime/CommandRuntime.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("CommandRuntime.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const nodes: ts.Node[] = []; const visit = (node: ts.Node): void => { nodes.push(node); ts.forEachChild(node, visit); }; visit(ast);
const helper = nodes.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "hasSafeQueuedTaskContinuation");
const resume = nodes.filter(ts.isBinaryExpression).filter(node => ts.isIdentifier(node.left) && node.left.text === "resumeTaskRun" && ts.isArrowFunction(node.right));
const dispatch = nodes.filter(ts.isIfStatement).filter(node => node.expression.getText(ast).includes('current.status === "queued"') && node.expression.getText(ast).includes("hasSafeQueuedTaskContinuation"));
assert.equal(helper.length, 1); assert.equal(resume.length, 1); assert.equal(dispatch.length, 1);
function admission(tasks: DurableTaskRunStore, start: (id: string) => Promise<{ task: TaskRunWithAttempts; completion: Promise<TaskClosureResult> }>) {
  const code = `${helper[0]!.getText(ast)}\nconst closing = false; const taskRuns = tasks; const durableTaskPromises = new Map(); const workerResumeAdmissions = new Map(); const config = { extensions: { subagent: { enabled: false } } }; const assertTaskOwner = task => { if (task.sessionId !== "parent") throw new Error("foreign task"); }; const startTaskRun = start; return (${resume[0]!.right.getText(ast)});`;
  return new Function("tasks", "start", "evaluateTaskRetry", "isTaskVerificationEvidence", ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(tasks, start, evaluateTaskRetry, isTaskVerificationEvidence) as (id: string) => ReturnType<typeof start>;
}
function dispatchGuard(tasks: DurableTaskRunStore): TaskRunWithAttempts {
  const code = `${helper[0]!.getText(ast)}\nconst taskRunId = "task"; const taskRuns = tasks; let current = tasks.get(taskRunId); ${dispatch[0]!.getText(ast)} return {task: current};`;
  const result = new Function("tasks", "evaluateTaskRetry", "isTaskVerificationEvidence", ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(tasks, evaluateTaskRetry, isTaskVerificationEvidence) as { task: TaskRunWithAttempts };
  return result.task;
}
async function fixture(kind: "repair" | "retry", run: (f: { workspace: string; tasks: DurableTaskRunStore; channel: TaskCommunication; executor: TaskCommandExecutor; checks: number; reopen(): Promise<void> }) => Promise<void>, reports = 1) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-task-receipt-")); const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let authority: RuntimeEventAuthority | undefined; let tasks: DurableTaskRunStore | undefined; let channel: TaskCommunication | undefined; let checks = 0;
  const open = async () => { authority = await RuntimeEventAuthority.open(workspace, { reconcileSessions: false }); tasks = await DurableTaskRunStore.open(workspace, authority); channel = new TaskCommunication(tasks, "parent"); };
  const close = () => { channel?.close(); tasks?.close(); authority?.close(); };
  const executor: TaskCommandExecutor = { executeTaskCheck: async input => {
    checks++; const result = await new Promise<{ status: "completed"; exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [path.join(workspace, "check.cjs")], { cwd: workspace }, (error, stdout, stderr) => { if (error && typeof error.code !== "number") { reject(error); return; } resolve({ status: "completed", exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr }); });
    });
    return { result, toolCallId: taskCheckToolCallId(input), resultEventId: `check-${checks}`, eventReferences: [`check-${checks}`] };
  } };
  try {
    await writeFile(path.join(workspace, "artifact.txt"), "broken"); await writeFile(path.join(workspace, "check.cjs"), 'const fs=require("node:fs"); const ok=fs.readFileSync("artifact.txt","utf8")==="fixed"; if(!ok) console.error("repair-witness"); process.exit(ok?0:7);\n');
    const contract: TaskVerificationContract = { version: 1, objective: "repair artifact", checks: [{ id: "check", command: "node check.cjs", definitionPaths: ["check.cjs"] }], artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 2 };
    await open(); tasks!.create({ taskRunId: "task", sessionId: "parent", task: { prompt: "prepare artifact", communication: true, ...(kind === "repair" ? { verification: contract } : {}) } }); tasks!.transition("task", "queued");
    if (kind === "repair") {
      const prepare = tasks!.prepareVerificationRepair.bind(tasks!); const stop = new Error("injected stop after durable repair admission");
      tasks!.prepareVerificationRepair = (...args) => { prepare(...args); throw stop; };
      try { await assert.rejects(runTaskClosure({ taskRuns: tasks!, taskRunId: "task", workspaceRoot: workspace, ignore: [], executor, executeAttempt: async (_prompt, attempt) => { for (let i = 0; i < reports; i++) channel!.worker("task", attempt.attemptId).report(`candidate report ${i}`, `report-${i}`); return "candidate output"; } }), error => error === stop); }
      finally { tasks!.prepareVerificationRepair = prepare; }
    } else {
      const attempt = tasks!.createAttempt("task", { retrySafety: "safe" }); tasks!.transition("task", "running", { attemptId: attempt.attemptId }); for (let i = 0; i < reports; i++) channel!.worker("task", attempt.attemptId).report(`candidate report ${i}`, `report-${i}`); tasks!.transition("task", "failed", { attemptId: attempt.attemptId, failure: { failureClass: "RateLimit", message: "retryable rate limit" } }); assert.equal(evaluateTaskRetry(tasks!.get("task")).allowed, true); tasks!.retry("task");
    }
    assert.equal(tasks!.get("task")!.status, "queued"); assert.equal(tasks!.get("task")!.attempts.at(-1)!.status, "failed");
    await run({ workspace, get tasks() { return tasks!; }, get channel() { return channel!; }, executor, get checks() { return checks; }, async reopen() { close(); await open(); } });
  } finally { close(); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}
type Fixture = Parameters<Parameters<typeof fixture>[1]>[0];
function acknowledge(f: Fixture) { let count = 0; for (;;) { const notices = f.channel.notifications(); if (!notices.length) break; for (const notice of notices) { f.channel.acknowledge(notice); count++; } } assert.ok(count > 0); assert.equal(f.tasks.latestEvent("task")!.eventType, "task.message.received"); return count; }
for (const kind of ["repair", "retry"] as const) {
  for (const receipt of [false, true]) {
    test(`${kind} admission survives ${receipt ? "acknowledged" : "pending"} report and SQLite reopen`, async () => {
      await fixture(kind, async f => {
        const before = f.tasks.get("task")!; if (receipt) acknowledge(f);
        assert.deepEqual(f.tasks.get("task")!.attempts, before.attempts); await f.reopen();
        const dispatched = dispatchGuard(f.tasks); assert.equal(dispatched.status, "queued");
        let starts = 0; let workers = 0; let prompt = "";
        const resume = admission(f.tasks, async id => { starts++; const completion = runTaskClosure({ taskRuns: f.tasks, taskRunId: id, workspaceRoot: f.workspace, ignore: [], executor: f.executor, executeAttempt: async text => { workers++; prompt = text; await writeFile(path.join(f.workspace, "artifact.txt"), "fixed"); return "repaired output"; } }); return { task: f.tasks.get(id)!, completion }; });
        const result = await resume("task"); assert.equal((await result.completion).status, "completed"); assert.equal(starts, 1); assert.equal(workers, 1);
        if (kind === "repair") { assert.match(prompt, /定向修复 Attempt/u); assert.match(prompt, /repair-witness/u); assert.match(prompt, /剩余 Attempt 预算：1/u); assert.equal(f.checks, 2); }
        else { assert.equal(prompt, "prepare artifact"); assert.equal(f.checks, 0); }
        assert.equal(f.tasks.get("task")!.attempts.length, 2); await f.reopen(); assert.equal(f.tasks.get("task")!.status, "completed"); assert.deepEqual(f.tasks.get("task")!.attempts[0], before.attempts[0]);
      });
    });
  }
  test(`${kind} original resume entry accepts acknowledgement without dispatch-helper intervention`, async () => {
    await fixture(kind, async f => { acknowledge(f); await f.reopen(); let starts = 0; const resume = admission(f.tasks, async id => { starts++; return { task: f.tasks.get(id)!, completion: Promise.resolve({ status: "completed" }) }; }); await resume("task"); assert.equal(starts, 1); assert.equal(f.tasks.get("task")!.status, "queued"); });
  });
}
test("direct closure recovery keeps failed-check repair instructions after acknowledgement", async () => {
  await fixture("repair", async f => { acknowledge(f); await f.reopen(); let prompt = ""; const result = await runTaskClosure({ taskRuns: f.tasks, taskRunId: "task", workspaceRoot: f.workspace, ignore: [], executor: f.executor, executeAttempt: async text => { prompt = text; await writeFile(path.join(f.workspace, "artifact.txt"), "fixed"); return "repaired output"; } }); assert.equal(result.status, "completed"); assert.match(prompt, /repair-witness/u); assert.match(prompt, /定向修复 Attempt/u); assert.equal(f.checks, 2); });
});

for (const kind of ["repair", "retry"] as const) {
  test(`${kind} admission is found beyond a page of real message receipts`, async () => {
    await fixture(kind, async f => {
      assert.equal(acknowledge(f), 120); await f.reopen();
      assert.equal(f.tasks.events("task").length, 100); assert.equal(f.tasks.latestEvent("task")!.eventType, "task.message.received");
      assert.equal(dispatchGuard(f.tasks).status, "queued");
      let starts = 0; await admission(f.tasks, async id => { starts++; return { task: f.tasks.get(id)!, completion: Promise.resolve({ status: "completed" }) }; })("task"); assert.equal(starts, 1);
      assert.equal(f.channel.notifications().length, 0);
    }, 120);
  });
  for (const change of ["cancel", "new attempt", "evidence update"] as const) {
    test(`${kind} receipts never hide a later ${change} boundary`, async () => {
      await fixture(kind, async f => {
        acknowledge(f);
        if (change === "cancel") f.tasks.transition("task", "cancelled");
        else if (change === "new attempt") f.tasks.createAttempt("task");
        else f.tasks.transition("task", "queued", { artifacts: { ...(f.tasks.get("task")!.attempts.at(-1)!.artifacts as Record<string, unknown>), sentinel: "changed" } });
        await f.reopen(); const before = f.tasks.get("task"); let starts = 0;
        await assert.rejects(admission(f.tasks, async id => { starts++; return { task: f.tasks.get(id)!, completion: Promise.resolve({ status: "completed" }) }; })("task"), /requires a live Worker/u);
        assert.equal(starts, 0); assert.deepEqual(f.tasks.get("task"), before);
      });
    });
  }
}
