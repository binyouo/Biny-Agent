/** Local branch names must not change when another ref namespace has the same suffix. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const names = ["feature/topic", "heads/topic", "main", "refs/heads/topic", "release"];

async function fixture(check: (value: {
  repo: string;
  service: import("../src/desktop/electron/main/DesktopProjectService.js").DesktopProjectService;
  project: import("../src/desktop/protocol.js").DesktopProject;
  git: (...args: string[]) => Promise<string>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-git-result-branch-"));
  try {
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = async (...args: string[]): Promise<string> => (await exec("git", args, { cwd: repo })).stdout;
    await git("init", "--quiet", "-b", "main");
    await writeFile(path.join(repo, "base.txt"), "base\n");
    await git("add", "base.txt");
    await git("-c", "user.name=Biny Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
    for (const name of names) {
      if (name !== "main") await git("branch", name, "refs/heads/main");
      await git("tag", name, "refs/heads/main");
    }
    await git("update-ref", "refs/remotes/origin/remote-only", "refs/heads/main");
    const [{ DesktopProjectService }, { DesktopStateStore }, { DesktopUserDataStore }, { createFileConfigStore }] = await Promise.all([
      import("../src/desktop/electron/main/DesktopProjectService.js"),
      import("../src/desktop/electron/main/DesktopStateStore.js"),
      import("../src/desktop/electron/main/DesktopUserDataStore.js"),
      import("../src/config/store.js")
    ]);
    const state = new DesktopStateStore(path.join(root, "state.json"));
    await state.load();
    const service = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "data")), createFileConfigStore({ workspaceRoot: repo }));
    const project = await service.createProject(repo);
    await check({ repo, service, project, git });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("local branch names remain exact under matching tags and exclude remote-only refs", async () => {
  await fixture(async ({ service, project }) => {
    assert.deepEqual(await service.listProjectBranches(project.id), names.map((name) => ({ name, current: name === "main" })));
  });
});

test("matching-tag branches with slashes and heads-like names remain switchable", async () => {
  await fixture(async ({ service, project, git }) => {
    for (const name of names) {
      await service.switchProjectBranch(project.id, name);
      assert.equal(await git("branch", "--show-current"), `${name}\n`);
      assert.equal((await service.listProjectBranches(project.id)).find((branch) => branch.current)?.name, name);
    }
    await assert.rejects(service.createProjectBranch(project.id, "release"), /本地分支已存在/u);
  });
});

test("matching tags do not weaken dirty-workspace or missing-branch protections", async () => {
  await fixture(async ({ repo, service, project }) => {
    await assert.rejects(service.switchProjectBranch(project.id, "missing"), /本地分支不存在/u);
    await writeFile(path.join(repo, "base.txt"), "dirty\n");
    await assert.rejects(service.switchProjectBranch(project.id, "release"), /未提交改动/u);
  });
});

test("branch enumeration retains the existing output-buffer boundary", async () => {
  await fixture(async ({ repo, service, project, git }) => {
    const oid = (await git("rev-parse", "--verify", "HEAD")).trim();
    const refs = (await git("for-each-ref", "--format=%(objectname) %(refname)")).split("\n").filter(Boolean);
    const manyNames = Array.from({ length: 16_000 }, (_, index) => `branch-${String(index).padStart(5, "0")}-${"x".repeat(12)}`);
    // Valid packed refs make the output-size boundary quick to reproduce without 16,000 processes.
    refs.push(...manyNames.map((name) => `${oid} refs/heads/${name}`));
    refs.sort();
    await writeFile(path.join(repo, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${refs.join("\n")}\n`);
    const baseline = await git("for-each-ref", "--format=%(refname:short)%00%(HEAD)", "refs/heads");
    assert.ok(Buffer.byteLength(baseline) < 512 * 1024, "this repository fits the existing output limit");
    const branches = await service.listProjectBranches(project.id).catch(() => {
      assert.fail("Branch enumeration rejected a repository whose baseline output fits 512 KiB.");
    });
    assert.equal(branches.length, manyNames.length + names.length);
    assert.equal(branches.find((branch) => branch.current)?.name, "main");
    assert.deepEqual(branches.map((branch) => branch.name).sort(), [...manyNames, ...names].sort());
  });
});
