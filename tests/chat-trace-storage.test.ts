/** 真实会话落盘→Desktop 只读读取→Trace 投影；不启动 Runtime/模型。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createFileConfigStore } from "../src/config/store.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
test("Trace 只读链路返回完整请求且不改写会话，不能跨项目读取", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-trace-read-"));
  try {
    const workspace = path.join(root, "workspace"); await mkdir(workspace);
    const state = new DesktopStateStore(path.join(root, "state.json")); await state.load();
    const projects = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "data")), createFileConfigStore({ workspaceRoot: workspace }));
    const project = await projects.createProject(workspace);
    const recorder = new SessionRecorder(workspace, "trace-test");
    recorder.record({type:"user_message",content:"hello",messageId:"u"});
    recorder.record({type:"model_request",metrics:{requestId:"r",provider:"local",modelId:"test",durationMs:1000,startedAt:"2026-09-25T00:00:00Z",attempts:[],eventCount:1,finishReason:"stop",usage:{inputTokens:10,outputTokens:2,totalTokens:12},requestContext:{operation:"agent"}}});
    recorder.record({type:"assistant_message",content:"done",messageId:"a",replyToMessageId:"u"});
    await recorder.close();
    const before = await readFile(recorder.filePath);
    const document = await projects.openSession(project, recorder.sessionId, [], new Map());
    assert.equal(buildSessionTimeline(document.events,[])[0]?.modelRequests?.[0]?.usage?.totalTokens,12);
    assert.deepEqual(await readFile(recorder.filePath),before);
    const otherDir = path.join(root,"other");await mkdir(otherDir);
    const other = await projects.createProject(otherDir);
    await assert.rejects(projects.openSession(other,recorder.sessionId,[],new Map()), /Session not found/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
