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
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-assumed-"));
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
  for (const deleted of [false, true]) {
    test(`assume-unchanged ${deleted ? "deletion" : "working bytes"} captured with ${kind} index without changing user Git state`, async () => {
      await fixture(async (root, git, store) => {
        if (kind === "staged") { await writeFile(path.join(root, "tracked.txt"), "staged\n"); await git("add", "tracked.txt"); }
        if (kind === "split-index") await git("update-index", "--split-index");
        await git("update-index", "--assume-unchanged", "tracked.txt");
        if (deleted) await rm(path.join(root, "tracked.txt")); else await writeFile(path.join(root, "tracked.txt"), "user-before\n");
        const original = await gitState(root, git);
        const checkpoint = await store.create("before agent modification");
        assert.deepEqual(await gitState(root, git), original);
        const files = await git("ls-tree", "-r", "--name-only", checkpoint.commit);
        if (deleted) assert.equal(files.includes("tracked.txt"), false);
        else assert.equal(await git("show", `${checkpoint.commit}:tracked.txt`), "user-before\n");
        await writeFile(path.join(root, "tracked.txt"), "agent-after\n");
        const summary = await store.restore(checkpoint.id);
        if (deleted) {
          await assert.rejects(readFile(path.join(root, "tracked.txt")), { code: "ENOENT" });
          assert.deepEqual(summary.movedAside, ["tracked.txt"]); assert.ok(summary.trashDirectory);
          assert.equal(await readFile(path.join(root, summary.trashDirectory, "tracked.txt"), "utf8"), "agent-after\n");
        } else assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "user-before\n");
        assert.deepEqual(await gitState(root, git), original);
      });
    });
  }
}

test("NUL-delimited assume paths preserve spaces, Unicode and literal special characters", async () => {
  await fixture(async (root, git, store) => {
    const names = [" leading.txt", "中文.txt", "-leading-dash.txt", "[literal].txt", ...(process.platform === "win32" ? [] : ["line\nbreak.txt", "trailing.txt ", "literal*.txt"])];
    for (const name of names) await writeFile(path.join(root, name), "committed");
    await git("add", "--all"); await git("commit", "-qm", "names");
    await git("update-index", "--assume-unchanged", "--", ...names);
    for (const name of names) await writeFile(path.join(root, name), `before:${name}`);
    const original = await gitState(root, git); const checkpoint = await store.create("literal names");
    for (const name of names) await writeFile(path.join(root, name), "after");
    await store.restore(checkpoint.id);
    for (const name of names) assert.equal(await readFile(path.join(root, name), "utf8"), `before:${name}`);
    assert.deepEqual(await gitState(root, git), original);
  });
});

test("large assumed-file batch uses stdin without losing later paths", async () => {
  await fixture(async (root, git, store) => {
    const names = Array.from({ length: 240 }, (_, i) => `long-${i.toString().padStart(3, "0")}-${"x".repeat(150)}.txt`);
    for (const name of names) await writeFile(path.join(root, name), "committed");
    await git("add", "--all"); await git("commit", "-qm", "batch");
    // Setup batches remain below Windows argv limits; the production operation receives all names via stdin.
    for (let i = 0; i < names.length; i += 40) await git("update-index", "--assume-unchanged", "--", ...names.slice(i, i + 40));
    for (const name of names) await writeFile(path.join(root, name), "user-before");
    const original = await gitState(root, git); const checkpoint = await store.create("batch");
    assert.equal(await git("show", `${checkpoint.commit}:${names[0]}`), "user-before");
    assert.equal(await git("show", `${checkpoint.commit}:${names.at(-1)}`), "user-before");
    assert.deepEqual(await gitState(root, git), original);
  });
});

test("missing skip-worktree entry keeps its cached content even with assume-unchanged", async () => {
  await fixture(async (root, git, store) => {
    await git("update-index", "--assume-unchanged", "tracked.txt");
    await git("update-index", "--skip-worktree", "tracked.txt");
    assert.equal(await git("ls-files", "-v"), "s tracked.txt\n");
    await rm(path.join(root, "tracked.txt"));
    const original = await gitState(root, git); const checkpoint = await store.create("sparse absent");
    assert.equal(await git("show", `${checkpoint.commit}:tracked.txt`), "committed\n");
    assert.deepEqual(await gitState(root, git), original);
  });
});

test("ordinary untracked and intent-to-add files retain checkpoint behavior", async () => {
  await fixture(async (root, git, store) => {
    await writeFile(path.join(root, "new.txt"), "new before");
    await writeFile(path.join(root, "intent.txt"), "intent before"); await git("add", "-N", "intent.txt");
    const original = await gitState(root, git); const checkpoint = await store.create("new files");
    await writeFile(path.join(root, "new.txt"), "changed"); await writeFile(path.join(root, "intent.txt"), "changed");
    await store.restore(checkpoint.id);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "new before"); assert.equal(await readFile(path.join(root, "intent.txt"), "utf8"), "intent before");
    assert.deepEqual(await gitState(root, git), original);
  });
});

test("checkpoint creation preserves the real index for present skip-worktree files", async () => {
  await fixture(async (root, git, store) => {
    await git("update-index", "--skip-worktree", "tracked.txt");
    await writeFile(path.join(root, "tracked.txt"), "user-before\n");
    const original = await gitState(root, git); await store.create("sparse present");
    assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "user-before\n");
    assert.deepEqual(await gitState(root, git), original);
  });
});

test("Git helper rejects failed stdin delivery even when Git exits successfully", async () => {
  await fixture(async (_root, _git, store) => {
    const helper = store as unknown as { git(args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> };
    // --version exits successfully without consuming stdin; oversized input deterministically exceeds pipe capacity.
    await assert.rejects(helper.git(["--version"], undefined, "x".repeat(8 * 1024 * 1024)));
  });
});

test("early Git command failure is propagated without an unhandled stdin error", async () => {
  await fixture(async (_root, _git, store) => {
    const helper = store as unknown as { git(args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> };
    await assert.rejects(helper.git(["update-index", "--invalid-checkpoint-test-option"], undefined, "missing-file\0".repeat(600_000)), /Command failed/u);
  });
});
