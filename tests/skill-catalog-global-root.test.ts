import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopSkillService } from "../src/desktop/electron/main/DesktopSkillService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { scanSkillCatalog } from "../src/extensions/skillCatalog.js";
import { importUnmanagedSkills, listUnmanagedSkillCandidates } from "../src/extensions/skillImports.js";
import { loadSkills } from "../src/extensions/skills.js";

async function writeSkill(root: string, name: string, description = name): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "SKILL.md");
  await writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n---\nInert metadata fixture.\n`);
  return filePath;
}

async function withFixture(
  context: TestContext,
  run: (fixture: { root: string; homeDir: string; projectRoot: string; configuredRoot: string }) => Promise<void>
): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-catalog-root-")));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const configuredRoot = path.join(root, "configured");
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  context.mock.method(os, "homedir", () => homeDir);
  try {
    await mkdir(projectRoot, { recursive: true });
    await run({ root, homeDir, projectRoot, configuredRoot });
  } finally {
    context.mock.restoreAll();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

for (const setting of ["absolute", "relative", "absent", "empty", "blank"] as const) {
  test(`catalog, Desktop and runtime share the default global skill root with ${setting} BINY_AGENT_DIR`, async (context) => {
    await withFixture(context, async ({ root, homeDir, projectRoot, configuredRoot }) => {
      const useConfiguredRoot = setting === "absolute" || setting === "relative";
      if (setting === "absent") delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = setting === "absolute"
        ? `  ${configuredRoot}  `
        : setting === "relative"
        ? path.relative(process.cwd(), configuredRoot)
        : setting === "empty" ? "" : " \t ";

      const fallbackRoot = path.join(homeDir, ".config", "biny", "skills");
      const expectedRoot = useConfiguredRoot ? path.join(configuredRoot, "skills") : fallbackRoot;
      await writeSkill(path.join(configuredRoot, "skills"), "biny-skill", "Configured Biny copy");
      await writeSkill(fallbackRoot, "biny-skill", "Fallback Biny copy");
      await writeSkill(path.join(homeDir, ".biny", "skills"), "unsupported-old-biny-root");
      await writeSkill(path.join(homeDir, ".agents", "skills"), "biny-skill", "Lower priority agent copy");
      await writeSkill(path.join(homeDir, ".agents", "skills"), "project-wins", "Global copy");
      const projectSkill = await writeSkill(path.join(projectRoot, ".biny", "skills"), "project-wins", "Project copy");
      for (const [directory, name] of [
        [".agents/skills", "agents-skill"],
        [".claude/skills", "claude-skill"],
        [".codex/skills", "codex-skill"],
        [".pi/agent/skills", "pi-skill"],
        [".cc-switch/skills", "cc-switch-skill"]
      ]) {
        await writeSkill(path.join(homeDir, directory!), name!);
      }

      // Only discover inert metadata. No skill activation, plugin import, or network access.
      const runtime = await loadSkills({ workspaceRoot: projectRoot, projectPaths: [] });
      const expectedSkill = path.join(expectedRoot, "biny-skill", "SKILL.md");
      assert.equal(runtime.skills.find((skill) => skill.name === "biny-skill")?.filePath, expectedSkill);
      assert.equal(runtime.skills.find((skill) => skill.name === "project-wins")?.filePath, projectSkill);
      const expected = runtime.skills.filter((skill) => skill.scope !== "builtin")
        .map((skill) => ({ name: skill.name, scope: skill.scope, source: skill.source, filePath: skill.filePath, ref: skill.ref }))
        .sort((left, right) => left.name.localeCompare(right.name));

      const state = new DesktopStateStore(path.join(root, "desktop.json"));
      await state.upsertProject({
        id: "project", path: projectRoot, name: "Fixture", dirty: false, missing: false, pinned: false,
        addedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z"
      });
      const service = new DesktopSkillService(state, {
        load: async () => configSchema.parse(defaultConfig),
        save: async () => { throw new Error("Unexpected configuration write"); }
      }, async () => { throw new Error("Unexpected network request"); });
      for (const snapshot of [
        await scanSkillCatalog({ projectRoots: [projectRoot] }),
        await service.snapshot("project")
      ]) {
        assert.deepEqual(snapshot.skills.filter((skill) => skill.scope !== "builtin")
          .map((skill) => ({ name: skill.name, scope: skill.scope, source: skill.source, filePath: skill.mdPath, ref: skill.ref }))
          .sort((left, right) => left.name.localeCompare(right.name)), expected);
        const binySkill = snapshot.skills.find((skill) => skill.name === "biny-skill");
        assert.equal(binySkill?.precedence, 100);
        assert.equal(snapshot.inventory.find((skill) => skill.name === "biny-skill" && skill.source === "agents")?.shadowedBy, binySkill?.ref);
        assert.equal(snapshot.inventory.some((skill) => skill.name === "unsupported-old-biny-root"), false);
        assert.equal(snapshot.inventory.some((skill) => skill.source === "biny" && skill.scope === "global" && skill.mdPath !== expectedSkill), false);
      }
    });
  });
}

for (const sameHome of [false, true]) {
  test(`explicit catalog homeDir stays isolated from BINY_AGENT_DIR${sameHome ? " even when it equals os.homedir()" : ""}`, async (context) => {
    await withFixture(context, async ({ root, homeDir, configuredRoot }) => {
      process.env[BINY_AGENT_DIR_ENV] = configuredRoot;
      const explicitHome = sameHome ? homeDir : path.join(root, "injected-home");
      await writeSkill(path.join(configuredRoot, "skills"), "ambient-configured-skill");
      const expected = await writeSkill(path.join(explicitHome, ".config", "biny", "skills"), "injected-home-skill");
      await writeSkill(path.join(explicitHome, ".agents", "skills"), "injected-agents-skill");
      const snapshot = await scanSkillCatalog({ homeDir: explicitHome });
      assert.deepEqual(snapshot.skills.filter((skill) => skill.scope !== "builtin").map((skill) => skill.name), [
        "injected-agents-skill", "injected-home-skill"
      ]);
      assert.equal(snapshot.skills.find((skill) => skill.name === "injected-home-skill")?.mdPath, expected);
      const candidate = listUnmanagedSkillCandidates(snapshot).find((skill) => skill.name === "injected-agents-skill");
      assert.ok(candidate);
      const imported = await importUnmanagedSkills({ ids: [candidate.id], homeDir: explicitHome });
      assert.equal(imported.length, 1);
      assert.equal(imported[0]?.installedPath, path.join(explicitHome, ".config", "biny", "skills", "injected-agents-skill"));
      const ambient = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.join(configuredRoot, "skills") });
      assert.deepEqual(ambient.skills.filter((skill) => skill.scope !== "builtin").map((skill) => skill.name), ["ambient-configured-skill"]);
    });
  });
}

test("explicit runtime globalRoot takes priority over BINY_AGENT_DIR and home conventions", async (context) => {
  await withFixture(context, async ({ root, homeDir, projectRoot, configuredRoot }) => {
    process.env[BINY_AGENT_DIR_ENV] = configuredRoot;
    await writeSkill(path.join(configuredRoot, "skills"), "ambient-configured-skill");
    await writeSkill(path.join(homeDir, ".config", "biny", "skills"), "home-skill");
    await writeSkill(path.join(homeDir, ".agents", "skills"), "agents-skill");
    const globalRoot = path.join(root, "explicit-global");
    const expected = await writeSkill(globalRoot, "explicit-global-skill");
    const runtime = await loadSkills({ workspaceRoot: projectRoot, projectPaths: [], globalRoot });
    assert.deepEqual(runtime.skills.filter((skill) => skill.scope !== "builtin").map((skill) => skill.filePath), [expected]);
  });
});

test("a default catalog import candidate reaches the configured root and runtime without touching an old home copy", async (context) => {
  await withFixture(context, async ({ homeDir, projectRoot, configuredRoot }) => {
    process.env[BINY_AGENT_DIR_ENV] = configuredRoot;
    const sourceFile = await writeSkill(path.join(homeDir, ".agents", "skills"), "importable-skill", "Agent source copy");
    const oldFile = await writeSkill(path.join(homeDir, ".config", "biny", "skills"), "importable-skill", "Unrelated old home copy");
    const sourceText = await readFile(sourceFile, "utf8");
    const oldText = await readFile(oldFile, "utf8");
    const snapshot = await scanSkillCatalog({ projectRoots: [projectRoot] });
    const candidate = listUnmanagedSkillCandidates(snapshot).find((skill) => skill.name === "importable-skill");
    assert.ok(candidate);

    const imported = await importUnmanagedSkills({ ids: [candidate.id], projectRoots: [projectRoot] });
    assert.equal(imported.length, 1, "a catalog-offered candidate must not disappear during the import rescan");
    const destination = path.join(configuredRoot, "skills", "importable-skill");
    assert.equal(imported[0]?.installedPath, destination);
    assert.equal(imported[0]?.alreadyInstalled, false);
    const installedFile = path.join(destination, "SKILL.md");
    assert.equal(await readFile(installedFile, "utf8"), sourceText);

    const runtime = await loadSkills({ workspaceRoot: projectRoot, projectPaths: [] });
    assert.equal(runtime.skills.find((skill) => skill.name === "importable-skill")?.filePath, installedFile);
    assert.equal(runtime.skills.find((skill) => skill.name === "importable-skill")?.source, "biny");
    const refreshed = await scanSkillCatalog({ projectRoots: [projectRoot] });
    assert.equal(refreshed.skills.find((skill) => skill.name === "importable-skill")?.mdPath, installedFile);
    assert.equal(listUnmanagedSkillCandidates(refreshed).some((skill) => skill.id === candidate.id), false);

    // A stale selection cannot overwrite an existing managed copy, even after a local edit.
    const editedText = sourceText.replace("Agent source copy", "Locally edited managed copy");
    await writeFile(installedFile, editedText);
    assert.deepEqual(await importUnmanagedSkills({ ids: [candidate.id], projectRoots: [projectRoot] }), []);
    assert.equal(await readFile(installedFile, "utf8"), editedText);
    assert.equal(await readFile(sourceFile, "utf8"), sourceText);
    assert.equal(await readFile(oldFile, "utf8"), oldText);
  });
});
