import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillTool, loadSkills, skillPromptForSelection } from "../src/extensions/skills.js";

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
  }
  await writeFile(path.join(directory, "SKILL.md"), "---\nname: lazy-demo\ndescription: Lazy routing description\n---\nEDITED_BODY_MARKER\n");
  const cachedActivation = await createSkillTool(bundle).resolveExecution({ skill: "lazy-demo" });
  assert.ok(!("isError" in cachedActivation));
  const cachedBody = await cachedActivation.execute({ toolCallId: "cached-skill" });
  assert.match(String(cachedBody), /LAZY_BODY_MARKER/u, "instructions use the directory scan snapshot until refresh");
  assert.doesNotMatch(String(cachedBody), /EDITED_BODY_MARKER/u);
  const refreshedBundle = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.join(root, "global") });
  const refreshedActivation = await createSkillTool(refreshedBundle).resolveExecution({ skill: "lazy-demo" });
  assert.ok(!("isError" in refreshedActivation));
  assert.match(String(await refreshedActivation.execute({ toolCallId: "refreshed-skill" })), /EDITED_BODY_MARKER/u);
  await rm(directory, { recursive: true });
  const prompt = await skillPromptForSelection(bundle, [definition.id]);
  assert.match(prompt, /"lazy-demo": Lazy routing description/u, "metadata preparation must not attempt an ordinary body or resource read");
  const activation = await createSkillTool(bundle).resolveExecution({ skill: definition.name });
  assert.ok(!("isError" in activation));
  await assert.rejects(() => activation.execute({ toolCallId: "removed-skill" }), /ENOENT/u,
    "an on-demand read must report missing files instead of pretending instructions were loaded");
  assert.equal(await skillPromptForSelection(bundle, "none"), "");

  const alwaysDirectory = path.join(root, ".agents", "skills", "always-lazy");
  await mkdir(alwaysDirectory, { recursive: true });
  await writeFile(path.join(alwaysDirectory, "SKILL.md"), "---\nname: always-lazy\ndescription: Always selected routing description\nalways-inject: true\n---\nALWAYS_BODY_MARKER\n");
  const alwaysBundle = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.join(root, "global") });
  await rm(alwaysDirectory, { recursive: true });
  const alwaysPrompt = await skillPromptForSelection(alwaysBundle, []);
  assert.match(alwaysPrompt, /"always-lazy": Always selected routing description/u);
  assert.doesNotMatch(alwaysPrompt, /ALWAYS_BODY_MARKER/u, "always-selected metadata must not read the instruction file during preparation");
  const alwaysActivation = await createSkillTool(alwaysBundle).resolveExecution({ skill: "always-lazy" });
  assert.ok(!("isError" in alwaysActivation));
  await assert.rejects(() => alwaysActivation.execute({ toolCallId: "removed-always-skill" }), /ENOENT/u);

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
  assert.ok(allPrompt.length > 8_000, "the selected catalog is not truncated by a prompt character budget");
  for (let index = 0; index < 100; index++) {
    assert.ok(allPrompt.includes(`- "catalog-${index}": ${"Long routing description. ".repeat(30).trim()}`), "every selected description is retained in full");
  }
  assert.doesNotMatch(allPrompt, /additional skills were omitted/u);
  assert.doesNotMatch(allPrompt, /BULK_BODY_MARKER/u);
} finally {
  await rm(root, { recursive: true, force: true });
}
