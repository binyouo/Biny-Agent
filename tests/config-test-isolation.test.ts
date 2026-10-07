import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertTestStatePathIsolated } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";

test("direct tests and their children refuse user state and Keychain before side effects; runner isolation does not cover direct execution", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "biny-config-user-home-"));
  const configRoot = path.join(home, ".config", "biny");
  const configPath = path.join(configRoot, "config.json");
  const original = JSON.stringify({ ...defaultConfig, providers: { saved: { type: "ollama", baseUrl: "http://localhost:1", requiresApiKey: false } }, extensions: { ...defaultConfig.extensions, mcp: { saved: { type: "stdio", command: "saved-command", enabled: false } } } });
  await mkdir(configRoot, { recursive: true });
  await writeFile(configPath, original, { mode: 0o600 });
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const keychainMarker = path.join(home, "keychain-accessed");
  await writeFile(path.join(bin, "security"), '#!/bin/sh\nprintf touched > "$BINY_KEYCHAIN_MARKER"\n', { mode: 0o700 });
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, BINY_KEYCHAIN_MARKER: keychainMarker };
    delete env.BINY_AGENT_DIR;
    delete env.NODE_TEST_CONTEXT;
    const probes = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "tests/fixtures/config-user-state.test.ts"], { cwd: process.cwd(), env: { ...env, BINY_ISOLATION_PROBE: "all" }, timeout: 10_000 });
    const results = JSON.parse(probes.stdout.trim()) as Record<string, { rejected: boolean; message: string }>;
    assert.deepEqual(Object.keys(results), ["save", "explicit", "ensure", "migration", "lock", "safe-storage", "agent-path", "config-path", "keychain", "default-keychain", "child"]);
    for (const [mode, result] of Object.entries(results)) {
      assert.equal(result.rejected, true, `${mode} must reject before any user-state side effect`);
      assert.match(result.message, mode === "default-keychain" ? /不支持持久化/u : /Test processes/u);
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.deepEqual(await readdir(configRoot), ["config.json"]);
    }
    await assert.rejects(readFile(keychainMarker), { code: "ENOENT" });
    const alias = path.join(home, "config-alias");
    await symlink(configRoot, alias);
    for (const agentDir of [configRoot, alias]) {
      const child = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", "tests/fixtures/config-user-state.test.ts"], { cwd: process.cwd(), env: { ...env, BINY_AGENT_DIR: agentDir, BINY_ISOLATION_PROBE: "save" }, timeout: 10_000 });
      assert.match(child.stdout, /"rejected":true/u);
      assert.equal(await readFile(configPath, "utf8"), original);
    }
    const isolated = path.join(home, "isolated");
    const child = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "tests/fixtures/config-user-state.test.ts"], { cwd: process.cwd(), env: { ...env, BINY_AGENT_DIR: isolated, BINY_ISOLATION_PROBE: "save" }, timeout: 10_000 });
    assert.equal(JSON.parse(child.stdout.trim()).rejected, false);
    assert.equal(JSON.parse(await readFile(path.join(isolated, "config.json"), "utf8")).defaultModel, defaultConfig.defaultModel);
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally { await rm(home, { recursive: true, force: true }); }
});


test("mocked HOME cannot move the user-state guard while temporary skill roots remain usable", async (context) => {
  const userRoot = path.join(os.homedir(), ".config", "biny");
  const isolated = await mkdtemp(path.join(os.tmpdir(), "biny-test-home-"));
  context.mock.method(os, "homedir", () => isolated);
  try {
    assert.throws(() => assertTestStatePathIsolated(userRoot), /Test processes/u);
    assert.doesNotThrow(() => assertTestStatePathIsolated(path.join(isolated, ".config", "biny")));
  } finally {
    context.mock.restoreAll();
    await rm(isolated, { recursive: true, force: true });
  }
});
