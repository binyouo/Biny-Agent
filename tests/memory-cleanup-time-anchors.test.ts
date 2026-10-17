import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { memoryTimeAnchorInstruction, temporaryMemoryCleanupPrompt } from "../src/agent/context/memoryExtraction.js";
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

await test("cleanup receives stored and current source times separately from memory saved-at", async () => {
  const f = await fixture();
  try {
    const storedAnchor = { messageId: "old-source", sentAt: "2026-09-20T10:30:00+08:00", timeZone: "Asia/Shanghai" };
    const currentAnchor = { messageId: "current-source", sentAt: "2026-10-16T17:00:00-04:00", timeZone: "America/New_York" };
    const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary", originAnchors: [storedAnchor] }, { now: savedAt })).entry!;
    f.candidates.push(entry);
    const result = await f.summarize({ originAnchors: [currentAnchor, currentAnchor] });
    const request = onlyCleanupRequest(f);
    assert.ok(request.prompt.includes(JSON.stringify(entry.originAnchors)), "cleanup must receive the stored source anchors");
    assert.ok(request.prompt.includes('Current conversation source: source-message anchors: [{"messageId":"current-source","sentAt":"2026-10-16T21:00:00.000Z","timeZone":"America/New_York"}]'),
      "cleanup must receive normalized, deduplicated current-conversation anchors");
    assert.match(request.prompt, /Memory saved-at: 2026-10-15T12:00:00\.000Z/u);
    assert.match(request.prompt, /saved-at is NOT event\/due\/completion time/u);
    assert.equal(request.systemPrompt, temporaryMemoryCleanupPrompt + "\n\n" + memoryTimeAnchorInstruction);
    assert.deepEqual(result, { created: [], updated: [], deleted: [] });
    const current = (await f.memory.getEntry(entry.id))!;
    assert.equal(current.content, entry.content);
    assert.equal(current.revision, entry.revision);
    assert.equal(current.createdAt, entry.createdAt);
    assert.deepEqual(current.originAnchors, entry.originAnchors);
    assert.equal(current.accessCount, entry.accessCount + 1, "semantic candidate access remains a legitimate side effect");
  } finally { await f.close(); }
});

await test("cleanup preserves unknown source timezones instead of borrowing the save timezone", async () => {
  const f = await fixture();
  try {
    const entry = (await f.memory.writeEntry({
      content: fact, durability: "temporary",
      originAnchors: [{ messageId: "unknown-zone", sentAt: "2026-09-20T02:30:00.000Z", timeZone: "unknown" }]
    }, { now: savedAt })).entry!;
    f.candidates.push(entry);
    const result = await f.summarize({ originAnchors: [
      { messageId: "invalid-zone", sentAt: "2026-10-16T12:00:00+02:00", timeZone: "Invalid/Timezone" }
    ] });
    const request = onlyCleanupRequest(f);
    assert.ok(request.prompt.includes('source-message anchors: [{"messageId":"unknown-zone","sentAt":"2026-09-20T02:30:00.000Z","timeZone":"unknown"}]'));
    assert.ok(request.prompt.includes('Current conversation source: source-message anchors: [{"messageId":"invalid-zone","sentAt":"2026-10-16T10:00:00.000Z","timeZone":"unknown"}]'));
    assert.doesNotMatch(request.prompt, /Invalid\/Timezone/u);
    assert.match(request.prompt, /Memory saved-at: 2026-10-15T12:00:00\.000Z/u);
    assert.equal(request.systemPrompt, temporaryMemoryCleanupPrompt + "\n\n" + memoryTimeAnchorInstruction);
    assert.deepEqual(result.deleted, []);
    const current = (await f.memory.getEntry(entry.id))!;
    assert.equal(current.content, entry.content);
    assert.equal(current.revision, entry.revision);
    assert.deepEqual(current.originAnchors, entry.originAnchors);
  } finally { await f.close(); }
});

await test("cleanup labels missing candidate and conversation source times as unknown", async () => {
  const f = await fixture();
  try {
    const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary" }, { now: savedAt })).entry!;
    f.candidates.push(entry);
    const result = await f.summarize();
    const request = onlyCleanupRequest(f);
    assert.equal(request.prompt.match(/original message time\/timezone unknown/gu)?.length, 2,
      "missing candidate and current-conversation sources must both remain explicitly unknown");
    assert.match(request.prompt, /Current conversation source: original message time\/timezone unknown/u);
    assert.match(request.prompt, /Memory saved-at: 2026-10-15T12:00:00\.000Z/u);
    assert.doesNotMatch(request.prompt, /source-message anchors:/u);
    assert.equal(request.systemPrompt, temporaryMemoryCleanupPrompt + "\n\n" + memoryTimeAnchorInstruction);
    assert.deepEqual(result.deleted, []);
    const current = (await f.memory.getEntry(entry.id))!;
    assert.equal(current.content, entry.content);
    assert.equal(current.revision, entry.revision);
    assert.equal(current.originAnchors, undefined);
  } finally { await f.close(); }
});

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
    assert.deepEqual(result, { created: [], updated: [], deleted: [] });
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

await test("cleanup excludes a temporary fact retained by this extraction batch", async () => {
  const f = await fixture();
  try {
    const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary" })).entry!;
    f.candidates.push(entry);
    f.state.extractionResponse = JSON.stringify([{ operation: "add", content: fact, durability: "temporary" }]);
    f.state.reconciliationResponse = JSON.stringify({ operation: "NONE", id: entry.id });
    const result = await f.summarize();
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Extract memories from this conversation:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Reconcile proposed memory:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Current date and time:")).length, 0);
    assert.equal(f.searches.length, 2, "candidate search remains in place even when the model filter retains the only fact");
    assert.equal(f.searches[1]?.query, conversationText);
    assert.equal((await f.memory.getEntry(entry.id))?.content, fact);
    assert.equal((await f.memory.getEntry(entry.id))?.revision, entry.revision);
    assert.deepEqual(result, { created: [], updated: [], deleted: [] });
  } finally { await f.close(); }
});

await test("a deferred addition still suppresses cleanup of a temporary candidate", async () => {
  const f = await fixture();
  try {
    const entry = (await f.memory.writeEntry({ content: fact, durability: "temporary" })).entry!;
    f.candidates.push(entry);
    f.state.extractionResponse = JSON.stringify([{ operation: "add", content: "The ongoing project review has a revised plan.", durability: "temporary" }]);
    f.state.reconciliationResponse = "{invalid";
    const result = await f.summarize();
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Extract memories from this conversation:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Reconcile proposed memory:")).length, 1);
    assert.equal(f.requests.filter(({ prompt }) => prompt.startsWith("Current date and time:")).length, 0);
    assert.equal(f.searches.length, 1, "deferred reconciliation must not launch cleanup search");
    assert.equal((await f.memory.getEntry(entry.id))?.content, fact);
    assert.equal((await f.memory.getEntry(entry.id))?.revision, entry.revision);
    assert.deepEqual(result, { created: [], updated: [], deleted: [] });
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
    reconciliationResponse: JSON.stringify({ operation: "ADD" }),
    cleanupResponse: () => "[]"
  };
  const model: AgentModel = {
    provider: "test", modelId: "cleanup-time-anchors-fixture",
    async stream(context, options) {
      const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      requests.push({ prompt, systemPrompt: context.systemPrompt });
      const text = prompt.startsWith("Extract memories from this conversation:") ? state.extractionResponse
        : prompt.startsWith("Reconcile proposed memory:") ? state.reconciliationResponse
          : await state.cleanupResponse();
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  const memory = new LocalMemory(root, () => model, undefined, 3, undefined, undefined, undefined,
    async (query, options) => { searches.push({ query, options }); return candidates; });
  return {
    memory, requests, searches, candidates, state,
    summarize: async (options: { originAnchors?: MemoryOriginAnchor[]; userId?: string } = {}) =>
      await memory.summarizeAndStoreMemories(conversation, {
        sessionId: "cleanup-session", turnId: "cleanup-turn", runId: "cleanup-run",
        externalContext: false, excludeExternalContext: false, now, ...options
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
