import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { executeConfigurationCommand } from "../src/config/commands.js";
import { createFileConfigStore } from "../src/config/store.js";

const cli = path.resolve("src/cli/index.ts");

test("module CLI persists configuration, selects models, and preserves failed updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-module-cli-"));
  try {
    const config = structuredClone(defaultConfig);
    config.providers = { fixture: { type: "openai-compatible", apiKeyEnv: "BINY_CLI_FIXTURE_KEY", baseUrl: "http://127.0.0.1:1/v1" } };
    config.models = { first: { provider: "fixture", model: "gpt-4o-mini" }, second: { provider: "fixture", model: "gpt-4o" } };
    config.defaultModel = "first";
    await writeFile(path.join(root, "config.json"), JSON.stringify(config));
    const changed = await run(root, ["config", "set", "heartbeat.intervalMinutes", "45", "--json"]);
    assert.equal(changed.code, 0, changed.stderr);
    assert.deepEqual(JSON.parse(changed.stdout), { path: "heartbeat.intervalMinutes", value: 45 });
    const queried = await run(root, ["config", "get", "heartbeat", "--json"]);
    assert.equal(queried.code, 0, queried.stderr);
    assert.equal(JSON.parse(queried.stdout).intervalMinutes, 45);
    const before = await readFile(path.join(root, "config.json"), "utf8");
    for (const args of [["config", "set", "heartbeat.intervalMinutes", "0"], ["model", "set", "missing"], ["provider", "remove", "fixture"]]) {
      const failed = await run(root, args);
      assert.equal(failed.code, 1, failed.stdout);
      assert.notEqual(failed.stderr, "");
      assert.equal(await readFile(path.join(root, "config.json"), "utf8"), before);
    }
    const selected = await run(root, ["model", "set", "second", "--json"]);
    assert.equal(selected.code, 0, selected.stderr);
    assert.equal(JSON.parse((await run(root, ["config", "get", "defaultModel", "--json"])).stdout), "second");
    const providerFile = path.join(root, "provider.json");
    await writeFile(providerFile, JSON.stringify({ type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "OTHER_FIXTURE_KEY" }));
    const added = await run(root, ["provider", "add", "other", "--file", providerFile, "--json"]);
    assert.equal(added.code, 0, added.stderr);
    const listed = await run(root, ["provider", "list", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).providers.other.apiKeyEnv, "OTHER_FIXTURE_KEY");
    assert.equal((await run(root, ["provider", "remove", "other", "--json"])).code, 0);
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, ".biny"), { recursive: true });
    const projectSettings = path.join(workspace, ".biny", "settings.json");
    await writeFile(projectSettings, '{"defaultModel":"first"}');
    const globalSelection = await run(root, ["model", "set", "second", "--json"], workspace);
    assert.equal(globalSelection.code, 0, globalSelection.stderr);
    assert.equal(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).defaultModel, "second");
    assert.equal(await readFile(projectSettings, "utf8"), '{"defaultModel":"first"}');
    const modelList = await run(root, ["model", "list", "--provider", "fixture", "--json"]);
    assert.equal(modelList.code, 0, modelList.stderr);
    assert.deepEqual(JSON.parse(modelList.stdout).models.map((model: { alias: string }) => model.alias).sort(), ["first", "second"]);
    const valid = await readFile(path.join(root, "config.json"), "utf8");
    for (const key of ["heartbeat.missing", "heartbeat.__proto__.polluted"]) {
      const unknown = await run(root, ["config", "set", key, "true", "--json"]);
      assert.equal(unknown.code, 1);
      assert.equal(unknown.stdout, "");
      assert.equal(await readFile(path.join(root, "config.json"), "utf8"), valid);
    }
    await writeFile(providerFile, '{"apiKey":"fixture-file-value",');
    const invalidFile = await run(root, ["provider", "add", "invalid", "--file", providerFile, "--json"]);
    assert.equal(invalidFile.code, 1);
    assert.equal(invalidFile.stdout, "");
    assert.match(invalidFile.stderr, /valid JSON/u);
    assert.doesNotMatch(invalidFile.stderr, /fixture-file-value/u);
    assert.equal(await readFile(path.join(root, "config.json"), "utf8"), valid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configuration queries redact stored credentials before selecting a path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-config-output-"));
  const credentials = new Map<string, string>();
  const store = createFileConfigStore(root, { globalDir: root, credentialStore: {
    persistent: true,
    async get(account) { return credentials.get(account); },
    async set(account, value) { credentials.set(account, value); },
    async delete(account) { credentials.delete(account); }
  } });
  try {
    const config = structuredClone(defaultConfig);
    config.defaultModel = "fixture";
    config.providers = { fixture: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
    config.models = { fixture: { provider: "fixture", model: "fixture" } };
    await store.save(config);
    credentials.set("provider:fixture:apiKey", "fixture-credential-value");
    assert.equal(await executeConfigurationCommand(store, "config.get", { path: "providers.fixture.apiKey" }, root), "[redacted]");
    const providers = await executeConfigurationCommand(store, "provider.list", {}, root);
    assert.doesNotMatch(JSON.stringify(providers), /fixture-credential-value/u);
    assert.doesNotMatch(await readFile(path.join(root, "config.json"), "utf8"), /fixture-credential-value/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("user and named-agent CLI reuse persisted documents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-document-cli-"));
  try {
    const saved = await run(root, ["user", "set", "项目文档使用中文", "--json"]);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(await readFile(path.join(root, "USER.md"), "utf8"), "项目文档使用中文\n");
    const shown = await run(root, ["user", "show", "--json"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).content, "项目文档使用中文");
    await mkdir(path.join(root, "agents"));
    await writeFile(path.join(root, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Review changes\n---\n\nRead the changed code.\n");
    const agents = await run(root, ["agent", "list", "--json"]);
    assert.equal(agents.code, 0, agents.stderr);
    assert.equal(JSON.parse(agents.stdout).agents[0].name, "reviewer");
    const agent = await run(root, ["agent", "show", "reviewer", "--json"]);
    assert.equal(agent.code, 0, agent.stderr);
    assert.equal(JSON.parse(agent.stdout).prompt, "Read the changed code.");
    const missing = await run(root, ["agent", "show", "absent", "--json"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, "");
    const definitionFile = path.join(root, "worker.md");
    await writeFile(definitionFile, "---\nname: writer\ndescription: Write project documentation\nruntime: builtin\n---\n\nDescribe the implemented behavior.\n");
    const created = await run(root, ["agent", "create", "writer", "--file", definitionFile, "--json"]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(JSON.parse((await run(root, ["agent", "show", "writer", "--json"])).stdout).scope, "project");
    const duplicate = await run(root, ["agent", "create", "writer", "--file", definitionFile, "--json"]);
    assert.equal(duplicate.code, 1);
    assert.equal((await run(root, ["agent", "delete", "writer", "--json"])).code, 0);
    assert.equal((await run(root, ["agent", "show", "writer", "--json"])).code, 1);
    assert.equal((await run(root, ["agent", "create", "writer", "--file", definitionFile, "--global", "--json"])).code, 0);
    assert.equal((await run(root, ["agent", "create", "writer", "--file", definitionFile, "--json"])).code, 0);
    assert.equal(JSON.parse((await run(root, ["agent", "show", "writer", "--json"])).stdout).scope, "project");
    const removedGlobal = await run(root, ["agent", "delete", "writer", "--global", "--json"]);
    assert.equal(removedGlobal.code, 0, removedGlobal.stderr);
    assert.equal(JSON.parse(removedGlobal.stdout).scope, "global");
    assert.equal(JSON.parse((await run(root, ["agent", "show", "writer", "--json"])).stdout).scope, "project");
    assert.equal((await run(root, ["agent", "delete", "writer", "--json"])).code, 0);
    await writeFile(definitionFile, "missing metadata");
    assert.equal((await run(root, ["agent", "create", "invalid", "--file", definitionFile, "--json"])).code, 1);
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, "linked"));
    await writeFile(definitionFile, "---\nname: writer\ndescription: Write docs\n---\n\nWrite documentation.\n");
    assert.equal((await run(root, ["config", "set", "extensions.subagent.agentPaths", '["linked/new"]', "--json"])).code, 0);
    const linked = await run(root, ["agent", "create", "writer", "--file", definitionFile, "--json"]);
    assert.equal(linked.code, 1);
    await assert.rejects(stat(path.join(root, "outside", "new")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function run(root: string, args: string[], cwd = root): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...process.execArgv, cli, ...args], {
    cwd, env: { ...process.env, BINY_AGENT_DIR: root, BINY_CLI_FIXTURE_KEY: "fixture-key" }, signal: AbortSignal.timeout(20_000)
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdin.end();
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}
