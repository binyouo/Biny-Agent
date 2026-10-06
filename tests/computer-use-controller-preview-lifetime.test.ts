import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ComputerAuditStore } from "../src/computer/auditStore.js";
import { ComputerUseController, type ComputerDriver, type DriverReply } from "../src/computer/controller.js";
import type { ComputerPreview } from "../src/computer/protocol.js";

const target = { pid: 42, windowId: "900" };
const image = { mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7eoAAAAASUVORK5CYII=" } as const;
const observation = (): DriverReply => ({ data: { pid: 42, window_id: 900, capture_id: "synthetic", screenshot_width: 1, screenshot_height: 1, screenshot_frame_valid: true }, images: [image] });
const action = { ...target, captureId: "synthetic", action: "press_key" as const, key: "Return" };
const openMirror = { ...target, operation: "open" as const };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, overrides: Partial<ComputerDriver> = {}, options: ConstructorParameters<typeof ComputerUseController>[1] = {}) {
  const auditStore = new ComputerAuditStore();
  const visible: boolean[] = [];
  const frames: (ComputerPreview | undefined)[] = [];
  const calls: string[] = [];
  const mirrorCalls: { operation: string; requestId: unknown }[] = [];
  const registrations: { windowId: string; requestId?: string }[] = [];
  const driver: ComputerDriver = {
    start: async () => { calls.push("start"); }, stop: async () => { calls.push("stop"); },
    list: async () => ({ data: {}, images: [] }),
    observe: async () => { calls.push("observe"); return observation(); },
    act: async () => ({ data: { effect: "confirmed" }, images: [] }),
    mirror: async (operation, args) => { mirrorCalls.push({ operation, requestId: args.request_id }); return { data: { closed: operation === "close" ? 1 : 0 }, images: [] }; },
    ...overrides
  };
  const controller = new ComputerUseController(driver, {
    enabled: true, actionLogging: true, auditStore, now: () => 0,
    preview: frame => frames.push(frame), setPreviewVisible: value => visible.push(value),
    refreshPreview: async () => { calls.push("refresh"); return undefined; },
    onMirrorChange: (windowId, requestId) => registrations.push({ windowId, requestId }),
    ...options
  });
  t.after(async () => { await controller.disable(); auditStore.close(); });
  return { controller, driver, visible, frames, calls, mirrorCalls, registrations };
}

for (const reenable of [false, true]) test(`late confirmed input preserves its receipt without reopening preview after disable${reenable ? "/enable" : ""}`, async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const entered = deferred(), finish = deferred<DriverReply>();
  let signal: AbortSignal | undefined;
  const f = fixture(t, { act: async (_session, _action, inputSignal) => { signal = inputSignal; entered.resolve(); return await finish.promise; } });
  await f.controller.observe("old", target);
  f.controller.setPreview(true);
  const pending = f.controller.act("old", action);
  await entered.promise;
  await f.controller.disable();
  if (reenable) await f.controller.enable();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(f.visible, [true, false]);
  finish.resolve({ data: { effect: "confirmed" }, images: [] });
  const result = await pending;
  assert.equal(result.data.status, "completed");
  assert.equal(result.data.doNotRepeat, true);
  assert.equal(result.data.workflowInterrupted, true);
  assert.equal((result.data.observation as { available: boolean }).available, false);
  assert.deepEqual(result.images, []);
  assert.deepEqual(f.visible, [true, false], "an old action cannot restart presentation after disable has resolved");
  t.mock.timers.tick(334); await flush();
  assert.equal(f.calls.includes("refresh"), false, "no new frame-pump work is armed");
  assert.equal(f.calls.filter(call => call === "observe").length, 1);
  assert.equal(f.controller.currentCapture(), undefined);
  assert.equal(f.controller.status().owner, undefined);
  assert.equal(f.controller.status().state, reenable ? "ready" : "disabled");
  assert.equal(f.controller.audit().at(-1)?.outcome, "completed", "stale receipt still has its truthful audit entry");
});

for (const phase of ["authorization", "open"] as const) {
  for (const reenable of [false, true]) test(`preview off${reenable ? "/on" : ""} retires mirror opening pending in ${phase}`, async t => {
    const entered = deferred(), finish = deferred();
    const calls: { operation: string; requestId: unknown }[] = [];
    const f = fixture(t, { mirror: async (operation, args) => {
      calls.push({ operation, requestId: args.request_id });
      if (phase === "open" && operation === "open") { entered.resolve(); await finish.promise; }
      return { data: { closed: operation === "close" ? 1 : 0 }, images: [] };
    } }, { authorize: async () => { if (phase === "authorization") { entered.resolve(); await finish.promise; } return "test.synthetic"; } });
    const pending = f.controller.mirror("old", openMirror);
    const rejected = assert.rejects(pending, /computer_(mirror_invalidated|preview_disabled)/);
    await entered.promise;
    f.controller.setPreview(false);
    if (reenable) f.controller.setPreview(true);
    const callsBeforeCompletion = calls.length;
    finish.resolve(); await rejected;
    assert.equal(f.registrations.some(value => value.requestId), false, "old completion cannot register a preview source");
    assert.equal(calls.filter(call => call.operation === "open").length, phase === "open" ? 1 : 0);
    if (phase === "open") {
      assert.ok(calls.slice(callsBeforeCompletion).some(call => call.operation === "close"), "an already-dispatched open needs completion-time cleanup");
      assert.ok(calls.every(call => call.requestId === calls[0]!.requestId), "cleanup is limited to the retired request");
    }
    assert.equal(f.controller.status().preview, reenable);
    assert.equal(f.controller.status().state, "ready");
  });
}

test("preview off/on rejects an old queued mirror but admits an explicitly new mirror", async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, { list: async () => { entered.resolve(); await finish.promise; return { data: {}, images: [] }; } });
  const blocking = f.controller.list("same"); await entered.promise;
  const old = f.controller.mirror("same", openMirror);
  const rejected = assert.rejects(old, /computer_(mirror_invalidated|preview_disabled)/);
  f.controller.setPreview(false); f.controller.setPreview(true);
  const fresh = f.controller.mirror("same", openMirror);
  finish.resolve(); await blocking; await rejected; await fresh;
  assert.equal(f.mirrorCalls.filter(call => call.operation === "open").length, 1);
  assert.equal(f.registrations.filter(value => value.requestId).length, 1);
});

test("ordinary preview dismissal/reopen does not revoke an authorized mirror opening", async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, {}, { authorize: async () => { entered.resolve(); await finish.promise; return "test.synthetic"; } });
  f.controller.setPreview(true);
  const pending = f.controller.mirror("same", openMirror); await entered.promise;
  f.controller.dismissPreview(); f.controller.setPreview(true);
  finish.resolve(); await pending;
  assert.equal(f.mirrorCalls.filter(call => call.operation === "open").length, 1);
  assert.equal(f.registrations.filter(value => value.requestId).length, 1);
});

test("preview off/on leaves unrelated admitted input and post-action observation intact", async t => {
  const entered = deferred(), finish = deferred(); let signal: AbortSignal | undefined;
  const f = fixture(t, { act: async (_session, _action, inputSignal) => { signal = inputSignal; entered.resolve(); await finish.promise; return { data: { effect: "confirmed" }, images: [] }; } });
  await f.controller.observe("same", target);
  const pending = f.controller.act("same", action); await entered.promise;
  f.controller.setPreview(false); f.controller.setPreview(true);
  assert.equal(signal?.aborted, false);
  finish.resolve(); const result = await pending;
  assert.equal(result.data.status, "completed");
  assert.equal(result.data.doNotRepeat, true);
  assert.deepEqual(result.data.observation, { available: true });
  assert.equal(f.calls.filter(call => call === "observe").length, 2);
  assert.deepEqual(f.controller.currentCapture()?.target, target);
});
