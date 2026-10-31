/** Actual closure, verification, communication and SQLite; only Worker/provider execution is injected. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { taskCheckToolCallId, type TaskCommandExecutor, type TaskVerificationContract } from "../src/runtime/taskVerification.js";

async function fixture(run: (f: {
  workspace: string; tasks: DurableTaskRunStore; communication: TaskCommunication;
  execute(output: string, resumed?: boolean, interrupt?: "abort" | "cancel" | "replace"): ReturnType<typeof runTaskClosure>;
  reopen(): Promise<void>; before(): Record<string, unknown>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-review-artifacts-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let authority: RuntimeEventAuthority | undefined; let tasks: DurableTaskRunStore | undefined; let communication: TaskCommunication | undefined;
  const open = async () => { authority = await RuntimeEventAuthority.open(workspace, { reconcileSessions: false }); tasks = await DurableTaskRunStore.open(workspace, authority); communication = new TaskCommunication(tasks, "parent"); };
  const close = () => { communication?.close(); tasks?.close(); authority?.close(); };
  try {
    await writeFile(path.join(workspace, "artifact.txt"), "candidate"); await writeFile(path.join(workspace, "check.cjs"), "process.exit(0);\n");
    const contract: TaskVerificationContract = { version: 1, objective: "verify candidate", checks: [{ id: "check", command: "node check.cjs", definitionPaths: ["check.cjs"] }], artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1 };
    const executor: TaskCommandExecutor = { executeTaskCheck: async input => {
      await new Promise<void>((resolve, reject) => execFile(process.execPath, [path.join(workspace, "check.cjs")], { cwd: workspace }, error => error ? reject(error) : resolve()));
      return { result: { status: "completed", exitCode: 0, stdout: "", stderr: "" }, toolCallId: taskCheckToolCallId(input), resultEventId: "result", eventReferences: ["result"] };
    } };
    await open(); tasks!.create({ taskRunId: "source", sessionId: "parent", task: { prompt: "source", verification: contract } }); tasks!.transition("source", "queued");
    const source = await runTaskClosure({ taskRuns: tasks!, taskRunId: "source", workspaceRoot: workspace, ignore: [], executor, executeAttempt: async () => "candidate" });
    assert.equal(source.status, "completed");
    const review = { taskRunId: "source", attemptId: tasks!.get("source")!.attempts.at(-1)!.attemptId, evidence: source.evidence, contract };
    tasks!.create({ taskRunId: "review", sessionId: "parent", task: { prompt: "review candidate", review, communication: true } }); tasks!.transition("review", "queued");
    let before: Record<string, unknown> = {};
    const populate = (attemptId: string) => {
      communication!.send("review", "Check the evidence", "input");
      const worker = communication!.worker("review", attemptId); worker.delivered(["input"]); worker.report("Important finding", "report"); assert.equal(worker.seal(), true);
      const task = tasks!.get("review")!;
      tasks!.transition("review", "running", { attemptId, artifacts: { ...task.attempts.at(-1)!.artifacts as Record<string, unknown>, extension: { nested: ["preserve"] } } });
      before = tasks!.get("review")!.attempts.at(-1)!.artifacts as Record<string, unknown>;
    };
    await run({ workspace, get tasks() { return tasks!; }, get communication() { return communication!; }, before: () => before,
      async reopen() { close(); await open(); },
      async execute(output, resumed = false, interrupt) {
        const controller = new AbortController();
        if (interrupt) {
          const get = tasks!.get.bind(tasks); let sourceReads = 0;
          tasks!.get = id => {
            const value = get(id);
            if (id === "source" && ++sourceReads === 2) queueMicrotask(() => {
              if (interrupt === "abort") controller.abort();
              else if (interrupt === "replace") {
                const replacement = tasks!.createAttempt("review");
                tasks!.transition("review", "running", { attemptId: replacement.attemptId, artifacts: { sentinel: "new owner" } });
              }
              else tasks!.transition("review", "cancelled", { attemptId: get("review")!.attempts.at(-1)!.attemptId });
            });
            return value;
          };
        }
        if (resumed) {
          const attempt = tasks!.createAttempt("review"); tasks!.transition("review", "running", { attemptId: attempt.attemptId, artifacts: { workerExecution: { prompt: "review candidate", workspaceRoot: workspace } } });
          populate(attempt.attemptId); tasks!.transition("review", "verifying", { attemptId: attempt.attemptId, artifacts: { ...before, output } }); close(); await open();
        }
        return await runTaskClosure({ taskRuns: tasks!, taskRunId: "review", workspaceRoot: workspace, ignore: [], executor, signal: controller.signal,
          executeAttempt: async (_, attempt) => { assert.equal(resumed, false, "resumed review must not rerun Worker"); populate(attempt.attemptId); return output; } });
      }
    });
  } finally { close(); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

for (const resumed of [false, true]) {
  for (const verdict of ["passed", "needs_changes"] as const) {
    test(`${resumed ? "resumed" : "fresh"} ${verdict} review retains durable reports and checkpoint`, async () => {
      await fixture(async f => {
        const output = JSON.stringify({ verdict, summary: "Review conclusion", evidenceReferences: ["source"], findings: verdict === "passed" ? [] : [{ criterion: "clarity", requestedChange: "Explain result" }] });
        assert.equal((await f.execute(output, resumed)).status, "completed");
        const verify = () => {
          const task = f.tasks.get("review")!; assert.equal(task.attempts.length, 1); assert.equal(task.status, "completed");
          const artifacts = task.attempts.at(-1)!.artifacts as Record<string, unknown>;
          for (const field of ["communication", "workerExecution", "extension"]) assert.deepEqual(artifacts[field], f.before()[field], field);
          assert.equal(artifacts.output, output); assert.deepEqual(artifacts.review, JSON.parse(output));
          assert.equal((artifacts.candidate as { taskRunId: string }).taskRunId, "source");
        };
        verify(); await f.reopen(); verify();
        const inspection = await f.communication.inspect("review"); assert.equal(inspection.messages.length, 2); assert.equal(inspection.inputOpen, false);
        assert.deepEqual(f.communication.messages("review"), inspection.messages);
        const notices = f.communication.notifications(); assert.equal(notices.length, 2); assert.equal(notices[0]!.terminal, false); assert.match(notices[0]!.content, /Important finding/u); assert.equal(notices[1]!.terminal, true);
        f.communication.acknowledge(notices[0]!); f.communication.acknowledge(notices[1]!); await f.reopen(); assert.equal(f.communication.notifications().length, 0);
      });
    });
  }
}
for (const [label, output] of [
  ["invalid JSON", "not JSON"],
  ["foreign reference", JSON.stringify({ verdict: "passed", summary: "ok", evidenceReferences: ["foreign"], findings: [] })],
  ["invalid verdict", JSON.stringify({ verdict: "passed", summary: "ok", evidenceReferences: ["source"], findings: [{ criterion: "x", requestedChange: "y" }] })]
]) {
  test(`${label} remains blocked and retains the existing mailbox`, async () => {
    await fixture(async f => {
      assert.equal((await f.execute(output!)).status, "blocked"); await f.reopen();
      const artifacts = f.tasks.get("review")!.attempts.at(-1)!.artifacts as Record<string, unknown>;
      assert.deepEqual(artifacts.communication, f.before().communication); assert.equal(artifacts.review, undefined);
    });
  });
}

for (const interrupt of ["abort", "cancel"] as const) {
  test(`${interrupt} during asynchronous review freshness checking never completes the review`, async () => {
    await fixture(async f => {
      const output = JSON.stringify({ verdict: "passed", summary: "ok", evidenceReferences: ["source"], findings: [] });
      assert.equal((await f.execute(output, false, interrupt)).status, "cancelled"); await f.reopen();
      const task = f.tasks.get("review")!; assert.equal(task.status, "cancelled");
      const artifacts = task.attempts.at(-1)!.artifacts as Record<string, unknown>;
      assert.equal(artifacts.review, undefined); assert.deepEqual(artifacts.communication, f.before().communication);
    });
  });
}

test("a newer attempt during review freshness checking keeps ownership and artifacts", async () => {
  await fixture(async f => {
    const output = JSON.stringify({ verdict: "passed", summary: "ok", evidenceReferences: ["source"], findings: [] });
    assert.equal((await f.execute(output, false, "replace")).status, "cancelled"); await f.reopen();
    const task = f.tasks.get("review")!; assert.equal(task.status, "running"); assert.equal(task.attempts.length, 2);
    assert.deepEqual(task.attempts.at(-1)!.artifacts, { sentinel: "new owner" });
    assert.deepEqual((task.attempts[0]!.artifacts as Record<string, unknown>).communication, f.before().communication);
  });
});
