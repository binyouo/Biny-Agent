import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/RuntimeHost.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli/index.js");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-goal-cli-")));
let noWork = false;
let mainRequests = 0;
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "state");
const provider = createServer((request, response) => { void (async () => {
  let source = "";
  for await (const chunk of request) source += String(chunk);
  const body = JSON.parse(source) as { tools?: Array<{ function?: { name?: string } }> };
  // 主请求保持在途，使控制命令与真实运行的取消边界可以稳定验证。
  const main = body.tools?.some(tool => tool.function?.name === "GoalUpdate");
  if (main) {
    mainRequests += 1;
    if (!noWork) return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    { choices: [{ index: 0, delta: { content: main ? "目标未完成，下一步继续。" : '{"skillIds":[],"tools":[]}' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
})().catch(error => { response.destroy(error instanceof Error ? error : new Error(String(error))); }); });
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
const config = configSchema.parse({ ...defaultConfig,
  defaultModel: "local", toolModel: "local",
  providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
  models: { local: { provider: "test", model: "local", capabilities: { tools: true, reasoning: false, streaming: true } } },
  permission: { ...defaultConfig.permission, mode: "auto" },
  thinking: { ...defaultConfig.thinking, enabled: false },
  chat: { ...defaultConfig.chat, defaultToolSelection: "all" },
  crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
  extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: false }, skills: [] },
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }
});
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
const run = async (...args: string[]) => await exec(process.execPath, [cli, "goal", ...args], {
  cwd: root, env: { ...process.env }, timeout: 15_000, maxBuffer: 1024 * 1024
});
const read = async () => JSON.parse((await run("show", "--session", "goal-cli", "--json")).stdout) as { objective: string; status: string; evidence?: { summary: string } } | null;
try {
  assert.match((await run("--help")).stdout, /set.*show|show.*set/su);
  assert.match((await run("set", "--help")).stdout, /--session.*--token-budget/su);
  assert.equal(await read(), null, "cold CLI query is available before a Host exists");
  host = await startRuntimeHost(root, async () => await createInteractiveAgentHost(root, {
    sessionId: "goal-cli", configStore: { load: async () => config, save: async () => undefined }
  }));
  const objective = "完成当前任务\n保留  所有验收条件";
  const set = JSON.parse((await run("set", objective, "--session", "goal-cli", "--json")).stdout) as { sessionId: string; objective: string; status: string };
  assert.equal(set.sessionId, "goal-cli");
  assert.equal(set.status, "active");
  assert.equal(set.objective, objective);
  assert.equal((await read())?.objective, objective);
  await run("pause", "--session", "goal-cli", "--json");
  assert.equal((await read())?.status, "paused");
  await run("resume", "--session", "goal-cli", "--json");
  assert.equal((await read())?.status, "active");
  await run("clear", "--session", "goal-cli", "--json");
  assert.equal(await read(), null);
  noWork = true;
  const beforeNoWork = mainRequests;
  await run("set", "创建并检查产物", "--session", "goal-cli", "--json");
  const deadline = Date.now() + 15_000;
  let pausedGoal = await read();
  while (pausedGoal?.status !== "paused" && mainRequests - beforeNoWork <= 2 && Date.now() < deadline) {
    pausedGoal = await read();
  }
  assert.equal(pausedGoal?.status, "paused", "The built CLI must observe the real Host stopping textual continuation.");
  assert.equal(mainRequests - beforeNoWork, 2);
  assert.match(pausedGoal.evidence!.summary, /空转/u);
  assert.match((await run("show", "--session", "goal-cli")).stdout, /空转/u, "Text output must explain the stop.");
  await host.close();
  host = undefined;
  assert.deepEqual(await read(), pausedGoal, "The stopped goal and its reason are also available through cold CLI JSON after Host exit.");
} finally {
  await host?.close();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("session goal built CLI tests passed");
