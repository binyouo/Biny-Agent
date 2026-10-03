import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-goal-host-"));
const oldAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "state");
let requests = 0;
let hold = false;
let noWork = false;
let held: ServerResponse | undefined;
const prompts: string[] = [];
const userInputs: string[] = [];
function send(response: ServerResponse, delta: unknown, finish = "stop"): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
}
const provider = createServer((request, response) => { void (async () => {
  let source = "";
  for await (const chunk of request) source += String(chunk);
  const body = JSON.parse(source) as { messages: unknown[]; tools?: Array<{ function?: { name?: string } }> };
  if (!body.tools?.some(tool => tool.function?.name === "GoalUpdate")) {
    send(response, { content: JSON.stringify({ skillIds: [], tools: [] }) });
    return;
  }
  prompts.push(JSON.stringify(body.messages));
  requests += 1;
  if (hold) { held = response; return; }
  if (noWork) { send(response, { content: "目标尚未完成，下一步继续检查。" }); return; }
  if (requests === 1) { send(response, { content: "阶段工作结束，仍需产出并验证文件。" }); return; }
  const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `goal-tool-${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  if (requests === 2) { send(response, call("Write", { path: "result.txt", content: "goal-result\n" }), "tool_calls"); return; }
  if (requests === 3) {
    send(response, call("GoalUpdate", { status: "completed", evidence: { summary: "目标逐项完成。", requirements: [{ requirement: "创建 result.txt", evidence: "Write 工具已成功写入 goal-result。" }] } }), "tool_calls");
    return;
  }
  send(response, { content: "已产出并验证 result.txt。" });
})().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }); });
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
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let goalOwnerClient: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Goal did not reach the expected state: ${JSON.stringify(value)}`);
}
try {
  let factories = 0;
  host = await startRuntimeHost(root, async () => {
    factories += 1;
    return await createInteractiveAgentHost(root, { sessionId: "goal-session", configStore: { load: async () => config, save: async () => undefined } });
  });
  client = await connectRuntimeHost(root);
  client.subscribe(update => {
    if (update.event?.type === "message.user") userInputs.push(update.event.content);
    if (update.event?.type === "permission.requested") {
      void client!.request("permission", { sessionId: update.event.sessionId, requestId: update.event.requestId, result: { approved: true, action: "allow_once", scope: "once" } });
    }
  });
  assert.equal(await client.request("session.goal.get", { sessionId: "missing-session" }), undefined, "A cold Goal query must not create a runtime.");
  assert.equal(factories, 1);
  const set = await client.request<{ accepted: boolean; result?: { goalId: string; revision: number } }>("session.goal.set", { sessionId: "goal-session", objective: "创建 result.txt，内容为 goal-result，并验证产物。", tokenBudget: 10_000 });
  assert.equal(set.accepted, true, JSON.stringify(set));
  const goal = await eventually(() => client!.request<{ status: string; tokensUsed: number }>("session.goal.get", { sessionId: "goal-session" }), value => value.status === "completed");
  assert.ok(goal.tokensUsed > 0, "Provider usage must be accounted to the persistent Goal.");
  await client.waitForIdle("goal-session");
  assert.equal(await readFile(path.join(root, "result.txt"), "utf8"), "goal-result\n");
  assert.ok(prompts.length >= 4);
  for (const prompt of prompts) assert.match(prompt, /创建 result.txt，内容为 goal-result，并验证产物/u, "The complete objective must remain visible in every Goal request.");
  const { snapshot } = await client.request<{ snapshot: InteractiveRuntimeSnapshot }>("snapshot", { sessionId: "goal-session" });
  const events = await readSessionEvents(snapshot.info.sessionFile);
  const turns = events.filter(event => event.type === "turn_status");
  assert.ok(new Set(turns.map(event => event.runtime?.turnId)).size >= 2, "Natural stop must continue in a new turn in the same session.");
  assert.ok(events.some(event => event.type === "tool_call" && event.tool === "GoalUpdate"));
  assert.deepEqual(events.filter(event => event.type === "user_message" && !event.auditOnly).map(event => event.content),
    ["创建 result.txt，内容为 goal-result，并验证产物。"], "The original objective is the only visible user input; automatic turns must not fabricate user messages.");

  assert.deepEqual(userInputs, ["创建 result.txt，内容为 goal-result，并验证产物。"], "The live timeline must also receive only the original input.");
  hold = true;
  const next = await client.request<{ accepted: boolean }>("session.goal.set", { sessionId: "goal-session", objective: "持续检查直到用户暂停。" });
  assert.equal(next.accepted, true);
  await eventually(async () => held !== undefined, Boolean);
  const active = await client.request<{ snapshot: InteractiveRuntimeSnapshot }>("snapshot", { sessionId: "goal-session" });
  assert.equal(active.snapshot.state.kind, "runs");
  const activeRunId = active.snapshot.state.kind === "runs" ? active.snapshot.state.activeRun.runId : "";
  await assert.rejects(client.request("cancel", { sessionId: "goal-session", runId: activeRunId, reason: "invalid" }), /Cancellation reason/);
  assert.equal((await client.request<{ status: string }>("session.goal.get", { sessionId: "goal-session" })).status, "active", "Rejected cancellation must not mutate the Goal.");
  const current = await client.request<{ goalId: string; revision: number }>("session.goal.get", { sessionId: "goal-session" });
  const paused = await client.request<{ accepted: boolean }>("session.goal.pause", { sessionId: "goal-session", expected: { goalId: current.goalId, revision: current.revision } });
  assert.equal(paused.accepted, true, JSON.stringify(paused));
  await client.waitForIdle("goal-session");
  assert.equal((await client.request<{ status: string }>("session.goal.get", { sessionId: "goal-session" })).status, "paused");
  const before = requests;
  const userInputsBeforeResume = [...userInputs];
  await client.request("session.goal.get", { sessionId: "goal-session" });
  await client.waitForIdle("goal-session");
  assert.equal(requests, before, "A paused Goal cannot be restarted by turn cleanup or querying.");
  await client.request("session.goal.resume", { sessionId: "goal-session" });
  await client.request("client.pause-owned-runs", {});
  assert.equal((await client.request<{ status: string }>("session.goal.get", { sessionId: "goal-session" })).status, "paused", "Client exit must also pause its durable Goal between turns, without retaining an idle writer lease.");

  await client.waitForIdle("goal-session");
  await client.close();
  client = await connectRuntimeHost(root);
  await client.request("session.ensure", { sessionId: "goal-session", writeIntent: true });
  goalOwnerClient = await connectRuntimeHost(root);
  held = undefined;
  await goalOwnerClient.request("session.goal.resume", { sessionId: "goal-session" });
  await eventually(async () => held !== undefined, Boolean);
  const otherRun = await goalOwnerClient.request<{ snapshot: InteractiveRuntimeSnapshot }>("snapshot", { sessionId: "goal-session" });
  assert.equal(otherRun.snapshot.state.kind, "runs");
  await client.request("client.pause-owned-runs", {});
  assert.equal((await goalOwnerClient.request<{ status: string }>("session.goal.get", { sessionId: "goal-session" })).status, "active", "An idle writer client's exit must not pause a Goal owned by another client.");
  const afterOtherExit = await goalOwnerClient.request<{ snapshot: InteractiveRuntimeSnapshot }>("snapshot", { sessionId: "goal-session" });
  assert.equal(afterOtherExit.snapshot.state.kind, "runs", "The other client's active Goal run must remain running.");
  if (otherRun.snapshot.state.kind === "runs" && afterOtherExit.snapshot.state.kind === "runs") {
    assert.equal(afterOtherExit.snapshot.state.activeRun.runId, otherRun.snapshot.state.activeRun.runId);
  }
  assert.deepEqual(userInputs, userInputsBeforeResume, "Resuming the same goal must not repeat the original input.");
  await goalOwnerClient.request("client.pause-owned-runs", {});
  assert.equal((await goalOwnerClient.request<{ status: string }>("session.goal.get", { sessionId: "goal-session" })).status, "paused");

  // A real Host and provider boundary must suppress textual automatic spinning,
  // persist the reason, and allow explicit recovery through the same public RPC.
  await goalOwnerClient.close();
  goalOwnerClient = await connectRuntimeHost(root);
  hold = false; noWork = true;
  const beforeNoWork = requests;
  const noWorkSet = await goalOwnerClient.request<{ accepted: boolean }>("session.goal.set", { sessionId: "goal-session", objective: "创建另一份产物并验证。" });
  assert.equal(noWorkSet.accepted, true);
  await goalOwnerClient.request("session.goal.resume", { sessionId: "goal-session" });
  const noWorkGoal = await eventually(() => goalOwnerClient!.request<{ status: string; evidence?: { summary: string } }>("session.goal.get", { sessionId: "goal-session" }), value => value.status === "paused" || requests - beforeNoWork > 2);
  assert.equal(noWorkGoal.status, "paused", "No-work turns must persist an automatic pause.");
  await goalOwnerClient.waitForIdle("goal-session");
  assert.equal(requests - beforeNoWork, 2, "Only the initial checkpoint and one internal audit may call the provider without working tools.");
  assert.match(noWorkGoal.evidence!.summary, /空转/u);
  const noWorkSnapshot = await goalOwnerClient.request<{ snapshot: InteractiveRuntimeSnapshot }>("snapshot", { sessionId: "goal-session" });
  const noWorkEvents = await readSessionEvents(noWorkSnapshot.snapshot.info.sessionFile);
  assert.equal(noWorkEvents.filter(event => event.type === "user_message" && event.content === "创建另一份产物并验证。" && !event.auditOnly).length, 1);
  const noWorkBeforeResume = requests;
  await goalOwnerClient.request("session.goal.resume", { sessionId: "goal-session" });
  await eventually(() => goalOwnerClient!.request<{ status: string }>("session.goal.get", { sessionId: "goal-session" }), value => value.status === "paused");
  await goalOwnerClient.waitForIdle("goal-session");
  assert.equal(requests - noWorkBeforeResume, 1, "Explicit resume permits one fresh internal audit and still prevents textual spinning.");
} finally {
  await goalOwnerClient?.close();
  await client?.close();
  await host?.close();
  held?.destroy();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("session goal host tests passed");
