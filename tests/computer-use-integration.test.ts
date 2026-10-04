import assert from "node:assert/strict";
import { generateText } from "ai";
import { createVercelLanguageModel, type VercelModelInput } from "../src/llm/vercelModel.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage, AgentToolResultContent } from "../src/agent/core/types.js";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createComputerUseTools, requestComputer } from "../src/tools/computerUse.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { parseCuaReply, CuaProcessDriver } from "../src/computer/cuaDriver.js";
import { CaptureSchedule, CaptureBusyError } from "../src/computer/captureSchedule.js";
import { ActivityCaptureEngine } from "../src/activity/captureEngine.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { boundComputerFrames } from "../src/computer/modelFrames.js";
import { applyCuaQaProfile } from "../src/desktop/electron/main/cuaQaProfile.js";
import { writeFile, mkdir } from "node:fs/promises";

const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];
function test(name: string, run: () => void | Promise<void>): void { cases.push({ name, run }); }

test("missing static SDK process is diagnosed and startup stays disabled", async () => {
  const root = await mkdtemp("/tmp/biny-cua-process-missing-"); let exited = 0;
  try {
    const driver = new CuaProcessDriver(() => { exited++; }, new URL(`file://${root}/missing-process.mjs`));
    await assert.rejects(driver.start(), /driver_sdk_missing_or_crashed/);
    await driver.stop(); assert.equal(exited, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("static process bridge forwards cancellation and permits clean stop/reopen", async () => {
  let exits = 0;
  const driver = new CuaProcessDriver(() => { exits++; }, new URL("./fixtures/cua-process-fixture.mjs", import.meta.url));
  await driver.start();
  try {
    const abort = new AbortController();
    const pending = driver.act("fixture", { pid: 42, windowId: "900", action: "press_key", captureId: "c1", delivery: "background", key: "Enter" }, abort.signal);
    await driver.diagnostics();
    abort.abort();
    await assert.rejects(pending, /SDK signal aborted/);
    await driver.stop(); await driver.start();
    assert.equal((await driver.list("fixture", undefined, new AbortController().signal)).data.method, "list");
  } finally { await driver.stop(); }
  assert.equal(exits, 0, "intentional stop must not report a crash");
});
test("stop retires the isolated host and re-enable creates a fresh instance", async () => {
  const driver = new CuaProcessDriver(() => undefined, new URL("./fixtures/cua-process-fixture.mjs", import.meta.url));
  try {
    await driver.start();
    const before = (await driver.diagnostics()).data.hostInstance;
    assert.equal(typeof before, "number");
    process.kill(before as number, 0);
    await driver.stop();
    assert.throws(() => process.kill(before as number, 0), { code: "ESRCH" }, "stop resolves only after the child PID exits");
    await assert.rejects(async () => driver.list("s", undefined, new AbortController().signal), /driver_not_connected/);
    await driver.start();
    assert.notEqual((await driver.diagnostics()).data.hostInstance, before, "a stopped host must not retain native callbacks across re-enable");
  } finally { await driver.stop(); }
});
test("actual model projection retains only two recent Cua frames without mutating history", () => {
  const messages: AgentMessage[] = [1, 2, 3, 4].map(index => ({ role: "toolResult", toolName: "ComputerObserve", toolCallId: String(index), content: [{ type: "image", mimeType: "image/png", data: Buffer.from(`frame-${index}`).toString("base64") }] }));
  const bounded = boundComputerFrames(messages);
  assert.equal(bounded.filter(message => message.role === "toolResult" && message.content.some(part => part.type === "image")).length, 2);
  const outgoing = JSON.stringify(toModelMessages(messages));
  assert.equal(outgoing.includes(Buffer.from("frame-1").toString("base64")), false);
  assert.match(outgoing, new RegExp(Buffer.from("frame-4").toString("base64")));
  assert.equal(messages.every(message => message.role === "toolResult" && message.content[0]?.type === "image"), true);
});
test("QA profile fails closed unless passive collection is disabled and isolates both data roots", async () => {
  assert.throws(() => applyCuaQaProfile({ getName: () => "Biny Cua QA", setPath: () => undefined }, {}), /default profile is forbidden/);
  const root = await mkdtemp("/tmp/biny-cua-qa-"); const env: NodeJS.ProcessEnv = { BINY_CUA_QA_PROFILE: root };
  let selected = ""; const app = { setPath: (_name: "userData", value: string) => { selected = value; } };
  try {
    await mkdir(path.join(root, "agent"));
    await writeFile(path.join(root, "agent/config.json"), JSON.stringify({ activity: { enabled: true } }));
    assert.throws(() => applyCuaQaProfile(app, env)); assert.equal(selected, ""); assert.equal(env.BINY_AGENT_DIR, undefined);
    await writeFile(path.join(root, "agent/config.json"), JSON.stringify({ activity: { enabled: false, inputMonitoringEnabled: false, browserPollIntervalMs: 0 } }));
    assert.equal(applyCuaQaProfile(app, env), true); assert.equal(selected, path.join(root, "desktop")); assert.equal(env.BINY_AGENT_DIR, path.join(root, "agent"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("passive SDK diagnostics exit the cold process without enabling runtime", async () => {
  const driver = new CuaProcessDriver(() => undefined, new URL("./fixtures/cua-process-fixture.mjs", import.meta.url));
  try {
    const diagnostic = await driver.diagnostics();
    assert.equal(diagnostic.data.method, "diagnostics");
    assert.throws(() => process.kill(diagnostic.data.hostInstance as number, 0), { code: "ESRCH" });
    await assert.rejects(async () => driver.list("s", undefined, new AbortController().signal), /driver_not_connected/);
    await driver.start();
    assert.equal((await driver.list("s", undefined, new AbortController().signal)).data.method, "list");
  } finally { await driver.stop(); }
});
test("raw generic capture identity and SDK dataBase64 remain intact; malformed frame rejected", () => {
  const result = { text: "", images: [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }], structuredJson: JSON.stringify({ capture_id: "c1" }), rawJson: "{}", degraded: false, isError: false };
  assert.equal(parseCuaReply(result).data.capture_id, "c1");
  assert.equal(parseCuaReply(result).images[0]?.dataBase64, "aGVsbG8=");
  assert.throws(() => parseCuaReply({ ...result, images: [{ mimeType: "image/png", dataBase64: "not a frame" }] }));
  assert.equal(parseCuaReply({ ...result, isError: true, errorCode: "capture_frame_mismatch" }).errorCode, "capture_frame_mismatch");
});
test("Activity skips scheduled captures without fallback/native failure or image-memory mixing", async () => {
  let now = 0; const schedule = new CaptureSchedule(() => now);
  let passive = 0; let fallback = 0;
  const engine = new ActivityCaptureEngine({ now: () => now,
    native: () => schedule.run("activity", async () => { passive++; return Buffer.from("passive-only"); }),
    desktop: async () => { fallback++; return Buffer.from("fallback"); }, frame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }) });
  const settings = { ...defaultActivitySettings, captureDebounceMs: 0 };
  await schedule.run("active", async () => {
    assert.equal(await engine.capture(settings, "heartbeat"), undefined);
    await assert.rejects(schedule.run("activity", async () => Buffer.from("private")), CaptureBusyError);
  });
  assert.equal(passive, 0); assert.equal(fallback, 0);
  now = 2000; const frame = await engine.capture(settings, "heartbeat"); assert.equal(frame?.jpeg.toString(), "passive-only"); assert.equal(passive, 1);
});
test("a retained PiP frame blocks passive capture after cooldown until preview closes", async () => {
  let now = 0; const schedule = new CaptureSchedule(() => now);
  let passive = 0;
  const engine = new ActivityCaptureEngine({ now: () => now,
    native: () => schedule.run("activity", async () => { passive++; return Buffer.from("private-preview-visible"); }),
    desktop: () => schedule.run("activity", async () => { passive++; return Buffer.from("fallback-private-preview"); }),
    frame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }) });
  const settings = { ...defaultActivitySettings, captureDebounceMs: 0 };
  const closePreview = schedule.retainPreview();
  await schedule.run("active", async () => Buffer.from("cua-active-private-window"));
  now = 10_000;
  assert.equal(await engine.capture(settings, "heartbeat"), undefined);
  assert.equal(passive, 0);
  // Closing destroys the surface before releasing the hold. Idempotent release cannot underflow.
  closePreview(); closePreview();
  assert.equal((await engine.capture(settings, "heartbeat"))?.jpeg.toString(), "private-preview-visible");
  assert.equal(passive, 1);
});
test("in-flight passive frames are discarded across preview open/close/reopen epochs", async () => {
  const schedule = new CaptureSchedule();
  let release!: () => void;
  const oldEpoch = schedule.activityEpoch();
  const pending = schedule.run("activity", async () => { await new Promise<void>(resolve => { release = resolve; }); return Buffer.from("late-private-frame"); });
  await new Promise(resolve => setImmediate(resolve));
  const close = schedule.retainPreview(); close();
  const closeReopened = schedule.retainPreview(); closeReopened();
  assert.equal(schedule.canPersistActivity(oldEpoch), false, "current closed boolean cannot admit a frame from before the privacy transition");
  release(); await assert.rejects(pending, CaptureBusyError);
  const newEpoch = schedule.activityEpoch();
  assert.equal(schedule.canPersistActivity(newEpoch), true);
});
for (const mode of ["ask", "full-access"] as const) test(`Agent desktop permissions (${mode}) preserve transport and image audit boundaries`, async () => {
  const root = await mkdtemp("/tmp/biny-computer-agent-");
  const endpoint = { endpoint: path.join(root, "control.sock"), token: "fixture-secret" };
  let requests = 0; let approvals = 0;
  const server = net.createServer(socket => { socket.setEncoding("utf8"); socket.on("data", (line: string) => {
    requests++; const request = JSON.parse(line) as { id: string; token: string; method: string; args: { session: string; key?: string } };
    assert.equal(request.token, endpoint.token); assert.ok(["computer_observe", "computer_action"].includes(request.method)); assert.equal(request.args.session, "computer-fixture");
    const data = request.method === "computer_observe" ? { capture_id: "c1" } : { status: request.args.key === "Enter" ? "unverified" : "completed", observation: { available: false }, doNotRepeat: true };
    socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { data, images: request.method === "computer_observe" ? [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }] : [] } })}\n`);
  }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.endpoint, resolve); });
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig); config.permission.mode = mode;
  const registry = new ToolRegistry(); for (const tool of createComputerUseTools(endpoint)) registry.registerBuiltinTool(tool);
  const recorder = new SessionRecorder(root, "computer-fixture");
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, confirmPermission: async () => { approvals++; return { approved: false }; } }, new PermissionManager(config.permission), () => undefined);
  try {
    const tool = coordinator.createAgentTools().find(value => value.name === "ComputerObserve")!;
    const args = { pid: 42, windowId: "900" };

    const reply = await tool.execute("approved", args);
    assert.deepEqual(reply.content.find(part => part.type === "image"), { type: "image", mimeType: "image/png", data: "aGVsbG8=" });
    assert.equal(JSON.stringify(reply.details).includes("aGVsbG8="), false);
    await assertProviderImageRequests(reply.content);
    await recorder.flush(); assert.equal((await readFile(recorder.filePath, "utf8")).includes("aGVsbG8="), false);
    assert.equal(requests, 1);
    await tool.execute("remembered-observation", { ...args, windowId: "901" });
    assert.equal(approvals, 0, "通用工具审批不覆盖独立应用审批");
    const action = coordinator.createAgentTools().find(value => value.name === "ComputerAction")!;
    const unverified = await action.execute("unverified", { ...args, action: "press_key", captureId: "c1", key: "Enter" });
    assert.equal(unverified.isError, true, "unverifiable input must not display generic tool success");
    assert.match(JSON.stringify(unverified.details), /doNotRepeat.*true/);
    const confirmed = await action.execute("confirmed-without-verification", { ...args, action: "press_key", captureId: "c2", key: "Tab" });
    assert.equal(confirmed.isError, false, "confirmed input with unavailable observation is completed and must not induce replay");
    assert.equal(requests, 4);
    assert.equal(approvals, 0, "动作不进入通用工具确认");
    assert.equal(new PermissionManager({ mode: "read-only" }).evaluate({ toolName: "ComputerAction", actionType: "shell", riskLevel: "medium", sessionId: "s", projectRoot: root }).decision, "deny");
  } finally { await recorder.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
test("post-dispatch disconnect is unknown; pre-dispatch abort has no side effect", async () => {
  const root = await mkdtemp("/tmp/biny-computer-disconnect-");
  const endpoint = { endpoint: path.join(root, "control.sock"), token: "secret" };
  let count = 0;
  const server = net.createServer(socket => { socket.on("data", () => { count++; socket.destroy(); }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.endpoint, resolve); });
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(requestComputer(endpoint, "action", {}, abort.signal, true)); assert.equal(count, 0);
    await assert.rejects(requestComputer(endpoint, "action", {}, undefined, true), /unknown/); assert.equal(count, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

async function assertProviderImageRequests(content: AgentToolResultContent[]): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "Observe the fixture." },
    { role: "assistant", content: [{ type: "toolCall", id: "approved", name: "ComputerObserve", arguments: { pid: 42, windowId: "900" } }] },
    { role: "toolResult", toolName: "ComputerObserve", toolCallId: "approved", content }
  ];
  const paths: Array<Pick<VercelModelInput, "providerType" | "api" | "modelId">> = [
    { providerType: "anthropic", api: "anthropic_messages", modelId: "claude-sonnet-4-5" },
    { providerType: "google-native", api: "google_generative_ai", modelId: "gemini-2.5-pro" },
    { providerType: "openai", api: "responses", modelId: "gpt-5" },
    { providerType: "openai", api: "chat_completions", modelId: "gpt-4.1" },
    { providerType: "openai-compatible", api: "chat_completions", modelId: "fixture" }
  ];
  for (const route of paths) {
    let body = "";
    const model = createVercelLanguageModel({ ...route, providerAlias: "fixture", authMode: "api-key", supportsReasoning: false, baseUrl: "https://fixture.invalid", apiKey: "fixture", headers: {},
      fetcher: async (_url, init) => { body = String(init?.body); throw new Error("fixture-request-captured"); } });
    await assert.rejects(generateText({ model, messages: toModelMessages(messages), maxRetries: 0 }), /fixture-request-captured/);
    assert.match(body, /aGVsbG8=/, `${route.providerType}/${route.api} must send the Cua image bytes to the actual request boundary`);
    assert.match(body, /image|inlineData/);
    assert.equal(body.includes("[binary content]"), false);
    console.log(`PASS Cua observation reaches ${route.providerType}/${route.api} serialized request`);
  }
}

for (const item of cases) { await item.run(); console.log(`PASS ${item.name}`); }
