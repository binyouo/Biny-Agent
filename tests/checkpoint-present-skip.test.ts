/** Full production checkpoint/store/lock modules with real isolated Git, files and SQLite locks. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CheckpointStore } from "../src/session/checkpointStore.js";
const run = promisify(execFile);

async function fixture(body: (root: string, git: (...args: string[]) => Promise<string>, store: CheckpointStore) => Promise<void>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-present-skip-"));
  const root = path.join(temporary, "workspace"); const oldAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
  try {
    await mkdir(root);
    const git = async (...args: string[]) => (await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
    await git("init", "-q", "-b", "main"); await git("config", "user.name", "Checkpoint Test"); await git("config", "user.email", "checkpoint@example.test"); await git("config", "commit.gpgsign", "false");
    await writeFile(path.join(root, "tracked.txt"), "committed\n");
    await git("add", "tracked.txt"); await git("commit", "-qm", "base");
    const store = await CheckpointStore.open(root); assert.ok(store);
    await body(root, git, store);
  } finally {
    if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
}
async function gitState(root: string, git: (...args: string[]) => Promise<string>) {
  return { index: await readFile(path.join(root, ".git", "index")), flags: await git("ls-files", "-v", "-z"), head: await git("rev-parse", "HEAD"), staged: await git("diff", "--cached", "--raw", "-z") };
}

for (const kind of ["ordinary", "staged", "split-index"] as const) {
  test(`present skip-worktree bytes survive create/restore with ${kind} index`, async () => {
    await fixture(async (root, git, store) => {
      if (kind === "staged") { await writeFile(path.join(root, "tracked.txt"), "staged\n"); await git("add", "tracked.txt"); }
      if (kind === "split-index") await git("update-index", "--split-index");
      await git("update-index", "--skip-worktree", "tracked.txt");
      await writeFile(path.join(root, "tracked.txt"), "user-before\n");
      const original = await gitState(root, git); const checkpoint = await store.create("before agent modification");
      assert.deepEqual(await gitState(root, git), original);
      assert.equal(await git("show", `${checkpoint.commit}:tracked.txt`), "user-before\n");
      await writeFile(path.join(root, "tracked.txt"), "agent-after\n"); await store.restore(checkpoint.id);
      assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "user-before\n");
      assert.deepEqual(await gitState(root, git), original);
    });
  });
}
for (const assumed of [false, true]) {
  test(`missing sparse projection retains cached bytes (assume-unchanged=${assumed})`, async () => {
    await fixture(async (root, git, store) => {
      if (assumed) await git("update-index", "--assume-unchanged", "tracked.txt");
      await git("update-index", "--skip-worktree", "tracked.txt");
      assert.equal(await git("ls-files", "-v"), `${assumed ? "s" : "S"} tracked.txt\n`);
      await rm(path.join(root, "tracked.txt")); const original = await gitState(root, git);
      const checkpoint = await store.create("absent projection");
      assert.equal(await git("show", `${checkpoint.commit}:tracked.txt`), "committed\n");
      await assert.rejects(readFile(path.join(root, "tracked.txt")), { code: "ENOENT" });
      assert.deepEqual(await gitState(root, git), original);
    });
  });
}
test("present and absent skip paths are independently classified in each checkpoint", async () => {
  await fixture(async (root, git, store) => {
    await git("update-index", "--skip-worktree", "tracked.txt");
    const original = await gitState(root, git);
    await rm(path.join(root, "tracked.txt"));
    const absent = await store.create("absent");
    assert.equal(await git("show", `${absent.commit}:tracked.txt`), "committed\n");
    await writeFile(path.join(root, "tracked.txt"), "materialized\n");
    const present = await store.create("present");
    assert.equal(await git("show", `${present.commit}:tracked.txt`), "materialized\n");
    await rm(path.join(root, "tracked.txt")); await store.restore(present.id);
    assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "materialized\n");
    assert.deepEqual(await gitState(root, git), original);
  });
});
test("NUL-delimited present skip names are literal, with a batch exceeding pipe capacity", async () => {
  await fixture(async (root, git, store) => {
    const names = [" leading.txt", "中文.txt", "-dash.txt", "[literal].txt", ...Array.from({ length: 600 }, (_, i) => `${i}-${"long".repeat(32)}.txt`)];
    if (process.platform !== "win32") names.push("line\nbreak.txt", "trailing ", "star*.txt");
    for (const name of names) await writeFile(path.join(root, name), "cached");
    await git("add", "-A"); await git("commit", "-qm", "paths");
    for (let i = 0; i < names.length; i += 40) await git("update-index", "--skip-worktree", "--", ...names.slice(i, i + 40));
    for (const name of names) await writeFile(path.join(root, name), `before:${name}`);
    const original = await gitState(root, git); const checkpoint = await store.create("literal names");
    for (const name of names) assert.equal(await git("show", `${checkpoint.commit}:${name}`), `before:${name}`);
    assert.deepEqual(await gitState(root, git), original);
  });
});
test("ordinary tracked deletion and untracked content still use worktree state", async () => {
  await fixture(async (root, git, store) => {
    await rm(path.join(root, "tracked.txt")); await writeFile(path.join(root, "new.txt"), "new before");
    const original = await gitState(root, git); const checkpoint = await store.create("normal changes");
    assert.equal(await git("ls-tree", "-r", "--name-only", checkpoint.commit), "new.txt\n");
    await writeFile(path.join(root, "new.txt"), "agent"); await store.restore(checkpoint.id);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "new before");
    assert.deepEqual(await gitState(root, git), original);
  });
});
test("excluded state files are not reintroduced when present and skip-worktree", async () => {
  await fixture(async (root, git, store) => {
    await mkdir(path.join(root, ".biny")); await writeFile(path.join(root, ".biny", "secret"), "cached state");
    await git("add", "-f", ".biny/secret"); await git("commit", "-qm", "state");
    await git("update-index", "--skip-worktree", ".biny/secret");
    await writeFile(path.join(root, ".biny", "secret"), "live state");
    const original = await gitState(root, git); const checkpoint = await store.create("exclude state");
    assert.equal((await git("ls-tree", "-r", "--name-only", checkpoint.commit)).includes(".biny/"), false);
    assert.equal(await readFile(path.join(root, ".biny", "secret"), "utf8"), "live state");
    assert.deepEqual(await gitState(root, git), original);
  });
});
test("successful Git early exit cannot hide incomplete stdin delivery", async () => {
  await fixture(async (_root, _git, store) => {
    const helper = store as unknown as { git(args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> };
    await assert.rejects(helper.git(["--version"], undefined, "x".repeat(8 * 1024 * 1024)));
  });
});
test("nonzero Git early exit propagates without unhandled stdin error", async () => {
  await fixture(async (_root, _git, store) => {
    const helper = store as unknown as { git(args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> };
    await assert.rejects(helper.git(["update-index", "--invalid-checkpoint-test-option"], undefined, "x".repeat(8 * 1024 * 1024)), /Command failed/u);
  });
});
