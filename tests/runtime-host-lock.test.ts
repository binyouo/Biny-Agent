import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureRuntimeHostDirectory,
  runtimeHostPaths
} from "../src/runtime/host/lifecycle.js";

type ChildMessage =
  | { kind: "before-stale-lock-remove"; pid: number }
  | { kind: "acquired"; pid: number }
  | { kind: "error"; error: string }
  | { kind: "released" };

const lifecycleUrl = pathToFileURL(fileURLToPath(new URL("../src/runtime/host/lifecycle.ts", import.meta.url))).href;

function spawnLockAcquirer(paths: ReturnType<typeof runtimeHostPaths>, persistenceRoot: string, holdStaleLockRemove = false): ChildProcess {
  const script = `
    import { promises as fs } from "node:fs";
    const paths = ${JSON.stringify(paths)};
    const persistenceRoot = ${JSON.stringify(persistenceRoot)};
    const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
    const holdStaleLockRemove = ${JSON.stringify(holdStaleLockRemove)};
    const send = (message) => process.send?.(message);
    const lifecycle = await import(lifecycleUrl);
    if (holdStaleLockRemove) {
      const remove = fs.rm.bind(fs);
      fs.rm = async (target, options) => {
        if (target === paths.lockPath) {
          send({ kind: "before-stale-lock-remove", pid: process.pid });
          await new Promise((resolve) => process.once("message", resolve));
        }
        return await remove(target, options);
      };
    }
    try {
      const lock = await lifecycle.acquireHostLock(paths, persistenceRoot);
      send({ kind: "acquired", pid: process.pid });
      await new Promise((resolve) => process.once("message", resolve));
      await lock.close();
      send({ kind: "released" });
    } catch (error) {
      send({ kind: "error", error: error instanceof Error ? error.message : String(error) });
    }
  `;
  const child = spawn(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    "--input-type=module", "-e", script
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  child.on("error", () => undefined);
  return child;
}

function waitForMessage(child: ChildProcess, predicate: (message: ChildMessage) => boolean): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Runtime Host lock child did not report within 5 seconds.")), 5_000);
    const onMessage = (value: unknown): void => {
      if (typeof value !== "object" || value === null || !("kind" in value)) return;
      const message = value as ChildMessage;
      if (predicate(message)) {
        finish(undefined, message);
        return;
      }
      if (message.kind === "error") {
        finish(new Error(`Runtime Host lock child failed: ${message.error}`));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`Runtime Host lock child exited before reporting (code=${String(code)}, signal=${String(signal)}).`));
    };
    const finish = (error?: Error, message?: ChildMessage): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(message!);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function releaseAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.send("release"); } catch { return; }
  await waitForMessage(child, (message) => message.kind === "released").catch(() => undefined);
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-lock-race-"));
const paths = runtimeHostPaths(root);
await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));

try {
  // Given the owner has created the exclusive lock file but has not yet written its PID,
  // when another process attempts startup, then it must fail closed and preserve that inode.
  {
    const ownerHandle = await fs.open(paths.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const ownerInode = (await ownerHandle.stat()).ino;
    const contender = spawnLockAcquirer(paths, root);
    try {
      const result = await waitForMessage(contender, (message) => message.kind === "acquired" || message.kind === "error");
      await ownerHandle.writeFile(`${String(process.pid)}\n`, "utf8");
      await ownerHandle.sync();
      assert.equal(result.kind, "error", "an unpublished owner lock must never be reclaimed as stale");
      assert.equal((await fs.stat(paths.lockPath)).ino, ownerInode, "the contender must preserve the initializing owner's lock file");
      assert.equal(await fs.readFile(paths.lockPath, "utf8"), `${String(process.pid)}\n`);
    } finally {
      await ownerHandle.close();
      await releaseAndWait(contender);
      await fs.rm(paths.lockPath, { force: true });
    }
  }

  // Given a stale owner and two simultaneous reclaimers, when the first reclaimer is
  // paused immediately before unlink, then the second must not publish another owner.
  {
    await fs.writeFile(paths.lockPath, `${String(Number.MAX_SAFE_INTEGER)}\n`, { mode: 0o600 });
    await fs.chmod(paths.lockPath, 0o600);
    const first = spawnLockAcquirer(paths, root, true);
    let second: ChildProcess | undefined;
    try {
      const paused = await waitForMessage(first, (message) => message.kind === "before-stale-lock-remove");
      assert.equal(paused.kind, "before-stale-lock-remove");
      second = spawnLockAcquirer(paths, root);
      const secondResult = await waitForMessage(second, (message) => message.kind === "acquired" || message.kind === "error");
      try { first.send("continue"); } catch { /* process may already have exited after reporting an error */ }
      const firstResult = await waitForMessage(first, (message) => message.kind === "acquired" || message.kind === "error");
      assert.equal(secondResult.kind, "error", "a concurrent stale-lock reclaimer must not create a second owner");
      assert.equal(firstResult.kind, "acquired", "the serialized reclaimer should become the sole owner");
      assert.equal(await fs.readFile(paths.lockPath, "utf8"), `${String(firstResult.pid)}\n`, "a losing reclaimer must not unlink the winning owner's lock");
    } finally {
      try { first.send("continue"); } catch { /* process may already have exited after reporting an error */ }
      await releaseAndWait(first);
      if (second) await releaseAndWait(second);
      await fs.rm(paths.lockPath, { force: true });
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("runtime-host-lock tests passed");
