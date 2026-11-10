import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { runRemoteTunnel } from "../src/remote/tunnel.js";
import { remotePairingUrl, remoteRelayUrl } from "../src/remote/address.js";
import { beginRemoteHandshake, generateConnectCode, routingToken } from "../src/remote/crypto.js";

type Frame = Record<string, any>;
async function fixture(t: TestContext, rejectRegistration = false) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const frames: Frame[] = [];
  let changed = (): void => undefined;
  const next = async (type: string, id?: string): Promise<Frame> => {
    const deadline = Date.now() + 2000;
    while (true) {
      const index = frames.findIndex(frame => frame.t === type && (id === undefined || frame.id === id));
      if (index >= 0) return frames.splice(index, 1)[0]!;
      assert.ok(Date.now() < deadline, `Timed out waiting for ${type}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), Math.max(1, deadline - Date.now()));
        changed = () => { clearTimeout(timer); resolve(); };
      });
    }
  };
  let connections = 0;
  let socket!: WebSocket;
  server.on("connection", (client, request) => {
    connections++;
    socket = client;
    client.on("message", data => {
      const frame = JSON.parse(data.toString()) as Frame;
      frames.push(frame);
      changed();
      if (frame.t === "register") {
        assert.equal(new URL(request.url!, "http://localhost").searchParams.get("th"), frame.tokenHash);
        if (rejectRegistration) client.close(4003, "Rejected");
        else client.send(JSON.stringify({ t: "registered", proto: 1 }));
      }
    });
  });
  const controller = new AbortController();
  const code = generateConnectCode();
  let opened = 0;
  let closed = 0;
  const requests: unknown[] = [];
  let notify: ((value: unknown) => void) | undefined;
  const running = runRemoteTunnel({ relay: `http://127.0.0.1:${address.port}`, code, registrationKey: "test-registration-key",
    createPeer(emit) { opened++; notify = emit; return { async handle(request) { requests.push(request); return { answer: "private answer" }; }, close() { closed++; } }; }
  }, controller.signal);
  void running.catch(() => undefined);
  t.after(async () => {
    controller.abort();
    await running.catch(() => undefined);
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const registration = await next("register");
  assert.equal(registration.proto, 1);
  assert.equal(registration.key, "test-registration-key");
  assert.equal(registration.tokenHash, createHash("sha256").update(await routingToken(code)).digest("hex"));
  assert.ok(!JSON.stringify(registration).includes(code));
  return { code, next, send: (value: unknown) => socket.send(JSON.stringify(value)), running, controller, requests,
    counts: () => ({ opened, closed, connections }), notify: (value: unknown) => notify!(value) };
}

test("remote tunnel refuses plaintext and unauthenticated channels before creating a Host adapter", { timeout: 5000 }, async t => {
  const relay = await fixture(t);
  relay.send({ t: "hreq", id: "plain", method: "POST", path: "/send", b: "e30=" });
  assert.equal((await relay.next("hres", "plain")).status, 403);
  await relay.next("hend", "plain");
  relay.send({ t: "wopen", id: "invalid", path: "/api" });
  await relay.next("werr", "invalid");
  relay.send({ t: "wopen", id: "wrong-code", path: "/__biny_e2e__" });
  await relay.next("wopened", "wrong-code");
  const wrong = await beginRemoteHandshake(generateConnectCode());
  relay.send({ t: "wmsg", id: "wrong-code", s: JSON.stringify(wrong.hello) });
  await relay.next("wclose", "wrong-code");
  assert.deepEqual(relay.counts(), { opened: 0, closed: 0, connections: 1 });
  assert.deepEqual(relay.requests, []);
});

test("remote tunnel dispatches only authenticated requests, encrypts replies/events, and closes replayed channels", { timeout: 5000 }, async t => {
  const relay = await fixture(t);
  relay.send({ t: "wopen", id: "phone", path: "/__biny_e2e__" });
  await relay.next("wopened", "phone");
  const hello = await beginRemoteHandshake(relay.code);
  relay.send({ t: "wmsg", id: "phone", s: JSON.stringify(hello.hello) });
  const cipher = await hello.finish(JSON.parse((await relay.next("wmsg", "phone")).s));
  const id = randomUUID();
  const packet = await cipher.encrypt({ id, method: "projects" });
  relay.send({ t: "wmsg", id: "phone", s: packet });
  const response = await relay.next("wmsg", "phone");
  assert.ok(!response.s.includes("private answer"));
  assert.deepEqual(await cipher.decrypt(response.s), { t: "response", id, result: { answer: "private answer" } });
  relay.notify({ t: "update", content: "private update" });
  assert.deepEqual(await cipher.decrypt((await relay.next("wmsg", "phone")).s), { t: "update", content: "private update" });
  relay.send({ t: "wmsg", id: "phone", s: packet });
  await relay.next("wclose", "phone");
  assert.equal(relay.requests.length, 1);
  assert.deepEqual(relay.counts(), { opened: 1, closed: 1, connections: 1 });
  relay.controller.abort();
  await relay.running;
  relay.notify({ t: "update", content: "late" });
  assert.equal(relay.counts().closed, 1);
});

test("registration rejection stops without redialing", { timeout: 5000 }, async t => {
  const relay = await fixture(t, true);
  await assert.rejects(relay.running, /registration was rejected/u);
  assert.equal(relay.counts().connections, 1);
});

test("relay and native pairing URLs preserve the encrypted protocol boundary", () => {
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=secret"]) assert.throws(() => remoteRelayUrl(url));
  assert.equal(remoteRelayUrl("http://127.0.0.1:8787").origin, "http://127.0.0.1:8787");
  const url = new URL(remotePairingUrl("https://relay.example.com", "test-code"));
  assert.equal(url.protocol, "biny:");
  assert.equal(url.hostname, "connect");
  assert.deepEqual(Object.fromEntries(url.searchParams), { v: "1", e2e: "1", u: "https://relay.example.com", k: "test-code" });
  assert.throws(() => remotePairingUrl("http://example.com", "test-code"));
});
