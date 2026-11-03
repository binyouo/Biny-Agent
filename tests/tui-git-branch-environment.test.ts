import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGitBranch } from "../src/tui/runtime/gitBranch.js";

test("TUI branch inspection uses the requested workspace, not inherited Git routing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-git-branch-"));
  const originalEnvironment = { ...process.env };
  const resetGitEnvironment = (): void => {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  };
  try {
    resetGitEnvironment();
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = root;
    const emptyHooks = path.join(root, "empty-hooks");
    const emptyConfig = path.join(root, "empty-gitconfig");
    await mkdir(emptyHooks);
    await writeFile(emptyConfig, "");
    const workspace = path.join(root, "workspace with spaces");
    const foreign = path.join(root, "foreign");
    const git = (cwd: string, args: string[]): void => {
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${emptyHooks}`,
        "-c", `init.templateDir=${emptyHooks}`, ...args], {
        cwd, windowsHide: true, stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig }
      });
    };
    for (const [directory, branch] of [[workspace, "workspace-branch"], [foreign, "foreign-branch"]] as const) {
      await mkdir(directory);
      git(directory, ["init", "-q", "-b", branch]);
      git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
    }
    const plain = path.join(root, "not-a-repository");
    await mkdir(plain);
    const linked = path.join(root, "linked worktree");
    git(workspace, ["worktree", "add", "-q", "-b", "linked-branch", linked]);

    await t.test("ordinary workspace branch", async () => {
      assert.equal(await readGitBranch(workspace), "workspace-branch");
    });
    await t.test("Git's own linked-worktree routing is retained", async () => {
      assert.equal(await readGitBranch(linked), "linked-branch");
    });
    for (const workTree of [false, true]) {
      await t.test(`foreign GIT_DIR${workTree ? " and GIT_WORK_TREE" : ""} cannot redirect inspection`, async () => {
        resetGitEnvironment();
        process.env.GIT_DIR = path.join(foreign, ".git");
        if (workTree) process.env.GIT_WORK_TREE = foreign;
        const before = { ...process.env };
        assert.equal(await readGitBranch(workspace), "workspace-branch");
        assert.deepEqual({ ...process.env }, before, "inspection must not mutate the caller environment");
      });
    }
    await t.test("foreign routing does not give a non-repository a branch", async () => {
      process.env.GIT_DIR = path.join(foreign, ".git");
      process.env.GIT_WORK_TREE = foreign;
      assert.equal(await readGitBranch(plain), undefined);
    });
    await t.test("nonexistent inherited Git directory cannot hide the workspace branch", async () => {
      resetGitEnvironment();
      process.env.GIT_DIR = path.join(root, "missing.git");
      assert.equal(await readGitBranch(workspace), "workspace-branch");
    });
    await t.test("foreign common directory cannot redirect a linked worktree", async () => {
      resetGitEnvironment();
      process.env.GIT_DIR = path.join(foreign, ".git");
      process.env.GIT_COMMON_DIR = path.join(foreign, ".git");
      process.env.GIT_WORK_TREE = foreign;
      assert.equal(await readGitBranch(linked), "linked-branch");
    });
    resetGitEnvironment();
    await t.test("detached HEAD remains absent", async () => {
      git(workspace, ["checkout", "--detach", "-q"]);
      assert.equal(await readGitBranch(workspace), undefined);
      git(workspace, ["checkout", "-q", "workspace-branch"]);
    });
    await t.test("unborn repository remains absent", async () => {
      const unborn = path.join(root, "unborn");
      await mkdir(unborn);
      git(unborn, ["init", "-q", "-b", "unborn-branch"]);
      assert.equal(await readGitBranch(unborn), undefined);
    });
    await t.test("missing workspace remains absent", async () => {
      assert.equal(await readGitBranch(path.join(root, "missing")), undefined);
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    await rm(root, { recursive: true, force: true });
  }
});
