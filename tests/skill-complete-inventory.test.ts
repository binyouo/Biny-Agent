/** 本地 Skill 与资源目录必须完整，同一目录不会因展示或运行时名额而丢失。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkills, createSkillTool } from "../src/extensions/skills.js";
import { scanSkillCatalog } from "../src/extensions/skillCatalog.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-complete-skills-")));
const names = Array.from({ length: 520 }, (_, index) => `fixture-${String(index).padStart(3, "0")}`);
try {
  for (const name of names) {
    const directory = path.join(root, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Complete inventory fixture\n---\nInstructions.`);
  }
  const resourceRoot = path.join(root, ".agents", "skills", names[0]!, "references");
  await mkdir(resourceRoot);
  for (let index = 0; index < 520; index++) await writeFile(path.join(resourceRoot, `${String(index).padStart(3, "0")}.md`), "LAZY_RESOURCE_BODY");
  const bundle = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.join(root, "empty-global") });
  assert.deepEqual(bundle.skills.filter((skill) => skill.scope === "project").map((skill) => skill.name).sort(), names);
  assert.ok(bundle.skills.some((skill) => skill.scope === "builtin"), "project skills cannot consume the built-in catalog's discovery slots");
  const invocation = await createSkillTool(bundle).resolveExecution({ skill: names[0] });
  assert.ok(!("isError" in invocation));
  const instructions = String(await invocation.execute({ toolCallId: "inventory" }));
  assert.equal((instructions.match(/- references\//gu) ?? []).length, 520, "all resource paths are listed");
  assert.doesNotMatch(instructions, /LAZY_RESOURCE_BODY/u, "listing does not read resource bodies");
  const catalog = await scanSkillCatalog({ homeDir: path.join(root, "home"), projectRoots: [root] });
  assert.deepEqual(catalog.skills.filter((skill) => skill.scope === "project").map((skill) => skill.name).sort(), names);
  assert.equal(catalog.skills.find((skill) => skill.name === names[0])!.files.length, 521, "the management catalog includes the primary file and every resource");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("complete Skill inventory tests passed");
