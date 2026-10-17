import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillTool, loadSkills, loadedSkillNamesForSelection, skillPromptForSelection } from "../src/extensions/skills.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-disclosure-"));
try {
  const directory = path.join(root, ".agents", "skills", "lazy-demo");
  await mkdir(path.join(directory, "references"), { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), "---\nname: lazy-demo\ndescription: Lazy routing description\n---\nLAZY_BODY_MARKER\n");
  await writeFile(path.join(directory, "references", "lazy-guide-unique.md"), "LAZY_RESOURCE_MARKER");
  const bundle = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.join(root, "global") });
  const definition = bundle.skills.find((skill) => skill.name === "lazy-demo");
  assert.ok(definition);
  for (const selection of [[definition.id], [definition.ref], [definition.name], "all", "auto", undefined] as const) {
    const prompt = await skillPromptForSelection(bundle, typeof selection === "object" ? [...selection] : selection);
    assert.match(prompt, /"lazy-demo": Lazy routing description/u);
    assert.doesNotMatch(prompt, /LAZY_BODY_MARKER|LAZY_RESOURCE_MARKER|lazy-guide-unique.md/u);
    assert.ok(!loadedSkillNamesForSelection(bundle, typeof selection === "object" ? [...selection] : selection).includes("lazy-demo"));
  }
  await rm(directory, { recursive: true });
  const prompt = await skillPromptForSelection(bundle, [definition.id]);
  assert.match(prompt, /"lazy-demo": Lazy routing description/u, "metadata preparation must not attempt an ordinary body or resource read");
  const activation = await createSkillTool(bundle).resolveExecution({ skill: definition.name });
  assert.ok(!("isError" in activation));
  await assert.rejects(() => activation.execute({ toolCallId: "removed-skill" }), /ENOENT/u,
    "an on-demand read must report missing files instead of pretending instructions were loaded");
  assert.equal(await skillPromptForSelection(bundle, "none"), "");
  assert.deepEqual(loadedSkillNamesForSelection(bundle, "none"), []);

  await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const name = `catalog-${index}`;
    const skillDirectory = path.join(root, ".agents", "skills", name);
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), `---\nname: ${name}\ndescription: ${"Long routing description. ".repeat(30)}\n---\nBULK_BODY_MARKER\n`);
  }));
  const bounded = await loadSkills({
    workspaceRoot: root, projectPaths: [], globalRoot: path.join(root, "global"),
    globalDefaults: Object.fromEntries(bundle.skills.filter((skill) => skill.alwaysInject).map((skill) => [skill.ref, false]))
  });
  assert.deepEqual(bounded.errors, []);
  assert.equal(bounded.skills.filter((skill) => skill.name.startsWith("catalog-")).length, 100);
  const allPrompt = await skillPromptForSelection(bounded, "all");
  assert.ok(allPrompt.length <= 8_000, "selecting all must preserve the initial metadata budget");
  assert.match(allPrompt, /additional skills were omitted/u);
  assert.match(allPrompt, /biny skill list --query/u, "omitted skills must remain discoverable through the CLI");
  assert.doesNotMatch(allPrompt, /BULK_BODY_MARKER/u);
} finally {
  await rm(root, { recursive: true, force: true });
}
