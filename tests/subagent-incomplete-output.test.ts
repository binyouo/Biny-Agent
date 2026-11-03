/** Actual manager/store/communication; isolates only CommandRuntime's original snapshot callback. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { SubagentTaskManager, SubagentTaskIncompleteError, type SubagentTaskSnapshot } from "../src/runtime/SubagentTaskManager.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";

async function snapshotCallback(tasks: DurableTaskRunStore, communication: TaskCommunication, binding?: { taskRunId: string; attemptId: string }) {
  const text = await readFile(new URL("../src/runtime/CommandRuntime.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("CommandRuntime.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node): void => { if (ts.isPropertyAssignment(node) && node.name.getText(source) === "onSnapshot" && node.initializer.getText(source).includes("taskRuns.syncSubagentSnapshot")) matches.push(node); ts.forEachChild(node, visit); };
  visit(source); assert.equal(matches.length, 1);
  const compiled = ts.transpileModule(`const handler = ${matches[0]!.initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function("taskRuns", "taskCommunication", "workerGoalBindings", "durableSubagentBindings", "sessionGoals", "agent", "recorder", `${compiled}; return handler;`)(
    tasks, communication, new Map(), binding ? new Map([["worker", binding]]) : new Map(), { get: () => undefined }, undefined, { sessionId: "parent" }
  ) as (snapshot: SubagentTaskSnapshot, output?: string) => void;
}

async function fixture(output: string, bound: boolean, mode: "incomplete" | "completed" | "failed" | "aborted", run: (f: {
  tasks: DurableTaskRunStore; communication: TaskCommunication; taskId: string; checkpoint: unknown; error: unknown;
  reopen(): Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-incomplete-output-")); const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let authority: RuntimeEventAuthority | undefined; let tasks: DurableTaskRunStore | undefined; let communication: TaskCommunication | undefined; let manager: SubagentTaskManager | undefined;
  const open = async () => { authority = await RuntimeEventAuthority.open(workspace, { reconcileSessions: false }); tasks = await DurableTaskRunStore.open(workspace, authority); communication = new TaskCommunication(tasks, "parent"); };
  const close = () => { communication?.close(); tasks?.close(); authority?.close(); };
  try {
    await open(); const taskId = bound ? "task" : "worker"; let binding;
    if (bound) { tasks!.create({ taskRunId: taskId, sessionId: "parent", task: { prompt: "research", communication: true } }); const attempt = tasks!.createAttempt(taskId); tasks!.transition(taskId, "queued"); binding = { taskRunId: taskId, attemptId: attempt.attemptId }; }
    const onSnapshot = await snapshotCallback(tasks!, communication!, binding);
    const checkpoint = { prompt: "research", workspaceRoot: workspace, communication: true };
    manager = new SubagentTaskManager({ maxConcurrentSubagents: 1, onSnapshot,
      persistCompletion: (snapshot, value) => { tasks!.syncSubagentSnapshot(snapshot, binding ?? { sessionId: "parent" }, value); },
      execute: async (_task, { signal }) => {
        const attempt = tasks!.get(taskId)!.attempts.at(-1)!;
        tasks!.transition(taskId, "running", { attemptId: attempt.attemptId, artifacts: { workerExecution: checkpoint, extension: { retained: true } } });
        communication!.worker(taskId, attempt.attemptId).report("Earlier progress", "report");
        if (mode === "aborted") {
          const cancelled = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
          queueMicrotask(() => manager!.cancelTask("worker", "fixture cancellation"));
          await cancelled; throw new SubagentTaskIncompleteError("max_steps", "late partial output");
        }
        if (mode === "incomplete") throw new SubagentTaskIncompleteError("max_steps", output);
        if (mode === "failed") throw new Error("execution failed");
        return output;
      }
    });
    const observed: SubagentTaskSnapshot[] = []; manager.subscribe(snapshot => observed.push(snapshot));
    let error: unknown; try { await manager.submit("research", { taskId: "worker" }).completion; } catch (value) { error = value; }
    await manager.close();
    for (const snapshot of [manager.getSnapshot("worker")!, ...manager.listSnapshots(), ...observed]) { assert.equal("output" in snapshot, false); assert.ok((snapshot.error?.length ?? 0) <= 2000); }
    await run({ get tasks() { return tasks!; }, get communication() { return communication!; }, taskId, checkpoint, error, async reopen() { close(); await open(); } });
  } finally { await manager?.close(); close(); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

for (const bound of [true, false]) {
  for (const output of ["short partial response", `${"partial detail ".repeat(300)}TAIL-MARKER`, `${"partial detail ".repeat(1200)}TAIL-MARKER`, ""]) {
    test(`${bound ? "bound" : "unbound"} incomplete output (${output.length}) persists before terminal projection`, async () => {
      await fixture(output, bound, "incomplete", async f => {
        assert.ok(f.error instanceof SubagentTaskIncompleteError);
        const check = async () => {
          const task = f.tasks.get(f.taskId)!; assert.equal(task.status, "incomplete"); assert.equal(task.attempts.length, 1);
          const artifacts = task.attempts.at(-1)!.artifacts as Record<string, unknown>;
          assert.equal(artifacts.output, output); assert.deepEqual(artifacts.workerExecution, f.checkpoint); assert.deepEqual(artifacts.extension, { retained: true });
          const inspection = await f.communication.inspect(f.taskId); assert.equal(inspection.output, output.slice(0, 16_000)); assert.equal(inspection.outputTruncated, output.length > 16_000); assert.equal(inspection.stopReason, "max_steps"); assert.equal(inspection.messages.length, 1);
          if (output.length > 2000) { assert.ok(!inspection.reason!.includes("TAIL-MARKER")); assert.equal(inspection.output!.endsWith("TAIL-MARKER"), output.length <= 16_000); }
        };
        await check(); await f.reopen(); await check();
        const before = f.tasks.get(f.taskId)!; const attempt = before.attempts.at(-1)!;
        assert.throws(() => f.tasks.transition(f.taskId, "incomplete", { attemptId: attempt.attemptId, artifacts: { output: "replacement" } }), /cannot be overwritten/u);
        f.tasks.syncSubagentSnapshot({ taskId: "worker", parentRunId: "parent", task: "research", status: "incomplete", createdAt: new Date().toISOString() }, { taskRunId: f.taskId, attemptId: attempt.attemptId }, "late output");
        assert.deepEqual(f.tasks.get(f.taskId), before);
      });
    });
  }
}
for (const mode of ["completed", "failed", "aborted"] as const) {
  test(`${mode} projection retains its existing output semantics`, async () => {
    await fixture("normal result", true, mode, async f => {
      await f.reopen(); const task = f.tasks.get(f.taskId)!; assert.equal(task.status, mode);
      const artifacts = task.attempts.at(-1)!.artifacts as Record<string, unknown>;
      assert.equal(artifacts.output, mode === "completed" ? "normal result" : undefined);
      assert.deepEqual(artifacts.workerExecution, f.checkpoint); assert.equal((await f.communication.inspect(f.taskId)).messages.length, 1);
    });
  });
}
