import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "../src/runtime/host/worktree.js";

const run = promisify(execFile);
const modes = ["clean", "dir", "common", "index", "linked", "task-source"] as const;

for (const mode of modes) {
  test(`worktree creation isolates Git routing: ${mode}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-worktree-routing-"));
    const previous = { ...process.env };
    const clean: NodeJS.ProcessEnv = { ...previous };
    for (const key of Object.keys(clean)) {
      if (key.startsWith("GIT_")) delete clean[key];
    }
    Object.assign(clean, {
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "xdg"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "empty.gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(root, "empty.gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      BINY_AGENT_DIR: path.join(root, "state")
    });
    const git = async (cwd: string, args: string[]): Promise<string> =>
      (await run("git", args, { cwd, env: clean })).stdout.trim();
    async function initialize(directory: string, label: string): Promise<void> {
      await mkdir(directory, { recursive: true });
      await git(directory, ["init", "-q", "-b", `fixture-${label}`, "--template="]);
      await git(directory, ["config", "core.hooksPath", path.join(root, "no-hooks")]);
      await git(directory, ["config", "commit.gpgsign", "false"]);
      await writeFile(path.join(directory, "marker.txt"), `${label}-marker\n`);
      await git(directory, ["add", "marker.txt"]);
      await git(directory, ["commit", "-qm", `fixture-${label}`]);
    }
    async function snapshot(directory: string) {
      const index = await git(directory, ["rev-parse", "--git-path", "index"]);
      return {
        head: await git(directory, ["rev-parse", "HEAD"]),
        index: await readFile(path.resolve(directory, index)),
        marker: await readFile(path.join(directory, "marker.txt")),
        stage: await git(directory, ["ls-files", "--stage"])
      };
    }
    try {
      await mkdir(clean.HOME!, { recursive: true });
      await mkdir(clean.XDG_CONFIG_HOME!, { recursive: true });
      await writeFile(clean.GIT_CONFIG_GLOBAL!, "");
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, clean);
      const a = path.join(root, "A");
      const b = path.join(root, "B");
      await initialize(a, "A");
      await initialize(b, "B");
      let sourceRoot = a;
      if (mode === "linked" || mode === "task-source") {
        sourceRoot = path.join(root, "linked-A");
        await git(a, ["worktree", "add", "-qb", "fixture-linked", sourceRoot]);
        await writeFile(path.join(sourceRoot, "marker.txt"), "linked-A-marker\n");
        await git(sourceRoot, ["add", "marker.txt"]);
        await git(sourceRoot, ["commit", "-qm", "fixture-linked"]);
      }
      const repoRoot = mode === "linked" ? sourceRoot : a;
      const before = { a: await snapshot(a), b: await snapshot(b), source: await snapshot(sourceRoot) };
      const baseBranch = await git(sourceRoot, ["symbolic-ref", "--short", "HEAD"]);
      if (mode === "dir") process.env.GIT_DIR = path.join(b, ".git");
      if (mode === "common") process.env.GIT_COMMON_DIR = path.join(b, ".git");
      if (mode === "index") process.env.GIT_INDEX_FILE = path.join(b, ".git", "index");
      const environmentBefore = { ...process.env };
      const manager = new WorktreeManager(repoRoot, a);
      const task = mode === "task-source" ? { taskRunId: "synthetic-task", sourceRoot } : undefined;
      const record = await manager.ensure("synthetic-session", task);
      assert.deepEqual({ ...process.env }, environmentBefore);
      assert.equal(manager.repoRoot, repoRoot);
      assert.equal(manager.persistenceRoot, a);
      assert.ok(record.worktreePath.startsWith(path.join(repoRoot, ".biny", "worktrees") + path.sep));
      const registry = JSON.parse(await readFile(manager.registryPath, "utf8"));
      assert.deepEqual(registry, { version: 1, records: [record] });
      assert.equal(record.baseBranch, baseBranch);
      assert.equal(record.baseCommit, before.source.head);
      assert.deepEqual(await readFile(path.join(record.worktreePath, "marker.txt")), before.source.marker);
      assert.equal(await git(record.worktreePath, ["rev-parse", "HEAD"]), before.source.head);
      assert.equal(await git(a, ["rev-parse", "--verify", `refs/heads/${record.branch}`]), before.source.head);
      await assert.rejects(git(b, ["rev-parse", "--verify", `refs/heads/${record.branch}`]));
      assert.ok((await git(a, ["worktree", "list", "--porcelain"])).includes(record.worktreePath));
      assert.ok(!(await git(b, ["worktree", "list", "--porcelain"])).includes(record.worktreePath));
      assert.equal(record.taskRunId, task?.taskRunId);
      assert.equal(record.sourceRoot, task?.sourceRoot);
      const after = { a: await snapshot(a), b: await snapshot(b), source: await snapshot(sourceRoot) };
      const digest = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
      // Save bounded synthetic observations before the preservation assertions.
      t.diagnostic(JSON.stringify({
        mode,
        record,
        indexes: Object.fromEntries((["a", "b", "source"] as const).map((name) => [name, {
          beforeHash: digest(before[name].index),
          afterHash: digest(after[name].index),
          beforeStage: before[name].stage,
          afterStage: after[name].stage
        }]))
      }));
      for (const name of ["a", "b", "source"] as const) {
        assert.equal(after[name].head, before[name].head, `${name} HEAD unchanged`);
        assert.deepEqual(after[name].marker, before[name].marker, `${name} marker unchanged`);
        assert.deepEqual(after[name].index, before[name].index, `${name} original index unchanged`);
        assert.equal(after[name].stage, before[name].stage, `${name} staged entries unchanged`);
      }
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });
}

// Diagnostic seam: exercise the original private Git subprocess boundary with read-only git var.
// This is not a merge/commit lifecycle test and does not create a worktree.
for (const emptyAuthorName of [false, true]) {
  test(`worktree Git preserves explicit author metadata; empty name=${emptyAuthorName}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-worktree-author-"));
    const previous = { ...process.env };
    const environment: NodeJS.ProcessEnv = { ...previous };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("GIT_")) delete environment[key];
    }
    Object.assign(environment, {
      LC_ALL: "C",
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "xdg"),
      BINY_AGENT_DIR: path.join(root, "state"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "empty.gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(root, "empty.gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: emptyAuthorName ? "" : "Synthetic Author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_AUTHOR_DATE: "2001-02-03T04:05:06+00:00",
      GIT_COMMITTER_NAME: "Synthetic Committer",
      GIT_COMMITTER_EMAIL: "committer@example.invalid",
      GIT_COMMITTER_DATE: "2004-05-06T07:08:09+00:00"
    });
    const repo = path.join(root, "repo");
    const git = async (args: string[]): Promise<string> =>
      (await run("git", args, { cwd: repo, env: environment })).stdout.trim();
    try {
      await mkdir(environment.HOME!, { recursive: true });
      await mkdir(environment.XDG_CONFIG_HOME!, { recursive: true });
      await mkdir(repo);
      await writeFile(environment.GIT_CONFIG_GLOBAL!, "");
      await git(["init", "-q", "--template="]);
      await git(["config", "user.useConfigOnly", "true"]);
      await git(["config", "core.hooksPath", path.join(root, "no-hooks")]);
      if (emptyAuthorName) {
        await git(["config", "user.name", "Local Fallback"]);
        await git(["config", "user.email", "local@example.invalid"]);
      }
      const before = await readFile(path.join(repo, ".git", "config"));
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, environment);
      const manager = new WorktreeManager(repo, repo) as unknown as {
        git(args: readonly string[]): Promise<string>;
      };
      if (emptyAuthorName) {
        await assert.rejects(manager.git(["var", "GIT_AUTHOR_IDENT"]), /empty ident name/u);
      } else {
        assert.equal((await manager.git(["var", "GIT_AUTHOR_IDENT"])).trim(),
          "Synthetic Author <author@example.invalid> 981173106 +0000");
        assert.equal((await manager.git(["var", "GIT_COMMITTER_IDENT"])).trim(),
          "Synthetic Committer <committer@example.invalid> 1083827289 +0000");
      }
      assert.deepEqual({ ...process.env }, environment);
      assert.deepEqual(await readFile(path.join(repo, ".git", "config")), before);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });
}
