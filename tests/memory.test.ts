import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import type { AgentModel } from "../src/agent/core/types.js";
import {
  LocalMemory,
  formatMemoryMatches,
  type MemoryEntry,
  type MemoryEntryInput
} from "../src/agent/context/LocalMemory.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { AGENT_DATABASE_FILE } from "../src/config/paths.js";
import { sleepMergePrompt } from "../src/agent/context/sleepMergePrompt.js";
import { memoryExtractionPrompt, memoryTimeAnchorInstruction, temporaryMemoryCleanupPrompt, parseMemoryOperations } from "../src/agent/context/memoryExtraction.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRef, EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import { selectMemoryEmbeddingModel } from "../src/llm/embedding/selectMemoryModel.js";

async function main(): Promise<void> {
  testMemoryExtractionProtocol();
  await testSingleStoreAndEdit();
  await testClearThreadOnlyDeletesActiveFacts();
  await testArchivedEntriesUseBoundedPages();
  await testArchiveListUsesMostRecentArchiveFirst();
  await testSharedLibraryAcrossWorkspaces();
  await testConcurrentWritesAndUsageProjection();
  await testRecallUsageAtomicityAndConcurrency();
  await testExactDuplicateNormalization();
  await testExactDuplicateRespectsUserId();
  await testExplicitDuplicateWritesRemainDistinct();
  await testAutomaticNonDuplicateKeepsDistinctSourceTimes();
  await testAutomaticSemanticDedup();
  await testAutomaticSemanticSearchRecordsScopedCandidateAccess();
  await testAutomaticSemanticDedupRespectsUserId();
  await testAutomaticDedupFailureContract();
  await testSemanticDeleteAndTemporaryCleanup();
  await testExtractionDeletesOnlyOwnUserId();
  await testSemanticDeleteRejectsMovedUserId();
  await testSemanticDeleteResponseProtocol();
  await testTemporaryCleanupRequiresExactCandidateIds();
  await testTemporaryCleanupFailureKeepsMemories();
  await testPersonMemoryRouting();
  await testSummarizationUsesToolModelAndRequiresCompleteTurn();
  await testExtractionPreservesOriginalMessageTime();
  await testRecallFormatsSourceTimeWithoutConflatingSaveTime();
  await testExtractionUsesOnlyConversationText();
  await testAutomaticSummarySkipsWithoutSemanticEmbedding();
  await testDirectExtractionWritesFlatEntries();
  await testSingleRootSafetyBoundary();
  await testListEntriesPagination();
  await testArchiveAndRestore();
  await testTemporaryMemoryExpiry();
  await testSleepSingleNamespaceExactAndExpired();
  await testSleepCoversSharedLibraryFromAnyWorkspace();
  await testSleepSimilarityScansEachUserNamespace();
  await testSleepNamespaceProgressIsBounded();
  await testSleepNamespaceScanFailureStopsLaterNamespaces();
  await testSleepSimilarityDoesNotMergeDifferentUsers();
  await testSleepSimilarityBoundaries();
  await testSleepExactDuplicatesRespectSourceTime();
  await testSleepAnchoredSimilarityRequiresModelDecision();
  await testSleepStrongPairDoesNotArchiveWeakClusterMember();
  await testSleepDoesNotArchiveEditedSourceFromOldScan();
  await testSleepDoesNotArchiveIntoDeletedSurvivor();
  await testSecondInstanceDoesNotInterruptActiveSleep();
  await testSecondInstanceStartsFromLatestCompletedHistory();
  await testStaleSleepOwnerCannotCommitAfterTakeover();
  await testSleepSynthesisArchivesCluster();
  await testSleepIgnoresUnrequestedSynthesisExpiry();
  await testSleepSynthesisFailureKeepsSources();
  await testSleepInvalidDeleteIsSafe();
  await testSleepRunRecord();
  await testSleepProgressPersistsAcrossInstances();
  await testSleepPreviewDoesNotMutate();
  await testSleepBatchOrdering();
  await testSleepWeightedSurvivor();
  await testEmbeddingStatusDoesNotCreateIndex();
  await testEmbeddingStatusReadsSelfReflectionMemory();
  await testSemanticSearchTreatsUnbuiltIndexAsEmptyCandidates();
  await testFactsAndVectorsShareDatabase();
  await testInitialEmbeddingGeneration();
  await testSleepUsesCurrentStoredVectorsWhenRuntimeUnavailable();
  await testMemoryVectorProjectionLifecycle();
  await testLocalMemoryMutationKeepsIndexInSync();
  console.log("memory tests passed");
}

async function testArchivedEntriesUseBoundedPages(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot);
    try {
      for (let index = 0; index < 26; index += 1) {
        const written = await memory.writeEntry({ content: `Archived page item ${index + 1}`, source: "manual" });
        assert.ok(written.entry);
        await memory.archiveEntry(written.entry.id, true);
      }
      const first = await memory.listArchivedEntries({ offset: 0, limit: 25 });
      const second = await memory.listArchivedEntries({ offset: 25, limit: 25 });
      assert.equal(first.total, 26);
      assert.equal(first.entries.length, 25);
      assert.equal(second.total, 26);
      assert.equal(second.entries.length, 1);
      assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 26);
      assert.equal((await memory.listArchivedEntries()).entries.length, 26, "CLI 全量路径保持可用");
    } finally {
      memory.close();
    }
  });
}

async function testArchiveListUsesMostRecentArchiveFirst(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot);
    try {
      const old = (await memory.writeEntry({ content: "Older high-priority archive", importance: 1 })).entry!;
      const recent = (await memory.writeEntry({ content: "Recent low-priority archive", importance: 0.1 })).entry!;
      const oldArchive = (await memory.archiveEntry(old.id, true, { now: new Date("2026-08-01T00:00:00.000Z") })).entry!;
      const recentArchive = (await memory.archiveEntry(recent.id, true, { now: new Date("2026-08-02T00:00:00.000Z") })).entry!;
      assert.deepEqual((await memory.listArchivedEntries()).entries.map((entry) => entry.id),
        [recentArchive.id, oldArchive.id], "归档列表以归档时间而非重要度排序");
    } finally { memory.close(); }
  });
}

function testMemoryExtractionProtocol(): void {
  assert.deepEqual(parseMemoryOperations('["NO_MEMORY"]'), []);
  assert.deepEqual(parseMemoryOperations("NO_MEMORY"), []);
  assert.deepEqual(parseMemoryOperations("[]"), []);
  assert.deepEqual(parseMemoryOperations('[{"content":"unfinished"'), []);
  assert.deepEqual(parseMemoryOperations("A reusable fact"), [{ content: "A reusable fact", operation: "add", durability: "permanent" }]);
  assert.deepEqual(parseMemoryOperations("Result: [{content:'forget this',operation:'delete'}, 'keep this'] done"), [
    { content: "forget this", operation: "delete", durability: "permanent" },
    { content: "keep this", operation: "add", durability: "permanent" }
  ]);
  assert.deepEqual(parseMemoryOperations('[null,7,"NO_MEMORY",{"content":"NO_MEMORY"},{"content":"valid","operation":"other","durability":"other"}]'), [
    { content: "valid", operation: "add", durability: "permanent" }
  ]);
  assert.equal(parseMemoryOperations(JSON.stringify(Array.from({ length: 20 }, (_, index) => `fact ${index}`))).length, 20);
}

/** 分页：offset/limit 切片 + total 为分页前计数，页间不重复不遗漏。 */
async function testListEntriesPagination(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);

    for (let index = 0; index < 7; index += 1) {
      await storage.writeEntry(projectEntry(
        `分页测试内容 ${String(index)}，用于验证 offset 与 limit 切片正确且 total 准确。`
      ));
    }
    const page0 = await storage.listEntries({ offset: 0, limit: 3 });
    assert.equal(page0.entries.length, 3);
    assert.equal(page0.total, 7);
    const page1 = await storage.listEntries({ offset: 3, limit: 3 });
    assert.equal(page1.entries.length, 3);
    assert.equal(page1.total, 7);
    const page2 = await storage.listEntries({ offset: 6, limit: 3 });
    assert.equal(page2.entries.length, 1);
    assert.equal(page2.total, 7);
    // 三页并集 = 全集，无重复。
    const ids = new Set([...page0.entries, ...page1.entries, ...page2.entries].map((entry) => entry.id));
    assert.equal(ids.size, 7, "分页必须覆盖全部条目且无重复");
    // offset 超出范围返回空页但 total 仍准确。
    const beyond = await storage.listEntries({ offset: 100, limit: 3 });
    assert.equal(beyond.entries.length, 0);
    assert.equal(beyond.total, 7);
  });
}

/** 扁平单库写入：写事务推进共享 revision，patch 更新保留 createdAt；audience/paths 写入门禁已删除。 */
async function testSingleStoreAndEdit(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const overview = await memory.getOverview();
    assert.equal(overview.storeRevision, 0);
    assert.equal(overview.entryCount, 0);

    const manual = await memory.writeEntry({
      content: "The user explicitly prefers concise progress updates during long coding tasks.",
      source: "manual",
      importance: 5,
      rationale: "Please keep progress updates concise."
    }, { now: new Date("2026-08-01T00:00:00.000Z") });
    assert.equal(manual.entry?.source, "manual");
    assert.equal(manual.revision, 1);

    const project = await memory.writeEntry(projectEntry(
      "Use src/weather.ts for deterministic weather requests."
    ), { now: new Date("2026-08-01T01:00:00.000Z") });
    assert.equal(project.revision, 2, "所有写入共享同一个 revision");

    // 删除 audience/paths 门禁后，同一事实库可以直接容纳任何来源的记忆。
    const previouslyForbidden = await memory.writeEntry({
      content: "Use src/weather.ts as this repository's weather entry point.",
      importance: 4
    });
    assert.equal(previouslyForbidden.written, true);
    assert.equal(previouslyForbidden.revision, 3);

    const created = project.entry;
    assert.ok(created);
    const updated = await memory.updateEntry(created.id, {
      content: "Use src/weather.ts as the deterministic weather request entry point.",
      importance: 4
    }, { now: new Date("2026-08-02T00:00:00.000Z") });
    assert.equal(updated.entry?.id, created.id);
    assert.equal(updated.entry?.createdAt, created.createdAt);
    assert.equal(updated.entry?.content, "Use src/weather.ts as the deterministic weather request entry point.");
    assert.equal(updated.revision, 4);

    const database = new DatabaseSync(path.join(agentRoot, AGENT_DATABASE_FILE), { readOnly: true });
    try {
      const rows = database.prepare("SELECT content, metadata FROM memories").all() as Array<{ content: string; metadata: string }>;
      assert.equal(rows.length, 3);
      assert.equal(rows.some((row) => row.content.includes("concise progress updates")), true);
      // 元数据只保留扁平字段；origin/kind 结构不再持久化。
      assert.equal(rows.every((row) => row.metadata.includes("kind") === false), true);
      assert.equal(rows.every((row) => row.metadata.includes(path.resolve(workspaceRoot)) === false), true, "元数据不能持久化绝对工作区路径");
    } finally {
      database.close();
    }
    memory.close();
  });
}

/** 共享 agent 目录：记忆是单一全局库，任何工作区写入的记忆对其他工作区直接可见、可召回。 */
async function testClearThreadOnlyDeletesActiveFacts(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const removed: string[][] = [];
    const memory = new LocalMemory(
      workspaceRoot, unusedModel, undefined, 3, undefined, undefined,
      { indexEntry: async () => undefined, removeEntries: (ids) => { removed.push([...ids]); } }
    );
    try {
      const a1 = await memory.writeEntry({ content: "First active fact for thread A.", threadId: "thread_A" });
      const a2 = await memory.writeEntry({ content: "Second active fact for thread A.", threadId: "thread_A" });
      const b1 = await memory.writeEntry({ content: "Active fact for thread B.", threadId: "thread_B" });
      const archivedSource = await memory.writeEntry({ content: "Archived fact for thread A.", threadId: "thread_A" });
      assert.ok(a1.entry && a2.entry && b1.entry && archivedSource.entry);
      const archived = await memory.archiveEntry(archivedSource.entry.id, true);
      assert.ok(archived.entry);
      removed.length = 0;
      const beforeRevision = (await memory.getOverview()).storeRevision;
      const cleared = await memory.clearThreadEntries("thread_A");
      assert.equal(cleared.deletedEntries, 2);
      assert.equal(cleared.revision, beforeRevision + 1);
      assert.deepEqual(new Set(removed.flat()), new Set([a1.entry.id, a2.entry.id]));
      assert.deepEqual((await memory.listMemoryEntries()).entries.map((entry) => entry.id), [b1.entry.id]);
      assert.deepEqual((await memory.listArchivedEntries()).entries.map((entry) => entry.id), [archived.entry.id]);
      const noMatch = await memory.clearThreadEntries("thread_A");
      assert.equal(noMatch.deletedEntries, 0);
      assert.equal(noMatch.revision, cleared.revision);
      await assert.rejects(memory.clearThreadEntries("  "), /threadId/u);
      assert.equal((await memory.listMemoryEntries()).total, 1);
    } finally {
      memory.close();
    }
  });
}

async function testSharedLibraryAcrossWorkspaces(): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-first-"));
    const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-second-"));
    try {
      const first = new LocalMemory(firstWorkspace, unusedModel);
      await first.writeEntry(projectEntry(
        "Run pnpm test before publishing the first workspace release."
      ));

      const second = new LocalMemory(secondWorkspace, unusedModel);
      const overview = await second.getOverview();
      assert.equal(overview.entryCount, 1);
      // 去掉 origin 门禁后不再需要 selector：另一工作区写入的条目直接可见。
      const shared = await second.listMemoryEntries();
      assert.equal(shared.entries.length, 1);
      assert.match(shared.entries[0]?.content ?? "", /first workspace release/u);

      const own = await second.writeEntry(projectEntry(
        "Run typecheck before publishing the second workspace release."
      ));
      assert.equal(own.revision, 2, "两个工作区写入推进同一个 revision");
      assert.equal((await second.listMemoryEntries()).entries.length, 2);
      assert.equal(await fs.realpath(path.join(agentRoot, AGENT_DATABASE_FILE)), path.join(await fs.realpath(agentRoot), AGENT_DATABASE_FILE));
      first.close();
      second.close();
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });
}

async function testConcurrentWritesAndUsageProjection(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot);

    for (let index = 0; index < 18; index += 1) {
      await storage.writeEntry(projectEntry(
        `Durable indexed summary ${String(index)} ${"content ".repeat(20)}`
      ));
    }
    const overview = await storage.getOverview();
    assert.equal(overview.entryCount, 18);

    const concurrent = await Promise.allSettled([
      storage.writeEntry(projectEntry("Concurrent A must persist without overwriting another writer.")),
      storage.writeEntry(projectEntry("Concurrent B must persist without overwriting another writer."))
    ]);
    assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 2);
    assert.equal((await storage.listEntries()).total, 20);

    const entry = (await storage.listEntries()).entries[0];
    assert.ok(entry);
    const beforeRevision = (await storage.getOverview()).storeRevision;
    await storage.recordRecallUsage([entry.id, entry.id], { now: new Date("2026-08-03T00:00:00.000Z") });
    const recalled = (await storage.listEntries()).entries.find(({ id }) => id === entry.id);
    assert.equal(recalled?.accessCount, 1, "one citation call counts an id once");
    assert.equal(recalled?.lastAccessedAt, "2026-08-03T00:00:00.000Z");
    assert.equal((await storage.getOverview()).storeRevision, beforeRevision, "derived usage must not advance content revision");
    const database = new DatabaseSync(path.join(agentRoot, AGENT_DATABASE_FILE), { readOnly: true });
    try {
      const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(entry.id) as { metadata?: string } | undefined;
      assert.equal(row?.metadata?.includes("accessCount"), true, "usage metadata follows the canonical field name");
      assert.equal(row?.metadata?.includes("recallCount"), false, "the legacy usage alias is absent");
    } finally {
      database.close();
    }

    await storage.deleteEntry(entry.id);
    const pruned = (await storage.listEntries()).entries.filter(({ id }) => id === entry.id);
    assert.equal(pruned.length, 0, "deleted entry must be removed");
  });
}

async function testRecallUsageAtomicityAndConcurrency(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const first = (await storage.writeEntry(projectEntry("First access statistics transaction fact."))).entry!;
    const second = (await storage.writeEntry(projectEntry("Second access statistics transaction fact."))).entry!;
    const initialRevision = (await storage.getOverview()).storeRevision;
    const database = new DatabaseSync(path.join(agentRoot, AGENT_DATABASE_FILE));
    try {
      database.exec(
        `CREATE TRIGGER reject_second_access BEFORE UPDATE OF access_count ON memories
         WHEN NEW.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'blocked access update'); END`
      );
      await assert.rejects(storage.recordRecallUsage([first.id, second.id]), /blocked access update/u);
      database.exec("DROP TRIGGER reject_second_access");
      assert.deepEqual((await storage.listEntries()).entries.map((entry) => entry.accessCount), [0, 0]);

      const cancelled = new AbortController();
      cancelled.abort(new Error("Cancelled before access commit"));
      await assert.rejects(storage.recordRecallUsage([first.id, second.id], { signal: cancelled.signal }));
      assert.deepEqual((await storage.listEntries()).entries.map((entry) => entry.accessCount), [0, 0]);

      await Promise.all([
        storage.recordRecallUsage([first.id, second.id, first.id], { now: new Date("2026-08-03T10:00:00.000Z") }),
        storage.recordRecallUsage([first.id, second.id], { now: new Date("2026-08-03T11:00:00.000Z") })
      ]);
      const entries = (await storage.listEntries()).entries;
      assert.deepEqual(entries.map((entry) => entry.accessCount), [2, 2]);
      assert.equal(entries.find((entry) => entry.id === first.id)?.updatedAt, entries[0]?.lastAccessedAt);
      assert.equal(entries.find((entry) => entry.id === second.id)?.updatedAt, entries[1]?.lastAccessedAt);
      assert.equal(entries[0]?.lastAccessedAt, entries[1]?.lastAccessedAt);
      assert.equal((await storage.getOverview()).storeRevision, initialRevision);
    } finally {
      database.close();
      storage.close();
    }
  });
}

async function testExactDuplicateNormalization(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const first = await storage.writeEntry(projectEntry(
      "Keep the cafe\u0301 rule.\n\nIt must be checked before release."
    ));
    assert.equal(first.written, true);
    const duplicate = await storage.writeEntry(projectEntry(
      "Keep the café rule. It must be checked before release."
    ));
    assert.equal(duplicate.written, true, "显式新增保留原始事实，Sleep 再整理规范化同文");
    assert.notEqual(duplicate.entry?.id, first.entry?.id);
    assert.equal((await storage.getOverview()).entryCount, 2);

    for (const content of [
      "keep the café rule. It must be checked before release.",
      "Keep the café rule! It must be checked before release.",
      "Keep the cafe rule. It must be checked before release.",
      "Keep the ｃａｆé rule. It must be checked before release."
    ]) {
      const distinct = await storage.writeEntry(projectEntry(content));
      assert.equal(distinct.written, true, "case, punctuation, accents and compatibility characters are not exact duplicates");

    }
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    try {
      const preview = await memory.previewMaintenance({ useLlm: false });
      assert.equal(preview.archiveProposed?.filter((entry) => entry.reason === "exact_dup").length, 1);
      await memory.runMemoryMaintenance({ useLlm: false });
      assert.equal((await storage.getOverview()).entryCount, 5);
    } finally {
      memory.close();
      storage.close();
    }
  });
}

async function testExactDuplicateRespectsUserId(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    try {
      const content = "The same preference belongs to separate explicit users.";
      const first = await memory.writeEntry({ content, userId: "user-a" });
      const second = await memory.writeEntry({ content, userId: "user-b" });
      const global = await memory.writeEntry({ content });
      assert.equal(first.written, true);
      assert.equal(second.written, true, "另一个显式 userId 不能复用前一个用户的事实 ID");
      assert.equal(global.written, true, "全局事实也不能复用某个用户的事实 ID");
      assert.equal((await memory.listMemoryEntries()).total, 3);
      const preview = await memory.previewMaintenance({ useLlm: false });
      assert.deepEqual(preview.archiveProposed, [], "Sleep exact 不能跨 userId 归档");
      await memory.runMemoryMaintenance({ useLlm: false });
      assert.equal((await memory.listMemoryEntries()).total, 3);
    } finally {
      memory.close();
    }
  });
}

async function testExplicitDuplicateWritesRemainDistinct(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot);
    try {
      const content = "The release checklist must be reviewed before publishing.";
      const first = await memory.writeEntry({ content, threadId: "thread-one" });
      const second = await memory.writeEntry({ content, threadId: "thread-two" });
      assert.equal(first.written, true);
      assert.equal(second.written, true, "显式新增事实不因正文相同而复用已有条目");
      assert.notEqual(second.entry?.id, first.entry?.id);
      assert.equal((await memory.listMemoryEntries()).total, 2);
    } finally { memory.close(); }
  });
}

async function testAutomaticNonDuplicateKeepsDistinctSourceTimes(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const candidates: MemoryEntry[] = [];
    const model = jsonMemoryModel(() => JSON.stringify({ isDuplicate: false }));
    const memory = new LocalMemory(workspaceRoot, () => model, undefined, 3, undefined, undefined, undefined,
      async () => candidates);
    try {
      const content = "The release is scheduled for Friday.";
      const first = await memory.writeAutoEntry({ content, originAnchors: [
        { messageId: "source-one", sentAt: "2026-08-01T09:00:00.000Z", timeZone: "Asia/Shanghai" }
      ] }, { requireSemantic: true });
      assert.ok(first.entry);
      candidates.push(first.entry);
      const second = await memory.writeAutoEntry({ content, originAnchors: [
        { messageId: "source-two", sentAt: "2026-08-08T09:00:00.000Z", timeZone: "Asia/Shanghai" }
      ] }, { requireSemantic: true });
      assert.equal(second.written, true, "模型确认来源时间不同后，SQLite 不得再次按正文压掉事实");
      assert.notEqual(second.entry?.id, first.entry.id);
      assert.equal((await memory.listMemoryEntries()).total, 2);
    } finally { memory.close(); }
  });
}

async function testAutomaticSemanticDedup(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let response: Record<string, unknown> = { isDuplicate: true, reason: "same core fact", duplicateOf: 1 };
    const model = jsonMemoryModel((prompt) => prompt.startsWith('New memory to add: "')
      ? `Result: ${JSON.stringify(response)}`
      : "{}");
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const first = await seed.writeEntry(projectEntry(
      "The release workflow requires running the complete test suite before publishing the package."
    ));
    assert.ok(first.entry);
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => [first.entry!]
    );
    const result = await memory.writeAutoEntry(projectEntry(
      "Run the complete test suite before publishing the package as part of the release workflow."
    ));
    assert.equal(result.written, false);
    assert.equal(result.entry?.id, first.entry.id);
    assert.equal((await memory.getOverview()).entryCount, 1);
    for (const duplicateOf of [undefined, 0, -1, 1.5, 99, "1", null]) {
      response = { isDuplicate: true, reason: { unexpected: "type" }, duplicateOf };
      const skipped = await memory.writeAutoEntry(projectEntry(
        "A paraphrased release rule repeats the existing verification requirements."
      ));
      assert.equal(skipped.written, false);
      assert.equal(skipped.entry, undefined);
      assert.equal(skipped.path, undefined);
      assert.equal((await memory.getOverview()).entryCount, 1);
    }
    memory.close();
    seed.close();
  });
}

async function testAutomaticSemanticSearchRecordsScopedCandidateAccess(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const own = (await seed.writeEntry({ content: "User A prefers compact release summaries.", userId: "user-a" })).entry!;
    const other = (await seed.writeEntry({ content: "User B prefers compact release summaries.", userId: "user-b" })).entry!;
    const ownSecond = (await seed.writeEntry({ content: "User A checks release notes before publishing.", userId: "user-a" })).entry!;
    const memory = new LocalMemory(
      workspaceRoot,
      () => jsonMemoryModel(() => JSON.stringify({ isDuplicate: false })),
      undefined, 3, undefined, undefined, undefined,
      async () => [own, other, ownSecond]
    );
    try {
      const written = await memory.writeAutoEntry({
        content: "User A also prefers release summaries with a short checklist.", userId: "user-a"
      }, { requireSemantic: true });
      assert.equal(written.written, true);
      const entries = (await memory.listMemoryEntries()).entries;
      assert.equal(entries.find((entry) => entry.id === own.id)?.accessCount, 1);
      assert.equal(entries.find((entry) => entry.id === ownSecond.id)?.accessCount, 1);
      assert.equal(entries.find((entry) => entry.id === other.id)?.accessCount, 0, "scope-excluded hits do not count");
      for (const id of [own.id, ownSecond.id]) {
        const entry = entries.find((candidate) => candidate.id === id)!;
        assert.ok(entry.lastAccessedAt);
        assert.equal(entry.updatedAt, entry.lastAccessedAt);
      }
      const cancelled = new AbortController();
      const cancelledMemory = new LocalMemory(
        workspaceRoot, unusedModel, undefined, 3, undefined, undefined, undefined,
        async () => {
          cancelled.abort(new Error("Cancelled after candidate search"));
          return [own];
        }
      );
      try {
        await assert.rejects(cancelledMemory.writeAutoEntry({
          content: "User A considers a different release checklist item.", userId: "user-a"
        }, { requireSemantic: true, signal: cancelled.signal }), /Cancelled after candidate search/u);
        assert.equal((await memory.listMemoryEntries()).entries.find((entry) => entry.id === own.id)?.accessCount, 1);
      } finally {
        cancelledMemory.close();
      }
    } finally {
      memory.close();
      seed.close();
    }
  });
}

async function testAutomaticSemanticDedupRespectsUserId(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const other = await seed.writeEntry({ content: "User A has a long-term preference for compact release summaries.", userId: "user-a" });
    assert.ok(other.entry);
    const scopes: Array<string | null | undefined> = [];
    const model = jsonMemoryModel(() => JSON.stringify({ isDuplicate: true, duplicateOf: 1 }));
    const memory = new LocalMemory(workspaceRoot, () => model, undefined, 3, undefined, undefined, undefined,
      async (_query, options) => { scopes.push(options.userId); return [other.entry!]; });
    try {
      const forB = await memory.writeAutoEntry({
        content: "User B prefers compact release summaries for long-term work.", userId: "user-b"
      }, { requireSemantic: true });
      const global = await memory.writeAutoEntry({
        content: "The global workflow favors concise release summaries."
      }, { requireSemantic: true });
      assert.equal(forB.written, true, "A 的语义候选不能阻止 B 写入");
      assert.equal(global.written, true, "显式用户的语义候选不能阻止全局事实写入");
      assert.deepEqual(scopes, ["user-b", null], "候选检索必须在 top-K 前收到明确命名空间");
    } finally {
      memory.close();
      seed.close();
    }
  });
}

/** 自动写入的模型故障应允许 exact-safe 新增；取消和必需语义缺失不能写入。 */
async function testAutomaticDedupFailureContract(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const first = await seed.writeEntry(projectEntry(
      "Release verification requires a complete test run before publishing."
    ));
    assert.ok(first.entry);
    const controller = new AbortController();
    let response: "invalid" | "throw" | "abort" = "invalid";
    const model = jsonMemoryModel(() => {
      if (response === "throw") throw new Error("The test model disconnected.");
      if (response === "abort") controller.abort(new Error("The test request was cancelled."));
      return "{invalid-json}";
    });
    const memory = new LocalMemory(
      workspaceRoot, () => model, undefined, 3, undefined, undefined, undefined,
      async () => [first.entry!]
    );
    const unavailable = new LocalMemory(
      workspaceRoot, unusedModel, undefined, 3, undefined, undefined, undefined,
      async () => undefined
    );
    try {
      const malformed = await memory.writeAutoEntry(projectEntry(
        "The release checklist also requires reviewing the package manifest."
      ), { requireSemantic: true });
      assert.equal(malformed.written, true);
      assert.equal((await memory.getOverview()).entryCount, 2);

      response = "throw";
      const disconnected = await memory.writeAutoEntry(projectEntry(
        "The release checklist additionally requires reviewing the license file."
      ), { requireSemantic: true });
      assert.equal(disconnected.written, true);
      assert.equal((await memory.getOverview()).entryCount, 3);

      response = "abort";
      await assert.rejects(memory.writeAutoEntry(projectEntry(
        "A cancelled release note must never be saved as a memory."
      ), { requireSemantic: true, signal: controller.signal }));
      assert.equal((await memory.getOverview()).entryCount, 3);

      const deferred = await unavailable.writeAutoEntry(projectEntry(
        "A missing semantic runtime defers this automatic memory candidate."
      ), { requireSemantic: true });
      assert.equal(deferred.written, false);
      assert.equal(deferred.deferred, true);
      assert.equal((await memory.getOverview()).entryCount, 3);
    } finally {
      unavailable.close();
      memory.close();
      seed.close();
    }
  });
}

async function testSemanticDeleteAndTemporaryCleanup(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const obsolete = await seed.writeEntry(projectEntry(
      "The old release process requires publishing directly without running the complete test suite first."
    ));
    const temporary = await seed.writeEntry({
      ...projectEntry(
        "The temporary branch note is only relevant to the previous release investigation and can expire."
      ),
      durability: "temporary",
      expiresAt: "2026-08-20T00:00:00.000Z"
    });
    assert.ok(obsolete.entry);
    assert.ok(temporary.entry);
    const model = jsonMemoryModel((prompt) => {
      if (prompt.includes("Extract memories from this conversation:")) return JSON.stringify([{ operation: "delete", content: "the old release rule" }]);
      if (prompt.startsWith("The user wants to delete memories about:")) return "[1]";
      if (prompt.startsWith("Current date and time:")) return JSON.stringify([temporary.entry!.id]);
      return "[]";
    });
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async (_query, options) => options.minimumSimilarity === 0
        ? [obsolete.entry!]
        : [temporary.entry!]
    );
    const result = await memory.summarizeAndStoreMemories([
      { role: "user", content: "The old release rule is no longer valid; the temporary note is no longer relevant." },
      { role: "assistant", content: "I will remove the obsolete temporary context." }
    ], {
      sessionId: "semantic-delete-session",
      turnId: "semantic-delete-turn",
      runId: "semantic-delete-run",
      externalContext: false,
      excludeExternalContext: false,
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    assert.deepEqual(result.deleted, [
      { id: obsolete.entry.id, content: obsolete.entry.content },
      { id: temporary.entry.id, content: temporary.entry.content }
    ]);
    assert.deepEqual(result.created, []);
    assert.equal((await memory.getOverview()).entryCount, 0);
    memory.close();
    seed.close();
  });
}

async function testExtractionDeletesOnlyOwnUserId(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seed = new LocalMemory(workspaceRoot, unusedModel);
    const foreignPermanent = await seed.writeEntry({ content: "User A old release rule.", userId: "user-a" });
    const ownPermanent = await seed.writeEntry({ content: "Default user old release rule." });
    const foreignTemporary = await seed.writeEntry({ content: "User A temporary release note.", userId: "user-a", durability: "temporary" });
    const ownTemporary = await seed.writeEntry({ content: "Default user temporary release note.", durability: "temporary" });
    assert.ok(foreignPermanent.entry && ownPermanent.entry && foreignTemporary.entry && ownTemporary.entry);
    const model = jsonMemoryModel((prompt) => {
      if (prompt.includes("Extract memories from this conversation:")) return JSON.stringify([{ operation: "delete", content: "old release rule" }]);
      if (prompt.startsWith("The user wants to delete memories about:")) return "[1]";
      if (prompt.startsWith("Current date and time:")) return JSON.stringify([foreignTemporary.entry!.id, ownTemporary.entry!.id]);
      return "[]";
    });
    const scopes: Array<string | null | undefined> = [];
    const memory = new LocalMemory(workspaceRoot, () => model, undefined, 3, undefined, undefined, undefined,
      async (_query, options) => {
        scopes.push(options.userId);
        return options.minimumSimilarity === 0
          ? [foreignPermanent.entry!, ownPermanent.entry!]
          : [foreignTemporary.entry!, ownTemporary.entry!];
      });
    try {
      await memory.summarizeAndStoreMemories([
        { role: "user", content: "Forget the old release rule; the temporary release note is no longer relevant." },
        { role: "assistant", content: "I will update the remembered release context." }
      ], { sessionId: "scope-delete", turnId: "turn", runId: "run", externalContext: false, excludeExternalContext: false });
      const remaining = (await memory.listMemoryEntries()).entries;
      assert.deepEqual(new Set(remaining.map((entry) => entry.id)), new Set([foreignPermanent.entry.id, foreignTemporary.entry.id]));
      assert.deepEqual(scopes, [null, null], "自动删除候选也须在 top-K 前限定默认 userId");
      await memory.summarizeAndStoreMemories([
        { role: "user", content: "Forget my old release rule and temporary release note." },
        { role: "assistant", content: "I will update your release context." }
      ], { sessionId: "scope-delete-a", turnId: "turn-a", runId: "run-a", userId: "user-a", externalContext: false, excludeExternalContext: false });
      assert.equal((await memory.listMemoryEntries()).total, 0);
      assert.deepEqual(scopes, [null, null, "user-a", "user-a"], "显式 userId 也须贯穿语义删除与临时清理");
    } finally {
      memory.close();
      seed.close();
    }
  });
}

async function testSemanticDeleteRejectsMovedUserId(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    try {
      const source = await storage.writeEntry({ content: "Scoped deletion source fact.", userId: "user-a" });
      assert.ok(source.entry);
      await storage.updateEntry(source.entry.id, { userId: "user-b" });
      await assert.rejects(storage.deleteEntry(source.entry.id, { expectedEntries: [source.entry] }), /stale/u);
      const active = (await storage.listEntries()).entries;
      assert.equal(active.length, 1);
      assert.equal(active[0]?.userId, "user-b");
    } finally {
      storage.close();
    }
  });
}

async function testSemanticDeleteResponseProtocol(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let description = "   ";
    let selection = "[]";
    let searches = 0;
    const prompts: string[] = [];
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => (
      prompt.startsWith("Extract memories from this conversation:")
        ? JSON.stringify([{ operation: "delete", content: description }])
        : selection
    ), prompts), undefined, 3, undefined, undefined, undefined, async (query, options) => {
      if (options.minimumSimilarity === 0.3) return [];
      assert.equal(query, "forget the release rule");
      assert.equal(options.minimumSimilarity, 0);
      assert.equal(options.limit, 10);
      searches += 1;
      return [candidate];
    });
    const written = await memory.writeEntry(projectEntry("The user previously preferred publishing without running the complete test suite."));
    assert.ok(written.entry);
    const candidate = written.entry;
    const runDelete = () => memory.summarizeAndStoreMemories([
      { role: "user", content: "Forget the old release rule." },
      { role: "assistant", content: "I will remove it." }
    ], { sessionId: "delete-session", turnId: "delete-turn", runId: "delete-run", externalContext: false, excludeExternalContext: false });
    assert.deepEqual((await runDelete()).deleted, []);
    assert.equal(searches, 0);
    description = "  forget the release rule  ";
    for (const response of ['["1"]', "[-1]", "[1.0]", "[1,]", "[0,99]", "[] then [1]"]) {
      selection = response;
      assert.deepEqual((await runDelete()).deleted, [], response);
      assert.equal((await memory.getOverview()).entryCount, 1);
    }
    selection = `Selected: ${JSON.stringify(Array.from({ length: 12 }, () => 1))} because the user asked to forget it.`;
    assert.deepEqual((await runDelete()).deleted, [{ id: candidate.id, content: candidate.content }]);
    assert.equal((await memory.getOverview()).entryCount, 0);
    assert.equal(prompts.at(-1), `The user wants to delete memories about: "${description}"\n\nHere are the candidate memories from the database:\n1. [permanent] ${candidate.content}\n\nWhich memories should be deleted? Respond with ONLY a JSON array of the numbers (1-indexed) of memories that should be deleted.\nIf none should be deleted, respond with [].\nExample response: [1, 3, 5] or []\n\nBe precise - only select memories that truly match what the user wants to delete.`);
    memory.close();
  });
}

async function testTemporaryCleanupRequiresExactCandidateIds(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let cleanupResponse = "[1]";
    const prompts: string[] = [];
    const now = new Date("2026-08-21T18:34:56.000Z");
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => (
      prompt.includes("Extract memories from this conversation:") ? '["NO_MEMORY"]' : cleanupResponse
    ), prompts), undefined, 3, undefined, undefined, undefined, async (query, options) => {
      assert.equal(query, "user: The project has finished.\n\nassistant: The deadline is no longer relevant.");
      assert.equal(options.limit, 20);
      assert.equal(options.minimumSimilarity, 0.3);
      return [candidate];
    });
    const written = await memory.writeEntry({
      ...projectEntry("The user is preparing a multi-session project with an upcoming deadline."),
      durability: "temporary"
    });
    assert.ok(written.entry);
    const candidate = written.entry;
    const runCleanup = () => memory.summarizeAndStoreMemories([
      { role: "user", content: "The project has finished." },
      { role: "assistant", content: "The deadline is no longer relevant." }
    ], { sessionId: "cleanup-session", turnId: "cleanup-turn", runId: "cleanup-run", externalContext: false, excludeExternalContext: false, now });
    for (const response of ["[1]", JSON.stringify([` ${candidate.id} `]), '["unknown-id"]', `["${candidate.id}"`, `[] followed by ["${candidate.id}"]`]) {
      cleanupResponse = response;
      assert.deepEqual((await runCleanup()).deleted, [], response);
      assert.equal((await memory.getOverview()).entryCount, 1);
    }
    cleanupResponse = JSON.stringify([null, 1, "unknown-id", candidate.id, candidate.id]);
    assert.deepEqual((await runCleanup()).deleted, [{ id: candidate.id, content: candidate.content }]);
    assert.equal((await memory.getOverview()).entryCount, 0);
    const created = new Date(candidate.createdAt);
    const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toLocaleTimeString()}`;
    assert.equal(prompts.at(-1), `Current date and time: ${localDate(now)}\n\nCurrent conversation context:\nuser: The project has finished.\n\nassistant: The deadline is no longer relevant.\n\nTemporary memories related to this conversation:\n- id: "${candidate.id}", created: "${localDate(created)}", content: "${candidate.content}"`);
    memory.close();
  });
}

async function testTemporaryCleanupFailureKeepsMemories(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let mode: "empty" | "permanent" | "embedding-error" | "model-error" | "abort" = "empty";
    let cleanupCalls = 0;
    const controller = new AbortController();
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => {
      if (prompt.startsWith("Extract memories from this conversation:")) return '["NO_MEMORY"]';
      cleanupCalls += 1;
      if (mode === "abort") controller.abort();
      throw new Error("cleanup model unavailable");
    }), undefined, 3, undefined, undefined, undefined, async () => {
      if (mode === "embedding-error") throw new Error("embedding unavailable");
      if (mode === "empty") return [];
      return mode === "permanent" ? [permanent.entry!] : [temporary.entry!];
    });
    const temporary = await memory.writeEntry({
      ...projectEntry("The user is working on a temporary project with an upcoming deadline."),
      durability: "temporary"
    });
    const permanent = await memory.writeEntry(projectEntry("The user prefers written project updates with specific next steps."));
    const runCleanup = () => memory.summarizeAndStoreMemories([
      { role: "user", content: "The project is finished." },
      { role: "assistant", content: "The deadline has passed." }
    ], { sessionId: "failure-session", turnId: "failure-turn", runId: "failure-run", externalContext: false, excludeExternalContext: false, signal: controller.signal });
    for (const scenario of ["empty", "permanent", "embedding-error", "model-error"] as const) {
      mode = scenario;
      assert.deepEqual(await runCleanup(), { created: [], deleted: [] });
      assert.equal((await memory.getOverview()).entryCount, 2);
    }
    assert.equal(cleanupCalls, 1);
    mode = "abort";
    await assert.rejects(runCleanup(), { name: "AbortError" });
    assert.equal((await memory.getOverview()).entryCount, 2);
    memory.close();
  });
}

async function testPersonMemoryRouting(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const result = await memory.writeAutoEntry(projectEntry(
      "PERSON: Alice: Alice prefers concise written updates and clear next steps."
    ));
    assert.equal(result.written, false);
    assert.equal((await memory.getOverview()).entryCount, 0);
    const profile = await fs.readFile(path.join(agentRoot, "people", "Alice.md"), "utf8");
    assert.match(profile, /prefers concise written updates/u);
    memory.close();
  });
}

async function testSummarizationUsesToolModelAndRequiresCompleteTurn(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let extractionCalls = 0;
    let toolCalls = 0;
    const extractionModel = jsonMemoryModel(() => {
      extractionCalls += 1;
      return JSON.stringify([]);
    });
    const toolModel = jsonMemoryModel(() => {
      toolCalls += 1;
      return JSON.stringify([{ operation: "add", content: "The memory summarizer must use the configured tool model for completed turns.", durability: "permanent" }]);
    });
    const memory = new LocalMemory(
      workspaceRoot,
      () => extractionModel,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => [],
      () => toolModel
    );

    const incomplete = await memory.summarizeAndStoreMemories(
      [{ role: "user", content: "A single message is not enough to summarize." }],
      {
        sessionId: "tool-model-session",
        turnId: "tool-model-incomplete",
        runId: "tool-model-run-1",
        externalContext: false,
        excludeExternalContext: false
      }
    );
    assert.deepEqual(incomplete, { created: [], deleted: [] });
    assert.equal(toolCalls, 0);
    assert.equal(extractionCalls, 0);

    const complete = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "Use the configured tool model for this durable memory rule." },
        { role: "assistant", content: "I will store the stable rule after the completed turn." }
      ],
      {
        sessionId: "tool-model-session",
        turnId: "tool-model-complete",
        messageId: "M_2",
        runId: "tool-model-run-2",
        externalContext: false,
        excludeExternalContext: false,
        onMemoryWritten: async () => { throw new Error("downstream projection unavailable"); }
      }
    );
    assert.equal(complete.created.length, 1);
    const linked = (await memory.listMemoryEntries()).entries.find((entry) => entry.messageId === "M_2");
    assert.deepEqual(complete.created, [{ id: linked?.id, content: linked?.content }]);
    assert.deepEqual(complete.deleted, []);
    assert.equal(linked?.threadId, "tool-model-session");
    assert.deepEqual(linked?.tags, ["conversation-summary"]);
    assert.equal(linked?.source, "auto");
    assert.equal(linked?.importance, 0.5);
    assert.equal(toolCalls, 1);
    assert.equal(extractionCalls, 0);
    memory.close();
  });
}

async function testExtractionUsesOnlyConversationText(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const prompts: string[] = [];
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel(() => '["NO_MEMORY"]', prompts));
    const longText = "  用户长期信息 ".repeat(1200);
    try {
      await memory.summarizeAndStoreMemories([
        { role: "user", content: "outside the last four" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
        { role: "user", content: longText },
        { role: "assistant", content: [
          { type: "reasoning", text: "private reasoning must not become memory" },
          { type: "text", text: "visible first" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "tool arguments must not become memory" } },
          { type: "text", text: "visible second" }
        ] },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "tool result must not become memory" }] },
        { role: "user", content: "  final question  " },
        { role: "assistant", content: [{ type: "text", text: "final answer" }] }
      ], { sessionId: "text-session", turnId: "text-turn", runId: "text-run", externalContext: false, excludeExternalContext: false });
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0], "Extract memories from this conversation:\n\n"
        + "assistant: visible first\nvisible second\n\nuser:   final question  \n\nassistant: final answer",
        "先按完整消息流取最后四条，再排除工具正文；较早的用户文本不应被补入窗口");
    } finally {
      memory.close();
    }
  });
}

async function testRecallFormatsSourceTimeWithoutConflatingSaveTime(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    try {
      const result = await memory.writeEntry({
        content: "The release was planned for October 1.", tags: ["release"],
        originAnchors: [{ messageId: "source_2", sentAt: "2026-09-12T08:00:00.000Z", timeZone: "unknown" }]
      }, { now: new Date("2026-09-25T10:00:00.000Z") });
      const entry = result.entry!;
      const prompt = formatMemoryMatches([{ entry, excerpt: entry.content, path: `memory://${entry.id}`, score: 0.9 }]);
      assert.match(prompt, /tags: release/u);
      assert.match(prompt, /saved-at: 2026-09-25T10:00:00.000Z/u);
      assert.match(prompt, /source_2/u);
      assert.match(prompt, /2026-09-12T08:00:00.000Z/u);
      assert.match(prompt, /timeZone":"unknown/u);
      assert.match(prompt, /saved-at is NOT event\/due\/completion time/u);
      assert.match(prompt, /original message sent-at/u);
      assert.match(prompt, /only a subset of relevant memories/iu);
      assert.match(prompt, /recall_memory/u);
      const temporary = (await memory.writeEntry({
        content: "The user may visit Paris next month.", durability: "temporary",
        expiresAt: "2026-10-25T00:00:00.000Z"
      })).entry!;
      const temporaryPrompt = formatMemoryMatches([{ entry: temporary, excerpt: temporary.content }]);
      assert.match(temporaryPrompt, /temporary/u, "短期事实注入必须明确标记暂时性");
      assert.match(temporaryPrompt, /may be outdated/u, "短期事实应提醒模型核对时效");
      assert.doesNotMatch(prompt, /may be outdated/u, "长期事实不应被误标为短期");
    } finally {
      memory.close();
    }
  });
}

async function testExtractionPreservesOriginalMessageTime(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const prompts: string[] = [];
    const model = jsonMemoryModel((prompt) => prompt.startsWith("Extract memories from this conversation:")
      ? JSON.stringify([{ operation: "add", content: "The user plans to ship a release on 2026-10-01.", durability: "temporary" }])
      : "[]", prompts);
    const memory = new LocalMemory(
      workspaceRoot, () => model, undefined, 3, undefined, undefined, undefined, async () => []
    );
    const anchors = [{ messageId: "source_1", sentAt: "2026-09-20T10:30:00+08:00", timeZone: "unknown" }];
    try {
      const result = await memory.summarizeAndStoreMemories([
        { role: "user", content: "Next month I plan to ship a release." },
        { role: "assistant", content: "I will remember the deadline." }
      ], {
        sessionId: "time-session", turnId: "time-turn", runId: "time-run", messageId: "source_1",
        originAnchors: anchors, externalContext: false, excludeExternalContext: false
      });
      assert.equal(result.created.length, 1);
      const entry = (await memory.listMemoryEntries()).entries[0]!;
      assert.deepEqual(entry.originAnchors, [{ messageId: "source_1", sentAt: "2026-09-20T02:30:00.000Z", timeZone: "unknown" }]);
      assert.ok(prompts[0]?.includes("2026-09-20T02:30:00.000Z"));
      assert.ok(prompts[0]?.includes("timeZone: unknown"));
      assert.ok(memoryTimeAnchorInstruction.includes("memory creation/access/update time"));
      await memory.updateEntry(entry.id, { tags: ["deadline"] });
      assert.deepEqual((await memory.listMemoryEntries()).entries[0]?.originAnchors, entry.originAnchors);
      const archived = await memory.archiveEntry(entry.id, true);
      assert.deepEqual(archived.entry?.originAnchors, entry.originAnchors);
      const restored = await memory.archiveEntry(archived.entry!.id, false);
      assert.deepEqual(restored.entry?.originAnchors, entry.originAnchors);
    } finally {
      memory.close();
    }
  });
}

async function testAutomaticSummarySkipsWithoutSemanticEmbedding(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const model = jsonMemoryModel(() => JSON.stringify([{ operation: "add", content: "Automatic memory writes require a semantic embedding before they enter the durable store.", durability: "permanent" }]));
    const memory = new LocalMemory(
      workspaceRoot,
      () => model,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => undefined
    );
    const result = await memory.summarizeAndStoreMemories([
      { role: "user", content: "Only store this automatic fact when semantic deduplication is available." },
      { role: "assistant", content: "I will apply the semantic write gate." }
    ], {
      sessionId: "semantic-gate-session",
      turnId: "semantic-gate-turn",
      runId: "semantic-gate-run",
      externalContext: false,
      excludeExternalContext: false
    });
    assert.deepEqual(result.created, []);
    assert.equal((await memory.getOverview()).entryCount, 0);
    memory.close();
  });
}

/** 提取协议只产出扁平 content；audience/origin 映射已删除，所有 add 都进入单一命名空间。 */
async function testDirectExtractionWritesFlatEntries(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const semanticCandidates: MemoryEntry[] = [];
    const memory = new LocalMemory(
      workspaceRoot,
      () => jsonMemoryModel((prompt) => prompt.startsWith('New memory to add: "')
        ? JSON.stringify({ isDuplicate: true, duplicateOf: 1 })
        : JSON.stringify([
          { operation: "add", content: "Completed root turn established a durable release workflow for this workspace.", durability: "permanent" },
          { operation: "add", content: "The user prefers durable summaries to remain concise and directly actionable.", durability: "permanent" }
        ])),
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      async () => semanticCandidates
    );
    const result = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "Remember the durable release workflow and my preference for concise actionable summaries." },
        { role: "assistant", content: "I will retain those durable memory rules." }
      ],
      {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        externalContext: false,
        excludeExternalContext: true,
        now: new Date("2026-08-10T00:00:00.000Z")
      }
    );
    assert.equal(result.created.length, 2);
    const entries = (await memory.listMemoryEntries()).entries;
    assert.equal(entries.length, 2);
    assert.equal(entries.every((entry) => entry.source === "auto"), true);
    assert.deepEqual(entries.map((entry) => entry.tags), [["conversation-summary"], ["conversation-summary"]]);
    assert.equal(entries.every((entry) => entry.threadId === "session-1"), true);
    assert.equal(entries.every((entry) => entry.durability === "permanent"), true);

    // 再次提取相同事实时，由语义候选与模型判断重复，不依赖 SQLite 静默去重。
    semanticCandidates.push(...entries);
    const duplicate = await memory.summarizeAndStoreMemories(
      [
        { role: "user", content: "The same durable workflow and preference still apply." },
        { role: "assistant", content: "The existing durable entries still apply." }
      ],
      {
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-2",
        externalContext: false,
        excludeExternalContext: true,
        now: new Date("2026-08-10T00:00:00.000Z")
      }
    );
    assert.deepEqual(duplicate.created, []);
    assert.equal((await memory.getOverview()).entryCount, 2);

    // 配置为排除外部上下文时，完成回合不会调用模型，也不会写入事实库。
    const excluded = await memory.summarizeAndStoreMemories(
      [{ role: "user", content: "This came from an external attachment." }],
      {
        sessionId: "session-2",
        turnId: "turn-3",
        runId: "run-3",
        externalContext: true,
        excludeExternalContext: true
      }
    );
    assert.deepEqual(excluded, { created: [], deleted: [] });
    memory.close();
  });
}

async function testSleepRunRecord(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const old = await memory.writeEntry(projectEntry(
      "An archived release note must survive a failed similarity scan."
    ), { now: new Date("2026-06-01T00:00:00.000Z") });
    assert.ok(old.entry);
    const oldArchive = await memory.archiveEntry(old.entry.id, true, {
      now: new Date("2026-06-01T00:00:01.000Z")
    });
    assert.ok(oldArchive.entry);
    await memory.writeEntry(projectEntry(
      "A completed task summary with enough durable content for sleep processing."
    ), { now: new Date("2026-08-01T00:00:00.000Z") });
    await memory.writeEntry(projectEntry(
      "A second completed task summary that keeps the failure path in the same namespace."
    ), { now: new Date("2026-08-01T00:00:01.000Z") });
    const result = await memory.runMemoryMaintenance({ now: new Date("2026-08-02T00:00:00.000Z"), useLlm: false }, {
      findSimilarPairs: async () => {
        throw new Error("index unavailable");
      }
    });
    assert.equal(result.failed, 1);
    const status = await memory.loadMaintenanceStatus();
    assert.equal(status.lastRun?.trigger, "scheduled");
    assert.equal(status.lastRun?.status, "failed");
    assert.equal(status.lastRun?.error, "index unavailable");
    assert.equal(status.lastRun?.examined, 0, "索引失败时不能把条目数计入 examined");
    assert.deepEqual(status.lastRun?.progressEvents?.map((event) => event.stage), ["exact", "expired", "similarity"],
      "失败运行不宣称执行了物理归档清理");
    assert.equal(typeof status.lastRun?.id, "string");
    assert.equal((await memory.listArchivedEntries()).entries.some((entry) => entry.id === oldArchive.entry!.id), true,
      "失败的 Sleep 不能同时清除超过保留期的归档事实");
    memory.close();
  });
}

/** 另一 Runtime 在相似扫描等待期间也能读到此前阶段的累计计数。 */
async function testSleepProgressPersistsAcrossInstances(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const sleeper = new LocalMemory(workspaceRoot, unusedModel);
    const observer = new LocalMemory(workspaceRoot, unusedModel);
    let releaseScan: () => void = () => undefined;
    let run: Promise<unknown> | undefined;
    try {
      const duplicateText = "A durable fact duplicated for the Sleep progress contract.";
      await sleeper.writeEntry(projectEntry(duplicateText));
      await sleeper.writeEntry(projectEntry(duplicateText));
      await sleeper.writeEntry({ ...projectEntry("An expired temporary fact."), durability: "temporary", expiresAt: "2020-01-01T00:00:00.000Z" });
      await sleeper.writeEntry(projectEntry("A separate durable fact makes the similarity scan observable."));
      let scanStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { scanStarted = resolve; });
      const paused = new Promise<void>((resolve) => { releaseScan = resolve; });
      run = sleeper.runMemoryMaintenance({ now: new Date("2026-08-02T00:00:00.000Z"), useLlm: false }, {
        findSimilarPairs: async () => { scanStarted(); await paused; return { examined: 2, pairs: [] }; }
      });
      await started;
      const visible = await observer.loadMaintenanceStatus();
      assert.equal(visible.state, "running");
      assert.equal(visible.progressStage, "similarity");
      assert.equal(visible.lastRun?.status, "running");
      assert.equal(visible.lastRun?.archivedExact, 1);
      assert.equal(visible.lastRun?.archivedExpired, 1);
      assert.deepEqual(visible.lastRun?.progressEvents?.map((event) => event.stage), ["exact", "expired"]);
      releaseScan();
      await run;
      const finished = await observer.loadMaintenanceStatus();
      assert.equal(finished.state, "idle");
      assert.equal(finished.progressStage, undefined);
      assert.deepEqual(finished.lastRun?.progressEvents?.map((event) => event.stage), ["exact", "expired", "similarity", "purge"]);
      assert.equal(finished.lastRun?.progressEvents?.[2]?.examined, 2);
    } finally {
      releaseScan();
      await run?.catch(() => undefined);
      sleeper.close();
      observer.close();
    }
  });
}

async function testArchiveAndRestore(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const created = await storage.writeEntry(projectEntry(
      "This memory remains available after archival and can be restored without losing its SQLite fact."
    ));
    assert.ok(created.entry);
    const archived = await storage.archiveEntry(created.entry!.id, true, { now: new Date("2026-08-20T00:00:00.000Z") });
    assert.equal(archived.archived, true);
    assert.equal(archived.entry?.archivedReason, "manual");
    assert.notEqual(archived.entry?.id, created.entry!.id);
    assert.equal(archived.entry?.originalId, created.entry!.id);
    assert.equal(archived.entry?.archivedBy, "manual");
    assert.equal((await storage.listEntries()).entries.length, 0);
    assert.equal((await storage.listEntries({ includeArchived: true })).entries.length, 1);
    const restored = await storage.archiveEntry(archived.entry!.id, false, { now: new Date("2026-08-21T00:00:00.000Z") });
    assert.equal(restored.archived, false);
    assert.equal(restored.entry?.archivedAt, undefined);
    assert.notEqual(restored.entry?.id, created.entry!.id);
    assert.equal(restored.entry?.originalId, undefined);
    assert.equal((await storage.listEntries()).entries.length, 1);
  });
}

async function testTemporaryMemoryExpiry(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const now = new Date("2026-08-31T00:00:00.000Z");

    const write = async (title: string, createdAt: string, extras: Partial<MemoryEntryInput> = {}): Promise<MemoryEntry> => {
      const result = await memory.writeEntry({
        ...projectEntry(`${title} contains a temporary fact used to verify expiration semantics.`),
        durability: "temporary",
        ...extras
      }, { now: new Date(createdAt) });

      assert.ok(result.entry);
      return result.entry;
    };

    const ttlBoundary = await write("TTL boundary", "2026-08-01T00:00:00.000Z");
    const ttlExpired = await write("TTL expired", "2026-07-31T00:00:00.000Z");
    const futureExpiry = await write("Future expiry", "2026-07-31T00:00:00.000Z", { expiresAt: "2026-09-01T00:00:00.000Z" });
    const recalled = await write("Recalled temporary", "2026-07-31T00:00:00.000Z");
    const pastExpiry = await write("Past expiry", "2026-08-30T00:00:00.000Z", { expiresAt: "2026-08-30T23:59:59.000Z" });
    const equalExpiry = await write("Equal expiry", "2026-08-30T00:00:00.000Z", { expiresAt: now.toISOString() });
    await memory.recordRecallUsage([recalled.id], { now: new Date("2026-08-30T12:00:00.000Z") });

    const preview = await memory.previewMaintenance({ now, useLlm: false });
    assert.equal(preview.temporaryToArchive, 3);

    const result = await memory.runMemoryMaintenance({
      now,
      useLlm: false
    });
    assert.equal(result.failed, 0);
    const active = (await memory.listMemoryEntries()).entries;
    assert.deepEqual(new Set(active.map((entry) => entry.id)), new Set([ttlBoundary.id, recalled.id, equalExpiry.id]));
    const archived = (await memory.listArchivedEntries()).entries;
    assert.deepEqual(new Set(archived.map((entry) => entry.originalId)), new Set([ttlExpired.id, futureExpiry.id, pastExpiry.id]));
    const retentionBoundary = new Date("2026-09-30T00:00:00.000Z");
    assert.equal((await memory.previewMaintenance({ now: retentionBoundary, useLlm: false })).archivedToDelete, 0);
    await memory.runMemoryMaintenance({ now: retentionBoundary, useLlm: false });
    const boundaryArchive = (await memory.listArchivedEntries()).entries;
    for (const entry of archived) {
      assert.ok(boundaryArchive.some((remaining) => remaining.id === entry.id));
    }
    const later = new Date(retentionBoundary.getTime() + 1);
    assert.equal((await memory.previewMaintenance({ now: later, useLlm: false })).archivedToDelete, 3);
    const cleanup = await memory.runMemoryMaintenance({ now: later, useLlm: false });
    assert.equal(cleanup.failed, 0);
    const remainingArchive = (await memory.listArchivedEntries()).entries;
    for (const entry of archived) {
      assert.equal(remainingArchive.some((remaining) => remaining.id === entry.id), false);
    }
    memory.close();
  });
}

/**
 * 扁平单库允许显式同文并存；Sleep exact 另区分 userId、temporary 的未知来源与持久事实。
 */
async function testSleepSingleNamespaceExactAndExpired(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const summary = "The user prefers deterministic release checks before publishing changes.";
    const first = await memory.writeEntry({
      ...projectEntry(summary),
      durability: "temporary",
      expiresAt: "2020-01-01T00:00:00.000Z",
      userId: "release-user"
    }, { now: new Date("2026-08-01T00:00:00.000Z") });
    const second = await memory.writeEntry(projectEntry(
      "The team keeps a deterministic release checklist for publishing changes."
    ), { now: new Date("2026-08-01T01:00:00.000Z") });
    assert.ok(first.entry && second.entry);
    // updateEntry 不做写入期去重：即使形成同文行，temporary 与 permanent 也不能直接合并。
    const duplicate = await memory.updateEntry(second.entry.id, {
      content: summary,
      userId: "release-user"
    }, { now: new Date("2026-08-01T02:00:00.000Z") });
    assert.equal(duplicate.written, true);

    const beforePreview = await memory.listMemoryEntries();
    const preview = await memory.previewMaintenance({ useLlm: false });
    assert.equal(preview.skipped, undefined);
    assert.deepEqual(preview.archiveProposed?.map((item) => item.reason), ["expired"]);
    assert.deepEqual(await memory.listMemoryEntries(), beforePreview);

    const result = await memory.runMemoryMaintenance({ useLlm: false });
    assert.equal(result.failed, 0);
    assert.equal((await memory.listMemoryEntries()).entries.length, 1);
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.originalId, first.entry.id);
    assert.equal(archived[0]?.archivedReason, "expired");
    assert.equal(archived[0]?.mergedInto, undefined);
    memory.close();
  });
}

/** 单一命名空间：跨工作区显式同文可并存；Sleep 从任一工作区扫描并整理共享库。 */
async function testSleepCoversSharedLibraryFromAnyWorkspace(): Promise<void> {
  await withSharedAgent(async (_agentRoot) => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "biny-memory-sleep-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "biny-memory-sleep-b-"));
    const memoryA = new LocalMemory(workspaceA, unusedModel);
    const memoryB = new LocalMemory(workspaceB, unusedModel);
    try {
      const summary = "Keep the release checks consistent between the two shared-library workspaces.";
      const first = await memoryA.writeEntry(projectEntry(summary), { now: new Date("2026-08-01T00:00:00.000Z") });
      assert.ok(first.entry);
      // 显式写入各自保留事实，Sleep 统一整理跨工作区的同文条目。
      const duplicate = await memoryB.writeEntry(projectEntry(summary));
      assert.equal(duplicate.written, true);
      assert.notEqual(duplicate.entry?.id, first.entry.id);
      const second = await memoryB.writeEntry(projectEntry(
        "Workspace B adds a distinct typecheck rule to the shared library."
      ), { now: new Date("2026-08-01T01:00:00.000Z") });
      assert.equal(second.written, true);
      assert.equal(second.revision, 3, "两个工作区写入推进同一个 revision");

      const result = await memoryA.runMemoryMaintenance({ useLlm: false });
      assert.equal(result.failed, 0);
      assert.equal(result.scanned, 3, "Sleep 从工作区 A 扫描共享库全部条目");
      assert.equal((await memoryA.listMemoryEntries()).entries.length, 2);
      assert.equal((await memoryA.listArchivedEntries()).entries.length, 1);
    } finally {
      memoryA.close();
      memoryB.close();
      await rm(workspaceA, { recursive: true, force: true });
      await rm(workspaceB, { recursive: true, force: true });
    }
  });
}

/** 共享单库里的向量扫描按精确 userId 分桶，未绑定用户的事实单独成桶。 */
async function testSleepSimilarityScansEachUserNamespace(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const entries: MemoryEntry[] = [];

    for (const [userId, content] of [
      ["user-a", "User A keeps a deterministic release rule for publishing."],
      ["user-a", "User A keeps a deterministic release note for archiving."],
      ["user-b", "User B keeps a deterministic release rule for publishing."],
      ["user-b", "User B keeps a deterministic release note for archiving."],
      [undefined, "The shared workspace keeps a separate release reference."]
    ] as const) {
      const result = await memory.writeEntry({ ...projectEntry(content), userId });
      assert.ok(result.entry);
      entries.push(result.entry);
    }
    const calls: Array<string | undefined> = [];
    const index = {
      indexEntry: async () => undefined,
      findSimilarPairs: async (namespace: MemoryEntry[]) => {
        assert.ok(namespace.length > 0);
        const userId = namespace[0]!.userId;
        assert.ok(namespace.every((entry) => entry.userId === userId), "每次只交给派生索引同一精确 userId 的事实");
        calls.push(userId);
        return { examined: namespace.length, pairs: namespace.length < 2 ? [] : [
          { leftId: namespace[0]!.id, rightId: namespace[1]!.id, similarity: 0.99 }
        ] };
      }
    };
    const preview = await memory.previewMaintenance({ useLlm: false }, index);
    assert.equal(preview.skipped, undefined);
    assert.deepEqual(new Set(calls), new Set(["user-a", "user-b", undefined]));
    assert.equal(preview.examined, entries.length, "预览累计所有命名空间，包括单条默认命名空间");
    assert.equal(preview.archiveProposed?.filter((entry) => entry.reason === "similarity_merge").length, 2);
    calls.length = 0;
    const result = await memory.runMemoryMaintenance({ useLlm: false }, {
      ...index
    });
    assert.equal(result.failed, 0);
    assert.deepEqual(new Set(calls), new Set(["user-a", "user-b", undefined]));
    assert.equal(memory.maintenanceStatus().lastRun?.examined, entries.length);
    assert.equal((await memory.listMemoryEntries()).entries.length, 3);
    memory.close();
  });
}

async function testSleepNamespaceProgressIsBounded(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    for (let index = 0; index < 70; index += 1) {
      await memory.writeEntry({ ...projectEntry(`A distinct reference for namespace ${index}.`), userId: `user-${index}` });
    }
    const result = await memory.runMemoryMaintenance({ useLlm: false }, {
      indexEntry: async () => undefined,
      findSimilarPairs: async (namespace) => ({ examined: namespace.length, pairs: [] })
    });
    assert.equal(result.failed, 0);
    const observer = new LocalMemory(workspaceRoot, unusedModel);
    const run = (await observer.loadMaintenanceStatus()).lastRun;
    assert.equal(run?.examined, 70);
    assert.equal(run?.progressEvents?.length, 64, "持久阶段日志不随用户数量无界增长");
    assert.deepEqual(run?.progressEvents?.slice(0, 2).map((event) => event.stage), ["exact", "expired"]);
    assert.equal(run?.progressEvents?.at(-1)?.stage, "purge");
    assert.equal(run?.progressEvents?.at(-2)?.examined, 70);
    assert.equal(run?.progressEvents?.at(-1)?.sequence, 73);
    observer.close();
    memory.close();
  });
}

async function testSleepNamespaceScanFailureStopsLaterNamespaces(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    for (const userId of ["user-a", "user-b", "user-c"]) {
      await memory.writeEntry({ ...projectEntry(`A distinct rule for ${userId}.`), userId });
    }
    const calls: string[] = [];
    const result = await memory.runMemoryMaintenance({ useLlm: false }, {
      indexEntry: async () => undefined,
      findSimilarPairs: async (namespace) => {
        calls.push(namespace[0]!.userId!);
        throw new Error("namespace scan unavailable");
      }
    });
    assert.equal(result.failed, 1);
    assert.equal(calls.length, 1, "扫描失败后不继续其它命名空间");
    const run = (await memory.loadMaintenanceStatus()).lastRun;
    assert.equal(run?.status, "failed");
    assert.deepEqual(run?.progressEvents?.map((event) => event.stage), ["exact", "expired", "similarity"]);
    assert.equal(run?.progressEvents?.at(-1)?.namespaceUserId, calls[0]);
    memory.close();
  });
}

async function testSleepSimilarityBoundaries(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const prompts: string[] = [];
    const model = jsonMemoryModel((prompt) => {
      const ids = memoryClusterIds(prompt);
      return ids.length === 3 || prompt.includes("The temporary rule repeats")
        ? JSON.stringify({ delete: [], synthesize: [] })
        : JSON.stringify({ delete: [ids[0]], synthesize: [] });
    }, prompts);
    const memory = new LocalMemory(workspaceRoot, () => model);

    const write = async (content: string, extras: Partial<MemoryEntryInput> = {}): Promise<MemoryEntry> => {
      const result = await memory.writeEntry({ ...projectEntry(content), ...extras });

      assert.ok(result.entry);
      return result.entry;
    };

    const permanent = await write("The permanent rule is the durable source for this similar fact.", { importance: 1 });
    const temporary = await write("The temporary rule repeats the durable source with extra detail.", { durability: "temporary", importance: 5 });
    const chainA = await write("The first chain memory describes the same release operation.");
    const chainB = await write("The middle chain memory describes the same release operation.");
    const chainC = await write("The last chain memory describes the same release operation.");
    const pairA = await write("The first pair memory describes a repeated deployment operation.");
    const pairB = await write("The second pair memory describes a repeated deployment operation.");

    const result = await memory.runMemoryMaintenance({ now: new Date("2026-08-31T00:00:00.000Z") }, {
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => ({ examined: 7, pairs: [
        { leftId: permanent.id, rightId: temporary.id, similarity: 0.95 },
        { leftId: chainA.id, rightId: chainB.id, similarity: 0.8 },
        { leftId: chainB.id, rightId: chainC.id, similarity: 0.8 },
        { leftId: pairA.id, rightId: pairB.id, similarity: 0.8 }
      ] })
    });
    assert.equal(result.failed, 0);
    assert.equal(prompts.length, 3, "temporary facts require a model decision even above the direct similarity threshold");
    const active = (await memory.listMemoryEntries()).entries;
    assert.equal(active.some((entry) => entry.id === permanent.id), true, "permanent memory wins survivor selection");
    assert.equal(active.some((entry) => entry.id === temporary.id), true);
    assert.equal(active.filter((entry) => [chainA.id, chainB.id, chainC.id].includes(entry.id)).length, 3);
    const activePair = active.find((entry) => [pairA.id, pairB.id].includes(entry.id));
    assert.ok(activePair);
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.some((entry) => entry.originalId === temporary.id), false);
    const llmArchived = archived.find((entry) => [pairA.id, pairB.id].includes(entry.originalId ?? ""));
    assert.equal(llmArchived?.archivedReason, "llm_merge");
    assert.equal(llmArchived?.mergedInto, activePair.id);
    memory.close();
  });
}

async function testSleepAnchoredSimilarityRequiresModelDecision(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const prompts: string[] = [];
    const model = jsonMemoryModel(() => JSON.stringify({ delete: [], synthesize: [] }), prompts);
    const memory = new LocalMemory(workspaceRoot, () => model);
    try {
      const anchor = { messageId: "source-message", sentAt: "2026-08-01T09:00:00.000Z", timeZone: "Asia/Shanghai" };
      const anchored = (await memory.writeEntry({ ...projectEntry("Release scheduled for Friday."), originAnchors: [anchor] })).entry!;
      const unanchored = (await memory.writeEntry(projectEntry("Release planned for the end of the week."))).entry!;
      const index = { findSimilarPairs: async () => ({ examined: 2, pairs: [
        { leftId: anchored.id, rightId: unanchored.id, similarity: 0.98 }
      ] }) };
      const preview = await memory.previewMaintenance({}, index);
      assert.equal(preview.archiveProposed?.some((entry) => entry.reason === "similarity_merge"), false);
      assert.equal(prompts.length, 1);
      const result = await memory.runMemoryMaintenance({}, index);
      assert.equal(result.failed, 0);
      assert.equal(prompts.length, 2);
      assert.deepEqual(new Set((await memory.listMemoryEntries()).entries.map((entry) => entry.id)),
        new Set([anchored.id, unanchored.id]));
      assert.equal((await memory.listArchivedEntries()).entries.length, 0);
    } finally { memory.close(); }
  });
}

async function testSleepExactDuplicatesRespectSourceTime(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot);
    try {
      const first = (await memory.writeEntry({
        content: "The release is scheduled for Friday.",
        originAnchors: [{ messageId: "source-one", sentAt: "2026-08-01T09:00:00.000Z", timeZone: "Asia/Shanghai" }]
      })).entry!;
      const second = (await memory.writeEntry({
        content: "An unrelated draft fact.",
        originAnchors: [{ messageId: "source-two", sentAt: "2026-08-08T09:00:00.000Z", timeZone: "Asia/Shanghai" }]
      })).entry!;
      await memory.updateEntry(second.id, { content: first.content });
      const preview = await memory.previewMaintenance({ useLlm: false });
      assert.equal(preview.archiveProposed?.some((entry) => entry.reason === "exact_dup"), false);
      await memory.runMemoryMaintenance({ useLlm: false });
      assert.deepEqual(new Set((await memory.listMemoryEntries()).entries.map((entry) => entry.id)),
        new Set([first.id, second.id]));
    } finally { memory.close(); }
  });
}

async function testSleepSimilarityDoesNotMergeDifferentUsers(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    try {
      const first = await memory.writeEntry({ content: "A plan belongs to user A.", userId: "user-a" });
      const second = await memory.writeEntry({ content: "A nearly identical plan belongs to user B.", userId: "user-b" });
      assert.ok(first.entry && second.entry);
      const index = {
        indexEntry: async () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [
          { leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.99 }
        ] })
      };
      const preview = await memory.previewMaintenance({ useLlm: false }, index);
      assert.deepEqual(preview.archiveProposed?.filter((item) => item.reason === "similarity_merge"), []);
      const run = await memory.runMemoryMaintenance({ useLlm: false }, index);
      assert.equal(run.failed, 0);
      assert.equal((await memory.listMemoryEntries()).total, 2);
      assert.equal((await memory.listArchivedEntries()).total, 0);
    } finally {
      memory.close();
    }
  });
}

/** 候选簇内的一条强边不能使通过弱边连进来的事实免于独立判断。 */
async function testSleepStrongPairDoesNotArchiveWeakClusterMember(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, () => unusedModel);
    try {
      const first = await memory.writeEntry({ ...projectEntry("The canonical release rule is retained."), importance: 1 });
      const duplicate = await memory.writeEntry(projectEntry("A near duplicate of the canonical release rule."));
      const related = await memory.writeEntry(projectEntry("A related but distinct release exception."));
      assert.ok(first.entry && duplicate.entry && related.entry);
      const index = {
        indexEntry: async () => undefined,
        findSimilarPairs: async () => ({ examined: 3, pairs: [
          { leftId: first.entry!.id, rightId: duplicate.entry!.id, similarity: 0.96 },
          { leftId: duplicate.entry!.id, rightId: related.entry!.id, similarity: 0.8 }
        ] })
      };
      const preview = await memory.previewMaintenance({ useLlm: false }, index);
      assert.deepEqual(preview.archiveProposed?.filter((item) => item.reason === "similarity_merge").map((item) => item.id), [duplicate.entry.id]);

      const result = await memory.runMemoryMaintenance({ useLlm: false }, index);
      assert.equal(result.failed, 0);
      assert.deepEqual(new Set((await memory.listMemoryEntries()).entries.map((entry) => entry.id)), new Set([first.entry.id, related.entry.id]));
      assert.deepEqual((await memory.listArchivedEntries()).entries.map((entry) => entry.originalId), [duplicate.entry.id]);
    } finally {
      memory.close();
    }
  });
}

/** 相似度扫描等待期间发生的手工编辑必须让旧版本的归档决定失效。 */
async function testSleepDoesNotArchiveEditedSourceFromOldScan(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const sleeper = new LocalMemory(workspaceRoot, () => unusedModel);
    const editor = new LocalMemory(workspaceRoot, () => unusedModel);
    let releaseScan: () => void = () => undefined;
    try {
      const survivor = await sleeper.writeEntry({ ...projectEntry("Canonical source before the scan."), importance: 1 });
      const source = await sleeper.writeEntry(projectEntry("Source content before the scan."));
      assert.ok(survivor.entry && source.entry);
      let scanStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { scanStarted = resolve; });
      const paused = new Promise<void>((resolve) => { releaseScan = resolve; });
      const run = sleeper.runMemoryMaintenance({ useLlm: false }, {
        indexEntry: async () => undefined,
        findSimilarPairs: async () => {
          scanStarted();
          await paused;
          return { examined: 2, pairs: [{ leftId: survivor.entry!.id, rightId: source.entry!.id, similarity: 0.99 }] };
        }
      });
      await started;
      await editor.updateEntry(source.entry.id, { content: "Newly edited source must stay available." });
      releaseScan();
      await run;
      assert.equal((await sleeper.listMemoryEntries()).entries.find((entry) => entry.id === source.entry!.id)?.content, "Newly edited source must stay available.");
      assert.equal((await sleeper.listArchivedEntries()).entries.some((entry) => entry.originalId === source.entry!.id), false);
    } finally {
      releaseScan();
      sleeper.close();
      editor.close();
    }
  });
}

/** survivor 消失后，其他条目不能继续归档并指向不存在的目标。 */
async function testSleepDoesNotArchiveIntoDeletedSurvivor(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const sleeper = new LocalMemory(workspaceRoot, () => unusedModel);
    const editor = new LocalMemory(workspaceRoot, () => unusedModel);
    let releaseScan: () => void = () => undefined;
    try {
      const survivor = await sleeper.writeEntry({ ...projectEntry("Canonical source before deletion."), importance: 1 });
      const source = await sleeper.writeEntry(projectEntry("Related source before deletion."));
      assert.ok(survivor.entry && source.entry);
      let scanStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { scanStarted = resolve; });
      const paused = new Promise<void>((resolve) => { releaseScan = resolve; });
      const run = sleeper.runMemoryMaintenance({ useLlm: false }, {
        indexEntry: async () => undefined,
        findSimilarPairs: async () => {
          scanStarted();
          await paused;
          return { examined: 2, pairs: [{ leftId: survivor.entry!.id, rightId: source.entry!.id, similarity: 0.99 }] };
        }
      });
      await started;
      await editor.deleteEntryById(survivor.entry.id);
      releaseScan();
      await run;
      assert.equal((await sleeper.listMemoryEntries()).entries.some((entry) => entry.id === source.entry!.id), true);
      assert.equal((await sleeper.listArchivedEntries()).entries.some((entry) => entry.originalId === source.entry!.id), false);
    } finally {
      releaseScan();
      sleeper.close();
      editor.close();
    }
  });
}

/** Host B 加载共享状态时不能把仍在工作的 Host A 标记为崩溃遗留任务。 */
async function testSecondInstanceDoesNotInterruptActiveSleep(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const first = new LocalMemory(workspaceRoot, () => unusedModel);
    const second = new LocalMemory(workspaceRoot, () => unusedModel);
    let releaseScan: () => void = () => undefined;
    let run: Promise<unknown> | undefined;
    try {
      const left = await first.writeEntry(projectEntry("First memory for an active sleep owner."));
      const right = await first.writeEntry(projectEntry("Second memory for an active sleep owner."));
      assert.ok(left.entry && right.entry);
      let scanStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { scanStarted = resolve; });
      const paused = new Promise<void>((resolve) => { releaseScan = resolve; });
      run = first.runMemoryMaintenance({ useLlm: false }, {
        indexEntry: async () => undefined,
        findSimilarPairs: async () => {
          scanStarted();
          await paused;
          return { examined: 2, pairs: [] };
        }
      });
      await started;
      const visible = await second.loadMaintenanceStatus();
      assert.equal(visible.state, "running");
      assert.equal(visible.lastRun?.status, "running");
      await assert.rejects(second.runMemoryMaintenance({ useLlm: false }), /already in progress|owner|lease/i);
      releaseScan();
      await run;
      assert.equal((await second.loadMaintenanceStatus()).lastRun?.status, "completed");
    } finally {
      releaseScan();
      await run?.catch(() => undefined);
      first.close();
      second.close();
    }
  });
}

/** lease 被接管后，旧扫描结果即使返回也不能覆盖新 owner 的事实与审计。 */
async function testStaleSleepOwnerCannotCommitAfterTakeover(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const first = new LocalMemory(workspaceRoot, () => unusedModel);
    const second = new LocalMemory(workspaceRoot, () => unusedModel);
    let releaseScan: () => void = () => undefined;
    let firstRun: Promise<unknown> | undefined;
    try {
      const survivor = await first.writeEntry({ ...projectEntry("Survivor before owner takeover."), importance: 1 });
      const source = await first.writeEntry(projectEntry("Source before owner takeover."));
      assert.ok(survivor.entry && source.entry);
      let scanStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { scanStarted = resolve; });
      const paused = new Promise<void>((resolve) => { releaseScan = resolve; });
      firstRun = first.runMemoryMaintenance({ useLlm: false }, {
        indexEntry: async () => undefined,
        findSimilarPairs: async () => {
          scanStarted();
          await paused;
          return { examined: 2, pairs: [{ leftId: survivor.entry!.id, rightId: source.entry!.id, similarity: 0.99 }] };
        }
      });
      await started;
      // 只推进持久 lease 的时间边界，模拟进程暂停超过租期；无需真实等待一分钟。
      const database = new DatabaseSync(path.join(agentRoot, AGENT_DATABASE_FILE));
      try {
        const row = database.prepare("SELECT value FROM memory_meta WHERE key = 'sleep_owner'").get() as { value?: string } | undefined;
        assert.ok(row?.value);
        database.prepare("UPDATE memory_meta SET value = ? WHERE key = 'sleep_owner'")
          .run(JSON.stringify({ ...JSON.parse(row.value), expiresAt: 0 }));
      } finally {
        database.close();
      }
      const recovered = await second.loadMaintenanceStatus();
      assert.equal(recovered.lastRun?.status, "failed");
      const replacement = await second.runMemoryMaintenance({ useLlm: false });
      assert.equal(replacement.failed, 0);
      releaseScan();
      await assert.rejects(firstRun, /owner lease was lost/i);
      assert.deepEqual(new Set((await second.listMemoryEntries()).entries.map((entry) => entry.id)), new Set([survivor.entry.id, source.entry.id]));
      assert.equal((await second.loadMaintenanceStatus()).lastRun?.status, "completed");
    } finally {
      releaseScan();
      await firstRun?.catch(() => undefined);
      first.close();
      second.close();
    }
  });
}

/** B 曾看见 A 的 running，也不能在 A 完成后把旧状态写回历史。 */
async function testSecondInstanceStartsFromLatestCompletedHistory(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const first = new LocalMemory(workspaceRoot, () => unusedModel);
    const second = new LocalMemory(workspaceRoot, () => unusedModel);
    let releaseScan: () => void = () => undefined;
    let firstRun: Promise<unknown> | undefined;
    try {
      await first.writeEntry(projectEntry("One entry keeps the first Sleep occupied."));
      await first.writeEntry(projectEntry("A second entry keeps the scan available."));
      let scanStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { scanStarted = resolve; });
      const paused = new Promise<void>((resolve) => { releaseScan = resolve; });
      firstRun = first.runMemoryMaintenance({ useLlm: false }, {
        indexEntry: async () => undefined,
        findSimilarPairs: async () => { scanStarted(); await paused; return { examined: 2, pairs: [] }; }
      });
      await started;
      const observed = await second.loadMaintenanceStatus();
      const firstRunId = observed.lastRun?.id;
      assert.equal(observed.lastRun?.status, "running");
      releaseScan();
      await firstRun;
      await second.runMemoryMaintenance({ useLlm: false });
      const history = (await second.loadMaintenanceStatus()).sleepRuns;
      assert.equal(history?.find((run) => run.id === firstRunId)?.status, "completed");
    } finally {
      releaseScan();
      await firstRun?.catch(() => undefined);
      first.close();
      second.close();
    }
  });
}

async function testSleepWeightedSurvivor(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const storage = new MemoryStorage(workspaceRoot);
    try {
      const timestamp = "2026-08-01T00:00:00.000Z";
      const first = await storage.writeEntry({
        ...projectEntry("A frequently accessed source describes the release workflow."),
        importance: 0.1,
        accessCount: 500
      }, { now: new Date(timestamp) });
      const second = await storage.writeEntry({
        ...projectEntry("A more important source describes related release workflow details."),
        importance: 0.7,
        accessCount: 0
      }, { now: new Date(timestamp) });
      assert.ok(first.entry && second.entry);
      const index = {
        indexEntry: async () => undefined,
        requestRebuild: () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.99 }] })
      };
      const preview = await memory.previewMaintenance({ useLlm: false }, index);
      assert.deepEqual(preview.archiveProposed, [{ id: first.entry.id, content: "A frequently accessed source describes the release workflow.", reason: "similarity_merge", mergedInto: second.entry.id }]);
      const result = await memory.runMemoryMaintenance({ useLlm: false }, index);
      assert.equal(result.failed, 0);
      assert.deepEqual((await memory.listMemoryEntries()).entries.map((entry) => entry.id), [second.entry.id]);
    } finally {
      memory.close();
      storage.close();
    }
  });
}

async function testSleepBatchOrdering(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const seen: string[][] = [];
    let cancelRequest: AbortController | undefined;
    let response: "retain" | "synthesize" | "delete" | "first-fails" = "retain";
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel((prompt) => {
      const batch = memoryClusterIds(prompt);
      seen.push(batch);
      if (cancelRequest) {
        cancelRequest.abort();
        throw new Error("request interrupted");
      }
      if (response === "first-fails") {
        if (seen.length === 1) throw new Error("first batch model request failed");
        return JSON.stringify({ delete: [batch[0]], synthesize: [] });
      }
      if (response === "delete") return JSON.stringify({ delete: [batch[0]], synthesize: [] });
      if (response === "synthesize") return JSON.stringify({
        delete: seen.length === 1 ? [] : [batch[0]],
        synthesize: Array.from({ length: seen.length === 1 ? 2 : 1 }, (_, index) => ({
          content: `Synthesized fact ${seen.length}-${index} preserves related source information.`,
          durability: "permanent"
        }))
      });
      return '{"delete":[],"synthesize":[]}';
    }));
    try {
      const entries: MemoryEntry[] = [];

      for (let index = 0; index < 4; index += 1) {
        const result = await memory.writeEntry(projectEntry(`Distinct chronological fact number ${index} describing the deployment process.`), {
          now: new Date(`2026-08-0${index + 1}T00:00:00.000Z`)
        });
        assert.ok(result.entry);
        entries.push(result.entry);

      }
      const ids = entries.map((entry) => entry.id);
      const index = {
        indexEntry: async () => undefined,
        requestRebuild: () => undefined,
        findSimilarPairs: async () => ({ examined: 4, pairs: [
          { leftId: ids[1]!, rightId: ids[0]!, similarity: 0.8 },
          { leftId: ids[0]!, rightId: ids[2]!, similarity: 0.8 },
          { leftId: ids[2]!, rightId: ids[3]!, similarity: 0.8 }
        ] })
      };
      for (const batchSize of [4, 2]) {
        const expected = batchSize === 4 ? [[ids[1], ids[0], ids[2], ids[3]]] : [[ids[3], ids[2]], [ids[1], ids[0]]];
        seen.length = 0;
        await memory.previewMaintenance({ llmBatchSize: batchSize }, index);
        assert.deepEqual(seen, expected);
        seen.length = 0;
        const result = await memory.runMemoryMaintenance({ llmBatchSize: batchSize }, index);
        assert.equal(result.failed, 0);
        assert.deepEqual(seen, expected);
      }
      const before = await memory.listMemoryEntries();
      response = "synthesize";
      seen.length = 0;
      const combined = await memory.previewMaintenance({ llmBatchSize: 2 }, index);
      assert.deepEqual(combined.synthesisProposed?.map((item) => item.sourceIds), [
        [ids[3], ids[2]], [ids[3], ids[2]], [ids[1]]
      ]);
      assert.deepEqual(combined.archiveProposed, [{
        id: ids[1], content: entries[1]!.content, reason: "llm_merge", mergedInto: "preview-3"
      }]);
      seen.length = 0;
      assert.deepEqual(await memory.previewMaintenance({ llmBatchSize: 2 }, index), combined);
      response = "delete";
      seen.length = 0;
      const deletion = await memory.previewMaintenance({ llmBatchSize: 2 }, index);
      assert.deepEqual(deletion.synthesisProposed, []);
      assert.deepEqual(deletion.archiveProposed, [
        { id: ids[3], content: entries[3]!.content, reason: "llm_merge", mergedInto: ids[2] },
        { id: ids[1], content: entries[1]!.content, reason: "llm_merge", mergedInto: ids[0] }
      ]);
      assert.deepEqual(await memory.listMemoryEntries(), before);
      response = "first-fails";
      cancelRequest = new AbortController();
      seen.length = 0;
      const cancelled = await memory.previewMaintenance({ llmBatchSize: 2, signal: cancelRequest.signal }, index);
      assert.equal(seen.length, 1);
      assert.equal(cancelled.skipped, "Cancelled by user");
      assert.deepEqual(cancelled.archiveProposed, []);
      assert.deepEqual(await memory.listMemoryEntries(), before);
      cancelRequest = undefined;
      seen.length = 0;
      const partial = await memory.previewMaintenance({ llmBatchSize: 2 }, index);
      assert.equal(seen.length, 2);
      assert.equal(partial.skipped, undefined);
      assert.deepEqual(partial.archiveProposed, [
        { id: ids[1], content: entries[1]!.content, reason: "llm_merge", mergedInto: ids[0] }
      ]);
      assert.deepEqual(await memory.listMemoryEntries(), before);
      seen.length = 0;
      const continued = await memory.runMemoryMaintenance({ llmBatchSize: 2 }, index);
      assert.equal(seen.length, 2);
      assert.equal(continued.failed, 0);
      assert.deepEqual(new Set((await memory.listMemoryEntries()).entries.map((entry) => entry.id)), new Set([ids[3], ids[2], ids[0]]));
    } finally {
      memory.close();
    }
  });
}

async function testSleepPreviewDoesNotMutate(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let deletedId = "";
    const prompts: string[] = [];
    const model = jsonMemoryModel(() => `Consolidation result:\n${JSON.stringify({ delete: [deletedId, "outside-cluster"], synthesize: [{ content: "A combined durable explanation of both related project facts.", durability: "permanent" }] })}\nEnd of result.`, prompts);
    const memory = new LocalMemory(workspaceRoot, () => model);
    const storage = new MemoryStorage(workspaceRoot);
    try {
      const first = await memory.writeEntry(projectEntry("The first durable source fact for the preview-only cluster."));
      const second = await memory.writeEntry(projectEntry("The second durable source fact for the preview-only cluster."));
      assert.ok(first.entry && second.entry);
      deletedId = first.entry.id;
      const before = await storage.listEntries({ includeArchived: true });
      const status = await storage.readMaintenanceStatus();
      const disabled = await memory.previewMaintenance({ sleepEnabled: false }, {
        findSimilarPairs: async () => { throw new Error("disabled preview must not query embeddings"); }
      });
      assert.equal(disabled.skipped, "Sleep is disabled in settings.");
      assert.deepEqual(disabled.archiveProposed, []);
      assert.deepEqual(disabled.synthesisProposed, []);
      assert.equal(prompts.length, 0);
      assert.deepEqual(await storage.listEntries({ includeArchived: true }), before);
      assert.deepEqual(await storage.readMaintenanceStatus(), status);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const running = memory.runMemoryMaintenance({ useLlm: false }, {
        findSimilarPairs: async () => { await pending; return ({ examined: 0, pairs: [] }); }
      });
      try {
        for (const sleepEnabled of [true, false]) {
          const deferred = await memory.previewMaintenance({ sleepEnabled }, {
            findSimilarPairs: async () => { throw new Error("must not start concurrent preview"); }
          });
          assert.equal(deferred.skipped, "A real sleep cycle is currently running; preview deferred.");
          assert.deepEqual(deferred.archiveProposed, []);
          assert.deepEqual(deferred.synthesisProposed, []);
        }
      } finally {
        release();
        await running;
      }
      const completedStatus = await storage.readMaintenanceStatus();
      let releasePreview!: () => void;
      const previewReady = new Promise<void>((resolve) => { releasePreview = resolve; });
      const pendingPreview = memory.previewMaintenance({ useLlm: false }, {
        findSimilarPairs: async () => { await previewReady; return ({ examined: 0, pairs: [] }); }
      });
      try {
        assert.equal((await memory.previewMaintenance()).skipped, "A real sleep cycle is currently running; preview deferred.");
        await assert.rejects(memory.runMemoryMaintenance(), /Sleep already in progress/);
        assert.equal(memory.cancelMaintenance(), true);
      } finally {
        releasePreview();
      }
      assert.equal((await pendingPreview).skipped, "Cancelled by user");
      assert.equal(memory.cancelMaintenance(), false);
      assert.deepEqual(await storage.readMaintenanceStatus(), completedStatus);
      const preview = await memory.previewMaintenance({}, {
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
      });
      assert.deepEqual(preview.archiveProposed, [{ id: first.entry.id, content: first.entry.content, reason: "llm_merge", mergedInto: "preview-1" }]);
      assert.equal(preview.synthesisProposed?.length, 1);
      assert.deepEqual(preview.synthesisProposed?.[0]?.sourceIds, [first.entry.id]);
      const promptPrefix = "Cluster of related memories:\n";
      assert.ok(prompts[0]?.startsWith(promptPrefix));
      assert.deepEqual(prompts[0]!.slice(promptPrefix.length).split("\n").sort(), [first.entry, second.entry].map((entry) =>
        `- id: "${entry.id}", content: "${entry.content}" [Memory saved-at: ${entry.createdAt}; original message time/timezone unknown; saved-at is NOT event/due/completion time.]`
      ).sort());
      const deterministic = await memory.previewMaintenance({ useLlm: false }, {
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.98 }] })
      });
      assert.equal(deterministic.archiveProposed?.length, 1);
      assert.equal(deterministic.archiveProposed?.[0]?.reason, "similarity_merge");
      assert.deepEqual(await storage.listEntries({ includeArchived: true }), before);
      assert.deepEqual(await storage.readMaintenanceStatus(), completedStatus);
    } finally {
      storage.close();
      memory.close();
    }
  });
}

async function testSleepSynthesisArchivesCluster(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const model = jsonMemoryModel(() => JSON.stringify({
      delete: [],
      synthesize: [{
        content: "The synthesized memory preserves both source facts and is now the single active representation.",
        durability: "permanent"
      }]
    }));
    const memory = new LocalMemory(workspaceRoot, () => model);

    const first = await memory.writeEntry({ ...projectEntry("The first source fact is part of the synthesized memory cluster."), durability: "temporary", accessCount: 7, importance: 5, tags: ["first", "shared"], threadId: "T_A", messageId: "M_A", originAnchors: [{ messageId: "M_A", sentAt: "2026-09-10T02:00:00.000Z", timeZone: "unknown" }] });

    const second = await memory.writeEntry({ ...projectEntry("The second source fact is part of the synthesized memory cluster."), accessCount: 3, importance: 1, tags: ["shared", "second"], threadId: "T_B", messageId: "M_B", originAnchors: [
      { messageId: "M_A", sentAt: "2026-09-10T02:00:00.000Z", timeZone: "unknown" },
      { messageId: "M_B", sentAt: "2026-09-11T03:00:00.000Z", timeZone: "Asia/Shanghai" }
    ] });

    assert.ok(first.entry && second.entry);
    const preparation = { calls: 0, commits: 0 };
    for (const unavailable of [true, false]) {
      const result = await memory.runMemoryMaintenance({}, {
        prepareSynthesis: async () => {
          if (unavailable) return undefined;
          throw new Error("Embedding generation failed");
        },
        indexEntry: async () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
      });
      assert.equal(result.written, 0);
      assert.equal((await memory.listArchivedEntries()).entries.length, 0);
      assert.equal(result.failed, 0);
      assert.equal((await memory.listMemoryEntries()).entries.length, 2);
    }
    await memory.runMemoryMaintenance({}, {
      prepareSynthesis: async (content) => {
        preparation.calls += 1;
        assert.equal((await memory.listMemoryEntries()).entries.length, 2);
        return (entry) => {
          preparation.commits += 1;
          assert.equal(entry.content, content);
        };
      },
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
    });

    const active = (await memory.listMemoryEntries()).entries;
    assert.equal(active.length, 3);
    assert.deepEqual(preparation, { calls: 1, commits: 1 });
    const synthesis = active.find((entry) => entry.tags.includes("sleep-merged"));
    assert.ok(synthesis);
    assert.equal(synthesis.source, "auto");
    assert.equal(synthesis.accessCount, 7);
    assert.equal(synthesis.importance, 1, "synthesis 继承按 Sleep 排名选中的 survivor importance");
    assert.equal(synthesis.threadId, "T_B");
    assert.equal(synthesis.messageId, "M_B");
    assert.deepEqual(synthesis.tags, ["sleep-merged", "first", "shared", "second"]);
    assert.deepEqual(synthesis.originAnchors, [
      { messageId: "M_A", sentAt: "2026-09-10T02:00:00.000Z", timeZone: "unknown" },
      { messageId: "M_B", sentAt: "2026-09-11T03:00:00.000Z", timeZone: "Asia/Shanghai" }
    ]);
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.length, 0, "synthesis without delete keeps the old cluster active");
    const database = new DatabaseSync(path.join(agentRoot, AGENT_DATABASE_FILE), { readOnly: true });
    try {
      const row = database.prepare("SELECT metadata FROM memories WHERE id = ?").get(synthesis.id) as { metadata?: string } | undefined;
      assert.match(row?.metadata ?? "", /"source":"auto"/u);
      assert.equal(JSON.parse(row!.metadata!).importance, 1);
    } finally {
      database.close();
    }
    memory.close();
  });
}

async function testSleepIgnoresUnrequestedSynthesisExpiry(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    // Given: 模型在合成提议里越过协议额外返回过期时间。
    const memory = new LocalMemory(workspaceRoot, () => jsonMemoryModel(() => JSON.stringify({
      delete: [],
      synthesize: [{
        content: "A temporary synthesis of the two ongoing planning facts.",
        durability: "temporary",
        expiresAt: "2000-01-01T00:00:00.000Z"
      }]
    })));
    try {
      const first = await memory.writeEntry(projectEntry("The ongoing planning work has a first stable detail."));
      const second = await memory.writeEntry(projectEntry("The ongoing planning work has a second related detail."));
      assert.ok(first.entry && second.entry);
      const now = new Date("2026-09-26T12:00:00.000Z");
      await memory.runMemoryMaintenance({ now, temporaryTtl: 3650 }, {
        prepareSynthesis: async () => () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [{
          leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8
        }] })
      });
      const synthesis = (await memory.listMemoryEntries()).entries.find((entry) => entry.tags.includes("sleep-merged"));
      assert.ok(synthesis);
      assert.equal(synthesis.durability, "temporary");
      assert.equal(synthesis.expiresAt, undefined, "Sleep must ignore model fields outside its synthesis contract");

      // When: 下一轮 Sleep 检查临时事实；Then: 不因模型多给的旧时间立即归档。
      await memory.runMemoryMaintenance({ now: new Date(now.getTime() + 60_000), temporaryTtl: 3650, useLlm: false });
      assert.ok((await memory.getEntry(synthesis.id))?.archivedAt === undefined);
    } finally {
      memory.close();
    }
  });
}

async function testSleepSynthesisFailureKeepsSources(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    let ids: string[] = [];
    const model = jsonMemoryModel(() => JSON.stringify({
      delete: ids,
      synthesize: [{
        content: "This synthesis cannot be inserted when its embedding generation fails.",
        durability: "permanent"
      }]
    }));
    const memory = new LocalMemory(workspaceRoot, () => model);
    try {
      const first = await memory.writeEntry(projectEntry(
        "The first source fact belongs to a cluster whose synthesis will fail."
      ));
      const second = await memory.writeEntry(projectEntry(
        "The second source fact belongs to a cluster whose synthesis will fail."
      ));
      assert.ok(first.entry && second.entry);
      ids = [first.entry.id, second.entry.id];

      const result = await memory.runMemoryMaintenance({}, {
        prepareSynthesis: async () => { throw new Error("embedding generation failed"); },
        indexEntry: async () => undefined,
        findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
      });
      assert.equal(result.failed, 0);
      assert.equal(result.written, 0);
      assert.equal(result.processed, 0);
      assert.deepEqual(new Set((await memory.listMemoryEntries()).entries.map((entry) => entry.id)), new Set(ids));
      const archived = await memory.listArchivedEntries();
      assert.equal(archived.entries.length, 0);
      // 合成失败仍须留下审计计数，来源条目继续参加正常召回。
      const lastRun = memory.maintenanceStatus().lastRun;
      assert.equal(lastRun?.synthesisFailed, 1, "一条合成提议失败必须被计数");
      assert.equal(lastRun?.archivedLlm, 0);
      assert.equal(lastRun?.llm, 0);
    } finally {
      memory.close();
    }
  });
}

async function testSleepInvalidDeleteIsSafe(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const model = jsonMemoryModel((prompt) => {
      const ids = memoryClusterIds(prompt);
      return JSON.stringify({ delete: ["not-a-cluster-entry", ids[0]], synthesize: [] });
    });
    const memory = new LocalMemory(workspaceRoot, () => model);
    const first = await memory.writeEntry(projectEntry("The first source fact must remain after an invalid model response."));
    const second = await memory.writeEntry(projectEntry("The second source fact must remain after an invalid model response."));
    assert.ok(first.entry && second.entry);
    const result = await memory.runMemoryMaintenance({}, {
      indexEntry: async () => undefined,
      requestRebuild: () => undefined,
      findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
    });
    assert.equal(result.failed, 0);
    assert.equal((await memory.listMemoryEntries()).entries.length, 1);
    assert.equal((await memory.listArchivedEntries()).entries.length, 1);
    memory.close();
  });
}

async function testSingleRootSafetyBoundary(): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-agent-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-workspace-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-memory-outside-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  const linkedAgentRoot = path.join(agentRoot, "linked-agent");
  process.env[BINY_AGENT_DIR_ENV] = linkedAgentRoot;
  try {
    await fs.symlink(outside, linkedAgentRoot, "dir");
    await assert.rejects(new LocalMemory(workspaceRoot, unusedModel).writeEntry(projectEntry(
      "This entry must never be written through a symbolic Agent root."
    )), /real directory, not a symbolic link/u);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testEmbeddingStatusDoesNotCreateIndex(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memoryRoot = agentRoot;
    const databasePath = path.join(memoryRoot, AGENT_DATABASE_FILE);
    const service = new MemoryEmbeddingService({
      localMemory: new LocalMemory(workspaceRoot, unusedModel),
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("status must not open a writable vector index"); },
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(memoryRoot),
      getActiveModel: () => undefined,
      getProviderModels: () => [],
      getRuntime: async () => undefined
    });
    const status = await service.status();
    assert.equal(status.index.active, undefined);
    assert.equal(status.pendingEntries, 0);
    await assert.rejects(fs.access(databasePath), /ENOENT/u, "读取状态不能创建空向量索引");
  });
}

async function testEmbeddingStatusReadsSelfReflectionMemory(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    await storage.writeEntry(projectEntry(
      "A self-reflection entry must remain readable by the embedding status path."
    ));
    const service = new MemoryEmbeddingService({
      localMemory: new LocalMemory(workspaceRoot, unusedModel),
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("status must not open a writable vector index"); },
      getReadOnlyVectorIndex: () => undefined,
      getActiveModel: () => undefined,
      getProviderModels: () => [],
      getRuntime: async () => undefined
    });
    const status = await service.status();
    assert.equal(status.totalEntries, 1);
    assert.equal(status.pendingEntries, 1);
  });
}

async function testSemanticSearchTreatsUnbuiltIndexAsEmptyCandidates(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const created = await memory.writeEntry(projectEntry(
      "An existing fact may temporarily have no vector while the semantic index is being built."
    ));
    assert.ok(created.entry);
    const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:unbuilt-index-test",
      displayName: "Unbuilt index test",
      dimensions: 3,
      recommendedThreshold: 0.8,
      source: "provider"
    };
    let embeddingCalls = 0;
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => {
        embeddingCalls += texts.length;
        return {
          embeddings: texts.map(() => new Float32Array([1, 0, 0])),
          dimensions: 3,
          fingerprint: descriptor.fingerprint,
          model: ref
        };
      }
    };
    const service = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => { throw new Error("an unbuilt read must not create a writable index"); },
      getReadOnlyVectorIndex: () => undefined,
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });
    const candidates = await service.findSimilarEntries(
      "find the existing semantic memory",
      [created.entry],
      5,
      0.3
    );
    assert.deepEqual(candidates, []);
    assert.deepEqual(await service.findSimilarPairs([created.entry], 0.75), { examined: 0, pairs: [] });
    assert.equal(embeddingCalls, 1, "the query still needs a semantic embedding before treating the index as empty");
    memory.close();
  });
}

async function testFactsAndVectorsShareDatabase(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const storage = new MemoryStorage(workspaceRoot);
    const written = await storage.writeEntry(projectEntry(
      "Facts and their embedding projection must live in the same memory SQLite database."
    ));
    assert.ok(written.entry);

    const memoryRoot = agentRoot;
    const databasePath = path.join(memoryRoot, AGENT_DATABASE_FILE);
    assert.equal(
      MemoryVectorIndex.openReadOnly(memoryRoot),
      undefined,
      "事实库已存在但向量表尚未初始化时，只读索引应按未建立处理"
    );
    const index = new MemoryVectorIndex(memoryRoot);
    assert.equal(index.databasePath, databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = new Set((database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).all() as Array<{ name?: unknown }>).map((row) => row.name));
      assert.equal(tables.has("memories"), true);
      assert.equal(tables.has("memory_archive"), true);
      assert.equal(tables.has("memory_embeddings"), true);
      assert.equal(tables.has("memory_vectors"), false);
      assert.equal(tables.has("memory_vector_generations"), false);
      assert.equal(tables.has("memory_vector_entry_states"), false);
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count?: unknown }).count,
        1
      );
    } finally {
      database.close();
      index.close();
    }
    await assert.rejects(
      fs.access(path.join(memoryRoot, ".memory-index.sqlite")),
      /ENOENT/u,
      "不应再创建独立的向量 SQLite 文件"
    );
  });
}

async function testInitialEmbeddingGeneration(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const created = await memory.writeEntry(projectEntry(
      "The first memory must be searchable immediately after its embedding is written."
    ));
    assert.ok(created.entry);

    const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:initial-generation-test",
      displayName: "Initial generation test",
      dimensions: 3,
      recommendedThreshold: 0.8,
      source: "provider"
    };
    let vector = new Float32Array([1, 0, 0]);
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => ({
        embeddings: texts.map(() => vector),
        dimensions: 3,
        fingerprint: descriptor.fingerprint,
        model: ref
      })
    };
    const service = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => new MemoryVectorIndex(agentRoot),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(agentRoot),
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });

    await service.indexEntry(created.entry);
    const status = await service.status();
    assert.equal(status.index.active?.modelFingerprint, descriptor.fingerprint);
    assert.equal(status.indexedEntries, 1);
    assert.equal(status.pendingEntries, 0);
    const matches = await service.findSimilarEntries("Find the first stored fact", [created.entry], 5, 0.3);
    assert.equal(matches?.length, 1);
    assert.equal(matches?.[0]?.accessCount, 0, "search returns the pre-access snapshot");
    const readVectorRevision = (): number | undefined => {
      const database = new DatabaseSync(path.join(agentRoot, AGENT_DATABASE_FILE), { readOnly: true });
      try {
        const row = database.prepare("SELECT revision FROM memory_embedding_versions WHERE memory_id = ?")
          .get(created.entry!.id) as { revision?: number } | undefined;
        return row?.revision;
      } finally {
        database.close();
      }
    };
    const vectorRevision = readVectorRevision();
    assert.equal(vectorRevision, created.entry.revision);
    await memory.recordRecallUsage([created.entry.id]);
    const accessed = (await memory.listMemoryEntries()).entries[0]!;
    assert.equal(accessed.accessCount, 1);
    assert.ok(accessed.lastAccessedAt);
    assert.equal(accessed.updatedAt, accessed.lastAccessedAt, "搜索访问更新事实时间");
    assert.equal(accessed.revision, created.entry.revision);
    assert.equal(readVectorRevision(), vectorRevision, "访问统计不能改写向量对应的事实版本");
    assert.equal((await service.status()).pendingEntries, 0, "访问统计不能使向量投影失效");
    await service.findSimilarEntries("Find no candidates", [], 5, 0.3);
    assert.equal((await memory.listMemoryEntries()).entries[0]?.accessCount, 1);
    const save = await service.prepareSynthesis(created.entry.content);
    assert.ok(save);
    assert.throws(() => save({ ...created.entry!, content: "Changed content" }), /changed after embedding/u);
    save(created.entry);
    const controller = new AbortController();
    const cancelled = await service.prepareSynthesis(created.entry.content, controller.signal);
    assert.ok(cancelled);
    controller.abort(new Error("Cancelled after generation"));
    assert.throws(() => cancelled(created.entry!), /Cancelled after generation/u);
    await service.rebuild();
    assert.equal((await service.status()).indexedEntries, 1);
    assert.deepEqual(await service.findSimilarPairs([created.entry], 0.75), { examined: 1, pairs: [] });
    assert.deepEqual(await service.findSimilarPairs([{ ...created.entry, content: "Outdated vector content" }], 0.75), { examined: 1, pairs: [] });
    const second = await memory.writeEntry(projectEntry("A distinct topic with an orthogonal embedding."));
    assert.ok(second.entry);
    const entries = [created.entry, second.entry];
    assert.deepEqual(await service.findSimilarPairs(entries, 0.75), { examined: 1, pairs: [] });
    vector = new Float32Array([0, 1, 0]);
    await service.indexEntry(second.entry);
    assert.deepEqual(await service.findSimilarPairs(entries, 0.75), { examined: 2, pairs: [] });
    const sink = {
      indexEntry: async () => undefined,
      findSimilarPairs: service.findSimilarPairs.bind(service)
    };
    assert.equal((await memory.previewMaintenance({ useLlm: false }, sink)).examined, 2);
    await memory.runMemoryMaintenance({ useLlm: false }, sink);
    assert.equal((await memory.loadMaintenanceStatus()).lastRun?.examined, 2);
    await memory.runMemoryMaintenance({ useLlm: false });
    assert.equal((await memory.loadMaintenanceStatus()).lastRun?.examined, 0);

    for (let index = entries.length; index < 64; index += 1) {
      const result = await memory.writeEntry(projectEntry(`Independent scan fixture number ${index}.`));
      assert.ok(result.entry);

      entries.push(result.entry);
      await service.indexEntry(result.entry);
    }
    const beforeScan = await memory.listMemoryEntries();
    const scanAbort = new AbortController();
    const abortHandle = setImmediate(() => scanAbort.abort(new Error("Cancel during vector scan")));
    try {
      await assert.rejects(service.findSimilarPairs(entries, 0.75, scanAbort.signal), /Cancel during vector scan/u);
    } finally {
      clearImmediate(abortHandle);
    }
    assert.deepEqual(await memory.listMemoryEntries(), beforeScan);
    assert.equal((await service.findSimilarPairs(entries, 0.75)).examined, 64);
    service.close();
    memory.close();
  });
}

async function testSleepUsesCurrentStoredVectorsWhenRuntimeUnavailable(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const first = (await memory.writeEntry(projectEntry("The release checklist belongs to the project."))).entry!;
    const second = (await memory.writeEntry(projectEntry("The project release has a checklist."))).entry!;
    const ref = { kind: "provider", provider: "test", model: "sleep-cached" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref, fingerprint: "sha256:sleep-cached", displayName: "Sleep cached vectors",
      dimensions: 3, recommendedThreshold: 0.8, source: "provider"
    };
    let runtimeAvailable = true;
    let providerAvailable = true;
    let configuredRef: EmbeddingModelRef = ref;
    let configured = descriptor;
    const runtime: EmbeddingModelRuntime = {
      descriptor, fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => ({
        embeddings: texts.map(() => new Float32Array([1, 0, 0])),
        dimensions: 3, fingerprint: descriptor.fingerprint, model: ref
      })
    };
    const service = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => new MemoryVectorIndex(agentRoot),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(agentRoot),
      getActiveModel: () => selectMemoryEmbeddingModel(configuredRef, [{ ...configured, available: providerAvailable }]),
      getConfiguredModel: () => configuredRef,
      getProviderModels: () => [{ ...configured, available: providerAvailable }],
      getRuntime: async () => runtimeAvailable ? runtime : undefined
    });
    try {
      await service.rebuild();
      runtimeAvailable = false;
      providerAvailable = false;
      const entries = (await memory.listMemoryEntries()).entries;
      const cachedScan = await service.findSimilarPairs(entries, 0.95);
      assert.equal(cachedScan.examined, 2);
      assert.equal(cachedScan.pairs.length, 1);
      assert.deepEqual(new Set([cachedScan.pairs[0]!.leftId, cachedScan.pairs[0]!.rightId]),
        new Set([first.id, second.id]));
      assert.equal(cachedScan.pairs[0]!.similarity, 1);
      const preview = await memory.previewMaintenance({ useLlm: false }, service);
      assert.equal(preview.examined, 2);
      assert.equal(preview.archiveProposed?.some((item) => item.reason === "similarity_merge"), true);
      configuredRef = { kind: "auto" };
      assert.equal((await service.findSimilarPairs(entries, 0.95)).examined, 2,
        "Auto may reuse its known projection while every configured provider is unavailable");
      providerAvailable = true;
      configured = { ...descriptor, fingerprint: "sha256:new-auto-selection" };
      assert.deepEqual(await service.findSimilarPairs(entries, 0.95), { examined: 0, pairs: [] },
        "Auto must not reuse the old projection after selecting another vector space");
      configured = descriptor;
      providerAvailable = false;
      configuredRef = { kind: "provider", provider: "test", model: "another-model" };
      assert.deepEqual(await service.findSimilarPairs(entries, 0.95), { examined: 0, pairs: [] },
        "An explicit model switch cannot reuse the prior provider projection");
      configuredRef = ref;
      configured = { ...descriptor, fingerprint: "sha256:another-model" };
      assert.deepEqual(await service.findSimilarPairs(entries, 0.95), { examined: 0, pairs: [] },
        "A configured model change cannot reuse the old projection");
      configured = descriptor;
      await memory.updateEntry(second.id, { content: "The project release checklist was revised." });
      assert.deepEqual(await service.findSimilarPairs((await memory.listMemoryEntries()).entries, 0.95),
        { examined: 1, pairs: [] }, "A stale entry revision cannot reuse its prior vector");
    } finally {
      service.close();
      memory.close();
    }
  });
}

async function testMemoryVectorProjectionLifecycle(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot, agentRoot) => {
    const ref = { kind: "provider", provider: "test", model: "projection-lifecycle" } as const;
    const descriptor: EmbeddingModelDescriptor = {
      ref,
      fingerprint: "sha256:projection-lifecycle",
      displayName: "Projection lifecycle test",
      dimensions: 3,
      recommendedThreshold: 0.8,
      source: "provider"
    };
    const runtime: EmbeddingModelRuntime = {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async ({ texts }) => ({
        embeddings: texts.map(() => new Float32Array([1, 0, 0])),
        dimensions: 3,
        fingerprint: descriptor.fingerprint,
        model: ref
      })
    };
    const memoryRoot = agentRoot;
    const memory = new LocalMemory(
      workspaceRoot,
      unusedModel,
      undefined,
      3,
      undefined,
      undefined,
      {
        indexEntry: async (entry) => await service?.indexEntry(entry),
        removeEntries: (entryIds) => service?.removeEntries(entryIds)
      }
    );
    const service: MemoryEmbeddingService = new MemoryEmbeddingService({
      localMemory: memory,
      localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
      getVectorIndex: () => new MemoryVectorIndex(memoryRoot),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(memoryRoot),
      getActiveModel: () => ref,
      getProviderModels: () => [descriptor],
      getRuntime: async () => runtime
    });
    const database = (): DatabaseSync => {
      const opened = new DatabaseSync(path.join(memoryRoot, AGENT_DATABASE_FILE), { allowExtension: true });
      loadSqliteVec(opened);
      return opened;
    };
    const projectionCount = (): number => {
      const opened = database();
      try {
        return Number((opened.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get() as { count?: unknown }).count ?? 0);
      } finally {
        opened.close();
      }
    };

    try {
      const created = await memory.writeEntry(projectEntry(
        "The compatibility vector projection follows the active memory entry lifecycle."
      ));
      assert.ok(created.entry);
      assert.equal(projectionCount(), 1, "首次事实写入应建立 vec0 投影");

      const archived = await memory.archiveEntry(created.entry.id, true);
      assert.equal(archived.archived, true);
      assert.equal(projectionCount(), 0, "归档必须删除对应 vec0 向量");

      const restored = await memory.archiveEntry(archived.entry!.id, false);
      assert.equal(restored.archived, false);
      assert.equal(projectionCount(), 1, "恢复必须重新建立 vec0 向量");

      const deleted = await memory.deleteEntryById(restored.entry!.id);
      assert.equal(deleted.deleted, true);
      assert.equal(projectionCount(), 0, "删除必须删除对应 vec0 向量");

      const second = await memory.writeEntry(projectEntry(
        "Clearing facts also clears their compatibility vector rows."
      ));
      assert.ok(second.entry);
      assert.equal(projectionCount(), 1);
      const cleared = await memory.clearAllEntries();
      assert.equal(cleared.deletedEntries, 1);
      assert.equal(projectionCount(), 0, "清空事实库不能留下孤立 vec0 向量");
    } finally {
      service.close();
      memory.close();
    }
  });
}

async function testLocalMemoryMutationKeepsIndexInSync(): Promise<void> {
  await withIsolatedMemory(async (workspaceRoot) => {
    const indexed: string[] = [];
    const removed: string[] = [];
    const memory = new LocalMemory(
      workspaceRoot,
      unusedModel,
      undefined,
      3,
      undefined,
      undefined,
      {
        indexEntry: async (entry) => { indexed.push(entry.id); },
        removeEntries: (entryIds) => { removed.push(...entryIds); }
      }
    );
    const created = await memory.writeEntry(projectEntry(
      "Every public memory mutation must keep its derived vector index synchronized."
    ));
    assert.ok(created.entry);
    assert.deepEqual(indexed, [created.entry.id]);

    const updated = await memory.updateEntry(created.entry.id, { content: "Updated mutation index sync keeps the derived vector synchronized." });
    assert.equal(updated.written, true);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id]);

    const archived = await memory.archiveEntry(created.entry.id, true);
    assert.equal(archived.archived, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id]);

    const archivedUpdate = await memory.updateEntry(archived.entry!.id, { content: "Edited archived mutation index sync must not rebuild active vectors." });
    assert.equal(archivedUpdate.written, true);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id]);
    assert.deepEqual(removed, [created.entry.id, created.entry.id], "编辑归档条目不能重新建立活动向量");

    const restored = await memory.archiveEntry(archivedUpdate.entry!.id, false);
    assert.equal(restored.archived, false);
    assert.ok(restored.entry);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id, restored.entry.id]);

    const deleted = await memory.deleteEntryById(restored.entry.id);
    assert.equal(deleted.deleted, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id]);

    const second = await memory.writeEntry(projectEntry(
      "Clearing the memory library must remove every entry from the derived vector index too."
    ));
    assert.ok(second.entry);
    assert.deepEqual(indexed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id]);
    const archivedSecond = await memory.archiveEntry(second.entry.id, true);
    assert.equal(archivedSecond.archived, true);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id]);
    const cleared = await memory.clearAllEntries();
    assert.equal(cleared.deletedEntries, 1);
    assert.deepEqual(removed, [created.entry.id, created.entry.id, restored.entry.id, second.entry.id, second.entry.id]);
  });
}

/** 扁平化后记忆只有 content 正文；标题/摘要等结构化字段不再存在。 */
function projectEntry(content: string): MemoryEntryInput {
  return { content };
}

function jsonMemoryModel(response: (prompt: string) => string, prompts: string[] = []): AgentModel {
  return {
    provider: "test",
    modelId: "memory-sleep-test",
    async stream(context, options) {
      const prompt = context.messages.flatMap((message) => (
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((content) => content.type === "text" ? [content.text] : [])
      )).join("\n");
      if (prompt.includes("Cluster of related memories:")) {
        assert.equal(context.systemPrompt, sleepMergePrompt);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
      }
      if (prompt.startsWith("Extract memories from this conversation:")) {
        assert.equal(context.systemPrompt, memoryExtractionPrompt + "\n\n" + memoryTimeAnchorInstruction);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
        assert.equal(prompt.includes("Existing memories:"), false);
      }
      if (prompt.startsWith("Current date and time:")) {
        assert.equal(context.systemPrompt, temporaryMemoryCleanupPrompt);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
      }
      if (prompt.startsWith("The user wants to delete memories about:")) {
        assert.equal(context.systemPrompt, undefined);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.role, "user");
        assert.equal(options?.maxOutputTokens, undefined);
      }
      if (prompt.startsWith('New memory to add: "')) {
        assert.equal(context.systemPrompt, undefined);
        assert.equal(context.messages.length, 1);
        assert.equal(options?.maxOutputTokens, undefined);
        assert.ok(prompt.includes("Prefer keeping the store clean:"));
        assert.ok(prompt.includes("1. [permanent]"));
      }
      prompts.push(prompt);
      const text = response(prompt);
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
}

function memoryClusterIds(prompt: string): string[] {
  const cluster = prompt.slice(prompt.lastIndexOf("Cluster of related memories:"));
  return [...cluster.matchAll(/^- id: "([^"]+)", content: /gmu)].map((match) => match[1]!).filter(Boolean);
}


function unusedModel(): AgentModel {
  return {
    provider: "test",
    modelId: "unused",
    async stream() {
      return (async function* () { /* storage-only tests do not call the model */ })();
    }
  };
}

async function withIsolatedMemory(run: (workspaceRoot: string, agentRoot: string) => Promise<void>): Promise<void> {
  await withSharedAgent(async (agentRoot) => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-workspace-"));
    try {
      await run(workspaceRoot, agentRoot);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

async function withSharedAgent(run: (agentRoot: string) => Promise<void>): Promise<void> {
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-agent-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await run(agentRoot);
  } finally {
    restoreAgentRoot(previous);
    await rm(agentRoot, { recursive: true, force: true });
  }
}

function restoreAgentRoot(previous: string | undefined): void {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
}

await main();
