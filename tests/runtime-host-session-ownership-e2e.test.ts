import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { SessionLeaseStore, SessionWriterConflictError } from "../src/runtime/SessionLease.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for Host/provider state");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(context: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-session-ownership-")));
  await ensureAgentDirs(root);
  const responses = new Map<string, ServerResponse>();
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const marker = body.match(/ownership-probe-[ABC]/u)?.[0];
    if (marker === undefined || responses.has(marker)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }] }));
      return;
    }
    responses.set(marker, response);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const configDir = path.join(root, "config");
  const configStore = createFileConfigStore(root, { globalDir: configDir });
  await configStore.save({
    ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    thinking: { ...defaultConfig.thinking, enabled: false },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  for (const sessionId of ["history-a", "history-b"]) {
    const recorder = new SessionRecorder(root, sessionId);
    recorder.record({ type: "user_message", content: "saved history" });
    recorder.record({ type: "assistant_message", content: "saved response" });
    await recorder.close();
  }
  const initial = await createInteractiveAgentHost(root, { configStore });
  await initial.runtime.resumeSession("history-a");
  const host = await startRuntimeHost(root, async () => initial, {
    workspaceRoot: root, configDir,
    createRuntime: async (sessionId, options) => {
      const runtime = await createInteractiveAgentHost(root, { configStore, resourceRegistry: options?.resourceRegistry });
      if (sessionId !== undefined) await runtime.runtime.resumeSession(sessionId);
      return runtime;
    }
  });
  const desktop = await connectRuntimeHost(root, { configDir, clientId: "desktop-owner", surface: "desktop" });
  const terminal = await connectRuntimeHost(root, { configDir, clientId: "terminal-observer", surface: "tui" });
  assert.ok(desktop && terminal);
  context.after(async () => {
    for (const response of responses.values()) response.destroy();
    await Promise.all([desktop.close(), terminal.close()]);
    await host.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, desktop, terminal, responses };
}

test("idle session probes do not retain writer ownership across clients or processes", { timeout: 20_000 }, async (context) => {
  const { root, desktop, terminal } = await fixture(context);
  const before = await readSessionEvents(sessionFilePath(root, "history-a"));
  await desktop.ensureSession({ sessionId: "history-a", writeIntent: true });
  await terminal.ensureSession({ sessionId: "history-a", writeIntent: true });
  await desktop.claimSession("history-a");
  await terminal.claimSession("history-a");
  await desktop.executeCommand("/help", "desktop");
  await assert.rejects(desktop.executeCommand("/inspect", "desktop"), /检查内容不能为空/u);
  await terminal.ensureSession({ sessionId: "history-a", writeIntent: true });
  const external = await SessionLeaseStore.open(root);
  try { external.acquire("history-a").close(); } finally { external.close(); }
  assert.deepEqual(await readSessionEvents(sessionFilePath(root, "history-a")), before);
});

test("long session commands release the admission queue while retaining their execution claim", { timeout: 20_000 }, async (context) => {
  const { desktop, terminal, responses } = await fixture(context);
  await desktop.ensureSession({ sessionId: "history-a" });
  const compacting = desktop.executeCommand("/compact ownership-probe-C", "desktop");
  let settled = false;
  void compacting.then(() => { settled = true; }, () => { settled = true; });
  void compacting.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await until(() => responses.has("ownership-probe-C"));
    const probe = terminal.ensureSession({ sessionId: "history-a", writeIntent: true });
    await assert.rejects(Promise.race([probe, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Session admission is blocked by the unfinished model request")), 1_000);
    })]), (error: unknown) => {
      assert.ok(error instanceof SessionWriterConflictError);
      assert.equal(error.conflictKind, "execution");
      return true;
    });
    assert.equal(settled, false, "释放准入队列不能提前结束原命令的 RPC");
  } finally {
    clearTimeout(timer);
    const response = responses.get("ownership-probe-C");
    response?.writeHead(200, { "content-type": "application/json" });
    response?.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }] }));
    await compacting.catch(() => undefined);
  }
  assert.equal(settled, true);
  await terminal.ensureSession({ sessionId: "history-a", writeIntent: true });
});

test("active execution fences only its session, survives client release/disconnect, and releases on completion", { timeout: 20_000 }, async (context) => {
  const { root, desktop, terminal, responses } = await fixture(context);
  const started = await desktop.submitRunForSession("history-a", "ownership-probe-A");
  assert.ok(started.accepted && started.result);
  await until(() => responses.size === 1);
  const conflict = async () => {
    await assert.rejects(terminal.ensureSession({ sessionId: "history-a", writeIntent: true }), (error: unknown) => {
      assert.ok(error instanceof SessionWriterConflictError);
      const detail = error as SessionWriterConflictError & { conflictKind?: string; runId?: string };
      assert.equal(detail.conflictKind, "execution");
      assert.equal(detail.runId, started.result!.runId);
      assert.equal(detail.ownerSurface, "desktop");
      return true;
    });
  };
  await conflict();
  assert.equal((await terminal.ensureSession({ sessionId: "history-a" })).snapshot.state.kind, "runs");
  const parallel = await terminal.submitRunForSession("history-b", "ownership-probe-B");
  assert.ok(parallel.accepted && parallel.result);
  await until(() => responses.size === 2);
  assert.equal(terminal.getSnapshot("history-a").info.workspaceRoot, terminal.getSnapshot("history-b").info.workspaceRoot);
  await desktop.releaseSessionClaim("history-a");
  await conflict();
  await desktop.close();
  await conflict();
  const rejected = await terminal.submitRunForSession("history-a", "must-not-dispatch");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.errorCode, "session_writer_conflict");
  assert.deepEqual((rejected as typeof rejected & { errorData?: unknown }).errorData, {
    sessionId: "history-a", ownerPid: process.pid, ownerSurface: "desktop", conflictKind: "execution", runId: started.result.runId
  });
  assert.equal((await readSessionEvents(sessionFilePath(root, "history-a"))).some((event) => event.type === "user_message" && event.content === "must-not-dispatch"), false);
  for (const response of responses.values()) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "completed" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""));
  }
  await until(() => terminal.getSnapshot("history-a").state.kind === "idle" && terminal.getSnapshot("history-b").state.kind === "idle");
  await terminal.ensureSession({ sessionId: "history-a", writeIntent: true });
  const external = await SessionLeaseStore.open(root);
  try { external.acquire("history-a").close(); } finally { external.close(); }
});
