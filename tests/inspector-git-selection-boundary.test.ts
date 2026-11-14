/** Exercise the production commit service with real, isolated Git repositories. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createFileConfigStore } from "../src/config/store.js";

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-git-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: repo })).stdout;
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const service = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "data")),
    createFileConfigStore({ workspaceRoot: repo }));
  const project = await service.createProject(repo);
  return { repo, git, service, project };
}
for (const selected of ["slot", "空 格\nslot"]) for (const stagedDeletion of [false, true]) {
  test(`directory replacing ${JSON.stringify(selected)} cannot stage its unselected descendants (staged deletion=${stagedDeletion})`, {
    skip: process.platform === "win32" && selected.includes("\n") ? "Windows filenames cannot contain LF" : false
  }, async t => {
    const { repo, git, service, project } = await fixture(t);
    await writeFile(path.join(repo, selected), "original selected file");
    await writeFile(path.join(repo, "unrelated.txt"), "original unrelated file");
    await writeFile(path.join(repo, "selected.txt"), "original other selection");
    await git("add", ".");
    await git("commit", "-m", "initial");
    await writeFile(path.join(repo, "unrelated.txt"), "unrelated staged version");
    await git("add", "unrelated.txt");
    await writeFile(path.join(repo, "unrelated.txt"), "unrelated worktree version");
    await writeFile(path.join(repo, "selected.txt"), "another selected change");
    await rm(path.join(repo, selected));
    if (stagedDeletion) await git("rm", "--cached", "--", selected);
    await mkdir(path.join(repo, selected));
    await writeFile(path.join(repo, selected, "unselected.env"), "SYNTHETIC_NOT_SELECTED");
    const snapshot = await service.projectGitStatus(project.id);
    assert.ok(snapshot.files.some(file => file.path === selected));
    assert.ok(snapshot.files.some(file => file.path === `${selected}/unselected.env`));
    const head = await git("rev-parse", "HEAD");
    const index = await readFile(path.join(repo, ".git/index"));
    const entries = await git("ls-files", "--stage", "-z");
    await assert.rejects(service.commitProjectFiles(project.id, {
      message: "only explicit files", paths: ["selected.txt", selected], revision: snapshot.revision
    }), /已变为目录/);
    assert.equal(await git("rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(path.join(repo, ".git/index")), index, "preflight rejection must not change any index bytes");
    assert.equal(await git("ls-files", "--stage", "-z"), entries);
    assert.equal(await git("show", ":unrelated.txt"), "unrelated staged version");
    assert.equal(await readFile(path.join(repo, selected, "unselected.env"), "utf8"), "SYNTHETIC_NOT_SELECTED");
  });
}
test("ordinary deletion and complete-file commit retain unrelated partial staging", async t => {
  const { repo, git, service, project } = await fixture(t);
  for (const name of ["deleted.txt", "selected.txt", "unrelated.txt"]) await writeFile(path.join(repo, name), "original");
  await git("add", ".");
  await git("commit", "-m", "initial");
  await writeFile(path.join(repo, "unrelated.txt"), "keep this index blob");
  await git("add", "unrelated.txt");
  await writeFile(path.join(repo, "unrelated.txt"), "keep this working tree");
  await rm(path.join(repo, "deleted.txt"));
  await writeFile(path.join(repo, "selected.txt"), "selected index");
  await git("add", "selected.txt");
  await writeFile(path.join(repo, "selected.txt"), "selected complete current content");
  const unselectedIndex = await git("ls-files", "--stage", "--", "unrelated.txt");
  const snapshot = await service.projectGitStatus(project.id);
  await service.commitProjectFiles(project.id, {
    message: "selected full contents", paths: ["deleted.txt", "selected.txt"], revision: snapshot.revision
  });
  assert.equal(await git("show", "HEAD:selected.txt"), "selected complete current content");
  await assert.rejects(git("show", "HEAD:deleted.txt"));
  assert.equal(await git("ls-files", "--stage", "--", "unrelated.txt"), unselectedIndex);
  assert.equal(await git("show", ":unrelated.txt"), "keep this index blob");
  assert.equal(await readFile(path.join(repo, "unrelated.txt"), "utf8"), "keep this working tree");
  assert.equal(await git("diff", "--cached", "--name-only"), "unrelated.txt\n");
});

test("a selected symbolic link to a directory commits only the link, not its target", {
  skip: process.platform === "win32" ? "Requires POSIX symbolic-link creation and Git link semantics" : false
}, async t => {
  const { repo, git, service, project } = await fixture(t);
  await writeFile(path.join(repo, "unrelated.txt"), "original");
  await git("add", "unrelated.txt");
  await git("commit", "-m", "initial");
  await writeFile(path.join(repo, "unrelated.txt"), "unrelated staged version");
  await git("add", "unrelated.txt");
  await writeFile(path.join(repo, "unrelated.txt"), "unrelated working tree");
  const unrelatedIndex = await git("ls-files", "--stage", "--", "unrelated.txt");
  await mkdir(path.join(repo, "target"));
  await writeFile(path.join(repo, "target", "unselected.env"), "SYNTHETIC_NOT_SELECTED");
  await symlink("target", path.join(repo, "selected-link"), "dir");

  const snapshot = await service.projectGitStatus(project.id);
  assert.ok(snapshot.files.some(file => file.path === "selected-link"));
  await service.commitProjectFiles(project.id, {
    message: "selected symbolic link", paths: ["selected-link"], revision: snapshot.revision
  });

  assert.equal(await git("show", "HEAD:selected-link"), "target");
  assert.match(await git("ls-tree", "HEAD", "--", "selected-link"), /^120000 blob /);
  assert.equal(await git("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"), "selected-link\0");
  assert.equal(await git("ls-files", "--stage", "--", "target"), "");
  assert.equal(await git("ls-files", "--stage", "--", "unrelated.txt"), unrelatedIndex);
  assert.equal(await git("show", ":unrelated.txt"), "unrelated staged version");
  assert.equal(await readFile(path.join(repo, "unrelated.txt"), "utf8"), "unrelated working tree");
  assert.equal(await readFile(path.join(repo, "target", "unselected.env"), "utf8"), "SYNTHETIC_NOT_SELECTED");
});
