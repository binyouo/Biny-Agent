/** The public Skill CLI must discover the same active catalog as its workspace runtime. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Command } from "commander";
import { registerSkillCommands } from "../src/cli/commands/skills.js";
import { saveConfigFile } from "../src/config/loader.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createProjectSkillKey, createSkillRef } from "../src/extensions/skillRef.js";

interface ListedSkill { name: string; active: boolean }
interface CatalogResult { skills: ListedSkill[]; warnings: string[] }

async function withFixture(context: TestContext, run: (fixture: { root: string; workspace: string; globalDir: string }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-skill-cli-config-")));
  const workspace = path.join(root, "workspace");
  const globalDir = path.join(root, "config");
  const priorAgentDir = process.env.BINY_AGENT_DIR;
  const priorExitCode = process.exitCode;
  context.mock.method(os, "homedir", () => path.join(root, "home"));
  process.env.BINY_AGENT_DIR = globalDir;
  try {
    await mkdir(workspace);
    await run({ root, workspace, globalDir });
  } finally {
    context.mock.restoreAll();
    process.exitCode = priorExitCode;
    if (priorAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(path.join(directory, name), { recursive: true });
  await writeFile(path.join(directory, name, "SKILL.md"), `---\nname: ${name}\ndescription: Inert CLI catalog fixture\n---\nFixture instructions.\n`);
}

async function invoke(context: TestContext, workspace: string, args: string[]): Promise<{ output: string; errors: string[] }> {
  const output: string[] = [];
  const errors: string[] = [];
  const log = context.mock.method(console, "log", (value: unknown) => output.push(String(value)));
  const error = context.mock.method(console, "error", (value: unknown) => errors.push(String(value)));
  try {
    const program = new Command();
    registerSkillCommands(program, workspace);
    await program.parseAsync(["skill", ...args], { from: "user" });
    return { output: output.join("\n"), errors };
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
}

async function list(context: TestContext, workspace: string): Promise<CatalogResult> {
  const result = await invoke(context, workspace, ["list", "--json"]);
  assert.deepEqual(result.errors, []);
  return JSON.parse(result.output) as CatalogResult;
}

function config(extensions: Partial<AgentConfig["extensions"]>): AgentConfig {
  return { ...defaultConfig, extensions: { ...defaultConfig.extensions, ...extensions } };
}

test("skill list includes configured project paths and reloads them for each workspace invocation", async (context) => {
  await withFixture(context, async ({ root, workspace, globalDir }) => {
    await writeSkill(path.join(workspace, "custom-skills"), "custom-workflow");
    await writeSkill(path.join(workspace, "replacement-skills"), "replacement-workflow");
    await saveConfigFile(globalDir, config({ skills: ["custom-skills"] }));
    assert.equal((await list(context, workspace)).skills.some((skill) => skill.name === "custom-workflow"), true);
    const other = path.join(root, "other");
    await mkdir(other);
    assert.equal((await list(context, other)).skills.some((skill) => skill.name === "custom-workflow"), false);
    await saveConfigFile(globalDir, config({ skills: ["replacement-skills"] }));
    const refreshed = await list(context, workspace);
    assert.equal(refreshed.skills.some((skill) => skill.name === "custom-workflow"), false);
    assert.equal(refreshed.skills.some((skill) => skill.name === "replacement-workflow"), true);
  });
});

test("skill list applies global defaults and only the requested workspace's activation overrides", async (context) => {
  await withFixture(context, async ({ root, workspace, globalDir }) => {
    const other = path.join(root, "other");
    await mkdir(other);
    await writeSkill(path.join(globalDir, "skills"), "disabled-globally");
    await writeSkill(path.join(globalDir, "skills"), "disabled-here");
    const globalRef = createSkillRef({ scope: "global", source: "biny", name: "disabled-globally" });
    const projectRef = createSkillRef({ scope: "global", source: "biny", name: "disabled-here" });
    await saveConfigFile(globalDir, config({
      skillDefaults: { [globalRef]: false, "builtin:browser": false },
      skillProjectOverrides: { [createProjectSkillKey(workspace)]: { [projectRef]: false } }
    }));
    const here = await list(context, workspace);
    assert.equal(here.skills.some((skill) => skill.name === "disabled-globally"), false);
    assert.equal(here.skills.some((skill) => skill.name === "disabled-here"), false);
    assert.equal(here.skills.some((skill) => skill.name === "browser"), false);
    assert.equal((await list(context, other)).skills.some((skill) => skill.name === "disabled-here"), true);
    await saveConfigFile(globalDir, config({
      skillDefaults: { [globalRef]: false },
      skillProjectOverrides: { [createProjectSkillKey(workspace)]: { [globalRef]: true } }
    }));
    assert.equal((await list(context, workspace)).skills.some((skill) => skill.name === "disabled-globally"), true);
    assert.equal((await list(context, other)).skills.some((skill) => skill.name === "disabled-globally"), false);
  });
});

test("skill list retains default discovery without a config file", async (context) => {
  await withFixture(context, async ({ workspace }) => {
    await writeSkill(path.join(workspace, ".biny", "skills"), "default-workflow");
    const catalog = await list(context, workspace);
    assert.equal(catalog.skills.some((skill) => skill.name === "default-workflow"), true);
    assert.equal(catalog.skills.some((skill) => skill.name === "browser"), true);
  });
});


test("public CLI entry lists a configured custom skill from its working directory", async (context) => {
  await withFixture(context, async ({ root, workspace, globalDir }) => {
    await writeSkill(path.join(workspace, "custom-skills"), "custom-workflow");
    await saveConfigFile(globalDir, config({ skills: ["custom-skills"] }));
    const result = spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"), "skill", "list", "--json"
    ], {
      cwd: workspace,
      env: { ...process.env, HOME: path.join(root, "home"), BINY_AGENT_DIR: globalDir },
      encoding: "utf8", timeout: 15_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(result.stdout) as CatalogResult;
    assert.equal(catalog.skills.some((skill) => skill.name === "custom-workflow"), true);
  });
});

test("skill search and find mark only the configured active workspace catalog as installed", async (context) => {
  await withFixture(context, async ({ root, workspace, globalDir }) => {
    const other = path.join(root, "other");
    await mkdir(other);
    await writeSkill(path.join(workspace, "custom-skills"), "custom-workflow");
    await writeSkill(path.join(globalDir, "skills"), "disabled-workflow");
    const disabledRef = createSkillRef({ scope: "global", source: "biny", name: "disabled-workflow" });
    await saveConfigFile(globalDir, config({
      skills: ["custom-skills"],
      skillDefaults: { [disabledRef]: false },
      skillProjectOverrides: { [createProjectSkillKey(workspace)]: { [disabledRef]: true } }
    }));
    const queries: URL[] = [];
    context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://skills.sh");
      queries.push(url);
      return new Response(JSON.stringify({
        query: "workflow", count: 2,
        skills: ["custom-workflow", "disabled-workflow"].map((name) => ({
          name, skillId: `skills/${name}`, source: "fixture-owner/fixture-repo"
        }))
      }), { headers: { "content-type": "application/json" } });
    });
    for (const command of ["search", "find"]) {
      for (const target of [workspace, other]) {
        const result = await invoke(context, target, [command, "workflow", "--json", "--limit", "2", "--offset", "3"]);
        assert.deepEqual(result.errors, []);
        const search = JSON.parse(result.output) as { skills: Array<{ name: string; installed: boolean }>; totalCount: number; query: string };
        assert.deepEqual(Object.keys(search).sort(), ["query", "skills", "totalCount"]);
        assert.deepEqual(search.skills.map((skill) => [skill.name, skill.installed]), [
          ["custom-workflow", target === workspace], ["disabled-workflow", target === workspace]
        ]);
        assert.equal(search.totalCount, 2);
        assert.equal(search.query, "workflow");
      }
    }
    assert.equal(queries.length, 4);
    assert.equal(queries.every((url) => url.searchParams.get("limit") === "2" && url.searchParams.get("offset") === "3"), true);
  });
});

test("invalid config is reported rather than inventing an active catalog or searching remotely", async (context) => {
  await withFixture(context, async ({ workspace, globalDir }) => {
    await mkdir(globalDir);
    await writeFile(path.join(globalDir, "config.json"), "invalid config", { mode: 0o600 });
    context.mock.method(globalThis, "fetch", async () => { assert.fail("invalid config must fail before remote search"); });
    for (const args of [["list", "--json"], ["search", "workflow", "--json"]]) {
      const result = await invoke(context, workspace, args);
      assert.equal(result.output, "");
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!, /Failed to load config.json/u);
      assert.equal(process.exitCode, 1);
    }
  });
});
