import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activityConfigSetCommand } from "../src/cli/commands/activity.js";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";

const entry = path.resolve("src/cli/index.ts");

test("activity config set reports persisted normalized text values without replacing unrelated settings", async () => {
  await fixture(async (root, globalRoot) => {
    const runCli = (key: string, value: string) => spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), entry, "activity", "config", "set", key, value
    ], { cwd: root, env: { ...process.env, BINY_AGENT_DIR: globalRoot }, encoding: "utf8", timeout: 15_000 });
    // These expectations come from the public settings bounds; the saved file is independently read below.
    for (const [key, input, expected] of [
      ["heartbeatMs", "1", 60_000],
      ["heartbeatMs", "0", 120_000],
      ["jpegQuality", "100", 95],
      ["browserPollIntervalMs", "0", 0],
      ["enabled", "false", false],
      ["ocrLanguages", '[" en-US ", "zh-Hans"]', ["en-US", "zh-Hans"]],
      ["outputDirectory", JSON.stringify(`  ${path.join(root, "new-records")}  `), path.join(root, "new-records")]
    ] as const) {
      const before = await loadConfigFile(globalRoot);
      const result = runCli(key, input);
      assert.equal(result.status, 0, result.stderr);
      const saved = await loadConfigFile(globalRoot);
      const { credentialRevisions: _beforeRevisions, ...beforeSettings } = before;
      const { credentialRevisions: _savedRevisions, ...savedSettings } = saved;
      assert.deepEqual(savedSettings, { ...beforeSettings, activity: { ...before.activity, [key]: expected } },
        "only the requested setting changes; credential revision bookkeeping is not a user setting");
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(globalRoot, "config.json"), "utf8")).activity[key], expected,
        "the file contains the same value confirmed by the CLI");
      assert.equal(result.stdout.split("\n")[0], `${key} = ${JSON.stringify(expected)}`,
        "text confirmation must show the persisted value, not the pre-normalization input");
    }
    const beforeInvalid = await fs.readFile(path.join(globalRoot, "config.json"));
    const invalid = runCli("heartbeatMs", "{}");
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "", "invalid object input must never receive a saved confirmation");
    assert.deepEqual(await fs.readFile(path.join(globalRoot, "config.json")), beforeInvalid);
  });
});

test("activity config save publication failures preserve the previous file, print no success, and permit retry", async () => {
  await fixture(async (root, globalRoot) => {
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    const originalRename = fs.rename;
    const originalLog = console.log;
    const output: unknown[][] = [];
    const target = path.join(globalRoot, "config.json");
    const before = await fs.readFile(target);
    const failure = new Error("Injected config publication failure");
    try {
      process.env.BINY_AGENT_DIR = globalRoot;
      console.log = (...args: unknown[]) => { output.push(args); };
      fs.rename = async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] === target) throw failure;
        return await originalRename(...args);
      };
      await assert.rejects(activityConfigSetCommand(root, "heartbeatMs", "1"), error => error === failure);
      assert.deepEqual(output, [], "failed atomic publication must not print a saved confirmation");
      assert.deepEqual(await fs.readFile(target), before, "failed save must preserve the complete previous document");
      assert.equal((await fs.readdir(globalRoot)).some(name => name.endsWith(".tmp")), false);
      fs.rename = originalRename;
      await activityConfigSetCommand(root, "heartbeatMs", "1");
      assert.equal((await loadConfigFile(globalRoot)).activity.heartbeatMs, 60_000);
      assert.deepEqual(output[0], ["heartbeatMs = 60000"]);
      output.length = 0;
      await activityConfigSetCommand(root, "jpegQuality", "0", { json: true });
      const saved = await loadConfigFile(globalRoot);
      assert.equal(saved.activity.jpegQuality, 55);
      assert.equal(output.length, 1);
      assert.deepEqual(JSON.parse(String(output[0]?.[0])), saved.activity,
        "the command function keeps its full normalized JSON response");
    } finally {
      fs.rename = originalRename;
      console.log = originalLog;
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
    }
  });
});

async function fixture(run: (root: string, globalRoot: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-config-feedback-")));
  const globalRoot = path.join(root, "agent");
  const providerAlias = `config-feedback-${randomUUID()}`;
  try {
    await saveConfigFile(globalRoot, configSchema.parse({
      ...defaultConfig,
      defaultModel: "local-test",
      providers: { [providerAlias]: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
      models: { "local-test": { provider: providerAlias, model: "local-test" } },
      activity: { ...defaultConfig.activity, enabled: false, heartbeatMs: 180_000, outputDirectory: path.join(root, "records") },
      chat: { ...defaultConfig.chat, temperature: 0.3 }
    }));
    await run(root, globalRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
