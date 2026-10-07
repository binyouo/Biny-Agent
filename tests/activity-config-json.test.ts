import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";

const entry = path.resolve("src/cli/index.ts");

test("activity config set --json reaches the real CLI action and returns only normalized saved settings", async () => {
  await fixture(async (root, globalRoot) => {
    for (const [args, key, expected] of [
      [["activity", "config", "set", "jpegQuality", "100", "--json"], "jpegQuality", 95],
      [["activity", "config", "--json", "set", "heartbeatMs", "1"], "heartbeatMs", 60_000],
      [["activity", "config", "set", "--json", "browserPollIntervalMs", "0"], "browserPollIntervalMs", 0],
      [["--theme", "light", "activity", "config", "set", "enabled", "false", "--json"], "enabled", false],
      [["activity", "config", "set", "ocrLanguages", '[" en-US ", "zh-Hans"]', "--json", "--theme", "dark"], "ocrLanguages", ["en-US", "zh-Hans"]]
    ] as const) {
      const before = await loadConfigFile(globalRoot);
      const result = runCli(root, globalRoot, ...args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const saved = await loadConfigFile(globalRoot);
      const { credentialRevisions: _beforeRevisions, ...beforeSettings } = before;
      const { credentialRevisions: _savedRevisions, ...savedSettings } = saved;
      assert.deepEqual(savedSettings, { ...beforeSettings, activity: { ...before.activity, [key]: expected } },
        "only the requested setting changes; credential revision bookkeeping is not a user setting");
      assert.deepEqual(JSON.parse(result.stdout), saved.activity,
        "the CLI must forward the parent-consumed JSON flag instead of printing a text confirmation");
      assert.equal(result.stdout, `${JSON.stringify(saved.activity)}\n`);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(globalRoot, "config.json"), "utf8")).activity, saved.activity);
    }
  });
});

test("activity config keeps read-only compact JSON and pretty text, while set without --json stays text", async () => {
  await fixture(async (root, globalRoot) => {
    const target = path.join(globalRoot, "config.json");
    const before = await fs.readFile(target);
    const saved = await loadConfigFile(globalRoot);
    for (const json of [false, true]) {
      const result = runCli(root, globalRoot, "activity", "config", ...(json ? ["--json"] : []));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, `${JSON.stringify(saved.activity, null, json ? undefined : 2)}\n`);
      assert.deepEqual(await fs.readFile(target), before, "showing config must not publish changes");
    }
    const result = runCli(root, globalRoot, "activity", "config", "set", "enabled", "true");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "enabled = true\n运行中的记录器会自动应用；会话/空闲计时相关改动在下一个会话生效。\n");
    assert.equal((await loadConfigFile(globalRoot)).activity.enabled, true);
  });
});

test("activity config set --json failures exit nonzero with no success output and preserve the previous config", async () => {
  await fixture(async (root, globalRoot) => {
    const target = path.join(globalRoot, "config.json");
    const before = await fs.readFile(target);
    for (const [key, value] of [["heartbeatMs", "{}"], ["unknownSetting", "1"]] as const) {
      const result = runCli(root, globalRoot, "activity", "config", "set", key, value, "--json");
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.notEqual(result.stderr, "");
      assert.deepEqual(await fs.readFile(target), before);
    }
    const preload = path.join(root, "fail-config-publication.mjs");
    await fs.writeFile(preload, [
      'import { promises as fs } from "node:fs";',
      'import path from "node:path";',
      'const rename = fs.rename;',
      'fs.rename = async (source, destination) => {',
      '  if (destination === path.join(process.env.BINY_AGENT_DIR, "config.json")) throw new Error("Injected config publication failure");',
      '  return await rename(source, destination);',
      '};'
    ].join("\n"));
    const failedSave = spawnSync(process.execPath, [
      "--import", preload, "--import", import.meta.resolve("tsx"), entry,
      "activity", "config", "set", "jpegQuality", "100", "--json"
    ], { cwd: root, env: { ...process.env, BINY_AGENT_DIR: globalRoot, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 15_000 });
    assert.equal(failedSave.status, 1, failedSave.stderr);
    assert.equal(failedSave.stdout, "");
    assert.match(failedSave.stderr, /Injected config publication failure/u);
    assert.deepEqual(await fs.readFile(target), before);
    assert.equal((await fs.readdir(globalRoot)).some(name => name.endsWith(".tmp")), false);
    const retry = runCli(root, globalRoot, "activity", "config", "set", "jpegQuality", "100", "--json");
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(retry.stderr, "");
    assert.deepEqual(JSON.parse(retry.stdout), (await loadConfigFile(globalRoot)).activity);
  });
});

function runCli(root: string, globalRoot: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, ...args], {
    cwd: root, env: { ...process.env, BINY_AGENT_DIR: globalRoot, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 15_000
  });
}

async function fixture(run: (root: string, globalRoot: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-config-json-")));
  const globalRoot = path.join(root, "agent");
  const providerAlias = `config-json-${randomUUID()}`;
  try {
    await saveConfigFile(globalRoot, configSchema.parse({
      ...defaultConfig,
      defaultModel: "local-test",
      providers: { [providerAlias]: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
      models: { "local-test": { provider: providerAlias, model: "local-test" } },
      activity: { ...defaultConfig.activity, enabled: false, outputDirectory: path.join(root, "records") },
      chat: { ...defaultConfig.chat, temperature: 0.3 }
    }));
    await run(root, globalRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
