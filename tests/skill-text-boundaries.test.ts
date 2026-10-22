import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillTool, loadSkills, skillPromptForSelection, type SkillBundle, type SkillDefinition } from "../src/extensions/skills.js";
import { createSkillId, createSkillRef } from "../src/extensions/skillRef.js";

function skill(description: string, index = 0): SkillDefinition {
  const name = `sample-${String(index).padStart(3, "0")}`;
  const ref = createSkillRef({ scope: "project", name, projectRoot: "/unused", source: "biny" });
  return {
    name, ref, id: createSkillId(ref), description,
    path: `skills/${name}.md`, filePath: `/unused/${name}.md`, rootPath: "/unused",
    scope: "project", source: "biny", alwaysInject: false
  };
}

function bundle(descriptions: string[]): SkillBundle {
  return { skills: descriptions.map(skill), paths: [], prompt: "", warnings: [], errors: [], conflicts: [] };
}

function cases(limit: number): Array<{ name: string; input: string; expected: string; valid?: boolean }> {
  return [
    { name: "empty", input: "", expected: "", valid: true },
    { name: "ASCII exact", input: "a".repeat(limit), expected: "a".repeat(limit), valid: true },
    { name: "CJK exact", input: "文".repeat(limit), expected: "文".repeat(limit), valid: true },
    { name: "pair exact", input: "a".repeat(limit - 2) + "😀", expected: "a".repeat(limit - 2) + "😀", valid: true },
    { name: "ASCII overflow", input: "a".repeat(limit + 1), expected: "a".repeat(limit - 1) + "…", valid: true },
    { name: "CJK overflow", input: "文".repeat(limit + 1), expected: "文".repeat(limit - 1) + "…", valid: true },
    { name: "pair before cut", input: "a".repeat(limit - 3) + "😀tail", expected: "a".repeat(limit - 3) + "😀…", valid: true },
    { name: "pair across cut", input: "a".repeat(limit - 2) + "😀tail", expected: "a".repeat(limit - 2) + "…", valid: true },
    { name: "pair after cut", input: "a".repeat(limit - 1) + "😀tail", expected: "a".repeat(limit - 1) + "…", valid: true },
    { name: "existing unpaired high at cut", input: "a".repeat(limit - 2) + "\ud800tail", expected: "a".repeat(limit - 2) + "\ud800…" },
    { name: "existing unpaired low at cut", input: "a".repeat(limit - 2) + "\udc00tail", expected: "a".repeat(limit - 2) + "\udc00…" },
    { name: "existing unpaired input unchanged", input: "a\ud800b\udc00", expected: "a\ud800b\udc00" }
  ];
}

function check(actual: string, item: ReturnType<typeof cases>[number], limit: number): void {
  assert.equal(actual, item.expected);
  assert.ok(actual.length <= limit, "the UTF-16 code-unit limit includes the ellipsis");
  if (item.valid) assert.equal(Buffer.from(actual, "utf8").toString("utf8"), actual, "valid input stays well-formed");
}

for (const item of cases(200)) {
  test(`Skill preparation display: ${item.name}`, async () => {
    const execution = await createSkillTool(bundle([item.input])).resolveExecution({ skill: "sample-000" });
    assert.ok(!("isError" in execution));
    assert.equal(execution.display?.kind, "generic");
    assert.equal(typeof execution.display?.detail, "string");
    check(execution.display!.detail as string, item, 200);
    // Deliberately never invoke execute: display preparation must need no file or provider.
  });
}

test("selected skill metadata preserves descriptions and Unicode for every selection", async () => {
  const description = "a".repeat(78) + "😀" + "z".repeat(1200);
  const prompt = await skillPromptForSelection(bundle(Array<string>(100).fill(description)), "all");
  assert.equal(Buffer.from(prompt, "utf8").toString("utf8"), prompt);
  const lines = prompt.split("\n").filter(line => line.startsWith('- "sample-'));
  assert.equal(lines.length, 100);
  for (const line of lines) assert.ok(line.endsWith(`: ${description}`));
  assert.ok(!prompt.includes("additional skills were omitted"));
});

test("empty and excluded selections stay empty", async () => {
  assert.equal(await skillPromptForSelection(bundle([])), "");
  assert.equal(await skillPromptForSelection(bundle(["description"]), "none"), "");
});

for (const item of cases(1024).filter((entry) => entry.valid && entry.input)) {
  test(`legacy metadata load: ${item.name}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-text-"));
    try {
      await mkdir(path.join(root, "skills"));
      await writeFile(path.join(root, "skills", "legacy.md"), item.input + "\n");
      const loaded = await loadSkills({ workspaceRoot: root, projectPaths: ["skills"], globalRoot: path.join(root, "absent-global") });
      assert.deepEqual(loaded.errors, []);
      const legacy = loaded.skills.find((entry) => entry.name === "legacy");
      assert.ok(legacy);
      check(legacy.description, item, 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [label, description, accepted] of [
  ["ASCII exact", "a".repeat(1024), true],
  ["CJK exact", "文".repeat(1024), true],
  ["pair exact", "a".repeat(1022) + "😀", true],
  ["ASCII overflow", "a".repeat(1025), false],
  ["CJK overflow", "文".repeat(1025), false],
  ["pair overflow", "a".repeat(1023) + "😀", false]
] as const) {
  test(`standard SKILL.md metadata: ${label}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-text-"));
    try {
      const directory = path.join(root, "skills", "standard");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: standard\ndescription: ${description}\n---\nBody\n`);
      const loaded = await loadSkills({ workspaceRoot: root, projectPaths: ["skills"], globalRoot: path.join(root, "absent-global") });
      const standard = loaded.skills.find((entry) => entry.name === "standard");
      if (accepted) {
        assert.ok(standard);
        assert.equal(standard.description, description);
        assert.deepEqual(loaded.errors, []);
      } else {
        assert.equal(standard, undefined, "standard metadata is rejected, not clipped");
        assert.equal(loaded.errors.length, 1);
        assert.match(loaded.errors[0]!, /description.*1024/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
