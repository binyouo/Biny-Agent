import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CheckpointStore, type Checkpoint } from "../src/session/checkpointStore.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";

const run = promisify(execFile);
const stateFiles = [".biny/settings.json", ".agent/todos.json"];
const workspaceFiles = [".agent-notes.txt", ".biny-notes.txt", ".gitignore", "source.txt", "tracked-then-ignored.txt"];

for (const splitIndex of [false, true]) {
  test(`checkpoints exclude tracked state with ${splitIndex ? "split" : "normal"} index`, { timeout: 10_000 }, async () => {
    await withRepository(async (root, store) => {
      if (splitIndex) await git(root, ["update-index", "--split-index"]);
      const gitBefore = await gitState(root);
      const stateBefore = await Promise.all(stateFiles.map((file) => readFile(path.join(root, file), "utf8")));

      const checkpoint = await store.create("before source edit");
      const snapshotFiles = (await git(root, ["ls-tree", "-r", "-z", "--name-only", checkpoint.commit])).split("\0").filter(Boolean);
      assert.deepEqual(snapshotFiles, workspaceFiles, "tracked local state must not enter the snapshot tree");
      assert.deepEqual(await gitState(root), gitBefore);

      await writeFile(path.join(root, "source.txt"), "after edit\n");
      await writeFile(path.join(root, "tracked-then-ignored.txt"), "after ignored edit\n");
      const summary = await store.restore(checkpoint.id);
      assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "before edit\n");
      assert.equal(await readFile(path.join(root, "tracked-then-ignored.txt"), "utf8"), "tracked before ignore\n");
      assert.deepEqual(await Promise.all(stateFiles.map((file) => readFile(path.join(root, file), "utf8"))), stateBefore);
      assert.equal(summary.restoredFiles, workspaceFiles.length);
      assert.deepEqual(summary.movedAside, []);
      assert.deepEqual(await gitState(root), gitBefore);
    });
  });
}

for (const trackedState of [true, false]) {
  test(`checkpoints preserve ignored ${trackedState ? "tracked" : "untracked"} state`, { timeout: 10_000 }, async () => {
    await withRepository(async (root, store) => {
      await writeFile(path.join(root, ".gitignore"), ".biny/\n.agent/\ntracked-then-ignored.txt\n");
      const gitBefore = await gitState(root);
      const stateBefore = await Promise.all(stateFiles.map((file) => readFile(path.join(root, file), "utf8")));

      const checkpoint = await store.create("ignored local state");
      const snapshotFiles = (await git(root, ["ls-tree", "-r", "-z", "--name-only", checkpoint.commit])).split("\0").filter(Boolean);
      assert.deepEqual(snapshotFiles, workspaceFiles);
      await writeFile(path.join(root, "source.txt"), "after edit\n");
      const summary = await store.restore("latest");
      assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "before edit\n");
      assert.deepEqual(await Promise.all(stateFiles.map((file) => readFile(path.join(root, file), "utf8"))), stateBefore);
      assert.equal(summary.restoredFiles, workspaceFiles.length);
      assert.deepEqual(summary.movedAside, []);
      assert.deepEqual(await gitState(root), gitBefore);
    }, trackedState);
  });
}

test("restoring an existing snapshot leaves tracked local state untouched", { timeout: 10_000 }, async () => {
  await withRepository(async (root, store) => {
    // 已有快照可能携带真实暂存区中的旧状态；恢复仍须遵守状态目录排除合同。
    const tree = (await git(root, ["write-tree"])).trim();
    const commit = (await git(root, ["commit-tree", tree, "-m", "existing checkpoint"])).trim();
    const checkpoint: Checkpoint = { id: commit.slice(0, 12), label: "existing checkpoint", commit, createdAt: "2026-09-30T00:00:00.000Z" };
    await git(root, ["update-ref", `refs/biny/checkpoints/${checkpoint.id}`, commit]);
    await writeFile(path.join(agentDir(root), "checkpoints.json"), JSON.stringify({ version: 1, checkpoints: [checkpoint] }));
    const gitBefore = await gitState(root);
    const stateBefore = await Promise.all(stateFiles.map((file) => readFile(path.join(root, file), "utf8")));
    await writeFile(path.join(root, "source.txt"), "after edit\n");

    const summary = await store.restore("latest");
    assert.deepEqual(
      await Promise.all(stateFiles.map((file) => readFile(path.join(root, file), "utf8"))),
      stateBefore,
      "undo must not overwrite local state with the snapshot's staged version"
    );
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "committed source\n");
    assert.equal(summary.restoredFiles, workspaceFiles.length);
    assert.deepEqual(summary.movedAside, []);
    assert.deepEqual(await gitState(root), gitBefore);
  });
});

test("checkpoints keep literal file names and record tracked deletions", { timeout: 10_000 }, async () => {
  await withRepository(async (root, store) => {
    const names = [":(exclude)source.txt", "bracket[1].txt", "line\nbreak.txt"];
    for (const name of names) await writeFile(path.join(root, name), name);
    await rm(path.join(root, "source.txt"));
    const gitBefore = await gitState(root);
    const checkpoint = await store.create("literal names and deletion");
    const snapshotFiles = (await git(root, ["ls-tree", "-r", "-z", "--name-only", checkpoint.commit])).split("\0").filter(Boolean);
    assert.deepEqual(snapshotFiles.sort(), [...workspaceFiles.filter((file) => file !== "source.txt"), ...names].sort());

    for (const name of names) await writeFile(path.join(root, name), "after edit\n");
    await writeFile(path.join(root, "source.txt"), "created after checkpoint\n");
    const summary = await store.restore(checkpoint.id);
    for (const name of names) assert.equal(await readFile(path.join(root, name), "utf8"), name);
    assert.deepEqual(summary.movedAside, ["source.txt"]);
    assert.ok(summary.trashDirectory);
    assert.equal(await readFile(path.join(root, summary.trashDirectory, "source.txt"), "utf8"), "created after checkpoint\n");
    assert.deepEqual(await gitState(root), gitBefore);
  });
});

test("a workspace containing only excluded state can create an empty checkpoint", { timeout: 10_000 }, async () => {
  await withRepository(async (root, store) => {
    for (const file of workspaceFiles) await rm(path.join(root, file));
    const gitBefore = await gitState(root);
    const checkpoint = await store.create("only local state remains");
    assert.equal(await git(root, ["ls-tree", "-r", "--name-only", checkpoint.commit]), "");
    const summary = await store.restore(checkpoint.id);
    assert.equal(summary.restoredFiles, 0);
    assert.deepEqual(summary.movedAside, []);
    for (const file of stateFiles) assert.equal(await readFile(path.join(root, file), "utf8"), "current local state\n");
    assert.deepEqual(await gitState(root), gitBefore);
  });
});

async function withRepository(operation: (root: string, store: CheckpointStore) => Promise<void>, trackedState = true): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-state-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.email", "test@biny.local"]);
    await git(root, ["config", "user.name", "Biny Test"]);
    await git(root, ["config", "commit.gpgsign", "false"]);
    for (const file of stateFiles) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "committed state\n");
    }
    for (const file of workspaceFiles) await writeFile(path.join(root, file), `${file}\n`);
    await writeFile(path.join(root, "source.txt"), "committed source\n");
    await writeFile(path.join(root, "tracked-then-ignored.txt"), "tracked before ignore\n");
    await writeFile(path.join(root, ".gitignore"), "");
    await git(root, ["add", "--", ...workspaceFiles]);
    if (trackedState) await git(root, ["add", "-f", "--", ".biny", ".agent"]);
    await git(root, ["commit", "-qm", "fixture"]);
    for (const file of stateFiles) await writeFile(path.join(root, file), "staged state\n");
    if (trackedState) await git(root, ["add", "-f", "--", ".biny", ".agent"]);
    for (const file of stateFiles) await writeFile(path.join(root, file), "current local state\n");
    await writeFile(path.join(root, "source.txt"), "before edit\n");
    await writeFile(path.join(root, ".gitignore"), "tracked-then-ignored.txt\n");
    await ensureAgentDirs(root);
    const store = await CheckpointStore.open(root);
    assert.ok(store);
    await operation(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function gitState(root: string): Promise<{ index: Buffer; head: string; reflog: Buffer }> {
  return {
    index: await readFile(path.join(root, ".git", "index")),
    head: await git(root, ["rev-parse", "HEAD"]),
    reflog: await readFile(path.join(root, ".git", "logs", "HEAD"))
  };
}

async function git(root: string, args: string[]): Promise<string> {
  return (await run("git", args, { cwd: root })).stdout;
}
