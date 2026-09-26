/** 通过全局 biny 与真实 PTY，验证多个终端和一次性命令共享 Host 时的 Session 边界。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { globalConfigDir } from "../src/config/paths.js";
import { saveConfigFile } from "../src/config/loader.js";
import { connectRuntimeHost, runtimeHostPaths, type RuntimeHostClient } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-cli-parallel-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const responses = new Map<string, ServerResponse>();
const provider = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  const body = JSON.parse(text) as { messages: Array<{ role: string; content: unknown }> };
  const marker = JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1)?.content).match(/terminal-probe-[A-F]/gu)?.at(-1);
  if (!marker || responses.has(marker)) { sendText(response, "[]"); return; }
  responses.set(marker, response);
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
// 默认从源码运行，方便 CI；本机跨目录验收显式使用编译后的全局 biny。
const cli = process.env.BINY_TEST_GLOBAL_CLI === "1"
  ? { executable: "biny", args: [] }
  : { executable: process.execPath, args: [...process.execArgv, path.resolve("src/cli/index.ts")] };
const terminals: Array<{ pty: IPty; output: string; exited: boolean }> = [];
let client: RuntimeHostClient | undefined;
let hostPid: number | undefined;
try {
  await saveConfigFile(globalConfigDir(), configSchema.parse({
    ...defaultConfig,
    defaultModel: "local-test",
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    thinking: { ...defaultConfig.thinking, enabled: false },
    chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "all" },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  }));
  const first = openTui();
  await waitFor(() => first.output.includes("openai-compatible/local-test"));
  client = await connectRuntimeHost(root, { clientId: "parallel-observer", surface: "cli" });
  assert.ok(client);
  hostPid = (JSON.parse(await readFile(runtimeHostPaths(root).registrationPath, "utf8")) as { pid: number }).pid;
  await enter(first.pty, "terminal-probe-A");
  await waitFor(() => responses.has("terminal-probe-A"));
  const a = await activeSession("terminal-probe-A");

  const second = openTui();
  await waitFor(() => second.output.includes("openai-compatible/local-test"));
  await enter(second.pty, "terminal-probe-B");
  await waitFor(() => responses.has("terminal-probe-B"));
  const b = await activeSession("terminal-probe-B");
  assert.notEqual(a, b, "新窗口不能附着并写入正在运行的 A");
  await enter(first.pty, "/new");
  await waitFor(() => first.output.includes("New chat started."));
  await enter(first.pty, "terminal-probe-C");
  await waitFor(() => responses.has("terminal-probe-C"));
  const c = await activeSession("terminal-probe-C");
  assert.notEqual(a, c);
  await enter(first.pty, `/resume ${a}`);
  await waitFor(() => first.output.includes(`session ${a.slice(0, 8)}`));
  assert.equal(client.getSnapshot(c).state.kind, "runs", "忙碌时恢复 A 不得中断 C");
  first.pty.write("\u0003");
  await waitFor(() => client!.getSnapshot(a).state.kind === "idle");
  assert.equal(client.getSnapshot(b).state.kind, "runs");
  assert.equal(client.getSnapshot(c).state.kind, "runs");
  await enter(first.pty, "/exit");
  await waitFor(() => first.exited);
  await waitFor(() => client!.getSnapshot(c).state.kind === "idle");
  assert.equal(client.getSnapshot(b).state.kind, "runs", "关闭一个窗口不能取消另一窗口的 B");
  sendText(responses.get("terminal-probe-B")!, "terminal-probe-B-done");
  await waitFor(() => client!.getSnapshot(b).state.kind === "idle");
  await enter(second.pty, "/exit");
  await waitFor(() => second.exited);

  const removedCommand = await command(["plan", "must not execute"]);
  assert.notEqual(removedCommand.code, 0);
  assert.match(removedCommand.output, /unknown command.*plan/u);

  // 主 Session 此刻空闲；两个独立命令仍必须各自新建会话，不竞抢 primary。
  const firstRun = command(["run", "--json", "terminal-probe-D"]);
  const run = command(["run", "--json", "terminal-probe-E"]);
  await waitFor(() => responses.has("terminal-probe-D") && responses.has("terminal-probe-E"));
  const d = await activeSession("terminal-probe-D");
  const e = await activeSession("terminal-probe-E");
  assert.notEqual(d, e);
  sendText(responses.get("terminal-probe-D")!, "terminal-probe-D-done");
  sendText(responses.get("terminal-probe-E")!, "terminal-probe-E-done");
  assert.equal((await firstRun).code, 0);
  const result = await run;
  assert.equal(result.code, 0, result.output);
  assert.equal((JSON.parse(result.stdout) as { sessionId: string }).sessionId, e);
  const dEvents = await readSessionEvents(sessionFilePath(root, d));
  const eEvents = await readSessionEvents(sessionFilePath(root, e));
  assert.ok(!JSON.stringify(dEvents).includes("terminal-probe-E"));
  assert.ok(!JSON.stringify(eEvents).includes("terminal-probe-D"));

  const incompleteRun = command(["run", "--json", "--", "- terminal-probe-F"]);
  await waitFor(() => responses.has("terminal-probe-F"));
  sendText(responses.get("terminal-probe-F")!, "partial result", "other");
  const incomplete = await incompleteRun;
  assert.equal(incomplete.code, 0, incomplete.output);
  const incompleteResult = JSON.parse(incomplete.stdout) as { status: string; stopReason: string };
  assert.equal(incompleteResult.status, "incomplete");
  assert.equal(incompleteResult.stopReason, "budget_exhausted");
  console.log("CLI/TUI multi-session tests passed (two PTYs, new/resume, cancellation, exit, concurrent runs)");
} catch (error) {
  for (const terminal of terminals) console.error(terminal.output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").slice(-3500));
  throw error;
} finally {
  for (const terminal of terminals) if (!terminal.exited) terminal.pty.kill();
  await client?.close();
  if (hostPid !== undefined && hostPid !== process.pid) {
    try { process.kill(hostPid, "SIGTERM"); } catch { /* Host 已退出。 */ }
    await waitFor(() => {
      try { process.kill(hostPid!, 0); return false; } catch { return true; }
    });
  }
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

function openTui(): typeof terminals[number] {
  const terminal = { pty: spawnPty(cli.executable, [...cli.args, "tui"], { cwd: root, cols: 100, rows: 35, env: { ...process.env, TERM: "xterm-256color" } }), output: "", exited: false };
  terminal.pty.onData((data) => { terminal.output += data; });
  terminal.pty.onExit(() => { terminal.exited = true; });
  terminals.push(terminal);
  return terminal;
}
async function enter(pty: IPty, text: string): Promise<void> {
  pty.write(text);
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  pty.write("\r");
}
async function activeSession(input: string): Promise<string> {
  const sessions = await client!.listRuntimeSessions();
  const target = sessions.find((entry) => entry.snapshot.state.kind === "runs" && entry.snapshot.state.activeRun.input.includes(input));
  assert.ok(target, `missing active session ${input}`);
  return target.sessionId;
}
function sendText(response: ServerResponse, text: string, finishReason = "stop"): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
}
function command(args: string[]): Promise<{ code: number | null; output: string; stdout: string }> {
  const child = spawn(cli.executable, [...cli.args, ...args], { cwd: root, env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += String(data); });
  child.stderr.on("data", (data) => { stderr += String(data); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output: stdout + stderr, stdout }));
  });
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 25000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for CLI/TUI parallel state");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
