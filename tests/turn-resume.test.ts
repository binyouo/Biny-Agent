import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "../src/agent/core/types.js";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentTurnOutcome } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createModelForConfig } from "../src/llm/modelFactory.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { validateRuntimeEventStream } from "../src/session/runtimeEvent.js";
import { agentDir, ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool, ToolExecutionContext } from "../src/tools/types.js";

interface WorkerOptions {
  workspaceRoot: string;
  sessionId: string;
  endpoint: string;
  executionLog: string;
  phase: "initial" | "resumed";
  crash: "during-tool-b" | "after-side-effect-b" | "after-tool-b";
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-turn-"));
  try {
    await ensureAgentDirs(root);
    await testRoundTripKeepsToolResults(root);
    await testClearedTurnIsNotResumable(root);
    await testCorruptStateIsIgnored(root);
    await testLegacyTurnIgnoresDeprecatedToolSnapshot(root);
    await testIsolatedPerSession(root);
    await testAgentSessionResumesAfterCrashDuringToolB();
    await testAgentSessionResumesAfterCrashAfterSideEffectB();
    await testAgentSessionResumesAfterCrashAfterToolB();
    console.log("turn resume tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 续跑的价值全在这里：已完成步骤的工具结果必须原样带回，否则等于重跑。 */
async function testRoundTripKeepsToolResults(root: string): Promise<void> {
  const store = new TurnStore(root, "session-a");
  const messages: AgentMessage[] = [
    { role: "user", content: "refactor the parser" },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "Read", arguments: { path: "a.ts" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "Read", content: [{ type: "text", text: "file body" }] }
  ];
  const facts = {
    actualToolCallCount: 1,
    changedFiles: ["a.ts"]
  };
  await store.save("refactor the parser", "system", messages, 3, facts, {
    status: "incomplete",
    stopReason: "hard_step_limit",
    summary: "The run reached its hard step limit."
  }, [{
    status: "blocked",
    stopReason: "blocked",
    summary: "Waiting for approval.",
    blockedReason: "waiting_for_approval"
  }]);

  const loaded = await new TurnStore(root, "session-a").load();
  assert.equal(loaded?.completedSteps, 3);
  assert.equal(loaded?.prompt, "refactor the parser");
  assert.equal(loaded?.messages.length, 3);
  assert.deepEqual(loaded?.facts, facts);
  assert.deepEqual(loaded?.terminal, {
    status: "incomplete",
    stopReason: "hard_step_limit",
    summary: "The run reached its hard step limit."
  });
  assert.deepEqual(loaded?.previousTerminals, [{
    status: "blocked",
    stopReason: "blocked",
    summary: "Waiting for approval.",
    blockedReason: "waiting_for_approval"
  }]);
  const toolMessage = loaded?.messages[2];
  assert.equal(toolMessage?.role, "toolResult");
  assert.equal(JSON.stringify(toolMessage).includes("file body"), true, "tool results must survive the round trip");
}

/** 陈旧的在途状态比没有更糟：它会让下一次启动去续跑一个早已完成的回合。 */
async function testClearedTurnIsNotResumable(root: string): Promise<void> {
  const store = new TurnStore(root, "session-b");
  await store.save("done work", undefined, [{ role: "user", content: "x" }], 1);
  assert.notEqual(await store.load(), undefined);
  await store.clear();
  assert.equal(await store.load(), undefined);
  // 清两次不该报错：正常收尾和异常收尾都可能走到这里。
  await store.clear();
}

async function testCorruptStateIsIgnored(root: string): Promise<void> {
  const store = new TurnStore(root, "session-c");
  const target = path.join(agentDir(root), "turns", "session-c.json");
  await (await import("node:fs/promises")).writeFile(target, "{ not json");
  assert.equal(await store.load(), undefined);
  // 空 messages 不构成可续跑的状态。
  await (await import("node:fs/promises")).writeFile(target, JSON.stringify({ turn: { sessionId: "session-c", prompt: "p", messages: [], completedSteps: 1 } }));
  assert.equal(await store.load(), undefined);
}

/** 旧 TurnStore 文件中的重复工具快照已停用，但不能因此让整个在途回合失效。 */
async function testLegacyTurnIgnoresDeprecatedToolSnapshot(root: string): Promise<void> {
  const sessionId = "legacy-session";
  const target = path.join(agentDir(root), "turns", `${sessionId}.json`);
  await writeFile(target, JSON.stringify({
    version: 3,
    turn: {
      sessionId,
      prompt: "continue legacy work",
      messages: [{ role: "user", content: "continue legacy work" }],
      completedSteps: 1,
      lastToolSequence: 1,
      pendingToolExecutions: [{
        tool: "Write",
        toolCallId: "legacy-call",
        sequence: 1,
        operationId: "legacy-operation",
        state: "unknown",
        retrySafety: "unsafe"
      }],
      updatedAt: "2026-09-15T00:00:00.000Z"
    }
  }));
  const loaded = await new TurnStore(root, sessionId).load();
  assert.equal(loaded?.prompt, "continue legacy work");
  assert.equal(loaded?.completedSteps, 1);
}

async function testIsolatedPerSession(root: string): Promise<void> {
  await new TurnStore(root, "session-d").save("d work", undefined, [{ role: "user", content: "d" }], 1);
  assert.equal(await new TurnStore(root, "session-e").load(), undefined);
}

async function testAgentSessionResumesAfterCrashDuringToolB(): Promise<void> {
  await testAgentSessionCrashRecovery("during-tool-b", 1);
}

async function testAgentSessionResumesAfterCrashAfterSideEffectB(): Promise<void> {
  await testAgentSessionCrashRecovery("after-side-effect-b", 1);
}

async function testAgentSessionResumesAfterCrashAfterToolB(): Promise<void> {
  await testAgentSessionCrashRecovery("after-tool-b", 2);
}

/**
 * 真正启动两个 AgentSession 进程：第一个在工具 B 中或 B 后被硬终止，第二个恢复同一
 * session 并调用 continueInterruptedTurn。执行日志证明工具 A 没有被重新执行。
 */
async function testAgentSessionCrashRecovery(
  crash: WorkerOptions["crash"],
  expectedPersistedSteps: number
): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), `biny-turn-${crash}-`));
  const executionLog = path.join(workspaceRoot, "tool-executions.log");
  const sessionId = `resume-${crash}`;
  const provider = await startRecoveryProvider(crash);
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(workspaceRoot, "global-agent");
  try {
    const sessionFile = await ensureIsolatedSessionFilePath(workspaceRoot, sessionId);
    const initial = spawnWorker({
      workspaceRoot,
      sessionId,
      endpoint: provider.endpoint,
      executionLog,
      phase: "initial",
      crash
    });
    const initialResult = crash === "after-tool-b"
      ? await killAfterToolB(initial, provider.afterToolBRequest)
      : crash === "after-side-effect-b"
        ? await killAfterPersistedState(
          initial,
          sessionFile,
          '"state":"side_effect_committed"'
        )
        : await childResult(initial);
    if (crash === "during-tool-b") {
      assert.equal(initialResult.code, 73, initialResult.stderr);
    } else {
      assert.equal(initialResult.signal, "SIGKILL", initialResult.stderr);
    }

    const persisted = await new TurnStore(workspaceRoot, sessionId).load();
    assert.equal(persisted?.completedSteps, expectedPersistedSteps);

    const resumed = spawnWorker({
      workspaceRoot,
      sessionId,
      endpoint: provider.endpoint,
      executionLog,
      phase: "resumed",
      crash
    });
    const resumedResult = await childResult(resumed);
    assert.equal(resumedResult.code, 0, resumedResult.stderr);
    const outcome = JSON.parse(resumedResult.stdout.trim()) as AgentTurnOutcome;
    // 普通扩展的局部副作用标记不再等于整个工具成功，必须有完整 outcome 才能继续。
    assert.equal(outcome.status, crash === "after-tool-b" ? "completed" : "blocked");
    assert.equal(
      outcome.steps,
      crash === "after-tool-b" ? 3 : 1
    );
    if (crash !== "after-tool-b") assert.match(outcome.error ?? "", /未确认的副作用/u);
    assert.equal(await new TurnStore(workspaceRoot, sessionId).load(), undefined);

    const sessionEvents = await readSessionEvents(sessionFile);
    const runtimeEvents = sessionEvents.filter((event) => event.runtime !== undefined);
    assert.equal(runtimeEvents.length, sessionEvents.length, "new session facts must carry runtime identity");
    assert.deepEqual(
      runtimeEvents.map((event) => event.runtime?.eventSeq),
      runtimeEvents.map((_event, index) => index + 1),
      "event sequence must be continuous after crash recovery"
    );
    assert.equal(new Set(runtimeEvents.map((event) => event.runtime?.eventId)).size, runtimeEvents.length);
    validateRuntimeEventStream(sessionEvents);
    const turnIds = new Set(runtimeEvents.map((event) => event.runtime?.turnId).filter((turnId): turnId is string => turnId !== undefined));
    const runIds = new Set(runtimeEvents.map((event) => event.runtime?.runId).filter((runId): runId is string => runId !== undefined));
    assert.equal(turnIds.size, 1, "initial run and continuation must share one turnId");
    assert.equal(runIds.size, 2, "resume must allocate a new runId");
    const terminalByRun = new Map<string, number>();
    const operations = new Map<string, string>();
    for (const event of runtimeEvents) {
      if (event.type === "turn_status" && event.runtime?.runId) {
        terminalByRun.set(event.runtime.runId, (terminalByRun.get(event.runtime.runId) ?? 0) + 1);
      }
      if (event.type === "tool_execution") operations.set(event.toolCallId, event.operationId);
      if (event.type === "tool_result" && event.toolCallId && event.operationId) {
        assert.equal(operations.get(event.toolCallId), event.operationId, "tool result identity must match its execution");
      }
    }
    assert.equal([...terminalByRun.values()].every((count) => count === 1), true);

    const executions = (await readFile(executionLog, "utf8")).trim().split("\n");
    assert.equal(executions.filter((entry) => entry === "tool-a:done").length, 1);
    assert.equal(executions.filter((entry) => entry === "tool-b:side-effect").length, crash === "after-side-effect-b" ? 1 : 0);
    assert.equal(executions.filter((entry) => entry === "tool-b:done").length, crash === "after-tool-b" ? 1 : 0);
    assert.equal(
      executions.filter((entry) => entry === "tool-b:start").length,
      1
    );

    const resumedRequest = provider.resumedRequests[0];
    if (crash !== "after-tool-b") {
      assert.equal(provider.resumedRequests.length, 0, "unknown side effects must block before another model request");
    } else {
      assert.ok(resumedRequest?.includes("call-a"), "resumed context must include tool A");
      assert.equal(
        resumedRequest?.includes("call-b"),
        true,
        "recovery must expose tool B's assistant call and its persisted or recovered result"
      );
    }

    const authority = await RuntimeEventAuthority.open(workspaceRoot);
    const projected = authority.readEvents({ sessionId }).events;
    assert.equal(projected.length, runtimeEvents.length, "authority projection must contain every JSONL fact after restart");
    assert.deepEqual(
      projected.map((event) => event.eventSeq),
      runtimeEvents.map((event) => event.runtime?.eventSeq),
      "authority must preserve the session high-water sequence"
    );
    authority.close();
  } finally {
    await provider.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function spawnWorker(options: WorkerOptions): ChildProcess {
  return spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), "--agent-worker", JSON.stringify(options)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BINY_AGENT_DIR: path.join(options.workspaceRoot, "global-agent")
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

async function killAfterToolB(
  child: ChildProcess,
  afterToolBRequest: Promise<void>
): Promise<ChildResult> {
  await withTimeout(afterToolBRequest, 10_000);
  child.kill("SIGKILL");
  return await childResult(child);
}

async function killAfterPersistedState(
  child: ChildProcess,
  sessionFile: string,
  stateText: string
): Promise<ChildResult> {
  await waitForFileText(sessionFile, stateText, 10_000);
  child.kill("SIGKILL");
  return await childResult(child);
}

async function waitForFileText(filePath: string, text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(filePath, "utf8")).includes(text)) return;
    } catch {
      // 子进程还没创建 session 文件时继续轮询。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${text} in ${filePath}.`);
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function childResult(child: ChildProcess): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  return await withTimeout(new Promise<ChildResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  }), 15_000);
}

async function startRecoveryProvider(crash: WorkerOptions["crash"]): Promise<{
  endpoint: string;
  afterToolBRequest: Promise<void>;
  resumedRequests: string[];
  close(): Promise<void>;
}> {
  let resolveAfterToolB!: () => void;
  const afterToolBRequest = new Promise<void>((resolve) => { resolveAfterToolB = resolve; });
  const resumedRequests: string[] = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    const phase = request.headers["x-test-phase"];
    if (phase === "resumed") resumedRequests.push(body);
    const hasToolA = body.includes("call-a");
    const hasToolB = body.includes("call-b");
    if (crash === "after-tool-b" && phase === "initial" && hasToolB) {
      resolveAfterToolB();
      return;
    }
    if (!hasToolA) {
      sendProviderParts(response, toolCallParts("call-a", "tool_a"));
      return;
    }
    if (!hasToolB) {
      sendProviderParts(response, toolCallParts("call-b", "tool_b"));
      return;
    }
    sendProviderParts(response, [
      { choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Recovery provider did not bind a TCP port.");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1`,
    afterToolBRequest,
    resumedRequests,
    close: async () => await closeServer(server)
  };
}

function toolCallParts(toolCallId: string, toolName: string): Array<Record<string, unknown> | "[DONE]"> {
  return [
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: toolCallId,
            type: "function",
            function: { name: toolName, arguments: "{}" }
          }]
        },
        finish_reason: null
      }]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]"
  ];
}

function sendProviderParts(
  response: import("node:http").ServerResponse,
  parts: Array<Record<string, unknown> | "[DONE]">
): void {
  const body = parts
    .map((part) => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`)
    .join("");
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(body);
}

async function requestBody(request: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${String(timeoutMs)}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runAgentWorker(options: WorkerOptions): Promise<void> {
  await ensureAgentDirs(options.workspaceRoot);
  const authority = await RuntimeEventAuthority.open(options.workspaceRoot);
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "test-model",
    providers: {
      active: {
        type: "openai",
        apiKey: "test-key",
        baseUrl: options.endpoint
      }
    },
    models: {
      "test-model": {
        provider: "active",
        model: "test-model",
        headers: { "x-test-phase": options.phase }
      }
    },
    agent: { ...defaultConfig.agent, hardStepLimit: 6 },
    permission: { ...defaultConfig.permission, mode: "full-access" },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const registry = new ToolRegistry();
  registry.register(crashTestTool("tool_a", options));
  registry.register(crashTestTool("tool_b", options));
  const recorder = options.phase === "initial"
    ? new SessionRecorder(options.workspaceRoot, options.sessionId, undefined, authority.asSink())
    : new SessionRecorder(options.workspaceRoot, undefined, undefined, authority.asSink());
  const agent = new AgentSession({
    workspaceRoot: options.workspaceRoot,
    config,
    model: createModelForConfig(config),
    toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    recorder,
    runtimeEventSink: authority.asSink()
  });
  try {
    await agent.initialize();
    if (options.phase === "resumed") await agent.resume(options.sessionId);
    let outcome: AgentTurnOutcome | undefined;
    const stream = options.phase === "initial"
      ? agent.prompt("run tool A and tool B")
      : agent.continueInterruptedTurn();
    for await (const event of stream) {
      if (event.type === "done") outcome = event.outcome;
    }
    await agent.close();
    if (!outcome) throw new Error("Agent worker ended without an outcome.");
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } finally {
    authority.close();
  }
}

function crashTestTool(name: "tool_a" | "tool_b", options: WorkerOptions): Tool<Record<string, never>> {
  return {
    name,
    description: `Execute ${name}.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: name === "tool_b" ? "write" : "read",
    resolveExecution() {
      return {
        approvalRule: name,
        async execute({ onExecutionState }: ToolExecutionContext) {
          if (name === "tool_a") {
            appendFileSync(options.executionLog, "tool-a:done\n");
            return { completed: true };
          }
          appendFileSync(options.executionLog, "tool-b:start\n");
          if (options.phase === "initial" && options.crash === "after-side-effect-b") {
            appendFileSync(options.executionLog, "tool-b:side-effect\n");
            onExecutionState?.("side_effect_committed", "test side effect marker persisted");
            setInterval(() => undefined, 1_000);
            await new Promise<void>(() => undefined);
          }
          if (options.phase === "initial" && options.crash === "during-tool-b") process.exit(73);
          appendFileSync(options.executionLog, "tool-b:done\n");
          return { completed: true };
        }
      };
    }
  };
}

async function ensureIsolatedSessionFilePath(workspaceRoot: string, sessionId: string): Promise<string> {
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(workspaceRoot, "global-agent");
  try {
    await ensureAgentDirs(workspaceRoot);
    return sessionFilePath(workspaceRoot, sessionId);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
  }
}

const workerIndex = process.argv.indexOf("--agent-worker");
if (workerIndex === -1) {
  await main();
} else {
  const serialized = process.argv[workerIndex + 1];
  if (!serialized) throw new Error("Missing AgentSession worker options.");
  await runAgentWorker(JSON.parse(serialized) as WorkerOptions);
}
