import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfigFile } from "../src/config/loader.js";
import { spawnRuntimeHost, terminateSpawnedHost } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import { createSessionFile, ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { readSessionMessages } from "../src/session/inspection.js";
import type { RemoteView } from "../src/remote/api.js";
import { beginRemoteHandshake, routingToken } from "../src/remote/crypto.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

async function until(condition: () => boolean | Promise<boolean>, message: () => string = () => "Expected state was not observed"): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, message());
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

test("native pairing uses the built CLI, shared Host, permission and persisted session through encrypted sockets", { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-remote-e2e-")));
  const previous = process.env.BINY_AGENT_DIR;
  const agentDir = path.join(root, "agent");
  process.env.BINY_AGENT_DIR = agentDir;
  const cleanups: Array<() => void | Promise<void>> = [];
  const cleanup = (work: () => void | Promise<void>): void => { cleanups.push(work); };
  t.after(async () => {
    const failures: unknown[] = [];
    for (const work of cleanups.reverse()) { try { await work(); } catch (error) { failures.push(error); } }
    try { await removeTestRoot(root, { recursive: true, force: true }); }
    finally { if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; }
    if (failures.length) throw new AggregateError(failures, "Remote test resources did not stop cleanly.");
  });
  let agentRequests = 0;
  let held: ServerResponse | undefined;
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    const latestUser = (body.messages as Array<{ role: string; content: unknown }>).filter(message => message.role === "user").at(-1);
    if (Array.isArray(body.tools) && JSON.stringify(latestUser?.content ?? "").includes("cancel-probe")) {
      held = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Waiting for cancellation" }, finish_reason: null }] })}\n\n`);
      return;
    }
    const parts = [];
    if (Array.isArray(body.tools) && body.tools.length && ++agentRequests === 1) {
      parts.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "phone-write", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "phone-result.txt", content: "written from phone\n" }) } }] }, finish_reason: null }] });
      parts.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      parts.push({ choices: [{ index: 0, delta: { content: Array.isArray(body.tools) ? "Phone request completed" : "[]" }, finish_reason: null }] });
      parts.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([...parts.map(part => `data: ${JSON.stringify(part)}\n\n`), "data: [DONE]\n\n"].join(""));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanup(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  const config = structuredClone(defaultConfig);
  config.defaultModel = "local-test";
  config.providers = { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } };
  config.models = { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } };
  config.permission.mode = "ask";
  config.context.memory.enabled = false;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.heartbeat.enabled = false;
  config.activity.enabled = false;
  config.checkpoints.enabled = false;
  config.thinking.enabled = false;
  config.chat.defaultToolSelection = "all";
  config.chat.defaultSkillSelection = "none";
  config.chat.skillExtraction.enabled = false;
  config.extensions.mcp = {};
  config.extensions.plugins = [];
  config.extensions.globalPlugins = [];
  await saveConfigFile(agentDir, config);
  await ensureAgentDirs(root);
  const history = Array.from({ length: 24 }, (_, index) => ({ type: index % 2 ? "assistant_message" : "user_message", content: `history-${index}`, time: "2026-11-02T00:00:00.000Z" }));
  await createSessionFile(root, "phone-history", Buffer.from(history.map(event => JSON.stringify(event)).join("\n") + "\n"));
  const latest = await readSessionMessages(root, "phone-history", { offset: 0, limit: 20, fromEnd: true });
  assert.equal(latest.offset, 4);
  assert.equal(latest.messages[0]?.content, "history-4");
  assert.equal(latest.messages.at(-1)?.content, "history-23");
  assert.equal(latest.nextOffset, null);
  const host = await spawnRuntimeHost(root, { workspaceRoot: root, surface: "cli", keepAlive: true });
  cleanup(async () => { try { await host.client.close(); } finally { await terminateSpawnedHost(host.process, 1000); } });
  await host.client.waitForReady();

  // 外部中继替身只转发帧，不执行 Biny 领域或解密手机消息。
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(relay, "listening");
  cleanup(async () => { for (const socket of relay.clients) socket.terminate(); await new Promise<void>(resolve => relay.close(() => resolve())); });
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");
  const relayUrl = `http://127.0.0.1:${relayAddress.port}`;
  let agent: WebSocket | undefined;
  let tokenHash = "";
  const phones = new Map<string, WebSocket>();
  const wire: string[] = [];
  let nextPhone = 0;
  relay.on("connection", (socket, request) => {
    const url = new URL(request.url!, relayUrl);
    if (url.pathname === "/agent") {
      agent = socket;
      socket.on("message", data => {
        const raw = data.toString();
        wire.push(raw);
        const frame = JSON.parse(raw);
        if (frame.t === "register") { tokenHash = frame.tokenHash; socket.send(JSON.stringify({ t: "registered", proto: 1 })); }
        else if (frame.t === "wmsg") phones.get(frame.id)?.send(frame.s);
        else if (frame.t === "wclose") phones.get(frame.id)?.close(frame.code, frame.reason);
      });
    } else {
      const [, , token] = url.pathname.split("/");
      assert.equal(createHash("sha256").update(token!).digest("hex"), tokenHash);
      const id = `phone-${++nextPhone}`;
      phones.set(id, socket);
      agent!.send(JSON.stringify({ t: "wopen", id, path: "/__biny_e2e__" }));
      socket.on("message", data => { wire.push(data.toString()); agent!.send(JSON.stringify({ t: "wmsg", id, s: data.toString() })); });
      socket.on("close", () => { phones.delete(id); if (agent?.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ t: "wclose", id })); });
    }
  });
  const cli = path.resolve("dist/cli/index.js");
  const remote = spawn(process.execPath, [cli, "remote", "run", "--relay", relayUrl, "--json"], { cwd: root, env: { ...process.env, BINY_RELAY_REGISTRATION_KEY: "remote-test-registration-key" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  remote.stdout.on("data", chunk => { stdout += String(chunk); });
  remote.stderr.on("data", chunk => { stderr += String(chunk); });
  cleanup(async () => { await terminateSpawnedHost(remote, 1000); });
  await until(() => stdout.includes("\n"), () => `CLI did not register: ${stderr}`);
  const pairing = JSON.parse(stdout.trim());
  assert.equal(pairing.workspace, root);
  const link = new URL(pairing.pairingUrl);
  assert.equal(link.protocol, "biny:");
  assert.equal(link.hostname, "connect");
  assert.equal(link.searchParams.get("v"), "1");
  assert.equal(link.searchParams.get("e2e"), "1");
  assert.equal(link.searchParams.get("u"), relayUrl);
  assert.equal(link.searchParams.get("k"), pairing.code);
  const connectPhone = async () => {
    const socket = new WebSocket(`${relayUrl.replace("http:", "ws:")}/c/${await routingToken(pairing.code)}/__biny_e2e__`);
    cleanup(async () => { if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.terminate(); await closed; } });
    await once(socket, "open");
    const handshake = await beginRemoteHandshake(link.searchParams.get("k")!);
    const welcome = once(socket, "message");
    socket.send(JSON.stringify(handshake.hello));
    const cipher = await handshake.finish(JSON.parse((await welcome)[0].toString()));
    let view: RemoteView | undefined;
    const pending = new Map<string, (value: { result?: unknown; error?: string }) => void>();
    let incoming = Promise.resolve();
    let failure: unknown;
    socket.on("message", data => {
      incoming = incoming.then(async () => {
        const value = await cipher.decrypt(data.toString()) as { t: string; id: string; view?: RemoteView; result?: unknown; error?: string };
        if (value.t === "response") { pending.get(value.id)?.(value); pending.delete(value.id); }
        else if (value.view) view = value.view;
      }).catch(error => { failure = error; socket.terminate(); });
    });
    return {
      view: () => view,
      async request<T>(method: string, fields: Record<string, unknown> = {}): Promise<T> {
        const id = crypto.randomUUID();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await new Promise<T>((resolve, reject) => {
            timer = setTimeout(() => reject(failure ?? new Error(`No response for ${method}`)), 10000);
            pending.set(id, response => response.error ? reject(new Error(response.error)) : resolve(response.result as T));
            void cipher.encrypt({ id, method, ...fields }).then(packet => socket.send(packet)).catch(reject);
          });
        } finally { clearTimeout(timer); pending.delete(id); }
      },
      async close() { const closed = once(socket, "close"); socket.close(); await closed; await incoming; assert.equal(failure, undefined); }
    };
  };
  let phone = await connectPhone();
  const listed = await phone.request<{ items: Array<{ id: string; name: string; path: string }> }>("projects");
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]!.path, root);
  const projectId = listed.items[0]!.id;
  await phone.request("open", { projectId, sessionId: "phone-history" });
  await assert.rejects(phone.request("send", { sessionId: "another-session", text: "must not run" }), /selection changed/u);
  assert.equal(agentRequests, 0, "a stale selection must not dispatch any model request");
  const catalog = await phone.request<{ items: Array<{ id: string }> }>("sessions", { projectId });
  assert.ok(catalog.items.some(item => item.id === "phone-history"));
  const historyPage = await phone.request<{ offset: number; messages: Array<{ content: string }> }>("history", { sessionId: "phone-history" });
  assert.equal(historyPage.offset, 4);
  assert.equal(historyPage.messages.at(-1)?.content, "history-23");
  const created = await phone.request<RemoteView>("create", { projectId });
  const createdSession = created.sessionId;
  const submitted = await phone.request<{ accepted: boolean }>("send", { sessionId: createdSession, text: "Create phone-result.txt for this private phone request" });
  assert.equal(submitted.accepted, true);
  await until(() => phone.view()?.state.kind === "runs" && Boolean((phone.view()!.state as Extract<RemoteView["state"], { kind: "runs" }>).pendingPermission));
  const permission = (phone.view()!.state as Extract<RemoteView["state"], { kind: "runs" }>).pendingPermission!;
  await assert.rejects(readFile(path.join(root, "phone-result.txt")), { code: "ENOENT" });
  assert.ok(JSON.stringify(permission.request).includes("phone-result.txt"));
  assert.equal((await phone.request<{ accepted: boolean }>("permission", { sessionId: createdSession, requestId: permission.requestId, approved: true })).accepted, true);
  await until(async () => await readFile(path.join(root, "phone-result.txt"), "utf8").catch(() => "") === "written from phone\n");
  await until(() => phone.view()?.state.kind === "idle");
  const reply = await phone.request<{ messages: Array<{ content: string }> }>("history", { sessionId: createdSession });
  assert.ok(reply.messages.some(message => message.content.includes("Phone request completed")));
  const events = await readSessionEvents(sessionFilePath(root, createdSession));
  assert.equal(events.filter(event => event.type === "user_message" && event.content.includes("private phone request")).length, 1);
  assert.ok(events.some(event => event.type === "tool_result"));
  assert.ok(events.some(event => event.type === "assistant_message" || event.type === "agent_message"));
  assert.ok(!wire.join("\n").includes("private phone request"));
  assert.ok(!wire.join("\n").includes("written from phone"));
  assert.ok(!wire.join("\n").includes(pairing.code));
  const sessions = await host.client.listRuntimeSessions();
  assert.ok(sessions.some(session => session.sessionId === createdSession), "mobile and local client share the same Host session");
  await phone.request("send", { sessionId: createdSession, text: "cancel-probe" });
  await until(() => held !== undefined && phone.view()?.state.kind === "runs");
  await phone.request("cancel", { sessionId: createdSession, runId: (phone.view()!.state as Extract<RemoteView["state"], { kind: "runs" }>).activeRun.runId });
  await until(async () => (await readSessionEvents(sessionFilePath(root, createdSession))).some(event => event.type === "turn_status" && event.status === "cancelled"));
  await until(() => held!.destroyed);
  const beforeReconnect = agentRequests;
  await phone.close();
  await until(() => phones.size === 0);
  phone = await connectPhone();
  await phone.request("open", { projectId, sessionId: createdSession });
  const restored = await phone.request<{ messages: Array<{ content: string }> }>("history", { sessionId: createdSession });
  assert.ok(restored.messages.some(message => message.content.includes("Phone request completed")));
  assert.equal(agentRequests, beforeReconnect, "reconnecting reads history without resubmitting a model request");
  await phone.close();
  await until(() => phones.size === 0);
  const stopped = once(remote, "exit");
  remote.kill("SIGINT");
  const [exitCode] = await stopped;
  assert.equal(exitCode, 0, stderr);
});
