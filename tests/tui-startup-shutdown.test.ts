/** Exercise terminal shutdown while the real Host client is still attaching. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { globalConfigDir } from "../src/config/paths.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import type { HostRegistration } from "../src/runtime/host/types.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import { BinyTui } from "../src/tui/app.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly paused = deferred<HostRequestFrame>();
  readonly requests: HostRequestFrame[] = [];
  constructor(readonly snapshot: InteractiveRuntimeSnapshot, readonly pauseOperation: string) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean {
    const frame = JSON.parse(data) as HostFrame;
    assert.ok(frame.kind === "hello" || frame.kind === "request");
    if (frame.kind === "hello") {
      queueMicrotask(() => this.deliver({ kind: "response", requestId: frame.requestId, ok: true,
        result: { hostEpoch: "synthetic-epoch", sequence: 1, capabilities: [] } }));
    } else {
      this.requests.push(frame);
      if (frame.operation === this.pauseOperation) this.paused.resolve(frame);
      else queueMicrotask(() => this.reply(frame));
    }
    return true;
  }
  reply(frame: HostRequestFrame): void {
    let result: unknown;
    if (frame.operation === "subscribe" || frame.operation === "snapshot") {
      result = { hostEpoch: "synthetic-epoch", sequence: 1, capabilities: [], snapshot: this.snapshot,
        sessions: [{ sessionId: this.snapshot.info.sessionId, primary: true, snapshot: this.snapshot, lastActiveAt: 1 }] };
    } else if (frame.operation === "skills.list") result = [];
    else if (frame.operation === "runtime.start-draft") result = this.snapshot.info;
    else if (frame.operation === "agent.context") result = { budget: { usedTokens: 0, maxTokens: 1000, source: "estimated" } };
    else if (frame.operation === "agent.usage") result = { summary: {} };
    else if (frame.operation === "cancel") result = undefined;
    else throw new Error(`Unexpected request: ${frame.operation}`);
    this.deliver({ kind: "response", requestId: frame.requestId, ok: true, result });
  }
  deliver(frame: HostFrame): void { if (!this.destroyed) this.emit("data", encodeHostFrame(frame)); }
  destroy(): this {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); }
    return this;
  }
}

async function fixture(t: TestContext, pauseOperation: string, resumeBusy = false) {
  // Keep a failing baseline's resurrected spinner from keeping the test process alive.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-shutdown-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const paths = runtimeHostPaths(root);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const registration: HostRegistration = { ...paths, ...currentRuntimeHostIdentity({ configDir: globalConfigDir() }),
    protocolVersion: runtimeHostProtocolVersion, persistenceRoot: root, hostEpoch: "synthetic-epoch",
    token: "synthetic-token", pid: process.pid, createdAt: new Date().toISOString() };
  await writeFile(paths.registrationPath, `${JSON.stringify(registration)}\n`, { mode: 0o600 });
  await ensureAgentDirs(root);
  const sessionFile = await createSessionFile(root, "synthetic-session", new Uint8Array());
  const snapshot: InteractiveRuntimeSnapshot = { revision: 1,
    info: { workspaceRoot: root, sessionId: "synthetic-session", sessionFile,
      provider: "test", modelAlias: "test", modelLabel: "Test", thinking: "off", reasoningLabel: "Off" },
    permissionMode: "ask", state: resumeBusy ? { kind: "runs", activeRun: {
      sessionId: "synthetic-session", runId: "synthetic-run", messageId: "synthetic-message",
      input: "Synthetic existing run", status: "thinking", startedAt: new Date().toISOString()
    } } : { kind: "idle" } };
  const socket = new MemorySocket(snapshot, pauseOperation);
  t.mock.method(net, "createConnection", () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  t.mock.method(net, "createServer", () => { throw new Error("Real listeners forbidden"); });
  let client: RuntimeHostClient | undefined;
  const connect = RuntimeHostClient.connect;
  t.mock.method(RuntimeHostClient, "connect", async (options: Parameters<typeof RuntimeHostClient.connect>[0]) => {
    client = await connect(options);
    return client;
  });
  let input: ((data: string) => void) | undefined;
  const stopped = deferred<void>();
  const terminal: Terminal = {
    start: onInput => { input = onInput; }, stop: () => stopped.resolve(), drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined
  };
  const app = new BinyTui(new TUI(terminal), root, undefined,
    resumeBusy ? "synthetic-session" : undefined, resumeBusy ? "resume-session" : "new");
  t.after(async () => {
    await app.exit();
    await client?.close();
    app["status"].dispose();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(paths.registrationPath, { force: true });
    await rm(root, { recursive: true, force: true });
  });
  return { app, socket, stopped: stopped.promise, client: () => client, quit: () => {
    assert.ok(input, "the supported terminal input handler is installed before attaching");
    input("\u0003");
    input("\u0003");
  } };
}

for (const resumeBusy of [false, true]) {
  test(`double Ctrl+C during initial attach releases the late client (${resumeBusy ? "resume busy session" : "new chat"})`, { timeout: 5000 }, async t => {
    const f = await fixture(t, "subscribe", resumeBusy);
    const running = f.app.run();
    const subscribe = await f.socket.paused.promise;
    f.quit();
    await f.stopped;
    assert.equal(f.client(), undefined, "shutdown precedes completion of the real client handshake");
    f.socket.reply(subscribe);
    await running;
    t.diagnostic(JSON.stringify({ socketDestroyed: f.socket.destroyed, runtimeListeners: f.client()?.["listeners"].size, requests: f.socket.requests.map(request => request.operation) }));
    assert.equal(f.socket.destroyed, true, "a client resolved after shutdown must release its socket");
    assert.equal(f.socket.requests.some(request => request.operation === "runtime.start-draft"), false,
      "shutdown must not create a new draft after the late attachment");
    assert.equal(f.app["unsubscribe"], undefined, "shutdown must not install a late runtime subscription");
    assert.equal(f.client()?.["listeners"].size, 0);
    assert.equal(f.app["status"]["tickTimer"], undefined, "late startup must not restart the disposed ticker");
  });
}

for (const resumeBusy of [false, true]) {
  test(`shutdown while listing skills cannot resume initialization (${resumeBusy ? "resume busy session" : "new chat"})`, { timeout: 5000 }, async t => {
    const f = await fixture(t, "skills.list", resumeBusy);
    const running = f.app.run();
    await f.socket.paused.promise;
    assert.ok(f.client(), "the client has been installed before skills load");
    f.quit();
    await f.stopped;
    await running;
    assert.equal(f.socket.destroyed, true);
    assert.equal(f.client()!["listeners"].size, 0);
    assert.equal(f.app["unsubscribe"], undefined);
    assert.equal(f.app["status"]["tickTimer"], undefined);
    assert.deepEqual(f.socket.requests.map(request => request.operation), ["subscribe", "skills.list"]);
  });
}

for (const pauseOperation of ["runtime.start-draft", "snapshot"]) {
  test(`shutdown while awaiting ${pauseOperation} still releases the attached client`, { timeout: 5000 }, async t => {
    const f = await fixture(t, pauseOperation);
    const running = f.app.run();
    await f.socket.paused.promise;
    f.quit();
    await f.stopped;
    await running;
    assert.equal(f.socket.destroyed, true);
    assert.equal(f.client()!["listeners"].size, 0);
    assert.equal(f.app["unsubscribe"], undefined);
    assert.equal(f.app["status"]["tickTimer"], undefined);
  });
}

test("ordinary startup stays subscribed until terminal exit", { timeout: 5000 }, async t => {
  const f = await fixture(t, "");
  const running = f.app.run();
  await f.app["startRuntimePromise"];
  assert.equal(f.socket.destroyed, false);
  assert.equal(f.client()!["listeners"].size, 1);
  assert.equal(f.app.tuiState.sessionId, "synthetic-session");
  f.quit();
  await running;
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.client()!["listeners"].size, 0);
});

test("an event during terminal shutdown cannot restart the disposed busy ticker", { timeout: 5000 }, async t => {
  const f = await fixture(t, "", true);
  const running = f.app.run();
  await f.app["startRuntimePromise"];
  assert.equal(f.client()!["listeners"].size, 1);
  assert.notEqual(f.app["status"]["tickTimer"], undefined);
  f.quit();
  // exit() yields while draining owned runs, before removing its subscription.
  // A Host event arriving in that normal shutdown window must remain inert.
  f.socket.deliver({ kind: "event", hostEpoch: "synthetic-epoch", sequence: 2,
    update: { snapshot: { ...f.socket.snapshot, revision: 2 } } });
  await running;
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.client()!["listeners"].size, 0);
  assert.equal(f.app["status"]["tickTimer"], undefined);
});
