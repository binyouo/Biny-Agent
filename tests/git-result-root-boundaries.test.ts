/** Real Git output must preserve whitespace that belongs to a repository root. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function fixture(name: string, check: (value: {
  repo: string;
  root: string;
  service: import("../src/desktop/electron/main/DesktopProjectService.js").DesktopProjectService;
  project: import("../src/desktop/protocol.js").DesktopProject;
  git: (...args: string[]) => Promise<string>;
}) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-git-result-root-")));
  try {
    const repo = path.join(root, name);
    await mkdir(repo);
    const git = async (...args: string[]): Promise<string> => (await exec("git", args, { cwd: repo })).stdout;
    await git("init", "--quiet", "-b", "main");
    await git("config", "user.name", "Biny Test");
    await git("config", "user.email", "test@example.invalid");
    const [{ DesktopProjectService }, { DesktopStateStore }, { DesktopUserDataStore }, { createFileConfigStore }] = await Promise.all([
      import("../src/desktop/electron/main/DesktopProjectService.js"),
      import("../src/desktop/electron/main/DesktopStateStore.js"),
      import("../src/desktop/electron/main/DesktopUserDataStore.js"),
      import("../src/config/store.js")
    ]);
    const state = new DesktopStateStore(path.join(root, "state.json"));
    await state.load();
    const service = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "data")), createFileConfigStore(repo));
    const project = await service.createProject(repo);
    await check({ repo, root, service, project, git });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const name of ["repo", "repo ", "repo\t", "repo\n", "repo\r", "repo \n\t", "repo\n\n", ' repo"名\\字 ']) {
  test(`repository root preserves ${JSON.stringify(name)} during status and selected-file commit`, { skip: process.platform === "win32" && name !== "repo" }, async () => {
    await fixture(name, async ({ repo, root, service, project, git }) => {
      // A real neighboring directory rules out accidental acceptance of the trimmed path.
      if (name.trimEnd() !== name) await mkdir(path.join(root, name.trimEnd()));
      await writeFile(path.join(repo, "selected.txt"), "selected\n");
      assert.equal(await git("rev-parse", "--show-toplevel"), `${repo}\n`);
      const before = await service.projectGitStatus(project.id);
      assert.deepEqual(before.files, [{ path: "selected.txt", status: "??" }]);
      assert.equal((await service.projectGitStatus(project.id)).revision, before.revision);
      const after = await service.commitProjectFiles(project.id, { message: "selected", paths: ["selected.txt"], revision: before.revision });
      assert.deepEqual(after.files, []);
      assert.equal(await git("show", "HEAD:selected.txt"), "selected\n");
    });
  });
}

test("repository-root checks still reject nested projects", async () => {
  await fixture("repo", async ({ repo, service }) => {
    const nested = path.join(repo, "nested");
    await mkdir(nested);
    const project = await service.createProject(nested);
    await assert.rejects(service.projectGitStatus(project.id), /Git 仓库根目录/u);
  });
});

test("repository-root checks still accept a symlink alias of a whitespace-ending root", { skip: process.platform === "win32" }, async () => {
  await fixture("repo ", async ({ repo, root, service }) => {
    const alias = path.join(root, "alias");
    await symlink(repo, alias, "dir");
    const project = await service.createProject(alias);
    const snapshot = await service.projectGitStatus(project.id);
    assert.deepEqual(snapshot.files, []);
  });
});
