import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { localReferenceKinds, parseLocalReferenceUri } from "../src/session/localReferences.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-retired-crystal-"));
try {
  const help = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "--help"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, BINY_AGENT_DIR: root } });
  assert.doesNotMatch(help, /^\s+crystal\b/mu);
  const legacyConfig = { ...structuredClone(defaultConfig), crystal: { passiveEnabled: true, semanticScanEnabled: false, contour: { count: 4, turns: 3, spread: 2 }, nucleus: { count: 8, turns: 5, spread: 2 }, dormantDays: 14 } };
  const parsed = configSchema.parse(legacyConfig);
  assert.equal(Object.hasOwn(parsed, "crystal"), false);
  await writeFile(path.join(root, "config.json"), JSON.stringify(legacyConfig));
  const loaded = await loadConfigFile(root);
  assert.equal(Object.hasOwn(loaded, "crystal"), false);
  assert.equal(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).crystal.passiveEnabled, true);
  await saveConfigFile(root, loaded);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")), "crystal"), false);
  const response = await handleActivityHttpRequest({ method: "GET", pathname: "/api/crystal/overview" }, { loadSettings: async () => defaultConfig.activity });
  assert.equal(response.status, 404);
  assert.equal(localReferenceKinds.some(({ kind }) => kind === "crystal" || kind === "bundle"), false);
  assert.throws(() => parseLocalReferenceUri("biny://crystal/old"), /Unsupported reference kind/u);
  const memory = new MemoryStorage(root, { agentDir: root });
  await memory.writeEntry({ content: "Existing memory" });
  memory.close();
  const db = new DatabaseSync(path.join(root, "agent.sqlite"));
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'crystals'").get()?.n, 0);
    db.exec("CREATE TABLE crystals (id TEXT PRIMARY KEY, name TEXT); INSERT INTO crystals VALUES ('old', 'preserve me')");
  } finally { db.close(); }
  const reopened = new MemoryStorage(root, { agentDir: root });
  assert.equal((await reopened.listEntries()).total, 1);
  reopened.close();
  const old = new DatabaseSync(path.join(root, "agent.sqlite"), { readOnly: true });
  try { assert.equal(old.prepare("SELECT name FROM crystals WHERE id = 'old'").get()?.name, "preserve me"); }
  finally { old.close(); }
} finally { await rm(root, { recursive: true, force: true }); }
