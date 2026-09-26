import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { AGENT_DATABASE_FILE } from "../src/config/paths.js";
import { createStoredMemoryEntry } from "../src/agent/context/memoryFormat.js";
import type { AgentModel } from "../src/agent/core/types.js";
import type { MemoryEntryInput, MemoryMaintenanceStatus, MemorySleepRun } from "../src/agent/context/memoryTypes.js";

const unusedModel: AgentModel = {
  provider: "test",
  modelId: "unused",
  stream: async () => (async function* () {
    yield { type: "finish" as const, reason: "stop" as const };
  })()
};

const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-lifecycle-agent-"));
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-lifecycle-workspace-"));
const previous = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = agentRoot;

try {
  await testEntryFieldsAndAccessCount();
  await testCompatibleAgentDatabaseSchemaIsMigrated();
  await testUnknownAgentDatabaseSchemaIsRejected();
  await testSleepRunPersistenceAndRecovery();
} finally {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
  await rm(agentRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("memory lifecycle tests passed");

async function testEntryFieldsAndAccessCount(): Promise<void> {
  const storage = new MemoryStorage(workspaceRoot);
  // 扁平 sanitize 规则：trim、去空、去重、单条 ≤120 字符、最多保留 12 条。
  const sanitizedTags = [
    "release",
    "verification",
    "保留空白",
    ...Array.from({ length: 9 }, (_, index) => `${index}:${"标签".repeat(100)}`.slice(0, 120))
  ];
  const rationale = "  原始理由\n".repeat(300);
  const input: MemoryEntryInput = {
    content: "The release process requires a deterministic verification step before publishing.",
    source: "auto",
    tags: ["release", "verification", "release", "", "  保留空白  ", ...Array.from({ length: 40 }, (_, index) => `${index}:${"标签".repeat(100)}`)],
    rationale,
    activitySource: "activity_session",
    activitySessionId: "activity-session-001",
    threadId: "thread-0001",
    messageId: "message-0001",
    userId: "user-0001",
    importance: 0.125
  };
  const first = await storage.writeEntry(input);
  assert.equal(first.written, true);
  assert.ok(first.entry);
  const fields = { id: "validation-entry", revision: 0, createdAt: "2026-09-05T12:00:00.000Z", updatedAt: "2026-09-05T12:00:00.000Z" };
  for (const accessCount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createStoredMemoryEntry({ ...input, accessCount }, fields), /non-negative safe integer/);
  }
  const sanitized = createStoredMemoryEntry({ ...input, accessCount: 7, content: "  retained fact  ", tags: ["release", "release"] }, fields);
  assert.equal(sanitized.content, "retained fact");
  assert.deepEqual(sanitized.tags, ["release"]);
  const verbatimSource = "  source/".repeat(20);
  assert.equal(createStoredMemoryEntry({ ...input, source: verbatimSource }, fields).source, verbatimSource);
  assert.equal(createStoredMemoryEntry({ ...input, source: "", rationale: "" }, fields).source, "");
  assert.equal(createStoredMemoryEntry({ ...input, rationale: "" }, fields).rationale, "");
  assert.equal(sanitized.accessCount, 7);
  for (const importance of [0, 0.125, 0.7, 1, 4]) {
    assert.equal(createStoredMemoryEntry({ ...input, importance }, fields).importance, importance);
  }
  assert.equal(createStoredMemoryEntry({ ...input, importance: undefined }, fields).importance, 0.5);
  const duplicate = await storage.writeEntry(input);
  assert.equal(duplicate.written, true);
  assert.notEqual(duplicate.entry?.id, first.entry.id);
  await storage.recordRecallUsage([first.entry!.id], { now: new Date("2026-09-05T12:00:00.000Z") });
  const entry = (await storage.listEntries()).entries.find((candidate) => candidate.id === first.entry!.id);
  assert.equal(entry?.source, "auto");
  assert.equal(entry?.activitySource, "activity_session");
  assert.equal(entry?.activitySessionId, "activity-session-001");
  assert.equal(entry?.importance, 0.125);
  assert.deepEqual(entry?.tags, sanitizedTags);
  assert.equal(entry?.rationale, rationale);
  assert.equal(entry?.threadId, "thread-0001");
  assert.equal(entry?.accessCount, 1);
  assert.equal(entry?.lastAccessedAt, "2026-09-05T12:00:00.000Z");
  const edited = await storage.updateEntry(entry!.id, { content: "The release convention entry was updated by the lifecycle test." });
  assert.equal(edited.entry?.activitySessionId, "activity-session-001");
  const archived = await storage.archiveEntry(entry!.id, true);
  assert.equal(archived.entry?.activitySource, "activity_session");
  assert.equal(archived.entry?.activitySessionId, "activity-session-001");
  const restored = await storage.archiveEntry(archived.entry!.id, false);
  assert.equal(restored.entry?.activitySessionId, "activity-session-001");
  assert.deepEqual(restored.entry?.tags, sanitizedTags);
  assert.equal(restored.entry?.rationale, rationale);
  storage.close();

  const database = new DatabaseSync(path.join(agentRoot, AGENT_DATABASE_FILE), { readOnly: true });
  try {
    const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(restored.entry!.id) as { metadata: string };
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.equal(metadata.activitySource, "activity_session");
    assert.equal(metadata.activitySessionId, "activity-session-001");
    assert.equal(metadata.source, "auto");
    assert.deepEqual(metadata.tags, sanitizedTags);
    assert.equal(metadata.rationale, rationale);
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: string }>).map((row) => row.name));
    assert.equal(tables.has("memories"), true);
    assert.equal(tables.has("memory_archive"), true);
    assert.equal(tables.has("memory_sleep_runs"), true);
    assert.equal(tables.has("crystal_terms"), true);
    assert.equal(tables.has("crystals"), true);
    assert.equal(tables.has("crystal_materials"), true);
    assert.equal(tables.has("crystal_bundles"), true);
    assert.equal(tables.has("crystal_processed_anchors"), true);
  } finally {
    database.close();
  }
}

/** 仅对结构完全可辨认的扁平事实库补版本/列，保留共库 Activity 与归档原文。 */
async function testCompatibleAgentDatabaseSchemaIsMigrated(): Promise<void> {
  for (const version of [5, 0]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `biny-agent-compatible-v${String(version)}-`));
    const agentDir = path.join(root, "agent");
    const databasePath = path.join(agentDir, AGENT_DATABASE_FILE);
    try {
      const original = new MemoryStorage(workspaceRoot, { agentDir });
      const active = await original.writeEntry({ content: `v${String(version)} active fact`, threadId: "thread-A" });
      const archived = await original.writeEntry({ content: `v${String(version)} archived fact`, threadId: "thread-A" });
      assert.ok(active.entry && archived.entry);
      await original.archiveEntry(archived.entry.id, true);
      original.close();
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("CREATE TABLE activity_sessions (id TEXT PRIMARY KEY, summary TEXT NOT NULL);");
        database.prepare("INSERT INTO activity_sessions VALUES (?, ?)").run("kept-session", "private activity record");
        if (version === 5) database.exec("ALTER TABLE memory_sleep_runs DROP COLUMN synthesis_failed;");
        database.exec(`PRAGMA user_version = ${String(version)};`);
      } finally { database.close(); }
      const reopened = new MemoryStorage(workspaceRoot, { agentDir });
      try {
        assert.deepEqual((await reopened.listEntries()).entries.map((entry) => entry.id), [active.entry.id]);
        assert.equal((await reopened.listArchivedEntries()).entries.some((entry) => entry.originalId === archived.entry!.id), true);
      } finally { reopened.close(); }
      const verified = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal((verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
        assert.equal((verified.prepare("SELECT summary FROM activity_sessions WHERE id = ?").get("kept-session") as { summary: string }).summary,
          "private activity record");
        assert.equal((verified.prepare("PRAGMA table_info(memory_sleep_runs)").all() as Array<{ name: string }>).some((column) => column.name === "synthesis_failed"), true);
      } finally { verified.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

/** 未知结构或带 workspace 范围的旧事实不能被扁平化为全局可见，也不能建议删共库。 */
async function testUnknownAgentDatabaseSchemaIsRejected(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-agent-old-schema-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const databasePath = path.join(agentDir, AGENT_DATABASE_FILE);
  try {
    for (const version of [2, 4, 5]) {
      await rm(databasePath, { force: true });
      const database = new DatabaseSync(databasePath);
      database.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT, origin_kind TEXT, workspace_id TEXT);
        CREATE TABLE activity_sessions (id TEXT PRIMARY KEY, summary TEXT NOT NULL);
        PRAGMA user_version = ${String(version)};`);
      database.prepare("INSERT INTO memories VALUES (?, ?, ?, ?)").run("scoped-fact", "Private workspace fact", "workspace", "workspace-A");
      database.prepare("INSERT INTO activity_sessions VALUES (?, ?)").run("kept-session", "private activity record");
      database.close();
      const storage = new MemoryStorage(workspaceRoot, { agentDir });
      try {
        await assert.rejects(storage.listEntries(), /Preserve agent\.sqlite.*explicit migration/u);
      } finally {
        storage.close();
      }
      const verified = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal((verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, version);
        assert.deepEqual((verified.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((column) => column.name),
          ["id", "content", "origin_kind", "workspace_id"]);
        assert.equal((verified.prepare("SELECT workspace_id FROM memories WHERE id = ?").get("scoped-fact") as { workspace_id: string }).workspace_id,
          "workspace-A", "unsupported scoped facts must not become globally visible");
        assert.equal((verified.prepare("SELECT summary FROM activity_sessions WHERE id = ?").get("kept-session") as { summary: string }).summary,
          "private activity record");
      } finally { verified.close(); }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSleepRunPersistenceAndRecovery(): Promise<void> {
  const storage = new MemoryStorage(workspaceRoot);
  const run: MemorySleepRun = {
    id: "sleep-running",
    status: "running",
    trigger: "scheduled",
    examined: 2,
    written: 0,
    failed: 0,
    archived: 0,
    exact: 0,
    expired: 0,
    similarity: 0,
    llm: 0,
    archivedExact: 0,
    archivedExpired: 0,
    archivedOrphan: 0,
    archivedSimilarity: 0,
    archivedLlm: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: "2026-09-05T11:00:00.000Z"
  };
  const status: MemoryMaintenanceStatus = {
    state: "running",
    startedAt: run.startedAt,
    lastScanAt: run.startedAt,
    eligible: 2,
    processed: 0,
    written: 0,
    failed: 0,
    lastRun: run,
    sleepRuns: [run]
  };
  const historicalRuns = Array.from({ length: 25 }, (_, index): MemorySleepRun => ({
    ...run,
    id: `sleep-history-${index}`,
    status: index === 1 ? "running" : "completed",
    startedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 7, index + 1, 1)).toISOString()
  }));
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: historicalRuns });
  assert.equal((await storage.readMaintenanceStatus()).sleepRuns?.length, 25);
  const beforeImport = await storage.readMaintenanceStatus();
  assert.equal(await storage.importSleepRun(run), true);
  const afterImport = await storage.readMaintenanceStatus();
  assert.deepEqual({ ...afterImport, sleepRuns: beforeImport.sleepRuns }, beforeImport);
  assert.equal(await storage.importSleepRun(run), false);
  assert.deepEqual(await storage.readMaintenanceStatus(), afterImport);
  await storage.writeMaintenanceStatus(status);
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: [] });
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: undefined });
  assert.equal((await storage.readMaintenanceStatus()).sleepRuns?.length, 26);
  await storage.writeMaintenanceStatus({ ...status, sleepRuns: [{ ...historicalRuns[0]!, inputTokens: 123 }] });
  const updatedHistory = (await storage.readMaintenanceStatus()).sleepRuns!;
  assert.equal(updatedHistory.length, 26);
  assert.equal(updatedHistory.find((item) => item.id === historicalRuns[0]!.id)?.inputTokens, 123);
  storage.close();

  const reopened = new LocalMemory(workspaceRoot, unusedModel);
  const recovered = await reopened.loadMaintenanceStatus();
  assert.equal(recovered.state, "idle");
  assert.equal(recovered.lastRun?.status, "failed");
  assert.equal(recovered.lastRun?.error, "interrupted");
  reopened.close();
  const persisted = new MemoryStorage(workspaceRoot);
  try {
    const history = (await persisted.readMaintenanceStatus()).sleepRuns!;
    assert.equal(history.length, 26);
    assert.equal(history.find((item) => item.id === run.id)?.status, "failed");
    assert.equal(history.find((item) => item.id === historicalRuns[1]!.id)?.status, "failed");
    assert.equal(history.find((item) => item.id === historicalRuns[0]!.id)?.inputTokens, 123);
    const completedRun: MemorySleepRun = { ...run, status: "completed", finishedAt: "2026-09-05T12:00:00.000Z" };
    await persisted.writeMaintenanceStatus({
      ...status,
      state: "idle",
      lastRun: completedRun,
      sleepRuns: [completedRun, { ...historicalRuns[1]!, status: "running" }]
    });
  } finally {
    persisted.close();
  }
  const recovery = new LocalMemory(workspaceRoot, unusedModel);
  try {
    const healed = await recovery.loadMaintenanceStatus();
    assert.equal(healed.sleepRuns?.find((item) => item.id === historicalRuns[1]!.id)?.status, "failed");
    assert.equal(healed.lastRun?.status, "completed");
    assert.equal(healed.lastRun?.finishedAt, "2026-09-05T12:00:00.000Z");
    assert.equal(healed.lastRun?.error, undefined);
    const again = await recovery.loadMaintenanceStatus();
    assert.deepEqual(again, healed);
  } finally {
    recovery.close();
  }
}
