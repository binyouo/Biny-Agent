/** 官方会话 mapping 从明确活动链进入持久化、引用与回放，不按时间猜分支。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { importSessionFile, exportSessionBundle, parseSessionImport, detectSessionImportFormat, listChatGptConversations } from "../src/session/transfer.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import { refreshSessionIndex } from "../src/session/catalog.js";
import { sessionMessageTree } from "../src/session/messageTree.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";
import { LocalReferenceService } from "../src/session/localReferences.js";
import { ensureAgentDirs, listSessionFiles } from "../src/session/store.js";

const seconds = Date.parse("2026-10-03T03:00:00Z") / 1000;
const message = (id: string, role: string, text: string, create_time: unknown = seconds) => ({ id, author: { role }, create_time,
  content: { content_type: "text", parts: [text] }, metadata: {}, recipient: "all" });
function conversation(id = "conversation-a") {
  return { id, title: `标题 ${id}`, create_time: seconds, update_time: seconds + 120, current_node: "selected", mapping: {
    root: { id: "root", parent: null, message: null },
    system: { id: "system", parent: "root", message: message("system", "system", "隐藏系统提示") },
    user: { id: "user", parent: "system", message: message("source-user", "user", "原始问题") },
    old: { id: "old", parent: "user", message: message("source-old", "assistant", "更晚但非活动回答", seconds + 999) },
    selected: { id: "selected", parent: "user", message: message("source-answer", "assistant", "当前回答") }
  } };
}
async function fixture(run: (root: string, workspace: string, source: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-chatgpt-import-")));
  const workspace = path.join(root, "project");
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = root;
  try { await mkdir(workspace); await ensureAgentDirs(workspace); await run(root, workspace, path.join(workspace, "conversations-001.json")); }
  finally { await refreshSessionIndex(workspace); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

test("official array imports only current_node parent path with independent identities, date hits, references and replay", async () => {
  await fixture(async (root, workspace, source) => {
    await writeFile(source, JSON.stringify([conversation()]));
    const imported = await importSessionFile(workspace, source);
    assert.equal(imported.format, "chatgpt");
    assert.equal(imported.sourceConversationId, "conversation-a");
    assert.equal(imported.sourceTitle, "标题 conversation-a");
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    const nodes = sessionMessageTree(events);
    assert.deepEqual(nodes.map((node) => node.message.role), ["user", "assistant"]);
    assert.equal(nodes[1]?.parentId, nodes[0]?.id);
    assert.equal(new Set(nodes.map((node) => node.slotId)).size, 2);
    assert.deepEqual(events.filter((event) => event.type === "user_message" || event.type === "agent_message").map((event) => event.importSource), [
      { format: "chatgpt", conversationId: "conversation-a", record: 3, messageId: "source-user", parentMessageId: "system" },
      { format: "chatgpt", conversationId: "conversation-a", record: 5, messageId: "source-answer", parentMessageId: "user" }
    ]);
    assert.deepEqual(replaySessionEvents(events).messages.map((entry) => entry.role), ["user", "assistant"]);
    assert.ok(!JSON.stringify(events).includes("非活动回答"));
    const detailService = new DateReferenceDetailService(root);
    const before = await readFile(imported.filePath, "utf8");
    try {
      const detail = await detailService.query({ startDate: "2026-10-03", endDate: "2026-10-04", timeZone: "Asia/Shanghai" }, [{ id: "project", path: workspace }]);
      assert.equal(detail.conversations.length, 2);
      const references = new LocalReferenceService({ root, projects: [{ id: "project", name: "Project", path: workspace }] });
      for (const hit of detail.conversations) {
        const ref = await references.referenceForMessage(imported.sessionId, hit.messageId, "project");
        assert.equal((await references.resolve(ref.uri, "project")).content, hit.quote);
      }
    } finally { detailService.close(); }
    assert.equal(await readFile(imported.filePath, "utf8"), before);
    const second = await importSessionFile(workspace, source);
    const secondIds = sessionMessageTree((await readStoredSessionEvents(workspace, second.sessionId)).events).map((node) => node.id);
    assert.ok(secondIds.every((id) => nodes.every((node) => node.id !== id)));
    await writeFile(source, (await exportSessionBundle(workspace, imported.sessionId)).content);
    const roundtrip = await importSessionFile(workspace, source);
    assert.deepEqual((await readStoredSessionEvents(workspace, roundtrip.sessionId)).events, events);
  });
});

test("multiple conversations require explicit choice and unknown selection never writes a session", async () => {
  await fixture(async (_root, workspace, source) => {
    await writeFile(source, JSON.stringify([conversation(), conversation("conversation-b")]));
    await assert.rejects(importSessionFile(workspace, source), /请选择.*会话/u);
    await assert.rejects(importSessionFile(workspace, source, { conversationId: "missing" }), /会话.*不存在/u);
    assert.deepEqual(await listSessionFiles(workspace), []);
    const selected = await importSessionFile(workspace, source, { conversationId: "conversation-b" });
    assert.equal(selected.sourceConversationId, "conversation-b");
  });
});

test("single mapping object imports without selection and media/hidden/tool content is reported without fake attachment bytes", async () => {
  await fixture(async (_root, workspace, source) => {
    const input = conversation();
    input.current_node = "visible";
    Object.assign(input.mapping, {
      hidden: { parent: "selected", message: { ...message("hidden", "assistant", "隐藏思考"), metadata: { is_visually_hidden_from_conversation: true } } },
      tool: { parent: "hidden", message: message("tool", "tool", "工具事实不会执行") },
      media: { parent: "tool", message: { ...message("media", "user", ""), content: { content_type: "multimodal_text", parts: ["可读正文", { content_type: "image_asset_pointer", asset_pointer: "file-service://unknown" }, { content_type: "input_audio", audio_asset_pointer: "audio://unknown" }] } } },
      visible: { parent: "media", message: message("visible", "assistant", "最终答复") }
    });
    await writeFile(source, JSON.stringify(input));
    const imported = await importSessionFile(workspace, source);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    assert.equal(imported.attachmentsRestored, 0);
    assert.equal(imported.skippedContentCount, 5, "system、hidden、tool三个消息和两个非文本part分别报告");
    assert.ok(imported.skippedContentIssues.some((issue) => issue.reason === "unsupported-content" && issue.count === 2));
    assert.deepEqual(replaySessionEvents(events).messages.map((entry) => entry.role), ["user", "assistant", "user", "assistant"]);
    assert.ok(JSON.stringify(events).includes("可读正文"));
    assert.ok(!JSON.stringify(events).includes("file-service://"));
    assert.ok(!JSON.stringify(events).includes("隐藏思考"));
  });
});

for (const mode of ["ambiguous", "missing-parent", "cycle", "unknown-current"] as const) {
  test(`invalid ${mode} graph is rejected before persistence`, async () => {
    await fixture(async (_root, workspace, source) => {
      const input = conversation();
      if (mode === "ambiguous") delete (input as { current_node?: string }).current_node;
      if (mode === "missing-parent") input.mapping.selected.parent = "missing";
      if (mode === "cycle") input.mapping.user.parent = "selected";
      if (mode === "unknown-current") input.current_node = "missing";
      await writeFile(source, JSON.stringify(input));
      await assert.rejects(importSessionFile(workspace, source), /ChatGPT.*(分支|parent|循环|current_node)/u);
      assert.deepEqual(await listSessionFiles(workspace), []);
    });
  });
}


test("listing is read-only, returns source dates and reports invalid branches without hiding other conversations", async () => {
  await fixture(async (_root, workspace, source) => {
    const invalid = conversation("bad");
    delete (invalid as { current_node?: string }).current_node;
    const raw = JSON.stringify([conversation(), invalid]);
    const summaries = listChatGptConversations(raw, source);
    assert.deepEqual(summaries[0], { id: "conversation-a", title: "标题 conversation-a", createdAt: "2026-10-03T03:00:00.000Z",
      updatedAt: "2026-10-03T03:02:00.000Z", messageCount: 2, importError: undefined });
    assert.match(summaries[1]!.importError!, /多个分支/u);
    assert.equal(detectSessionImportFormat(raw, source), "chatgpt");
    const parsed = parseSessionImport(raw, source, { conversationId: "conversation-a" });
    assert.equal(parsed.format, "chatgpt");
    assert.equal(parsed.events.length, 3);
    assert.deepEqual(parsed.attachments, []);
    assert.deepEqual(await listSessionFiles(workspace), [], "列表和preflight不持久化任何会话");
  });
});

test("missing current_node accepts only a unique leaf chain and missing source ID stays a selection record", async () => {
  await fixture(async (_root, workspace, source) => {
    const input = conversation();
    delete (input as { id?: string }).id;
    input.title = "";
    delete (input as { current_node?: string }).current_node;
    delete (input.mapping as { old?: unknown }).old;
    const raw = JSON.stringify(input);
    assert.equal(listChatGptConversations(raw, source)[0]?.id, "source-record:1");
    await writeFile(source, raw);
    const imported = await importSessionFile(workspace, source, { format: "chatgpt", conversationId: "source-record:1" });
    assert.equal(imported.sourceConversationId, undefined);
    assert.equal(imported.sourceTitle, undefined, "缺失来源标题不能以展示默认名伪造来源事实");
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    assert.ok(events.every((event) => event.importSource?.conversationId === undefined));
    assert.deepEqual(sessionMessageTree(events).map((node) => node.message.role), ["user", "assistant"]);
  });
});

test("only valid numeric exported seconds become message timestamps; analysis and tool recipients stay hidden", async () => {
  await fixture(async (_root, workspace, source) => {
    const input = conversation();
    input.mapping.user.message.create_time = "2026-10-03T03:00:00Z";
    input.mapping.selected.message.create_time = seconds + 0.125;
    input.current_node = "last";
    Object.assign(input.mapping, {
      analysis: { parent: "selected", message: { ...message("analysis", "assistant", "不可公开的analysis"), channel: "analysis" } },
      routed: { parent: "analysis", message: { ...message("routed", "assistant", "print('no execution')"), recipient: "python" } },
      last: { parent: "routed", message: message("last", "assistant", "有效正文", 1e20) }
    });
    await writeFile(source, JSON.stringify(input));
    const imported = await importSessionFile(workspace, source);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    const userEvent = events.find((event) => event.type === "user_message");
    assert.equal(userEvent?.time, undefined);
    assert.ok(events.some((event) => event.time === "2026-10-03T03:00:00.125Z"));
    assert.ok(events.filter((event) => event.importSource?.messageId === "last").every((event) => event.time === undefined));
    assert.ok(!JSON.stringify(events).includes("不可公开的analysis"));
    assert.ok(!JSON.stringify(events).includes("no execution"));
    assert.equal(imported.skippedContentIssues.filter((issue) => issue.reason === "hidden-message").length, 2);
  });
});

test("readable text parts survive mixed content; unsupported-only selected conversations are rejected before writes", async () => {
  await fixture(async (_root, workspace, source) => {
    const input = conversation();
    input.current_node = "user";
    Object.assign(input.mapping.user.message.content, { content_type: "multimodal_text", parts: ["一", { content_type: "text", text: "二" },
      { type: "text", text: "三" }, { content_type: "file", file_id: "unavailable" }] });
    await writeFile(source, JSON.stringify(input));
    const imported = await importSessionFile(workspace, source);
    assert.equal(imported.skippedContentCount, 2, "系统消息和文件part均明确报告");
    assert.equal(replaySessionEvents((await readStoredSessionEvents(workspace, imported.sessionId)).events).messages[0]?.content, "一\n二\n三");
    const empty = { id: "only-media", current_node: "media", mapping: { media: { parent: null, message: {
      ...message("media", "user", ""), content: { content_type: "image", asset_pointer: "missing" } } } } };
    const before = await listSessionFiles(workspace);
    await writeFile(source, JSON.stringify(empty));
    await assert.rejects(importSessionFile(workspace, source), /没有可导入的公开文本/u);
    assert.deepEqual(await listSessionFiles(workspace), before);
  });
});

test("duplicate source selection IDs and excessive mapping are rejected without guessing", async () => {
  await fixture(async (_root, workspace, source) => {
    assert.throws(() => listChatGptConversations(JSON.stringify([conversation(), conversation()]), source), /ID 重复/u);
    const mapping = Object.fromEntries(Array.from({ length: 50_001 }, (_, index) => [`node-${index}`, { parent: null, message: null }]));
    const raw = JSON.stringify({ id: "large", mapping });
    assert.match(listChatGptConversations(raw, source)[0]!.importError!, /节点数量.*上限/u);
    assert.throws(() => parseSessionImport(raw, source), /节点数量.*上限/u);
    assert.deepEqual(await listSessionFiles(workspace), []);
  });
});
