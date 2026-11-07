import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RemoteAccess } from "../src/remote/access.js";
import { beginRemoteHandshake, type RemoteCipher } from "../src/remote/crypto.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "Expected access state was not observed"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

const workspace = { id: "project-one", name: "One", path: "/p/one", workspaceRoot: "/w" };
interface Counters { closed: number; subscriptions: number }

function fakeClient(counters: Counters): RuntimeHostClient {
  return {
    subscribeAllRuntimeEvents() { counters.subscriptions++; return () => { counters.subscriptions--; }; },
    async ensureSession() { return { sessionId: "session-1", snapshot: { info: { sessionId: "session-1", modelLabel: "model", workspaceRoot: "/w" }, state: { kind: "idle" } } }; },
    async close() { counters.closed++; }
  } as unknown as RuntimeHostClient;
}

async function relaySocket(t: { after(work: () => void | Promise<void>): void }, reject = false): Promise<{ url: string; agent: () => WebSocket; frames: Array<{ t: string; id?: string; s?: string; key?: string }> }> {
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(typeof address !== "string" && address);
  let agent: WebSocket;
  const frames: Array<{ t: string; id?: string; s?: string; key?: string }> = [];
  relay.on("connection", socket => { agent = socket; socket.on("message", data => {
    const frame = JSON.parse(data.toString()); frames.push(frame);
    if (frame.t === "register") { if (reject) socket.close(4003, "Rejected"); else socket.send(JSON.stringify({ t: "registered", proto: 1 })); }
  }); });
  t.after(async () => { for (const socket of relay.clients) socket.terminate(); await new Promise<void>(resolve => relay.close(() => resolve())); });
  return { url: `http://127.0.0.1:${address.port}`, agent: () => agent, frames };
}

/** 手机上的一支通道：wopen + 握手，再把加密请求转成带响应的调用。 */
async function phone(agent: WebSocket, frames: Array<{ t: string; id?: string; s?: string }>, id: string, code: string): Promise<{ request(method: string, fields?: Record<string, unknown>): Promise<{ result?: unknown; error?: string }> }> {
  const handshake = await beginRemoteHandshake(code);
  agent.send(JSON.stringify({ t: "wopen", id, path: "/__biny_e2e__" }));
  agent.send(JSON.stringify({ t: "wmsg", id, s: JSON.stringify(handshake.hello) }));
  const deadline = Date.now() + 5000;
  let welcome: { s?: string } | undefined;
  while (!(welcome = frames.find(frame => frame.t === "wmsg" && frame.id === id))) { assert.ok(Date.now() < deadline, "Handshake was not answered"); await new Promise(resolve => setTimeout(resolve, 5)); }
  const cipher: RemoteCipher = await handshake.finish(JSON.parse(welcome.s!));
  let consumed = 0;
  const inbox = new Map<string, { result?: unknown; error?: string }>();
  return { async request(method, fields = {}) {
    const requestId = randomUUID();
    agent.send(JSON.stringify({ t: "wmsg", id, s: await cipher.encrypt({ id: requestId, method, ...fields }) }));
    const requestDeadline = Date.now() + 5000;
    for (;;) {
      for (; consumed < frames.length; consumed++) {
        const frame = frames[consumed]!;
        if (frame.t !== "wmsg" || frame.id !== id) continue;
        const value = await cipher.decrypt(frame.s!).catch(() => undefined) as { t?: string; id?: string; result?: unknown; error?: string } | undefined;
        if (value?.t === "response" && value.id) inbox.set(value.id, value);
      }
      const value = inbox.get(requestId);
      if (value) return value;
      assert.ok(Date.now() < requestDeadline, `No response for ${method}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } };
}

test("desktop access publishes only registered pairing, attaches the phone-selected project on demand, and revokes old codes", async t => {
  const { url, agent, frames } = await relaySocket(t);
  const counters = { closed: 0, subscriptions: 0 };
  const attached: string[] = [];
  const access = new RemoteAccess({
    list: async () => [workspace],
    attach: async projectId => {
      if (projectId !== workspace.id) throw new Error(`Unknown project: ${projectId}`);
      attached.push(projectId);
      return { workspaceRoot: workspace.workspaceRoot, client: fakeClient(counters) };
    }
  }, () => undefined);
  t.after(async () => { await access.stop(); });
  const start = access.start({ relay: url, registrationKey: "private-relay-key" });
  assert.equal(start.state, "connecting");
  assert.equal(start.pairingUrl, undefined);
  assert.throws(() => access.start({ relay: url }), /先关闭/u);
  await until(() => access.status().state === "connected");
  const link = access.status().pairingUrl!;
  assert.ok(!JSON.stringify(access.status()).includes("private-relay-key"));
  assert.equal(frames.find(frame => frame.t === "register")?.key, "private-relay-key");
  assert.deepEqual(attached, []);
  const code = new URL(link).searchParams.get("k")!;
  const oldHandshake = await beginRemoteHandshake(code);
  agent().send(JSON.stringify({ t: "wopen", id: "first", path: "/__biny_e2e__" }));
  assert.equal(access.status().connections, 0);
  agent().send(JSON.stringify({ t: "wmsg", id: "first", s: JSON.stringify(oldHandshake.hello) }));
  await until(() => access.status().connections === 1);
  const welcome = frames.find(frame => frame.t === "wmsg" && frame.id === "first")!;
  const cipher = await oldHandshake.finish(JSON.parse(welcome.s!));
  assert.equal(counters.subscriptions, 0);
  let consumed = 0;
  const inbox = new Map<string, { result?: unknown; error?: string }>();
  const request = async (method: string, fields: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: string }> => {
    const requestId = randomUUID();
    agent().send(JSON.stringify({ t: "wmsg", id: "first", s: await cipher.encrypt({ id: requestId, method, ...fields }) }));
    const deadline = Date.now() + 5000;
    for (;;) {
      for (; consumed < frames.length; consumed++) {
        const frame = frames[consumed]!;
        if (frame.t !== "wmsg" || frame.id !== "first") continue;
        const value = await cipher.decrypt(frame.s!).catch(() => undefined) as { t?: string; id?: string; result?: unknown; error?: string } | undefined;
        if (value?.t === "response" && value.id) inbox.set(value.id, value);
      }
      const value = inbox.get(requestId);
      if (value) return value;
      assert.ok(Date.now() < deadline, `No response for ${method}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const projects = await request("projects");
  assert.deepEqual((projects.result as { items: Array<{ id: string }> }).items.map(item => item.id), ["project-one"]);
  assert.equal(counters.subscriptions, 0);
  const rejected = await request("sessions", { projectId: "missing" });
  assert.match(rejected.error!, /Unknown project/u);
  const failed = await request("open", { projectId: "missing", sessionId: "other" });
  assert.match(failed.error!, /Unknown project/u);
  assert.equal(access.status().state, "connected");
  const created = await request("create", { projectId: "project-one" });
  assert.ok(created.result);
  assert.deepEqual(attached, ["project-one"]);
  assert.equal(counters.subscriptions, 1);
  await access.regenerate();
  assert.equal(access.status().pairingUrl, undefined);
  assert.equal(counters.closed, 1);
  assert.equal(counters.subscriptions, 0);
  await until(() => access.status().state === "connected");
  assert.notEqual(access.status().pairingUrl, link);
  agent().send(JSON.stringify({ t: "wopen", id: "stale", path: "/__biny_e2e__" }));
  agent().send(JSON.stringify({ t: "wmsg", id: "stale", s: JSON.stringify(oldHandshake.hello) }));
  await until(() => frames.some(frame => frame.t === "wclose" && frame.id === "stale"));
  assert.equal(access.status().connections, 0);
  assert.equal(counters.subscriptions, 0);
  const second = await phone(agent(), frames, "second", new URL(access.status().pairingUrl!).searchParams.get("k")!);
  const secondCreated = await second.request("create", { projectId: "project-one" });
  assert.ok(secondCreated.result);
  assert.deepEqual(attached, ["project-one", "project-one"]);
  await access.stop();
  assert.equal(counters.closed, 2);
  assert.equal(counters.subscriptions, 0);
  assert.equal(access.status().state, "disabled");
  assert.equal(access.status().pairingUrl, undefined);
});

test("stopping during Host attachment waits for release without exposing a late pairing", async t => {
  const { url, agent, frames } = await relaySocket(t);
  let resolveAttach!: (value: { workspaceRoot: string; client: RuntimeHostClient }) => void;
  const attachment = new Promise<{ workspaceRoot: string; client: RuntimeHostClient }>(done => { resolveAttach = done; });
  let closed = false, attachStarted = false;
  const counters = { closed: 0, subscriptions: 0 };
  const lateClient = fakeClient(counters);
  const realClose = lateClient.close.bind(lateClient);
  lateClient.close = async () => { closed = true; await realClose(); };
  const access = new RemoteAccess({ list: async () => [workspace], attach: () => { attachStarted = true; return attachment; } }, () => undefined);
  t.after(async () => { await access.stop(); });
  access.start({ relay: url });
  await until(() => access.status().state === "connected");
  const code = new URL(access.status().pairingUrl!).searchParams.get("k")!;
  const handshake = await beginRemoteHandshake(code);
  agent().send(JSON.stringify({ t: "wopen", id: "phone", path: "/__biny_e2e__" }));
  agent().send(JSON.stringify({ t: "wmsg", id: "phone", s: JSON.stringify(handshake.hello) }));
  await until(() => access.status().connections === 1);
  const welcome = frames.find(frame => frame.t === "wmsg" && frame.id === "phone")!;
  const cipher = await handshake.finish(JSON.parse(welcome.s!));
  agent().send(JSON.stringify({ t: "wmsg", id: "phone", s: await cipher.encrypt({ id: randomUUID(), method: "create", projectId: "project-one" }) }));
  await until(() => attachStarted);
  const stopped = access.stop();
  assert.equal(access.status().pairingUrl, undefined);
  resolveAttach({ workspaceRoot: "/w", client: lateClient });
  await stopped;
  assert.equal(closed, true);
  assert.equal(access.status().state, "disabled");
  assert.equal(access.status().pairingUrl, undefined);
});

test("relay rejection is visible without leaking credentials or a usable QR", async t => {
  const { url } = await relaySocket(t, true);
  const access = new RemoteAccess({ list: async () => [workspace], attach: async () => { throw new Error("unused"); } }, () => undefined);
  t.after(async () => { await access.stop(); });
  access.start({ relay: url, registrationKey: "private-relay-key" });
  await until(() => access.status().state === "error");
  assert.equal(access.status().pairingUrl, undefined);
  assert.ok(!access.status().error?.includes("private-relay-key"));
  await access.stop();
  assert.equal(access.status().state, "disabled");
});
