/** 真实 Runtime、HTTP provider 协议和 session 落盘；不调用真实模型或用户配置。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { listAllSessionFiles } from "../src/session/store.js";
import { readSessionEvents } from "../src/session/events.js";
import { buildSessionTimeline, listChangedFiles } from "../src/desktop/renderer/src/sessionTimeline.js";
const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-runtime-"));
const oldAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "global");
let runtime: CommandRuntime | undefined;
let failure = true;
let written = false;
const prompts: string[] = [];
const provider = createServer((req, res) => { void (async () => {
  let source = "";
  for await (const chunk of req) source += String(chunk);
  const body = JSON.parse(source) as { messages: unknown[]; tools?: unknown[] };
  prompts.push(JSON.stringify(body.messages));
  if (failure) { res.writeHead(400); res.end(JSON.stringify({ error: { message: "test provider failure" } })); return; }
  const auxiliary = !body.tools?.length;
  const delta = auxiliary ? { content: JSON.stringify({ skillIds: [] }) } : written ? { content: "HEARTBEAT_OK" } : { tool_calls: [{ index: 0, id: "write-note", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "note.md", content: "已完成本地检查。" }) } }] };
  const finish = auxiliary || written ? "stop" : "tool_calls";
  if (!auxiliary) written = true;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }, "[DONE]"].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
})().catch(error => { res.writeHead(500); res.end(String(error)); }); });
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
try {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const config = configSchema.parse({ ...defaultConfig,
    defaultModel: "local", toolModel: "local",
    providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { local: { provider: "test", model: "local", capabilities: { tools: true, reasoning: false, streaming: true } } },
    thinking: { ...defaultConfig.thinking, enabled: false },
    chat: { ...defaultConfig.chat, defaultToolSelection: "all" },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  });
  runtime = await createCommandRuntime(workspace, { configStore: { load: async () => config, save: async () => undefined } });
  assert.equal(prompts.length, 0, "关闭心跳的 Runtime 启动不能自行生成日记");
  assert.equal(await runtime.heartbeat.triggerNow(), false);
  assert.match(runtime.heartbeat.status().lastError ?? "", /test provider failure/);
  failure = false;
  assert.equal(await runtime.heartbeat.triggerNow(), true);
  const files = await listAllSessionFiles();
  const events = (await Promise.all(files.map(file => readSessionEvents(file)))).flat();
  assert.equal(await readFile(path.join(workspace, "note.md"), "utf8"), "已完成本地检查。");
  for (const type of ["user_message", "assistant_message", "tool_call", "tool_result", "error"]) assert.ok(events.some(event => event.type === type), type);
  const outputs = buildSessionTimeline(events, []).flatMap(listChangedFiles);
  assert.deepEqual(outputs, [{ path: "note.md", operation: "write", status: "completed" }]);
  assert.equal(events.some(event => event.type === "message_metadata" && event.metadata.diaryPath), false);
  assert.equal(runtime.hasBackgroundWork(), false);
} finally {
  await runtime?.close();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("heartbeat runtime e2e tests passed");
