import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readSkillCatalogFile,
  scanSkillCatalog,
  writeSkillCatalogFile
} from "../src/extensions/skillCatalog.js";
import { loadSkills } from "../src/extensions/skills.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-catalog-"));
  try {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const sharedSkill = path.join(homeDir, ".agents", "skills", "shared-skill");
    await mkdir(sharedSkill, { recursive: true });
    await writeFile(path.join(sharedSkill, "SKILL.md"), "---\nname: shared-skill\ndescription: A shared local skill\n---\n# Shared skill\n\nUse this skill when testing the local catalog.\n");
    await mkdir(path.join(sharedSkill, "references"), { recursive: true });
    await writeFile(path.join(sharedSkill, "references", "guide.md"), "# Guide\n");

    const agentsSkillRoot = path.join(homeDir, ".agents", "skills");
    await mkdir(agentsSkillRoot, { recursive: true });

    const binySkill = path.join(homeDir, ".config", "biny", "skills", "biny-only");
    await mkdir(binySkill, { recursive: true });
    await writeFile(path.join(binySkill, "skill.md"), "---\nname: biny-only\ndescription: Biny skill\n---\n\nBiny body\n");

    const projectSkill = path.join(projectRoot, ".agents", "skills", "project-skill");
    await mkdir(projectSkill, { recursive: true });
    await writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: project-skill\ndescription: Project skill\n---\n\nProject body\n");
    const globalProjectCopy = path.join(homeDir, ".agents", "skills", "project-skill");
    await mkdir(globalProjectCopy, { recursive: true });
    await writeFile(path.join(globalProjectCopy, "SKILL.md"), "---\nname: project-skill\ndescription: Global copy\n---\n\nGlobal body\n");

    const snapshot = await scanSkillCatalog({ homeDir, projectRoots: [projectRoot] });
    assert.equal(snapshot.warnings.length, 0);
    assert.deepEqual(snapshot.skills.filter((skill) => skill.scope !== "builtin").map((skill) => skill.name), ["biny-only", "shared-skill", "project-skill"]);
    assert.equal(snapshot.inventory.length, 13);
    assert.deepEqual(snapshot.skills.filter((skill) => skill.scope === "builtin").map((skill) => skill.name), [
      "browser",
      "daily-report",
      "memory-management",
      "plan-weave",
      "scheduler",
      "self-reflection",
      "tasks",
      "todo",
      "workspace-search"
    ]);
    const projectCopy = snapshot.inventory.find((skill) => skill.name === "project-skill" && skill.scope === "global");
    assert.ok(projectCopy?.shadowedBy);
    assert.equal(snapshot.skills.find((skill) => skill.name === "project-skill")?.scope, "project");

    const shared = snapshot.skills.find((skill) => skill.name === "shared-skill");
    assert.ok(shared);
    assert.equal(shared.scope, "global");
    assert.equal(shared.description, "A shared local skill");
    assert.deepEqual(shared.linkedEngines, ["codex", "pi"]);
    assert.equal(shared.ref.endsWith(":agents:shared-skill"), true);
    assert.deepEqual(shared.frontmatter, { name: "shared-skill", description: "A shared local skill" });
    assert.deepEqual(shared.files.map((file) => file.path), ["SKILL.md", "references/guide.md"]);

    const runtimeSkills = await loadSkills({
      workspaceRoot: projectRoot,
      projectPaths: [],
      globalRoot: path.join(root, "no-global-skills")
    });
    assert.equal(runtimeSkills.skills.filter((skill) => skill.name === "project-skill").length, 1);

    const guide = await readSkillCatalogFile(shared, "references/guide.md");
    assert.equal(guide.content, "# Guide\n");
    assert.equal(guide.binary, false);

    await writeSkillCatalogFile(shared, "references/guide.md", "# Updated guide\n");
    assert.equal(await readFile(path.join(shared.absolutePath, "references", "guide.md"), "utf8"), "# Updated guide\n");
    await assert.rejects(() => readSkillCatalogFile(shared, "../outside.txt"), /越界/);

    const duplicateAgents = path.join(projectRoot, ".agents", "skills", "duplicate-skill");
    const duplicateBiny = path.join(projectRoot, ".biny", "skills", "duplicate-skill");
    await mkdir(duplicateAgents, { recursive: true });
    await mkdir(duplicateBiny, { recursive: true });
    await writeFile(path.join(duplicateAgents, "SKILL.md"), "---\nname: duplicate-skill\ndescription: Agent copy\n---\n");
    await writeFile(path.join(duplicateBiny, "SKILL.md"), "---\nname: duplicate-skill\ndescription: Biny copy\n---\n");
    const deduplicated = await scanSkillCatalog({ homeDir, projectRoots: [projectRoot] });
    assert.equal(deduplicated.skills.filter((skill) => skill.name === "duplicate-skill").length, 1);
    assert.equal(deduplicated.skills.find((skill) => skill.name === "duplicate-skill")?.source, "biny");
    const shadowed = deduplicated.inventory.find((skill) => skill.name === "duplicate-skill" && skill.shadowedBy);
    assert.ok(shadowed);
    assert.equal(deduplicated.diagnostics.some((diagnostic) => diagnostic.kind === "duplicate_id"), true);

    const externalSkill = path.join(root, "external-skill");
    await mkdir(externalSkill, { recursive: true });
    await writeFile(path.join(externalSkill, "SKILL.md"), "---\nname: external-skill\ndescription: External\n---\n");
    await symlink(externalSkill, path.join(agentsSkillRoot, "external-skill"), "dir");
    const withExternalLink = await scanSkillCatalog({ homeDir });
    assert.match(withExternalLink.warnings.join(" "), /非受支持根目录/);
    assert.equal(withExternalLink.skills.some((skill) => skill.name === "external-skill"), false);

    const projectExternalLink = path.join(root, "project-external-skill");
    await mkdir(projectExternalLink, { recursive: true });
    await writeFile(path.join(projectExternalLink, "SKILL.md"), "---\nname: project-external-skill\ndescription: Project external\n---\n");
    const projectLinkRoot = path.join(projectRoot, ".agents", "skills");
    await symlink(projectExternalLink, path.join(projectLinkRoot, "project-external-skill"), "dir");
    const withUnsupportedProjectLink = await scanSkillCatalog({ homeDir, projectRoots: [projectRoot] });
    assert.match(withUnsupportedProjectLink.warnings.join(" "), /非受支持根目录/);
    assert.equal(withUnsupportedProjectLink.diagnostics.some((diagnostic) => diagnostic.kind === "unsupported_symlink"), true);

    await fs.link(path.join(shared.absolutePath, "SKILL.md"), path.join(shared.absolutePath, "hard-link.md"));
    const withHardLink = await scanSkillCatalog({ homeDir });
    const refreshed = withHardLink.skills.find((skill) => skill.name === "shared-skill");
    assert.ok(refreshed);
    assert.equal(refreshed.ref, shared.ref);
    await assert.rejects(() => readSkillCatalogFile(refreshed, "hard-link.md"), /硬链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
