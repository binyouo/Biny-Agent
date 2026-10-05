import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { scanSkillCatalog } from "../src/extensions/skillCatalog.js";
import { defaultGlobalSkillRoots, skillRootPrecedence } from "../src/extensions/skillRoots.js";
import { loadSkills } from "../src/extensions/skills.js";

async function writeSkill(root: string, name: string, description: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "SKILL.md");
  await writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n---\nInert metadata fixture.\n`);
  return filePath;
}

async function withFixture(
  context: TestContext,
  run: (fixture: { root: string; homeDir: string; configuredRoot: string; projectRoot: string }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-precedence-"));
  const homeDir = path.join(root, "home");
  const configuredRoot = path.join(root, "configured");
  const projectRoot = path.join(root, "project");
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  context.mock.method(os, "homedir", () => homeDir);
  process.env[BINY_AGENT_DIR_ENV] = configuredRoot;
  try {
    await mkdir(projectRoot, { recursive: true });
    await run({ root, homeDir, configuredRoot, projectRoot });
  } finally {
    context.mock.restoreAll();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

for (const sameHome of [true, false]) {
  test(`explicit ${sameHome ? "current" : "different"} home keeps managed Biny skills ahead of same-name agent skills`, async (context) => {
    await withFixture(context, async ({ root, homeDir, configuredRoot, projectRoot }) => {
      const explicitHome = sameHome ? homeDir : path.join(root, "injected-home");
      const managedRoot = path.join(explicitHome, ".config", "biny", "skills");
      const expected = await writeSkill(managedRoot, "same-name", "Managed Biny copy");
      const agentFile = await writeSkill(path.join(explicitHome, ".agents", "skills"), "same-name", "Agent copy");
      await writeSkill(path.join(configuredRoot, "skills"), "same-name", "Ambient copy");
      const snapshot = await scanSkillCatalog({ homeDir: explicitHome, projectRoots: [projectRoot] });
      const winner = snapshot.skills.find((skill) => skill.name === "same-name");
      assert.equal(winner?.mdPath, expected);
      assert.equal(winner?.source, "biny");
      assert.equal(winner?.precedence, 100);
      const shadowed = snapshot.inventory.find((skill) => skill.mdPath === agentFile);
      assert.equal(shadowed?.precedence, 101);
      assert.equal(shadowed?.shadowedBy, winner?.ref);
      assert.equal(snapshot.inventory.filter((skill) => skill.name === "same-name").length, 2);
      assert.equal(snapshot.diagnostics.find((diagnostic) => diagnostic.ref === shadowed?.ref)?.shadowedBy, winner?.ref);

      const runtime = await loadSkills({ workspaceRoot: projectRoot, projectPaths: [], globalRoot: managedRoot });
      assert.equal(runtime.skills.find((skill) => skill.name === "same-name")?.filePath, expected);
      assert.equal(runtime.skills.filter((skill) => skill.scope !== "builtin").length, 1);

      const projectFile = await writeSkill(path.join(projectRoot, ".biny", "skills"), "same-name", "Project copy");
      const projectSnapshot = await scanSkillCatalog({ homeDir: explicitHome, projectRoots: [projectRoot] });
      assert.equal(projectSnapshot.skills.find((skill) => skill.name === "same-name")?.mdPath, projectFile);
      assert.equal(projectSnapshot.skills.find((skill) => skill.name === "same-name")?.precedence, 0);
    });
  });
}

test("global precedence uses the same omitted-versus-explicit home contract as global roots", async (context) => {
  await withFixture(context, async ({ root, homeDir, configuredRoot }) => {
    assert.deepEqual(defaultGlobalSkillRoots().map((directory) => skillRootPrecedence("global", directory)), [100, 101, 102, 103, 104, 105]);
    for (const explicitHome of [homeDir, path.join(root, "injected-home")]) {
      assert.deepEqual(defaultGlobalSkillRoots(explicitHome).map((directory) => skillRootPrecedence("global", directory, explicitHome)), [100, 101, 102, 103, 104, 105]);
      assert.equal(skillRootPrecedence("global", path.join(configuredRoot, "skills"), explicitHome), 107);
    }
    assert.equal(skillRootPrecedence("project", ".biny/skills"), 0);
    assert.equal(skillRootPrecedence("project", ".agents/skills"), 1);
    assert.equal(skillRootPrecedence("builtin", path.join(root, "builtin")), 300);
  });
});

test("default catalog and runtime retain configured global precedence", async (context) => {
  await withFixture(context, async ({ homeDir, configuredRoot, projectRoot }) => {
    const expected = await writeSkill(path.join(configuredRoot, "skills"), "same-name", "Configured Biny copy");
    const agentFile = await writeSkill(path.join(homeDir, ".agents", "skills"), "same-name", "Agent copy");
    await writeSkill(path.join(homeDir, ".config", "biny", "skills"), "same-name", "Unused home copy");
    const snapshot = await scanSkillCatalog({ projectRoots: [projectRoot] });
    const runtime = await loadSkills({ workspaceRoot: projectRoot, projectPaths: [] });
    const winner = snapshot.skills.find((skill) => skill.name === "same-name");
    assert.equal(winner?.mdPath, expected);
    assert.equal(winner?.precedence, 100);
    assert.equal(snapshot.inventory.find((skill) => skill.mdPath === agentFile)?.shadowedBy, winner?.ref);
    assert.equal(runtime.skills.find((skill) => skill.name === "same-name")?.filePath, expected);
    assert.equal(runtime.conflicts.find((conflict) => conflict.name === "same-name")?.winner.filePath, expected);
  });
});
