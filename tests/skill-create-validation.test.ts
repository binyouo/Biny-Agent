/** Local creation must reject unusable names before reporting installation or writing files. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const cliPath = path.resolve("src/cli/index.ts");
const tsxPath = import.meta.resolve("tsx");

async function withFixture(run: (fixture: { root: string; workspace: string; skillRoot: string; invoke: (args: string[]) => ReturnType<typeof invokeCli> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-create-validation-"));
  const workspace = path.join(root, "workspace");
  const skillRoot = path.join(root, "config", "skills");
  await mkdir(workspace);
  await mkdir(path.join(root, "home"));
  await mkdir(skillRoot, { recursive: true });
  try {
    await run({ root, workspace, skillRoot, invoke: (args) => invokeCli(root, workspace, args) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function invokeCli(root: string, workspace: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--import", tsxPath, cliPath, "skill", ...args], {
    cwd: workspace,
    env: { ...process.env, NODE_NO_WARNINGS: "1", HOME: path.join(root, "home"), BINY_AGENT_DIR: path.join(root, "config") },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function document(name: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: Inert local CLI fixture\n---\nFixture instructions.\n`;
}

test("skill create rejects runtime-invalid names without reporting success or changing installed files", async (context) => {
  for (const name of ["MySkill", "my_skill", "my.skill", "my--skill", "my-skill-", "a".repeat(65)]) {
    await context.test(name, async () => {
      await withFixture(async ({ root, skillRoot, invoke }) => {
        const source = path.join(root, "SKILL.md");
        const content = document(name);
        await writeFile(source, content);
        await mkdir(path.join(skillRoot, "existing-skill"));
        const existing = path.join(skillRoot, "existing-skill", "SKILL.md");
        await writeFile(existing, document("existing-skill"));
        const before = await readdir(skillRoot);
        const result = invoke(["create", name, "--file", source]);
        assert.equal(result.status, 1, `Invalid name must fail, got stdout: ${result.stdout}`);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, `Skill name 无效：${name}。应使用 1-64 位小写字母、数字和单连字符。\n`);
        assert.deepEqual(await readdir(skillRoot), before);
        assert.equal(await readFile(existing, "utf8"), document("existing-skill"));
        assert.equal(await readFile(source, "utf8"), content);
      });
    });
  }
});

test("valid lowercase, numeric, and 64-character names create loadable Skills without altering the source", async () => {
  await withFixture(async ({ root, skillRoot, invoke }) => {
    const names = ["my-skill-2", "7", "a".repeat(64)];
    for (const name of names) {
      const source = path.join(root, `${name}.md`);
      const content = name.length === 64
        ? `---\nname: ${name}\ndescription: ${"x".repeat(1024)}\n---\nFixture instructions.\n`
        : document(name);
      await writeFile(source, content);
      const result = invoke(["create", name, "--file", source]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Installed personal Skill/u);
      assert.equal(await readFile(path.join(skillRoot, name, "SKILL.md"), "utf8"), content);
      assert.equal(await readFile(source, "utf8"), content);
    }
    const listed = invoke(["list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const catalog = JSON.parse(listed.stdout) as { skills: Array<{ name: string; active: boolean }>; warnings: string[] };
    assert.deepEqual(catalog.warnings, []);
    for (const name of names) assert.equal(catalog.skills.some((skill) => skill.name === name && skill.active), true);
  });
});


test("skill create rejects an overlong description before installation rather than leaving an unloadable Skill", async () => {
  await withFixture(async ({ root, skillRoot, invoke }) => {
    const source = path.join(root, "SKILL.md");
    const content = `---\nname: long-description\ndescription: ${"x".repeat(1025)}\n---\nFixture instructions.\n`;
    await writeFile(source, content);
    const result = invoke(["create", "long-description", "--file", source]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Skill description 不能超过 1024 个字符。\n");
    assert.deepEqual(await readdir(skillRoot), []);
    assert.equal(await readFile(source, "utf8"), content);
  });
});


test("skill create still rejects mismatched names and invalid frontmatter before writing", async () => {
  await withFixture(async ({ root, skillRoot, invoke }) => {
    const source = path.join(root, "SKILL.md");
    for (const content of [
      document("different-name"),
      "---\nname: chosen-name\n---\nFixture instructions.\n",
      "---\nname: chosen-name\ndescription: [unterminated\n---\n",
      "---\nname: 7\ndescription: Inert fixture\n---\n"
    ]) {
      await writeFile(source, content);
      const result = invoke(["create", "chosen-name", "--file", source]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stdout, "");
      assert.notEqual(result.stderr, "");
      assert.deepEqual(await readdir(skillRoot), []);
      assert.equal(await readFile(source, "utf8"), content);
    }
  });
});

test("uninstall can still remove an existing directory whose name creation now rejects", async () => {
  await withFixture(async ({ skillRoot, invoke }) => {
    const legacy = path.join(skillRoot, "Legacy_Skill.v1");
    await mkdir(legacy);
    await writeFile(path.join(legacy, "SKILL.md"), document("Legacy_Skill.v1"));
    const result = invoke(["uninstall", "Legacy_Skill.v1"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Uninstalled from Biny: Legacy_Skill.v1\n");
    assert.equal(result.stderr, "");
    await assert.rejects(readdir(legacy), { code: "ENOENT" });
  });
});
