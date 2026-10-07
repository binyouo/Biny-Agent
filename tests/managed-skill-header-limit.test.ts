/** Managed writes must reject headers that runtime discovery cannot completely read. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { importManagedSkillSource, installManagedSkillSource, listManagedSkillSources } from "../src/extensions/managedSkillSources.js";

const cliPath = path.resolve("src/cli/index.ts");
const tsxPath = import.meta.resolve("tsx");
const skillName = "header-skill";

function document(delimiterEnd: number, multibyte = "", newline = "\n", closingWhitespace = "", body = "Fixture instructions.\n"): string {
  const prefix = `---${newline}name: ${skillName}${newline}description: Header boundary fixture${newline}metadata:${newline}  note: ${multibyte}`;
  const padding = delimiterEnd - Buffer.byteLength(`${prefix}${newline}---`, "utf8");
  assert.ok(padding >= 0);
  const header = `${prefix}${"x".repeat(padding)}${newline}---`;
  assert.equal(Buffer.byteLength(header, "utf8"), delimiterEnd);
  return `${header}${closingWhitespace}${newline}${body}`;
}

async function withFixture(run: (fixture: { root: string; sourceFile: string; sourceRoot: string; skillRoot: string; invoke: (args: string[], input?: string) => ReturnType<typeof invokeCli> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-header-"));
  const sourceFile = path.join(root, "input", skillName, "SKILL.md");
  const sourceRoot = path.join(root, "sources");
  const skillRoot = path.join(root, "config", "skills");
  try {
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await mkdir(path.join(root, "workspace"));
    await mkdir(path.join(root, "home"));
    await run({ root, sourceFile, sourceRoot, skillRoot, invoke: (args, input) => invokeCli(root, args, input) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function invokeCli(root: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, ["--import", tsxPath, cliPath, "skill", ...args], {
    cwd: path.join(root, "workspace"),
    env: { ...process.env, NODE_NO_WARNINGS: "1", HOME: path.join(root, "home"), BINY_AGENT_DIR: path.join(root, "config") },
    encoding: "utf8", input, timeout: 15_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test("managed import rejects closing delimiters beyond the runtime UTF-8 byte window before writing", async (context) => {
  for (const [label, multibyte] of [["ASCII", ""], ["CJK", "界".repeat(21_000)], ["emoji", "😀".repeat(16_000)]]) {
    await context.test(label!, async () => {
      await withFixture(async ({ sourceFile, sourceRoot, skillRoot }) => {
        const content = document(65_537, multibyte);
        await writeFile(sourceFile, content);
        await assert.rejects(importManagedSkillSource({ sourceFile, root: sourceRoot, installedRoot: skillRoot }), /frontmatter/u);
        await assert.rejects(readdir(sourceRoot), { code: "ENOENT" });
        await assert.rejects(readdir(path.dirname(skillRoot)), { code: "ENOENT" });
        assert.equal(await readFile(sourceFile, "utf8"), content);
      });
    });
  }
});

test("CLI create rejects unreadable headers from file and stdin without success output or target writes", async () => {
  for (const fromStdin of [false, true]) {
    await withFixture(async ({ sourceFile, skillRoot, invoke }) => {
      const content = document(65_537, "界".repeat(21_000));
      await writeFile(sourceFile, content);
      const result = invoke(["create", skillName, "--file", fromStdin ? "-" : sourceFile], fromStdin ? content : undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /frontmatter/u);
      await assert.rejects(readdir(path.dirname(skillRoot)), { code: "ENOENT" });
      assert.equal(await readFile(sourceFile, "utf8"), content);
    });
  }
});

test("edited cached sources with unreadable headers are warned and refused without changing source or existing Skills", async () => {
  await withFixture(async ({ sourceFile, sourceRoot, skillRoot }) => {
    const original = document(256);
    await writeFile(sourceFile, original);
    await importManagedSkillSource({ sourceFile, root: sourceRoot, installedRoot: skillRoot });
    const existingFile = path.join(skillRoot, "existing-skill", "SKILL.md");
    await mkdir(path.dirname(existingFile), { recursive: true });
    await writeFile(existingFile, "Existing Skill bytes.\n");
    const managedFile = path.join(sourceRoot, skillName, "SKILL.md");
    const content = document(65_537, "界".repeat(21_000));
    await writeFile(managedFile, content);
    const listed = await listManagedSkillSources({ root: sourceRoot, installedRoot: skillRoot });
    assert.deepEqual(listed.sources, []);
    assert.equal(listed.warnings.length, 1);
    assert.match(listed.warnings[0]!, /frontmatter/u);
    await assert.rejects(installManagedSkillSource({ sourceId: skillName, root: sourceRoot, skillRoot }), /Skill 来源不存在/u);
    assert.deepEqual(await readdir(skillRoot), ["existing-skill"]);
    assert.equal(await readFile(existingFile, "utf8"), "Existing Skill bytes.\n");
    assert.equal(await readFile(managedFile, "utf8"), content);
    assert.equal(await readFile(sourceFile, "utf8"), original);
  });
});

test("complete delimiter at the byte boundary and large bodies retain exact bytes through import, install, list and check", async (context) => {
  const valid = [
    ["one byte before", document(65_535)],
    ["exact ASCII", document(65_536)],
    ["exact CJK", document(65_536, "界".repeat(21_000))],
    ["exact emoji", document(65_536, "😀".repeat(16_000))],
    ["CRLF after boundary", document(65_536, "", "\r\n")],
    ["closing whitespace after boundary", document(65_536, "", "\n", " \t".repeat(100))],
    ["large body", document(256, "", "\n", "", "正文".repeat(20_000))]
  ] as const;
  for (const [label, content] of valid) {
    await context.test(label, async () => {
      await withFixture(async ({ sourceFile, sourceRoot, skillRoot, invoke }) => {
        await writeFile(sourceFile, content);
        await importManagedSkillSource({ sourceFile, root: sourceRoot, installedRoot: skillRoot });
        const installed = await installManagedSkillSource({ sourceId: skillName, root: sourceRoot, skillRoot });
        assert.equal(installed.installed, true);
        for (const file of [sourceFile, path.join(sourceRoot, skillName, "SKILL.md"), path.join(skillRoot, skillName, "SKILL.md")]) {
          assert.equal(await readFile(file, "utf8"), content);
        }
        const managed = await listManagedSkillSources({ root: sourceRoot, installedRoot: skillRoot });
        assert.deepEqual(managed.warnings, []);
        assert.equal(managed.sources[0]?.installed, true);
        assertRuntimeVisible(invoke);
      });
    });
  }
});

function assertRuntimeVisible(invoke: (args: string[]) => ReturnType<typeof invokeCli>): void {
  const listed = invoke(["list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stderr, "");
  const catalog = JSON.parse(listed.stdout) as { skills: Array<{ name: string; active: boolean }>; warnings: string[] };
  assert.deepEqual(catalog.warnings, []);
  assert.equal(catalog.skills.some((skill) => skill.name === skillName && skill.active), true);
  const checked = invoke(["check", skillName, "--json"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stderr, "");
  const report = JSON.parse(checked.stdout) as { reports: Array<{ name: string; status: string }>; diagnostics: unknown[] };
  assert.equal(report.reports.length, 1);
  assert.equal(report.reports[0]?.name, skillName);
  assert.equal(report.reports[0]?.status, "unverified");
  assert.deepEqual(report.diagnostics, []);
}

test("CLI create accepts an exact multibyte boundary and a large body without changing bytes", async () => {
  for (const content of [document(65_536, "界".repeat(21_000)), document(256, "", "\n", "", "正文".repeat(20_000))]) {
    await withFixture(async ({ sourceFile, skillRoot, invoke }) => {
      await writeFile(sourceFile, content);
      const created = invoke(["create", skillName, "--file", sourceFile]);
      assert.equal(created.status, 0, created.stderr);
      assert.equal(created.stderr, "");
      assert.equal(await readFile(path.join(skillRoot, skillName, "SKILL.md"), "utf8"), content);
      assertRuntimeVisible(invoke);
    });
  }
});

test("full-document validation rejects a fake closing delimiter completed only by truncation", async () => {
  await withFixture(async ({ sourceFile, sourceRoot, skillRoot, invoke }) => {
    const content = `${document(65_536).slice(0, 65_536)}not-a-delimiter\nBody\n`;
    await writeFile(sourceFile, content);
    await assert.rejects(importManagedSkillSource({ sourceFile, root: sourceRoot, installedRoot: skillRoot }), /结束分隔线/u);
    await assert.rejects(readdir(sourceRoot), { code: "ENOENT" });
    const created = invoke(["create", skillName, "--file", sourceFile]);
    assert.equal(created.status, 1, created.stderr);
    assert.equal(created.stdout, "");
    assert.match(created.stderr, /结束分隔线/u);
    await assert.rejects(readdir(path.dirname(skillRoot)), { code: "ENOENT" });
    assert.equal(await readFile(sourceFile, "utf8"), content);
  });
});

test("a UTF-8 codepoint split by the metadata read window cannot make an oversized header valid", async () => {
  await withFixture(async ({ sourceFile, sourceRoot, skillRoot }) => {
    const prefix = `---\nname: ${skillName}\ndescription: Header boundary fixture\nmetadata:\n  note: `;
    const content = `${prefix}${"界".repeat(22_000)}\n---\nBody\n`;
    assert.equal(Buffer.from(content).subarray(0, 65_536).toString("utf8").endsWith("\uFFFD"), true);
    await writeFile(sourceFile, content);
    await assert.rejects(importManagedSkillSource({ sourceFile, root: sourceRoot, installedRoot: skillRoot }), /frontmatter/u);
    await assert.rejects(readdir(sourceRoot), { code: "ENOENT" });
    await assert.rejects(readdir(path.dirname(skillRoot)), { code: "ENOENT" });
  });
});

test("a valid YAML key beginning with dashes cannot impersonate a delimiter at the byte boundary", async (context) => {
  const content = `${document(65_536).slice(0, 65_536)}not-a-delimiter: accepted\ncompatibility: Declared after the read window\n---\nBody\n`;
  for (const entry of ["managed import", "CLI create"]) {
    await context.test(entry, async () => {
      await withFixture(async ({ sourceFile, sourceRoot, skillRoot, invoke }) => {
        await writeFile(sourceFile, content);
        if (entry === "managed import") {
          await assert.rejects(importManagedSkillSource({ sourceFile, root: sourceRoot, installedRoot: skillRoot }), /frontmatter/u);
          await assert.rejects(readdir(sourceRoot), { code: "ENOENT" });
        } else {
          const created = invoke(["create", skillName, "--file", sourceFile]);
          assert.equal(created.status, 1, created.stderr);
          assert.equal(created.stdout, "");
          assert.match(created.stderr, /frontmatter/u);
        }
        await assert.rejects(readdir(path.dirname(skillRoot)), { code: "ENOENT" });
        assert.equal(await readFile(sourceFile, "utf8"), content);
      });
    });
  }
});
