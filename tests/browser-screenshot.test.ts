import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createBrowserTools } from "../src/tools/browser.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutionCoordinator } from "../src/agent/ToolExecutionCoordinator.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { boundComputerFrames } from "../src/computer/modelFrames.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { testModel } from "./helpers/model.js";
import { prepareBrowserScreenshot } from "../src/browser/transfers.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";

test("browser screenshot reaches the model, saves only on request, and uses normal permission and event boundaries", { timeout: 15_000 }, async testContext => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-shot-"));
  await ensureAgentDirs(root);
  const png = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: "#123456" } }).png().toBuffer();
  const frames = [png, ...await Promise.all(["#234567", "#345678"].map(background => sharp({ create: { width: 2000, height: 1200, channels: 3, background } }).png().toBuffer()))];
  assert.equal(frames[0]!.length, frames[1]!.length, "different pixels with identical metadata exercise screenshot deduplication");
  let frame = png;
  let batchFrame: number | undefined;
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const endpoint = { endpoint: path.join(root, "browser.sock"), token: "test", projectId: "project-a" };
  const server = net.createServer(socket => socket.once("data", data => {
    const request = JSON.parse(data.toString());
    calls.push(request);
    if (batchFrame !== undefined) frame = frames[batchFrame++]!;
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { mimeType: "image/png", data: frame.toString("base64"), url: "https://example.test/", title: "Test page" } })}\n`);
  }));
  await new Promise<void>(resolve => server.listen(endpoint.endpoint, resolve));
  const recorder = new SessionRecorder(root, "browser-shot");
  try {
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    for (const tool of createBrowserTools(endpoint, { workspaceRoot: root, ignore: [] })) registry.registerBuiltinTool(tool);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => {});
    const tool = coordinator.createAgentTools().find(item => item.name === "BrowserScreenshot");
    assert.ok(tool, "the model must have a direct screenshot tool");
    const observed = await tool.execute("observe", { fullPage: true });
    assert.equal(observed.isError, false);
    const image = observed.content.find(part => part.type === "image");
    assert.ok(image?.type === "image");
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    assert.equal(metadata.width, 1280);
    assert.equal(metadata.height, 768);
    assert.deepEqual((await readdir(root)).filter(file => file.endsWith(".png") || file.endsWith(".jpg")), []);
    assert.equal(calls[0]?.args.projectId, "project-a");
    assert.equal(calls[0]?.args.fullPage, true);
    assert.equal(calls[0]?.args.sessionId, recorder.sessionId);
    const saved = await tool.execute("save", { path: "page.png" });
    assert.equal(saved.isError, false);
    assert.deepEqual(await readFile(path.join(root, "page.png")), png);
    assert.equal((await tool.execute("overwrite", { path: "page.png" })).isError, true);
    const before = calls.length;
    assert.equal((await tool.execute("denied", { path: ".env" })).isError, true);
    assert.equal((await tool.execute("escape", { path: "../outside.png" })).isError, true);
    const abort = new AbortController(); abort.abort();
    assert.equal((await tool.execute("cancel", {}, abort.signal)).isError, true);
    assert.equal(calls.length, before, "invalid destinations and cancelled work must not capture");
    await coordinator.waitForIdle(); await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    const result = events.find(event => event.type === "tool_result" && event.toolCallId === "save");
    assert.ok(result?.type === "tool_result");
    assert.equal(result.executionStatus, "succeeded");
    assert.doesNotMatch(JSON.stringify(events), new RegExp(png.toString("base64").slice(0, 80)));
    assert.ok(events.some(event => event.type === "tool_call" && event.toolCallId === "observe"));
    const requests: AgentMessage[][] = [];
    const model = testModel({ provider: "test", modelId: "browser-shot-model", stream: async context => {
      requests.push(structuredClone(context.messages));
      const step = requests.length;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (step <= 3) {
          frame = frames[step - 1]!;
          yield { type: "tool-call", id: `shot-${step}`, name: "BrowserScreenshot", arguments: {} };
          yield { type: "finish", reason: "tool-calls" };
        } else { yield { type: "text-delta", text: "Inspected" }; yield { type: "finish", reason: "stop" }; }
      })();
    } });
    const sessionConfig = configSchema.parse({ ...config,
      providers: { sample: { type: "openai-compatible", baseUrl: "https://example.invalid/", apiKeyEnv: "BINY_TEST_UNCONFIGURED_KEY" } },
      models: { selected: { provider: "sample", model: "browser-shot-model", capabilities: { vision: true } } }, defaultModel: "selected"
    });
    sessionConfig.context.memory.useMemories = false; sessionConfig.context.memory.generateMemories = false;
    const agent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model, toolRegistry: registry, permissionManager: new PermissionManager(sessionConfig.permission), recorder: new SessionRecorder(root) });
    try {
      await agent.initialize(); await agent.runTask("Inspect the browser screenshots");
      assert.equal(requests.length, 4);
      assert.deepEqual(requests.map(messages => messages.flatMap(message => message.role === "toolResult" ? message.content : []).filter(part => part.type === "image").length), [0, 1, 2, 2]);
      const stored = await readSessionEvents(agent.getInfo().sessionFile);
      const storedImages = stored.flatMap(event => event.type === "agent_message" && event.message.role === "toolResult" ? event.message.content : []).filter(part => part.type === "image");
      assert.equal(storedImages.length, 3, "request limits must not erase canonical screenshot history");
    } finally { await agent.close(); }
    const visionRequests: AgentMessage[][] = [];
    const visionModel = testModel({ provider: "test", modelId: "fixture-vision", stream: async context => {
      visionRequests.push(structuredClone(context.messages));
      return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "Screenshot description" }; yield { type: "finish", reason: "stop" }; })();
    } });
    const provider = testContext.mock.method(ProviderRegistry.prototype, "createModelSettings", () => ({ model: visionModel, contextWindow: undefined }));
    let batchStep = 0;
    const batchModel = testModel({ provider: "test", modelId: "batch-model", stream: async () => {
      batchStep++;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (batchStep === 1) {
          for (let index = 0; index < 3; index++) yield { type: "tool-call", id: `batch-${index}`, name: "BrowserScreenshot", arguments: {} };
          yield { type: "finish", reason: "tool-calls" };
        } else { yield { type: "text-delta", text: "Inspected" }; yield { type: "finish", reason: "stop" }; }
      })();
    } });
    batchFrame = 0;
    sessionConfig.visionModel = "selected";
    const visionAgent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model: batchModel, toolRegistry: registry, permissionManager: new PermissionManager(sessionConfig.permission), recorder: new SessionRecorder(root) });
    try {
      await visionAgent.initialize(); await visionAgent.runTask("Inspect the screenshot batch");
      assert.equal(batchFrame, 3);
      assert.equal(visionRequests.length, 2, "retire old frames before invoking the vision model, not just before the main model");
    } finally { await visionAgent.close(); provider.mock.restore(); }
  } finally {
    await recorder.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid, oversized and cancelled screenshot results never create an artifact or publish an image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-shot-invalid-"));
  let published = 0;
  const options = { workspaceRoot: root, ignore: [], onImage: () => { published++; return true; } };
  try {
    const save = prepareBrowserScreenshot("invalid.png", options);
    await assert.rejects(save({ mimeType: "image/png", data: Buffer.from("not PNG").toString("base64") }), /PNG/);
    await assert.rejects(save({ mimeType: "image/png", data: "iVBORw0KGgo=" }));
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1); Buffer.from("89504e470d0a1a0a", "hex").copy(oversized);
    await assert.rejects(save({ mimeType: "image/png", data: oversized.toString("base64") }), /8 MiB/);
    const abort = new AbortController();
    const cancelled = prepareBrowserScreenshot("cancelled.png", { ...options, signal: abort.signal });
    abort.abort();
    await assert.rejects(cancelled({ mimeType: "image/png", data: "iVBORw0KGgo=" }));
    assert.deepEqual(await readdir(root), []);
    assert.equal(published, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("browser observations share the recent image budget without changing stored messages", () => {
  const messages: AgentMessage[] = ["BrowserScreenshot", "BrowserClipboardRead", "ComputerObserve", "ChromeRelayScreenshot", "BrowserScreenshot"].map((toolName, index) => ({
    role: "toolResult", toolCallId: String(index), toolName, content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from("pixels").toString("base64") }], isError: false
  }));
  const bounded = boundComputerFrames(messages);
  assert.deepEqual(bounded.map(message => message.role === "toolResult" && message.content.some(part => part.type === "image")), [false, false, false, true, true]);
  assert.equal(messages.flatMap(message => message.role === "toolResult" ? message.content : []).filter(part => part.type === "image").length, 5);
});

test("computer MCP frames share the same recent image budget", () => {
  const messages: AgentMessage[] = ["mcp_computer-use_get_app_state", "mcp_computer-use_press_key", "ComputerObserve"].map((toolName, index) => ({
    role: "toolResult", toolCallId: String(index), toolName, content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from("pixels").toString("base64") }], isError: false
  }));
  const bounded = boundComputerFrames(messages);
  assert.deepEqual(bounded.map(message => message.role === "toolResult" && message.content.some(part => part.type === "image")), [false, true, true]);
  assert.equal(messages[0]!.role === "toolResult" && messages[0]!.content[0]!.type, "image");
});
