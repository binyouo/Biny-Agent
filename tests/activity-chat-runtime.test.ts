/** 真实 AgentSession 请求链路：Activity 只在本轮提供引用，关闭后连日报派生段也不可见。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { writeDailyActivityNote } from "../src/activity/dailyNotes.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-chat-runtime-"));
const previousRoot = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
const workspace = path.join(root, "workspace");
const store = new ActivityStore();
try {
  const activityDirectory = path.join(root, "activity-records");
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  await store.open(activityDirectory, process.env[BINY_AGENT_DIR_ENV]!);
  const started = new Date(Date.now() - 60 * 60_000).toISOString();
  const sessionId = store.startSession(started);
  await store.recordFallbackCapture({ sessionId, occurredAt: started, eventType: "fallback_capture",
    rawOcrText: "OCR_SECRET_831 登录排查", jpeg: Buffer.from("fixture") });
  const frame = store.listOcrEmbeddingSources("activity-runtime-fixture")[0]!;
  store.upsertOcrEmbedding(frame.id, "activity-runtime-fixture", new Float32Array([1, 0]), started);
  store.endSession(sessionId, new Date(Date.parse(started) + 20 * 60_000).toISOString());
  store.recordAnalysis(analysis(sessionId));

  const config = testConfig(activityDirectory);
  const requests: ModelStreamContext[] = [];
  const recorder = new SessionRecorder(workspace);
  const agent = new AgentSession({
    workspaceRoot: workspace, config, model: captureModel(requests),
    getActivityEmbeddingRuntime: async () => fakeRuntime(),
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
    recorder
  });
  try {
    await agent.initialize();
    assert.equal((await agent.runTask("上次登录排查结论是什么")).status, "completed");
    const first = requestText(requests.at(-1)?.messages ?? []);
    assert.match(first, /登录排查完成/u);
    assert.doesNotMatch(first, /OCR_SECRET_831/u);
    const events = await readSessionEvents(recorder.filePath);
    assert.equal(events.find((event) => event.type === "user_message")?.content, "上次登录排查结论是什么");

    assert.equal((await agent.runTask("问")).status, "completed");
    assert.doesNotMatch(requestText(requests.at(-1)?.messages ?? []), /登录排查完成/u,
      "上一轮 Activity 引用不得保留在对话历史");
  } finally {
    await agent.close();
  }

  const date = new Date();
  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  await writeDailyActivityNote(dateKey, "仅在活动记录中出现的日报私有文字");
  const disabled = testConfig(activityDirectory);
  disabled.activity.enabled = false;
  const disabledRequests: ModelStreamContext[] = [];
  const disabledAgent = new AgentSession({ workspaceRoot: workspace, config: disabled,
    model: captureModel(disabledRequests), toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...disabled.permission, source: "test" }),
    recorder: new SessionRecorder(workspace) });
  try {
    await disabledAgent.initialize();
    assert.equal((await disabledAgent.runTask("你好")).status, "completed");
    assert.doesNotMatch(requestText(disabledRequests.at(-1)?.messages ?? []), /登录排查完成|日报私有文字/u);
    assert.doesNotMatch(disabledRequests.at(-1)?.systemPrompt ?? "", /## Activity Recorder/u);
  } finally {
    await disabledAgent.close();
  }
} finally {
  await store.close();
  if (previousRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousRoot;
  await rm(root, { recursive: true, force: true });
}

function requestText(messages: readonly AgentMessage[]): string {
  return messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string"
    ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
}

function captureModel(requests: ModelStreamContext[]): AgentModel {
  return { provider: "fixture", modelId: "activity-chat-runtime", stream: async (context) => {
    requests.push({ ...context, messages: [...context.messages] });
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: "收到" };
      yield { type: "finish", reason: "stop" };
    })();
  } };
}

function fakeRuntime(): EmbeddingModelRuntime {
  return {
    fingerprint: "activity-runtime-fixture",
    descriptor: { ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "activity-runtime-fixture",
      displayName: "fixture", recommendedThreshold: 0.75, source: "local", dimensions: 2 },
    embed: async () => ({ embeddings: [new Float32Array([1, 0])], dimensions: 2,
      fingerprint: "activity-runtime-fixture", model: { kind: "local", model: "multilingual-e5-small" } })
  };
}

function testConfig(activityDirectory: string): AgentConfig {
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.activity.outputDirectory = activityDirectory;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  return config;
}

function analysis(sessionId: string): ActivitySessionAnalysis {
  return { sessionId, analyzedAt: new Date().toISOString(), analyzerModel: "fixture", project: "Biny",
    title: "登录排查完成", description: "定位到配置差异", summary: "登录排查完成，定位到配置差异",
    topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
    worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard", confidence: 1,
    sourceEventCount: 3, inputHash: `activity-chat-runtime-${sessionId}` };
}
