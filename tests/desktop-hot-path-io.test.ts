import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { projectSessionsDir } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { sessionCatalogRecordRevision, updateSessionCatalogMetadata, writeSessionCatalogRecord } from "../src/session/catalog.js";
import { LocalReferenceService } from "../src/session/localReferences.js";
import { createSessionFile } from "../src/session/store.js";

test("Desktop local actions read only their own history and leave the Runtime cold", { timeout: 30_000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-hot-path-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  const state = new DesktopStateStore(path.join(root, "desktop.json"));
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  const projects = new DesktopProjectService(state, storage, configStore);
  const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
  const runtimeAdmission = agents as unknown as { initializeRuntime(projectId: string, allowSpawn: boolean, lifetime: symbol): Promise<unknown> };
  const initializeRuntime = runtimeAdmission.initializeRuntime.bind(agents);
  const runtimeStarts: string[] = [];
  t.mock.method(runtimeAdmission, "initializeRuntime", async (projectId: string, allowSpawn: boolean, lifetime: symbol) => {
    if (allowSpawn) runtimeStarts.push(projectId);
    return await initializeRuntime(projectId, allowSpawn, lifetime);
  });
  t.after(async () => {
    await agents.closeAll();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  await state.load();
  await storage.initialize();
  const config = structuredClone(defaultConfig);
  config.providers = { isolated: { type: "openai", apiKeyEnv: "BINY_HOT_PATH_UNCONFIGURED_KEY" } };
  config.models = { isolated: { provider: "isolated", model: "isolated" } };
  config.defaultModel = "isolated";
  await configStore.save(config);
  const project = await projects.createEmptyProject(path.join(root, "project"));
  const directory = projectSessionsDir(project.path);
  const startedAt = "2026-01-01T00:00:00.000Z";
  const sessionId = "session-000";
  for (let i = 0; i < 128; i++) {
    const id = `session-${String(i).padStart(3, "0")}`;
    await createSessionFile(project.path, id, Buffer.from(JSON.stringify({ type: "user_message", content: `Fixture ${id}`,
      messageId: `message-${i}`, slotId: `slot-${i}`, time: startedAt }) + "\n"));
  }
  const record = await writeSessionCatalogRecord(project.path, { version: 1, sessionId, rootSessionId: sessionId,
    createdAt: startedAt, updatedAt: startedAt });

  const opened: string[] = [];
  const dirReads: string[] = [];
  const open = fs.open;
  const readFile = fs.readFile;
  const readdir = fs.readdir;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".jsonl")) opened.push(path.basename(String(args[0])));
    return await open(...args);
  });
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith(".jsonl")) opened.push(path.basename(String(args[0])));
    return await readFile(...args);
  });
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === directory) dirReads.push(directory);
    return await readdir(...args);
  });
  syncBuiltinESMExports();

  const references = new LocalReferenceService({ projects: [project] });
  assert.match((await references.referenceForMessage(sessionId, "message-0", project.id)).uri, /message\/slot-0$/u);
  assert.deepEqual(opened.splice(0), ["session-000.jsonl"]);
  const scoped = await references.search("Fixture", project.id, "message", 30, "Asia/Shanghai", { sessionId });
  assert.deepEqual(scoped.map(item => item.messageId), ["message-0"]);
  assert.deepEqual(opened.splice(0), ["session-000.jsonl"]);
  assert.deepEqual(await references.search("Fixture", project.id, "message", 30, "Asia/Shanghai", {}), []);
  assert.deepEqual(opened.splice(0), []);

  const first = await agents.listSessionTreePage(project.id, { limit: 32 });
  assert.equal(first.sessions.length, 32);
  assert.equal(opened.splice(0).length, 128, "existing histories populate the summary projection once");
  const next = await agents.listSessionTreePage(project.id, { limit: 32, cursor: first.nextCursor });
  assert.equal(next.sessions.length, 32);
  assert.deepEqual(opened.splice(0), []);
  const script = `
    import { promises as fs } from 'node:fs';
    import { listSessionCatalog } from './src/session/catalog.ts';
    const original = fs.open;
    let opens = 0;
    fs.open = async (file, ...args) => {
      if (String(file).endsWith('.jsonl')) opens++;
      return await original(file, ...args);
    };
    const result = await listSessionCatalog(process.argv[1], true);
    console.log(JSON.stringify({ opens, count: result.length }));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script, project.path], { timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout), { opens: 0, count: 128 });
  const changed = path.join(directory, "session-003.jsonl");
  await fs.appendFile(changed, JSON.stringify({ type: "assistant_message", content: "Updated", time: "2026-01-02T00:00:00Z" }) + "\n");
  assert.equal((await agents.listSessionTreePage(project.id, { cursor: first.nextCursor })).revisionChanged, true);
  assert.deepEqual(opened.splice(0), ["session-003.jsonl"]);
  await fs.unlink(changed);
  assert.equal((await agents.listSessionTreePage(project.id)).sessions.some(item => item.id === "session-003"), false);
  assert.deepEqual(opened.splice(0), []);

  dirReads.length = 0;
  await agents.startDraft(project.id, "shared", true);
  await agents.saveChatPersonalization(project.id, sessionId, { useMemories: false, contributeMemories: false }, sessionCatalogRecordRevision(record));
  const result = await agents.runSlashCommand(project.id, sessionId, "/memories use");
  assert.deepEqual(result.chatMetadata?.receipt.metadata.personalization, { useMemories: true, contributeMemories: false });
  let published = false;
  await updateSessionCatalogMetadata(project.path, sessionId, { personalization: { useMemories: true, contributeMemories: true } },
    result.chatMetadata?.receipt.metadata.metadataRevision, { onIndexRefresh() { published = true; } });
  assert.equal(published, false);
  const settings = new DesktopSettingsTransaction(state, agents);
  const before = await settings.snapshot(project.id);
  const saved = await settings.save(project.id, { expectedPreferenceRevision: before.preferenceRevision,
    expectedConfigRevision: before.configRevision, memory: { ...before.memory, enabled: false } });
  assert.equal(saved.status, "committed");
  const personalization = await agents.personalizationOverview(project.id, sessionId);
  assert.equal(personalization.chat?.effective.useMemories, false);
  assert.deepEqual(opened, []);
  assert.deepEqual(dirReads, [], "draft and memory operations must not enumerate project histories");

  const privacy = await agents.maskingOverview(project.id);
  assert.deepEqual(privacy.records, []);
  assert.equal(await agents.maskingDetail(project.id, "missing"), undefined);
  const { registrationPath } = runtimeHostPaths(project.path);
  await assert.rejects(fs.access(registrationPath), { code: "ENOENT" });
  assert.deepEqual(runtimeStarts, []);
  console.log("128-session fixture: point/look-up 1/1 JSONL; first/next/reopen 128/0/0; append 1; delete 0; memory/draft 0 directory reads; no Runtime registration");
});
