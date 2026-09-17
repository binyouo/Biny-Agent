import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { renderEmotionPrompt } from "../src/agent/context/emotionPrompt.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { analyzeContextEmotion, EmotionAnalysisScheduler } from "../src/agent/context/emotionAnalysis.js";
import { FatigueService, fatigueLevel, fatigueTimeBonus } from "../src/agent/context/fatigue.js";
import {
  blendEmotion,
  type BlendedEmotion,
  type EmotionState
} from "../src/agent/context/emotionTypes.js";
import {
  buildPromptBundle,
  stableSystemPromptForCache,
  systemPromptForTelemetry
} from "../src/agent/prompts.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { emotionSetBaseCommand, emotionSetContextCommand } from "../src/cli/commands/emotion.js";

const now = new Date("2026-08-30T03:00:00.000Z");

await testBlendEmotion();
await testEmotionStorage();
testEmotionPromptAndSystemPrompt();
await testEmotionCliWritesLocalFiles();
await testFatigueService();
await testEmotionAnalysis();
await testAgentSessionAutoAnalysis();
await testAgentSessionFatigue();
testBuiltInEmotionConfig();
console.log("emotion tests passed");

async function testBlendEmotion(): Promise<void> {
  const base = emotion("平稳", 5, 7, "2026-08-30T02:00:00.000Z", "完成了一段稳定工作");
  const context = emotion("疲惫", 10, 2, "2026-08-30T02:30:00.000Z", "连续处理多个问题");
  const blended = blendEmotion(base, context, 0, now);
  assert.equal(blended.source, "blended");
  assert.equal(blended.mood, "疲惫");
  assert.equal(blended.valence, 8);
  assert.equal(blended.energy, 7);
  assert.equal(blended.trigger, "连续处理多个问题");

  const baseOnly = blendEmotion(
    base,
    undefined,
    0,
    now
  );
  assert.equal(baseOnly.source, "base");
  assert.equal(baseOnly.mood, "平稳");

  const contextOnly = blendEmotion(
    undefined,
    emotion("开心", 8, 8, "2026-08-30T02:30:00.000Z"),
    0,
    now
  );
  assert.equal(contextOnly.source, "context");
  assert.equal(contextOnly.mood, "开心");
  assert.equal(contextOnly.valence, 8);

  const baseExpired = blendEmotion(
    emotion("长期疲惫", 2, 2, "2026-08-29T19:59:59.999Z"),
    undefined,
    0,
    now
  );
  assert.equal(baseExpired.mood, "cheerful");
  assert.equal(baseExpired.valence, 6);

  const contextExpired = blendEmotion(
    base,
    emotion("过期上下文", 1, 1, "2026-08-30T00:59:59.999Z"),
    0,
    now
  );
  assert.equal(contextExpired.source, "blended");
  assert.equal(contextExpired.mood, "cheerful");
  assert.equal(contextExpired.valence, 6);

  const fatigued = blendEmotion(base, undefined, 61, now);
  assert.equal(fatigued.energy, 7);
  assert.equal(fatigued.fatigue, 61);
  assert.equal(blendEmotion(undefined, undefined, 120, now).fatigue, 100);

  const defaultEmotion = blendEmotion(undefined, undefined, 0, now);
  assert.deepEqual(
    {
      mood: defaultEmotion.mood,
      valence: defaultEmotion.valence,
      energy: defaultEmotion.energy,
      fatigue: defaultEmotion.fatigue
    },
    { mood: "cheerful", valence: 7, energy: 7, fatigue: 0 }
  );
}

async function testEmotionStorage(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-test-"));
  const agentDir = path.join(root, "agent");
  let current = now;
  const storage = new EmotionStorage({ configDir: agentDir, now: () => current });
  try {
    await assert.rejects(fs.access(storage.directory), /ENOENT/u);
    await storage.writeBase(emotion("基础", 6, 7, "2026-08-30T02:00:00.000Z", "全局原因"));
    await storage.writeContext(
      "session/one",
      emotion("上下文", 3, 5, "2026-08-30T02:30:00.000Z", "本轮原因")
    );
    assert.equal((await storage.readBase())?.mood, "基础");
    assert.equal((await storage.readContext("session/one"))?.trigger, "本轮原因");
    const blended = await storage.readBlended("session/one", 0);
    assert.equal(blended.mood, "上下文");
    assert.equal(blended.valence, 5);

    const baseDocument = await fs.readFile(path.join(storage.directory, "base.md"), "utf8");
    assert.match(baseDocument, /^---\nmood: 基础\nvalence: 6\nenergy: 7\nupdated: 2026-08-30T02:00:00\.000Z\n---\n\n全局原因\n$/u);
    const contextDirectory = path.join(storage.directory, "context");
  const contextFiles = await fs.readdir(contextDirectory);
  assert.deepEqual(contextFiles, ["session-one.md"]);
  assert.equal(contextFiles.some((file) => file.endsWith(".tmp")), false);
  const contextDocument = await fs.readFile(path.join(contextDirectory, "session-one.md"), "utf8");
  assert.doesNotMatch(contextDocument, /^energy:/mu, "context 文件只保存 mood/valence/updated");

    await fs.writeFile(path.join(storage.directory, "base.md"), "not markdown", "utf8");
    assert.equal(await storage.readBase(), undefined);
    current = new Date("2026-08-30T06:00:00.000Z");
    assert.equal((await storage.readContext("session/one"))?.mood, "上下文");
    await fs.writeFile(
      path.join(contextDirectory, "session-one.md"),
      "---\nmood: 外部上下文\nvalence: 8\nupdated: 2026-08-30T05:59:00.000Z\n---\n\n外部触发\n",
      "utf8"
    );
    assert.equal((await storage.readContext("session/one"))?.mood, "外部上下文");
    await fs.writeFile(path.join(contextDirectory, "session-one.md"), "---\nmood: broken\n---\n", "utf8");
    assert.equal(await storage.readContext("session/one"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testEmotionCliWritesLocalFiles(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-cli-test-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = root;
  try {
    await emotionSetBaseCommand("专注", "8", "6", ["完成一轮整理"]);
    await emotionSetContextCommand("chat-one", "轻松", "7", ["用户反馈明确"]);
    const storage = new EmotionStorage({ configDir: root });
    assert.equal((await storage.readBase())?.mood, "专注");
    assert.equal((await storage.readContext("chat-one"))?.mood, "轻松");
    const contextDocument = await fs.readFile(path.join(root, "emotions", "context", "chat-one.md"), "utf8");
    assert.doesNotMatch(contextDocument, /^energy:/mu);
  } finally {
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function testEmotionPromptAndSystemPrompt(): void {
  const blended: BlendedEmotion = {
    ...emotion("疲惫", 5, 4, "2026-08-30T02:30:00.000Z", "凌晨三点还在干活，有点累"),
    fatigue: 30,
    source: "base"
  };
  const emotionPrompt = renderEmotionPrompt(blended);
  assert.match(emotionPrompt, /<biny_emotion mood="疲惫" valence="5" energy="4" fatigue="30">/u);
  assert.match(emotionPrompt, /EMOTION — A layered state/u);
  assert.match(emotionPrompt, /The user's real needs and confirmed facts still matter/u);
  assert.match(emotionPrompt, /FATIGUE & SLEEP STATE: 😪 TIRED/u);
  assert.doesNotMatch(emotionPrompt, /SLEEPING/u);
  assert.doesNotMatch(emotionPrompt, /Task/u);
  assert.doesNotMatch(emotionPrompt, /cannot take it on right now/u);
  const sleepingPrompt = renderEmotionPrompt({ ...blended, fatigue: 80 });
  assert.match(sleepingPrompt, /FATIGUE & SLEEP STATE: 💤 SLEEPING/u);
  assert.match(sleepingPrompt, /Task/u);
  assert.match(sleepingPrompt, /cannot take it on right now/u);
  assert.match(sleepingPrompt, /cannot grant, revoke, or modify work permissions/u);
  assert.match(emotionPrompt, /cannot grant, revoke, or modify work permissions/u);
  assert.match(emotionPrompt, /level=tired/u);
  assert.match(emotionPrompt, /凌晨三点还在干活，有点累/u);

  const promptBundle = buildPromptBundle({
    cwd: "/tmp/workspace",
    identityPrompt: "private identity text",
    emotionPrompt
  });
  assert.equal(promptBundle.systemPrompt.indexOf("<!-- biny-emotion:start -->"), -1);
  assert.match(promptBundle.turnContext, /<!-- biny-emotion:start -->/u);
  const stable = stableSystemPromptForCache(promptBundle.systemPrompt);
  assert.doesNotMatch(stable, /biny-emotion/u);
  assert.doesNotMatch(stable, /凌晨三点还在干活/u);
  const telemetry = systemPromptForTelemetry(promptBundle.systemPrompt);
  assert.ok(telemetry);
  assert.doesNotMatch(telemetry, /<biny_emotion omitted="true" \/>/u);
  assert.doesNotMatch(telemetry, /凌晨三点还在干活/u);
  assert.doesNotMatch(telemetry, /private identity text/u);
}

async function testFatigueService(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-fatigue-test-"));
  let current = new Date(2026, 7, 30, 10, 0, 0, 0);
  const service = new FatigueService({ agentDir: root, now: () => current });
  try {
    await service.initialize();
    const first = await service.recordMessage();
    assert.equal(first.fatigue, 2);
    assert.equal(first.messageCount, 1);
    current = new Date(current.getTime() + 10 * 60_000);
    assert.equal(service.status().fatigue, 0, "fatigue decays at 0.8 per minute");

    const restarted = new FatigueService({ agentDir: root, now: () => current });
    assert.equal((await restarted.currentStatus()).messageCount, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "fatigue.json"), "utf8")).messageCount, 1);
    assert.equal(fatigueTimeBonus(new Date(2026, 7, 30, 2)), 30);
    assert.equal(fatigueTimeBonus(new Date(2026, 7, 30, 23)), 15);
    assert.equal(fatigueTimeBonus(new Date(2026, 7, 30, 13)), 8);
    assert.equal(fatigueLevel(29), "awake");
    assert.equal(fatigueLevel(30), "tired");
    assert.equal(fatigueLevel(50), "sleepy");
    assert.equal(fatigueLevel(75), "sleeping");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testEmotionAnalysis(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-analysis-test-"));
  const current = new Date("2026-08-30T10:00:00.000Z");
  const storage = new EmotionStorage({ configDir: root, now: () => current });
  let promptText = "";
  let output = JSON.stringify({ mood: "专注", valence: 8, reason: "用户目标明确" });
  const model: AgentModel = {
    provider: "test",
    modelId: "emotion-analysis-test",
    stream: async ({ messages }) => {
      promptText = JSON.stringify(messages);
      return (async function* () {
        yield { type: "text-delta" as const, text: output };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  let scheduled: (() => void) | undefined;
  const scheduler = new EmotionAnalysisScheduler({
    delayMs: 5_000,
    analyze: async (sessionId, _signal, messageId) => { scheduledCalls.push(`${sessionId}:${messageId ?? ""}`); },
    timers: {
      setTimeout: (callback) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined
    }
  });
  const scheduledCalls: string[] = [];
  try {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: index === 11 ? "L".repeat(200) : `message-${String(index)}`
    }));
    const updated = await analyzeContextEmotion({
      sessionId: "session-one",
      storage,
      getModel: () => model,
      getMessages: async () => messages,
      now: () => current
    });
    assert.equal(updated?.mood, "专注");
    assert.equal(updated?.valence, 8);
    assert.equal(updated?.energy, 7);
    assert.match(promptText, /message-10/u);
    assert.doesNotMatch(promptText, /message-0/u, "only the most recent ten messages are analyzed");
    assert.match(promptText, /L{150}/u);
    assert.doesNotMatch(promptText, /L{151}/u, "each message is capped at 150 characters");
    assert.equal(await analyzeContextEmotion({
      sessionId: "session-one",
      storage,
      getModel: () => model,
      getMessages: async () => messages,
      now: () => current
    }), undefined, "unchanged context does not rewrite the snapshot");

    scheduler.schedule("session-one", "message-one");
    scheduler.schedule("session-one", "message-two");
    scheduled?.();
    await Promise.resolve();
    assert.deepEqual(scheduledCalls, ["session-one:message-two"]);
    scheduler.schedule("session-one", "message-three");
    const cancelledCallback = scheduled;
    scheduler.cancel();
    cancelledCallback?.();
    await Promise.resolve();
    assert.deepEqual(scheduledCalls, ["session-one:message-two"], "cancel aborts pending analysis");

    output = "not json";
    await assert.rejects(analyzeContextEmotion({
      sessionId: "session-one",
      storage,
      getModel: () => model,
      getMessages: async () => messages,
      now: () => current
    }));
  } finally {
    scheduler.cancel();
    await rm(root, { recursive: true, force: true });
  }
}

async function testAgentSessionAutoAnalysis(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-auto-session-test-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(workspaceRoot, "agent");
  const model: AgentModel = {
    provider: "test",
    modelId: "emotion-auto-test",
    stream: async ({ messages }) => {
      const requestText = JSON.stringify(messages);
      const output = requestText.includes("Analyze the recent conversation")
        ? JSON.stringify({ mood: "专注", valence: 8, reason: "用户目标明确" })
        : "ok";
      return (async function* () {
        yield { type: "text-delta" as const, text: output };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "emotion-auto-test",
    providers: { test: { type: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" } },
    models: { "emotion-auto-test": { provider: "test", model: "emotion-auto-test" } },
    context: {
      ...defaultConfig.context,
      memory: {
        ...defaultConfig.context.memory,
        enabled: false,
        useMemories: false,
        generateMemories: false
      }
    }
  });
  await ensureAgentDirs(workspaceRoot);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    recorder: new SessionRecorder(workspaceRoot)
  });
  await agent.initialize();
  try {
    assert.equal((await agent.runTask("请分析这轮对话的情绪")).status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 5_250));
    const storage = new EmotionStorage({ configDir: path.join(workspaceRoot, "agent") });
    assert.equal((await storage.readContext(agent.getInfo().sessionId))?.mood, "专注");
    const events = await fs.readFile(agent.getInfo().sessionFile, "utf8");
    assert.match(events, /"type":"message_metadata"/u);
    assert.match(events, /"emotionUpdated":true/u);
    assert.equal(await fs.stat(path.join(workspaceRoot, "agent", "emotions", "base.md")).then(() => true, () => false), false);
  } finally {
    await agent.close();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testAgentSessionFatigue(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-session-test-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(workspaceRoot, "agent");
  await ensureAgentDirs(workspaceRoot);
  const model: AgentModel = {
    provider: "test",
    modelId: "emotion-test",
    stream: async () => (async function* () {
      yield { type: "start" as const };
      yield { type: "text-delta" as const, text: "ok" };
      yield { type: "finish" as const, reason: "stop" as const };
    })()
  };
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "emotion-test",
    providers: { test: { type: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" } },
    models: { "emotion-test": { provider: "test", model: "emotion-test" } },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    recorder: new SessionRecorder(workspaceRoot)
  });
  await agent.initialize();
  try {
    const outcome = await agent.runTask("完成一轮情绪测试");
    assert.equal(outcome.status, "completed");
    assert.ok(agent.getFatigue() >= 1);
    const fatigueDocument = JSON.parse(await fs.readFile(path.join(workspaceRoot, "agent", "fatigue.json"), "utf8")) as { fatigue: number; messageCount: number };
    assert.equal(fatigueDocument.fatigue, 1.5);
    assert.equal(fatigueDocument.messageCount, 1);
    await agent.startNewSession();
    assert.ok(agent.getFatigue() >= 1);
    const persistedAfterNewSession = JSON.parse(await fs.readFile(path.join(workspaceRoot, "agent", "fatigue.json"), "utf8")) as { messageCount: number };
    assert.equal(persistedAfterNewSession.messageCount, 1);
  } finally {
    await agent.close();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function testBuiltInEmotionConfig(): void {
  const parsed = configSchema.parse(defaultConfig);
  assert.equal("emotion" in parsed.context, false);
  // heartbeat 回归用户配置，默认关闭（稳定的默认行为）。
  assert.equal(parsed.heartbeat.enabled, false);
}

function emotion(
  mood: string,
  valence: number,
  energy: number,
  updatedAt: string,
  trigger?: string
): EmotionState {
  return { mood, valence, energy, updatedAt, trigger };
}
