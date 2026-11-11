import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { temporaryMemoryCleanupPrompt } from "../src/agent/context/memoryExtraction.js";
import type { MemoryEntry, MemoryOriginAnchor, MemorySimilarSearchOptions } from "../src/agent/context/memoryTypes.js";
import type { AgentMessage, AgentModel } from "../src/agent/core/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

const now = new Date("2026-10-17T10:00:00.000Z");
const savedAt = new Date("2026-10-15T12:00:00.000Z");
const fact = "The user plans to review the ongoing project next Friday.";
const conversation: AgentMessage[] = [
  { role: "user", content: "Can we review the project plan tomorrow?" },
  { role: "assistant", content: "We can review the plan." }
];
const conversationText = "user: Can we review the project plan tomorrow?\n\nassistant: We can review the plan.";

for (const originAnchors of [undefined, [
  { messageId: "source", sentAt: "2026-09-20T10:30:00+08:00", timeZone: "Asia/Shanghai" }
]]) {
  await test(`temporary cleanup uses conversation text and saved-at without expanding ${originAnchors ? "known" : "unknown"} source metadata`, async () => {
    const f = await fixture();
    try {
      const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary", originAnchors }, { now: savedAt })).entry!;
      f.candidates.push(entry);
      const result = await f.summarize({ originAnchors });
      const request = onlyCleanupRequest(f);
      assert.ok(request.prompt.includes(`Current conversation context:\n${conversationText}`));
      assert.ok(request.prompt.includes(`- id: "${entry.id}", created: "`));
      assert.ok(request.prompt.includes(`content: "${fact}"`));
      assert.doesNotMatch(request.prompt, /source-message anchors:|Current conversation source:|Memory saved-at:/u);
      assert.equal(request.systemPrompt, temporaryMemoryCleanupPrompt);
      assert.deepEqual(result.deleted, []);
      const current = (await f.memory.getEntry(entry.id))!;
      assert.equal(current.content, entry.content);
      assert.equal(current.revision, entry.revision);
      assert.deepEqual(current.originAnchors, entry.originAnchors);
    } finally { await f.close(); }
  });
}

await test("cleanup preserves its original semantic query, user scope and candidate access counts", async () => {
  const f = await fixture();
  try {
    const own = (await f.memory.writeEntry({ content: fact, durability: "temporary", userId: "owner" })).entry!;
    const foreign = (await f.memory.writeEntry({ content: "Another person's temporary plan.", durability: "temporary", userId: "other" })).entry!;
    const permanent = (await f.memory.writeEntry({ content: "The user prefers written plans.", userId: "owner" })).entry!;
    f.candidates.push(own, foreign, permanent);
    const result = await f.summarize({ userId: "owner", originAnchors: [
      { messageId: "query-source", sentAt: "2026-10-16T21:00:00.000Z", timeZone: "unknown" }
    ] });
    const request = onlyCleanupRequest(f);
    assert.equal(f.searches.length, 1);
    assert.equal(f.searches[0]?.query, conversationText, "source metadata must not enter the semantic search query");
    assert.equal(f.searches[0]?.options.limit, 20);
    assert.equal(f.searches[0]?.options.minimumSimilarity, 0.3);
    assert.equal(f.searches[0]?.options.userId, "owner");
    assert.ok(request.prompt.includes(own.id));
    assert.ok(!request.prompt.includes(foreign.id));
    assert.ok(!request.prompt.includes(permanent.id));
    assert.equal((await f.memory.getEntry(own.id))?.accessCount, own.accessCount + 1);
    assert.equal((await f.memory.getEntry(foreign.id))?.accessCount, foreign.accessCount);
    assert.equal((await f.memory.getEntry(permanent.id))?.accessCount, permanent.accessCount + 1,
      "scope-filtered semantic hits are counted before the temporary-only model filter");
    assert.deepEqual(result, { created: [], deleted: [] });
  } finally { await f.close(); }
});

await test("cleanup cannot delete a candidate edited while its model decision is pending", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  let pending: ReturnType<typeof f.summarize> | undefined;
  try {
    const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary" })).entry!;
    f.candidates.push(entry);
    f.state.cleanupResponse = async () => {
      entered.resolve();
      await release.promise;
      return JSON.stringify([entry.id]);
    };
    pending = f.summarize();
    await bounded(entered.promise);
    const updated = await f.memory.updateEntry(entry.id, { content: "The project review is now planned for November." });
    assert.equal(updated.written, true);
    release.resolve();
    const result = await bounded(pending);
    onlyCleanupRequest(f);
    assert.deepEqual(result.deleted, []);
    const current = (await f.memory.getEntry(entry.id))!;
    assert.equal(current.content, updated.entry!.content);
    assert.equal(current.revision, updated.entry!.revision);
  } finally {
    release.resolve();
    await pending?.catch(() => undefined);
    await f.close();
  }
});

await test("cleanup also considers a temporary fact confirmed as a duplicate in this batch", async () => {
  const f = await fixture();
  try {
    const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary" })).entry!;
    f.candidates.push(entry);
    f.state.extractionResponse = JSON.stringify([{ operation: "add", content: fact, durability: "temporary" }]);
    f.state.reconciliationResponse = JSON.stringify({ isDuplicate: true, duplicateOf: 1 });
    const result = await f.summarize();
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Extract memories from this conversation:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.includes("New memory to add:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Current date and time:")).length, 1);
    assert.equal(f.searches.length, 2, "candidate search remains in place even when the model filter retains the only fact");
    assert.equal(f.searches[1]?.query, conversationText);
    assert.equal((await f.memory.getEntry(entry.id))?.content, fact);
    assert.equal((await f.memory.getEntry(entry.id))?.revision, entry.revision);
    assert.deepEqual(result, { created: [], deleted: [] });
  } finally { await f.close(); }
});

await test("a failed duplicate judgment does not suppress adding or temporary cleanup", async () => {
  const f = await fixture();
  try {
    const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary" })).entry!;
    f.candidates.push(entry);
    f.state.extractionResponse = JSON.stringify([{ operation: "add", content: "The ongoing project review has a revised plan.", durability: "temporary" }]);
    f.state.reconciliationResponse = "{invalid";
    const result = await f.summarize();
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Extract memories from this conversation:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.includes("New memory to add:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Current date and time:")).length, 1);
    assert.equal(f.searches.length, 2, "cleanup remains independent of duplicate-check failure");
    assert.equal((await f.memory.getEntry(entry.id))?.content, fact);
    assert.equal((await f.memory.getEntry(entry.id))?.revision, entry.revision);
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0]?.content, "The ongoing project review has a revised plan.");
    assert.deepEqual(result.deleted, []);
  } finally { await f.close(); }
});

interface CapturedRequest {
  prompt: string;
  systemPrompt: string | undefined;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cleanup-time-anchors-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = root;
  const requests: CapturedRequest[] = [];
  const searches: Array<{ query: string; options: MemorySimilarSearchOptions }> = [];
  const candidates: MemoryEntry[] = [];
  const state: {
    extractionResponse: string;
    reconciliationResponse: string;
    cleanupResponse: () => string | Promise<string>;
  } = {
    extractionResponse: '["NO_MEMORY"]',
    reconciliationResponse: JSON.stringify({ isDuplicate: false }),
    cleanupResponse: () => "[]"
  };
  const model: AgentModel = testModel({
    provider: "test", modelId: "cleanup-time-anchors-fixture",
    async stream(context, options) {
      const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      requests.push({ prompt, systemPrompt: context.systemPrompt });
      const text = prompt.startsWith("Extract memories from this conversation:") ? state.extractionResponse
        : prompt.includes("New memory to add:") ? state.reconciliationResponse
          : await state.cleanupResponse();
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  });
  const memory = new LocalMemory(root, () => model, undefined, 3, undefined, undefined, undefined,
    async (query, options) => { searches.push({ query, options }); return candidates; });
  return {
    memory, requests, searches, candidates, state,
    summarize: async (options: { originAnchors?: MemoryOriginAnchor[]; userId?: string } = {}) =>
      await memory.summarizeAndStoreMemories(conversation, {
        sessionId: "cleanup-session", turnId: "cleanup-turn", runId: "cleanup-run",
        now, ...options
      }),
    close: async () => {
      memory.close();
      if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previous;
      await rm(root, { recursive: true, force: true });
    }
  };
}

function onlyCleanupRequest(f: Awaited<ReturnType<typeof fixture>>): CapturedRequest {
  // Assert outside model.stream: LocalMemory intentionally catches ordinary model failures.
  assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Extract memories from this conversation:")).length, 1);
  const requests = f.requests.filter(({ prompt }) => prompt.startsWith("Current date and time:"));
  assert.equal(requests.length, 1, "NO_MEMORY must still reach the normal temporary cleanup path");
  return requests[0]!;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Cleanup test did not reach its model boundary within five seconds.")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
