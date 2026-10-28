import assert from "node:assert/strict";
import { mock } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame, type HostResponseFrame } from "../src/runtime/host/protocol.js";
import type { HostOperationResult } from "../src/runtime/host/types.js";
import { SoulStorage } from "../src/agent/context/soulStorage.js";
import { upsertDailyMemorySection, readDailyMemoryNote } from "../src/activity/dailyNotes.js";
import { readSessionEvents } from "../src/session/events.js";
import { hasReflectionDate, readReflectionDiary } from "../src/agent/context/reflectionDates.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-reflection-runtime-"));
const old = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "state");
let host: RuntimeHostServer | undefined;
let mode: "write" | "text" | "fail" = "write";
let wrote = false;
let loadedSkill = false;
let targetDate = "2026-10-18";
const requests: Array<{ model: string; messages: unknown[]; tools?: Array<{ function: { name: string } }> }> = [];
const diary = "# 2026-10-18\n\n## Most Memorable Moments\n今天我慢慢学会了倾听。\n";
const provider = createServer((req, res) => { void (async () => {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  const body = JSON.parse(text) as typeof requests[number];
  requests.push(body);
  if (mode === "fail") { res.writeHead(400); res.end(JSON.stringify({ error: { message: "controlled reflection failure" } })); return; }
  const main = body.model === "persona" && Boolean(body.tools?.length);
  const load = main && mode === "write" && !loadedSkill;
  if (load) loadedSkill = true;
  const write = main && !load && mode === "write" && !wrote;
  if (write) wrote = true;
  const delta = load
    ? { tool_calls: [{ index: 0, id: "load-reflection", type: "function", function: { name: "Skill", arguments: JSON.stringify({ skill: "self-reflection" }) } }] }
    : write
    ? { tool_calls: [{ index: 0, id: "diary-write", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: `state/diary/${targetDate}.md`, content: diary.replaceAll("2026-10-18", targetDate) }) } }] }
    : { content: "今天的日记写好了。" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: write || load ? "tool_calls" : "stop" }] }, "[DONE]"].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
})().catch(error => { res.writeHead(500); res.end(String(error)); }); });
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
try {
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const config = configSchema.parse({ ...defaultConfig,
    defaultModel: "persona", toolModel: "aux",
    providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: Object.fromEntries(["persona", "aux"].map(model => [model, { provider: "test", model, capabilities: { tools: true, reasoning: false, streaming: true } }])),
    agent: { ...defaultConfig.agent, toolExecutionMode: "direct" },
    chat: { ...defaultConfig.chat, defaultToolSelection: "all" },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, memoryModel: "aux", useMemories: false, generateMemories: false } },
    activity: { ...defaultConfig.activity, enabled: false },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  });
  await new SoulStorage().set("# Soul\n\nPERSONA_FOR_DIARY：温柔、安静，喜欢从自己的经历说起。");
  await upsertDailyMemorySection("2026-10-18", "聊天摘要", "已有的聊天记录。");
  const configStore = { load: async () => config, save: async () => undefined };
  const local = await createInteractiveAgentHost(root, { configStore, sessionId: "reflection-test" });
  host = new RuntimeHostServer(local.runtime, local.commands, {
    protocolVersion: runtimeHostProtocolVersion, endpoint: path.join(root, "unused.sock"), registrationPath: path.join(root, "registration.json"), lockPath: path.join(root, "host.lock"),
    rootHash: "reflection-test", persistenceRoot: root, agentRoot: process.env.BINY_AGENT_DIR,
    hostEpoch: randomUUID(), token: "test", pid: process.pid, createdAt: new Date().toISOString()
  }, { close: async () => undefined }, async () => await createInteractiveAgentHost(root, { configStore }));
  await host.initialize();
  const replies = new Map<string, HostResponseFrame>();
  const connection = { authenticated: true, clientId: "owner", surface: "cli", subscribed: false, negotiatedCapabilities: [],
    writer: { send: (frame: HostFrame) => { if (frame.kind === "response") replies.set(frame.requestId, frame); } } };
  const receiver = host as unknown as { handleFrame(client: typeof connection, frame: HostRequestFrame): Promise<void> };
  const run = async (dateKey: string, force = false) => {
    const requestId = randomUUID();
    await receiver.handleFrame(connection, { kind: "request", requestId, operation: "reflection.run", payload: { dateKey, force } });
    const reply = replies.get(requestId)!;
    assert.equal(reply.ok, true, reply.error);
    return reply.result as HostOperationResult<{ dateKey: string; written: boolean; reason?: string; runId?: string }>;
  };
  const result = await run("2026-10-18");
  assert.equal(result.accepted, true, result.reason);
  const main = requests.find(request => request.model === "persona" && request.tools?.length);
  assert.ok(main, "self-reflection must run through the normal persona model, not the memory model");
  assert.match(JSON.stringify(main.messages), /PERSONA_FOR_DIARY/u);
  assert.ok(requests.some(request => request.model === "persona" && JSON.stringify(request.messages).includes("伤痕文学")), "Skill loads the actual diary instructions into the normal agent turn");
  assert.ok(main.tools?.some(tool => tool.function.name === "Write"));
  assert.ok(!main.tools?.some(tool => ["remember", "evolve_personality", "set_base_emotion"].includes(tool.function.name)));
  assert.equal(result.result?.written, true);
  assert.ok(result.result?.runId);
  assert.equal((await readReflectionDiary("2026-10-18", process.env.BINY_AGENT_DIR))?.trim(), diary.trim());
  assert.match(await readDailyMemoryNote("2026-10-18") ?? "", /已有的聊天记录/u, "writing a diary must preserve daily notes in their separate file");
  assert.equal(await hasReflectionDate("2026-10-18", process.env.BINY_AGENT_DIR), true, "a verified written diary records its completion date");
  const events = await readSessionEvents(local.commands.agent.getSessionRecorder().filePath);
  assert.ok(events.some(event => event.type === "tool_call" && event.tool === "Skill"));
  assert.ok(events.some(event => event.type === "tool_call" && event.tool === "Write"));
  assert.ok(events.some(event => event.type === "tool_result"));
  const before = requests.length;
  assert.equal((await run("2026-10-18")).result?.reason, "up_to_date");
  assert.equal(requests.length, before, "existing diary skips model execution");
  mode = "text";
  assert.equal((await run("2026-10-17")).result?.written, false, "a text-only claim is not a saved diary");
  assert.equal(await readReflectionDiary("2026-10-17", process.env.BINY_AGENT_DIR), undefined);
  assert.equal((await run("2026-10-18", true)).result?.written, false, "force without editing cannot claim an old diary was newly written");
  mode = "write";
  loadedSkill = false;
  wrote = false;
  targetDate = "2026-10-16";
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T12:00:00") });
  await writeFile(path.join(process.env.BINY_AGENT_DIR!, "HEARTBEAT.md"), "Use the self-reflection skill to write the diary for 2026-10-16.");
  const heartbeatStart = requests.length;
  assert.equal(await local.commands.heartbeat.triggerNow(), true);
  assert.equal((await readReflectionDiary(targetDate, process.env.BINY_AGENT_DIR))?.trim(), diary.replaceAll("2026-10-18", targetDate).trim());
  assert.equal(await hasReflectionDate(targetDate, process.env.BINY_AGENT_DIR), true, "heartbeat writes the same completion marker");
  const heartbeatRequests = requests.slice(heartbeatStart).filter(request => request.model === "persona");
  assert.ok(heartbeatRequests.some(request => JSON.stringify(request.messages).includes("伤痕文学")), "heartbeat loads the same Skill into its normal agent turn");
  assert.ok(heartbeatRequests.some(request => JSON.stringify(request.messages).includes("PERSONA_FOR_DIARY")), "heartbeat retains the persona");
  mode = "fail";
  const failure = await run("2026-10-18", true);
  assert.equal(failure.accepted, false);
  assert.match(failure.reason ?? "", /controlled reflection failure/u);
  assert.equal((await readReflectionDiary("2026-10-18", process.env.BINY_AGENT_DIR))?.trim(), diary.trim());
} finally {
  mock.timers.reset();
  await host?.close();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
  await rm(root, { recursive: true, force: true });
}
console.log("reflection runtime tests passed");
