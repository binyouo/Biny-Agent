/** Actual WorktreeManager, catalog/storage dependencies and Git; no runtime collaborators are mocked. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { WorktreeManager, WorktreeUnavailableError, WorktreeUnmergedError, type WorktreeRecord } from "../src/runtime/host/worktree.js";

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

for (const drift of ["detached", "different branch"] as const) {
  for (const operation of ["remove checkout", "remove branch", "merge", "squash"] as const) {
    test(`${operation} preserves a committed checkout on ${drift}`, async () => {
      await fixture(async f => {
        await f.git(f.record.worktreePath, "checkout", ...(drift === "detached" ? ["--detach"] : ["-b", "other-branch"]));
        const head = await f.commit();
        const status = (await f.manager.status(f.record.sessionId))[0]!; assert.equal(status.dirty, false);
        const operationResult = operation.startsWith("remove") ? f.manager.remove(f.record.sessionId, operation === "remove branch") : f.manager.merge(f.record.sessionId, { strategy: operation === "squash" ? "squash" : "merge", deleteAfter: true });
        await assert.rejects(operationResult, WorktreeUnavailableError); assert.equal(status.mergedIntoBase, false); await f.preserved(head);
        assert.deepEqual(await f.manager.get(f.record.sessionId), f.record);
        assert.equal(await readFile(path.join(f.record.worktreePath, "important.txt"), "utf8"), "unmerged user work");
        assert.equal(await f.git(f.repo, "rev-parse", f.record.branch), f.record.baseCommit);
      });
    });
  }
  test(`catalog reconciliation keeps a ${drift} checkout with unmerged work`, async () => {
    await fixture(async f => {
      await f.git(f.record.worktreePath, "checkout", ...(drift === "detached" ? ["--detach"] : ["-b", "other-branch"])); const head = await f.commit();
      const reconciled = await f.manager.reconcile(); assert.deepEqual(reconciled.removed, []); assert.ok(reconciled.orphaned.includes(f.record.sessionId)); await f.preserved(head);
    });
  });
}

test("unchanged registered task checkout still cleans up normally", async () => {
  await fixture(async f => { await f.manager.releaseUnchangedTask(f.record.sessionId); assert.equal(await f.manager.get(f.record.sessionId), undefined); await assert.rejects(access(f.record.worktreePath)); }, true);
});
test("unchanged task on a different branch is retained instead of deleting a drifted checkout", async () => {
  await fixture(async f => { await f.git(f.record.worktreePath, "checkout", "-b", "other-branch"); await f.manager.releaseUnchangedTask(f.record.sessionId); await f.preserved(f.record.baseCommit); assert.equal((await f.manager.get(f.record.sessionId))!.status, "kept"); }, true);
});
test("registered unmerged branch cannot be deleted, but explicit checkout-only removal retains its commit", async () => {
  await fixture(async f => { const head = await f.commit(); await assert.rejects(f.manager.remove(f.record.sessionId, true), WorktreeUnmergedError); await f.preserved(head); await f.manager.remove(f.record.sessionId, false); assert.equal(await f.git(f.repo, "rev-parse", f.record.branch), head); await assert.rejects(access(f.record.worktreePath)); });
});
for (const strategy of ["merge", "squash"] as const) {
  test(`registered ${strategy} and cleanup retain successful merge semantics`, async () => {
    await fixture(async f => { await f.commit(); const result = await f.manager.merge(f.record.sessionId, { strategy, deleteAfter: true }); assert.equal(result.cleanup.status, "completed"); assert.equal(await readFile(path.join(f.repo, "important.txt"), "utf8"), "unmerged user work"); assert.equal(await f.manager.get(f.record.sessionId), undefined); await assert.rejects(access(f.record.worktreePath)); });
  });
}

test("an unrelated same-named tag does not change the registered HEAD branch identity", async () => {
  await fixture(async f => { await f.git(f.repo, "tag", f.record.branch); assert.equal((await f.manager.status(f.record.sessionId))[0]!.mergedIntoBase, true); await f.manager.remove(f.record.sessionId, false); assert.equal(await f.manager.get(f.record.sessionId), undefined); });
});
