import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs, { constants, existsSync, promises as files, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionLeaseStore, isSessionWriterConflictError } from "../src/runtime/SessionLease.js";
import { agentDir } from "../src/session/store.js";

const timeoutMs = 10_000;
const workerFlag = "--session-lease-race-worker";

interface Outcome {
  acquired: boolean;
  conflict?: boolean;
  pid: number;
  runtimeId: string;
  error?: string;
}

interface Worker {
  child: ChildProcess;
  paused: string;
  resume: string;
  stop: string;
  outcome: string;
  finished: Promise<void>;
}

type PauseAt = "none" | "stale" | "empty";

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function waitForFileSync(filePath: string): void {
  const deadline = Date.now() + timeoutMs;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}.`);
    Atomics.wait(sleep, 0, 0, 10);
  }
}

async function runWorker(root: string, name: string, sessionId: string, pauseAt: PauseAt): Promise<void> {
  const store = await SessionLeaseStore.open(root);
  const pause = (): void => {
    writeFileSync(path.join(root, `${name}.paused`), "ready");
    waitForFileSync(path.join(root, `${name}.resume`));
  };
  if (pauseAt === "stale") {
    // Freeze B after reading the old owner, immediately before reclaiming it.
    // A must not be allowed to publish a lease during that same election.
    const internal = store as unknown as { retireStaleLease(leasePath: string): void };
    const retire = internal.retireStaleLease.bind(internal);
    internal.retireStaleLease = (leasePath): void => { pause(); retire(leasePath); };
  }
  if (pauseAt === "empty") {
    const open = fs.openSync;
    const leasePath = path.join(agentDir(root), "runs", `session-${sessionId}.lock`);
    fs.openSync = (filePath, flags, mode): number => {
      const descriptor = open(filePath, flags, mode);
      if (filePath === leasePath && typeof flags === "number" && (flags & constants.O_EXCL) !== 0) pause();
      return descriptor;
    };
    syncBuiltinESMExports();
  }
  const publish = (outcome: Outcome): void => {
    const outcomePath = path.join(root, `${name}.outcome`);
    writeFileSync(`${outcomePath}.tmp`, JSON.stringify(outcome));
    renameSync(`${outcomePath}.tmp`, outcomePath);
  };
  try {
    const lease = store.acquire(sessionId);
    publish({
      acquired: true, pid: process.pid, runtimeId: store.runtimeId
    });
    await waitForFile(path.join(root, `${name}.stop`));
    lease.close();
  } catch (error) {
    publish({
      acquired: false,
      conflict: isSessionWriterConflictError(error),
      pid: process.pid,
      runtimeId: store.runtimeId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    store.close();
  }
}

function launch(root: string, name: string, sessionId: string, pauseAt: PauseAt = "none"): Worker {
  const child = spawn(process.execPath, [
    ...process.execArgv, fileURLToPath(import.meta.url), workerFlag, root, name, sessionId, pauseAt
  ], { env: { ...process.env, BINY_AGENT_DIR: root }, stdio: ["ignore", "ignore", "inherit"] });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return {
    child, finished,
    paused: path.join(root, `${name}.paused`),
    resume: path.join(root, `${name}.resume`),
    stop: path.join(root, `${name}.stop`),
    outcome: path.join(root, `${name}.outcome`)
  };
}

async function result(worker: Worker): Promise<Outcome> {
  await waitForFile(worker.outcome);
  return JSON.parse(await files.readFile(worker.outcome, "utf8")) as Outcome;
}

async function stop(worker: Worker): Promise<void> {
  await files.writeFile(worker.resume, "resume");
  await files.writeFile(worker.stop, "stop");
  await worker.finished;
}

async function fixture(run: (root: string, store: SessionLeaseStore, workers: Worker[]) => Promise<void>): Promise<void> {
  const root = await files.mkdtemp(path.join(os.tmpdir(), "biny-session-lease-races-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const store = await SessionLeaseStore.open(root);
  const workers: Worker[] = [];
  try {
    await run(root, store, workers);
  } finally {
    await Promise.all(workers.map(stop));
    store.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await files.rm(root, { recursive: true, force: true });
  }
}

function leasePath(root: string, sessionId: string): string {
  return path.join(agentDir(root), "runs", `session-${sessionId}.lock`);
}

if (process.argv[2] === workerFlag) {
  const [, , , root, name, sessionId, pauseAt] = process.argv;
  assert.ok(root && name && sessionId);
  assert.ok(pauseAt === "none" || pauseAt === "stale" || pauseAt === "empty");
  await runWorker(root, name, sessionId, pauseAt);
} else {
  await test("stale-owner read/reclaim/publish is one cross-process election", async () => {
    await fixture(async (root, _store, workers) => {
      const id = "stale-race";
      await files.writeFile(leasePath(root, id), JSON.stringify({
        version: 1, runtimeId: "dead-owner", pid: 2147483647,
        sessionId: id, createdAt: new Date().toISOString()
      }), { mode: 0o600 });
      const b = launch(root, "b", id, "stale");
      workers.push(b);
      await waitForFile(b.paused);
      const independent = _store.acquire("while-stale-election-paused");
      independent.close();
      const a = launch(root, "a", id);
      workers.push(a);
      const aResult = await result(a);
      await files.writeFile(b.resume, "resume");
      const bResult = await result(b);
      assert.equal(Number(aResult.acquired) + Number(bResult.acquired), 1,
        "two processes must never both return a lease after reading the same dead owner");
      assert.equal(aResult.conflict, true);
      assert.equal(bResult.acquired, true);
      assert.equal((JSON.parse(await files.readFile(leasePath(root, id), "utf8")) as { runtimeId: string }).runtimeId,
        bResult.runtimeId);
    });
  });

  await test("a live publisher's initially empty marker cannot be retired", async () => {
    await fixture(async (root, _store, workers) => {
      const id = "initial-publish";
      const a = launch(root, "a", id, "empty");
      workers.push(a);
      await waitForFile(a.paused);
      const initial = await files.lstat(leasePath(root, id));
      assert.equal(initial.size, 0);
      const b = launch(root, "b", id);
      workers.push(b);
      const bResult = await result(b);
      const afterContender = await files.lstat(leasePath(root, id));
      await files.writeFile(a.resume, "resume");
      const aResult = await result(a);
      assert.equal(bResult.acquired, false, "an incomplete marker is not proof of a dead owner");
      assert.equal(bResult.conflict, true);
      assert.equal(afterContender.ino, initial.ino);
      assert.equal(aResult.acquired, true);
    });
  });

  await test("live owner conflicts, unrelated sessions proceed, and kernel ownership ends on crash", async () => {
    await fixture(async (root, store, workers) => {
      const a = launch(root, "a", "crash");
      workers.push(a);
      assert.equal((await result(a)).acquired, true);
      assert.throws(() => store.acquire("crash"), isSessionWriterConflictError);
      const independent = store.acquire("independent");
      independent.close();
      a.child.kill("SIGKILL");
      await a.finished;
      // Simulate the dead owner's PID having been reused by a live process.
      // Kernel ownership, not kill(pid, 0), must decide whether a gated marker is stale.
      const marker = JSON.parse(await files.readFile(leasePath(root, "crash"), "utf8")) as Record<string, unknown>;
      marker.pid = process.pid;
      await files.writeFile(leasePath(root, "crash"), JSON.stringify(marker));
      const recovered = store.acquire("crash");
      recovered.close();
    });
  });

  await test("crashes during publication or stale reclaim release the election gate", async () => {
    await fixture(async (root, store, workers) => {
      for (const pauseAt of ["empty", "stale"] as const) {
        const id = `crash-${pauseAt}`;
        if (pauseAt === "stale") {
          await files.writeFile(leasePath(root, id), JSON.stringify({
            version: 1, runtimeId: "dead-owner", pid: 2147483647,
            sessionId: id, createdAt: new Date().toISOString()
          }), { mode: 0o600 });
        }
        const a = launch(root, pauseAt, id, pauseAt);
        workers.push(a);
        await waitForFile(a.paused);
        a.child.kill("SIGKILL");
        await a.finished;
        const recovered = store.acquire(id);
        recovered.close();
      }
    });
  });

  await test("same-process losers fail immediately without releasing the live kernel lock", async () => {
    await fixture(async (root, first, workers) => {
      const second = await SessionLeaseStore.open(root);
      const owner = first.acquire("same-process");
      try {
        const started = Date.now();
        for (let attempt = 0; attempt < 4; attempt += 1) {
          assert.throws(() => second.acquire("same-process"), isSessionWriterConflictError);
        }
        assert.ok(Date.now() - started < 1_000, "a store must not wait for its own process to release another lease");
        const contender = launch(root, "contender", "same-process");
        workers.push(contender);
        assert.equal((await result(contender)).conflict, true,
          "closing losing SQLite connections must preserve the first connection's kernel lock");
      } finally {
        second.close();
        owner.close();
      }
    });
  });

  await test("legacy live PID stays protected and a dead legacy owner is recoverable", async () => {
    await fixture(async (root, store) => {
      const id = "legacy";
      const record = {
        version: 1, runtimeId: "legacy-owner", pid: process.pid,
        sessionId: id, createdAt: new Date().toISOString()
      };
      await files.writeFile(leasePath(root, id), JSON.stringify(record), { mode: 0o600 });
      assert.throws(() => store.acquire(id), isSessionWriterConflictError);
      assert.equal(await files.readFile(leasePath(root, id), "utf8"), JSON.stringify(record));
      record.pid = 2147483647;
      await files.writeFile(leasePath(root, id), JSON.stringify(record));
      store.acquire(id).close();
    });
  });

  await test("a published gated marker still passes the old v1 reader's live-owner check", async () => {
    await fixture(async (root, store) => {
      const id = "legacy-reader";
      const owner = store.acquire(id);
      // The previous readLease implementation accepts extra properties but insists
      // on this v1 envelope before it checks process liveness. Changing version
      // would make it treat even a healthy new writer's marker as corrupt/stale.
      const record = JSON.parse(await files.readFile(leasePath(root, id), "utf8")) as Record<string, unknown>;
      assert.equal(record.version, 1);
      assert.equal(typeof record.runtimeId, "string");
      assert.ok(record.runtimeId);
      assert.equal(typeof record.pid, "number");
      assert.ok(Number.isSafeInteger(record.pid));
      assert.ok((record.pid as number) > 0);
      assert.equal(record.sessionId, id);
      assert.equal(typeof record.createdAt, "string");
      assert.ok(Number.isFinite(Date.parse(record.createdAt as string)));
      assert.doesNotThrow(() => process.kill(record.pid as number, 0));
      assert.equal(typeof record.authority, "object");
      owner.close();
    });
  });

  await test("release preserves a replacement marker and always closes its own gate", async () => {
    await fixture(async (root, first) => {
      const second = await SessionLeaseStore.open(root);
      const id = "replacement";
      const markerPath = leasePath(root, id);
      const owner = first.acquire(id);
      await files.rename(markerPath, `${markerPath}.original`);
      const otherMarker = JSON.stringify({
        version: 1, runtimeId: "other-owner", pid: process.pid,
        sessionId: id, createdAt: new Date().toISOString()
      });
      await files.writeFile(markerPath, otherMarker, { mode: 0o600 });
      const replacementIdentity = await files.lstat(markerPath);
      owner.close();
      owner.close();
      assert.equal((await files.lstat(markerPath)).ino, replacementIdentity.ino);
      assert.equal(await files.readFile(markerPath, "utf8"), otherMarker);
      await files.unlink(markerPath);
      const next = second.acquire(id);
      owner.close();
      assert.equal((JSON.parse(await files.readFile(markerPath, "utf8")) as { runtimeId: string }).runtimeId,
        second.runtimeId);
      next.close();
      second.close();
    });
  });

  await test("replaced authority cannot elect another writer or make release remove the owner marker", async () => {
    await fixture(async (root, first) => {
      const second = await SessionLeaseStore.open(root);
      const id = "replaced-authority";
      const markerPath = leasePath(root, id);
      const authorityPath = `${markerPath}.authority.sqlite`;
      const owner = first.acquire(id);
      const marker = await files.readFile(markerPath, "utf8");
      await files.rename(authorityPath, `${authorityPath}.original`);
      await files.writeFile(authorityPath, "", { mode: 0o600 });
      assert.throws(() => second.acquire(id), /authority changed/u);
      owner.close();
      assert.equal(await files.readFile(markerPath, "utf8"), marker);
      second.close();
    });
  });

  await test("marker, authority, and SQLite side-file symlinks/hardlinks fail closed", async () => {
    await fixture(async (root, store) => {
      const target = path.join(root, "external-target");
      await files.writeFile(target, "do not touch", { mode: 0o600 });
      for (const artifact of ["marker", "authority", "journal", "wal", "shm"] as const) {
        for (const linkKind of ["symlink", "hardlink"] as const) {
          const id = `${artifact}-${linkKind}`;
          const markerPath = leasePath(root, id);
          const authorityPath = `${markerPath}.authority.sqlite`;
          const artifactPath = artifact === "marker" ? markerPath
            : artifact === "authority" ? authorityPath : `${authorityPath}-${artifact}`;
          if (linkKind === "symlink") await files.symlink(target, artifactPath);
          else await files.link(target, artifactPath);
          assert.throws(() => store.acquire(id), /Unsafe|side file|ELOOP/u);
          assert.equal(await files.readFile(target, "utf8"), "do not touch");
          assert.equal(existsSync(artifactPath), true);
          await files.unlink(artifactPath);
        }
      }
      const privateGate = `${leasePath(root, "nonprivate")}.authority.sqlite`;
      await files.writeFile(privateGate, "", { mode: 0o644 });
      assert.throws(() => store.acquire("nonprivate"), /private/u);
    });
  });

  await test("a swapped runs directory is rejected before touching its marker or gate", async () => {
    await fixture(async (root, store) => {
      const directory = path.dirname(leasePath(root, "directory"));
      const movedDirectory = `${directory}.original`;
      await files.rename(directory, movedDirectory);
      await files.mkdir(directory);
      assert.throws(() => store.acquire("directory"), /directory changed/u);
      assert.deepEqual(await files.readdir(directory), []);
      await files.rmdir(directory);
      await files.symlink(movedDirectory, directory);
      assert.throws(() => store.acquire("directory"), /directory changed/u);
      assert.deepEqual(await files.readdir(movedDirectory), []);
    });
  });

  await test("store close releases every session FD while preserving stable authority inodes", async () => {
    await fixture(async (root, store) => {
      const before = existsSync("/proc/self/fd") ? (await files.readdir("/proc/self/fd")).length : undefined;
      const count = 24;
      const identities: number[] = [];
      for (let index = 0; index < count; index += 1) {
        const id = `fd-${index}`;
        store.acquire(id);
        identities.push((await files.stat(`${leasePath(root, id)}.authority.sqlite`)).ino);
      }
      if (before !== undefined) {
        assert.ok((await files.readdir("/proc/self/fd")).length >= before + count);
      }
      store.close();
      store.close();
      if (before !== undefined) {
        assert.ok((await files.readdir("/proc/self/fd")).length <= before + 1, "closing a store must not retain idle SQLite connections");
      }
      const replacement = await SessionLeaseStore.open(root);
      try {
        for (let index = 0; index < count; index += 1) {
          const id = `fd-${index}`;
          replacement.acquire(id).close();
          const gate = `${leasePath(root, id)}.authority.sqlite`;
          assert.equal((await files.stat(gate)).ino, identities[index]);
          assert.equal((await files.stat(gate)).size, 0);
          assert.equal(existsSync(`${gate}-journal`), false);
        }
      } finally {
        replacement.close();
      }
    });
  });
}
