import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage, memoryDatabaseFileName } from "../src/agent/context/memoryStorage.js";
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
  await testOldMemoryDatabaseIsRejected();
  await testV5DatabaseGainsSynthesisFailedColumn();
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
  assert.equal(duplicate.written, false);
  await storage.recordRecallUsage([first.entry!.id], { now: new Date("2026-09-05T12:00:00.000Z") });
  const entry = (await storage.listEntries()).entries[0];
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

  const database = new DatabaseSync(path.join(agentRoot, "memory", memoryDatabaseFileName), { readOnly: true });
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

/** 未知旧版本库必须拒绝打开；v4 结构化旧库直接清空记忆事实表并重建为当前版本，crystal 表保留。 */
async function testOldMemoryDatabaseIsRejected(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-current-schema-"));
  const agentDir = path.join(root, "agent");
  const memoryDir = path.join(agentDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  const databasePath = path.join(memoryDir, memoryDatabaseFileName);
  const legacyV2 = new DatabaseSync(databasePath);
  legacyV2.exec("CREATE TABLE memories (id TEXT PRIMARY KEY); PRAGMA user_version = 2;");
  legacyV2.close();
  try {
    const oldStorage = new MemoryStorage(workspaceRoot, { agentDir });
    await assert.rejects(oldStorage.listEntries(), /schema is not current/u);
    oldStorage.close();

    await rm(databasePath, { force: true });
    const legacyV4 = new DatabaseSync(databasePath, { allowExtension: true });
    // crystal 表与记忆 schema 无关，v4 库里本来就是完整结构；这里保留索引需要的列。
    // memory_embeddings 按真实 v4 库的样子建一张 vec0 虚表：迁移必须加载 sqlite-vec
    // 才能删掉它，否则任何进程打开旧库都会卡在 "no such module: vec0"。
    const { load: loadSqliteVec } = await import("sqlite-vec");
    loadSqliteVec(legacyV4);
    legacyV4.exec(
      "CREATE TABLE memories (id TEXT PRIMARY KEY); " +
      "CREATE TABLE crystals (id TEXT PRIMARY KEY NOT NULL, stage TEXT NOT NULL DEFAULT 'candidate', dormant INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL); " +
      "CREATE VIRTUAL TABLE memory_embeddings USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[384]); " +
      "PRAGMA user_version = 4;"
    );
    legacyV4.close();
    const migrated = new MemoryStorage(workspaceRoot, { agentDir });
    try {
      assert.equal((await migrated.listEntries()).entries.length, 0);
      const written = await migrated.writeEntry({
        content: "A fresh current memory database can be rebuilt after removing the old one."
      });
      assert.equal(written.written, true);
      const reopened = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const version = (reopened.prepare("PRAGMA user_version").get() as { user_version?: unknown }).user_version;
        assert.equal(version, 6);
        const tables = new Set((reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: string }>).map((row) => row.name));
        assert.equal(tables.has("memories"), true);
        assert.equal(tables.has("crystals"), true, "v4 旧库重建时 crystal 表必须保留");
      } finally {
        reopened.close();
      }
    } finally {
      migrated.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** v5 → v6 纯加列迁移：sleep run 历史保留，synthesisFailed 缺省为 0。 */
async function testV5DatabaseGainsSynthesisFailedColumn(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-v5-migrate-"));
  const agentDir = path.join(root, "agent");
  const memoryDir = path.join(agentDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  const databasePath = path.join(memoryDir, memoryDatabaseFileName);
  try {
    const current = new MemoryStorage(workspaceRoot, { agentDir });
    await current.writeMaintenanceStatus({
      state: "idle",
      eligible: 1,
      processed: 1,
      written: 0,
      failed: 0,
      lastRun: {
        id: "v5-run",
        status: "completed",
        trigger: "scheduled",
        examined: 1,
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
        startedAt: "2026-09-10T19:00:00.000Z",
        finishedAt: "2026-09-10T19:01:00.000Z"
      },
      sleepRuns: []
    });
    current.close();

    // 把库降回 v5：去掉 synthesis_failed 列，模拟旧版本数据。
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE memory_sleep_runs DROP COLUMN synthesis_failed; PRAGMA user_version = 5;");
    const versionRow = legacy.prepare("PRAGMA user_version").get() as { user_version?: unknown };
    assert.equal(versionRow.user_version, 5);
    legacy.close();

    const migrated = new MemoryStorage(workspaceRoot, { agentDir });
    try {
      const status = await migrated.readMaintenanceStatus();
      assert.equal(status.lastRun?.id, "v5-run");
      assert.equal(status.lastRun?.synthesisFailed, 0, "旧运行记录的合成失败计数缺省为 0");
      const reopened = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const version = (reopened.prepare("PRAGMA user_version").get() as { user_version?: unknown }).user_version;
        assert.equal(version, 6);
      } finally {
        reopened.close();
      }
    } finally {
      migrated.close();
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
