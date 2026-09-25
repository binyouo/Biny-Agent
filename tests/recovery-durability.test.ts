/** 用真实文件、公开会话入口及硬退出验证断点故障不会越过执行或终态边界。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { AgentTurnCancellationError } from "../src/agent/types.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

const config = configSchema.parse({
  ...defaultConfig,
  activity: { ...defaultConfig.activity, enabled: false },
  permission: { ...defaultConfig.permission, mode: "full-access" },
  context: {
    ...defaultConfig.context,
    emotion: { ...defaultConfig.context.emotion, enabled: false },
    memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
  }
});

function model(response: () => Promise<ModelStreamEvent[]>): AgentModel {
  return {
    provider: "synthetic", modelId: "durability-test", supportsTools: true,
    stream: async () => {
      const events = await response();
      return (async function* () { yield* events; })();
    }
  };
}

const answer: ModelStreamEvent[] = [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }];

function agent(root: string, recorder: SessionRecorder, provider: AgentModel, tools = new ToolRegistry()): AgentSession {
  return new AgentSession({ workspaceRoot: root, recorder, model: provider, config, toolRegistry: tools, permissionManager: new PermissionManager(config.permission) });
}

async function initialCheckpointFailure(root: string): Promise<void> {
  const recorder = new SessionRecorder(root, "initial-failure");
  const marker = path.join(root, "provider-started");
  const session = agent(root, recorder, model(async () => { await writeFile(marker, "called"); return answer; }));
  try {
    await session.initialize();
    await mkdir(path.join(agentDir(root), "turns", "initial-failure.json"));
    const result = await session.runTask("persist before execution", { emotionAnalysis: false });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /检查点/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const facts = await readSessionEvents(recorder.filePath);
    assert.ok(facts.some((event) => event.type === "user_message" && event.content === "persist before execution"));
    assert.ok(facts.some((event) => event.type === "turn_status" && event.status === "failed"));
  } finally { await session.close(); }
}

async function stepCheckpointFailure(root: string): Promise<void> {
  const turns = path.join(agentDir(root), "turns");
  const savedTurns = `${turns}-saved`;
  const effects = path.join(root, "effects");
  const requests = path.join(root, "requests");
  let disrupted = false;
  const registry = new ToolRegistry();
  registry.register({
    name: "write_once", description: "Write a local marker", risk: "write",
    parameters: { type: "object", properties: {}, required: [] }, schema: z.object({}),
    resolveExecution: () => ({
      approvalRule: "write_once", retrySafety: "unsafe", execute: async () => {
        await appendFile(effects, "committed\n");
        // 模拟工具执行后断点目录不可写，原断点保留在旁边，便于解除故障后重启。
        await rename(turns, savedTurns);
        await writeFile(turns, "unavailable");
        disrupted = true;
        return { committed: true };
      }
    })
  });
  const recorder = new SessionRecorder(root, "step-failure");
  const session = agent(root, recorder, model(async () => {
    await appendFile(requests, "request\n");
    return [{ type: "tool-call", id: "write-1", name: "write_once", arguments: {} }, { type: "finish", reason: "tool-calls" }];
  }), registry);
  try {
    await session.initialize();
    const result = await session.runTask("write a marker once", { emotionAnalysis: false });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /检查点/, JSON.stringify(result));
    assert.equal(await readFile(requests, "utf8"), "request\n", "断点失败后不得发出下一次模型请求");
    assert.equal(await readFile(effects, "utf8"), "committed\n");
    const facts = await readSessionEvents(recorder.filePath);
    assert.ok(facts.some((event) => event.type === "tool_result" && event.executionStatus === "succeeded"));
  } finally {
    await session.close();
    if (disrupted) {
      await rm(turns, { force: true });
      await rename(savedTurns, turns);
    }
  }
  const resumedModel = model(async () => answer);
  const resumed = agent(root, new SessionRecorder(root), {
    ...resumedModel,
    stream: async (context) => {
      assert.ok(context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "write-1"), "恢复的模型上下文必须包含已成功提交的工具结果");
      return await resumedModel.stream(context);
    }
  }, registry);
  try {
    await resumed.initialize();
    await resumed.resume("step-failure");
    let result;
    for await (const event of resumed.continueInterruptedTurn({ emotionAnalysis: false })) {
      if (event.type === "done") result = event.outcome;
    }
    assert.equal(result?.status, "completed", JSON.stringify(result));
    assert.equal(await readFile(effects, "utf8"), "committed\n", "已落盘工具结果不能重跑");
    assert.equal(await resumed.interruptedTurn(), undefined);
  } finally { await resumed.close(); }
}

/** Given 正在等待模型；When 关闭导致暂停；Then 重开保留任务且等待用户继续。 */
async function pausedTurn(root: string, beforeExecution = false): Promise<void> {
  const controller = new AbortController();
  const sessionId = beforeExecution ? "paused-before-execution" : "paused-turn";
  const recorder = new SessionRecorder(root, sessionId);
  const session = agent(root, recorder, {
    provider: "synthetic", modelId: "pause-test", supportsTools: true,
    stream: async () => {
      controller.abort(new AgentTurnCancellationError("paused"));
      throw controller.signal.reason;
    }
  });
  try {
    await session.initialize();
    if (beforeExecution) controller.abort(new AgentTurnCancellationError("paused"));
    const result = await session.runTask("keep this task", { abortSignal: controller.signal, emotionAnalysis: false });
    assert.equal(result.stopReason, "paused");
    assert.ok(await session.interruptedTurn(), "关闭暂停不能丢掉断点");
  } finally { await session.close(); }
  const resumed = agent(root, new SessionRecorder(root), model(async () => answer));
  try {
    await resumed.initialize();
    await resumed.resume(sessionId);
    assert.ok(await resumed.interruptedTurn());
    const before = await readSessionEvents(recorder.filePath);
    assert.equal(before.filter((event) => event.type === "assistant_message").length, 0, "重开不得自动执行");
    let result;
    for await (const event of resumed.continueInterruptedTurn({ emotionAnalysis: false })) {
      if (event.type === "done") result = event.outcome;
    }
    assert.equal(result?.status, "completed", JSON.stringify(result));
    assert.equal(await resumed.interruptedTurn(), undefined);
    const events = await readSessionEvents(recorder.filePath);
    assert.equal(events.filter((event) => event.type === "user_message").length, 1, "继续不能重复提交原任务");
  } finally { await resumed.close(); }
}

/** 工具已开始写入但没有确认结果时，暂停后不能重复执行。 */
async function pauseUnknownSideEffect(root: string): Promise<void> {
  const controller = new AbortController();
  const effects = path.join(root, "paused-unknown-effects");
  const registry = new ToolRegistry();
  registry.register({
    name: "uncertain_write", description: "An interrupted write", risk: "write",
    parameters: { type: "object", properties: {}, required: [] }, schema: z.object({}),
    resolveExecution: () => ({ retrySafety: "unsafe", execute: async () => {
      await appendFile(effects, "written\n");
      controller.abort(new AgentTurnCancellationError("paused"));
      throw controller.signal.reason;
    } })
  });
  const recorder = new SessionRecorder(root, "paused-unknown");
  const session = agent(root, recorder, model(async () => [
    { type: "tool-call", id: "uncertain-1", name: "uncertain_write", arguments: {} },
    { type: "finish", reason: "tool-calls" }
  ]), registry);
  try {
    await session.initialize();
    await session.runTask("write once", { abortSignal: controller.signal, emotionAnalysis: false });
    assert.ok(await session.interruptedTurn());
  } finally { await session.close(); }
  const resumed = agent(root, new SessionRecorder(root), model(async () => {
    throw new Error("不确定副作用必须在请求模型前阻塞");
  }), registry);
  try {
    await resumed.initialize();
    await resumed.resume("paused-unknown");
    let result;
    for await (const event of resumed.continueInterruptedTurn({ emotionAnalysis: false })) {
      if (event.type === "done") result = event.outcome;
    }
    assert.equal(result?.status, "blocked", JSON.stringify(result));
    assert.match(result?.error ?? "", /未确认的副作用/u);
    assert.equal(await readFile(effects, "utf8"), "written\n");
    assert.ok(await resumed.interruptedTurn(), "核对之前保留断点");
  } finally { await resumed.close(); }
  let followupContext = "";
  const followupModel = model(async () => answer);
  const followup = agent(root, new SessionRecorder(root), {
    ...followupModel,
    stream: async (context) => {
      followupContext = JSON.stringify(context.messages);
      return await followupModel.stream(context);
    }
  }, registry);
  try {
    await followup.initialize();
    await followup.resume("paused-unknown");
    let emptyResult;
    for await (const event of followup.startInterruptedFollowup({ emotionAnalysis: false })) {
      if (event.type === "done") emptyResult = event.outcome;
    }
    assert.equal(emptyResult?.status, "completed", JSON.stringify(emptyResult));
    assert.equal(await readFile(effects, "utf8"), "written\n", "空输入新回合不能重放不确定副作用");
    assert.equal(followupContext.includes("<turn_paused>"), true, "空输入新回合应获知上次工作被暂停");
    const emptyFacts = await readSessionEvents(followup.getInfo().sessionFile);
    assert.equal(emptyFacts.filter((event) => event.type === "user_message" && !event.auditOnly).length, 1);
    assert.equal(emptyFacts.filter((event) => event.type === "user_message" && event.auditOnly && event.metadata?.turnTrigger === "resume_interrupted_task").length, 1);
    const result = await followup.runTask("先核对上次写入结果，不要重复执行", { emotionAnalysis: false });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(await readFile(effects, "utf8"), "written\n", "新的自由输入不能自动重放未知副作用");
  } finally { await followup.close(); }
}

async function terminalCrashWorker(root: string): Promise<void> {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "terminal-crash", undefined, {
    appendSessionEvent: ({ event }) => {
      // sink 在 JSONL fsync 后执行；此时立即退出，不运行 finally 或断点清理。
      if (event.type === "turn_status" && event.status === "completed") process.exit(73);
    }
  });
  const session = agent(root, recorder, model(async () => answer));
  await session.initialize();
  await session.runTask("finish durably", { emotionAnalysis: false });
  throw new Error("terminal crash point was not reached");
}

async function terminalCrash(root: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "terminal-worker", root], {
    env: process.env, stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    // 子进程调度依赖真实时间，20 秒硬上限只判超时，不作为成功条件。
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(stderr || "terminal crash worker timed out")); }, 20_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (status) => { clearTimeout(timeout); resolve(status); });
  });
  assert.equal(code, 73, stderr);
  assert.ok(await new TurnStore(root, "terminal-crash").load(), "终态落盘前不得清除断点");
  const marker = path.join(root, "unexpected-resume");
  const resumed = agent(root, new SessionRecorder(root), model(async () => { await writeFile(marker, "called"); return answer; }));
  try {
    await resumed.initialize();
    await resumed.resume("terminal-crash");
    assert.equal(await resumed.interruptedTurn(), undefined, "已落盘终态必须压过陈旧断点");
    await assert.rejects(async () => { for await (const _event of resumed.continueInterruptedTurn()) { /* 消费公开流 */ } }, /no interrupted turn/i);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally { await resumed.close(); }
}

async function desktopRecovery(root: string): Promise<void> {
  const workspace = path.join(root, "desktop-workspace");
  await mkdir(workspace);
  const storage = new DesktopUserDataStore(path.join(root, "desktop-data"));
  await storage.initialize();
  const state = new DesktopStateStore(path.join(storage.root, "state.json"));
  await state.load();
  const projects = new DesktopProjectService(state, storage, { load: async () => config, save: async () => {} });
  const project = await projects.createProject(workspace);
  const dataRoot = await projects.dataRoot(project);
  await ensureAgentDirs(dataRoot);
  const recorder = new SessionRecorder(dataRoot, "desktop-recovery");
  const store = new TurnStore(dataRoot, recorder.sessionId);
  recorder.setRuntimeContext({ runId: "run-desktop", turnId: "turn-desktop" });
  try {
    await recorder.recordAndFlush({ type: "user_message", content: "unfinished task" });
    await store.save("unfinished task", undefined, [{ role: "user", content: "unfinished task" }], 0, undefined, undefined, undefined, recorder.runtimeHighWater());
    const before = await readFile(recorder.filePath, "utf8");
    for (let index = 0; index < 2; index += 1) {
      const opened = await projects.openSession(project, recorder.sessionId, undefined, new Map());
      assert.equal(opened.recovery?.canContinue, true);
    }
    assert.equal(await readFile(recorder.filePath, "utf8"), before, "读取恢复提示不应开始执行或写入恢复事实");
    await recorder.recordAndFlush({ type: "tool_call", tool: "Bash", args: {}, toolCallId: "unknown-call", sequence: 1 });
    await recorder.recordAndFlush({ type: "tool_execution", tool: "Bash", toolCallId: "unknown-call", sequence: 1, operationId: "unknown-operation", state: "admitted", retrySafety: "unsafe" });
    const blocked = await projects.openSession(project, recorder.sessionId, undefined, new Map());
    assert.equal(blocked.recovery?.canContinue, false);
    assert.match(blocked.recovery?.message ?? "", /未确认的副作用/);
    await recorder.recordAndFlush({ type: "turn_status", status: "cancelled", stopReason: "paused", steps: 0, resumable: true });
    const pausedUnknown = await projects.openSession(project, recorder.sessionId, undefined, new Map());
    assert.equal(pausedUnknown.recovery?.canContinue, true,
      "暂停后的空输入应能开启新回合核对不确定结果，无须精确重放旧工具");
    await recorder.recordAndFlush({ type: "tool_result", tool: "Bash", toolCallId: "unknown-call", result: "done", executionStatus: "succeeded" });
    recorder.setRuntimeContext({ runId: "run-followup", turnId: "turn-followup" });
    await recorder.recordAndFlush({ type: "user_message", content: "", auditOnly: true, metadata: { turnTrigger: "resume_interrupted_task" } });
    await store.save("", undefined, [{ role: "user", content: "unfinished task" }], 0,
      undefined, undefined, undefined, recorder.runtimeHighWater());
    const interruptedFollowup = await projects.openSession(project, recorder.sessionId, undefined, new Map());
    assert.equal(interruptedFollowup.recovery?.canContinue, false,
      "新 turn 的启动记录已落盘后，不得再次把旧暂停当成可点击的新回合");
    await recorder.recordAndFlush({ type: "turn_status", status: "completed", stopReason: "model_stop", steps: 1 });
    assert.equal((await projects.openSession(project, recorder.sessionId, undefined, new Map())).recovery, undefined);
    await writeFile(path.join(agentDir(dataRoot), "turns", `${recorder.sessionId}.json`), "{corrupt");
    const corrupt = await projects.openSession(project, recorder.sessionId, undefined, new Map());
    assert.equal(corrupt.recovery?.canContinue, false);
    assert.match(corrupt.recovery?.message ?? "", /无法读取回合检查点/);
    const legacy = new SessionRecorder(dataRoot, "legacy-paused-stale");
    try {
      await legacy.recordAndFlush({ type: "user_message", content: "old task" });
      await new TurnStore(dataRoot, legacy.sessionId).save("old task", undefined, [{ role: "user", content: "old task" }], 0);
      await legacy.recordAndFlush({ type: "turn_status", status: "cancelled", stopReason: "paused", steps: 0, resumable: true });
      await legacy.recordAndFlush({ type: "user_message", content: "new task" });
      assert.equal((await projects.openSession(project, legacy.sessionId, undefined, new Map())).recovery, undefined,
        "无 turnId 的旧断点在新输入后不能重新显示继续入口");
    } finally { await legacy.close(); }
  } finally { await recorder.close(); }
}

/** 新回合只写完初始检查点就重启时，内部恢复不能退回到旧暂停 turn。 */
async function emptyFollowupCheckpointRestart(root: string): Promise<void> {
  const sessionId = "empty-followup-restart";
  const recorder = new SessionRecorder(root, sessionId);
  const store = new TurnStore(root, sessionId);
  const marker = "<turn_paused>\nThe previous turn was paused before completion. Running processes may still be active in the background. If tools or commands were cancelled, they may have partially executed.\n</turn_paused>";
  recorder.setRuntimeContext({ runId: "original-run", turnId: "original-turn" });
  await recorder.recordAndFlush({ type: "user_message", content: "original work" });
  await recorder.recordAndFlush({ type: "turn_interrupted", reason: "paused", content: marker });
  await recorder.recordAndFlush({ type: "turn_status", status: "cancelled", stopReason: "paused", steps: 0, resumable: true });
  recorder.setRuntimeContext({ runId: "followup-run", turnId: "followup-turn" });
  await recorder.recordAndFlush({ type: "user_message", content: "", auditOnly: true, metadata: { turnTrigger: "resume_interrupted_task" } });
  await store.save("", undefined, [{ role: "user", content: "original work" }, { role: "user", content: marker }], 0,
    undefined, undefined, undefined, recorder.runtimeHighWater());
  await recorder.close();

  let request = "";
  const provider = model(async () => answer);
  const resumed = agent(root, new SessionRecorder(root), {
    ...provider,
    stream: async (context) => { request = JSON.stringify(context.messages); return await provider.stream(context); }
  });
  try {
    await resumed.initialize();
    await resumed.resume(sessionId);
    let result;
    for await (const event of resumed.continueInterruptedTurn({ emotionAnalysis: false })) {
      if (event.type === "done") result = event.outcome;
    }
    assert.equal(result?.status, "completed", JSON.stringify(result));
    assert.equal(request.includes("<turn_paused>"), true, "重启后继续新 turn 时仍保留旧暂停事实");
    const facts = await readSessionEvents(resumed.getInfo().sessionFile);
    const terminals = facts.filter((event) => event.type === "turn_status");
    assert.deepEqual(terminals.map((event) => event.runtime?.turnId), ["original-turn", "followup-turn"]);
    assert.equal(facts.filter((event) => event.type === "user_message" && !event.auditOnly).length, 1);
  } finally { await resumed.close(); }
}

if (process.argv[2] === "terminal-worker") {
  await terminalCrashWorker(process.argv[3]!);
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-recovery-durability-"));
  try {
    await ensureAgentDirs(root);
    await initialCheckpointFailure(root);
    await stepCheckpointFailure(root);
    await terminalCrash(root);
    await pausedTurn(root);
    await pausedTurn(root, true);
    await pauseUnknownSideEffect(root);
    await desktopRecovery(root);
    await emptyFollowupCheckpointRestart(root);
    console.log("recovery durability tests passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}
