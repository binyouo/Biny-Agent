import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CheckpointStore, type Checkpoint } from "../src/session/checkpointStore.js";

const run = promisify(execFile);
async function repository(operation: (store: CheckpointStore, root: string, git: (...args: string[]) => Promise<string>) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-retained-ref-"));
  const root = path.join(directory, "repo");
  const keys = ["BINY_AGENT_DIR", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.BINY_AGENT_DIR = path.join(directory, "state");
  // Commit identity has second resolution. Freeze native Git dates so identical
  // snapshots reliably exercise the same-second collision without timing sleeps.
  process.env.GIT_AUTHOR_DATE = "2026-10-31T00:00:00Z";
  process.env.GIT_COMMITTER_DATE = "2026-10-31T00:00:00Z";
  const git = async (...args: string[]): Promise<string> => (await run("git", args, { cwd: root })).stdout.trim();
  try {
    await fs.mkdir(root);
    await git("init", "-q");
    await git("config", "user.name", "Checkpoint test");
    await git("config", "user.email", "checkpoint@example.invalid");
    await fs.writeFile(path.join(root, "file.txt"), "original\n");
    await git("add", ".");
    await git("commit", "-qm", "initial");
    const store = await CheckpointStore.open(root);
    assert.ok(store);
    await operation(store, root, git);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
async function later(store: CheckpointStore, count: number): Promise<void> {
  for (let index = 0; index < count; index++) await store.create(`later-${index}`);
}
async function protectedRef(git: (...args: string[]) => Promise<string>, checkpoint: Checkpoint): Promise<string> {
  return await git("rev-parse", "--verify", `refs/biny/checkpoints/${checkpoint.id}`);
}

test("pruning one duplicate entry preserves the retained checkpoint ref", async () => repository(async (store, _root, git) => {
  const first = await store.create("before Write");
  const duplicate = await store.create("before Write");
  assert.equal(first.commit, duplicate.commit);
  await later(store, 49);
  const entries = await store.list();
  assert.equal(entries.length, 50);
  assert.equal(entries.filter(entry => entry.id === first.id).length, 1);
  assert.equal(await protectedRef(git, duplicate), duplicate.commit);
}));

test("a retained duplicate remains restorable after native Git garbage collection", async () => repository(async (store, root, git) => {
  const first = await store.create("before Write");
  const duplicate = await store.create("before Write");
  assert.equal(first.id, duplicate.id);
  await later(store, 49);
  const originalIndex = await fs.readFile(path.join(root, ".git", "index"));
  const originalHead = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(root, "file.txt"), "changed\n");
  await git("gc", "--prune=now");
  const restored = await store.restore(duplicate.id);
  assert.equal(restored.checkpoint.commit, duplicate.commit);
  assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "original\n");
  assert.equal(await git("rev-parse", "HEAD"), originalHead);
  assert.deepEqual(await fs.readFile(path.join(root, ".git", "index")), originalIndex);
}));

test("the ref is removed once every duplicate entry has expired", async () => repository(async (store, _root, git) => {
  const first = await store.create("before Write");
  assert.equal((await store.create("before Write")).id, first.id);
  await later(store, 50);
  assert.equal((await store.list()).length, 50);
  assert.equal((await store.list()).some(entry => entry.id === first.id), false);
  await assert.rejects(protectedRef(git, first));
}));

test("ordinary distinct checkpoints retain the fifty-entry cap and prune only expired refs", async () => repository(async (store, _root, git) => {
  const expired = await store.create("oldest");
  await later(store, 50);
  const entries = await store.list();
  assert.equal(entries.length, 50);
  assert.equal(new Set(entries.map(entry => entry.id)).size, 50);
  await assert.rejects(protectedRef(git, expired));
  for (const entry of entries) assert.equal(await protectedRef(git, entry), entry.commit);
}));

test("a pending publication protects its ref after another publisher expires the old entry", async context => repository(async (store, root, git) => {
  const old = await store.create("before Write");
  await later(store, 49);
  const pendingStore = await CheckpointStore.open(root);
  assert.ok(pendingStore);
  // Only schedule the publication boundary. The original create, Git commands,
  // index publication and cross-process lock implementations all execute.
  const scheduled = pendingStore as unknown as { appendIndexEntry(checkpoint: Checkpoint): Promise<void> };
  const append = scheduled.appendIndexEntry.bind(scheduled);
  let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(scheduled, "appendIndexEntry", async (checkpoint: Checkpoint) => {
    arrived();
    await released;
    await append(checkpoint);
  });
  const pending = pendingStore.create("before Write");
  try {
    await Promise.race([arrival, pending.then(() => { throw new Error("Missing publication gate"); })]);
    await store.create("expire-old-entry");
    assert.equal((await store.list()).some(entry => entry.id === old.id), false);
  } finally {
    release();
    await pending;
  }
  const republished = await pending;
  assert.equal(republished.id, old.id);
  assert.equal((await store.list()).at(-1)?.id, old.id);
  assert.equal(await protectedRef(git, republished), republished.commit);
  await git("gc", "--prune=now");
  await fs.writeFile(path.join(root, "file.txt"), "changed\n");
  await store.restore(republished.id);
  assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "original\n");
}));
