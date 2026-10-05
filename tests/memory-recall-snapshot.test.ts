/** Live vector hits must not be joined to changed or removed fact snapshots. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { HybridMemoryRetriever, type AutomaticMemoryStore } from "../src/agent/context/HybridMemoryRetriever.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import type { MemoryEntryPatch } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

for (const automatic of [false, true]) {
  for (const patch of [
    { content: "The release is on Friday." }, { userId: "bob" },
    { tags: ["Other"] }, { threadId: "thread-b" }
  ] satisfies MemoryEntryPatch[]) await testChangedCandidate(automatic, patch);
}
await testChangedCandidate(false, { content: "The release is on Friday." }, true);
await testChangedCandidate(false, { content: "Friday release" }, false, 1);
await testChangedCandidate(false, { content: "Friday release" }, false, 2, 0);
for (const outcome of ["archived", "deleted"] as const) await testRemovedAfterSearch(outcome);
await testUnrelatedAndUsageWrites();
await testCallerLimits();
await testEmptyStore();
for (const fallback of [false, true]) await testRevalidationCancellation(fallback);
console.log("memory recall snapshot tests passed");

async function testChangedCandidate(automatic: boolean, patch: MemoryEntryPatch, fallback = false, limit = 2, maxChars?: number): Promise<void> {
  const f = await createFixture(fallback);
  let pending: ReturnType<HybridMemoryRetriever["retrieve"]> | undefined;
  try {
    const stableScore = f.index.search([1, 0], { modelFingerprint: "snapshot-fixture", limit: 3 })
      .find(({ entryId }) => entryId === f.stable.id)!.similarity;
    pending = f.retriever.retrieve("release date", [], {
      limit, maxChars, rewriteQuery: false, automatic, userId: "alice", tags: ["Work"], threadId: "thread-a",
      allowEntry: automatic ? (entry) => entry.userId === undefined : undefined
    });
    await bounded(f.started.promise);
    const updated = (await f.writer.updateEntry(f.target.id, patch)).entry!;
    assert.notEqual(updated.revision, f.target.revision);
    assert.equal(f.index.upsertActiveVectors("snapshot-fixture", 2, [
      { entryId: updated.id, revision: updated.revision, embedding: [1, 0] }
    ]), true);
    assert.equal(f.index.search([1, 0], { modelFingerprint: "snapshot-fixture", limit: 1 })[0]?.entryId, updated.id,
      "the live vector hit belongs to the updated fact");
    f.held.resolve();
    const result = await bounded(pending);
    assert.deepEqual(result.matches.map(({ entry }) => entry.id), limit === 1 || maxChars === 0 ? [] : [f.stable.id],
      "a changed fact must not be recalled using its pre-embedding text or scope metadata");
    if (result.matches.length) assert.equal(result.matches[0]?.score, stableScore, "the real vector score is preserved");
    assert.equal(result.matches.some(({ entry }) => entry.id === f.lower.id), false, "post-top-K revalidation must not refill slots");
    assert.equal((await f.writer.getEntry(f.target.id))?.accessCount, 0, "a skipped stale ID must not accrue usage on its newer fact");
    assert.equal((await f.writer.getEntry(f.stable.id))?.accessCount, limit === 1 ? 0 : 1);
    assert.deepEqual(f.usage, limit === 1 ? [] : [[f.stable.id]], "validated hits count before context budgeting");
    assert.equal(result.report.degraded, undefined);
    assert.equal(result.storeRevision, f.snapshotRevision, "retain the original fact snapshot contract");
    assert.equal(f.listReads, fallback ? 2 : 1, "production selected-ID reads avoid a second corpus scan");
    if (!fallback) assert.deepEqual(f.getReads.sort(), (limit === 1 ? [f.target.id] : [f.target.id, f.stable.id]).sort());
    if (maxChars === 0) {
      assert.deepEqual(result.report.omitted, [{ id: f.stable.id, reason: "budget" }]);
      assert.deepEqual(result.report.budgetOmission, { maxChars: 0, usedChars: 0, omitted: 1 });
    }
  } finally { f.held.resolve(); await pending; await f.close(); }
}

async function testRemovedAfterSearch(outcome: "archived" | "deleted"): Promise<void> {
  const f = await createFixture();
  let mutation: Promise<unknown> = Promise.resolve();
  try {
    f.held.resolve();
    // Let a separate writer settle after the real vector query and before selected-ID reads.
    const originalSearch = f.index.search.bind(f.index);
    f.index.search = (query, options) => {
      const hits = originalSearch(query, options);
      assert.equal(hits[0]?.entryId, f.target.id);
      mutation = outcome === "archived" ? f.writer.archiveEntry(f.target.id, true) : f.writer.deleteEntry(f.target.id);
      return hits;
    };
    const getEntry = f.memory.getEntry!;
    f.memory.getEntry = async (id, options) => { await mutation; return await getEntry(id, options); };
    const result = await f.retriever.retrieve("release date", [], { limit: 2, rewriteQuery: false });
    await mutation;
    assert.deepEqual(result.matches.map(({ entry }) => entry.id), [f.stable.id], outcome);
    assert.deepEqual(f.usage, [[f.stable.id]]);
    assert.equal(await f.writer.getEntry(f.target.id, { activeOnly: true }), undefined);
    if (outcome === "archived") assert.equal((await f.writer.listArchivedEntries()).entries[0]?.accessCount, 0);
  } finally { await mutation; await f.close(); }
}

async function testUnrelatedAndUsageWrites(): Promise<void> {
  const f = await createFixture();
  let pending: ReturnType<HybridMemoryRetriever["retrieve"]> | undefined;
  try {
    pending = f.retriever.retrieve("release date", [], { limit: 2, rewriteQuery: false });
    await bounded(f.started.promise);
    await f.writer.updateEntry(f.lower.id, { content: "Unrelated changed fact" });
    await f.writer.recordRecallUsage([f.target.id], { now: new Date("2030-01-01T00:00:00.000Z") });
    assert.equal((await f.writer.getEntry(f.target.id))?.revision, f.target.revision, "usage does not change the fact revision");
    assert.notEqual((await f.writer.getOverview()).storeRevision, f.snapshotRevision);
    f.held.resolve();
    const result = await bounded(pending);
    assert.deepEqual(result.matches.map(({ entry }) => entry.id), [f.target.id, f.stable.id],
      "unrelated facts and usage-only metadata do not invalidate unchanged selected facts");
    assert.equal(result.matches[0]?.score, 1);
    assert.equal((await f.writer.getEntry(f.target.id))?.accessCount, 2);
    assert.equal((await f.writer.getEntry(f.stable.id))?.accessCount, 1);
    assert.equal(f.listReads, 1);
  } finally { f.held.resolve(); await pending; await f.close(); }
}

async function testCallerLimits(): Promise<void> {
  const f = await createFixture();
  try {
    // Exercise the real public caller's defaulting logic without constructing unrelated services.
    const caller = { memoryRetriever: f.retriever, localMemory: { recallLimit: 3 } } as unknown as AgentSession;
    const empty = await AgentSession.prototype.searchMemory.call(caller, "release date", [], { limit: 0 });
    assert.deepEqual(empty.matches, []);
    assert.equal(f.embedCalls, 0);
    assert.deepEqual(f.getReads, []);
    assert.deepEqual(f.usage, []);
    f.held.resolve();
    const defaulted = await AgentSession.prototype.searchMemory.call(caller, "release date", [], { rewriteQuery: false });
    assert.deepEqual(defaulted.matches.map(({ entry }) => entry.id), [f.target.id, f.stable.id, f.lower.id]);
    assert.equal(f.searchLimits.at(-1), 3, "absent limits still use the configured public caller default");
    assert.equal(f.embedCalls, 1);
    const blank = await f.retriever.retrieve("  ", [], { limit: 3 });
    assert.deepEqual(blank.matches, []);
    assert.equal(blank.report.degraded, undefined);
    assert.equal(f.embedCalls, 1);
  } finally { await f.close(); }
}

async function testEmptyStore(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-recall-empty-"));
  const storage = new MemoryStorage(root, { agentDir: root });
  const unexpected = (): never => { throw new Error("Empty recall must not request models, indexes or usage writes"); };
  const retriever = new HybridMemoryRetriever({
    localMemory: { listMemoryEntries: (options) => storage.listEntries(options), getEntry: unexpected, recordRecallUsage: unexpected },
    getEmbeddingRuntime: unexpected, getReadOnlyVectorIndex: unexpected, getThreshold: unexpected
  });
  try { assert.deepEqual((await retriever.retrieve("release", [], { limit: 3 })).matches, []); }
  finally { retriever.close(); storage.close(); await rm(root, { recursive: true, force: true }); }
}

async function testRevalidationCancellation(fallback: boolean): Promise<void> {
  const f = await createFixture(fallback);
  const controller = new AbortController();
  const reason = new Error("Cancelled while revalidating selected facts");
  try {
    f.held.resolve();
    if (fallback) {
      const list = f.memory.listMemoryEntries;
      f.memory.listMemoryEntries = async (options) => {
        const result = await list(options);
        if (f.listReads === 2) controller.abort(reason);
        return result;
      };
    } else {
      const getEntry = f.memory.getEntry!;
      f.memory.getEntry = async (id, options) => {
        const entry = await getEntry(id, options);
        assert.equal(options?.signal, controller.signal);
        assert.equal(options?.activeOnly, true);
        controller.abort(reason);
        return entry;
      };
    }
    await assert.rejects(f.retriever.retrieve("release", [], { limit: 1, signal: controller.signal, rewriteQuery: false }),
      (error: unknown) => error === reason);
    assert.deepEqual(f.usage, [], "cancellation after fact reads wins before usage writes");
    assert.equal((await f.writer.getEntry(f.target.id))?.accessCount, 0);
  } finally { await f.close(); }
}

async function createFixture(fallback = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-recall-snapshot-"));
  const reader = new MemoryStorage(root, { agentDir: root });
  const writer = new MemoryStorage(root, { agentDir: root });
  const started = deferred<void>();
  const held = deferred<void>();
  const common = { tags: ["Work"], threadId: "thread-a" };
  const target = (await writer.writeEntry({ ...common, content: "The release is on Tuesday." })).entry!;
  const stable = (await writer.writeEntry({ ...common, content: "The release checklist is unchanged." })).entry!;
  const lower = (await writer.writeEntry({ ...common, content: "A lower-ranked release fact." })).entry!;
  const index = new MemoryVectorIndex(root);
  index.replaceAll("snapshot-fixture", 2, [
    { entryId: target.id, revision: target.revision, embedding: [1, 0] },
    { entryId: stable.id, revision: stable.revision, embedding: [0.8, 0.6] },
    { entryId: lower.id, revision: lower.revision, embedding: [0.6, 0.8] }
  ]);
  const state = { listReads: 0, getReads: [] as string[], embedCalls: 0, usage: [] as string[][], searchLimits: [] as Array<number | undefined> };
  const memory: AutomaticMemoryStore = {
    listMemoryEntries: (options) => { state.listReads++; return reader.listEntries(options); },
    getEntry: fallback ? undefined : (id, options) => { state.getReads.push(id); return reader.getEntry(id, options); },
    recordRecallUsage: (ids, options) => { state.usage.push(ids); return reader.recordRecallUsage(ids, options); }
  };
  const runtime: EmbeddingModelRuntime = {
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "snapshot-fixture",
      displayName: "snapshot fixture", dimensions: 2, recommendedThreshold: 0.3, source: "local"
    },
    fingerprint: "snapshot-fixture",
    embed: async () => {
      state.embedCalls++;
      started.resolve();
      await held.promise;
      return { embeddings: [new Float32Array([1, 0])], dimensions: 2, fingerprint: "snapshot-fixture",
        model: { kind: "local", model: "multilingual-e5-small" } };
    }
  };
  const retriever = new HybridMemoryRetriever({
    localMemory: memory, getEmbeddingRuntime: async () => runtime,
    getReadOnlyVectorIndex: () => ({ status: () => index.status(), search: (query, options) => {
      state.searchLimits.push(options.limit);
      return index.search(query, options);
    } }),
    getThreshold: () => 0.3
  });
  return {
    writer, index, retriever, memory, target, stable, lower, held, started,
    snapshotRevision: (await writer.getOverview()).storeRevision,
    usage: state.usage, getReads: state.getReads, searchLimits: state.searchLimits,
    get listReads() { return state.listReads; }, get embedCalls() { return state.embedCalls; },
    close: async () => { held.resolve(); retriever.close(); index.close(); reader.close(); writer.close(); await rm(root, { recursive: true, force: true }); }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Recall fixture did not settle within 5 seconds")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
