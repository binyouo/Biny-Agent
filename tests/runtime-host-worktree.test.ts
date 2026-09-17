import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  WorktreeBaseBranchMismatchError,
  WorktreeDirtyError,
  WorktreeManager,
  WorktreeUnavailableError,
  WorktreeUnmergedError
} from "../src/runtime/host/worktree.js";

const run = promisify(execFile);
let nonGit: string | undefined;

const repository = await mkdtemp(path.join(os.tmpdir(), "biny-worktree-test-"));
try {
  await run("git", ["init", "--quiet", "-b", "main"], { cwd: repository });
  await run("git", ["config", "user.name", "Biny Tests"], { cwd: repository });
  await run("git", ["config", "user.email", "biny-tests@example.invalid"], { cwd: repository });
  await writeFile(path.join(repository, ".gitignore"), ".biny/\n");
  await writeFile(path.join(repository, "README.md"), "base\n");
  await run("git", ["add", ".gitignore", "README.md"], { cwd: repository });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: repository });

  const manager = new WorktreeManager(repository, repository);
  const first = await manager.ensure("session-a");
  assert.equal(first.status, "active");
  assert.equal(first.baseBranch, "main");
  assert.match(first.branch, /^biny\/wt-session-/u);
  assert.equal((await manager.ensure("session-a")).worktreePath, first.worktreePath, "ensure 同一 session 必须幂等");

  await writeFile(path.join(first.worktreePath, "README.md"), "dirty\n");
  await assert.rejects(manager.remove("session-a"), (error: unknown) => error instanceof WorktreeDirtyError);
  assert.equal((await manager.get("session-a"))?.status, "kept", "脏 worktree 只能标记 kept，不能自动删除");

  await writeFile(path.join(first.worktreePath, "README.md"), "merged\n");
  await run("git", ["add", "README.md"], { cwd: first.worktreePath });
  await run("git", ["commit", "--quiet", "-m", "session change"], { cwd: first.worktreePath });
  const merged = await manager.merge("session-a", { deleteAfter: true });
  assert.equal(merged.record.status, "merged");
  assert.equal(merged.cleanup.status, "completed");
  assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "merged\n");
  assert.equal(await manager.get("session-a"), undefined, "deleteAfter 应删除注册表记录");

  const unmerged = await manager.ensure("session-b");
  await writeFile(path.join(unmerged.worktreePath, "README.md"), "unmerged\n");
  await run("git", ["add", "README.md"], { cwd: unmerged.worktreePath });
  await run("git", ["commit", "--quiet", "-m", "unmerged change"], { cwd: unmerged.worktreePath });
  await assert.rejects(manager.remove("session-b", true), (error: unknown) => error instanceof WorktreeUnmergedError);
  assert.deepEqual(await manager.get("session-b"), unmerged, "未合并分支拒绝删除时必须保留注册表记录");
  assert.equal(await fsPathExists(unmerged.worktreePath), true, "未合并分支拒绝删除时必须保留 worktree");
  await manager.remove("session-b", false);
  assert.equal(await manager.get("session-b"), undefined, "明确不删分支时可以只移除干净 worktree");

  const wrongBranch = await manager.ensure("session-wrong-branch");
  await writeFile(path.join(wrongBranch.worktreePath, "wrong-branch.txt"), "must stay isolated\n");
  await run("git", ["add", "wrong-branch.txt"], { cwd: wrongBranch.worktreePath });
  await run("git", ["commit", "--quiet", "-m", "wrong branch change"], { cwd: wrongBranch.worktreePath });
  await run("git", ["switch", "--quiet", "-c", "other"], { cwd: repository });
  await assert.rejects(
    manager.merge("session-wrong-branch"),
    (error: unknown) => error instanceof WorktreeBaseBranchMismatchError
  );
  assert.equal((await manager.get("session-wrong-branch"))?.status, "active");
  assert.equal(await fsPathExists(path.join(repository, "wrong-branch.txt")), false);
  await run("git", ["switch", "--quiet", "main"], { cwd: repository });
  await manager.remove("session-wrong-branch", false);

  const squash = await manager.ensure("session-squash");
  await writeFile(path.join(squash.worktreePath, "squash.txt"), "squashed\n");
  await run("git", ["add", "squash.txt"], { cwd: squash.worktreePath });
  await run("git", ["commit", "--quiet", "-m", "squash change"], { cwd: squash.worktreePath });
  const squashResult = await manager.merge("session-squash", { strategy: "squash", deleteAfter: true });
  assert.equal(squashResult.record.mergeStrategy, "squash");
  assert.match(squashResult.record.mergedCommit ?? "", /^[0-9a-f]{40}$/u);
  assert.equal(squashResult.cleanup.status, "completed");
  assert.equal(await manager.get("session-squash"), undefined);
  assert.equal(await readFile(path.join(repository, "squash.txt"), "utf8"), "squashed\n");

  nonGit = await mkdtemp(path.join(os.tmpdir(), "biny-non-git-"));
  const unavailable = new WorktreeManager(nonGit, repository);
  await assert.rejects(unavailable.ensure("session-b"), (error: unknown) => error instanceof WorktreeUnavailableError);
} finally {
  await rm(repository, { recursive: true, force: true });
  if (nonGit) await rm(nonGit, { recursive: true, force: true });
}

console.log("runtime-host worktree tests passed");

async function fsPathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
