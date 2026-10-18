import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { agentDir } from "../src/session/store.js";

async function reportProcessDirectoryEquality(context: TestContext, workspace: string): Promise<void> {
  try {
    const canonicalWorkspace = await realpath(workspace);
    const rawAgent = agentDir(workspace);
    const canonicalAgent = agentDir(canonicalWorkspace);
    const isDirectory = async (directory: string): Promise<boolean> => {
      try {
        return (await stat(directory)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    context.diagnostic(JSON.stringify({
      processDirectoryEquality: {
        workspaceEqualsCanonical: workspace === canonicalWorkspace,
        workspaceDifferenceIsCaseOnly: workspace !== canonicalWorkspace && workspace.toLowerCase() === canonicalWorkspace.toLowerCase(),
        rawAgentEqualsCanonicalAgent: rawAgent === canonicalAgent,
        rawProcessDirectoryExists: await isDirectory(path.join(rawAgent, "processes")),
        canonicalProcessDirectoryExists: await isDirectory(path.join(canonicalAgent, "processes"))
      }
    }));
  } catch {
    context.diagnostic(JSON.stringify({ processDirectoryEqualityUnavailable: true }));
  }
}

test("failed Windows tree cleanup is reported even when the shell itself has exited", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "biny-windows-cleanup-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const child = Object.assign(new EventEmitter(), { pid: 987654321, exitCode: null as number | null, signalCode: null, unref() {}, kill() { return true; } });
  let alive = true;
  const service = new ManagedProcessService({ workspaceRoot: root });
  const spawn = context.mock.method(childProcess, "spawn", (command: string) => {
    if (command === "synthetic-background-command") {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as childProcess.ChildProcess;
    }
    assert.equal(command, "taskkill");
    const helper = Object.assign(new EventEmitter(), { kill() { return true; } });
    queueMicrotask(() => {
      alive = false;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      helper.emit("close", 5);
    });
    return helper as unknown as childProcess.ChildProcess;
  });
  const kill = context.mock.method(process, "kill", (pid: number) => {
    assert.equal(pid, child.pid);
    if (!alive) throw Object.assign(new Error("synthetic process exited"), { code: "ESRCH" });
    return true;
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const started = await service.start({ command: "synthetic-background-command", shell: { kind: "posix", executable: "/bin/sh" } }).catch(async (error: unknown) => {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        await reportProcessDirectoryEquality(context, root);
      }
      throw error;
    });
    const stopped = await service.stop(started.processId);
    assert.equal(stopped.cleanup.status, "failed", "a failed tree walk cannot prove descendants stopped");
    assert.match(stopped.cleanup.message ?? "", /taskkill.*5/u);
  } finally {
    await service.close();
    Object.defineProperty(process, "platform", platform);
    spawn.mock.restore(); kill.mock.restore(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows managed process uses the initialized state partition for an ordinary workspace case alias", { skip: process.platform !== "win32" }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "biny-process-workspace-alias-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  let service: ManagedProcessService | undefined;
  try {
    const canonicalRoot = await realpath(root);
    const workspaceRoot = path.join(canonicalRoot, "MixedCaseWorkspace");
    const workspaceAlias = path.join(canonicalRoot, "mixedcaseworkspace");
    const stateRoot = path.join(canonicalRoot, "state");
    await mkdir(workspaceRoot);
    await mkdir(stateRoot);
    const canonicalWorkspace = await realpath(workspaceRoot);
    assert.ok(workspaceAlias !== workspaceRoot, "fixture must change only the owned workspace component's casing");
    assert.ok(realpathSync.native(workspaceAlias) === canonicalWorkspace, "native alias must identify the created workspace");
    assert.ok(await realpath(workspaceAlias) === canonicalWorkspace, "async alias must identify the created workspace");
    process.env.BINY_AGENT_DIR = await realpath(stateRoot);
    const child = Object.assign(new EventEmitter(), { pid: 987654322, exitCode: null as number | null, signalCode: null, unref() {}, kill() { return true; } });
    let alive = true;
    context.mock.method(childProcess, "spawn", (command: string) => {
      if (command === "synthetic-workspace-alias-command") {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as childProcess.ChildProcess;
      }
      assert.equal(command, "taskkill");
      const helper = Object.assign(new EventEmitter(), { kill() { return true; } });
      queueMicrotask(() => {
        alive = false;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        helper.emit("close", 0);
      });
      return helper as unknown as childProcess.ChildProcess;
    });
    context.mock.method(process, "kill", (pid: number) => {
      assert.equal(pid, child.pid);
      if (!alive) throw Object.assign(new Error("synthetic process exited"), { code: "ESRCH" });
      return true;
    });
    syncBuiltinESMExports();
    service = new ManagedProcessService({ workspaceRoot: workspaceAlias });
    const started = await service.start({ command: "synthetic-workspace-alias-command", shell: { kind: "posix", executable: "/bin/sh" } }).catch(async (error: unknown) => {
      await reportProcessDirectoryEquality(context, workspaceAlias);
      throw error;
    });
    const expectedProcessDirectory = path.join(agentDir(canonicalWorkspace), "processes");
    assert.ok(path.dirname(started.logPath) === expectedProcessDirectory, "process log must use the partition established during initialization");
    assert.ok(await realpath(path.dirname(started.logPath)) === expectedProcessDirectory, "process log parent must remain canonical");
    assert.match((await service.readOutput(started.processId)).content, /starting managed process/u);
    const stopped = await service.stop(started.processId);
    assert.equal(stopped.cleanup.status, "stopped");
  } finally {
    try {
      await service?.close();
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }
});
