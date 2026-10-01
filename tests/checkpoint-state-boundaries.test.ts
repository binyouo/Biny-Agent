import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CheckpointStore, type Checkpoint } from "../src/session/checkpointStore.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";

const run = promisify(execFile);
const fixtureRoot = process.env.BINY_CHECKPOINT_TEST_ROOT ?? os.tmpdir();
const stateFiles = [".biny/settings.json", ".agent/todos.json"];
const aliasFiles = [".Biny/settings.json", ".Agent/todos.json"];

for (const legacy of [false, true]) {
  test(`${legacy ? "existing" : "new"} sparse checkpoint excludes state outside the cone`, { timeout: 10_000 }, async () => {
    await withRepository(async (root, store) => {
      for (const file of [...stateFiles, "src/source.txt", "outside/user.txt"]) await put(root, file, "before\n");
      await commit(root);
      await sparseCheckout(root);
      const gitBefore = await gitState(root);
      const checkpoint = legacy ? await existingCheckpoint(root) : await store.create("sparse state");
      if (!legacy) assert.deepEqual(await snapshotFiles(root, checkpoint), ["outside/user.txt", "src/source.txt"]);
      for (const file of stateFiles) await put(root, file, "current state\n");
      await put(root, "src/source.txt", "after edit\n");
      const summary = await store.restore(checkpoint.id);
      for (const file of stateFiles) assert.equal(await readFile(path.join(root, file), "utf8"), "current state\n");
      assert.equal(await readFile(path.join(root, "src/source.txt"), "utf8"), "before\n");
      assert.equal(summary.restoredFiles, 2);
      assert.deepEqual(summary.movedAside, []);
      assert.deepEqual(await gitState(root), gitBefore);
    });
  });
}

for (const sparse of [false, true]) {
  for (const legacy of [false, true]) {
    test(`${legacy ? "existing" : "new"} ${sparse ? "sparse" : "normal"} checkpoint preserves physical state aliases`, { timeout: 10_000 }, async (context) => {
      await withRepository(async (root, store) => {
        for (const file of [...aliasFiles, "src/source.txt"]) await put(root, file, "before\n");
        if (!await sameDirectory(root, ".Biny", ".biny")) {
          context.skip("requires case-insensitive directory lookup");
          return;
        }
        await commit(root);
        if (sparse) await sparseCheckout(root);
        const gitBefore = await gitState(root);
        const checkpoint = legacy ? await existingCheckpoint(root) : await store.create("physical aliases");
        if (!legacy) assert.deepEqual(await snapshotFiles(root, checkpoint), ["src/source.txt"]);
        for (const file of stateFiles) await put(root, file, "current state\n");
        await put(root, "src/source.txt", "after edit\n");
        const summary = await store.restore("latest");
        for (const file of stateFiles) assert.equal(await readFile(path.join(root, file), "utf8"), "current state\n");
        assert.equal(await readFile(path.join(root, "src/source.txt"), "utf8"), "before\n");
        assert.equal(summary.restoredFiles, 1);
        assert.deepEqual(summary.movedAside, []);
        assert.deepEqual(await gitState(root), gitBefore);
      });
    });
  }
}

for (const sparse of [false, true]) {
  test(`${sparse ? "sparse" : "normal"} checkpoint protects distinct case-sensitive user directories`, { timeout: 10_000 }, async (context) => {
    await withRepository(async (root, store) => {
      for (const file of stateFiles) await put(root, file, "state before\n");
      const ordinary = [".Biny/user.txt", ".Agent/user.txt", "nested/.biny/user.txt", ".biny-notes.txt", "src/source.txt"];
      for (const file of ordinary) await put(root, file, "ordinary before\n");
      if (await sameDirectory(root, ".Biny", ".biny")) {
        context.skip("requires distinct case-sensitive directories");
        return;
      }
      await commit(root);
      if (sparse) await sparseCheckout(root);
      const gitBefore = await gitState(root);
      const checkpoint = await store.create("ordinary case-sensitive paths");
      assert.deepEqual(await snapshotFiles(root, checkpoint), [...ordinary].sort());
      for (const file of [...stateFiles, ...ordinary]) await put(root, file, "after edit\n");
      const summary = await store.restore(checkpoint.id);
      for (const file of ordinary) assert.equal(await readFile(path.join(root, file), "utf8"), "ordinary before\n");
      for (const file of stateFiles) assert.equal(await readFile(path.join(root, file), "utf8"), "after edit\n");
      assert.equal(summary.restoredFiles, ordinary.length);
      assert.deepEqual(summary.movedAside, []);
      assert.deepEqual(await gitState(root), gitBefore);
    });
  });
}

for (const operation of ["create", "restore"]) {
  for (const targetKind of ["inaccessible", "cyclic"]) {
    test(`${operation} preserves ordinary case-sensitive symlinks with ${targetKind} targets`, { timeout: 10_000 }, async (context) => {
      if (targetKind === "inaccessible" && process.getuid?.() === 0) {
        context.skip("requires enforced directory permissions");
        return;
      }
      await withRepository(async (root, store) => {
        for (const file of stateFiles) await put(root, file, "state before\n");
        try {
          await lstat(path.join(root, ".Biny"));
          context.skip("requires distinct case-sensitive directory entries");
          return;
        } catch (error) {
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        }
        const targetRoot = await mkdtemp(path.join(fixtureRoot, "biny-checkpoint-link-target-"));
        try {
          await mkdir(path.join(targetRoot, "child"));
          const target = targetKind === "inaccessible" ? path.join(targetRoot, "child") : ".Biny";
          await symlink(target, path.join(root, ".Biny"));
          await put(root, "source.txt", "before edit\n");
          await commit(root);
          const gitBefore = await gitState(root);
          const existing = operation === "restore" ? await existingCheckpoint(root) : undefined;
          if (targetKind === "inaccessible") await chmod(targetRoot, 0o000);
          await assert.rejects(stat(path.join(root, ".Biny")), { code: targetKind === "inaccessible" ? "EACCES" : "ELOOP" });

          const checkpoint = existing ?? await store.create("ordinary symlink");
          if (operation === "create") assert.deepEqual(await snapshotFiles(root, checkpoint), [".Biny", "source.txt"]);
          assert.equal(await git(root, ["show", `${checkpoint.commit}:.Biny`]), target);
          await put(root, "source.txt", "after edit\n");
          for (const file of stateFiles) await put(root, file, "current state\n");
          const summary = await store.restore(checkpoint.id);
          assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "before edit\n");
          assert.equal(await readlink(path.join(root, ".Biny")), target);
          for (const file of stateFiles) assert.equal(await readFile(path.join(root, file), "utf8"), "current state\n");
          assert.equal(summary.restoredFiles, 2);
          assert.deepEqual(summary.movedAside, []);
          assert.deepEqual(await gitState(root), gitBefore);
        } finally {
          await chmod(targetRoot, 0o700);
          await rm(targetRoot, { recursive: true, force: true });
        }
      });
    });
  }
}

async function withRepository(operation: (root: string, store: CheckpointStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(fixtureRoot, "biny-checkpoint-boundary-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "Biny Test"]);
    await git(root, ["config", "user.email", "test@biny.local"]);
    await git(root, ["config", "commit.gpgsign", "false"]);
    await ensureAgentDirs(root);
    const store = await CheckpointStore.open(root);
    assert.ok(store);
    await operation(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

async function commit(root: string): Promise<void> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "fixture"]);
}

async function sparseCheckout(root: string): Promise<void> {
  await git(root, ["sparse-checkout", "init", "--cone"]);
  await git(root, ["sparse-checkout", "set", "src"]);
}

async function existingCheckpoint(root: string): Promise<Checkpoint> {
  const tree = (await git(root, ["write-tree"])).trim();
  const commit = (await git(root, ["commit-tree", tree, "-m", "existing checkpoint"])).trim();
  const checkpoint: Checkpoint = { id: commit.slice(0, 12), label: "existing checkpoint", commit, createdAt: "2026-09-30T00:00:00.000Z" };
  await git(root, ["update-ref", `refs/biny/checkpoints/${checkpoint.id}`, commit]);
  await writeFile(path.join(agentDir(root), "checkpoints.json"), JSON.stringify({ version: 1, checkpoints: [checkpoint] }));
  return checkpoint;
}

async function sameDirectory(root: string, left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(path.join(root, left), { bigint: true }), stat(path.join(root, right), { bigint: true })]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function snapshotFiles(root: string, checkpoint: Checkpoint): Promise<string[]> {
  return (await git(root, ["ls-tree", "-r", "-z", "--name-only", checkpoint.commit])).split("\0").filter(Boolean).sort();
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
