/** Real git worktrees and approval/verification/store; runtime workspace registry and admission are isolated boundaries. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import ts from "typescript";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { approveTaskVerification, readWorkerAttemptCheckpoint, runTaskClosure } from "../src/runtime/TaskClosure.js";
import { approveTaskRun } from "../src/runtime/taskOperations.js";
import { pendingTaskVerificationApproval, readTaskDefinition, taskCheckToolCallId, type TaskCommandExecutor, type TaskVerificationContract } from "../src/runtime/taskVerification.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const exec = promisify(execFile);
async function runtimeApproval(tasks: DurableTaskRunStore, primary: string, candidate: string, state: { registered: boolean; foreign: boolean; ensureCalls: number }) {
  const text = await readFile(new URL("../src/runtime/CommandRuntime.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("CommandRuntime.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let workspace: ts.VariableDeclaration | undefined; let owner: ts.VariableDeclaration | undefined; let method: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "taskWorkspace") workspace = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "assertTaskOwner") owner = node;
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "approveTaskVerification" && node.body) method = node;
    ts.forEachChild(node, visit);
  }; visit(source); assert.ok(workspace?.initializer); assert.ok(owner?.initializer);
  const compile = (value: string) => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const assertOwner = new Function("agent", compile(`const owner = ${owner!.initializer!.getText(source)};`) + ";return owner;")({ getInfo: () => ({ sessionId: state.foreign ? "other-parent" : "parent" }) });
  const registry = {
    get: async () => state.registered ? { worktreePath: candidate } : undefined,
    ensure: async () => { state.ensureCalls++; await access(candidate); return { worktreePath: candidate }; }
  };
  const resolve = new Function("taskWorktreeId", "taskWorktrees", "taskRuns", "readWorkerAttemptCheckpoint", "workspaceRoot", "readTaskDefinition", "loadAgentDefinitions", "findSubagentDefinition", compile(`const resolve = ${workspace!.initializer!.getText(source)};`) + ";return resolve;")(
    () => "task-worktree", registry, tasks, readWorkerAttemptCheckpoint, primary, readTaskDefinition, async () => [], () => undefined
  );
  // Baseline taskOperations does not use this new runtime boundary; never substitute its approval implementation.
  if (!method) return async () => { throw new Error("Runtime approval boundary is absent."); };
  return new Function("taskRuns", "assertTaskOwner", "taskWorkspace", "config", "approveTaskVerification", compile(`const handler = ({ ${method.getText(source)} }).approveTaskVerification;`) + ";return handler;")(
    tasks, assertOwner, resolve, { workspace: { ignore: [] } }, approveTaskVerification
  ) as CommandRuntime["approveTaskVerification"];
}

async function fixture(options: { isolated?: boolean; changedDefinition?: boolean; identicalPrimary?: boolean }, run: (f: {
  primary: string; candidate: string; tasks: DurableTaskRunStore; state: { registered: boolean; foreign: boolean; ensureCalls: number };
  approve(id?: string): Promise<void>; approvalId: string; starts(): number; checks(): number; workers(): number; reopen(): Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-worktree-approval-")); const primary = path.join(root, "primary"); await mkdir(primary);
  const candidate = options.isolated === false ? primary : path.join(root, "isolated");
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let authority: RuntimeEventAuthority | undefined; let tasks: DurableTaskRunStore | undefined;
  const open = async () => { authority = await RuntimeEventAuthority.open(primary, { reconcileSessions: false }); tasks = await DurableTaskRunStore.open(primary, authority); };
  const close = () => { tasks?.close(); authority?.close(); };
  const git = async (...args: string[]) => await exec("git", args, { cwd: primary });
  try {
    await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
    await writeFile(path.join(primary, "artifact.txt"), options.identicalPrimary ? "candidate" : "original"); await writeFile(path.join(primary, "check.cjs"), "process.exit(0);\n");
    await git("add", "."); await git("commit", "-m", "baseline");
    if (candidate !== primary) await git("worktree", "add", "-b", "candidate", candidate);
    if (options.changedDefinition) await writeFile(path.join(candidate, "check.cjs"), "// isolated verifier\nprocess.exit(0);\n");
    const contract: TaskVerificationContract = { version: 1, objective: "verify", checks: [{ id: "check", command: "node check.cjs", definitionPaths: ["check.cjs"] }], artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1 };
    await open(); tasks!.create({ taskRunId: "task", sessionId: "parent", task: { prompt: "candidate", ...(candidate !== primary ? { isolation: "worktree" } : {}), verification: contract } }); tasks!.transition("task", "queued");
    let workers = 0; let starts = 0; let checks = 0;
    const denied: TaskCommandExecutor = { executeTaskCheck: async input => ({ result: { status: "permission_required", reason: "fixture permission boundary" }, approvalRequired: true, toolCallId: taskCheckToolCallId(input), resultEventId: "denied", eventReferences: ["denied"] }) };
    const parked = await runTaskClosure({ taskRuns: tasks!, taskRunId: "task", workspaceRoot: candidate, ignore: [], executor: denied,
      executeAttempt: async () => { workers++; await writeFile(path.join(candidate, "artifact.txt"), "candidate"); return "candidate output"; } });
    assert.equal(parked.status, "needs_approval"); const pending = pendingTaskVerificationApproval(parked.evidence!); assert.ok(pending);
    close(); await open();
    const state = { registered: candidate !== primary, foreign: false, ensureCalls: 0 };
    await run({ primary, candidate, get tasks() { return tasks!; }, state, approvalId: pending.approvalId, starts: () => starts, checks: () => checks, workers: () => workers,
      async reopen() { close(); await open(); },
      async approve(id = pending.approvalId) {
        const approve = await runtimeApproval(tasks!, primary, candidate, state);
        const commands = { workspaceRoot: primary, taskRuns: tasks!, config: { workspace: { ignore: [] } }, approveTaskVerification: approve,
          async startTaskRun() {
            starts++;
            return { completion: runTaskClosure({ taskRuns: tasks!, taskRunId: "task", workspaceRoot: candidate, ignore: [],
              executor: { executeTaskCheck: async input => {
                checks++; assert.equal(input.approval?.approvalId, pending.approvalId);
                const result = await exec(process.execPath, [path.join(candidate, "check.cjs")], { cwd: candidate });
                return { result: { status: "completed" as const, exitCode: 0, stdout: result.stdout, stderr: result.stderr }, toolCallId: taskCheckToolCallId(input), resultEventId: "checked", eventReferences: ["checked"] };
              } }, executeAttempt: async () => { throw new Error("Approval must not rerun the Worker"); } }) };
          }, graphs: { projectTaskClosure: () => undefined }
        } as unknown as CommandRuntime;
        const runtime = { runExclusiveOperation: async (_kind: string, execute: () => Promise<unknown>) => await execute() } as unknown as InteractiveRuntimeHandle;
        const admitted = await approveTaskRun(runtime, commands, "task", id, primary); await admitted.completion;
      }
    });
  } finally { close(); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

for (const scenario of ["isolated artifact", "isolated definition", "primary changed", "ordinary primary"] as const) {
  test(`${scenario}: approval validates the original candidate workspace`, async () => {
    await fixture({ isolated: scenario !== "ordinary primary", changedDefinition: scenario === "isolated definition" }, async f => {
      if (scenario === "primary changed") await writeFile(path.join(f.primary, "check.cjs"), "throw new Error('unrelated primary checkout');\n");
      await f.approve(); assert.equal(f.starts(), 1); assert.equal(f.checks(), 1); assert.equal(f.workers(), 1);
      await f.reopen(); assert.equal(f.tasks.get("task")!.status, "completed"); assert.equal(f.tasks.get("task")!.attempts.length, 1);
      assert.equal(f.state.ensureCalls, scenario === "ordinary primary" ? 0 : 1);
    });
  });
}
for (const scenario of ["changed candidate", "stale approval", "missing registration", "missing directory", "foreign owner"] as const) {
  test(`${scenario}: approval remains fail closed with no verification dispatch`, async () => {
    await fixture({ identicalPrimary: true }, async f => {
      if (scenario === "changed candidate") await writeFile(path.join(f.candidate, "artifact.txt"), "tampered");
      if (scenario === "missing registration") f.state.registered = false;
      if (scenario === "missing directory") await rm(f.candidate, { recursive: true, force: true });
      if (scenario === "foreign owner") f.state.foreign = true;
      const before = f.tasks.get("task");
      await assert.rejects(f.approve(scenario === "stale approval" ? "stale-id" : undefined));
      assert.equal(f.starts(), 0); assert.equal(f.checks(), 0); assert.equal(f.workers(), 1); assert.deepEqual(f.tasks.get("task"), before);
      if (scenario === "missing registration" || scenario === "foreign owner") assert.equal(f.state.ensureCalls, 0);
      await f.reopen(); assert.equal(f.tasks.get("task")!.status, "needs_approval");
    });
  });
}
