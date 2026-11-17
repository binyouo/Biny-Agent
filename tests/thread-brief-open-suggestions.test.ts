import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadBriefStore } from "../src/session/threadBriefStore.js";
import type { BriefProjectSuggestion } from "../src/session/threadBriefTypes.js";

const suggestion = (id: string, status: BriefProjectSuggestion["status"]): BriefProjectSuggestion => ({
  id, signature: id, kind: "create", status, name: id, brief: "brief", focus: "focus", reason: "reason",
  threads: [{ sessionId: "session", projectId: "project", title: "title", createdAt: "2026-01-01T00:00:00Z" }],
  createdAt: "2026-01-01T00:00:00Z"
});

test("pending brief suggestions are limited after status filtering and survive restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brief-open-suggestions-"));
  const store = new ThreadBriefStore(root);
  try {
    await store.open();
    store.putSuggestion(suggestion("old-open", "open"));
    for (let i = 0; i < 501; i++) store.putSuggestion(suggestion(`history-${i}`, ["rejected", "dismissed", "accepted"][i % 3] as BriefProjectSuggestion["status"]));
    assert.deepEqual(store.snapshot().suggestions.map(item => item.id), ["old-open"]);
    assert.equal(store.suggestions().length, 500, "historical listing keeps its existing bound");
    assert.equal(store.suggestions().some(item => item.id === "old-open"), false);
    store.close();
    await store.open();
    assert.deepEqual(store.snapshot().suggestions.map(item => item.id), ["old-open"]);
    for (let i = 0; i < 501; i++) store.putSuggestion(suggestion(`open-${i}`, "open"));
    const pending = store.snapshot().suggestions;
    assert.equal(pending.length, 500);
    assert.equal(pending[0]?.id, "open-500");
    assert.equal(pending.at(-1)?.id, "open-1");
    store.putSuggestion({ ...pending[0]!, status: "dismissed" });
    assert.equal(store.snapshot().suggestions.at(-1)?.id, "open-0");
    assert.equal(store.suggestion("open-500")?.status, "dismissed");
    assert.equal(store.hasSignature("history-0"), true, "historical deduplication evidence is retained");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
