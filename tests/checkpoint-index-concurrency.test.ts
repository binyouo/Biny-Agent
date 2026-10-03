import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CheckpointStore } from "../src/session/checkpointStore.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";

const run = promisify(execFile);
const workerFlag = "--checkpoint-index-worker";

async function withRepository(operation: (root: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-index-"));
  const root = path.join(directory, "repo");
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(directory, "state");
  try {
    await fs.mkdir(root);
    await run("git", ["init", "-q"], { cwd: root });
    await fs.writeFile(path.join(root, "baseline.txt"), "original\n");
    await run("git", ["add", "baseline.txt"], { cwd: root });
    await ensureAgentDirs(root);
    await operation(root);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function create(root: string, label: string): Promise<string> {
  const store = await CheckpointStore.open(root);
  assert.ok(store);
  return (await store.create(label)).id;
}

function launch(root: string, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), workerFlag, root, label], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors || `Checkpoint worker exited ${String(code)}.`)));
  });
}

if (process.argv[2] === workerFlag) {
  const root = process.argv[3];
  const label = process.argv[4];
  assert.ok(root && label);
  console.log(await create(root, label));
} else {
  await test("separate session stores retain every concurrent checkpoint", async () => {
    await withRepository(async (root) => {
      const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => create(root, `session-${index}`)));
      assert.ok(outcomes.every((result) => result.status === "fulfilled"), "Every admitted checkpoint must finish without a temporary-file collision.");
      const store = await CheckpointStore.open(root);
      assert.ok(store);
      const entries = await store.list();
      assert.equal(entries.length, 8, "The shared index must retain all session checkpoints.");
      assert.deepEqual(new Set(entries.map((entry) => entry.id)), new Set(outcomes.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])));
      for (const entry of entries) await store.restore(entry.id);
    });
  });

  await test("separate processes retain every concurrent checkpoint", { timeout: 15_000 }, async () => {
    await withRepository(async (root) => {
      const outcomes = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => launch(root, `process-${index}`)));
      assert.ok(outcomes.every((result) => result.status === "fulfilled"), "Cross-process publication must not lose a checkpoint or fail rename.");
      const store = await CheckpointStore.open(root);
      assert.ok(store);
      const entries = await store.list();
      assert.equal(entries.length, 4);
      assert.deepEqual(new Set(entries.map((entry) => entry.id)), new Set(outcomes.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])));
    });
  });

  await test("an unreadable index is never replaced with an empty index", async () => {
    await withRepository(async (root) => {
      await create(root, "already-published");
      const target = path.join(agentDir(root), "checkpoints.json");
      const original = await fs.readFile(target, "utf8");
      const read = fs.readFile;
      fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === target) throw Object.assign(new Error("synthetic index read failure"), { code: "EIO" });
        return await read(...args);
      }) as typeof fs.readFile;
      try {
        await assert.rejects(create(root, "must-not-replace"), /synthetic index read failure/u);
      } finally {
        fs.readFile = read;
      }
      assert.equal(await fs.readFile(target, "utf8"), original);
    });
  });

  await test("a stale index lock is recovered before publication", async () => {
    await withRepository(async (root) => {
      await fs.writeFile(path.join(agentDir(root), "checkpoints.json.lock"), JSON.stringify({ pid: 2147483647, nonce: "stale" }), { mode: 0o600 });
      const id = await create(root, "after-owner-exit");
      const store = await CheckpointStore.open(root);
      assert.ok(store);
      assert.equal((await store.list())[0]?.id, id);
      await assert.rejects(fs.stat(path.join(agentDir(root), "checkpoints.json.lock")), { code: "ENOENT" });
    });
  });

  await test("a malformed index is not overwritten during publication", async () => {
    await withRepository(async (root) => {
      const target = path.join(agentDir(root), "checkpoints.json");
      const invalid = "{\"version\":1,\"checkpoints\":[{\"id\":\"incomplete\"}]}\n";
      await fs.writeFile(target, invalid);
      await assert.rejects(create(root, "must-preserve-invalid-index"), /Invalid checkpoint index entry/u);
      assert.equal(await fs.readFile(target, "utf8"), invalid);
    });
  });

  await test("a failed publication retains the previous index and removes its temporary file", async () => {
    await withRepository(async (root) => {
      await create(root, "previous");
      const directory = agentDir(root);
      const target = path.join(directory, "checkpoints.json");
      const original = await fs.readFile(target, "utf8");
      const rename = fs.rename;
      fs.rename = async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] === target) throw Object.assign(new Error("synthetic publication failure"), { code: "EIO" });
        return await rename(...args);
      };
      try {
        await assert.rejects(create(root, "failed"), /synthetic publication failure/u);
      } finally {
        fs.rename = rename;
      }
      assert.equal(await fs.readFile(target, "utf8"), original);
      assert.equal((await fs.readdir(directory)).some((file) => file.startsWith("checkpoints.json.") && file.endsWith(".tmp")), false);
      const next = await create(root, "after-failure");
      const store = await CheckpointStore.open(root);
      assert.ok(store);
      assert.equal((await store.list()).at(-1)?.id, next, "The failed operation must release its index lock.");
    });
  });
}
