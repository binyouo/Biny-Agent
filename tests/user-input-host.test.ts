/** 真实 socket、Runtime、模型协议与 JSONL；模型只使用本机 HTTP 替身。 */
import assert from "node:assert/strict";
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
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";

test("普通模式经 Host 提问、CLI 回答、模型继续并落盘；取消使旧卡失效", { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-input-host-")));
  const saved = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let sawAnswer = false;
  let modelCalls = 0;
  const provider = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name: string } }> };
      if (!body.tools?.length) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ tools: [] }) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      modelCalls++;
      assert.ok(body.tools?.some((tool) => tool.function?.name === "AskUserQuestion"));
      let frames: unknown[];
      if (body.messages.at(-1)?.role === "tool") {
        sawAnswer = JSON.stringify(body.messages.at(-1)).includes("下载目录");
        frames = [{ choices: [{ index: 0, delta: { content: "按选择继续。" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
      } else {
        frames = [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `question-${modelCalls}`, type: "function", function: {
          name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ id: "place", question: "放在哪里？", options: [{ label: "桌面" }, { label: "下载目录" }] }] })
        } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), "data: [DONE]\n\n"].join(""));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
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
    const waitForQuestion = (): Promise<void> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("No question within 10 seconds")); }, 10000);
      const unsubscribe = client.subscribe((update) => {
        if (update.event?.type === "tool.progress" && update.event.update.customKind === "user_input") {
          clearTimeout(timer); unsubscribe(); resolve();
        }
      });
    });
    const ready = waitForQuestion();
    const run = client.submitPrompt("做个小工具，但需要先确认存放位置");
    void run.completion.catch(() => undefined);
    await ready;
    assert.equal(modelCalls, 1, "未回答前不得请求下一步模型");
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
    assert.equal(events.filter((event) => event.type === "tool_call" && event.tool === "AskUserQuestion").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "AskUserQuestion").length, 1);
    assert.match(JSON.stringify(buildSessionTimeline(events, []).flatMap((turn) => turn.tools)), /下载目录/);
    const textReady = waitForQuestion();
    const textRun = client.submitPrompt("再确认一个自定义位置");
    void textRun.completion.catch(() => undefined);
    await textReady;
    const textRequest = (await client.pendingUserInput(sessionId))[0]!;
    const textAnswer = await execFile(process.execPath, ["--import", loader, cli, "input", "answer", textRequest.toolCallId, "--session", sessionId, "--run", textRequest.runId, "--question", "place", "--text", "下载目录"], { cwd: root, env: process.env, timeout: 10000 });
    assert.equal(textAnswer.stdout.trim(), "Answers submitted.");
    assert.equal((await textRun.completion).status, "completed");
    const cancelReady = waitForQuestion();
    const cancelling = client.submitPrompt("再确认一次，然后测试停止");
    void cancelling.completion.catch(() => undefined);
    await cancelReady;
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
