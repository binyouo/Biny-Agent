/** 本地 HTTP/WS 真链路；扩展是外部边界 fake，不调用真实用户浏览器。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { BrowserRelay } from "../src/browser/BrowserRelay.js";
import { requestBrowserRelay } from "../src/browser/relayClient.js";
import sharp from "sharp";

const origin = `chrome-extension://${"a".repeat(32)}`;
async function connect(relay: BrowserRelay): Promise<WebSocket> {
  const socket = new WebSocket(relay.pairingUrl(), { origin });
  await once(socket, "open");
  const ready = once(socket, "message");
  socket.send(JSON.stringify({ type: "hello", version: 2, browserName: "Chrome test" }));
  await ready;
  return socket;
}
async function fixture(run: (relay: BrowserRelay, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-relay-"));
  const file = path.join(root, "relay.json");
  const relay = new BrowserRelay(file);
  try { await relay.start(); await run(relay, file); }
  finally { await relay.close(); await rm(root, { recursive: true, force: true }); }
}

test("multiple profiles route identical tab IDs independently and isolate pending requests", async () => fixture(async (relay, file) => {
  const first = await connect(relay);
  const second = await connect(relay);
  const status = await requestBrowserRelay("status", {}, { file }) as { browsers: Array<{ browserId: string }> };
  assert.equal(status.browsers.length, 2);
  const [a, b] = status.browsers;
  const dispatched = once(first, "message");
  const waiting = relay.request("read", { browserId: a.browserId, tabId: 7 });
  const rejected = assert.rejects(waiting, { code: "unavailable" });
  await dispatched;
  second.on("message", (raw) => {
    const command = JSON.parse(raw.toString());
    second.send(JSON.stringify({ id: command.id, ok: true, result: { url: "https://example.org/", title: "Profile B", text: "B", interactive: [] } }));
  });
  assert.equal((await relay.request("read", { browserId: b.browserId, tabId: 7 }) as { text: string }).text, "B");
  first.terminate();
  await rejected;
  assert.equal((await relay.request("read", { browserId: b.browserId, tabId: 7 }) as { text: string }).text, "B");
  await assert.rejects(relay.request("read", { browserId: a.browserId, tabId: 7 }), /连接已变化/);
}));

test("file tools save binary output, refuse overwrite and deny uploads before dispatch", async () => fixture(async (relay, file) => {
  const { createBrowserRelayTools } = await import("../src/tools/browserRelay.js");
  const root = path.dirname(file);
  const socket = await connect(relay);
  const dispatched: Array<{ method: string; args: { files?: Array<{ data: string }> } }> = [];
  let screenshotData = "iVBORw0KGgo=";
  socket.on("message", (raw) => {
    const command = JSON.parse(raw.toString()); dispatched.push(command);
    socket.send(JSON.stringify({ id: command.id, ok: true, result: command.method === "upload" ? { success: true, url: "https://example.com/" } : { mimeType: "image/png", data: screenshotData } }));
  });
  const tools = createBrowserRelayTools(file, { workspaceRoot: root, ignore: [] });
  const target = { browserId: relay.status().browsers[0]!.browserId, tabId: 1 };
  const run = async (name: string, args: object, deniedPaths: string[] = []) => {
    const tool = tools.find((item) => item.name === name)!;
    const execution = await tool.resolveExecution(tool.schema.parse({ ...target, ...args }));
    assert.ok(!("isError" in execution));
    return execution.execute({ toolCallId: "file", operationId: "file", deniedPaths });
  };
  await run("ChromeRelayScreenshot", { path: "screen.png" });
  assert.equal((await readFile(path.join(root, "screen.png"))).toString("hex"), "89504e470d0a1a0a");
  await assert.rejects(run("ChromeRelayScreenshot", { path: "screen.png" }), /changed|exist/i);
  await writeFile(path.join(root, "private.txt"), "secret");
  const before = dispatched.length;
  await assert.rejects(run("ChromeRelayUpload", { selector: "input", paths: ["private.txt"] }, ["private.txt"]), /禁止/);
  await assert.rejects(run("ChromeRelayUpload", { selector: "input", paths: ["../outside"] }), /escapes/);
  assert.equal(dispatched.length, before);
  await writeFile(path.join(root, "document.txt"), "public");
  await run("ChromeRelayUpload", { selector: "input", paths: ["document.txt"] });
  assert.equal(dispatched.at(-1)?.args.files?.[0]?.data, Buffer.from("public").toString("base64"));
  screenshotData = (await sharp({ create: { width: 20, height: 10, channels: 3, background: "#123456" } }).png().toBuffer()).toString("base64");
  const screenshot = tools.find(item => item.name === "ChromeRelayScreenshot")!;
  const execution = await screenshot.resolveExecution(screenshot.schema.parse(target));
  assert.ok(!("isError" in execution));
  let returnedImage: string | undefined;
  const result = await execution.execute({ toolCallId: "observation", operationId: "observation", onImage: image => { returnedImage = image.data; return true; } }) as { imageReturned: boolean; path?: string };
  assert.equal(result.imageReturned, true);
  assert.equal(result.path, undefined);
  assert.equal((await sharp(Buffer.from(returnedImage!, "base64")).metadata()).width, 20);
  const beforeMissingPath = dispatched.length;
  await assert.rejects(execution.execute({ toolCallId: "no-image-channel", operationId: "no-image-channel" }), /保存路径/);
  assert.equal(dispatched.length, beforeMissingPath);
}));

test("Relay authenticates, lists existing tabs and invalidates targets after reconnect", async () => fixture(async (relay, file) => {
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await requestBrowserRelay("status", {}, { file }), { running: true, connected: false, browsers: [] });
  await assert.rejects(requestBrowserRelay("tabs", {}, { file }), /未连接/);
  const url = new URL(relay.pairingUrl());
  const denied = await fetch(`http://127.0.0.1:${url.port}/command`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 403);
  const pageOrigin = new WebSocket(relay.pairingUrl(), { origin: "https://example.com" });
  const [failure] = await once(pageOrigin, "error");
  assert.match(String(failure), /403/);
  const socket = await connect(relay);
  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ id: request.id, ok: true, result: request.method === "tabs"
      ? [{ id: 7, windowId: 2, url: "https://example.com/", title: "Existing tab", active: true }]
      : { url: "https://example.com/", title: "Existing tab", text: "Hello", interactive: [] } }));
  });
  const { browsers: [tabs] } = await requestBrowserRelay("tabs", {}, { file }) as { browsers: Array<{ browserId: string; tabs: Array<{ id: number }> }> };
  assert.equal(tabs.tabs[0].id, 7);
  const read = await requestBrowserRelay("read", { browserId: tabs.browserId, tabId: 7 }, { file }) as { text: string };
  assert.equal(read.text, "Hello");
  const oldPairing = relay.pairingUrl();
  await relay.disconnect();
  assert.notEqual(relay.pairingUrl(), oldPairing);
  await connect(relay);
  await assert.rejects(requestBrowserRelay("read", { browserId: tabs.browserId, tabId: 7 }, { file }), /连接已变化/);
}));

test("Relay returns page evaluation values and reports the evaluated tab", async () => fixture(async (relay) => {
  const socket = await connect(relay);
  const browserId = relay.status().browsers[0]!.browserId;
  const activity: Array<{ browserId: string; tabId: number; sessionId?: string; browserName: string }> = [];
  relay.attachActivity((target) => activity.push(target));
  let value: unknown;
  socket.on("message", (raw) => {
    const command = JSON.parse(raw.toString()) as { id: string; method: string };
    socket.send(JSON.stringify({ id: command.id, ok: true, result: value }));
  });
  for (value of [{ title: "Page value" }, null, false, 0, "", [1, "text"]]) {
    activity.length = 0;
    const result = await relay.request("evaluate", {
      browserId, tabId: 7, code: "document.title"
    }, undefined, "agent-session");
    assert.deepEqual(result, value);
    assert.deepEqual(activity, [{ browserId, tabId: 7, sessionId: "agent-session", browserName: "Chrome test" }]);
  }
}));

test("read, screenshot and wait do not start a mutation preview", async () => fixture(async (relay) => {
  const socket = await connect(relay);
  const target = { browserId: relay.status().browsers[0]!.browserId, tabId: 7 };
  const activity: unknown[] = [];
  relay.attachActivity((event) => activity.push(event));
  socket.on("message", (raw) => {
    const command = JSON.parse(raw.toString()) as { id: string; method: string };
    const result = command.method === "read"
      ? { url: "https://example.com/", title: "Page", text: "Text", interactive: [] }
      : command.method === "screenshot"
        ? { mimeType: "image/png", data: "iVBORw0KGgo=" }
        : { success: true, url: "https://example.com/" };
    socket.send(JSON.stringify({ id: command.id, ok: true, result }));
  });
  await relay.request("read", target);
  await relay.request("screenshot", target);
  await relay.request("wait", { ...target, state: "load" });
  assert.deepEqual(activity, []);
}));

test("opening a tab reports its new target to preview without losing the result on notification failure", async () => fixture(async (relay) => {
  const socket = await connect(relay);
  const browserId = relay.status().browsers[0]!.browserId;
  const activity: Array<{ browserId: string; tabId: number; sessionId?: string; browserName: string }> = [];
  relay.attachActivity((target) => { activity.push(target); throw new Error("preview unavailable"); });
  socket.on("message", (raw) => {
    const command = JSON.parse(raw.toString()) as { id: string; method: string };
    socket.send(JSON.stringify({ id: command.id, ok: true, result: { success: true, tabId: 11, windowId: 3, url: "https://example.org/" } }));
  });
  const result = await relay.request("open", { browserId, url: "https://example.org/" }, undefined, "agent-session");
  assert.deepEqual(result, { success: true, tabId: 11, windowId: 3, url: "https://example.org/" });
  assert.deepEqual(activity, [{ browserId, tabId: 11, sessionId: "agent-session", browserName: "Chrome test" }]);
}));

test("dispatched page evaluation disconnect is unknown and never replayed", async () => fixture(async (relay, file) => {
  const socket = await connect(relay);
  let calls = 0;
  socket.on("message", () => { calls++; socket.terminate(); });
  await assert.rejects(requestBrowserRelay("evaluate", {
    browserId: relay.status().browsers[0]?.browserId, tabId: 7, code: "document.title = 'changed'"
  }, { file }), { code: "unknown" });
  await connect(relay);
  assert.equal(calls, 1);
}));

test("dispatched mutation disconnect is unknown and never replayed", async () => fixture(async (relay, file) => {
  const socket = await connect(relay);
  let calls = 0;
  socket.on("message", () => { calls++; socket.terminate(); });
  await assert.rejects(requestBrowserRelay("click", { browserId: relay.status().browsers[0]?.browserId, tabId: 7, selector: "#send" }, { file }), { code: "unknown" });
  await connect(relay);
  assert.equal(calls, 1);
}));

test("malformed successful mutation result remains unknown", async () => fixture(async (relay, file) => {
  const socket = await connect(relay);
  socket.on("message", (raw) => socket.send(JSON.stringify({ id: JSON.parse(raw.toString()).id, ok: true, result: { malformed: true } })));
  await assert.rejects(requestBrowserRelay("click", { browserId: relay.status().browsers[0]?.browserId, tabId: 7, selector: "#send" }, { file }), { code: "unknown" });
}));

test("cancellation ends the connection and rejects concurrent requests", async () => fixture(async (relay) => {
  const socket = await connect(relay);
  const dispatched = once(socket, "message");
  const controller = new AbortController();
  const result = relay.request("read", { browserId: relay.status().browsers[0]?.browserId, tabId: 7 }, controller.signal);
  const rejection = assert.rejects(result, { code: "unavailable" });
  await dispatched;
  await assert.rejects(relay.request("tabs", {}), { code: "busy" });
  controller.abort();
  await rejection;
}));

test("public tool execution persists results, unknown outcomes and permission denial", async () => fixture(async (relay, file) => {
  const { ToolExecutionCoordinator } = await import("../src/agent/toolExecutionCoordinator.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { PermissionManager } = await import("../src/permission/PermissionManager.js");
  const { SessionRecorder } = await import("../src/session/recorder.js");
  const { ensureAgentDirs } = await import("../src/session/store.js");
  const { readSessionEvents } = await import("../src/session/events.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const { createBrowserRelayTools } = await import("../src/tools/browserRelay.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-relay-runtime-"));
  let recorder: InstanceType<typeof SessionRecorder> | undefined;
  try {
    await ensureAgentDirs(root);
    recorder = new SessionRecorder(root);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    for (const tool of createBrowserRelayTools(file)) registry.register(tool);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    const socket = await connect(relay);
    let dispatched = 0;
    socket.on("message", (raw) => {
      dispatched++;
      const command = JSON.parse(raw.toString());
      if (command.method === "tabs") socket.send(JSON.stringify({ id: command.id, ok: true, result: [] }));
      else socket.terminate();
    });
    await coordinator.createAgentTools().find((tool) => tool.name === "ChromeRelayListTabs")!.execute("list", {});
    await coordinator.createAgentTools().find((tool) => tool.name === "ChromeRelayClick")!.execute("click", { browserId: relay.status().browsers[0]?.browserId, tabId: 1, selector: "#send" });
    await coordinator.waitForIdle();
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    assert.ok(events.some((event) => event.type === "tool_call" && event.toolCallId === "list"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === "list" && event.executionStatus === "succeeded"));
    assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === "click" && event.executionStatus === "unknown"));
    config.permission.mode = "read-only";
    const denied = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    await denied.createAgentTools().find((tool) => tool.name === "ChromeRelayClick")!.execute("denied", { browserId: "00000000-0000-4000-8000-000000000000", tabId: 1, selector: "#send" });
    await denied.waitForIdle(); await recorder.flush();
    assert.equal(dispatched, 2);
    assert.ok((await readSessionEvents(recorder.filePath)).some((event) => event.type === "tool_result" && event.toolCallId === "denied" && event.executionStatus === "failed"));
  } finally { await recorder?.close(); await rm(root, { recursive: true, force: true }); }
}));

test("completed relay actions notify their preview target without changing a dispatched result on notification failure", async () => fixture(async (relay, file) => {
  const socket = await connect(relay); const events: unknown[] = [];
  socket.on("message", raw => { const command = JSON.parse(raw.toString()); socket.send(JSON.stringify({ id: command.id, ok: true, result: { success: true, url: "https://example.org/" } })); });
  const target = { browserId: relay.status().browsers[0]!.browserId, tabId: 7 };
  relay.attachActivity(value => { events.push(value); throw new Error("preview capacity exceeded"); });
  const tools = (await import("../src/tools/browserRelay.js")).createBrowserRelayTools(file);
  const tool = tools.find(item => item.name === "ChromeRelayClick")!;
  const execution = await tool.resolveExecution(tool.schema.parse({ ...target, selector: "button" }));
  assert.ok(!("isError" in execution));
  const result = await execution.execute({ toolCallId: "relay", operationId: "relay", sessionId: "linked-session" });
  assert.equal((result as { success: boolean }).success, true);
  assert.deepEqual(events, [{ ...target, browserName: "Chrome test", sessionId: "linked-session" }]);
}));

test("an input waits for an in-flight preview frame without being rejected or repeated", async () => fixture(async relay => {
  const socket = await connect(relay), target = { browserId: relay.status().browsers[0]!.browserId, tabId: 7 };
  const received = once(socket, "message");
  const frame = relay.request("screenshot", target, undefined, undefined, true);
  const command = JSON.parse((await received)[0].toString());
  const next = once(socket, "message");
  const input = relay.request("click", { ...target, selector: "button" });
  // Capture rejection before returning the frame; the input is allowed to wait, never replay.
  const result = input.then(value => ({ value }), error => ({ error }));
  socket.send(JSON.stringify({ id: command.id, ok: true, result: { mimeType: "image/png", data: "eA==" } }));
  await frame;
  const timeout = setTimeout(() => socket.terminate(), 1000);
  try {
    const completed = await Promise.race([next.then(([raw]) => {
      const action = JSON.parse(raw.toString()); assert.equal(action.method, "click");
      socket.send(JSON.stringify({ id: action.id, ok: true, result: { success: true, url: "https://example.org/" } }));
      return result;
    }), result]);
    assert.equal("error" in completed, false, JSON.stringify(completed));
  } finally { clearTimeout(timeout); }
}));
