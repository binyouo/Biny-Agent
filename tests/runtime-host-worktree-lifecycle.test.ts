import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { WorktreeManager, WorktreeUnavailableError, WorktreeUnmergedError } from "../src/runtime/host/worktree.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worktree-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--quiet", "-b", "main"]);
  await git(root, ["config", "user.name", "Biny Tests"]);
  await git(root, ["config", "user.email", "biny-tests@example.invalid"]);
  await writeFile(path.join(root, ".gitignore"), ".biny/\n");
  await git(root, ["add", ".gitignore"]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  return { root, manager: new WorktreeManager(root, root) };
}

test("squash cleanup cannot delete commits added after the merge", async t => {
  const { root, manager } = await fixture(t);
  const record = await manager.ensure("squash-followup");
  await writeFile(path.join(record.worktreePath, "first.txt"), "first\n");
  await git(record.worktreePath, ["add", "first.txt"]);
  await git(record.worktreePath, ["commit", "--quiet", "-m", "first"]);
  await manager.merge(record.sessionId, { strategy: "squash" });
  await writeFile(path.join(record.worktreePath, "second.txt"), "second\n");
  await git(record.worktreePath, ["add", "second.txt"]);
  await git(record.worktreePath, ["commit", "--quiet", "-m", "second"]);
  assert.equal((await manager.status(record.sessionId))[0]!.mergedIntoBase, false);
  await assert.rejects(manager.remove(record.sessionId, true), WorktreeUnmergedError);
  assert.equal(await readFile(path.join(record.worktreePath, "second.txt"), "utf8"), "second\n");
  assert.equal(await git(root, ["show", `${record.branch}:second.txt`]), "second");
  await assert.rejects(access(path.join(root, "second.txt")), { code: "ENOENT" });
});

test("legacy squash records without a source version cannot authorize branch deletion", async t => {
  const { manager } = await fixture(t);
  const record = await manager.ensure("legacy-squash");
  await writeFile(path.join(record.worktreePath, "first.txt"), "first\n");
  await git(record.worktreePath, ["add", "first.txt"]);
  await git(record.worktreePath, ["commit", "--quiet", "-m", "first"]);
  await manager.merge(record.sessionId, { strategy: "squash" });
  const persisted = JSON.parse(await readFile(manager.registryPath, "utf8"));
  delete persisted.records[0].mergedSourceCommit;
  await writeFile(manager.registryPath, JSON.stringify(persisted));
  assert.equal((await manager.status(record.sessionId))[0]!.mergedIntoBase, false);
  await assert.rejects(manager.remove(record.sessionId, true), WorktreeUnmergedError);
  await access(record.worktreePath);
});

test("a missing checkout preserves registration across reconciliation and refuses a replacement", async t => {
  const { root, manager } = await fixture(t);
  const record = await manager.ensure("missing-checkout");
  await writeFile(path.join(record.worktreePath, "saved.txt"), "saved\n");
  await git(record.worktreePath, ["add", "saved.txt"]);
  await git(record.worktreePath, ["commit", "--quiet", "-m", "saved"]);
  const branches = await git(root, ["branch", "--format=%(refname:short)"]);
  await git(root, ["worktree", "remove", record.worktreePath]);
  await assert.rejects(manager.ensure(record.sessionId), WorktreeUnavailableError);
  assert.deepEqual(await manager.get(record.sessionId), record);
  await manager.reconcile();
  assert.equal((await manager.get(record.sessionId))?.worktreePath, record.worktreePath);
  assert.equal((await manager.status(record.sessionId))[0]!.exists, false);
  await assert.rejects(manager.runtimeFactoryOptions(record.sessionId), WorktreeUnavailableError);
  await assert.rejects(manager.ensure(record.sessionId), WorktreeUnavailableError);
  assert.equal(await git(root, ["branch", "--format=%(refname:short)"]), branches);
  assert.equal(await git(root, ["show", `${record.branch}:saved.txt`]), "saved");
});
