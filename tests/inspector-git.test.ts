/** 真实临时仓库验证桌面提交的路径与暂存区边界。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createFileConfigStore } from "../src/config/store.js";
const exec = promisify(execFile);
test("空仓库首次提交、删除文件和本地远端推拉使用真实 Git", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-inspector-remote-"));
  const repo = path.join(dir, "repo"); await mkdir(repo);
  const git = async (...args: string[]): Promise<string> => (await exec("git", args, { cwd: repo })).stdout;
  try {
    await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
    const state = new DesktopStateStore(path.join(dir, "state.json")); await state.load();
    const service = new DesktopProjectService(state, new DesktopUserDataStore(path.join(dir, "data")), createFileConfigStore({ workspaceRoot: repo }));
    const project = await service.createProject(repo);
    await writeFile(path.join(repo, "first.txt"), "first");
    let snapshot = await service.projectGitStatus(project.id);
    await service.commitProjectFiles(project.id, { message: "initial", paths: ["first.txt"], revision: snapshot.revision });
    assert.equal((await git("show", "HEAD:first.txt")).trim(), "first");
    const remote = path.join(dir, "remote.git");
    await git("init", "--bare", "-b", "main", remote); await git("remote", "add", "origin", remote);
    await git("config", "branch.main.remote", "origin"); await git("config", "branch.main.merge", "refs/heads/main");
    await service.projectGitRemote(project.id, "push");
    await rm(path.join(repo, "first.txt"));
    snapshot = await service.projectGitStatus(project.id);
    await service.commitProjectFiles(project.id, { message: "delete", paths: ["first.txt"], revision: snapshot.revision });
    assert.equal((await git("ls-tree", "--name-only", "HEAD")).trim(), "");
    await service.projectGitRemote(project.id, "push");
    const peer = path.join(dir, "peer"); await git("clone", remote, peer);
    const peerGit = async (...args: string[]): Promise<void> => { await exec("git", args, { cwd: peer }); };
    await peerGit("config", "user.name", "Test"); await peerGit("config", "user.email", "test@example.invalid");
    await writeFile(path.join(peer, "remote.txt"), "remote"); await peerGit("add", "."); await peerGit("commit", "-m", "remote"); await peerGit("push");
    await service.projectGitRemote(project.id, "pull");
    assert.equal((await git("show", "HEAD:remote.txt")).trim(), "remote");
    await writeFile(path.join(repo, "remote.txt"), "dirty");
    await assert.rejects(service.projectGitRemote(project.id, "pull"), /未提交|改动|工作区/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("提交只包含选择文件，保留无关暂存内容，拒绝过期快照和越界路径", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-inspector-git-"));
  const repo = path.join(dir, "repo"); await mkdir(repo);
  const git = async (...args: string[]): Promise<string> => (await exec("git", args, { cwd: repo })).stdout;
  try {
    await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
    await writeFile(path.join(repo, "base.txt"), "base"); await git("add", "base.txt"); await git("commit", "-m", "init");
    const state = new DesktopStateStore(path.join(dir, "state.json")); await state.load();
    const service = new DesktopProjectService(state, new DesktopUserDataStore(path.join(dir, "data")), createFileConfigStore({ workspaceRoot: repo }));
    const project = await service.createProject(repo);
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ packageManager: "pnpm@10.6.5", scripts: { dev: "vite" } }));
    assert.equal(await service.projectPreviewCommand(project.id), "pnpm run dev");
    await rm(path.join(repo, "package.json"));
    const selected = "空 格\nfile.txt";
    await writeFile(path.join(repo, selected), "selected");
    await writeFile(path.join(repo, "unrelated.txt"), "staged"); await git("add", "unrelated.txt");
    const before = await service.projectGitStatus(project.id);
    assert.ok(before.files.some((file) => file.path === selected));
    await assert.rejects(service.commitProjectFiles(project.id, { message: "test", paths: ["../outside"], revision: before.revision }), /文件|路径/);
    await service.commitProjectFiles(project.id, { message: "feat(test): selected", paths: [selected], revision: before.revision });
    assert.equal(await git("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"), `${selected}\0`);
    assert.equal(await git("diff", "--cached", "--name-only"), "unrelated.txt\n");
    await assert.rejects(service.commitProjectFiles(project.id, { message: "stale", paths: ["unrelated.txt"], revision: before.revision }), /刷新/);
    await git("config", "core.hooksPath", path.join(dir, "hooks")); await mkdir(path.join(dir, "hooks"));
    await writeFile(path.join(dir, "hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const current = await service.projectGitStatus(project.id);
    await assert.rejects(service.commitProjectFiles(project.id, { message: "fail", paths: ["unrelated.txt"], revision: current.revision }), /提交失败/);
    assert.equal(await git("diff", "--cached", "--name-only"), "unrelated.txt\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("未初始化项目可从提交页初始化，已有仓库不会被重新初始化", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-inspector-init-"));
  try {
    const state = new DesktopStateStore(path.join(dir, "state.json")); await state.load();
    const service = new DesktopProjectService(state, new DesktopUserDataStore(path.join(dir, "data")), createFileConfigStore({ workspaceRoot: dir }));
    const project = await service.createProject(dir);
    await assert.rejects(service.projectGitStatus(project.id), /不是 Git 仓库/);
    const snapshot = await service.initializeProjectGit(project.id);
    assert.ok(snapshot.files.some((file) => file.path === "state.json"));
    assert.equal((await service.projectGitStatus(project.id)).revision, snapshot.revision);
    await assert.rejects(service.initializeProjectGit(project.id), /已经是 Git 仓库/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("开发服务器预检区分缺少 package.json、缺少脚本与可运行项目", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-inspector-preview-"));
  try {
    const state = new DesktopStateStore(path.join(dir, "state.json")); await state.load();
    const service = new DesktopProjectService(state, new DesktopUserDataStore(path.join(dir, "data")), createFileConfigStore({ workspaceRoot: dir }));
    const project = await service.createProject(dir);
    assert.deepEqual(await service.projectPreviewAvailability(project.id), { available: false, reason: "项目没有 package.json 或 HTML 页面，无法自动运行预览。" });
    await assert.rejects(service.projectPreviewCommand(project.id), /项目没有 package.json/);
    await writeFile(path.join(dir, "package.json"), "null");
    assert.deepEqual(await service.projectPreviewAvailability(project.id), { available: false, reason: "package.json 格式有误，无法识别开发脚本。" });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    assert.deepEqual(await service.projectPreviewAvailability(project.id), { available: false, reason: "项目没有 dev、start 或 serve 脚本，也没有 HTML 页面。" });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    assert.deepEqual(await service.projectPreviewAvailability(project.id), { available: true, command: "npm run dev" });
    await rm(path.join(dir, "package.json"));
    await mkdir(path.join(dir, "pages"));
    await writeFile(path.join(dir, "pages", "demo.html"), "<!doctype html><title>Nested</title>");
    assert.deepEqual(await service.projectPreviewAvailability(project.id), { available: true, kind: "static", entry: "pages/demo.html", entries: ["pages/demo.html"] });
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Preview</title>");
    assert.deepEqual(await service.projectPreviewAvailability(project.id), { available: true, kind: "static", entry: "index.html", entries: ["index.html", "pages/demo.html"] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
