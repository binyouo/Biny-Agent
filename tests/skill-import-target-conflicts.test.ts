import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanSkillCatalog } from "../src/extensions/skillCatalog.js";
import { importUnmanagedSkills, listUnmanagedSkillCandidates } from "../src/extensions/skillImports.js";

const conflict = /不是已验证的同名 Skill/;
const valid = (name: string) => `---\nname: ${name}\ndescription: A valid skill\n---\n# Body\n`;
async function fixture(run: (homeDir: string, source: string, target: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-target-"));
  try {
    const homeDir = path.join(root, "home");
    const source = path.join(homeDir, ".agents", "skills", "shared");
    const target = path.join(homeDir, ".config", "biny", "skills", "shared");
    await mkdir(source, { recursive: true });
    await mkdir(path.dirname(target), { recursive: true });
    await run(homeDir, source, target, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function select(homeDir: string, name = "shared"): Promise<string> {
  const candidates = listUnmanagedSkillCandidates(await scanSkillCatalog({ homeDir }));
  const candidate = candidates.find(candidate => candidate.name === name);
  assert.ok(candidate, "a valid unmanaged skill must remain available when its managed counterpart is invalid");
  return candidate.id;
}

for (const [label, targetText] of [
  ["different metadata name", valid("unrelated")],
  ["same name without description", "---\nname: shared\n---\n# Body\n"],
  ["same name with invalid allowed-tools", "---\nname: shared\ndescription: Present\nallowed-tools: 123\n---\n# Body\n"],
  ["malformed YAML", "---\nname: [\n---\n# Body\n"]
] as const) {
  test(`invalid target (${label}) is retained and reported as a conflict, not installed`, async () => fixture(async (homeDir, source, target) => {
    const sourceText = valid("shared");
    await writeFile(path.join(source, "SKILL.md"), sourceText);
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), targetText);
    await writeFile(path.join(target, "personal.txt"), "keep me");
    const id = await select(homeDir);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(importUnmanagedSkills({ homeDir, ids: [id] }), conflict);
      assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), targetText);
      assert.equal(await readFile(path.join(target, "personal.txt"), "utf8"), "keep me");
      assert.equal(await readFile(path.join(source, "SKILL.md"), "utf8"), sourceText);
      assert.deepEqual(await readdir(path.dirname(target)), ["shared"]);
      assert.equal(await select(homeDir), id);
    }
  }));
}

test("a valid legacy source does not mistake a different valid managed skill for its own installation", async () => fixture(async (homeDir, source, target) => {
  await writeFile(path.join(source, "skill.md"), valid("incoming"));
  await mkdir(target);
  await writeFile(path.join(target, "SKILL.md"), valid("shared"));
  const id = await select(homeDir, "incoming");
  await assert.rejects(importUnmanagedSkills({ homeDir, ids: [id] }), conflict);
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), valid("shared"));
  await assert.rejects(access(path.join(target, "skill.md")), { code: "ENOENT" });
}));

test("an existing empty target has no verified installation and is not replaced", async () => fixture(async (homeDir, source, target) => {
  await writeFile(path.join(source, "SKILL.md"), valid("shared"));
  await mkdir(target);
  const before = await stat(target);
  const id = await select(homeDir);
  await assert.rejects(importUnmanagedSkills({ homeDir, ids: [id] }), conflict);
  const after = await stat(target);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(await readdir(target), []);
}));

test("normal installation and repeated selection stay idempotent", async () => fixture(async (homeDir, source, target) => {
  await writeFile(path.join(source, "SKILL.md"), valid("shared"));
  await mkdir(path.join(source, "references"));
  await writeFile(path.join(source, "references", "guide.md"), "guide");
  const id = await select(homeDir);
  const first = await importUnmanagedSkills({ homeDir, ids: [id] });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.alreadyInstalled, false);
  assert.equal(await readFile(path.join(target, "references", "guide.md"), "utf8"), "guide");
  assert.deepEqual(listUnmanagedSkillCandidates(await scanSkillCatalog({ homeDir })), []);
  assert.deepEqual(await importUnmanagedSkills({ homeDir, ids: [id] }), []);
  assert.equal(await readFile(path.join(source, "SKILL.md"), "utf8"), valid("shared"));
}));

test("an existing single-file hard link remains rejected", async () => fixture(async (homeDir, source, target, root) => {
  await writeFile(path.join(source, "SKILL.md"), valid("shared"));
  await mkdir(target);
  const victim = path.join(root, "victim");
  await writeFile(victim, valid("unrelated"));
  await link(victim, path.join(target, "SKILL.md"));
  await assert.rejects(importUnmanagedSkills({ homeDir, ids: [await select(homeDir)] }), /缺少安全的 SKILL.md/);
  assert.equal(await readFile(victim, "utf8"), valid("unrelated"));
}));

test("an existing symbolic-link target remains rejected", { skip: process.platform === "win32" }, async () => fixture(async (homeDir, source, target, root) => {
  await writeFile(path.join(source, "SKILL.md"), valid("shared"));
  const victim = path.join(root, "victim");
  await mkdir(victim);
  await writeFile(path.join(victim, "SKILL.md"), valid("unrelated"));
  await symlink(victim, target, "dir");
  await assert.rejects(importUnmanagedSkills({ homeDir, ids: [await select(homeDir)] }), /目标不是安全目录/);
  assert.equal(await readFile(path.join(victim, "SKILL.md"), "utf8"), valid("unrelated"));
}));

test("moving a conflicting target away allows a later import without losing either skill", async () => fixture(async (homeDir, source, target, root) => {
  await writeFile(path.join(source, "SKILL.md"), valid("shared"));
  await mkdir(target);
  await writeFile(path.join(target, "SKILL.md"), valid("unrelated"));
  const id = await select(homeDir);
  await assert.rejects(importUnmanagedSkills({ homeDir, ids: [id] }), conflict);
  const backup = path.join(root, "previous-skill");
  await rename(target, backup);
  const result = await importUnmanagedSkills({ homeDir, ids: [id] });
  assert.equal(result[0]?.alreadyInstalled, false);
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), valid("shared"));
  assert.equal(await readFile(path.join(backup, "SKILL.md"), "utf8"), valid("unrelated"));
}));
