import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CheckpointStore } from "../src/session/checkpointStore.js";
import { ensureAgentDirs } from "../src/session/store.js";

const run = promisify(execFile);

async function main(): Promise<void> {
  await testNonGitWorkspaceHasNoCheckpoints();
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-"));
  try {
    await initRepository(workspaceRoot);
    await ensureAgentDirs(workspaceRoot);
    await testRestoresEditsAndPreservesNewFiles(workspaceRoot);
    await testDoesNotTouchUserGitState(workspaceRoot);
    await testIgnoredFilesAreUntouched(workspaceRoot);
    await testTrackedFileIgnoredAfterCommitIsPreserved(workspaceRoot);
    await testUnusualFileNamesAreMovedAside(workspaceRoot);
    await testMissingStagedFileIsNotReportedAsMoved(workspaceRoot);
    await testSplitIndexCheckpoint();
    console.log("checkpoint tests passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** 不是 git 仓库时能力就是不可用，不伪造一个半吊子实现。 */
async function testNonGitWorkspaceHasNoCheckpoints(): Promise<void> {
  const plain = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-plain-"));
  try {
    assert.equal(await CheckpointStore.open(plain), undefined);
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
}

async function testRestoresEditsAndPreservesNewFiles(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, "keep.txt"), "original\n");
  await run("git", ["add", "-A"], { cwd: workspaceRoot });
  await run("git", ["commit", "-m", "base"], { cwd: workspaceRoot });

  const store = await CheckpointStore.open(workspaceRoot);
  assert.notEqual(store, undefined);
  const checkpoint = await store!.create("before edit");

  // agent 干了两件事：改坏一个文件，又新建一个文件。
  await writeFile(path.join(workspaceRoot, "keep.txt"), "broken\n");
  await writeFile(path.join(workspaceRoot, "added.txt"), "new work\n");

  const summary = await store!.restore(checkpoint.id);
  assert.equal(await readFile(path.join(workspaceRoot, "keep.txt"), "utf8"), "original\n", "edited file must go back");
  assert.deepEqual(summary.movedAside, ["added.txt"]);
  // 新增文件被移走而不是删除：撤销本身也必须可逆。
  const trashed = path.join(workspaceRoot, summary.trashDirectory ?? "", "added.txt");
  assert.equal(await readFile(trashed, "utf8"), "new work\n");
  await assert.rejects(readFile(path.join(workspaceRoot, "added.txt"), "utf8"));

  assert.equal((await store!.list()).some((entry) => entry.id === checkpoint.id), true);
  await assert.rejects(store!.restore("does-not-exist"), /No such checkpoint/);
}

/** 建快照和恢复都不能动用户的暂存区、HEAD 和分支历史。 */
async function testDoesNotTouchUserGitState(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, "staged.txt"), "staged content\n");
  await run("git", ["add", "staged.txt"], { cwd: workspaceRoot });
  const stagedBefore = (await run("git", ["diff", "--cached", "--name-only"], { cwd: workspaceRoot })).stdout.trim();
  const headBefore = (await run("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout.trim();
  const logBefore = (await run("git", ["log", "--oneline"], { cwd: workspaceRoot })).stdout.trim();

  const store = await CheckpointStore.open(workspaceRoot);
  const checkpoint = await store!.create("with staged changes");
  await writeFile(path.join(workspaceRoot, "keep.txt"), "changed again\n");
  await store!.restore(checkpoint.id);

  assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout.trim(), headBefore, "HEAD must not move");
  assert.equal((await run("git", ["log", "--oneline"], { cwd: workspaceRoot })).stdout.trim(), logBefore, "history must be unchanged");
  assert.equal((await run("git", ["diff", "--cached", "--name-only"], { cwd: workspaceRoot })).stdout.trim(), stagedBefore, "the staging area must be left alone");
  // 快照提交挂在 refs/biny 下，git log 看不到它们。
  const refs = (await run("git", ["for-each-ref", "--format=%(refname)", "refs/biny/checkpoints"], { cwd: workspaceRoot })).stdout;
  assert.equal(refs.includes(checkpoint.id), true);
}

/** 被 .gitignore 忽略的文件不进快照，恢复时也不该被碰。 */
async function testIgnoredFilesAreUntouched(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, ".gitignore"), "ignored/\n");
  await mkdir(path.join(workspaceRoot, "ignored"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "ignored", "local.txt"), "local only\n");
  await run("git", ["add", "-A"], { cwd: workspaceRoot });
  await run("git", ["commit", "-m", "gitignore"], { cwd: workspaceRoot });

  const store = await CheckpointStore.open(workspaceRoot);
  const checkpoint = await store!.create("with ignored files");
  await writeFile(path.join(workspaceRoot, "ignored", "local.txt"), "still mine\n");
  const summary = await store!.restore(checkpoint.id);

  assert.equal(await readFile(path.join(workspaceRoot, "ignored", "local.txt"), "utf8"), "still mine\n");
  assert.equal(summary.movedAside.includes("ignored/local.txt"), false);
}

/** 已跟踪文件即使后来命中 ignore，立即恢复快照也不能把它当成新增文件。 */
async function testTrackedFileIgnoredAfterCommitIsPreserved(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, "tracked-then-ignored.txt"), "already here\n");
  await run("git", ["add", "tracked-then-ignored.txt"], { cwd: workspaceRoot });
  await run("git", ["commit", "-m", "track file before ignore"], { cwd: workspaceRoot });
  await writeFile(path.join(workspaceRoot, ".gitignore"), "ignored/\ntracked-then-ignored.txt\n");

  const store = await CheckpointStore.open(workspaceRoot);
  assert.ok(store);
  const checkpoint = await store.create("tracked file now ignored");
  const stagedBefore = (await run("git", ["diff", "--cached", "--raw"], { cwd: workspaceRoot })).stdout;
  const summary = await store.restore(checkpoint.id);

  assert.equal(await readFile(path.join(workspaceRoot, "tracked-then-ignored.txt"), "utf8"), "already here\n");
  assert.equal(summary.movedAside.includes("tracked-then-ignored.txt"), false);
  assert.equal((await run("git", ["diff", "--cached", "--raw"], { cwd: workspaceRoot })).stdout, stagedBefore);
}

/** Git 的默认转义与逐行分割不能正确表示中文、空格和换行文件名。 */
async function testUnusualFileNamesAreMovedAside(workspaceRoot: string): Promise<void> {
  const store = await CheckpointStore.open(workspaceRoot);
  assert.ok(store);
  const checkpoint = await store.create("before unusual names");
  const names = ["新增.txt", " leading-space.txt", "trailing-space.txt ", "line\nbreak.txt"];
  for (const name of names) await writeFile(path.join(workspaceRoot, name), name);

  const summary = await store.restore(checkpoint.id);
  assert.deepEqual(summary.movedAside, [...names].sort());
  assert.ok(summary.trashDirectory);
  for (const name of names) {
    assert.equal(await readFile(path.join(workspaceRoot, summary.trashDirectory, name), "utf8"), name);
    await assert.rejects(readFile(path.join(workspaceRoot, name), "utf8"));
  }
}

/** 暂存区里仍有路径但工作区文件已消失时，不能声称已经移动该文件。 */
async function testMissingStagedFileIsNotReportedAsMoved(workspaceRoot: string): Promise<void> {
  const store = await CheckpointStore.open(workspaceRoot);
  assert.ok(store);
  const checkpoint = await store.create("before staged file disappears");
  const name = "staged-then-missing.txt";
  await writeFile(path.join(workspaceRoot, name), "staged only\n");
  await run("git", ["add", name], { cwd: workspaceRoot });
  await rm(path.join(workspaceRoot, name));
  const stagedBefore = (await run("git", ["diff", "--cached", "--raw"], { cwd: workspaceRoot })).stdout;

  const summary = await store.restore(checkpoint.id);
  assert.equal(summary.movedAside.includes(name), false);
  assert.equal((await run("git", ["diff", "--cached", "--raw"], { cwd: workspaceRoot })).stdout, stagedBefore);
}

/** 临时 index 必须能解析真实 index 的 sharedindex 引用。 */
async function testSplitIndexCheckpoint(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-split-"));
  try {
    await initRepository(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "split.txt"), "before\n");
    await run("git", ["add", "split.txt"], { cwd: workspaceRoot });
    await run("git", ["commit", "-m", "base"], { cwd: workspaceRoot });
    await run("git", ["update-index", "--split-index"], { cwd: workspaceRoot });
    const store = await CheckpointStore.open(workspaceRoot);
    assert.ok(store);
    const checkpoint = await store.create("split index");
    await writeFile(path.join(workspaceRoot, "split.txt"), "after\n");
    await store.restore(checkpoint.id);
    assert.equal(await readFile(path.join(workspaceRoot, "split.txt"), "utf8"), "before\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function initRepository(workspaceRoot: string): Promise<void> {
  await run("git", ["init", "-q", "-b", "main"], { cwd: workspaceRoot });
  await run("git", ["config", "user.email", "test@biny.local"], { cwd: workspaceRoot });
  await run("git", ["config", "user.name", "Biny Test"], { cwd: workspaceRoot });
  await run("git", ["config", "commit.gpgsign", "false"], { cwd: workspaceRoot });
}

await main();
