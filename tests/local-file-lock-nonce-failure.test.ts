/** Nonce publication failures must release the already-acquired kernel gate. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withGlobalConfigWriteLock } from "../src/config/versioned.js";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";

const workerFlag = "--local-lock-nonce-failure-worker";

async function worker(root: string, throughConfig: boolean): Promise<void> {
  const lockName = throughConfig ? ".config.write.lock" : "state.lock";
  const lock = (operation: () => Promise<void>): Promise<void> => throughConfig
    ? withGlobalConfigWriteLock(root, operation)
    : withLocalFileWriteLock(root, lockName, operation);
  const entropyFailure = new Error("injected nonce entropy failure");
  const randomBytes = crypto.randomBytes;
  const exec = DatabaseSync.prototype.exec;
  const authorities: DatabaseSync[] = [];
  // Keep the acquired connection reachable so GC cannot hide a missed close.
  DatabaseSync.prototype.exec = function (sql): void {
    exec.call(this, sql);
    if (sql === "PRAGMA journal_mode = MEMORY; BEGIN IMMEDIATE") authorities.push(this);
  };
  crypto.randomBytes = (() => { throw entropyFailure; }) as typeof crypto.randomBytes;
  syncBuiltinESMExports();
  let entered = false;
  try {
    await assert.rejects(lock(async () => { entered = true; }), (error: unknown) => error === entropyFailure);
  } finally {
    DatabaseSync.prototype.exec = exec;
    crypto.randomBytes = randomBytes;
    syncBuiltinESMExports();
  }
  assert.equal(authorities.length, 1, "the failing attempt must acquire exactly one authority");
  const acquired = authorities[0];
  assert.ok(acquired, "the injected nonce failure must follow a successful authority acquisition");
  assert.equal(entered, false, "nonce failure must never invoke the critical section");
  assert.equal(existsSync(path.join(root, lockName)), false, "nonce failure must not publish a marker");
  const gate = path.join(root, `${lockName}.authority.sqlite`);
  const probe = new DatabaseSync(gate, { timeout: 0 });
  try {
    probe.exec("PRAGMA journal_mode = MEMORY; BEGIN IMMEDIATE; ROLLBACK");
  } finally {
    probe.close();
  }
  assert.throws(() => acquired.prepare("SELECT 1"), /database is not open/u, "cleanup must explicitly close the retained connection");
  const initial = await fs.stat(gate);
  assert.equal(initial.size, 0);
  await lock(async () => { entered = true; });
  assert.equal(entered, true, "a successor must acquire after the failed attempt rejects");
  assert.equal(existsSync(path.join(root, lockName)), false);
  assert.equal((await fs.stat(gate)).ino, initial.ino, "cleanup must preserve the authority inode");
}

if (process.argv[2] === workerFlag) {
  const root = process.argv[3];
  assert.ok(root);
  await worker(root, process.argv[4] === "config");
} else {
  for (const throughConfig of [false, true]) {
    await test(`nonce failure releases the gate for ${throughConfig ? "global config" : "local file"} successors`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-lock-nonce-failure-"));
      try {
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [
            ...process.execArgv, fileURLToPath(import.meta.url), workerFlag, root, throughConfig ? "config" : "local"
          ], { stdio: ["ignore", "pipe", "pipe"] });
          let output = "";
          child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
          child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal, output }));
        });
        assert.equal(outcome.code, 0, outcome.output);
        assert.equal(outcome.signal, null, outcome.output);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}
