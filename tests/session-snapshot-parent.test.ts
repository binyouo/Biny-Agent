/** 快照恢复、模型输出、落盘与聊天投影共用真实消息父链。 */
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { clearSessionParseCache, sessionFileFingerprint } from "../src/session/parseCache.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { tryReadSessionSnapshot, writeSessionSnapshot } from "../src/session/sessionSnapshot.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const mode of ["cold", "snapshot", "selected"] as const) {
  const selectedVersion = mode === "selected";
  test(`${mode} 长会话恢复后继续发送保留${selectedVersion ? "已选择版本" : "末条回答"}的父链`, async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-snapshot-parent-"));
    await ensureAgentDirs(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot);
    let agent: AgentSession | undefined;
    try {
      recorder.record({ type: "user_message", content: "第一条消息", messageId: "user-first" });
      recorder.record({ type: "agent_message", messageId: "answer-first", slotId: "user-first", parentMessageId: "user-first",
        message: { role: "assistant", content: [{ type: "text", text: "第一条回答" }], stopReason: "stop" } });
      recorder.record({ type: "assistant_message", content: "第一条回答", messageId: "answer-first", replyToMessageId: "user-first", slotId: "user-first" });
      if (selectedVersion) {
        recorder.record({ type: "agent_message", messageId: "answer-alternative", slotId: "user-first", parentMessageId: "user-first",
          message: { role: "assistant", content: [{ type: "text", text: "另一版本" }], stopReason: "stop" } });
        recorder.record({ type: "assistant_message", content: "另一版本", messageId: "answer-alternative", replyToMessageId: "user-first", slotId: "user-first" });
        recorder.record({ type: "message_version_selected", messageId: "answer-first", slotId: "user-first" });
      }
      await recorder.close();
      // 历史中的大块诊断不进入模型上下文，但计入完整会话文件大小。
      const diagnostic = JSON.stringify({ type: "error", message: "历史诊断", detail: "x".repeat(512 * 1024) }) + "\n";
      await appendFile(recorder.filePath, diagnostic.repeat(34));
      assert.ok((await stat(recorder.filePath)).size > 16 * 1024 * 1024);
      const replay = await replaySession(recorder.filePath);
      const fingerprint = sessionFileFingerprint(await stat(recorder.filePath));
      if (mode !== "cold") {
        await writeSessionSnapshot(recorder.filePath, fingerprint, replay);
        assert.ok(await tryReadSessionSnapshot(recorder.filePath, fingerprint), "必须命中快照而非完整重放");
      }
      clearSessionParseCache();
      const config = configSchema.parse({ ...defaultConfig,
        context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } } });
      const model: AgentModel = { provider: "test", modelId: "snapshot-parent", supportsTools: false,
        async stream() { return (async function* () {
          yield { type: "text-delta" as const, text: "第二条回答" };
          yield { type: "finish" as const, reason: "stop" as const };
        })(); } };
      agent = new AgentSession({ workspaceRoot, config, model, toolRegistry: new ToolRegistry(),
        permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(workspaceRoot) });
      await agent.initialize();
      await agent.resume(recorder.sessionId);
      for await (const event of agent.prompt("第二条消息")) {
        if (event.type === "done") assert.equal(event.outcome.status, "completed");
      }
      await agent.close();
      agent = undefined;
      const events = await readSessionEvents(recorder.filePath);
      const nextUser = events.find((event) => event.type === "user_message" && event.content === "第二条消息");
      assert.ok(nextUser?.type === "user_message");
      assert.equal(nextUser.parentMessageId, "answer-first", "快照中空 events 不能清掉活动父消息，也不能选择未激活版本");
      const timeline = buildSessionTimeline(events, []);
      assert.deepEqual(timeline.map((turn) => turn.assistant), ["第一条回答", "第二条回答"]);
      assert.deepEqual(timeline.map((turn) => turn.user), ["第一条消息", "第二条消息"]);
    } finally {
      await agent?.close();
      await recorder.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}
