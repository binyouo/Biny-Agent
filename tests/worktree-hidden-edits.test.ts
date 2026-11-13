/** Actual WorktreeManager, catalog/storage dependencies and Git; no runtime collaborators are mocked. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { WorktreeManager, WorktreeDirtyError, type WorktreeRecord } from "../src/runtime/host/worktree.js";

const exec = promisify(execFile);
async function fixture(run: (f: { repo: string; record: WorktreeRecord; manager: WorktreeManager; git(cwd: string, ...args: string[]): Promise<string>; commit(): Promise<string>; preserved(head: string): Promise<void> }) => Promise<void>, task = false) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-worktree-head-")); const repo = path.join(root, "repo"); await mkdir(repo);
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  try {
    await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Test"); await git(repo, "config", "user.email", "test@example.test");
    await writeFile(path.join(repo, ".gitignore"), ".biny/\n"); await writeFile(path.join(repo, "base.txt"), "base"); await git(repo, "add", "."); await git(repo, "commit", "-m", "baseline");
    const manager = new WorktreeManager(repo, repo); const record = await manager.ensure("session-one", task ? { taskRunId: "task", sourceRoot: repo } : undefined);
    await run({ repo, record, manager, git,
      async commit() { await writeFile(path.join(record.worktreePath, "important.txt"), "unmerged user work"); await git(record.worktreePath, "add", "important.txt"); await git(record.worktreePath, "commit", "-m", "user work"); return await git(record.worktreePath, "rev-parse", "HEAD"); },
      async preserved(head) { await access(record.worktreePath); assert.equal(await git(record.worktreePath, "rev-parse", "HEAD"), head); assert.ok(await new WorktreeManager(repo, repo).get(record.sessionId)); assert.equal(await git(repo, "rev-parse", "HEAD"), record.baseCommit); }
    });
  } finally { if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

for (const flag of ["assume-unchanged", "skip-worktree"] as const) {
  for (const operation of ["release", "reconcile", "remove", "remove-checkout"] as const) {
    test(`${operation} preserves tracked edits hidden by ${flag}`, async () => {
      await fixture(async f => {
        await f.git(f.record.worktreePath, "update-index", `--${flag}`, "base.txt");
        await writeFile(path.join(f.record.worktreePath, "base.txt"), "important user edits");
        assert.equal(await f.git(f.record.worktreePath, "status", "--porcelain"), "");
        const indexPath = await f.git(f.record.worktreePath, "rev-parse", "--git-path", "index");
        const before = await readFile(path.resolve(f.record.worktreePath, indexPath));
        if (operation === "release") await f.manager.releaseUnchangedTask(f.record.sessionId);
        else if (operation === "reconcile") await f.manager.reconcile();
        else await assert.rejects(f.manager.remove(f.record.sessionId, operation === "remove"), WorktreeDirtyError);
        assert.equal(await readFile(path.join(f.record.worktreePath, "base.txt"), "utf8"), "important user edits");
        assert.deepEqual(await readFile(path.resolve(f.record.worktreePath, indexPath)), before);
        await f.preserved(f.record.baseCommit);
      }, operation === "release");
    });
  }
}

for (const flags of [["assume-unchanged"], ["skip-worktree"], ["assume-unchanged", "skip-worktree"]]) {
  test(`clean flagged checkout is conservatively retained until flags are cleared: ${flags.join("+")}`, async () => {
    await fixture(async f => {
      for (const flag of flags) await f.git(f.record.worktreePath, "update-index", `--${flag}`, "base.txt");
      assert.equal((await f.manager.status(f.record.sessionId))[0]!.dirty, false);
      await f.manager.releaseUnchangedTask(f.record.sessionId);
      await f.preserved(f.record.baseCommit);
      assert.equal((await f.manager.get(f.record.sessionId))!.status, "kept");
      assert.match((await f.manager.get(f.record.sessionId))!.cleanupError!, /index flags that can hide local edits/u);
      assert.doesNotMatch((await f.manager.get(f.record.sessionId))!.cleanupError!, /contains uncommitted changes/u);
      for (const flag of flags) await f.git(f.record.worktreePath, "update-index", `--no-${flag}`, "base.txt");
      await f.manager.releaseUnchangedTask(f.record.sessionId);
      assert.equal(await f.manager.get(f.record.sessionId), undefined);
      await assert.rejects(access(f.record.worktreePath));
    }, true);
  });
}

for (const strategy of ["merge", "squash"] as const) {
  test(`${strategy} can complete without deleting hidden edits during cleanup`, async () => {
    await fixture(async f => {
      await f.commit();
      await f.git(f.record.worktreePath, "update-index", "--assume-unchanged", "base.txt");
      await writeFile(path.join(f.record.worktreePath, "base.txt"), "private uncommitted edits");
      const result = await f.manager.merge(f.record.sessionId, { strategy, deleteAfter: true });
      assert.equal(result.record.status, "merged");
      assert.equal(result.cleanup.status, "failed");
      assert.equal(await readFile(path.join(f.record.worktreePath, "base.txt"), "utf8"), "private uncommitted edits");
      assert.equal(await readFile(path.join(f.repo, "base.txt"), "utf8"), "base");
      assert.equal(await readFile(path.join(f.repo, "important.txt"), "utf8"), "unmerged user work");
      assert.ok(await f.manager.get(f.record.sessionId));
      assert.equal(await f.git(f.repo, "rev-parse", "--verify", f.record.branch), await f.git(f.record.worktreePath, "rev-parse", "HEAD"));
    });
  });
}
