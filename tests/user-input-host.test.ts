/** 真实 socket、Runtime、模型协议与 JSONL；模型只使用本机 HTTP 替身。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { startRuntimeHost, connectRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { SubmittedAgentRun } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { redactSecrets } from "../src/utils/secrets.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";

type MockRequest = { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: Array<{ function?: { name: string } }> };

function summarizeMockRequest(body: MockRequest) {
  return {
    tools: body.tools?.slice(0, 24).map(tool => diagnosticText(tool.function?.name)?.slice(0, 80)),
    toolCount: body.tools?.length ?? 0,
    lastRole: diagnosticText(body.messages.at(-1)?.role)?.slice(0, 32),
    lastToolCallId: diagnosticText(body.messages.at(-1)?.tool_call_id)?.slice(0, 80)
  };
}

interface QuestionClient {
  subscribe(listener: (update: AgentRuntimeUpdate) => void): () => void;
  submitPrompt(input: string, attachments: [], ids: { runId: string }): SubmittedAgentRun;
  getSnapshot(): InteractiveRuntimeSnapshot;
}

function diagnosticText(value: unknown): string | undefined {
  return typeof value === "string" ? redactSecrets(value).slice(0, 240) : undefined;
}

/** Diagnostics only: keep the existing deadline and observe every early terminal outcome. */
function submitAndWaitForQuestion(
  client: QuestionClient,
  sessionId: string,
  phase: string,
  input: string,
  providerSummary: () => unknown
): Promise<SubmittedAgentRun> {
  const runId = randomUUID();
  return new Promise((resolve, reject) => {
    let submitted: SubmittedAgentRun | undefined;
    let questionSeen = false;
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const events: unknown[] = [];
    const cleanup = (): void => {
      clearTimeout(timer);
      const stop = unsubscribe;
      unsubscribe = undefined;
      stop?.();
    };
    const fail = (reason: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      let state: string | undefined;
      try { state = client.getSnapshot().state.kind; } catch { /* diagnostic only */ }
      const error = cause instanceof Error
        ? { name: diagnosticText(cause.name), message: diagnosticText(cause.message) }
        : cause === undefined ? undefined : { name: "NonErrorRejection" };
      reject(new Error(`${phase}: ${reason}; ${JSON.stringify({
        sessionId, runId, state, provider: (() => { try { return providerSummary(); } catch { return { unavailable: true }; } })(), events, error
      })}`));
    };
    const finishQuestion = (): void => {
      if (settled || !questionSeen || !submitted) return;
      settled = true;
      cleanup();
      resolve(submitted);
    };
    const timer = setTimeout(() => fail("No question within 10 seconds"), 10_000);
    try {
      const stop = client.subscribe((update) => {
        if (settled) return;
        const event = update.event;
        if (event) {
          events.push({
            type: event.type,
            sessionId: event.sessionId,
            runId: event.runId,
            ...(event.type === "tool.progress" ? { customKind: diagnosticText(event.update.customKind) } : {}),
            ...(event.type === "run.failed" ? { error: diagnosticText(event.error) } : {})
          });
          if (events.length > 12) events.shift();
        }
        if (event?.sessionId === sessionId && event.runId === runId
          && event.type === "tool.progress" && event.update.customKind === "user_input") {
          questionSeen = true;
          finishQuestion();
        }
        if (!questionSeen && event?.sessionId === sessionId && event.runId === runId
          && (event.type === "run.completed" || event.type === "run.failed"
            || event.type === "run.blocked" || event.type === "run.incomplete"
            || event.type === "run.cancelled" || event.type === "run.aborted")) {
          fail(`Terminal event before question: ${JSON.stringify({
            type: event.type, stopReason: event.stopReason, steps: event.steps,
            error: event.type === "run.failed" ? diagnosticText(event.error) : undefined,
            reason: "reason" in event ? diagnosticText(event.reason) : undefined,
            summary: event.type === "run.blocked" ? diagnosticText(event.summary) : undefined
          })}`);
        }
      });
      // subscribe may synchronously replay updates before returning its disposer.
      if (settled) { stop(); return; }
      unsubscribe = stop;
      submitted = client.submitPrompt(input, [], { runId });
      void submitted.completion.then(
        (outcome) => fail(`Run ended before question: ${JSON.stringify({
          status: outcome.status, stopReason: outcome.stopReason,
          steps: outcome.steps, error: diagnosticText(outcome.error)
        })}`),
        (error: unknown) => fail("Run rejected before question", error)
      );
      finishQuestion();
    } catch (error) {
      fail("Unable to subscribe or submit question run", error);
    }
  });
}

test("普通模式发现提问工具后经 Host 提问、CLI 回答并落盘；取消使旧卡失效", { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-input-host-")));
  const saved = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let sawAnswer = false;
  let modelCalls = 0;
  let providerRequests = 0;
  let providerBranch = "none";
  let lastRequest: ReturnType<typeof summarizeMockRequest> | undefined;
  let providerFailure: string | undefined;
  const providerSummary = () => ({ providerRequests, modelCalls, providerBranch, lastRequest, providerFailure });
  const provider = createServer(async (req, res) => {
    providerRequests++;
    providerBranch = "reading";
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as MockRequest;
      lastRequest = summarizeMockRequest(body);
      if (!body.tools?.length) {
        providerBranch = "no-tools-stop";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ tools: [] }) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      modelCalls++;
      let frames: unknown[];
      if (!body.tools.some((tool) => tool.function?.name === "AskUserQuestion")) {
        providerBranch = "discover-tool-calls";
        assert.ok(body.tools.some((tool) => tool.function?.name === "ToolSearch"), "未预选提问工具时仍可精确发现");
        frames = [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "discover-question", type: "function", function: {
          name: "ToolSearch", arguments: JSON.stringify({ query: "AskUserQuestion" })
        } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
      } else if (body.messages.at(-1)?.role === "tool" && body.messages.at(-1)?.tool_call_id?.startsWith("question-")) {
        providerBranch = "answer-stop";
        sawAnswer = JSON.stringify(body.messages.at(-1)).includes("下载目录");
        frames = [{ choices: [{ index: 0, delta: { content: "按选择继续。" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
      } else {
        providerBranch = "question-tool-calls";
        frames = [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `question-${modelCalls}`, type: "function", function: {
          name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ id: "place", question: "放在哪里？", options: [{ label: "桌面" }, { label: "下载目录" }] }] })
        } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), "data: [DONE]\n\n"].join(""));
    } catch (error) {
      providerFailure = diagnosticText(error instanceof Error ? error.message : String(error));
      providerBranch += "-error";
      res.writeHead(500); res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  await saveConfig(root, configSchema.parse({
    ...defaultConfig, defaultModel: "local-test",
    chat: { ...defaultConfig.chat, defaultToolSelection: "auto", defaultSkillSelection: "none" },
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"], provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  }));
  const host = await startRuntimeHost(root, async (resourceRegistry) => await createInteractiveAgentHost(root, { resourceRegistry }));
  const connected = await connectRuntimeHost(root, { surface: "desktop", clientId: "input-test" });
  assert.ok(connected);
  let client = connected;
  try {
    const sessionId = client.getSnapshot().info.sessionId;
    assert.equal("planning" in client.getSnapshot().info, false, "interactive session snapshots do not expose the removed planning mode");
    const run = await submitAndWaitForQuestion(client, sessionId, "initial-question",
      "做个小工具，但需要先确认存放位置", providerSummary);
    assert.equal(modelCalls, 2, "仅发现和提问两步，未回答前不得请求下一步模型");
    const pending = await client.pendingUserInput(sessionId);
    assert.equal(pending.length, 1);
    const request = pending[0]!;
    await assert.rejects(client.answerUserInput(sessionId, "old-run", request.toolCallId, { status: "skipped" }), /no longer pending/);
    await assert.rejects(client.answerUserInput("another-session", request.runId, request.toolCallId, { status: "skipped" }), /no longer pending/);
    const execFile = promisify(execFileCallback);
    const cli = path.resolve("src/cli/index.ts");
    const loader = createRequire(import.meta.url).resolve("tsx");
    const listed = await execFile(process.execPath, ["--import", loader, cli, "input", "list", "--session", sessionId, "--json"], { cwd: root, env: process.env, timeout: 10000 });
    assert.equal(JSON.parse(listed.stdout.trim())[0].toolCallId, request.toolCallId);
    const answered = await execFile(process.execPath, ["--import", loader, cli, "input", "answer", request.toolCallId, "--session", sessionId, "--run", request.runId, "--answers", JSON.stringify([{ id: "place", selected: ["下载目录"] }]), "--json"], { cwd: root, env: process.env, timeout: 10000 });
    assert.equal(JSON.parse(answered.stdout.trim()).response.status, "answered");
    assert.equal((await run.completion).status, "completed");
    assert.ok(sawAnswer, "真实模型协议必须接收到用户答案");
    const events = (await readFile(client.getSnapshot().info.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "ToolSearch").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_call" && event.tool === "AskUserQuestion").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "AskUserQuestion").length, 1);
    assert.match(JSON.stringify(buildSessionTimeline(events, []).flatMap((turn) => turn.tools)), /下载目录/);
    const textRun = await submitAndWaitForQuestion(client, sessionId, "custom-text-question",
      "再确认一个自定义位置", providerSummary);
    const textRequest = (await client.pendingUserInput(sessionId))[0]!;
    const textAnswer = await execFile(process.execPath, ["--import", loader, cli, "input", "answer", textRequest.toolCallId, "--session", sessionId, "--run", textRequest.runId, "--question", "place", "--text", "下载目录"], { cwd: root, env: process.env, timeout: 10000 });
    assert.equal(textAnswer.stdout.trim(), "Answers submitted.");
    assert.equal((await textRun.completion).status, "completed");
    const cancelling = await submitAndWaitForQuestion(client, sessionId, "cancel-question",
      "再确认一次，然后测试停止", providerSummary);
    const old = (await client.pendingUserInput(sessionId))[0]!;
    await client.close();
    const reconnected = await connectRuntimeHost(root, { surface: "desktop", clientId: "input-test-reconnected" });
    assert.ok(reconnected);
    client = reconnected;
    assert.deepEqual(await client.pendingUserInput(sessionId), [old], "关闭和重连客户端不得丢失待答问题");
    const callsBeforeCancel = modelCalls;
    await client.cancelRunRequest(cancelling.runId, "cancelled", sessionId);
    await client.waitForIdle();
    assert.deepEqual(await client.pendingUserInput(sessionId), []);
    assert.equal(modelCalls, callsBeforeCancel, "取消问题后不请求下一步模型");
    await assert.rejects(client.answerUserInput(sessionId, old.runId, old.toolCallId, { status: "skipped" }), /no longer pending/);
    const cancelledEvents = (await readFile(client.getSnapshot().info.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
    assert.equal(cancelledEvents.findLast((event) => event.type === "turn_status")?.status, "cancelled");
  } finally {
    await client.close();
    await host.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (saved === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = saved;
    await rm(root, { recursive: true, force: true });
  }
});
