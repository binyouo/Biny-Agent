import { readyHostClient } from "./helpers/readyHostClient.js";
import { createHostTestStores } from "./helpers/hostStores.js";
import { testModel } from "./helpers/model.js";
/** Archive-row deletion must not invalidate the separately active version of the fact. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentModel } from "../src/agent/core/types.js";
import type { MemoryDeleteResult, MemoryEntry } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const oldFact = "The user prefers Go for backend work.";
const currentFact = "The user now prefers Rust for backend work.";
const unrelatedFact = "The user's unrelated project is named Sundial.";

await test("CLI deleting an updated archive preserves the active fact and its current recall", async () => {
  const f = await fixture();
  try {
    const { current, history, unrelated } = await seedUpdated(f);
    assert.deepEqual(await f.recallIds(), [current.id]);
    const before = (await f.memory.getEntry(current.id))!;
    const deleted = await f.deleteWithCli(history.id);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.entry?.id, history.id);
    assert.equal(deleted.entry?.originalId, current.id);
    assert.equal(await f.memory.getEntry(history.id), undefined);
    assert.deepEqual(await f.memory.getEntry(current.id), before,
      "deleting the prior-version row must not modify the current fact");
    assert.deepEqual(await f.recallIds(), [current.id],
      "deleting the prior-version row must preserve the current version's semantic recall");
    assert.deepEqual(f.vectorIds(), new Set([current.id, unrelated.id]));
    assert.equal((await f.embedding.status()).pendingEntries, 0);
    assert.equal((await f.deleteWithCli(history.id)).deleted, false);
    assert.deepEqual(await f.recallIds(), [current.id]);
  } finally { await f.close(); }
});

await test("deleting an older updated archive leaves later automatic reconciliation available", async () => {
  const f = await fixture();
  try {
    const { current, history } = await seedUpdated(f);
    const latestContent = "The user now prefers Rust and keeps using pnpm.";
    f.respond = () => JSON.stringify({ operation: "UPDATE", id: current.id, content: latestContent, durability: "permanent" });
    const later = await f.memory.writeAutoEntry({ content: latestContent }, { requireSemantic: true });
    assert.equal(later.updated, true);
    assert.equal((await f.memory.listArchivedEntries()).total, 2);
    const passages = f.passageCalls;
    await f.memory.deleteEntryById(history.id);
    assert.equal(f.passageCalls, passages, "history deletion must not re-embed facts");
    const remaining = (await f.memory.listArchivedEntries()).entries;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.content, currentFact);
    f.respond = () => JSON.stringify({ operation: "NONE", id: current.id });
    const retained = await f.memory.writeAutoEntry({ content: latestContent }, { requireSemantic: true });
    assert.equal(retained.deferred, undefined,
      "removing history cannot create an indexing gap that defers otherwise valid automatic contributions");
    assert.equal(retained.written, false);
    assert.equal(retained.entry?.id, current.id);
    assert.equal(retained.entry?.content, latestContent);
    assert.deepEqual(await f.recallIds(), [current.id]);
  } finally { await f.close(); }
});

await test("archive deletion preserves current recall after reopening storage and projection", async () => {
  const f = await fixture();
  try {
    const { current, history } = await seedUpdated(f);
    await f.deleteWithCli(history.id);
    const reopened = await f.shutdownAndReopen(current.id);
    assert.equal(reopened.entry?.content, currentFact);
    assert.equal(reopened.entry?.revision, current.revision);
    assert.deepEqual(reopened.matches.map(({ entry }) => entry.id), [current.id],
      "the preserved current projection must be readable through fresh connections");
  } finally { await f.close(); }
});

await test("deleting the active fact still removes its projection and updated history", async () => {
  const f = await fixture();
  try {
    const { current, history, unrelated } = await seedUpdated(f);
    const independent = (await f.memory.writeEntry({ content: "Independent archived fact." })).entry!;
    const archived = await f.memory.archiveEntry(independent.id, true);
    assert.ok(archived.entry);
    assert.equal((await f.deleteWithCli(current.id)).deleted, true);
    assert.equal(await f.memory.getEntry(current.id), undefined);
    assert.equal(await f.memory.getEntry(history.id), undefined);
    assert.equal((await f.memory.getEntry(archived.entry.id))?.content, independent.content);
    assert.deepEqual(await f.recallIds(), []);
    assert.deepEqual(f.vectorIds(), new Set([unrelated.id]));
    assert.equal((await f.embedding.status()).pendingEntries, 0);
  } finally { await f.close(); }
});

await test("deleting a normal archive or a missing id leaves unrelated current vectors alone", async () => {
  const f = await fixture();
  try {
    const active = (await f.memory.writeEntry({ content: currentFact })).entry!;
    const other = (await f.memory.writeEntry({ content: unrelatedFact })).entry!;
    const archived = await f.memory.archiveEntry(other.id, true);
    assert.ok(archived.entry);
    assert.deepEqual(f.vectorIds(), new Set([active.id]));
    assert.equal((await f.deleteWithCli(archived.entry.id)).deleted, true);
    assert.equal((await f.deleteWithCli("missing-memory-id")).deleted, false);
    assert.deepEqual(await f.recallIds(), [active.id]);
    assert.deepEqual(f.vectorIds(), new Set([active.id]));
    assert.equal((await f.memory.listArchivedEntries()).total, 0);
  } finally { await f.close(); }
});

async function seedUpdated(f: Awaited<ReturnType<typeof fixture>>): Promise<{
  current: MemoryEntry; history: MemoryEntry; unrelated: MemoryEntry;
}> {
  const old = (await f.memory.writeEntry({ content: oldFact, source: "manual" })).entry!;
  const unrelated = (await f.memory.writeEntry({ content: unrelatedFact, source: "manual" })).entry!;
  f.respond = () => JSON.stringify({ operation: "UPDATE", id: old.id, content: currentFact, durability: "permanent" });
  const updated = await f.memory.writeAutoEntry({ content: currentFact }, { requireSemantic: true });
  assert.equal(updated.updated, true);
  assert.ok(updated.entry);
  const history = (await f.memory.listArchivedEntries()).entries[0];
  assert.ok(history);
  assert.equal(history.archivedReason, "updated");
  assert.equal(history.originalId, old.id);
  assert.notEqual(history.id, old.id);
  assert.equal(updated.entry.id, old.id);
  return { current: updated.entry, history, unrelated };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-archive-delete-projection-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const agentDir = path.join(root, "agent");
  process.env.BINY_AGENT_DIR = agentDir;
  const allowedOrigins = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!allowedOrigins.has(url.origin)) throw new Error(`Unexpected network request: ${url.origin}`);
    return await originalFetch(input, init);
  };
  let memory: import("../src/agent/context/LocalMemory.js").LocalMemory | undefined;
  let embedding: import("../src/agent/context/MemoryEmbeddingService.js").MemoryEmbeddingService | undefined;
  let retriever: import("../src/agent/context/SemanticMemoryRetriever.js").SemanticMemoryRetriever | undefined;
  let host: Awaited<ReturnType<typeof import("../src/runtime/RuntimeHost.js").startRuntimeHost>> | undefined;
  let client: Awaited<ReturnType<typeof import("../src/runtime/RuntimeHost.js").connectRuntimeHost>> | undefined;
  const close = async (): Promise<void> => {
    try {
      try { await client?.close(); }
      finally { await host?.close(); }
    } finally {
      try {
        try { retriever?.close(); }
        finally {
          try { embedding?.close(); }
          finally { memory?.close(); }
        }
      } finally {
        console.log = originalLog;
        globalThis.fetch = originalFetch;
        if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
        else process.env.BINY_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  try {
    // Product modules load only after the per-case filesystem/network boundary is installed.
    const { LocalMemory } = await import("../src/agent/context/LocalMemory.js");
    const { MemoryEmbeddingService } = await import("../src/agent/context/MemoryEmbeddingService.js");
    const { MemoryVectorIndex } = await import("../src/agent/context/MemoryVectorIndex.js");
    const { SemanticMemoryRetriever } = await import("../src/agent/context/SemanticMemoryRetriever.js");
    const { LocalEmbeddingManager } = await import("../src/llm/embedding/LocalEmbeddingRuntime.js");
    const { connectRuntimeHost, startRuntimeHost } = await import("../src/runtime/RuntimeHost.js");
    const { memoryManageCommand } = await import("../src/cli/commands/localCapabilities.js");
    const state = { passageCalls: 0, respond: (): string => { throw new Error("Unexpected memory model call"); } };
    const model: AgentModel = testModel({
      provider: "test", modelId: "archive-delete",
      async stream(_context, options) {
        options?.signal?.throwIfAborted();
        const text = state.respond();
        return (async function* () {
          yield { type: "text-delta" as const, text };
          yield { type: "finish" as const, reason: "stop" as const };
        })();
      }
    });
    const ref = { kind: "provider", provider: "test", model: "archive-delete" } as const;
    const runtime: EmbeddingModelRuntime = {
      descriptor: { ref, fingerprint: "archive-delete", displayName: "fixture", dimensions: 2, recommendedThreshold: 0.8, source: "provider" },
      fingerprint: "archive-delete",
      async embed({ texts, inputType }) {
        if (inputType === "passage") state.passageCalls += 1;
        return { embeddings: texts.map((text) => new Float32Array(text === unrelatedFact || text === "Independent archived fact." ? [0, 1] : [1, 0])),
          dimensions: 2, fingerprint: "archive-delete", model: ref };
      }
    };
    const localMemory = new LocalMemory(root, () => model, undefined, 5, undefined, undefined, {
      indexEntry: async (entry) => await service.indexEntry(entry),
      removeEntries: (ids) => service.removeEntries(ids)
    }, async (query, options) => await service.findSimilarEntries(query,
      (await localMemory.listMemoryEntries()).entries.filter((entry) => entry.userId === (options.userId ?? undefined)),
      options.limit, options.minimumSimilarity, options.signal));
    memory = localMemory;
    const service = new MemoryEmbeddingService({
      localMemory, localManager: new LocalEmbeddingManager(path.join(root, "models")),
      getVectorIndex: () => new MemoryVectorIndex(agentDir),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(agentDir),
      getActiveModel: () => ref, getProviderModels: () => [runtime.descriptor], getRuntime: async () => runtime
    });
    embedding = service;
    const search = new SemanticMemoryRetriever({
      localMemory, getEmbeddingRuntime: async () => runtime,
      getReadOnlyVectorIndex: () => service.vectorIndex(), getThreshold: () => 0.8,
      closeVectorIndex: false
    });
    retriever = search;
    // The unrelated interactive-runtime boundary stays idle. Domain mutation, storage,
    // projection, CLI routing and authenticated Host transport are all real implementations.
    // Background repair is deliberately outside this immediate post-mutation contract.
    const commands = { ...await createHostTestStores(root), agent: {
      getLocalMemory: () => localMemory,
      getPersonalizationState: async () => ({ memory: { enabled: false, sleepEnabled: false } })
    } } as unknown as CommandRuntime;
    const interactive = {
      getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
        info: { sessionId: "archive-delete", sessionFile: path.join(root, "session.jsonl"), workspaceRoot: root } }),
      subscribe: () => () => undefined,
      runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
        await execute(new AbortController().signal),
      close: async () => undefined
    } as unknown as InteractiveRuntimeHandle;
    host = await startRuntimeHost(root, async () => ({ runtime: interactive, commands }), { workspaceRoot: root });
    client = await readyHostClient(await connectRuntimeHost(root, { clientId: "archive-delete", surface: "cli" }));
    assert.ok(client);
    assert.equal((await localMemory.listMemoryEntries()).total, 0, "each case starts with an empty isolated active store");
    assert.equal((await localMemory.listArchivedEntries()).total, 0, "each case starts with an empty isolated archive");
    const connected = client;
    return Object.assign(state, {
      memory: localMemory, embedding: service, close,
      vectorIds: () => new Set(service.vectorIndex().listActiveEmbeddings({ modelFingerprint: "archive-delete" }).map((entry) => entry.entryId)),
      recallIds: async () => (await search.retrieve("backend preference", [], { limit: 5, rewriteQuery: false })).matches.map(({ entry }) => entry.id),
      shutdownAndReopen: async (id: string) => {
        await connected.close();
        client = undefined;
        await host?.close();
        host = undefined;
        search.close();
        service.close();
        localMemory.close();
        const freshMemory = new LocalMemory(root, () => model);
        const freshSearch = new SemanticMemoryRetriever({
          localMemory: freshMemory, getEmbeddingRuntime: async () => runtime,
          getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(agentDir), getThreshold: () => 0.8
        });
        try {
          const entry = await freshMemory.getEntry(id);
          const result = await freshSearch.retrieve("backend preference", [], { limit: 5, rewriteQuery: false });
          return { entry, matches: result.matches };
        } finally {
          try { freshSearch.close(); }
          finally { freshMemory.close(); }
        }
      },
      deleteWithCli: async (id: string): Promise<MemoryDeleteResult> => {
        const output: string[] = [];
        const passages = state.passageCalls;
        console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
        try {
          await memoryManageCommand(root, "delete", id, { yes: true, json: true, noSpawn: true });
        } finally { console.log = originalLog; }
        assert.equal(state.passageCalls, passages, "CLI deletion must not repair its projection by rebuilding or re-embedding");
        assert.equal(output.length, 1);
        return JSON.parse(output[0]!) as MemoryDeleteResult;
      },

    });
  } catch (error) {
    await close();
    throw error;
  }
}
