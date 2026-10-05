/** Run the real extension worker with in-memory Chrome and WebSocket boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const source = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/browser-extension/background.js", import.meta.url))],
  bundle: true, write: false, format: "iife", platform: "browser"
}).outputFiles[0]!.text;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  let message: (value: { type: string }, sender: object, reply: (value: unknown) => void) => void;
  let onDetach: (source: { tabId: number }) => void;
  let releaseDetach!: () => void;
  let rejectDetach!: (error: Error) => void;
  const detaching = new Promise<void>((resolve, reject) => { releaseDetach = resolve; rejectDetach = reject; });
  const attached = new Set<number>();
  const calls: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  class Socket {
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly instances: Socket[] = [];
    readyState = 0;
    deferClose = false;
    readonly sent: Array<Record<string, unknown>> = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => Promise<void>;
    constructor(_url: string) { Socket.instances.push(this); }
    send(value: string): void { this.sent.push(JSON.parse(value)); }
    open(): void { this.readyState = Socket.OPEN; this.onopen?.(); }
    close(): void { this.readyState = 3; if (!this.deferClose) this.finishClose(); }
    finishClose(): void { this.onclose?.(); }
    async receive(value: object): Promise<void> { await this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const chrome = {
    action: { setBadgeText: async () => undefined, onClicked: { addListener() {} } },
    storage: { local: { get: async () => ({ pairingUrl: `ws://127.0.0.1:12345/relay?token=${"a".repeat(64)}` }) } },
    tabs: { get: async (id: number) => ({ id, url: "https://example.com/" }), onRemoved: { addListener() {} } },
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => {
        calls.push("attach");
        assert.equal(attached.has(tabId), false, "old debugger must be released before attaching again");
        attached.add(tabId);
      },
      detach: async ({ tabId }: { tabId: number }) => {
        calls.push("detach");
        await detaching;
        attached.delete(tabId);
        onDetach({ tabId });
      },
      sendCommand: async (_target: unknown, method: string) => {
        calls.push(method);
        return method === "Page.captureScreenshot" ? { data: "iVBORw0KGgo=" } : {};
      },
      onDetach: { addListener(listener: typeof onDetach) { onDetach = listener; } },
      onEvent: { addListener() {} }
    },
    runtime: { onMessage: { addListener(listener: typeof message) { message = listener; } } },
    alarms: { create() {}, onAlarm: { addListener() {} } }
  };
  runInNewContext(source, {
    chrome, WebSocket: Socket, URL,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); }
  });
  return {
    sockets: Socket.instances, calls, releaseDetach, rejectDetach,
    reconnect: () => message({ type: "reconnect" }, {}, () => undefined),
    retry: () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); }
  };
}

async function attachFirstBrowser(state: ReturnType<typeof fixture>) {
  await flush();
  const socket = state.sockets[0]!;
  socket.open();
  await socket.receive({ type: "ready" });
  await socket.receive({ id: "first", method: "screenshot", args: { tabId: 1 } });
  assert.equal(socket.sent.at(-1)?.ok, true);
  assert.equal(state.calls.filter((call) => call === "attach").length, 1);
  return socket;
}

for (const initialDisconnect of ["transport", "manual"] as const) {
  test(`repeated reconnect waits for pending ${initialDisconnect} debugger cleanup`, async () => {
    const state = fixture();
    try {
      const first = await attachFirstBrowser(state);
      if (initialDisconnect === "transport") { first.close(); state.retry(); }
      else { first.deferClose = true; state.reconnect(); }
      await flush();
      assert.equal(state.sockets.length, 1, "initial reconnect waits for detachment");
      state.reconnect();
      state.reconnect();
      await flush();
      assert.equal(state.sockets.length, 1, "manual reconnect must retain outstanding cleanup");
      assert.equal(state.calls.filter((call) => call === "detach").length, 1);

      state.releaseDetach();
      await flush();
      assert.equal(state.sockets.length, 2, "only the latest reconnect opens a new connection");
      const current = state.sockets[1]!;
      current.open();
      await current.receive({ type: "ready" });
      assert.equal(current.sent.length, 1, "old commands are not replayed");
      await current.receive({ id: "second", method: "screenshot", args: { tabId: 1 } });
      assert.equal(current.sent.at(-1)?.ok, true, "fresh command can attach after cleanup");
      assert.equal(current.sent.at(-1)?.id, "second");
      assert.equal(state.calls.filter((call) => call === "attach").length, 2);
      assert.equal(state.calls.filter((call) => call === "Page.captureScreenshot").length, 2);

      if (initialDisconnect === "manual") first.finishClose();
      await flush();
      assert.equal(state.calls.filter((call) => call === "detach").length, 1, "late close from the old socket cannot detach the new debugger");
      await current.receive({ id: "third", method: "screenshot", args: { tabId: 1 } });
      assert.equal(current.sent.at(-1)?.ok, true);
      assert.equal(state.calls.filter((call) => call === "attach").length, 2, "the current connection keeps its attachment");
    } finally { state.releaseDetach(); await flush(); }
  });
}

test("rejected debugger cleanup does not permanently block subsequent reconnects", async () => {
  const state = fixture();
  try {
    await attachFirstBrowser(state);
    state.reconnect();
    state.reconnect();
    await flush();
    assert.equal(state.sockets.length, 1);
    state.rejectDetach(new Error("debugger was already detached"));
    await flush();
    assert.equal(state.sockets.length, 2);
    state.sockets[1]!.open();
    state.reconnect();
    await flush();
    assert.equal(state.sockets.length, 3, "the cleanup chain remains usable after a rejection");
    assert.equal(state.calls.filter((call) => call === "detach").length, 1);
  } finally { state.releaseDetach(); await flush(); }
});
