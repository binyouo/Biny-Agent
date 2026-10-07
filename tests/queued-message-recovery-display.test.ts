/** 保存的追加消息从原 JSONL 投影为只读恢复内容，不改变回合终态或触发执行。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { saveAttachment } from "../src/attachments/store.js";
import { undeliveredMessageNotices } from "../src/session/queuedMessages.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";

const runtime = (runId: string, seq: number) => ({ runId, eventId: `event-${seq}`, eventSeq: seq });
const user: SessionEvent = { type: "user_message", messageId: "user", content: "原始任务", runtime: runtime("original", 1) };
const answer = (id: string, runId: string, seq: number): SessionEvent[] => [
  { type: "agent_message", messageId: id, parentMessageId: "user", slotId: "answer", runtime: runtime(runId, seq),
    message: { role: "assistant", content: [{ type: "text", text: `回答 ${id}` }] } },
  { type: "assistant_message", messageId: id, replyToMessageId: "user", slotId: "answer", content: `回答 ${id}`,
    runtime: runtime(runId, seq + 1) }
];
const receipt = (id: string, runId: string, seq: number, content = `已保存 ${id}`): SessionEvent => ({
  type: "user_message", messageId: id, auditOnly: true, content, metadata: { queuedDelivery: "steer" }, runtime: runtime(runId, seq)
});
const terminal = (runId: string, seq: number): SessionEvent => ({ type: "turn_status", status: "cancelled", stopReason: "cancelled",
  steps: 1, summary: "用户已取消", runtime: runtime(runId, seq) });
const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};
function render(turns: ReturnType<typeof buildSessionTimeline>): Document {
  return new JSDOM(renderToStaticMarkup(React.createElement(MessageTimeline, {
    projectId: "recovery", turns, thinking: false, onPreviewFile: noop, onOpenExternal: noop,
    onResolvePermission: noopAsync, onRetry: noopAsync, onSwitchVersion: noopAsync,
    onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop,
    onReferenceMessage: noop, onShowMessageReferences: noop, onAddQuoteToConversation: noopAsync
  }))).window.document;
}

async function persisted(run: (file: string, attachment: Awaited<ReturnType<typeof saveAttachment>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-queued-recovery-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  await recorder.close();
  try { await run(recorder.filePath, await saveAttachment(root, "保存附件.txt", "text/plain", Buffer.from("fixture"))); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function roundTrip(file: string, events: SessionEvent[]): Promise<SessionEvent[]> {
  await writeFile(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return await readSessionEvents(file);
}

test("当前分支中断后显示未交付正文与有效附件，已有notice不改变cancelled结果", async () => {
  await persisted(async (file, attachment) => {
    const saved = { ...receipt("steering", "original", 2), attachments: [attachment, { ...attachment, path: "@attachments/../invalid.txt", name: "无效附件" }] };
    const notice = undeliveredMessageNotices([saved])[0]!;
    const events = await roundTrip(file, [user, saved, ...answer("answer", "original", 3), terminal("original", 5), notice]);
    const before = await readFile(file, "utf8");
    for (const turns of [buildSessionTimeline(events, []), createSessionTimelineProjector().update({ sessionId: "saved", events, liveEvents: [] })]) {
      assert.equal(turns[0]?.status, "cancelled");
      assert.equal(turns[0]?.error, "用户已取消", "finally写入的notice不能覆盖原终态说明");
      const doc = render(turns);
      const entry = doc.querySelector('[data-saved-message-id="steering"]');
      assert.ok(entry, "持久化接收回执必须进入恢复展示");
      assert.ok(entry.textContent?.includes("已保存 steering"));
      assert.ok(entry.textContent?.includes(attachment.name));
      assert.ok(entry.textContent?.includes(attachment.path));
      assert.ok(!entry.textContent?.includes("无效附件"));
      assert.ok(!entry.textContent?.includes("原目标未知"));
      assert.equal(entry.querySelectorAll("button, a, input, textarea").length, 0);
      assert.equal(entry.closest("article[data-message-id]"), null, "恢复正文不是助手回答，不能绑定助手消息操作");
      assert.equal(entry.closest(".markdown-body"), null, "选中恢复正文不产生回答摘录");
    }
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("普通回合尚未写出回答也按明确的run用户消息绑定展示，不补造助手答复", async () => {
  await persisted(async (file, attachment) => {
    const events = await roundTrip(file, [user, { ...receipt("before-answer", "original", 2), attachments: [attachment] }, terminal("original", 3)]);
    const turns = buildSessionTimeline(events, []);
    assert.equal(turns[0]?.status, "cancelled");
    assert.equal(turns[0]?.assistant, "");
    const doc = render(turns);
    assert.ok(doc.querySelector('[data-saved-message-id="before-answer"]'));
    assert.equal(doc.querySelector('section[aria-label="恢复区域：原目标未知"]'), null);
  });
});

test("能够证明属于非活动回答分支的追加消息不显示", async () => {
  await persisted(async (file, attachment) => {
    const events = await roundTrip(file, [user, { ...receipt("inactive-steering", "original", 2), attachments: [attachment] },
      ...answer("old", "original", 3), ...answer("selected", "retry", 5),
      { type: "message_version_selected", messageId: "selected", slotId: "answer" }, terminal("original", 7)]);
    for (const turns of [buildSessionTimeline(events, []), createSessionTimelineProjector().update({ sessionId: "branch", events, liveEvents: [] })]) {
      assert.equal(render(turns).querySelector('[data-saved-message-id="inactive-steering"]'), null);
    }
  });
});

test("写新回答前取消的retry只在原目标未知的只读恢复区展示，不按最近消息归属", async () => {
  await persisted(async (file, attachment) => {
    const saved = { ...receipt("unknown-steering", "unbound-retry", 4), attachments: [attachment] };
    const events = await roundTrip(file, [user, ...answer("original-answer", "original", 2), saved, terminal("unbound-retry", 5)]);
    const projector = createSessionTimelineProjector();
    for (const turns of [buildSessionTimeline(events, []), projector.update({ sessionId: "unknown", events, liveEvents: [] })]) {
      const doc = render(turns);
      const area = doc.querySelector('section[aria-label="恢复区域：原目标未知"]');
      assert.ok(area, "缺少原消息或分支绑定时必须独立展示");
      assert.ok(area.textContent?.includes("原目标未知"));
      assert.ok(area.textContent?.includes("已保存 unknown-steering"));
      assert.ok(area.textContent?.includes(attachment.path));
      assert.equal(area.querySelectorAll("button, a, input, textarea").length, 0);
      assert.equal(area.closest("article[data-message-id]"), null, "不能挂在最近一条用户/助手消息上");
    }
  });
});

test("已交付及已移除回执不重复显示，正文编辑和重复notice只恢复一次", async () => {
  await persisted(async (file, attachment) => {
    const saved = { ...receipt("edited", "original", 2, "旧正文"), attachments: [attachment] };
    const events = await roundTrip(file, [user, saved,
      { type: "message_metadata", messageId: "edited", metadata: { queuedContent: "修改后的正文" } },
      receipt("removed", "original", 3), { type: "message_metadata", messageId: "removed", metadata: { queuedState: "removed" } },
      receipt("delivered", "original", 4), { type: "user_message", messageId: "delivered", parentMessageId: "user", content: "已交付", runtime: runtime("original", 5) },
      ...answer("answer", "original", 6), ...undeliveredMessageNotices([saved]), terminal("original", 8)]);
    assert.equal(undeliveredMessageNotices(events).length, 0, "持久notice仍防止重复写入");
    const doc = render(buildSessionTimeline(events, []));
    assert.equal(doc.querySelectorAll('[data-saved-message-id="edited"]').length, 1);
    assert.ok(doc.querySelector('[data-saved-message-id="edited"]')?.textContent?.includes("修改后的正文"));
    assert.equal(doc.querySelector('[data-saved-message-id="removed"]'), null);
    assert.equal(doc.querySelector('[data-saved-message-id="delivered"]'), null);
  });
});

test("活动run中的队列不提前显示恢复提示，持久终态和实时终态后投影一致", async () => {
  await persisted(async (file, attachment) => {
    const events = await roundTrip(file, [user, { ...receipt("pending-live", "original", 2), attachments: [attachment] }]);
    const base = { sessionId: "live", runId: "original", timestamp: "2026-10-07T00:00:00Z" };
    const liveEvents: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "user", content: "原始任务" },
      { ...base, type: "run.started", input: "原始任务", messageId: "reserved", skills: [], model: { alias: "fake", provider: "fake", label: "fake", reasoning: "off" } }];
    const projector = createSessionTimelineProjector();
    assert.equal(render(projector.update({ sessionId: "live", events, liveEvents })).querySelector('[data-saved-message-id="pending-live"]'), null);
    liveEvents.push({ ...base, type: "run.cancelled", durationMs: 1, reason: "用户取消" });
    const updated = projector.update({ sessionId: "live", events, liveEvents });
    assert.deepEqual(updated, buildSessionTimeline(events, liveEvents));
    assert.ok(render(updated).querySelector('[data-saved-message-id="pending-live"]'));
    const completedEvents = await roundTrip(file, [...events, terminal("original", 3)]);
    assert.ok(render(projector.update({ sessionId: "live", events: completedEvents, liveEvents: [] })).querySelector('[data-saved-message-id="pending-live"]'));
  });
});


test("共享中间回答仍在活动路径时，以明确最终回答绑定排除旧分支回执", async () => {
  await persisted(async (file, attachment) => {
    const old = answer("old-final", "original", 4).map((event) => ({ ...event, parentMessageId: "shared-intermediate" }));
    const selected = answer("selected-final", "retry", 6).map((event) => ({ ...event, parentMessageId: "shared-intermediate" }));
    const events = await roundTrip(file, [user,
      { type: "agent_message", messageId: "shared-intermediate", parentMessageId: "user", slotId: "intermediate", runtime: runtime("original", 2),
        message: { role: "assistant", content: [{ type: "text", text: "共享中间答复" }] } },
      { ...receipt("old-branch-receipt", "original", 3), attachments: [attachment] }, ...old, ...selected,
      { type: "message_version_selected", messageId: "selected-final", slotId: "answer" }, terminal("original", 8)]);
    for (const turns of [buildSessionTimeline(events, []), createSessionTimelineProjector().update({ sessionId: "shared", events, liveEvents: [] })]) {
      assert.equal(render(turns).querySelector('[data-saved-message-id="old-branch-receipt"]'), null);
    }
  });
});

test("只读附件展示支持固定导入命名空间，拒绝任意嵌套与路径穿越", async () => {
  await persisted(async (file, attachment) => {
    const imported = { ...attachment, path: "@attachments/import-0123456789abcdef0123456789abcdef/imported.txt", name: "已导入附件" };
    const events = await roundTrip(file, [user, { ...receipt("imported-receipt", "original", 2), attachments: [imported,
      { ...attachment, path: "@attachments/arbitrary/file.txt", name: "任意嵌套" },
      { ...attachment, path: "@attachments/import-0123456789abcdef0123456789abcdef/../file.txt", name: "路径穿越" }] }, terminal("original", 3)]);
    const entry = render(buildSessionTimeline(events, [])).querySelector('[data-saved-message-id="imported-receipt"]');
    assert.ok(entry?.textContent?.includes(imported.path));
    assert.ok(!entry?.textContent?.includes("任意嵌套"));
    assert.ok(!entry?.textContent?.includes("路径穿越"));
  });
});
