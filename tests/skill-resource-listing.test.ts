import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillResourceTool, createSkillTool, loadSkills, skillPromptForSelection } from "../src/extensions/skills.js";

const workspaceRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-skill-resource-listing-")));
const globalRoot = path.join(workspaceRoot, "global-skills");
const resources = [
  ["references/guide.md", "reference", "Reference contents stay lazy."],
  ["scripts/check.js", "script", "Script contents stay lazy."],
  ["assets/template.txt", "asset", "Asset contents stay lazy."]
] as const;

try {
  for (const scope of ["project", "global"] as const) {
    for (const filename of ["SKILL.md", "skill.md"]) {
      const name = `${scope}-${filename === "SKILL.md" ? "upper" : "lower"}`;
      const directory = path.join(scope === "project" ? path.join(workspaceRoot, ".biny", "skills") : globalRoot, name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, filename), `---\nname: ${name}\ndescription: Test resource discovery\n---\nFollow the bundled resources.\n`);
      for (const [relative, , content] of resources) {
        const target = path.join(directory, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    }
  }
  await writeFile(path.join(workspaceRoot, "legacy-notes.md"), "Legacy file instructions.");
  await writeFile(path.join(workspaceRoot, "skill.md"), "Legacy skill file without frontmatter.");
  const bundle = await loadSkills({ workspaceRoot, projectPaths: ["legacy-notes.md", "skill.md"], globalRoot });
  assert.deepEqual(bundle.errors, []);
  assert.doesNotMatch(bundle.prompt, /Follow the bundled resources|Reference contents stay lazy/u);

  for (const scope of ["project", "global"] as const) {
    for (const casing of ["upper", "lower"]) {
      const name = `${scope}-${casing}`;
      const skill = bundle.skills.find((candidate) => candidate.name === name);
      assert.ok(skill, `${name} must remain discoverable`);
      const execution = await createSkillTool(bundle).resolveExecution({ skill: name });
      assert.ok(!("isError" in execution));
      const invoked = await execution.execute({ toolCallId: name });
      assert.equal(typeof invoked, "string");
      const selected = await skillPromptForSelection(bundle, [skill.ref]);
      for (const [entryPoint, output] of [["Skill", invoked as string], ["selected prompt", selected]]) {
        assert.match(output, /Follow the bundled resources/u);
        for (const [relative, kind, content] of resources) {
          assert.ok(output.includes(`- ${path.normalize(relative)} (${kind})`), `${entryPoint} must list ${name}/${relative}`);
          assert.ok(!output.includes(content), "Listing a resource must not eagerly read its contents");
        }
        assert.ok(!output.includes(`- ${casing === "upper" ? "SKILL.md" : "skill.md"} (file)`), "The primary instruction file is not an auxiliary resource");
      }
      const read = await createSkillResourceTool(bundle).resolveExecution({ skill: name, path: resources[0][0] });
      assert.ok(!("isError" in read));
      assert.equal((await read.execute({ toolCallId: `${name}-resource` }) as { content: string }).content, resources[0][2]);
    }
  }

  for (const name of ["legacy-notes", "skill"]) {
    const legacy = await createSkillTool(bundle).resolveExecution({ skill: name });
    assert.ok(!("isError" in legacy));
    const invoked = await legacy.execute({ toolCallId: name }) as string;
    const selected = await skillPromptForSelection(bundle, [name]);
    for (const output of [invoked, selected]) {
      assert.match(output, /Legacy/u);
      assert.doesNotMatch(output, /Resources in this skill directory/u, "Plain legacy Markdown files do not list their surrounding workspace");
    }
  }
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("skill resource listing tests passed");
