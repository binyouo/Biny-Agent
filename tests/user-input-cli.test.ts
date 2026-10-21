import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, realpath, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";

const execFile = promisify(execFileCallback);
const loader = createRequire(import.meta.url).resolve("tsx");
const cli = path.resolve("src/cli/index.ts");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test("input 命令帮助区分发起、查看与回答，并提供同一套输入示例", async () => {
  for (const action of ["ask", "list", "answer"] as const) {
    const result = await execFile(process.execPath, ["--import", loader, cli, "input", action, "--help"], { timeout: 10_000 });
    assert.match(result.stdout, new RegExp(`Usage: biny input ${action}\\b`, "u"));
    assert.match(result.stdout, /--session <id>/u);
    assert.match(result.stdout, /--json/u);
    assert.match(result.stdout, /Examples:/u);
  }
});

test("input 参数错误只写 stderr，以非零状态退出，不污染 JSON stdout", async () => {
  const cases = [
    { args: ["ask", "问题", "--input", "{}", "--json"], message: /Provide either a question/u },
    { args: ["ask", "--input", "{", "--json"], message: /JSON|property name/iu },
    { args: ["list", "--json"], message: /Provide --session/u },
    { args: ["answer", "call", "--run", "run", "--skip", "--text", "回答", "--json"], message: /Provide --answers/u }
  ];
  for (const entry of cases) {
    await assert.rejects(execFile(process.execPath, ["--import", loader, cli, "input", ...entry.args], {
      env: { ...process.env, BINY_AGENT_SESSION_ID: undefined, BINY_AGENT_CONTEXT: undefined }, timeout: 10_000
    }), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "stderr" in error && "code" in error);
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(String(error.stderr), entry.message);
      assert.doesNotMatch(String(error.stderr), /\n\s+at /u);
      return true;
    });
  }
});

for (const executionMode of ["direct", "code_mode"] as const) {
  test(`${executionMode}: 前台 CLI 发起提问，共用卡片、审计和取消边界`, { timeout: 45_000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-input-cli-")));
    const savedAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    const biny = [process.execPath, "--import", loader, cli].map(quote).join(" ");
    const scopeFile = path.join(root, "scope.json");
    const capture = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(scopeFile)}, JSON.stringify({scope:process.env.BINY_AGENT_CONTEXT,sessionId:process.env.BINY_AGENT_SESSION_ID}))`].map(quote).join(" ");
    const questions = { questions: [{ id: "place", question: "放在哪里？", options: [{ label: "桌面" }, { label: "下载目录" }] }] };
    let command = `${capture} && ${biny} input ask --input ${quote(JSON.stringify(questions))} --json`;
    let shellTimeoutMs = 15_000;
    let steps = 0;
    const modelResults: string[] = [];
    const shellResults: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
    const pendingAtModelReturn: number[] = [];
    const failures: unknown[] = [];
    const provider = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        let delta: Record<string, unknown>;
        let reason = "stop";
        if (!Array.isArray(body.tools)) delta = { content: '{"tools":[]}' };
        else if (steps++ === 0) {
          const name = executionMode === "direct" ? "Bash" : "run_script";
          const args = name === "Bash" ? { command, timeoutMs: shellTimeoutMs }
            : { description: "Run fixture workflow", code: `return await tools.Bash(${JSON.stringify({ command, timeoutMs: shellTimeoutMs })});` };
          delta = { tool_calls: [{ index: 0, id: `ask-cli-${modelResults.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
          reason = "tool_calls";
        } else {
          const message = body.messages.findLast((entry: { role: string }) => entry.role === "tool");
          modelResults.push(JSON.stringify(message));
          let value = JSON.parse(message.content);
          if (Array.isArray(value)) value = JSON.parse(value.map((part: { text?: string }) => part.text ?? "").join(""));
          shellResults.push(value.ok === false ? { stdout: "", stderr: String(value.error), exitCode: 1 } : value.value ?? value);
          pendingAtModelReturn.push((await client!.pendingUserInput(client!.getSnapshot().info.sessionId)).length);
          delta = { content: "已处理你的回答。" };
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        failures.push(error);
        response.writeHead(500);
        response.end(String(error));
      }
    });
    let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
    let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
    try {
      await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      assert.ok(address && typeof address === "object");
      await saveConfig(root, configSchema.parse({
        ...defaultConfig, defaultModel: "fixture", thinking: { ...defaultConfig.thinking, enabled: false },
        agent: { ...defaultConfig.agent, toolExecutionMode: executionMode },
        permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [], criticalAlwaysAsk: false },
        providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
        models: { fixture: { provider: "local", model: "fixture", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
        context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
      }));
      host = await startRuntimeHost(root, async resourceRegistry => await createInteractiveAgentHost(root, { resourceRegistry }), { createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); } });
      client = await connectRuntimeHost(root, { surface: "desktop", clientId: "cli-question-test" });
      assert.ok(client);
      const connected = client;
      const sessionId = connected.getSnapshot().info.sessionId;
      const runCli = async (args: string[], env = process.env): Promise<{ stdout: string; stderr: string }> => await execFile(process.execPath, ["--import", loader, cli, "input", ...args], { cwd: root, env, timeout: 10_000 });
      const nextQuestion = async (runId: string): Promise<string> => {
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("CLI question was not published.")), 10_000);
            unsubscribe = connected.subscribe(({ event }) => {
              if (event?.runId !== runId) return;
              if (event.type === "tool.progress" && event.tool === "AskUserQuestion" && event.update.customKind === "user_input") resolve(event.toolCallId);
              else if (event.type === "run.completed" || event.type === "run.failed") reject(new Error(`Run ended without a question: ${modelResults.at(-1)}`));
            });
          });
        } finally { clearTimeout(timer); unsubscribe(); }
      };
      let run = connected.submitPrompt("先确认存放位置，再继续工作");
      void run.completion.catch(() => undefined);
      const toolCallId = await nextQuestion(run.runId);
      const scope = JSON.parse(await readFile(scopeFile, "utf8")) as { scope: string; sessionId: string };
      assert.equal(scope.sessionId, sessionId);
      assert.deepEqual((await connected.pendingUserInput(sessionId)).map(request => request.toolCallId), [toolCallId]);
      assert.equal(steps, 1, "等待用户期间不继续请求模型");
      await assert.rejects(connected.sessionCommand("AskUserQuestion", questions, "foreign-session", scope.scope), /expired|another run/u);
      await assert.rejects(connected.sessionCommand("AskUserQuestion", questions, sessionId), /foreground.*context/u);
      const listed = await runCli(["list", "--json"], { ...process.env, BINY_AGENT_SESSION_ID: sessionId });
      assert.equal(JSON.parse(listed.stdout)[0].toolCallId, toolCallId);
      await runCli(["answer", toolCallId, "--session", sessionId, "--run", run.runId, "--question", "place", "--text", "下载目录", "--json"]);
      assert.equal((await run.completion).status, "completed");
      assert.equal(shellResults[0]!.exitCode, 0, shellResults[0]!.stderr);
      assert.deepEqual(JSON.parse(shellResults[0]!.stdout).response, { status: "answered", answers: [{ id: "place", selected: [], text: "下载目录" }] });
      await assert.rejects(connected.sessionCommand("AskUserQuestion", questions, sessionId, scope.scope), /expired|another run/u);
      const events = (await readFile(connected.getSnapshot().info.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as SessionEvent);
      assert.equal(events.filter(event => event.type === "tool_call" && event.tool === "AskUserQuestion").length, 1);
      assert.equal(events.filter(event => event.type === "tool_result" && event.tool === "AskUserQuestion").length, 1);
      const cards = buildSessionTimeline(events, []).flatMap(turn => turn.tools).filter(tool => tool.tool === "AskUserQuestion");
      assert.equal(cards.length, 1);
      assert.match(JSON.stringify(cards), /下载目录/u);
      command = `${biny} input ask ${quote("项目名称是什么？")} --json`;
      steps = 0;
      run = connected.submitPrompt("再确认项目名称");
      void run.completion.catch(() => undefined);
      const skippedId = await nextQuestion(run.runId);
      assert.deepEqual((await connected.pendingUserInput(sessionId))[0]?.questions, [{ id: "answer", question: "项目名称是什么？", options: [], multiSelect: false }]);
      await runCli(["answer", skippedId, "--session", sessionId, "--run", run.runId, "--skip", "--json"]);
      assert.equal((await run.completion).status, "completed");
      assert.equal(shellResults[1]!.exitCode, 0, shellResults[1]!.stderr);
      assert.deepEqual(JSON.parse(shellResults[1]!.stdout).response, { status: "skipped" });
      command = `${biny} input ask ${quote("等待到命令超时")} --json`;
      shellTimeoutMs = 2_500;
      steps = 0;
      run = connected.submitPrompt("测试命令超时后清理等待");
      void run.completion.catch(() => undefined);
      const timedOutId = await nextQuestion(run.runId);
      assert.equal((await run.completion).status, "completed");
      assert.match(modelResults[2]!, /timeout|timed out|cancelled/iu);
      assert.deepEqual(pendingAtModelReturn, [0, 0, 0], "Shell 返回后、回合结束前，所有提问等待都已清理");
      await assert.rejects(connected.answerUserInput(sessionId, run.runId, timedOutId, { status: "skipped" }), /no longer pending/u);
      shellTimeoutMs = 15_000;
      steps = 0;
      run = connected.submitPrompt("测试等待期间停止");
      void run.completion.catch(() => undefined);
      const cancelledId = await nextQuestion(run.runId);
      await connected.cancelRunRequest(run.runId, "cancelled", sessionId);
      assert.equal((await run.completion).status, "cancelled");
      assert.deepEqual(await connected.pendingUserInput(sessionId), []);
      await assert.rejects(connected.answerUserInput(sessionId, run.runId, cancelledId, { status: "skipped" }), /no longer pending/u);
      await assert.rejects(runCli(["ask", "无人接收的问题", "--json"]), /foreground.*context/u);
      await assert.rejects(runCli(["ask", "重复问题", "--input", JSON.stringify(questions)]), /Provide.*question.*--input/u);
      assert.deepEqual(failures, []);
    } finally {
      await client?.close();
      await host?.close();
      provider.closeAllConnections();
      if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
      if (savedAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = savedAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
