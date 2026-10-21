import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { test } from "node:test";
import { AgentMemoryOwner } from "../src/runtime/memory/owner.js";
import { canonicalMemoryRoot, serveMemoryOwner } from "../src/runtime/memory/transport.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { SemanticMemoryRetriever } from "../src/agent/context/SemanticMemoryRetriever.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { AGENT_DATABASE_FILE } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readSessionEvents } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const oldFact = "User prefers Go for backend work and uses pnpm for frontend dependencies.";
const newFact = "User now prefers Rust instead of Go for backend work.";
const mergedFact = "User prefers Rust for backend work and uses pnpm for frontend dependencies.";
const oldAnchor = { messageId: "old-message", sentAt: "2026-09-01T08:00:00.000Z", timeZone: "Asia/Shanghai" };
const newAnchor = { messageId: "new-message", sentAt: "2026-10-13T08:00:00.000Z", timeZone: "Asia/Shanghai" };

await test("completed conversation updates one fact, preserves its history, and recalls the correction after reopening", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({
      content: oldFact, source: "manual", tags: ["development"], importance: 0.8,
      threadId: "old-thread", originAnchors: [oldAnchor], metadataExtra: { note: "retain" }
    })).entry!;
    f.respond = (prompt) => prompt.startsWith("Extract memories")
      ? JSON.stringify([{ operation: "add", content: newFact, durability: "permanent" }])
      : JSON.stringify({ operation: "UPDATE", id: old.id, content: mergedFact, durability: "permanent" });
    const changes = await f.memory.summarizeAndStoreMemories([
      { role: "user", content: newFact }, { role: "assistant", content: "Understood." }
    ], {
      sessionId: "new-thread", turnId: "turn", messageId: "new-message", runId: "run",
      externalContext: false, excludeExternalContext: true, originAnchors: [newAnchor]
    });
    assert.deepEqual(changes.created, [], "a correction is not another active fact");
    assert.deepEqual(changes.updated, [{ id: old.id, content: mergedFact }]);
    assert.deepEqual(changes.deleted, []);
    const current = (await f.memory.getEntry(old.id))!;
    assert.equal(current.content, mergedFact);
    assert.equal(current.createdAt, old.createdAt);
    assert.equal(current.importance, 0.8);
    assert.deepEqual(current.metadataExtra, { note: "retain" });
    assert.deepEqual(current.originAnchors, [oldAnchor, newAnchor]);
    assert.ok(current.tags.includes("development"));
    assert.equal(current.threadId, "new-thread");
    assert.ok(current.revision > old.revision);
    const archive = (await f.memory.listArchivedEntries()).entries;
    assert.equal(archive.length, 1);
    assert.equal(archive[0]?.content, oldFact);
    assert.equal(archive[0]?.archivedReason, "updated");
    assert.equal(archive[0]?.originalId, old.id);
    assert.equal(archive[0]?.mergedInto, old.id);
    assert.deepEqual(archive[0]?.originAnchors, [oldAnchor]);
    assert.deepEqual(await f.memory.resolveArchiveChains([archive[0]!.id]), {
      [archive[0]!.id]: { finalId: old.id, depth: 0 }
    }, "the current active version is the end of the archive chain");

    f.respond = () => JSON.stringify({ operation: "NONE", id: old.id });
    const repeated = await f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true });
    assert.equal(repeated.written, false);
    assert.equal(repeated.entry?.id, old.id);
    assert.equal((await f.memory.listMemoryEntries()).total, 1);
    assert.equal((await f.memory.listArchivedEntries()).total, 1);
    const reopened = new LocalMemory(f.root, () => f.model);
    try {
      const retriever = f.retriever(reopened);
      const result = await retriever.retrieve("backend preference", [], { limit: 5, rewriteQuery: false });
      assert.deepEqual(result.matches.map(({ entry }) => entry.content), [mergedFact]);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

await test("invalid reconciliation and provider failure defer automatic writes without inventing an ADD", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
    const responses = [
      "{invalid", JSON.stringify({ operation: "UPDATE", id: "unknown", content: mergedFact, durability: "permanent" }),
      JSON.stringify({ operation: "NONE", id: "unknown" }),
      JSON.stringify({ operation: "UPDATE", id: old.id, content: " ", durability: "permanent" }),
      JSON.stringify({ operation: "UPDATE", id: old.id, content: "x".repeat(2001), durability: "permanent" }),
      JSON.stringify({ operation: "UPDATE", id: old.id, content: mergedFact, durability: "invalid" }),
      JSON.stringify({ operation: "DELETE", id: old.id }),
      new Error("provider disconnected")
    ];
    for (const response of responses) {
      f.respond = () => { if (response instanceof Error) throw response; return response; };
      const result = await f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true });
      assert.equal(result.written, false);
      assert.equal(result.deferred, true);
      assert.equal((await f.memory.getEntry(old.id))?.content, oldFact);
      assert.equal((await f.memory.getOverview()).storeRevision, old.revision);
      assert.equal((await f.memory.listArchivedEntries()).total, 0);
    }
  } finally { await f.close(); }
});

for (const state of ["missing", "uninitialized", "empty", "different-model", "different-dimensions", "partial", "stale"] as const) {
  await test(`automatic writing defers when the index for existing facts is ${state}`, async () => {
    const f = await fixture();
    const writer = new MemoryStorage(f.root);
    try {
      const old = (await writer.writeEntry({ content: oldFact })).entry!;
      if (state !== "missing") {
        const index = f.embedding.vectorIndex();
        if (state !== "uninitialized") {
          const dimensions = state === "different-dimensions" ? 3 : 2;
          index.replaceAll(state === "different-model" ? "old-model" : "reconcile", dimensions, [{
            entryId: old.id, revision: old.revision, embedding: dimensions === 3 ? [1, 0, 0] : [1, 0]
          }]);
          if (state === "empty") index.removeEntries([old.id]);
          if (state === "partial") await writer.writeEntry({ content: "Another unindexed fact." });
          if (state === "stale") await writer.updateEntry(old.id, { content: "A corrected fact waiting for indexing." });
        }
      }
      const before = await writer.listEntries();
      const result = await f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true });
      assert.equal(result.written, false);
      assert.equal(result.deferred, true);
      assert.deepEqual(await writer.listEntries(), before);
      assert.equal((await f.memory.listArchivedEntries()).total, 0);
    } finally { writer.close(); await f.close(); }
  });
}

await test("unindexed facts in another user scope do not block an automatic correction", async () => {
  const f = await fixture();
  const writer = new MemoryStorage(f.root);
  try {
    const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
    await writer.writeEntry({ content: "Another user's unindexed fact.", userId: "another-user" });
    f.respond = () => JSON.stringify({ operation: "UPDATE", id: old.id, content: mergedFact, durability: "permanent" });
    const result = await f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true });
    assert.equal(result.written, true);
    assert.equal(result.updated, true);
    assert.equal(result.entry?.id, old.id);
  } finally { writer.close(); await f.close(); }
});

await test("a failed correction in an extraction batch cannot delete the original fact", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
    f.respond = (prompt) => {
      if (prompt.startsWith("Extract memories")) return JSON.stringify([
        { operation: "delete", content: "the Go preference" },
        { operation: "add", content: newFact, durability: "permanent" }
      ]);
      if (prompt.startsWith("The user wants to delete")) return "[1]";
      throw new Error("reconciliation unavailable");
    };
    const changes = await f.memory.summarizeAndStoreMemories([
      { role: "user", content: newFact }, { role: "assistant", content: "Understood." }
    ], { sessionId: "thread", turnId: "turn", runId: "run", externalContext: false, excludeExternalContext: true });
    assert.equal((await f.memory.getEntry(old.id))?.content, oldFact);
    assert.deepEqual(changes, { created: [], updated: [], deleted: [] });
  } finally { await f.close(); }
});

for (const operation of ["UPDATE", "NONE"] as const) {
  for (const mutation of ["edit", "delete", "move"] as const) {
    await test(`${operation} rejects a stale candidate after another writer performs ${mutation}`, async () => {
      const f = await fixture();
      const writer = new MemoryStorage(f.root);
      try {
        const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
        f.respond = async () => {
          if (mutation === "delete") await writer.deleteEntry(old.id);
          else await writer.updateEntry(old.id, mutation === "move" ? { userId: "other-user" } : { content: "User prefers Python." });
          return JSON.stringify(operation === "NONE" ? { operation, id: old.id }
            : { operation, id: old.id, content: mergedFact, durability: "permanent" });
        };
        const result = await f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true });
        assert.equal(result.written, false);
        assert.equal(result.deferred, true);
        const remaining = await writer.getEntry(old.id);
        if (mutation === "delete") assert.equal(remaining, undefined);
        else if (mutation === "move") assert.equal(remaining?.userId, "other-user");
        else assert.equal(remaining?.content, "User prefers Python.");
        assert.equal((await f.memory.listArchivedEntries()).total, 0);
      } finally { writer.close(); await f.close(); }
    });
  }
}

await test("automatic update and previous-version archive roll back together on a database failure", async () => {
  const f = await fixture();
  let database: DatabaseSync | undefined;
  try {
    const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
    database = new DatabaseSync(path.join(f.root, AGENT_DATABASE_FILE));
    database.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON memory_archive BEGIN SELECT RAISE(ABORT, 'archive failed'); END");
    f.respond = () => JSON.stringify({ operation: "UPDATE", id: old.id, content: mergedFact, durability: "permanent" });
    await assert.rejects(f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true }), /archive failed/u);
    assert.equal((await f.memory.getEntry(old.id))?.content, oldFact);
    assert.equal((await f.memory.getOverview()).storeRevision, old.revision);
    assert.equal((await f.memory.listArchivedEntries()).total, 0);
    const result = await f.retriever().retrieve("backend", [], { limit: 1 });
    assert.equal(result.matches[0]?.entry.content, oldFact);
  } finally { database?.close(); await f.close(); }
});

await test("failed indexing keeps the corrected SQLite fact and never recalls the old vector as current", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
    f.respond = () => JSON.stringify({ operation: "UPDATE", id: old.id, content: mergedFact, durability: "permanent" });
    f.failPassage = true;
    const result = await f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true });
    assert.equal(result.written, true);
    assert.equal((await f.memory.getEntry(old.id))?.content, mergedFact);
    assert.equal((await f.memory.listArchivedEntries()).entries[0]?.content, oldFact);
    assert.deepEqual((await f.retriever().retrieve("backend", [], { limit: 5 })).matches, []);
    assert.equal((await f.embedding.status()).pendingEntries, 1);
    f.failPassage = false;
    await f.embedding.indexEntry(result.entry!);
    assert.equal((await f.retriever().retrieve("backend", [], { limit: 5 })).matches[0]?.entry.content, mergedFact);
  } finally { await f.close(); }
});

await test("forgetting an updated fact deletes its saved previous versions without deleting unrelated archives", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
    const other = (await f.memory.writeEntry({ content: "Separate archived fact." })).entry!;
    await f.memory.archiveEntry(other.id, true);
    f.respond = () => JSON.stringify({ operation: "UPDATE", id: old.id, content: mergedFact, durability: "permanent" });
    await f.memory.writeAutoEntry({ content: newFact }, { requireSemantic: true });
    assert.equal((await f.memory.listArchivedEntries()).total, 2);
    await f.memory.deleteEntryById(old.id);
    assert.equal(await f.memory.getEntry(old.id), undefined);
    assert.deepEqual((await f.memory.listArchivedEntries()).entries.map((entry) => entry.content), [other.content]);
  } finally { await f.close(); }
});

await test("manual semantic search selects top-K within user, thread and tag scope using the real vector index", async () => {
  const f = await fixture();
  try {
    await f.memory.writeEntry({ content: "blocked user", userId: "bob", threadId: "one", tags: ["Work"] });
    await f.memory.writeEntry({ content: "blocked thread", userId: "alice", threadId: "two", tags: ["Work"] });
    await f.memory.writeEntry({ content: "blocked tag", userId: "alice", threadId: "one", tags: ["work"] });
    const own = (await f.memory.writeEntry({ content: "allowed own", userId: "alice", threadId: "one", tags: ["Work"] })).entry!;
    const shared = (await f.memory.writeEntry({ content: "allowed shared", threadId: "one", tags: ["Work"] })).entry!;
    const result = await f.retriever().retrieve("work", [], { limit: 2, userId: "alice", threadId: "one", tags: ["Work"] });
    assert.deepEqual(new Set(result.matches.map(({ entry }) => entry.id)), new Set([own.id, shared.id]));
    const all = (await f.memory.listMemoryEntries()).entries;
    assert.ok(all.filter((entry) => entry.content.startsWith("blocked")).every((entry) => entry.accessCount === 0));
    assert.ok(all.filter((entry) => entry.content.startsWith("allowed")).every((entry) => entry.accessCount === 1));
  } finally { await f.close(); }
});

await test("a real AgentSession persists automatic correction metadata and the revised fact", { timeout: 15_000 }, async () => {
  const f = await fixture();
  let agent: AgentSession | undefined;
  let memoryServer: Awaited<ReturnType<typeof serveMemoryOwner>> | undefined;
  let requests = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/embeddings");
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { input: string[]; model: string };
    assert.equal(payload.model, "test-embedding");
    assert.ok(payload.input.every((text) => typeof text === "string"));
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = structuredClone(defaultConfig);
    config.providers = { embed: {
      type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false,
      embeddingModels: [{ id: "test-embedding", displayName: "Test", dimensions: 2 }]
    } };
    config.context.memory.enabled = true;
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = true;
    config.context.memory.excludeExternalContext = true;
    config.context.memory.embeddingModel = { kind: "provider", provider: "embed", model: "test-embedding" };
    config.toolModel = undefined;
    await ensureAgentDirs(f.root);
    const owner = new AgentMemoryOwner(await canonicalMemoryRoot(f.root), { load: async () => config, save: async () => { throw new Error("Unexpected config write"); } });
    memoryServer = await serveMemoryOwner(await canonicalMemoryRoot(f.root), f.root, owner);
    const recorder = new SessionRecorder(f.root, "memory-reconcile-agent");
    agent = new AgentSession({
      workspaceRoot: f.root, config, model: f.model, recorder, toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" })
    });
    await agent.initialize();
    const old = (await agent.getLocalMemory().writeEntry({ content: oldFact })).entry!;
    f.respond = (prompt) => {
      if (prompt.startsWith("Extract memories")) return JSON.stringify([{ operation: "add", content: newFact, durability: "permanent" }]);
      if (prompt.startsWith("Reconcile proposed memory:")) return JSON.stringify({ operation: "UPDATE", id: old.id, content: mergedFact, durability: "permanent" });
      return "Understood.";
    };
    const result = await agent.runTask(newFact);
    assert.equal(result.status, "completed");
    await agent.close();
    agent = undefined;
    const events = await readSessionEvents(recorder.filePath);
    const handled = events.find((event) => event.type === "message_metadata" && event.metadata.memoryExtracted === true);
    assert.ok(handled?.type === "message_metadata");
    assert.deepEqual(handled.metadata.updatedMemories, [{ id: old.id, content: mergedFact, type: "updated" }]);
    assert.equal(handled.metadata.createdMemories, undefined);
    assert.equal((await f.memory.getEntry(old.id))?.content, mergedFact);
    assert.ok(requests >= 3, "initial indexing, candidate search and corrected indexing use the real provider adapter");
  } finally {
    await agent?.close();
    await memoryServer?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-reconcile-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const state = {
    respond: (_prompt: string): string | Promise<string> => JSON.stringify({ operation: "ADD" }),
    failPassage: false
  };
  const model: AgentModel = testModel({
    provider: "test", modelId: "reconcile-fixture",
    async stream(context, options) {
      const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      const text = await state.respond(prompt);
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  });
  const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
  const runtime: EmbeddingModelRuntime = {
    descriptor: { ref, fingerprint: "reconcile", displayName: "fixture", dimensions: 2, recommendedThreshold: 0.3, source: "provider" },
    fingerprint: "reconcile",
    async embed({ texts, inputType }) {
      if (state.failPassage && inputType === "passage") throw new Error("embedding failed");
      return {
        embeddings: texts.map((text) => new Float32Array(text.startsWith("allowed") ? [0.9, 0.1] : [1, 0])),
        dimensions: 2, fingerprint: "reconcile", model: ref
      };
    }
  };
  const memory = new LocalMemory(root, () => model, undefined, 5, undefined, undefined,
    { indexEntry: async (entry) => await embedding.indexEntry(entry) },
    async (query, options) => await embedding.findSimilarEntries(query,
      (await memory.listMemoryEntries()).entries.filter((entry) => entry.userId === (options.userId ?? undefined)),
      options.limit, options.minimumSimilarity, options.signal));
  const embedding = new MemoryEmbeddingService({
    localMemory: memory, localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
    getVectorIndex: () => new MemoryVectorIndex(root), getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
    getActiveModel: () => ref, getProviderModels: () => [runtime.descriptor], getRuntime: async () => runtime
  });
  return Object.assign(state, {
    root, model, memory, embedding,
    retriever: (store = memory) => new SemanticMemoryRetriever({
      localMemory: store, getEmbeddingRuntime: async () => runtime,
      getReadOnlyVectorIndex: () => embedding.vectorIndex(), getThreshold: () => 0.3,
      closeVectorIndex: false
    }),
    close: async () => {
      embedding.close(); memory.close();
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
