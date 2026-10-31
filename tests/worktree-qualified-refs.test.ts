/** Actual WorktreeManager, catalog/storage dependencies and Git; no runtime collaborators are mocked. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { WorktreeManager, WorktreeUnmergedError, type WorktreeRecord } from "../src/runtime/host/worktree.js";

const exec = promisify(execFile);
async function fixture(run: (f: { repo: string; record: WorktreeRecord; manager: WorktreeManager; git(cwd: string, ...args: string[]): Promise<string>; commit(): Promise<string>; preserved(head: string): Promise<void> }) => Promise<void>, tagBefore = false) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-worktree-refs-")); const repo = path.join(root, "repo"); await mkdir(repo);
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  try {
    await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Test"); await git(repo, "config", "user.email", "test@example.test");
    await writeFile(path.join(repo, ".gitignore"), ".biny/\n"); await writeFile(path.join(repo, "base.txt"), "base"); await git(repo, "add", "."); await git(repo, "commit", "-m", "baseline");
    if (tagBefore) await git(repo, "tag", "main");
    const manager = new WorktreeManager(repo, repo); const record = await manager.ensure("session-one");
    await run({ repo, record, manager, git,
      async commit() { await writeFile(path.join(record.worktreePath, "important.txt"), "unmerged user work"); await git(record.worktreePath, "add", "important.txt"); await git(record.worktreePath, "commit", "-m", "user work"); return await git(record.worktreePath, "rev-parse", "HEAD"); },
      async preserved(head) { await access(record.worktreePath); assert.equal(await git(record.worktreePath, "rev-parse", "HEAD"), head); assert.ok(await new WorktreeManager(repo, repo).get(record.sessionId)); assert.equal(await git(repo, "rev-parse", "HEAD"), record.baseCommit); }
    });
  } finally { if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

for (const annotated of [false, true]) {
  const kind = annotated ? "annotated" : "lightweight";
  test(`${kind} source tag cannot authorize deletion after new post-squash work`, async () => {
    await fixture(async f => {
      const source = await f.commit();
      await f.manager.merge(f.record.sessionId, { strategy: "squash" });
      await f.git(f.repo, "tag", ...(annotated ? ["-a", "-m", "old source"] : []), f.record.branch, source);
      await writeFile(path.join(f.record.worktreePath, "later.txt"), "new unmerged work");
      await f.git(f.record.worktreePath, "add", "later.txt"); await f.git(f.record.worktreePath, "commit", "-m", "later work");
      const head = await f.git(f.record.worktreePath, "rev-parse", "HEAD");
      const primary = await f.git(f.repo, "rev-parse", "HEAD");
      const status = (await f.manager.status(f.record.sessionId))[0]!;
      await assert.rejects(f.manager.remove(f.record.sessionId, true), WorktreeUnmergedError);
      assert.equal(status.mergedIntoBase, false);
      assert.equal(await f.git(f.record.worktreePath, "rev-parse", "HEAD"), head);
      assert.equal(await f.git(f.repo, "rev-parse", `refs/heads/${f.record.branch}`), head);
      assert.equal(await readFile(path.join(f.record.worktreePath, "later.txt"), "utf8"), "new unmerged work");
      assert.equal(await f.git(f.repo, "rev-parse", "HEAD"), primary);
      assert.ok(await new WorktreeManager(f.repo, f.repo).get(f.record.sessionId));
    });
  });
  for (const strategy of ["merge", "squash"] as const) {
    test(`${strategy} uses the branch rather than a stale ${kind} source tag`, async () => {
      await fixture(async f => {
        await f.git(f.repo, "tag", ...(annotated ? ["-a", "-m", "old source"] : []), f.record.branch, f.record.baseCommit);
        const source = await f.commit();
        const status = (await f.manager.status(f.record.sessionId))[0]!;
        const result = await f.manager.merge(f.record.sessionId, { strategy, deleteAfter: true });
        assert.equal(status.mergedIntoBase, false);
        assert.equal(result.record.mergedSourceCommit, source); assert.equal(result.cleanup.status, "completed");
        assert.equal(await readFile(path.join(f.repo, "important.txt"), "utf8"), "unmerged user work");
        assert.equal(await f.manager.get(f.record.sessionId), undefined); await assert.rejects(access(f.record.worktreePath));
        assert.equal(await f.git(f.repo, "rev-parse", `refs/tags/${f.record.branch}^{commit}`), f.record.baseCommit);
      });
    });
  }
}
for (const before of [false, true]) {
  for (const strategy of ["merge", "squash"] as const) {
    test(`${strategy} honors the real base branch with a tag created ${before ? "before" : "after"} registration`, async () => {
      await fixture(async f => {
        if (!before) await f.git(f.repo, "tag", "main", f.record.baseCommit);
        assert.equal(f.record.baseBranch, "main"); const source = await f.commit();
        const result = await f.manager.merge(f.record.sessionId, { strategy, deleteAfter: true });
        assert.equal(result.record.mergedSourceCommit, source); assert.equal(result.cleanup.status, "completed");
        assert.equal(await readFile(path.join(f.repo, "important.txt"), "utf8"), "unmerged user work");
        assert.equal(await f.manager.get(f.record.sessionId), undefined); await assert.rejects(access(f.record.worktreePath));
        assert.equal(await f.git(f.repo, "rev-parse", "refs/tags/main"), f.record.baseCommit);
      }, before);
    });
  }
}
test("reconciliation preserves new work behind a stale same-named source tag", async () => {
  await fixture(async f => {
    await f.git(f.repo, "tag", f.record.branch, f.record.baseCommit); const head = await f.commit();
    const result = await f.manager.reconcile(); assert.deepEqual(result.removed, []); assert.ok(result.orphaned.includes(f.record.sessionId)); await f.preserved(head);
  });
});
for (const strategy of ["merge", "squash"] as const) {
  test(`ordinary ${strategy} and cleanup remain available without ambiguous refs`, async () => {
    await fixture(async f => { const source = await f.commit(); const result = await f.manager.merge(f.record.sessionId, { strategy, deleteAfter: true }); assert.equal(result.record.mergedSourceCommit, source); assert.equal(result.cleanup.status, "completed"); assert.equal(await readFile(path.join(f.repo, "important.txt"), "utf8"), "unmerged user work"); });
  });
}
test("ordinary unmerged removal keeps the checkout and branch", async () => {
  await fixture(async f => { const head = await f.commit(); await assert.rejects(f.manager.remove(f.record.sessionId, true), WorktreeUnmergedError); await f.preserved(head); });
});

for (const strategy of ["merge", "squash"] as const) {
  test(`a stale base tag does not hide completed ${strategy} evidence`, async () => {
    await fixture(async f => {
      await f.commit(); await f.manager.merge(f.record.sessionId, { strategy });
      await f.git(f.repo, "tag", "main", f.record.baseCommit);
      assert.equal((await f.manager.status(f.record.sessionId))[0]!.mergedIntoBase, true);
      await f.manager.remove(f.record.sessionId, true);
      assert.equal(await f.manager.get(f.record.sessionId), undefined); await assert.rejects(access(f.record.worktreePath));
      assert.equal(await readFile(path.join(f.repo, "important.txt"), "utf8"), "unmerged user work");
    });
  });
}
