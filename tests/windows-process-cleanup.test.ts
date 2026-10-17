import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";

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
    const started = await service.start({ command: "synthetic-background-command", shell: { kind: "posix", executable: "/bin/sh" } });
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
