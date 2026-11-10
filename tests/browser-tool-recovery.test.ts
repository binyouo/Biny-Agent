import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { resolveContinuationPlan } from "../src/session/recoveryPlan.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createBrowserTools, requestBrowser } from "../src/tools/browser.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

for (const scenario of [
  { name: "a dispatched browser mutation with a lost response blocks continuation", refused: false, tool: "BrowserClick", args: { selector: "#submit" }, status: "unknown", continuation: "block" },
  { name: "a refused browser input remains failed and allows continuation", refused: true, tool: "BrowserType", args: { selector: "#field", value: "example" }, status: "failed", continuation: "continue" }
] as const) test(scenario.name, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-recovery-"));
  await ensureAgentDirs(root);
  const endpoint = { endpoint: path.join(root, "browser.sock"), token: "test-only" };
  let dispatched = 0;
  const server = net.createServer((socket) => socket.once("data", data => {
    dispatched += 1;
    if (scenario.refused) {
      const request = JSON.parse(String(data)) as { id: string };
      socket.end(`${JSON.stringify({ id: request.id, ok: false, error: "元素被遮挡。", inputNotDispatched: true })}\n`);
    } else socket.destroy();
  }));
  await new Promise<void>((resolve) => server.listen(endpoint.endpoint, resolve));
  const recorder = new SessionRecorder(root, "browser-recovery");
  recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
  try {
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    for (const tool of createBrowserTools(endpoint)) registry.registerBuiltinTool(tool);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => {});
    const tool = coordinator.createAgentTools().find((tool) => tool.name === scenario.tool)!;
    await tool.execute("input", scenario.args, AbortSignal.timeout(2_000));
    await coordinator.waitForIdle();
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    const result = events.findLast((event) => event.type === "tool_result");
    assert.equal(dispatched, 1);
    assert.equal(result?.type === "tool_result" && result.executionStatus, scenario.status);
    const replay = replaySessionEvents(events, { sessionId: recorder.sessionId });
    const plan = resolveContinuationPlan({ sessionId: recorder.sessionId, turnId: "turn", prompt: "click", messages: [{ role: "user", content: "click" }], completedSteps: 0, updatedAt: new Date().toISOString() }, replay, 10);
    assert.equal(plan.action, scenario.continuation);
  } finally {
    await recorder.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("a browser connection failure before dispatch is not an unknown side effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-unavailable-"));
  try {
    await assert.rejects(requestBrowser({ endpoint: path.join(root, "missing.sock"), token: "test-only" }, "click", {}), (error: unknown) => error instanceof Error && !(error instanceof ToolOutcomeUnknownError));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only explicit evidence of rejected input clears browser uncertainty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-refusal-"));
  const endpoint = { endpoint: path.join(root, "browser.sock"), token: "test-only" };
  let reply: Record<string, unknown> = {};
  let received = 0;
  const server = net.createServer(socket => socket.once("data", data => {
    const request = JSON.parse(String(data)) as { id: string };
    received++;
    socket.end(`${JSON.stringify({ id: request.id, ok: false, error: "元素被遮挡。", ...reply })}\n`);
  }));
  await new Promise<void>(resolve => server.listen(endpoint.endpoint, resolve));
  try {
    for (const [fields, unknown] of [
      [{}, true],
      [{ outcomeUnknown: false }, true],
      [{ inputNotDispatched: "true" }, true],
      [{ inputNotDispatched: true }, false],
      [{ inputNotDispatched: true, id: "wrong-request" }, true],
      [{ inputNotDispatched: true, ok: null }, true],
      [{ inputNotDispatched: true, outcomeUnknown: true }, true]
    ] as const) {
      reply = fields;
      await assert.rejects(requestBrowser(endpoint, "fill", { selector: "#field", value: "example" }), (error: unknown) =>
        error instanceof Error && (error instanceof ToolOutcomeUnknownError) === unknown);
    }
    assert.equal(received, 7, "failed inputs must not be retried by the transport");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation after browser dispatch stays unknown while DOM reads remain retry-safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-cancel-"));
  const endpoint = { endpoint: path.join(root, "browser.sock"), token: "test-only" };
  const controller = new AbortController();
  const server = net.createServer((socket) => socket.once("data", () => {
    controller.abort();
    socket.destroy();
  }));
  await new Promise<void>((resolve) => server.listen(endpoint.endpoint, resolve));
  try {
    await assert.rejects(requestBrowser(endpoint, "fill", { selector: "input", value: "example" }, controller.signal), (error: unknown) => error instanceof ToolOutcomeUnknownError && error.reason === "cancelled");
    await assert.rejects(requestBrowser(endpoint, "read_dom", {}, AbortSignal.timeout(2_000)), (error: unknown) => error instanceof Error && !(error instanceof ToolOutcomeUnknownError));
    const tools = createBrowserTools(endpoint);
    const navigation = tools.find((tool) => tool.name === "BrowserOpen")!.resolveExecution!({ url: "http://localhost" }, { workspaceRoot: root, ignore: [] });
    const reading = tools.find((tool) => tool.name === "BrowserReadDom")!.resolveExecution!({}, { workspaceRoot: root, ignore: [] });
    assert.equal((await navigation).retrySafety, "unsafe");
    assert.equal((await reading).retrySafety, "safe");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
