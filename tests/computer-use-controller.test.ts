import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUseController, type ComputerDriver, type DriverReply } from "../src/computer/controller.js";

const target = { pid: 42, windowId: "900" };
const other = { pid: 43, windowId: "901" };
const frame = (): DriverReply => ({ data: { pid: 42, window_id: 900, capture_id: "c1", screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true }, images: [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }] });
function fixture() {
  const calls: string[] = [];
  let action: ComputerDriver["act"] = async () => ({ data: { effect: "confirmed" }, images: [] });
  let observe: ComputerDriver["observe"] = async () => frame();
  const driver: ComputerDriver = { start: async () => undefined, stop: async () => undefined, list: async () => ({ data: { apps: [] }, images: [] }), observe: (...args) => observe(...args), act: (...args) => { calls.push(args[1].action); return action(...args); } };
  let now = 0;
  const previews: unknown[] = [];
  const controller = new ComputerUseController(driver, { now: () => now, preview: value => previews.push(value) });
  return { controller, calls, previews, setAction: (value: typeof action) => { action = value; }, setObserve: (value: typeof observe) => { observe = value; }, advance: () => { now = 60_001; } };
}
test("disabled and permission/missing/version failures do not admit calls", async () => {
  const f = fixture();
  await assert.rejects(f.controller.observe("s", target), /disabled/);
  for (const message of ["driver_missing", "driver_version_mismatch", "permission_required"]) {
    const driver = { start: async () => { throw new Error(message); }, stop: async () => undefined } as ComputerDriver;
    const c = new ComputerUseController(driver);
    await assert.rejects(c.enable(), new RegExp(message));
    assert.equal(c.status().state, "disabled");
  }
});
test("exact session, target, TTL and one-use capture; action followed by observation", async () => {
  const f = fixture(); await f.controller.enable();
  await f.controller.observe("s", target);
  await assert.rejects(f.controller.observe("other-session", target), /owner/);
  await assert.rejects(f.controller.act("s", { ...other, action: "click", captureId: "c1", x: 1, y: 2 }), /capture/);
  await assert.rejects(f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 100, y: 2 }), /bounds/);
  const reply = await f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 });
  assert.equal(reply.data.status, "completed"); assert.equal(reply.images.length, 1);
  f.advance();
  await assert.rejects(f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 }), /capture_expired/);
});
test("background refusal is preserved without foreground retry; unverifiable is not success", async () => {
  const f = fixture(); await f.controller.enable(); await f.controller.observe("s", target);
  f.setAction(async () => ({ data: { effect: "refused", code: "background_unavailable" }, images: [] }));
  const result = await f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Enter" });
  assert.equal(result.data.status, "refused"); assert.deepEqual(f.calls, ["press_key"]);
  f.setAction(async () => ({ data: { effect: "unverifiable" }, images: [] }));
  await f.controller.observe("s", target);
  assert.equal((await f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Enter" })).data.status, "unverified");
});
test("pause/takeover abort the SDK, drop late frames, invalidate queued actions", async () => {
  const f = fixture(); await f.controller.enable(); await f.controller.observe("s", target);
  let release!: () => void; let seenSignal: AbortSignal | undefined;
  f.setAction(async (_session, _action, signal) => { seenSignal = signal; await new Promise<void>(resolve => { release = resolve; }); return { data: { effect: "confirmed" }, images: [] }; });
  const first = f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  const queued = f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Enter" });
  f.controller.control("takeover"); assert.equal(seenSignal?.aborted, true); release();
  const late = await first; assert.equal(late.data.status, "completed"); assert.equal(late.data.workflowInterrupted, true); await assert.rejects(queued, /invalidated/);
  assert.equal(f.controller.status().state, "taken-over"); assert.deepEqual(f.calls, ["click"]);
  f.controller.control("resume"); await assert.rejects(f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 }), /capture/);
});
test("disconnect/crash outcome is unknown, no automatic replay, preview close/reopen", async () => {
  const f = fixture(); await f.controller.enable(); f.controller.setPreview(true); await f.controller.observe("s", target);
  assert.equal(f.previews.length, 1); f.controller.setPreview(false); assert.equal(f.previews.at(-1), undefined);
  f.controller.setPreview(true); assert.equal(f.previews.length, 2);
  f.setAction(async () => { throw new Error("connection closed"); });
  await assert.rejects(f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 }), /unknown/);
  assert.equal(f.controller.status().state, "unknown"); assert.equal(f.controller.status().lastOutcome, "unknown");
  f.controller.control("resume"); await f.controller.observe("s", target); assert.notEqual(f.previews.at(-1), undefined);
  await f.controller.disable(); assert.equal(f.controller.status().owner, undefined);
});

test("late failure belongs to its old generation after stop/reopen", async () => {
  const f = fixture(); await f.controller.enable(); await f.controller.observe("old", target);
  let fail!: () => void;
  f.setAction(async () => { await new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("old connection failed")); }); return { data: {}, images: [] }; });
  const old = f.controller.act("old", { ...target, action: "click", captureId: "c1", x: 1, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  await f.controller.disable(); await f.controller.enable();
  const reopened = f.controller.status(); fail();
  await assert.rejects(old, /unknown/);
  assert.deepEqual(f.controller.status(), reopened);
  await f.controller.observe("new", target);
  assert.equal(f.controller.status().owner, "new");
});
test("confirmed input preserves completion when verification is interrupted and blocks next input", async () => {
  const f = fixture(); await f.controller.enable(); await f.controller.observe("s", target);
  let release!: () => void; let observedSignal: AbortSignal | undefined;
  f.setObserve(async (_session, _target, signal) => { observedSignal = signal; await new Promise<void>(resolve => { release = resolve; }); return frame(); });
  const action = f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  f.controller.control("takeover"); assert.equal(observedSignal?.aborted, true); release();
  const result = await action;
  assert.equal(result.data.status, "completed"); assert.deepEqual(result.data.observation, { available: false, reason: "computer_verification_interrupted: This operation was aborted" });
  assert.equal(result.errorCode, undefined); assert.equal(result.data.doNotRepeat, true); assert.deepEqual(result.images, []);
  assert.equal(f.controller.status().state, "taken-over");
  await assert.rejects(f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 }), /taken-over/);
});

test("verification refusal does not turn confirmed delivery into an input failure", async () => {
  const f = fixture(); await f.controller.enable(); await f.controller.observe("s", target);
  f.setObserve(async () => ({ data: {}, images: [], errorCode: "capture_generation_mismatch" }));
  const result = await f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 });
  assert.equal(result.data.status, "completed"); assert.equal(result.errorCode, undefined);
  assert.equal(result.data.doNotRepeat, true); assert.equal(f.controller.status().state, "paused");
  assert.deepEqual(result.data.observation, { available: false, reason: "capture_generation_mismatch" });
});
