import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";

const workerFlag = "--local-lock-race-worker";
const waitTimeoutMs = 15_000;

interface Outcome {
  entered: boolean;
  pid: number;
  error?: string;
  elapsedMs: number;
}

interface Worker {
  child: ChildProcess;
  finished: Promise<void>;
  paused: string;
  resume: string;
  stop: string;
  outcome: string;
  busy: string;
  successorRead: string;
}

async function waitForFile(filePath: string | readonly string[]): Promise<void> {
  const paths = typeof filePath === "string" ? [filePath] : filePath;
  const deadline = Date.now() + waitTimeoutMs;
  while (!paths.some((candidate) => existsSync(candidate))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${paths.join(" or ")}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function worker(root: string, name: string, lockName: string, pauseAt: string): Promise<void> {
  const lockPath = path.join(root, lockName);
  const pause = async (): Promise<void> => {
    await fs.writeFile(path.join(root, `${name}.paused`), "paused");
    await waitForFile(path.join(root, `${name}.resume`));
  };
  if (pauseAt === "stale") {
    const unlink = fs.unlink.bind(fs);
    let once = true;
    fs.unlink = async (target): Promise<void> => {
      if (target === lockPath && once) { once = false; await pause(); }
      await unlink(target);
    };
  }
  if (pauseAt === "empty") {
    const open = fs.open;
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === lockPath && typeof args[1] === "number" && (args[1] & constants.O_EXCL) !== 0) await pause();
      return handle;
    };
  }
  if (pauseAt.startsWith("legacy-read-")) {
    const open = fs.open;
    let once = true;
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === lockPath && typeof args[1] === "number" && (args[1] & constants.O_EXCL) === 0) {
        if (pauseAt === "legacy-read-stat") {
          const stat = handle.stat.bind(handle);
          handle.stat = async (...statArgs: Parameters<typeof handle.stat>) => {
            const value = await stat(...statArgs);
            if (once) { once = false; await pause(); }
            return value;
          };
        }
        const read = handle.readFile.bind(handle);
        handle.readFile = async (...readArgs: Parameters<typeof handle.readFile>) => {
          const raw = await read(...readArgs);
          if (String(raw).includes("legacy-successor")) {
            await fs.writeFile(path.join(root, `${name}.successor-read`), "read");
          }
          if (pauseAt === "legacy-read-complete" && once) { once = false; await pause(); }
          return raw;
        };
        if (pauseAt === "legacy-read-open" && once) { once = false; await pause(); }
      }
      return handle;
    };
  }
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql): void {
    try { exec.call(this, sql); } catch (error) {
      if (error instanceof Error && /database (?:table )?is locked/u.test(error.message)) {
        writeFileSync(path.join(root, `${name}.busy`), "busy");
      }
      throw error;
    }
  };
  const startedAt = Date.now();
  const publish = async (outcome: Outcome): Promise<void> => {
    const outcomePath = path.join(root, `${name}.outcome`);
    await fs.writeFile(`${outcomePath}.tmp`, JSON.stringify(outcome));
    await fs.rename(`${outcomePath}.tmp`, outcomePath);
  };
  let entered = false;
  try {
    await withLocalFileWriteLock(root, lockName, async () => {
      entered = true;
      await publish({ entered, pid: process.pid, elapsedMs: Date.now() - startedAt });
      await waitForFile(path.join(root, `${name}.stop`));
    });
  } catch (error) {
    // A release failure must not hide the fact that the critical section ran.
    await publish({ entered, pid: process.pid, elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error) });
  }
}

function launch(root: string, name: string, lockName = "state.lock", pauseAt = "none"): Worker {
  const child = spawn(process.execPath, [
    ...process.execArgv, fileURLToPath(import.meta.url), workerFlag, root, name, lockName, pauseAt
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return {
    child, finished,
    paused: path.join(root, `${name}.paused`),
    resume: path.join(root, `${name}.resume`),
    stop: path.join(root, `${name}.stop`),
    outcome: path.join(root, `${name}.outcome`),
    busy: path.join(root, `${name}.busy`),
    successorRead: path.join(root, `${name}.successor-read`)
  };
}

async function result(worker: Worker): Promise<Outcome> {
  await waitForFile(worker.outcome);
  return JSON.parse(await fs.readFile(worker.outcome, "utf8")) as Outcome;
}

async function stop(worker: Worker): Promise<void> {
  await fs.writeFile(worker.resume, "resume");
  await fs.writeFile(worker.stop, "stop");
  await worker.finished;
}

async function fixture(run: (root: string, workers: Worker[]) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-local-file-lock-races-"));
  const workers: Worker[] = [];
  try { await run(root, workers); } finally {
    await Promise.all(workers.map(stop));
    await fs.rm(root, { recursive: true, force: true });
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => { throw new Error("Uninitialized barrier."); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

if (process.argv[2] === workerFlag) {
  const [, , , root, name, lockName, pauseAt] = process.argv;
  assert.ok(root && name && lockName && pauseAt);
  await worker(root, name, lockName, pauseAt);
} else {
  await test("final stale-owner stat and unlink cannot admit two cross-process operations", async () => {
    await fixture(async (root, workers) => {
      await fs.writeFile(path.join(root, "state.lock"), JSON.stringify({ pid: 2147483647, nonce: "dead" }), { mode: 0o600 });
      const b = launch(root, "b", "state.lock", "stale");
      workers.push(b);
      await waitForFile(b.paused);
      const a = launch(root, "a");
      workers.push(a);
      const aResult = await result(a);
      await fs.writeFile(b.resume, "resume");
      const bResult = await result(b);
      assert.equal(Number(aResult.entered) + Number(bResult.entered), 1,
        "two processes must not both enter after B's last stale-owner stat and before B's unlink");
      assert.equal(aResult.entered, false);
      assert.match(aResult.error ?? "", /Timed out/u);
      assert.ok(aResult.elapsedMs >= 4_500 && aResult.elapsedMs < 10_000,
        "contention must keep its bounded five-second wait");
      assert.equal(bResult.entered, true);
    });
  });

  await test("a live initial publisher is protected, and its partial marker recovers after SIGKILL", async () => {
    await fixture(async (root, workers) => {
      const owner = launch(root, "owner", "state.lock", "empty");
      workers.push(owner);
      await waitForFile(owner.paused);
      const initial = await fs.lstat(path.join(root, "state.lock"));
      assert.equal(initial.size, 0);
      const contender = launch(root, "contender");
      workers.push(contender);
      await waitForFile(contender.busy);
      assert.equal(existsSync(contender.outcome), false);
      assert.equal((await fs.lstat(path.join(root, "state.lock"))).ino, initial.ino);
      owner.child.kill("SIGKILL");
      await owner.finished;
      assert.equal((await result(contender)).entered, true);
    });
  });

  await test("a crashed published owner is recovered even when its PID has been reused", async () => {
    await fixture(async (root, workers) => {
      const owner = launch(root, "owner");
      workers.push(owner);
      assert.equal((await result(owner)).entered, true);
      owner.child.kill("SIGKILL");
      await owner.finished;
      const lockPath = path.join(root, "state.lock");
      const record = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
      record.pid = process.pid;
      await fs.writeFile(lockPath, JSON.stringify(record));
      let entered = false;
      await withLocalFileWriteLock(root, "state.lock", async () => { entered = true; });
      assert.equal(entered, true);
    });
  });

  await test("same-process retries yield and do not release the owner's cross-process gate", async () => {
    await fixture(async (root, workers) => {
      const entered = deferred();
      const release = deferred();
      let active = 0;
      const owner = withLocalFileWriteLock(root, "state.lock", async () => {
        active += 1;
        entered.resolve();
        await release.promise;
        active -= 1;
      });
      await entered.promise;
      const retried = deferred();
      let retries = 0;
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql): void {
        try { exec.call(this, sql); } catch (error) {
          if (error instanceof Error && /database (?:table )?is locked/u.test(error.message) && ++retries >= 3) retried.resolve();
          throw error;
        }
      };
      const contender = withLocalFileWriteLock(root, "state.lock", async () => {
        assert.equal(active, 0, "two same-process operations cannot overlap");
      });
      try {
        await retried.promise;
        const third = launch(root, "third");
        workers.push(third);
        await waitForFile(third.busy);
        assert.equal(existsSync(third.outcome), false,
          "closing losing SQLite connections must not unlock the owner's connection");
        let independent = false;
        await withLocalFileWriteLock(root, "other.lock", async () => { independent = true; });
        assert.equal(independent, true);
        release.resolve();
        assert.equal((await result(third)).entered, true);
        await stop(third);
        await Promise.all([owner, contender]);
      } finally {
        DatabaseSync.prototype.exec = exec;
        release.resolve();
        await Promise.all([owner, contender]);
      }
    });
  });

  await test("legacy live markers remain protected until their owner removes them", async () => {
    await fixture(async (root, workers) => {
      const lockPath = path.join(root, "state.lock");
      const marker = JSON.stringify({ pid: process.pid, nonce: "legacy-owner" });
      await fs.writeFile(lockPath, marker, { mode: 0o600 });
      const contender = launch(root, "contender");
      workers.push(contender);
      // Wait until the contender has actually read the legacy record by starting
      // a second gate contender and observing its real SQLite busy result.
      const observer = launch(root, "observer");
      workers.push(observer);
      await waitForFile([observer.busy, contender.busy]);
      assert.equal(existsSync(contender.outcome), false);
      assert.equal(existsSync(observer.outcome), false);
      assert.equal(await fs.readFile(lockPath, "utf8"), marker);
      await fs.unlink(lockPath);
      // Either contender can win first; release each as soon as it enters.
      await Promise.all([contender, observer].map(async (candidate) => {
        const outcome = await result(candidate);
        assert.equal(outcome.entered, true, JSON.stringify(outcome));
        await stop(candidate);
      }));
    });
  });

  for (const pauseAt of ["legacy-read-open", "legacy-read-stat", "legacy-read-complete"]) {
    await test(`legacy marker removal during ${pauseAt} retries acquisition`, async () => {
      await fixture(async (root, workers) => {
        const lockPath = path.join(root, "state.lock");
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: "legacy-owner" }), { mode: 0o600 });
        const contender = launch(root, "contender", "state.lock", pauseAt);
        workers.push(contender);
        await waitForFile(contender.paused);
        assert.equal(existsSync(contender.outcome), false);
        await fs.unlink(lockPath);
        await fs.writeFile(contender.resume, "resume");
        const outcome = await result(contender);
        assert.equal(outcome.entered, true, JSON.stringify(outcome));
        await stop(contender);
        assert.equal((await result(contender)).error, undefined);
      });
    });

    await test(`legacy marker replacement during ${pauseAt} protects its live successor`, async () => {
      await fixture(async (root, workers) => {
        const lockPath = path.join(root, "state.lock");
        await fs.writeFile(lockPath, JSON.stringify({ pid: 2147483647, nonce: "dead-predecessor" }), { mode: 0o600 });
        const contender = launch(root, "contender", "state.lock", pauseAt);
        workers.push(contender);
        await waitForFile(contender.paused);
        const successor = JSON.stringify({ pid: process.pid, nonce: "legacy-successor" });
        // Keep the old descriptor linked so this also covers a safe inode
        // mismatch, rather than only the nlink=0 case in the removal test.
        await fs.rename(lockPath, `${lockPath}.predecessor`);
        await fs.writeFile(lockPath, successor, { mode: 0o600 });
        await fs.writeFile(contender.resume, "resume");
        await waitForFile([contender.successorRead, contender.outcome]);
        assert.equal(existsSync(contender.outcome), false,
          existsSync(contender.outcome) ? JSON.stringify(await result(contender)) : "successor must remain protected");
        assert.equal(await fs.readFile(lockPath, "utf8"), successor);
        await fs.unlink(lockPath);
        const outcome = await result(contender);
        assert.equal(outcome.entered, true, JSON.stringify(outcome));
        await stop(contender);
        assert.equal((await result(contender)).error, undefined);
      });
    });

    for (const tampering of ["symlink", "hardlink", "detached-hardlinks", "authority", "directory"] as const) {
      await test(`unsafe ${tampering} during ${pauseAt} fails closed`, async () => {
        await fixture(async (root, workers) => {
          const lockPath = path.join(root, "state.lock");
          const target = path.join(root, "external-target");
          const marker = JSON.stringify({ pid: process.pid, nonce: "legacy-owner" });
          await fs.writeFile(lockPath, marker, { mode: 0o600 });
          await fs.writeFile(target, "do not touch", { mode: 0o600 });
          const contender = launch(root, "contender", "state.lock", pauseAt);
          workers.push(contender);
          await waitForFile(contender.paused);
          const oldRoot = `${root}.original`;
          try {
            if (tampering === "detached-hardlinks") {
              await fs.link(lockPath, `${lockPath}.alias-one`);
              await fs.link(lockPath, `${lockPath}.alias-two`);
            }
            await fs.unlink(lockPath);
            if (tampering === "symlink") await fs.symlink(target, lockPath);
            if (tampering === "hardlink") await fs.link(target, lockPath);
            if (tampering === "authority") {
              const gate = `${lockPath}.authority.sqlite`;
              await fs.rename(gate, `${gate}.original`);
              await fs.writeFile(gate, "", { mode: 0o600 });
            }
            if (tampering === "directory") {
              await fs.rename(root, oldRoot);
              await fs.mkdir(root, { mode: 0o700 });
              await fs.writeFile(target, "do not touch", { mode: 0o600 });
            }
            await fs.writeFile(contender.resume, "resume");
            const outcome = await result(contender);
            assert.equal(outcome.entered, false, JSON.stringify(outcome));
            assert.match(outcome.error ?? "", /single-link|changed during access/u);
            assert.ok(outcome.elapsedMs < 4_500, "unsafe changes must fail immediately, not be retried to timeout");
            assert.equal(await fs.readFile(target, "utf8"), "do not touch");
            if (tampering === "symlink" || tampering === "hardlink") {
              assert.equal(existsSync(lockPath), true, "unsafe target must not be reclaimed");
            }
            if (tampering === "detached-hardlinks") {
              assert.equal(await fs.readFile(`${lockPath}.alias-one`, "utf8"), marker);
              assert.equal(await fs.readFile(`${lockPath}.alias-two`, "utf8"), marker);
            }
          } finally {
            await stop(contender);
            await fs.rm(oldRoot, { recursive: true, force: true });
          }
        });
      });
    }
  }

  await test("operation and partial-publication exceptions release all resources", async () => {
    await fixture(async (root) => {
      const lockPath = path.join(root, "state.lock");
      await assert.rejects(withLocalFileWriteLock(root, "state.lock", async () => {
        throw new Error("injected operation failure");
      }), /injected operation failure/u);
      assert.equal(existsSync(lockPath), false);
      const open = fs.open;
      fs.open = async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (args[0] === lockPath && typeof args[1] === "number" && (args[1] & constants.O_EXCL) !== 0) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (): Promise<void> => {
            await write("{\"pid\":");
            throw new Error("injected publication failure");
          };
        }
        return handle;
      };
      try {
        await assert.rejects(withLocalFileWriteLock(root, "state.lock", async () => {
          assert.fail("failed publication must never execute the operation");
        }), /injected publication failure/u);
      } finally { fs.open = open; }
      assert.equal(await fs.readFile(lockPath, "utf8"), "{\"pid\":");
      await withLocalFileWriteLock(root, "state.lock", async () => undefined);
      assert.equal(existsSync(lockPath), false);
    });
  });

  await test("release never removes a replacement inode or an in-place changed owner", async () => {
    await fixture(async (root) => {
      for (const replaceInode of [false, true]) {
        const name = `replace-${String(replaceInode)}.lock`;
        const lockPath = path.join(root, name);
        const marker = JSON.stringify({ pid: process.pid, nonce: "other-owner" });
        await assert.rejects(withLocalFileWriteLock(root, name, async () => {
          if (replaceInode) await fs.rename(lockPath, `${lockPath}.original`);
          await fs.writeFile(lockPath, marker, { mode: 0o600 });
        }), /changed during access/u);
        assert.equal(await fs.readFile(lockPath, "utf8"), marker);
        await fs.unlink(lockPath);
        await withLocalFileWriteLock(root, name, async () => undefined);
      }
    });
  });

  await test("authority replacement fails closed without admitting a new operation", async () => {
    await fixture(async (root) => {
      const lockPath = path.join(root, "state.lock");
      const gatePath = `${lockPath}.authority.sqlite`;
      let marker = "";
      await assert.rejects(withLocalFileWriteLock(root, "state.lock", async () => {
        marker = await fs.readFile(lockPath, "utf8");
        await fs.rename(gatePath, `${gatePath}.original`);
        await fs.writeFile(gatePath, "", { mode: 0o600 });
        await assert.rejects(withLocalFileWriteLock(root, "state.lock", async () => {
          assert.fail("a replacement gate must not elect another owner");
        }), /authority changed/u);
      }), /authority changed/u);
      assert.equal(await fs.readFile(lockPath, "utf8"), marker);
    });
  });

  await test("authority and side-file links are rejected without touching their targets", async () => {
    await fixture(async (root) => {
      const target = path.join(root, "external-target");
      await fs.writeFile(target, "do not touch", { mode: 0o600 });
      for (const artifact of ["authority", "journal", "wal", "shm"] as const) {
        for (const linkKind of ["symlink", "hardlink"] as const) {
          const name = `${artifact}-${linkKind}.lock`;
          const gate = `${path.join(root, name)}.authority.sqlite`;
          const artifactPath = artifact === "authority" ? gate : `${gate}-${artifact}`;
          if (linkKind === "symlink") await fs.symlink(target, artifactPath);
          else await fs.link(target, artifactPath);
          await assert.rejects(withLocalFileWriteLock(root, name, async () => assert.fail("unsafe file")), /authority/u);
          assert.equal(await fs.readFile(target, "utf8"), "do not touch");
          assert.equal(existsSync(artifactPath), true);
          await fs.unlink(artifactPath);
        }
      }
      const gate = `${path.join(root, "nonprivate.lock")}.authority.sqlite`;
      await fs.writeFile(gate, "", { mode: 0o644 });
      await assert.rejects(withLocalFileWriteLock(root, "nonprivate.lock", async () => undefined), /private/u);
    });
  });

  await test("directory replacement preserves files in the new directory and closes the old gate", async () => {
    await fixture(async (root) => {
      const old = `${root}.original`;
      try {
        await assert.rejects(withLocalFileWriteLock(root, "state.lock", async () => {
          await fs.rename(root, old);
          await fs.mkdir(root);
          await fs.writeFile(path.join(root, "state.lock"), "replacement");
        }), /directory changed/u);
        assert.equal(await fs.readFile(path.join(root, "state.lock"), "utf8"), "replacement");
      } finally {
        if (existsSync(old)) {
          await fs.rm(root, { recursive: true, force: true });
          await fs.rename(old, root);
        }
      }
      await withLocalFileWriteLock(root, "state.lock", async () => undefined);
    });
  });

  await test("only active operations retain FDs and stable gate inodes survive reuse", async () => {
    await fixture(async (root) => {
      const before = existsSync("/proc/self/fd") ? (await fs.readdir("/proc/self/fd")).length : undefined;
      const release = deferred();
      const entered = deferred();
      const count = 16;
      let acquired = 0;
      const operations = Array.from({ length: count }, (_, index) => withLocalFileWriteLock(root, `fd-${index}.lock`, async () => {
        acquired += 1;
        if (acquired === count) entered.resolve();
        await release.promise;
      }));
      try {
        await entered.promise;
        if (before !== undefined) assert.ok((await fs.readdir("/proc/self/fd")).length >= before + count);
      } finally {
        release.resolve();
        await Promise.all(operations);
      }
      if (before !== undefined) assert.ok((await fs.readdir("/proc/self/fd")).length <= before + 1);
      for (let index = 0; index < count; index += 1) {
        const name = `fd-${index}.lock`;
        const gate = `${path.join(root, name)}.authority.sqlite`;
        const identity = await fs.stat(gate);
        await withLocalFileWriteLock(root, name, async () => undefined);
        assert.equal((await fs.stat(gate)).ino, identity.ino);
        assert.equal((await fs.stat(gate)).size, 0);
        assert.equal(existsSync(`${gate}-journal`), false);
      }
    });
  });
}
