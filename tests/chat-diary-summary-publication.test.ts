import { testModel } from "./helpers/model.js";
/** Public diary APIs with a synthetic model boundary; no Host, provider or live user data. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type AgentModel = import("../src/agent/core/types.js").AgentModel;
type ModelStreamEvent = import("../src/agent/core/types.js").ModelStreamEvent;
type DiaryResult = import("../src/agent/context/chatDiary.js").ChatDiaryRefreshResult;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture did not reach ${label}.`)), 5_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function controlledModel(summary: string) {
  const entered = deferred<string>();
  const release = deferred<void>();
  let calls = 0;
  const model: AgentModel = testModel({
    provider: "test",
    modelId: "public-diary-publication",
    stream: async (context) => {
      calls += 1;
      const prompt = context.messages.map((message) => typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
      entered.resolve(prompt);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        await release.promise;
        yield { type: "text-delta", text: summary };
        yield { type: "finish", reason: "stop" };
      })();
    }
  });
  return { model, entered, release, calls: () => calls };
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-diary-summary-publication-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
try {
  // Product imports happen only after isolation is established.
  const { refreshChatDailyDiary } = await import("../src/agent/context/chatDiary.js");
  const { appendDailyMemoryEntry, readDailyMemoryNote, readDailyMemorySection, upsertDailyMemorySection } = await import("../src/activity/dailyNotes.js");
  const dateKey = "2026-10-18";

  function options(name: string) {
    return { configDir: path.join(root, name), agentDir: path.join(root, "empty-session-source") };
  }

  async function appendSource(config: { configDir: string }, suffix: string): Promise<void> {
    await appendDailyMemoryEntry(dateKey, "聊天摘要", `session-${suffix}\0turn-${suffix}`, `### 12:00 · project-${suffix}\n- 请求：source-${suffix}\n- 结果：completed-${suffix}`, config);
  }

  async function note(config: { configDir: string }): Promise<string> {
    const content = await readDailyMemoryNote(dateKey, config);
    assert.ok(content, "the public writer must have created the isolated daily note");
    return content;
  }

  for (const force of [false, true]) await test(`an older source cannot replace a newer published summary (force=${String(force)})`, async () => {
    const config = options(`newer-completes-first-${String(force)}`);
    const older = controlledModel("Older summary based only on source-a.");
    const newer = controlledModel("Newer summary includes source-a and source-b.");
    const pending: Promise<DiaryResult>[] = [];
    try {
      await appendSource(config, "a");
      await upsertDailyMemorySection(dateKey, "自我反思", "Keep my independent reflection.", config);
      const first = refreshChatDailyDiary(dateKey, { ...config, model: older.model, force });
      pending.push(first);
      const oldPrompt = await bounded(older.entered.promise, "older model admission");
      assert.match(oldPrompt, /source-a/u);
      assert.doesNotMatch(oldPrompt, /source-b/u);

      await appendSource(config, "b");
      const second = refreshChatDailyDiary(dateKey, { ...config, model: newer.model, force });
      pending.push(second);
      const newPrompt = await bounded(newer.entered.promise, "newer model admission");
      assert.match(newPrompt, /source-a/u);
      assert.match(newPrompt, /source-b/u);
      newer.release.resolve();
      assert.equal((await bounded(second, "newer publication")).written, true);
      const winner = readDailyMemorySection(await note(config), "每日总结");
      assert.ok(winner?.includes("Newer summary includes source-a and source-b."));

      older.release.resolve();
      const settled = await bounded(first, "older settlement");
      const final = await note(config);
      assert.match(readDailyMemorySection(final, "聊天摘要") ?? "", /source-a[\s\S]*source-b/u);
      assert.equal(readDailyMemorySection(final, "自我反思"), "Keep my independent reflection.");
      assert.equal(readDailyMemorySection(final, "每日总结"), winner,
        "a delayed older-source completion must preserve the newer summary and source marker");
      assert.equal(settled.written, false);
      assert.equal(settled.reason, "superseded");
    } finally {
      older.release.resolve();
      newer.release.resolve();
      await Promise.allSettled(pending);
    }
  });

  await test("the first publication remains authoritative until an explicit retry", async () => {
    const config = options("older-completes-first");
    const older = controlledModel("Older summary.");
    const newer = controlledModel("Latest summary includes source-b.");
    const pending: Promise<DiaryResult>[] = [];
    try {
      await appendSource(config, "a");
      const first = refreshChatDailyDiary(dateKey, { ...config, model: older.model });
      pending.push(first);
      await bounded(older.entered.promise, "older model admission");
      await appendSource(config, "b");
      const second = refreshChatDailyDiary(dateKey, { ...config, model: newer.model });
      pending.push(second);
      await bounded(newer.entered.promise, "newer model admission");
      older.release.resolve();
      assert.equal((await bounded(first, "older publication")).written, true);
      const winner = readDailyMemorySection(await note(config), "每日总结");
      assert.ok(winner?.includes("Older summary."));
      newer.release.resolve();
      const settled = await bounded(second, "newer settlement");
      assert.equal(readDailyMemorySection(await note(config), "每日总结"), winner,
        "an overlapping request must not replace a section already changed since its snapshot");
      assert.equal(settled.written, false);
      assert.equal(settled.reason, "superseded");
      const retried = await refreshChatDailyDiary(dateKey, { ...config, model: newer.model });
      assert.equal(retried.written, true);
      assert.match(readDailyMemorySection(await note(config), "每日总结") ?? "", /Latest summary includes source-b\./u);
      assert.equal(newer.calls(), 2);
    } finally {
      older.release.resolve();
      newer.release.resolve();
      await Promise.allSettled(pending);
    }
  });

  await test("different activity policies cannot bypass ownership of a published summary", async () => {
    const config = options("different-activity-policies");
    const chatOnly = controlledModel("Late chat-only summary.");
    const combined = controlledModel("Published summary includes activity-evidence.");
    const pending: Promise<DiaryResult>[] = [];
    try {
      await appendSource(config, "a");
      const first = refreshChatDailyDiary(dateKey, { ...config, model: chatOnly.model, allowActivity: false });
      pending.push(first);
      assert.doesNotMatch(await bounded(chatOnly.entered.promise, "chat-only model admission"), /activity-evidence/u);
      await upsertDailyMemorySection(dateKey, "活动记录", "activity-evidence", config);
      const second = refreshChatDailyDiary(dateKey, { ...config, model: combined.model, allowActivity: true });
      pending.push(second);
      assert.match(await bounded(combined.entered.promise, "combined model admission"), /activity-evidence/u);
      combined.release.resolve();
      assert.equal((await bounded(second, "combined publication")).written, true);
      const winner = readDailyMemorySection(await note(config), "每日总结");
      assert.ok(winner?.includes("Published summary includes activity-evidence."));
      chatOnly.release.resolve();
      const settled = await bounded(first, "chat-only settlement");
      const final = await note(config);
      assert.equal(readDailyMemorySection(final, "活动记录"), "activity-evidence");
      assert.equal(readDailyMemorySection(final, "每日总结"), winner,
        "a different source projection must not overwrite the completed summary");
      assert.equal(settled.written, false);
      assert.equal(settled.reason, "superseded");
    } finally {
      chatOnly.release.resolve();
      combined.release.resolve();
      await Promise.allSettled(pending);
    }
  });

  await test("source growth alone retains the existing single-refresh snapshot behavior", async () => {
    const config = options("single-snapshot");
    const model = controlledModel("An admitted snapshot of source-a.");
    let pending: Promise<DiaryResult> | undefined;
    try {
      await appendSource(config, "a");
      pending = refreshChatDailyDiary(dateKey, { ...config, model: model.model });
      await bounded(model.entered.promise, "snapshot model admission");
      await appendSource(config, "b");
      model.release.resolve();
      assert.equal((await bounded(pending, "snapshot publication")).written, true);
      const final = await note(config);
      assert.match(readDailyMemorySection(final, "聊天摘要") ?? "", /source-b/u);
      assert.match(readDailyMemorySection(final, "每日总结") ?? "", /An admitted snapshot of source-a\./u);
    } finally {
      model.release.resolve();
      if (pending) await Promise.allSettled([pending]);
    }
  });

  await test("independent section changes survive publication and source deduplication remains effective", async () => {
    const config = options("independent-section");
    const model = controlledModel("Current summary.");
    let pending: Promise<DiaryResult> | undefined;
    try {
      await appendSource(config, "a");
      pending = refreshChatDailyDiary(dateKey, { ...config, model: model.model });
      await bounded(model.entered.promise, "summary model admission");
      await upsertDailyMemorySection(dateKey, "活动记录", "Independent activity narrative.", config);
      await upsertDailyMemorySection(dateKey, "自我反思", "Independent reflection.", config);
      model.release.resolve();
      assert.equal((await bounded(pending, "summary publication")).written, true);
      const final = await note(config);
      assert.equal(readDailyMemorySection(final, "活动记录"), "Independent activity narrative.");
      assert.equal(readDailyMemorySection(final, "自我反思"), "Independent reflection.");
      const repeated = await refreshChatDailyDiary(dateKey, { ...config, model: model.model });
      assert.equal(repeated.written, false);
      assert.equal(repeated.reason, "up_to_date");
      assert.equal(model.calls(), 1);
      const forced = await refreshChatDailyDiary(dateKey, { ...config, model: model.model, force: true });
      assert.equal(forced.written, true);
      assert.equal(model.calls(), 2);
    } finally {
      model.release.resolve();
      if (pending) await Promise.allSettled([pending]);
    }
  });
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
