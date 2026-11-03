import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { collectProjectContext, formatProjectContext } from "../src/project/ProjectContext.js";
import { gitInspectionEnvironment } from "../src/tools/git/environment.js";

const exec = promisify(execFile);
async function fixture(run: (f: {
  root: string;
  git(...args: string[]): Promise<string>;
  write(name: string, content: string): Promise<void>;
  verify(codes: string[]): Promise<string>;
}) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-project-git-columns-")));
  const hooks = path.join(root, "empty-hooks");
  const git = async (...args: string[]) => (await exec("git", ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", ...args], {
    cwd: root, env: gitInspectionEnvironment(), timeout: 10_000
  })).stdout;
  const write = async (name: string, content: string) => { await writeFile(path.join(root, name), content); };
  try {
    await mkdir(hooks); await git("init", "--quiet");
    await git("config", "user.name", "Synthetic Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("config", "core.autocrlf", "false"); await git("config", "core.quotePath", "true");
    await git("config", "status.renames", "true");
    await write("a.txt", "original a\n"); await write("b.txt", "original b\n");
    await git("add", "a.txt", "b.txt"); await git("commit", "--quiet", "-m", "synthetic base");
    await run({ root, git, write, async verify(codes) {
      const raw = await git("--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--ignore-submodules=all");
      const expected = raw.replace(/\r?\n$/u, "");
      assert.deepEqual(expected ? expected.split("\n").map(line => line.slice(0, 2)) : [], codes, "real Git fixture must establish the intended XY codes");
      const context = await collectProjectContext(root, []);
      assert.equal(context.gitStatus, expected, "preserve status columns and quoted paths, removing only the output terminator");
      const prompt = formatProjectContext(context);
      assert.ok(prompt.endsWith(`git status:\n${expected || "(clean)"}`), "the prompt must retain the same unindented XY columns");
      return expected;
    } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("project snapshot retains the blank index column of the first unstaged modification", async () => {
  await fixture(async f => { await f.write("a.txt", "unstaged\n"); await f.verify([" M"]); });
});
test("project snapshot keeps staged modifications in the index column", async () => {
  await fixture(async f => { await f.write("a.txt", "staged\n"); await f.git("add", "a.txt"); await f.verify(["M "]); });
});
test("first and subsequent git-status lines preserve distinct staged and unstaged columns", async () => {
  await fixture(async f => {
    await f.write("a.txt", "unstaged a\n"); await f.write("b.txt", "staged b\n"); await f.git("add", "b.txt");
    await f.verify([" M", "M "]);
  });
});
test("worktree-only deletion keeps its leading blank status column", async () => {
  await fixture(async f => { await unlink(path.join(f.root, "a.txt")); await f.verify([" D"]); });
});
test("simultaneous index and worktree modifications retain both nonblank status columns", async () => {
  await fixture(async f => {
    await f.write("a.txt", "staged\n"); await f.git("add", "a.txt"); await f.write("a.txt", "unstaged after index\n");
    await f.verify(["MM"]);
  });
});
test("staged renames preserve Git's quoted path representation", async () => {
  await fixture(async f => {
    await f.git("mv", "a.txt", "renamed file.txt");
    const output = await f.verify(["R "]);
    assert.match(output, /a\.txt -> "renamed file\.txt"/u);
  });
});
test("copy detection preserves both status columns and quoted paths", async () => {
  await fixture(async f => {
    await f.git("config", "status.renames", "copies");
    await f.write("copied file.txt", "original a\n");
    await f.write("a.txt", "original a\nextra line\n");
    await f.git("add", "a.txt", "copied file.txt");
    const output = await f.verify(["M ", "C "]);
    assert.match(output, /a\.txt -> "copied file\.txt"/u);
  });
});
test("untracked filenames and their status prefix remain intact", async () => {
  await fixture(async f => { await f.write("untracked file.txt", "untracked\n"); const output = await f.verify(["??"]); assert.match(output, /"untracked file\.txt"/u); });
});
test("clean workspaces retain the existing clean prompt marker", async () => {
  await fixture(async f => { assert.equal(await f.verify([]), ""); });
});
test("non-repository fallback and pre-aborted collection remain unchanged", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-project-no-git-")));
  try {
    const context = await collectProjectContext(root, []); assert.equal(context.gitStatus, "(not a git repository)");
    const controller = new AbortController(); const reason = new Error("synthetic cancellation"); controller.abort(reason);
    await assert.rejects(collectProjectContext(root, [], controller.signal), error => error === reason);
  } finally { await rm(root, { recursive: true, force: true }); }
});
