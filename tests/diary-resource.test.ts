/** 问候不产生工作日记；显式生成的日记仍可通过 Desktop 预览；模型只替换外部边界。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeDailyMemoryNote } from "../src/activity/dailyNotes.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-diary-resource-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "global");
try {
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  await ensureAgentDirs(workspaceRoot);
  const config = configSchema.parse({ ...defaultConfig, context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } } });
  const model: AgentModel = { provider: "test", modelId: "diary-resource", async *stream() {
    for (const text of "hey~ what's up?\n\n</think>\nPrivate reasoning") yield { type: "text-delta", text };
    yield { type: "finish", reason: "stop" };
  } };
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({ workspaceRoot, config, model, recorder, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission) });
  try {
    await agent.initialize();
    let outcome;
    let visible = "";
    for await (const event of agent.prompt("hi")) {
      if (event.type === "assistant.delta") visible += event.content;
      if (event.type === "done") outcome = event.outcome;
    }
    assert.equal(visible.trim(), "hey~ what's up?");
    assert.equal(outcome?.status, "completed");
    const events = await readSessionEvents(recorder.filePath);
    const turn = buildSessionTimeline(events, []).at(-1)!;
    const projector = createSessionTimelineProjector();
    assert.deepEqual(projector.update({ sessionId: recorder.sessionId, events, liveEvents: [] }), buildSessionTimeline(events, []));
    assert.equal(turn.assistant.trim(), "hey~ what's up?");
    assert.equal("diaryPath" in turn, false, "成功问候不能触发日记卡片");
    await assert.rejects(readFile(path.join(root, "global", "memory", "2026-09-22.md")), { code: "ENOENT" });
    assert.equal(events.some((event) => event.type === "message_metadata" && event.metadata.diaryPath), false);
    // 单独验证真实存在的文件仍可阅读；不再用聊天完成来伪造文件产出。
    const diaryPath = await writeDailyMemoryNote("2026-09-22", "已完成并验证今天的修改。", { configDir: path.join(root, "global") });

    const storage = new DesktopUserDataStore(path.join(root, "desktop"));
    await storage.initialize();
    const state = new DesktopStateStore(path.join(root, "state.json"));
    await state.load();
    const projects = new DesktopProjectService(state, storage, createFileConfigStore(root, { globalDir: process.env.BINY_AGENT_DIR }));
    const project = await projects.createProject(workspaceRoot);
    assert.equal(projects.workspaceFile(project, diaryPath), await realpath(diaryPath), "系统应用打开与文件预览共用同一条日记路径");
    const preview = await projects.readWorkspaceFile(project, diaryPath);
    assert.equal(preview.path, diaryPath);
    assert.match(preview.content!, /已完成并验证今天的修改/u);
    await assert.rejects(projects.readWorkspaceFile(project, path.join(root, "global", "config.json")), /escapes workspace/u);
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    const link = path.join(root, "global", "memory", "2000-01-01.md");
    await symlink(outside, link);
    await assert.rejects(projects.readWorkspaceFile(project, link), /symbolic link/u);
    await rm(diaryPath);
    await assert.rejects(projects.readWorkspaceFile(project, diaryPath), { code: "ENOENT" });

  } finally { await agent.close(); }
  console.log("diary resource end-to-end tests passed");
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
