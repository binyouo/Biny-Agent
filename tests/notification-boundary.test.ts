/** 通知协议只能进入通知元数据；真实投影入口、工具审计和多步执行都不能泄漏到正文。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig, configSchema } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import type { SessionEvent } from "../src/session/events.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { publicAssistantMessage } from "../src/session/publicMessage.js";
import { activitySummaryText } from "../src/runtime/activitySummary.js";
import { createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { sessionEventsToTranscript } from "../src/tui/sessionTranscript.js";
import { summarizeSessionEvents } from "../src/session/events.js";
import { archiveConversationMarkdown } from "../src/session/markdownArchive.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
import { exportSessionClaudeCode } from "../src/session/transfer.js";

const block = "<biny_notification>内部通知</biny_notification>";
const base = { sessionId: "session", runId: "run", timestamp: "2026-09-22T00:00:00.000Z" };

test("旧记录在 TUI、会话摘要和 Markdown 导出中也隐藏通知，不修改原始文件", async () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "hi", time: base.timestamp },
    { type: "tool_call", tool: "Bash", args: { command: "true" }, assistantContent: `回复${block}`, time: base.timestamp },
    { type: "assistant_message", content: `结束${block}`, time: base.timestamp }
  ];
  assert.doesNotMatch(JSON.stringify(sessionEventsToTranscript(events)), /biny_notification|内部通知/);
  const date = new Date(base.timestamp);
  assert.equal(summarizeSessionEvents("chat.jsonl", events, { birthtime: date, mtime: date })?.lastAssistantMessage, "结束");
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-notification-export-"));
  try {
    const dir = path.join(root, "sessions", "project");
    await mkdir(dir, { recursive: true });
    const source = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(path.join(dir, "chat.jsonl"), source);
    const result = await archiveConversationMarkdown(root);
    assert.equal(result.failed.length, 0);
    assert.doesNotMatch(await readFile(path.join(result.directory, "chat.md"), "utf8"), /biny_notification|内部通知/);
    assert.equal(await readFile(path.join(dir, "chat.jsonl"), "utf8"), source);
    const index = new SessionSearchIndex(root);
    try {
      await index.indexSessionFile("chat", path.join(dir, "chat.jsonl"));
      assert.equal(index.search("内部通知").length, 0);
      assert.doesNotMatch(JSON.stringify(index.search("结束")), /biny_notification|内部通知/);
    } finally { index.close(); }
    // 模拟此前已生成的污染索引：即使不重建，搜索展示也不能漏出被 snippet 截断的协议。
    const database = new DatabaseSync(path.join(root, "search", "sessions.sqlite"));
    try {
      database.prepare("UPDATE session_transcripts SET body = ? WHERE role = 'assistant'").run(`结束${block.repeat(30)}后文`);
    } finally { database.close(); }
    try {
      const hits = index.search("结束");
      assert.equal(hits[0]?.excerpt, "结束后文");
    } finally { index.close(); }
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    await recorder.close();
    await writeFile(recorder.filePath, source);
    const exported = await exportSessionClaudeCode(root, recorder.sessionId);
    assert.doesNotMatch(exported.content, /biny_notification|内部通知/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("通知出现在中间、多次或未闭合时仍不泄漏，也不误删后续正文", () => {
  assert.equal(publicAssistantMessage(`前文${block}后文${block}`), "前文后文");
  assert.equal(publicAssistantMessage("正文<biny_notification>未闭合"), "正文");
  assert.equal(publicAssistantMessage("正文<bin"), "正文");
  assert.equal(publicAssistantMessage("正文<other>保留</other>"), "正文<other>保留</other>");
  assert.equal(activitySummaryText(`正文${block.repeat(20)}后文`), "正文后文");
});

test("实际增量投影在历史工具摘要和逐帧流式输出中统一隐藏通知且不破坏缓存", () => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [
    { type: "user_message", content: "hi", time: base.timestamp },
    { type: "tool_call", tool: "Bash", args: { command: "true" }, assistantContent: `回复${block}`, time: base.timestamp },
    { type: "assistant_message", content: `结束${block}`, time: base.timestamp }
  ];
  const history = projector.update({ sessionId: "history", events, liveEvents: [] });
  assert.doesNotMatch(JSON.stringify(history), /biny_notification|内部通知/);
  assert.equal(projector.update({ sessionId: "history", events, liveEvents: [] })[0], history[0]);
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "hi" },
    { ...base, type: "run.started", messageId: "assistant", model: { alias: "test", provider: "test", label: "test", reasoning: "" } }
  ];
  const empty: SessionEvent[] = [];
  for (const content of ["回复<bin", "y_notification>内部通知", "</biny_notification>", "后文"]) {
    liveEvents.push({ ...base, type: "assistant.delta", content });
    const published = projector.update({ sessionId: "session", events: empty, liveEvents });
    assert.doesNotMatch(JSON.stringify(published), /biny_notification|内部通知|<bin/);
  }
  const final = projector.update({ sessionId: "session", events: empty, liveEvents });
  assert.equal(final[0]?.assistant, "回复后文", "公开快照不能修改流式累积缓冲");
});

test("带通知的工具步经过真实 Agent 入口后，工具审计及最终结果都只保存公开正文", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-notification-boundary-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const tools = new ToolRegistry();
  tools.registerBuiltinTool(createWriteFileTool({ workspaceRoot: root, ignore: [] }));
  let requests = 0;
  const model: AgentModel = {
    provider: "test", modelId: "notification", supportsTools: true,
    async stream(context) {
      requests += 1;
      if (requests > 1) {
        const assistantMessages = context.messages.filter((message) => message.role === "assistant");
        assert.doesNotMatch(JSON.stringify(assistantMessages), /biny_notification|内部通知/);
      }
      const events: ModelStreamEvent[] = requests === 1 ? [
        { type: "text-delta", text: `写入${block}文件` },
        { type: "tool-call", id: "write", name: "Write", arguments: { path: "result.txt", content: "ok" } },
        { type: "finish", reason: "tool-calls" }
      ] : [{ type: "text-delta", text: `已${block}完成` }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* events; })();
    }
  };
  const config = configSchema.parse({ ...defaultConfig, context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } } });
  const agent = new AgentSession({ workspaceRoot: root, config, model, toolRegistry: tools, permissionManager: new PermissionManager(config.permission), recorder });
  try {
    await agent.initialize();
    let completed = false;
    for await (const event of agent.prompt("写入 result.txt", { confirmPermission: async () => ({ approved: true, scope: "once" }) })) {
      if (event.type === "assistant.delta" || event.type === "assistant.completed") assert.doesNotMatch(event.content, /biny_notification|内部通知/);
      if (event.type === "done") {
        assert.equal(event.outcome.status, "completed");
        assert.equal(event.outcome.output, "已完成");
        completed = true;
      }
    }
    assert.ok(completed);
    await recorder.flush();
    assert.equal(await readFile(path.join(root, "result.txt"), "utf8"), "ok");
    const rows = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
    const call = rows.find((row) => row.type === "tool_call");
    assert.ok(call && call.type === "tool_call");
    assert.doesNotMatch(call.assistantContent ?? "", /biny_notification|内部通知/);
    recorder.record({ type: "tool_call", tool: "Write", args: {}, assistantContent: `写入文件${block}` });
    await recorder.flush();
    const last = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent).at(-1);
    assert.ok(last?.type === "tool_call");
    assert.equal(last.assistantContent, "写入文件");
    assert.equal(requests, 2);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});
