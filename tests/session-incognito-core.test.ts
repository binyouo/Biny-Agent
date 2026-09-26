/** 无痕会话的 catalog 真值、分支继承和 Agent 自动记忆门禁。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV, globalAgentDir } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import {
  getSessionCatalogItem, readSessionCatalogRecord, readSessionCatalogRecordForFile,
  readSessionCatalogRecordForFileSync,
  sessionCatalogRecordRevision, updateSessionCatalogMetadata
} from "../src/session/catalog.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionMessageMetadata } from "../src/session/messageTree.js";
import { forkSession } from "../src/session/fork.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-incognito-core-"));
const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
const workspace = path.join(root, "workspace");
try {
  await (await import("node:fs/promises")).mkdir(workspace);
  await ensureAgentDirs(workspace);
  const config = structuredClone(defaultConfig);
  config.context.memory.enabled = true;
  config.context.memory.useMemories = true;
  config.context.memory.generateMemories = true;
  const model: AgentModel = { provider: "fixture", modelId: "incognito", stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: "收到" };
    yield { type: "finish", reason: "stop" };
  })() };
  const recorder = new SessionRecorder(workspace);
  const agent = new AgentSession({ workspaceRoot: workspace, initialIsIncognito: true,
    config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder });
  try {
    await agent.initialize();
    assert.equal(await agent.getSessionIncognito(), true);
    assert.equal((await agent.getPersonalizationState()).resolved.useMemories, false);
    const initialRecord = await readSessionCatalogRecord(workspace, recorder.sessionId);
    assert.ok(initialRecord);
    await agent.updateSessionIncognito(false, sessionCatalogRecordRevision(initialRecord));
    assert.equal((await agent.getPersonalizationState()).resolved.useMemories, true);
    const sharedRecord = await readSessionCatalogRecord(workspace, recorder.sessionId);
    assert.ok(sharedRecord);
    await agent.updateSessionIncognito(true, sessionCatalogRecordRevision(sharedRecord));
    assert.equal((await readSessionCatalogRecord(workspace, recorder.sessionId))?.isIncognito, true);
    assert.equal((await readSessionCatalogRecordForFile(recorder.filePath, recorder.sessionId))?.isIncognito, true);
    assert.equal(readSessionCatalogRecordForFileSync(recorder.filePath, recorder.sessionId)?.isIncognito, true);
    await assert.rejects(readSessionCatalogRecordForFile(recorder.filePath, "wrong-session"), /session/i);
    const incognitoState = await agent.getPersonalizationState();
    assert.equal(incognitoState.resolved.useMemories, false);
    assert.equal(incognitoState.resolved.contributeMemories, false);
    await agent.updateChatPersonalization({ useMemories: true, contributeMemories: true }, incognitoState.catalogRevision);
    const overridden = await agent.getPersonalizationState();
    assert.equal(overridden.resolved.useMemories, false);
    assert.equal(overridden.resolved.contributeMemories, false);
    const stages: string[] = [];
    for await (const event of agent.prompt("无痕消息照常保存")) {
      if (event.type === "preparation.updated") stages.push(event.stage);
    }
    assert.ok(!stages.includes("memory"));
    assert.ok((await readSessionEvents(recorder.filePath)).some((event) => event.type === "user_message" && event.content === "无痕消息照常保存"));
    assert.equal((await getSessionCatalogItem(workspace, recorder.sessionId))?.isIncognito, true);
  } finally {
    await agent.close();
  }
  const privateEvents = await readSessionEvents(recorder.filePath);
  const privateAnswer = privateEvents.find((event) => event.type === "assistant_message" && event.messageId);
  assert.ok(privateAnswer?.messageId);
  assert.equal(sessionMessageMetadata(privateEvents, privateAnswer.messageId).memoryExtracted, true,
    "无痕成功回合应记录自动记忆已处理，避免恢复时误当作待抽取");
  const forked = await forkSession(workspace, recorder.sessionId);
  assert.equal((await readSessionCatalogRecord(workspace, forked.sessionId))?.isIncognito, true);
  const disabledRecorder = new SessionRecorder(workspace);
  const disabledConfig = structuredClone(config);
  disabledConfig.context.memory.generateMemories = false;
  let disabledExtractionCalls = 0;
  const disabledModel: AgentModel = { ...model, stream: async (...args) => {
    if (args[0].systemPrompt?.includes("memory management assistant")) disabledExtractionCalls += 1;
    return await model.stream(...args);
  } };
  const disabledAgent = new AgentSession({ workspaceRoot: workspace, config: disabledConfig, model: disabledModel,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...disabledConfig.permission, source: "test" }), recorder: disabledRecorder });
  try {
    await disabledAgent.initialize();
    assert.equal((await disabledAgent.runTask("已关闭自动记忆贡献")).status, "completed");
  } finally {
    await disabledAgent.close();
  }
  const disabledEvents = await readSessionEvents(disabledRecorder.filePath);
  const disabledAnswer = disabledEvents.find((event) => event.type === "assistant_message" && event.messageId);
  assert.ok(disabledAnswer?.messageId);
  assert.equal(sessionMessageMetadata(disabledEvents, disabledAnswer.messageId).memoryExtracted, true,
    "自动贡献关闭的成功回合也应记录已处理状态");
  assert.equal(disabledExtractionCalls, 0, "关闭自动贡献不能调用提取模型");
  const reopenedRecorder = new SessionRecorder(workspace, recorder.sessionId, recorder.filePath);
  const reopened = new AgentSession({ workspaceRoot: workspace, config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder: reopenedRecorder });
  try {
    await reopened.initialize();
    assert.equal(await reopened.getSessionIncognito(), true);
    assert.equal((await reopened.getPersonalizationState()).resolved.useMemories, false);
    assert.equal((await reopened.runTask("恢复后仍无痕")).status, "completed");
    const record = await readSessionCatalogRecord(workspace, recorder.sessionId);
    assert.ok(record);
    await updateSessionCatalogMetadata(workspace, recorder.sessionId, { isIncognito: false }, sessionCatalogRecordRevision(record));
    assert.equal((await reopened.getPersonalizationState()).resolved.useMemories, true);
    const newSessionId = await reopened.startNewSession({ isIncognito: true });
    assert.equal((await readSessionCatalogRecord(workspace, newSessionId))?.isIncognito, true);
    assert.equal((await reopened.getPersonalizationState()).resolved.useMemories, false);
  } finally {
    await reopened.close();
  }
  assert.equal((await readSessionCatalogRecord(workspace, forked.sessionId))?.isIncognito, true);
  const legacy = new SessionRecorder(workspace);
  legacy.record({ type: "user_message", content: "legacy" });
  await legacy.close();
  assert.equal((await getSessionCatalogItem(workspace, legacy.sessionId))?.isIncognito, false);
  assert.equal(readSessionCatalogRecordForFileSync(legacy.filePath, legacy.sessionId), undefined);
  const nestedDirectory = path.join(path.dirname(legacy.filePath), "2026", "09", "26");
  await mkdir(nestedDirectory, { recursive: true });
  const nestedFile = path.join(nestedDirectory, path.basename(legacy.filePath));
  await rename(legacy.filePath, nestedFile);
  assert.equal(readSessionCatalogRecordForFileSync(nestedFile, legacy.sessionId), undefined);
  const alias = path.join(globalAgentDir(), "sessions", "incognito-alias");
  await symlink(path.dirname(recorder.filePath), alias);
  assert.throws(() => readSessionCatalogRecordForFileSync(path.join(alias, `${recorder.sessionId}.jsonl`), recorder.sessionId), /outside|real directory/u);
  await rm(alias);
  const malformed = path.join(path.dirname(legacy.filePath), ".catalog", `${legacy.sessionId}.json`);
  await mkdir(path.dirname(malformed), { recursive: true });
  await writeFile(malformed, "{invalid-json", "utf8");
  assert.throws(() => readSessionCatalogRecordForFileSync(nestedFile, legacy.sessionId));

  // 模拟另一个进程在后台 embedding 检查悬挂期间切换无痕；写入前必须重读持久状态。
  const racingRecorder = new SessionRecorder(workspace);
  const racingAgent = new AgentSession({ workspaceRoot: workspace, config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder: racingRecorder });
  let enteredEmbedding!: () => void;
  const entered = new Promise<void>((resolve) => { enteredEmbedding = resolve; });
  let releaseEmbedding!: () => void;
  const embeddingGate = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
  racingAgent.getEmbeddingRuntime = async () => {
    enteredEmbedding();
    await embeddingGate;
    return undefined;
  };
  try {
    await racingAgent.initialize();
    assert.equal((await racingAgent.runTask("竞争中的自动记忆候选")).status, "completed");
    await Promise.race([entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("embedding gate not reached")), 3_000))]);
    await updateSessionCatalogMetadata(workspace, racingRecorder.sessionId, { isIncognito: true });
    releaseEmbedding();
  } finally {
    releaseEmbedding();
    await racingAgent.close();
  }
  const gatedEvents = await readSessionEvents(racingRecorder.filePath);
  assert.equal(gatedEvents.some((event) => event.type === "message_metadata"
    && event.metadata?.memoryExtracted === true), true,
  "embedding 检查后切为无痕且尚未写事实时，空结果也应记录已处理");
  assert.equal(gatedEvents.some((event) => event.type === "message_metadata" && event.metadata?.createdMemories), false);

  let enteredExtraction!: () => void;
  const extractionEntered = new Promise<void>((resolve) => { enteredExtraction = resolve; });
  let releaseExtraction!: () => void;
  const extractionGate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
  const extractionModel: AgentModel = { provider: "fixture", modelId: "incognito-extraction", stream: async (context) => {
    const extracting = JSON.stringify(context.messages).includes("Extract memories from this conversation:");
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      if (extracting) {
        enteredExtraction();
        await extractionGate;
      }
      yield { type: "text-delta", text: extracting
        ? '[{"operation":"add","content":"A durable memory from the extracted conversation.","durability":"permanent"}]'
        : "收到" };
      yield { type: "finish", reason: "stop" };
    })();
  } };
  const extractionRecorder = new SessionRecorder(workspace);
  const extractionAgent = new AgentSession({ workspaceRoot: workspace, config, model: extractionModel, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder: extractionRecorder });
  extractionAgent.getEmbeddingRuntime = async () => ({
    fingerprint: "incognito-fixture",
    descriptor: { ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "incognito-fixture",
      displayName: "fixture", recommendedThreshold: 0.5, source: "local", dimensions: 2 },
    embed: async () => ({ embeddings: [new Float32Array([1, 0])], dimensions: 2, fingerprint: "incognito-fixture",
      model: { kind: "local", model: "multilingual-e5-small" } })
  });
  try {
    await extractionAgent.initialize();
    assert.equal((await extractionAgent.runTask("让模型提取长期记忆")).status, "completed");
    await Promise.race([extractionEntered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("extraction gate not reached")), 3_000))]);
    await updateSessionCatalogMetadata(workspace, extractionRecorder.sessionId, { isIncognito: true });
    releaseExtraction();
  } finally {
    releaseExtraction();
    await extractionAgent.close();
  }
  assert.equal((await readSessionEvents(extractionRecorder.filePath)).some((event) => event.type === "message_metadata"
    && event.metadata?.memoryExtracted === true), false);
} finally {
  if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
  await rm(root, { recursive: true, force: true });
}
console.log("session incognito core tests passed");
