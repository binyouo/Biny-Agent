import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  discoverSkillRepositories,
  installDiscoveredSkill,
  updateDiscoveredSkill,
  type SkillRepository
} from "../src/extensions/skillDiscovery.js";
import { readManagedSkillVersion } from "../src/extensions/skillVersions.js";

const repository: SkillRepository = { owner: "fixture-owner", name: "fixture-repository", branch: "main", enabled: true };
const document = (name: string, body: string): string => `---\nname: ${name}\ndescription: Root path regression fixture\n---\n\n${body}\n`;

function fixture(files: Record<string, string>) {
  let revision = "a".repeat(40);
  const requests: string[] = [];
  const prefix = `https://api.github.com/repos/${repository.owner}/${repository.name}`;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === `${prefix}/commits/main?per_page=1`) return Response.json({ sha: revision });
    if (url === `${prefix}/git/trees/main?recursive=1` || url === `${prefix}/git/trees/${revision}?recursive=1`) {
      return Response.json({ tree: Object.entries(files).map(([file, content]) => ({
        path: file, type: "blob", mode: "100644", size: Buffer.byteLength(content)
      })) });
    }
    for (const ref of ["main", revision]) {
      const rawPrefix = `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/${ref}/`;
      if (!url.startsWith(rawPrefix)) continue;
      const file = url.slice(rawPrefix.length).split("/").map(decodeURIComponent).join("/");
      if (Object.hasOwn(files, file)) return new Response(files[file]);
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  return { files, requests, fetcher, setRevision: (next: string): void => { revision = next; } };
}

function selection(directory: string, name = "root-skill") {
  return { name, directory, repoOwner: repository.owner, repoName: repository.name, repoBranch: repository.branch };
}

test("root and repository-name child remain distinct discovery and installation targets", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "biny-skill-root-collision-"));
  const remote = fixture({
    "SKILL.md": document("root-skill", "Root instructions"),
    [`${repository.name}/SKILL.md`]: document("child-skill", "Child instructions"),
    [`${repository.name}/references/guide.md`]: "Child reference\n"
  });
  try {
    const discovered = await discoverSkillRepositories({ repositories: [repository], fetcher: remote.fetcher });
    assert.deepEqual(discovered.warnings, []);
    assert.equal(discovered.skills.length, 2, "the root must not deduplicate the actual child directory");
    const root = discovered.skills.find((skill) => skill.directory === ".");
    const child = discovered.skills.find((skill) => skill.directory === repository.name);
    assert.ok(root);
    assert.ok(child);
    assert.equal(root.name, "root-skill");
    assert.equal(child.name, "child-skill");
    assert.equal(root.key, `${repository.owner}/${repository.name}:.`);
    assert.equal(child.key, `${repository.owner}/${repository.name}:${repository.name}`);
    assert.equal(root.readmeUrl, `https://github.com/${repository.owner}/${repository.name}/tree/main`);
    assert.equal(child.readmeUrl, `https://github.com/${repository.owner}/${repository.name}/tree/main/${repository.name}`);
    const installedRoot = await installDiscoveredSkill({ skill: root, homeDir, fetcher: remote.fetcher });
    const installedChild = await installDiscoveredSkill({ skill: child, homeDir, fetcher: remote.fetcher });
    assert.equal(installedRoot.version.source.directory, ".");
    assert.equal(installedChild.version.source.directory, repository.name);
    assert.equal(await readFile(path.join(installedRoot.installedPath, "SKILL.md"), "utf8"), remote.files["SKILL.md"]);
    assert.equal(await readFile(path.join(installedChild.installedPath, "SKILL.md"), "utf8"), remote.files[`${repository.name}/SKILL.md`]);
    assert.equal(await readFile(path.join(installedChild.installedPath, "references/guide.md"), "utf8"), "Child reference\n");
    await assert.rejects(stat(path.join(installedChild.installedPath, repository.name)), { code: "ENOENT" });
    remote.setRevision("b".repeat(40));
    remote.files["SKILL.md"] = document("root-skill", "Updated root instructions");
    remote.files[`${repository.name}/SKILL.md`] = document("child-skill", "Updated child instructions");
    const updatedRoot = await updateDiscoveredSkill({ name: root.name, expectedVersion: installedRoot.version.id, homeDir, fetcher: remote.fetcher });
    const updatedChild = await updateDiscoveredSkill({ name: child.name, expectedVersion: installedChild.version.id, homeDir, fetcher: remote.fetcher });
    assert.equal(updatedRoot.version.source.directory, ".");
    assert.equal(updatedChild.version.source.directory, repository.name);
    assert.equal(await readFile(path.join(updatedRoot.installedPath, "SKILL.md"), "utf8"), remote.files["SKILL.md"]);
    assert.equal(await readFile(path.join(updatedChild.installedPath, "SKILL.md"), "utf8"), remote.files[`${repository.name}/SKILL.md`]);
    remote.setRevision("c".repeat(40));
    remote.files["SKILL.md"] = document("child-skill", "Unexpected root identity change");
    await assert.rejects(updateDiscoveredSkill({ name: root.name, expectedVersion: updatedRoot.version.id, homeDir, fetcher: remote.fetcher }), /名称与所选 Skill 不一致.*刷新/u);
    assert.equal((await readManagedSkillVersion(path.dirname(installedRoot.installedPath), root.name))?.id, updatedRoot.version.id);
    assert.match(await readFile(path.join(updatedRoot.installedPath, "SKILL.md"), "utf8"), /Updated root instructions/u);
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

for (const filename of ["SKILL.md", "skill.md"]) {
  test(`updates a discovered root ${filename} through its persisted source directory`, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "biny-skill-root-update-"));
    const original = document("root-skill", "Original root instructions");
    const remote = fixture({ [filename]: original, "references/guide.md": "Original reference\n" });
    try {
      const discovered = await discoverSkillRepositories({ repositories: [repository], fetcher: remote.fetcher });
      assert.deepEqual(discovered.warnings, []);
      assert.equal(discovered.skills.length, 1);
      const selected = discovered.skills[0]!;
      assert.equal(selected.directory, ".", "root selection has its own exact identity");
      assert.equal(selected.key, `${repository.owner}/${repository.name}:.`);
      const installed = await installDiscoveredSkill({ skill: selected, homeDir, fetcher: remote.fetcher });
      assert.equal(installed.directory, ".");
      assert.equal(installed.version.source.directory, ".");
      const managedRoot = path.dirname(installed.installedPath);
      const persisted = await readManagedSkillVersion(managedRoot, selected.name);
      assert.equal(persisted?.id, installed.version.id);
      assert.deepEqual(persisted?.source, installed.version.source, "exercise the real saved source, without rewriting metadata");
      const originalDirectory = await realpath(installed.installedPath);
      assert.equal(await readFile(path.join(originalDirectory, "SKILL.md"), "utf8"), original);

      const unchanged = await updateDiscoveredSkill({ name: selected.name, expectedVersion: persisted!.id, homeDir, fetcher: remote.fetcher });
      assert.equal(unchanged.version.id, installed.version.id, "an unchanged root source reuses its version");

      remote.setRevision("b".repeat(40));
      remote.files[filename] = document("root-skill", "Updated root instructions");
      remote.files["references/guide.md"] = "Updated reference\n";
      remote.files[`${repository.name}/SKILL.md`] = document("nested-skill", "New nested skill must not replace the root");
      const updated = await updateDiscoveredSkill({ name: selected.name, expectedVersion: unchanged.version.id, homeDir, fetcher: remote.fetcher });
      assert.equal(updated.version.previous, installed.version.id);
      assert.equal(updated.version.revision, "b".repeat(40));
      assert.equal(updated.version.source.directory, ".");
      assert.equal(await readFile(path.join(updated.installedPath, "SKILL.md"), "utf8"), remote.files[filename]);
      assert.equal(await readFile(path.join(updated.installedPath, "references/guide.md"), "utf8"), "Updated reference\n");
      assert.equal(await readFile(path.join(originalDirectory, "SKILL.md"), "utf8"), original, "the retired version stays immutable");
      assert.equal((await readManagedSkillVersion(managedRoot, selected.name))?.id, updated.version.id);
      assert.equal(remote.requests.some((url) => url.includes(`/${"b".repeat(40)}/${filename}`)), true, "update downloads remain pinned to the resolved revision");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
}

test("repository-name and basename aliases reject rather than guess a source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-exact-path-"));
  try {
    for (const [files, selected] of [
      [{ "SKILL.md": document("root-skill", "Root instructions") }, selection(repository.name)],
      [{ "skills/nested/SKILL.md": document("nested-skill", "Nested instructions") }, selection("nested", "nested-skill")]
    ] as const) {
      const remote = fixture(files);
      await assert.rejects(installDiscoveredSkill({ skill: selected, homeDir: root, fetcher: remote.fetcher }), /找不到.*Skill 目录.*刷新/u);
      assert.equal(remote.requests.length, 2, "unknown aliases must fail before downloading files");
      await assert.rejects(stat(path.join(root, ".config")), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exact nested directory selection remains stable across updates", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "biny-skill-nested-update-"));
  const remote = fixture({ "skills/nested/SKILL.md": document("nested-skill", "Nested instructions") });
  try {
    const installed = await installDiscoveredSkill({ skill: selection("skills/nested", "nested-skill"), homeDir, fetcher: remote.fetcher });
    assert.equal(installed.version.source.directory, "skills/nested");
    const unchanged = await updateDiscoveredSkill({ name: "nested-skill", expectedVersion: installed.version.id, homeDir, fetcher: remote.fetcher });
    assert.equal(unchanged.version.id, installed.version.id);
    assert.equal(await readFile(path.join(installed.installedPath, "SKILL.md"), "utf8"), remote.files["skills/nested/SKILL.md"]);
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

test("an explicit root identity does not fall back to an unrelated nested skill", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "biny-skill-root-missing-"));
  const remote = fixture({ "skills/nested/SKILL.md": document("root-skill", "Unrelated nested instructions") });
  try {
    await assert.rejects(installDiscoveredSkill({ skill: selection("."), homeDir, fetcher: remote.fetcher }), /找不到.*Skill 目录.*刷新/u);
    assert.equal(remote.requests.length, 2, "resolve the source tree, then reject before downloading files");
    await assert.rejects(stat(path.join(homeDir, ".config")), { code: "ENOENT" });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("exact root selection does not allow traversal or malformed directory variants", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "biny-skill-root-invalid-"));
  const remote = fixture({ "SKILL.md": document("root-skill", "Root instructions") });
  try {
    for (const directory of ["", "..", "./..", "../other", "nested/../other", "./", "./.", "nested/.", "nested//child", "/root", "nested/", "nested\\child", "nested\0child"]) {
      await assert.rejects(installDiscoveredSkill({ skill: selection(directory), homeDir, fetcher: remote.fetcher }), /Skill 目录路径无效/u, JSON.stringify(directory));
    }
    assert.deepEqual(remote.requests, [], "invalid selected paths fail before any fetch or filesystem write");
    await assert.rejects(stat(path.join(homeDir, ".config")), { code: "ENOENT" });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

for (const directory of ["."]) {
  test(`root selection ${directory} retains download tree checks`, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "biny-skill-root-checks-"));
    try {
      for (const invalid of [
        { entry: { path: "link", type: "blob", mode: "120000", size: 4 }, error: /不能包含符号链接/u },
        { entry: { path: "huge.bin", type: "blob", mode: "100644", size: 32 * 1024 * 1024 + 1 }, error: /总大小超过/u }
      ]) {
        const requests: string[] = [];
        const fetcher: typeof fetch = async (input) => {
          const url = String(input);
          requests.push(url);
          if (url.includes("/commits/")) return Response.json({ sha: "a".repeat(40) });
          if (url.includes("/git/trees/")) return Response.json({ tree: [{ path: "SKILL.md", type: "blob", mode: "100644", size: 100 }, invalid.entry] });
          throw new Error(`Unexpected download: ${url}`);
        };
        await assert.rejects(installDiscoveredSkill({ skill: selection(directory), homeDir, fetcher }), invalid.error);
        assert.equal(requests.length, 2);
      }
      await assert.rejects(stat(path.join(homeDir, ".config")), { code: "ENOENT" });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
}
