/** Local Skill creation must reject metadata that runtime discovery cannot load. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseManagedSkillMetadata } from "../src/extensions/managedSkillSources.js";

const cliPath = path.resolve("src/cli/index.ts");
const tsxPath = import.meta.resolve("tsx");
const invalidMetadata = [
  ["license: 42", "SKILL.md license must be a string."],
  ["compatibility: 42", "SKILL.md compatibility must be a string."],
  [`compatibility: ${"x".repeat(501)}`, "SKILL.md compatibility 超过 500 个字符。"],
  ["allowed-tools: 42", "SKILL.md allowed-tools 必须是字符串或字符串数组。"],
  ["allowed-tools: null", "SKILL.md allowed-tools 必须是字符串或字符串数组。"],
  ["allowed-tools: [Read, 42]", "SKILL.md allowed-tools 必须是字符串或字符串数组。"],
  ["metadata: 42", "SKILL.md metadata 必须是对象。"],
  ["metadata: []", "SKILL.md metadata 必须是对象。"],
  ["metadata: null", "SKILL.md metadata 必须是对象。"],
  ["always-inject: 42", "SKILL.md always-inject 必须是布尔值。"],
  ["always-inject: yes", "SKILL.md always-inject 必须是布尔值。"]
] as const;

function document(name: string, metadata: string, body = "Fixture instructions.\n"): string {
  return `---\nname: ${name}\ndescription: Inert managed import fixture\n${metadata}\n---\n${body}`;
}

async function withFixture(run: (fixture: { root: string; sourceFile: string; skillRoot: string; invoke: (args: string[]) => ReturnType<typeof invokeCli> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-managed-metadata-"));
  const sourceFile = path.join(root, "input", "optional-skill", "SKILL.md");
  const skillRoot = path.join(root, "config", "skills");
  try {
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await mkdir(path.join(root, "workspace"));
    await mkdir(path.join(root, "home"));
    await run({ root, sourceFile, skillRoot, invoke: (args) => invokeCli(root, args) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function invokeCli(root: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--import", tsxPath, cliPath, "skill", ...args], {
    cwd: path.join(root, "workspace"),
    env: { ...process.env, NODE_NO_WARNINGS: "1", HOME: path.join(root, "home"), BINY_AGENT_DIR: path.join(root, "config") },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test("CLI create rejects runtime-invalid optional metadata before writing and preserves existing Skills", async (context) => {
  for (const [metadata, message] of invalidMetadata) {
    await context.test(metadata.slice(0, 60), async () => {
      await withFixture(async ({ sourceFile, skillRoot, invoke }) => {
        const content = document("optional-skill", metadata);
        await writeFile(sourceFile, content);
        assert.throws(() => parseManagedSkillMetadata(content, "optional-skill"), { message });
        const rejected = invoke(["create", "optional-skill", "--file", sourceFile]);
        assert.equal(rejected.status, 1, rejected.stderr);
        assert.equal(rejected.stdout, "");
        assert.equal(rejected.stderr.trim(), message);
        await assert.rejects(readdir(path.dirname(skillRoot)), { code: "ENOENT" });
        const existing = path.join(skillRoot, "existing-skill", "SKILL.md");
        const existingContent = document("existing-skill", "license: MIT");
        await mkdir(path.dirname(existing), { recursive: true });
        await writeFile(existing, existingContent);
        const retried = invoke(["create", "optional-skill", "--file", sourceFile]);
        assert.equal(retried.status, 1, retried.stderr);
        assert.equal(retried.stdout, "");
        assert.equal(retried.stderr.trim(), message);
        assert.deepEqual(await readdir(skillRoot), ["existing-skill"]);
        assert.equal(await readFile(existing, "utf8"), existingContent);
        assert.equal(await readFile(sourceFile, "utf8"), content);
      });
    });
  }
});

test("valid optional metadata retains exact bytes through CLI create, runtime list and check", async () => {
  await withFixture(async ({ root, skillRoot, invoke }) => {
    const valid = [
      { name: "string-tools", metadata: "license: MIT\ncompatibility: '   '\nallowed-tools: Read Bash(git:*)\nmetadata:\n  example: {version: 2, nested: [true, null]}" },
      { name: "array-tools", metadata: `license: ''\ncompatibility: ' ${"x".repeat(500)} '\nallowed-tools: [Read, '', ' Bash(git:*) ']\nmetadata: {}` },
      { name: "null-text", metadata: "license: null\ncompatibility: null\nallowed-tools: []\nmetadata: {}", body: "x".repeat(70_000) }
    ];
    for (const { name, metadata, body } of valid) {
      const sourceFile = path.join(root, "input", name, "SKILL.md");
      const content = document(name, metadata, body);
      await mkdir(path.dirname(sourceFile));
      await writeFile(sourceFile, content);
      const created = invoke(["create", name, "--file", sourceFile]);
      assert.equal(created.status, 0, created.stderr);
      assert.equal(created.stderr, "");
      for (const file of [sourceFile, path.join(skillRoot, name, "SKILL.md")]) {
        assert.equal(await readFile(file, "utf8"), content);
      }
      if (name === "string-tools") {
        await writeFile(sourceFile, document(name, metadata, "Changed source body.\n"));
        const duplicate = invoke(["create", name, "--file", sourceFile]);
        assert.equal(duplicate.status, 1, duplicate.stderr);
        assert.equal(duplicate.stdout, "");
        assert.match(duplicate.stderr, /EEXIST/u);
        assert.equal(await readFile(path.join(skillRoot, name, "SKILL.md"), "utf8"), content);
      }
      const checked = invoke(["check", name, "--json"]);
      assert.equal(checked.status, 0, checked.stderr);
      assert.equal(checked.stderr, "");
      const report = JSON.parse(checked.stdout) as { reports: Array<{ name: string; status: string }>; diagnostics: unknown[] };
      assert.equal(report.reports.length, 1);
      assert.equal(report.reports[0]?.name, name);
      assert.equal(report.reports[0]?.status, "unverified");
      assert.deepEqual(report.diagnostics, []);
    }
    const result = invoke(["list", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const catalog = JSON.parse(result.stdout) as { skills: Array<{ name: string; active: boolean }>; warnings: string[] };
    assert.deepEqual(catalog.warnings, []);
    for (const { name } of valid) assert.equal(catalog.skills.some((skill) => skill.name === name && skill.active), true);
  });
});
