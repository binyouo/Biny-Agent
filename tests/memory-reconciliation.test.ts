import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
const oldAnchor = { messageId: "old-message", sentAt: "2026-09-01T08:00:00.000Z", timeZone: "Asia/Shanghai" };
const newAnchor = { messageId: "new-message", sentAt: "2026-10-13T08:00:00.000Z", timeZone: "Asia/Shanghai" };

await test("new information creates a separate fact without rewriting the previous preference", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: oldFact, originAnchors: [oldAnchor], tags: ["development"] })).entry!;
    f.respond = () => JSON.stringify({ isDuplicate: false });
    const result = await f.memory.writeAutoEntry({ content: newFact, originAnchors: [newAnchor] }, { requireSemantic: true });
    assert.equal(result.written, true);
    assert.notEqual(result.entry?.id, old.id);
    assert.equal(result.entry?.content, newFact);
    assert.deepEqual(result.entry?.originAnchors, [newAnchor]);
    assert.equal((await f.memory.getEntry(old.id))?.content, oldFact);
    assert.equal((await f.memory.listArchivedEntries()).total, 0);
    const reopened = new LocalMemory(f.root, () => f.model);
    try {
      const result = await f.retriever(reopened).retrieve("backend preference", [], { limit: 5, rewriteQuery: false });
      assert.deepEqual(new Set(result.matches.map(({ entry }) => entry.content)), new Set([oldFact, newFact]));
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

await test("duplicate facts are skipped through the real vector candidate path", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
    f.respond = () => JSON.stringify({ isDuplicate: true, duplicateOf: 1 });
    const result = await f.memory.writeAutoEntry({ content: oldFact }, { requireSemantic: true });
    assert.equal(result.written, false);
    assert.equal(result.entry?.id, old.id);
    assert.equal((await f.memory.listMemoryEntries()).total, 1);
    assert.equal((await f.memory.listArchivedEntries()).total, 0);
  } finally { await f.close(); }
});

for (const isDuplicate of [true, false]) {
  for (const mutation of ["edit", "delete", "move"] as const) {
    await test(`duplicate judgment ${isDuplicate} rejects a stale candidate after ${mutation}`, async () => {
      const f = await fixture();
      const writer = new MemoryStorage(f.root);
      try {
        const old = (await f.memory.writeEntry({ content: oldFact })).entry!;
        f.respond = async () => {
          if (mutation === "delete") await writer.deleteEntry(old.id);
          else await writer.updateEntry(old.id, mutation === "move" ? { userId: "other-user" } : { content: "User prefers Python." });
          return JSON.stringify({ isDuplicate, duplicateOf: 1 });
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

await test("a real AgentSession persists a newly extracted fact independently from the previous preference", { timeout: 15_000 }, async () => {
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
      if (prompt.includes("New memory to add:")) return JSON.stringify({ isDuplicate: false });
      return "Understood.";
    };
    const result = await agent.runTask(newFact);
    assert.equal(result.status, "completed");
    await agent.close();
    agent = undefined;
    const events = await readSessionEvents(recorder.filePath);
    const handled = events.find((event) => event.type === "message_metadata" && event.metadata.memoryExtracted === true);
    assert.ok(handled?.type === "message_metadata");
    const created = handled.metadata.createdMemories as Array<{ id: string; content: string; type: string }>;
    assert.equal(created.length, 1);
    assert.notEqual(created[0]?.id, old.id);
    assert.deepEqual(created[0], { id: created[0]!.id, content: newFact, type: "created" });
    assert.equal(handled.metadata.updatedMemories, undefined);
    assert.equal((await f.memory.getEntry(old.id))?.content, oldFact);
    assert.equal((await f.memory.getEntry(created[0]!.id))?.content, newFact);
    assert.ok(requests >= 3, "initial indexing, candidate search and new-fact indexing use the real provider adapter");
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
    respond: (_prompt: string): string | Promise<string> => JSON.stringify({ isDuplicate: false }),
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
