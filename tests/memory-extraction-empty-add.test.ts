import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentModel } from "../src/agent/core/types.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import type { MemoryOperation } from "../src/agent/context/memoryExtraction.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const oldFact = "User prefers Go for backend development.";
const replacement = "User now prefers Rust for backend development.";
const temporaryFact = "User is preparing the current backend migration.";
const forget = { operation: "delete", content: "the previous backend preference", durability: "permanent" } as const;
const valid = { operation: "add", content: replacement, durability: "permanent" } as const;

for (const [label, content] of [["empty", ""], ["whitespace", " \t\n "]] as const) {
  await test(`${label} replacement ADD cannot permanently delete the original fact`, async () => {
    const f = await fixture();
    try {
      f.operations = [forget, { operation: "add", content, durability: "permanent" }];
      const changes = await f.extract();
      const active = await f.readActive();
      assert.ok(active.entries.some((entry) => entry.id === f.old.id && entry.content === oldFact),
        "an unusable replacement must keep the original persisted fact");
      assert.ok(active.entries.some((entry) => entry.id === f.temporary.id));
      assert.deepEqual(changes, { created: [], updated: [], deleted: [] });
      assert.deepEqual(f.requests, ["extract"], "failed ADD must gate deletion and temporary-cleanup models");
      assert.equal((await f.memory.listArchivedEntries()).total, 0);
    } finally { await f.close(); }
  });
}

await test("a blank ADD also protects temporary facts when no explicit DELETE is present", async () => {
  const f = await fixture();
  try {
    f.operations = [{ operation: "add", content: " \n\t ", durability: "temporary" }];
    const changes = await f.extract();
    assert.ok((await f.readActive()).entries.some((entry) => entry.id === f.temporary.id),
      "temporary cleanup cannot delete a fact after replacement validation failed");
    assert.deepEqual(changes, { created: [], updated: [], deleted: [] });
    assert.deepEqual(f.requests, ["extract"]);
  } finally { await f.close(); }
});

for (const blankFirst of [false, true]) {
  await test(`valid ADD still commits with a ${blankFirst ? "preceding" : "following"} blank ADD, while deletions stay gated`, async () => {
    const f = await fixture();
    try {
      const blank: MemoryOperation = { operation: "add", content: " \t ", durability: "permanent" };
      f.operations = [forget, ...(blankFirst ? [blank, valid] : [valid, blank])];
      const changes = await f.extract();
      const active = (await f.readActive()).entries;
      assert.ok(active.some((entry) => entry.id === f.old.id), "the invalid member must keep the deletion source");
      assert.ok(active.some((entry) => entry.id === f.temporary.id), "the invalid member must gate temporary cleanup");
      assert.equal(changes.created.length, 1);
      assert.equal(changes.created[0]?.content, replacement);
      assert.ok(active.some((entry) => entry.id === changes.created[0]?.id && entry.content === replacement));
      assert.deepEqual(changes.updated, []);
      assert.deepEqual(changes.deleted, []);
      assert.deepEqual(f.requests, ["extract", "reconcile"]);
      assert.equal(active.length, 3);
    } finally { await f.close(); }
  });
}

await test("a valid replacement ADD preserves the existing deletion and cleanup behavior", async () => {
  const f = await fixture();
  try {
    f.operations = [forget, valid];
    const changes = await f.extract();
    const active = (await f.readActive()).entries;
    assert.equal(changes.created.length, 1);
    assert.equal(changes.created[0]?.content, replacement);
    assert.deepEqual(active.map((entry) => entry.id), [changes.created[0]!.id]);
    assert.equal(active[0]?.content, replacement);
    assert.deepEqual(new Set(changes.deleted.map((entry) => entry.id)), new Set([f.old.id, f.temporary.id]));
    assert.deepEqual(changes.updated, []);
    assert.deepEqual(f.requests, ["extract", "reconcile", "delete", "cleanup"]);
  } finally { await f.close(); }
});

await test("DELETE-only extraction remains able to forget a fact and clean temporary context", async () => {
  const f = await fixture();
  try {
    f.operations = [forget];
    const changes = await f.extract();
    assert.equal((await f.readActive()).total, 0);
    assert.deepEqual(changes.created, []);
    assert.deepEqual(changes.updated, []);
    assert.deepEqual(new Set(changes.deleted.map((entry) => entry.id)), new Set([f.old.id, f.temporary.id]));
    assert.deepEqual(f.requests, ["extract", "delete", "cleanup"]);
  } finally { await f.close(); }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-empty-add-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const state = { operations: [] as MemoryOperation[], requests: [] as string[], temporaryId: "" };
  const model: AgentModel = {
    provider: "test",
    modelId: "empty-add-regression",
    async stream(context, options) {
      const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      let text: string;
      if (prompt.startsWith("Extract memories from this conversation:")) {
        state.requests.push("extract");
        text = JSON.stringify(state.operations);
      } else if (prompt.startsWith("Reconcile proposed memory:")) {
        state.requests.push("reconcile");
        text = JSON.stringify({ operation: "ADD" });
      } else if (prompt.startsWith("The user wants to delete memories about:")) {
        state.requests.push("delete");
        const candidate = prompt.split("\n").find((line) => /^\d+\./u.test(line) && line.endsWith(oldFact));
        assert.ok(candidate, "the real semantic path must supply the original deletion candidate");
        text = JSON.stringify([Number(candidate.match(/^\d+/u)![0])]);
      } else {
        assert.ok(prompt.startsWith("Current date and time:"), "unexpected model stage");
        state.requests.push("cleanup");
        assert.ok(prompt.includes(state.temporaryId), "cleanup must receive the stored temporary fact");
        text = JSON.stringify([state.temporaryId]);
      }
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  const ref = { kind: "provider", provider: "test", model: "embedding" } as const;
  const runtime: EmbeddingModelRuntime = {
    descriptor: {
      ref, fingerprint: "empty-add-regression", displayName: "fixture",
      dimensions: 2, recommendedThreshold: 0.3, source: "provider"
    },
    fingerprint: "empty-add-regression",
    async embed({ texts, signal }) {
      signal?.throwIfAborted();
      return {
        embeddings: texts.map(() => new Float32Array([1, 0])),
        dimensions: 2, fingerprint: "empty-add-regression", model: ref
      };
    }
  };
  const memory: LocalMemory = new LocalMemory(root, () => model, undefined, 5, undefined, undefined,
    { indexEntry: async (entry) => await embedding.indexEntry(entry),
      removeEntries: (ids) => embedding.removeEntries(ids) },
    async (query, options) => await embedding.findSimilarEntries(query,
      (await memory.listMemoryEntries()).entries.filter((entry) => entry.userId === (options.userId ?? undefined)),
      options.limit, options.minimumSimilarity, options.signal));
  const embedding: MemoryEmbeddingService = new MemoryEmbeddingService({
    localMemory: memory,
    localManager: new LocalEmbeddingManager(path.join(root, "models")),
    getVectorIndex: () => new MemoryVectorIndex(root),
    getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
    getActiveModel: () => ref,
    getProviderModels: () => [runtime.descriptor],
    getRuntime: async () => runtime
  });
  const close = async (): Promise<void> => {
    try {
      try { embedding.close(); } finally { memory.close(); }
    } finally {
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    const old = (await memory.writeEntry({ content: oldFact })).entry!;
    const temporary = (await memory.writeEntry({ content: temporaryFact, durability: "temporary" })).entry!;
    state.temporaryId = temporary.id;
    return Object.assign(state, {
      root, memory, old, temporary, close,
      extract: () => memory.summarizeAndStoreMemories([
        { role: "user", content: "My backend preference changed from Go to Rust, and the previous migration is finished." },
        { role: "assistant", content: "Understood." }
      ], { sessionId: "empty-add-session", turnId: "turn", runId: "run",
        externalContext: false, excludeExternalContext: true }),
      readActive: async () => {
        const reader = new MemoryStorage(root, { agentDir: root });
        try { return await reader.listEntries(); } finally { reader.close(); }
      }
    });
  } catch (error) {
    await close();
    throw error;
  }
}
