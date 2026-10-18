import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { messageTokenCost } from "../src/agent/context/tokenUsage.js";
import type { AgentUserMessage } from "../src/agent/core/types.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { snapshotToReplay, tryReadSessionSnapshot, writeSessionSnapshot } from "../src/session/sessionSnapshot.js";

test("model history carries original send time and timezone without rewriting session text", () => {
  const events = [
    { type: "user_message" as const, content: "明天交付", time: "2026-10-07T23:30:00+08:00", metadata: { sentAtTimeZone: "Asia/Shanghai" } },
    { type: "user_message" as const, content: "昨天完成了", time: "2026-10-09T01:00:00Z" },
    { type: "user_message" as const, content: "empty timezone", time: "2026-10-09T01:00:00Z", metadata: { sentAtTimeZone: "" } },
    { type: "user_message" as const, content: "legacy, unknown send time" },
    { type: "user_message" as const, content: "invalid send time", time: "invalid" }
  ];
  const before = structuredClone(events);
  const replay = replaySessionEvents(events);
  const modelMessages = toModelMessages(replay.messages);
  assert.deepEqual(modelMessages, [
    { role: "user", content: "[Message sent-at: 2026-10-07T15:30:00.000Z; original timezone: Asia/Shanghai; message time is not event/due/completion time.]\n\n明天交付" },
    { role: "user", content: "[Message sent-at: 2026-10-09T01:00:00.000Z; original local timezone unknown; message time is not event/due/completion time.]\n\n昨天完成了" },
    { role: "user", content: "[Message sent-at: 2026-10-09T01:00:00.000Z; original local timezone unknown; message time is not event/due/completion time.]\n\nempty timezone" },
    { role: "user", content: "legacy, unknown send time" },
    { role: "user", content: "invalid send time" }
  ]);
  assert.deepEqual(events, before);
  assert.deepEqual(replay.messages.map(message => message.content), events.map(event => event.content));
  assert.deepEqual(toModelMessages(replay.messages), modelMessages, "repeated projection must not duplicate time prefixes");
});

test("multimodal model projection preserves media and includes the time anchor in its token budget", () => {
  const user: AgentUserMessage = {
    role: "user", sentAt: "2026-10-07T15:30:00Z", sentAtTimeZone: "Asia/Shanghai",
    content: [{ type: "image", data: "synthetic-image", mimeType: "image/png" }, { type: "text", text: "明天处理这个" }]
  };
  const prefix = "[Message sent-at: 2026-10-07T15:30:00.000Z; original timezone: Asia/Shanghai; message time is not event/due/completion time.]";
  assert.deepEqual(toModelMessages([user]), [{ role: "user", content: [
    { type: "text", text: prefix },
    { type: "file", data: "synthetic-image", mediaType: "image/png" },
    { type: "text", text: "明天处理这个" }
  ] }]);
  assert.deepEqual(user.content[0], { type: "image", data: "synthetic-image", mimeType: "image/png" });
  assert.equal(messageTokenCost(user), messageTokenCost({ role: "user", content: [{ type: "text", text: prefix }, ...user.content] }));
});

test("replay cache rebuild preserves original times without rewriting JSONL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-sent-at-snapshot-"));
  try {
    const file = path.join(root, "session.jsonl");
    const events = [{ type: "user_message" as const, messageId: "source", content: "明天处理", time: "2026-10-07T15:30:00Z", metadata: { sentAtTimeZone: "Asia/Shanghai" } }];
    const bytes = `${events.map(event => JSON.stringify(event)).join("\n")}\n`;
    await writeFile(file, bytes);
    const { size, mtimeMs } = await stat(file);
    const fingerprint = { size, mtimeMs };
    const replay = replaySessionEvents(events);
    await writeSessionSnapshot(file, fingerprint, replay);
    const snapshot = await tryReadSessionSnapshot(file, fingerprint);
    assert.ok(snapshot);
    assert.deepEqual(toModelMessages(snapshotToReplay(snapshot).messages), [{ role: "user", content: "[Message sent-at: 2026-10-07T15:30:00.000Z; original timezone: Asia/Shanghai; message time is not event/due/completion time.]\n\n明天处理" }]);
    await writeFile(path.join(root, "session.snap.json"), JSON.stringify({ ...snapshot, replayVersion: 3, messages: [{ role: "user", content: "明天处理" }] }));
    assert.equal(await tryReadSessionSnapshot(file, fingerprint), undefined, "old caches without send-time metadata must be rebuilt");
    assert.equal(await readFile(file, "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct provider receives send-time text through the actual SDK request", async () => {
  const requests: LanguageModelV4CallOptions[] = [];
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "send-time", supportedUrls: {},
    doGenerate: async () => { throw new Error("Unexpected non-streaming request"); },
    doStream: async options => {
      requests.push(options);
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "answer" });
        controller.enqueue({ type: "text-delta", id: "answer", delta: "fixture answer" });
        controller.enqueue({ type: "text-end", id: "answer" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }
        } });
        controller.close();
      } }) };
    }
  };
  const messages = replaySessionEvents([{ type: "user_message", content: "明天处理", time: "2026-10-07T15:30:00Z", metadata: { sentAtTimeZone: "Asia/Shanghai" } }]).messages;
  for await (const event of vercelAgentLoopContinue({ messages, tools: [] }, {
    model: { provider: "fixture", modelId: "send-time", supportsTools: false, vercelModel: provider },
    vercelModel: provider, tools: [], maxSteps: 1
  })) assert.notEqual(event.type, "error");
  assert.equal(requests.length, 1);
  const text = requests[0]!.prompt.flatMap(message => message.role === "user" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []).join("\n");
  assert.equal(text, "[Message sent-at: 2026-10-07T15:30:00.000Z; original timezone: Asia/Shanghai; message time is not event/due/completion time.]\n\n明天处理");
});
