import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUseController, type ComputerDriver, type DriverReply } from "../src/computer/controller.js";

const target = { pid: 42, windowId: "900" };
const other = { pid: 43, windowId: "901" };
const frame = (): DriverReply => ({ data: { pid: 42, window_id: 900, capture_id: "c1", screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true }, images: [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }] });
function fixture(enabled = false) {
  const calls: string[] = [];
  const lifecycle: string[] = [];
  let start: ComputerDriver["start"] = async () => undefined;
  let action: ComputerDriver["act"] = async () => ({ data: { effect: "confirmed" }, images: [] });
  let observe: ComputerDriver["observe"] = async () => frame();
  const driver: ComputerDriver = { start: async () => { lifecycle.push("start"); await start(); }, stop: async () => { lifecycle.push("stop"); }, list: async () => { lifecycle.push("list"); return { data: { apps: [] }, images: [] }; }, observe: (...args) => { lifecycle.push("observe"); return observe(...args); }, act: (...args) => { calls.push(args[1].action); return action(...args); } };
  let now = 0;
  const previews: unknown[] = [];
  const controller = new ComputerUseController(driver, { enabled, now: () => now, preview: value => previews.push(value) });
  return { controller, calls, lifecycle, previews, setStart: (value: typeof start) => { start = value; }, setAction: (value: typeof action) => { action = value; }, setObserve: (value: typeof observe) => { observe = value; }, advance: () => { now = 60_001; } };
}
test("observation options reach the driver and remain in post-action verification, not target identity", async () => {
  const f = fixture(true);
  const observations: unknown[] = [];
  const request = { ...target, depth: 3, screenshotMaxWidth: 320, interactiveOnly: false, autoLaunch: false };
  f.setObserve(async (_session, input) => { observations.push(input); return frame(); });
  await f.controller.observe("s", request);
  assert.deepEqual(f.controller.currentCapture()?.target, target);
  await f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Return" });
  assert.deepEqual(observations, [request, request]);
  for (const options of [{ depth: 0 }, { depth: 21 }, { screenshotMaxWidth: 0 }, { interactiveOnly: "false" }, { extra: true }]) {
    assert.throws(() => f.controller.observe("s", { ...target, ...options } as never));
  }
  assert.equal(observations.length, 2, "invalid options cannot reach the driver");
});
test("disabled and permission/missing/version failures do not admit calls", async () => {
  const f = fixture();
  await assert.rejects(f.controller.observe("s", target), /disabled/);
  for (const message of ["driver_missing", "driver_version_mismatch", "permission_required"]) {
    const failed = fixture(); failed.setStart(async () => { throw new Error(message); });
    await failed.controller.enable();
    await assert.rejects(failed.controller.list("s"), new RegExp(message));
    assert.equal(failed.controller.status().state, "ready", "startup failure must retain the enabled intent");
    assert.equal(failed.controller.status().diagnostic, message);
    assert.deepEqual(failed.lifecycle, ["start"], "startup failure cannot dispatch the requested operation");
    failed.setStart(async () => undefined);
    await failed.controller.list("s");
    assert.equal(failed.controller.status().diagnostic, undefined);
  }
});
test("restored enabled intent and explicit enable are cold until an admitted first call", async () => {
  const restored = fixture(true);
  assert.equal(restored.controller.status().state, "ready");
  assert.deepEqual(restored.lifecycle, [], "restoring intent cannot start a driver or capture a frame");
  await Promise.all([restored.controller.list("s"), restored.controller.list("s"), restored.controller.observe("s", target)]);
  assert.deepEqual(restored.lifecycle, ["start", "list", "list", "observe"], "concurrent first calls share one lazy startup");
  const enabled = fixture();
  await enabled.controller.enable(); await enabled.controller.enable();
  assert.equal(enabled.controller.status().state, "ready");
  assert.deepEqual(enabled.lifecycle, [], "enable only arms the capability");
  await enabled.controller.list("s");
  assert.deepEqual(enabled.lifecycle, ["start", "list"]);
});
test("missing intent, pre-cancelled calls and paused or taken-over control cannot start the driver", async () => {
  const disabled = fixture();
  await assert.rejects(disabled.controller.list("s"), /computer_disabled/u);
  assert.deepEqual(disabled.lifecycle, []);
  const restored = fixture(true);
  const signal = AbortSignal.abort();
  await assert.rejects(restored.controller.list("s", undefined, signal), /abort/iu);
  assert.deepEqual(restored.lifecycle, []);
  for (const control of ["pause", "takeover"] as const) {
    restored.controller.control(control);
    await restored.controller.enable();
    await assert.rejects(restored.controller.list("s"), new RegExp(control === "pause" ? "computer_paused" : "computer_taken-over"));
    assert.deepEqual(restored.lifecycle, []);
  }
});
test("rearming cannot admit a request queued while the capability was disabled", async () => {
  const f = fixture();
  const denied = assert.rejects(f.controller.list("old"), /disabled|invalidated/u);
  await f.controller.enable();
  await denied;
  assert.deepEqual(f.lifecycle, []);
  assert.equal(f.controller.status().owner, undefined);
  await f.controller.list("new");
  assert.equal(f.controller.status().owner, "new");
});
test("cancelled startup rejects promptly and its late completion cannot dispatch input", { timeout: 2_000 }, async () => {
  const f = fixture(true);
  const entered = deferred(); const ready = deferred();
  f.setStart(async () => { entered.resolve(); await ready.promise; });
  const controller = new AbortController();
  const request = f.controller.observe("s", target, controller.signal);
  const rejected = assert.rejects(request, /abort|cancel/iu);
  try {
    await withTimeout(entered.promise);
    controller.abort();
    await withTimeout(rejected);
    assert.equal(f.controller.status().state, "ready", "request cancellation cannot clear persisted enabled intent");
    ready.resolve();
    await waitFor(() => f.lifecycle.includes("stop"));
    assert.deepEqual(f.lifecycle.filter(call => call === "observe" || call === "list"), []);
    assert.deepEqual(f.calls, []);
  } finally { ready.resolve(); await request.catch(() => undefined); }
});
test("disable during startup invalidates queued calls and late startup cannot re-enable", { timeout: 2_000 }, async () => {
  const f = fixture(true);
  const entered = deferred(); const ready = deferred();
  f.setStart(async () => { entered.resolve(); await ready.promise; });
  const request = f.controller.observe("s", target);
  const rejected = assert.rejects(request, /abort|cancel|invalidated/iu);
  try {
    await withTimeout(entered.promise);
    const queued = assert.rejects(f.controller.list("s"), /invalidated/u);
    await withTimeout(f.controller.disable());
    assert.equal(f.controller.status().state, "disabled");
    await withTimeout(rejected); await withTimeout(queued);
    const disabled = f.controller.status();
    ready.resolve();
    await waitFor(() => f.lifecycle.filter(call => call === "stop").length >= 2);
    assert.deepEqual(f.controller.status(), disabled);
    assert.deepEqual(f.lifecycle.filter(call => call === "observe" || call === "list"), []);
    assert.deepEqual(f.calls, []);
  } finally { ready.resolve(); await request.catch(() => undefined); }
});
test("takeover during startup cannot be undone by a late SDK callback", { timeout: 2_000 }, async () => {
  const f = fixture(true);
  const entered = deferred(); const ready = deferred();
  f.setStart(async () => { entered.resolve(); await ready.promise; });
  const request = f.controller.observe("s", target);
  const rejected = assert.rejects(request, /abort|cancel|invalidated/iu);
  try {
    await withTimeout(entered.promise);
    f.controller.control("takeover");
    await withTimeout(rejected);
    const takenOver = f.controller.status();
    ready.resolve();
    await waitFor(() => f.lifecycle.includes("stop"));
    assert.deepEqual(f.controller.status(), takenOver);
    await assert.rejects(f.controller.list("s"), /taken-over/u);
    assert.deepEqual(f.lifecycle.filter(call => call === "observe" || call === "list"), []);
  } finally { ready.resolve(); await request.catch(() => undefined); }
});
test("a new admitted request waits for cancelled startup cleanup before restarting", { timeout: 2_000 }, async () => {
  const f = fixture(true);
  const entered = deferred(); const ready = deferred();
  f.setStart(async () => { entered.resolve(); await ready.promise; });
  const signal = new AbortController();
  const first = f.controller.list("s", undefined, signal.signal);
  const rejected = assert.rejects(first, /abort|cancel/iu);
  let next: Promise<DriverReply> | undefined;
  try {
    await withTimeout(entered.promise); signal.abort(); await withTimeout(rejected);
    next = f.controller.list("s");
    f.setStart(async () => undefined); ready.resolve();
    await withTimeout(next);
    assert.deepEqual(f.lifecycle, ["start", "stop", "start", "list"], "the cancelled startup cannot stop or dispatch the replacement operation");
    assert.equal(f.controller.status().state, "ready");
  } finally { ready.resolve(); await first.catch(() => undefined); await next?.catch(() => undefined); }
});
test("crash requires explicit rearm and clears the first-start cache", async () => {
  const f = fixture(true);
  await f.controller.list("old"); f.controller.crashed();
  await assert.rejects(f.controller.list("new"), /disabled/u);
  assert.equal(f.controller.status().lastOutcome, "unknown");
  assert.deepEqual(f.lifecycle, ["start", "list"]);
  await f.controller.enable();
  assert.deepEqual(f.lifecycle, ["start", "list"], "rearm must remain cold");
  await f.controller.list("new");
  assert.deepEqual(f.lifecycle, ["start", "list", "start", "list"]);
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
  const lifecycle = [...f.lifecycle];
  await f.controller.enable(); await assert.rejects(f.controller.list("s"), /unknown/u);
  assert.deepEqual(f.lifecycle, lifecycle, "unknown outcomes cannot automatically resume or restart the driver");
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Controller lifecycle event timed out.")), 500); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Controller lifecycle event timed out.");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("approval changes cancel waiting observations before screenshot dispatch", async () => {
  const entered = deferred(); const release = deferred(); let screenshots = 0;
  const driver: ComputerDriver = { start: async () => undefined, stop: async () => undefined,
    list: async () => ({ data: { apps: [] }, images: [] }),
    observe: async () => { screenshots++; return frame(); }, act: async () => ({ data: { effect: "confirmed" }, images: [] }) };
  const controller = new ComputerUseController(driver, { enabled: true, authorize: async () => { entered.resolve(); await release.promise; return "test.notes"; } });
  const request = controller.observe("s", target);
  const rejected = assert.rejects(request, /abort|invalidated/iu);
  await entered.promise;
  controller.authorizationChanged();
  release.resolve(); await rejected;
  assert.equal(screenshots, 0);
});

test("PID reuse cannot deliver an old application's captured input even when both apps are authorized", async () => {
  let appId = "test.notes"; let inputs = 0;
  const driver: ComputerDriver = { start: async () => undefined, stop: async () => undefined,
    list: async () => ({ data: { apps: [] }, images: [] }), observe: async () => frame(),
    act: async () => { inputs++; return { data: { effect: "confirmed" }, images: [] }; } };
  const controller = new ComputerUseController(driver, { enabled: true, authorize: async () => appId });
  await controller.observe("s", target); appId = "test.other";
  await assert.rejects(controller.act("s", { ...target, captureId: "c1", action: "press_key", key: "Enter" }), /capture_app_identity_changed/);
  assert.equal(inputs, 0);
});

// 前台交付是唯一允许动作改变用户焦点的模式，此前没有任何测试覆盖它的闸门。
test("foreground delivery stays refused until the user turns it on, and closes again when they do not", async () => {
  const f = fixture(); await f.controller.enable(); await f.controller.observe("s", target);

  // 默认不放行：后台交付是默认，且不需要任何许可。
  await f.controller.observe("s", target);
  await f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Enter" });
  assert.deepEqual(f.calls, ["press_key"], "默认的后台交付不该被闸门拦住");

  // 同一个动作，声明成前台交付 → 必须拒绝，且绝不能派发。
  await f.controller.observe("s", target);
  await assert.rejects(
    f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Enter", delivery: "foreground" }),
    /foreground_permission_required/
  );
  assert.deepEqual(f.calls, ["press_key"], "被拒的前台动作不能落到驱动上");

  // 用户显式放行后才通过。
  f.controller.setForeground(true);
  await f.controller.observe("s", target);
  await f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Enter", delivery: "foreground" });
  assert.deepEqual(f.calls, ["press_key", "press_key"], "放行后才派发");

  // 关掉之后必须立刻恢复拒绝 —— 这个开关不能有粘性。
  f.controller.setForeground(false);
  await f.controller.observe("s", target);
  await assert.rejects(
    f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Enter", delivery: "foreground" }),
    /foreground_permission_required/
  );
  assert.deepEqual(f.calls, ["press_key", "press_key"], "关闭后不得再派发前台动作");
});

// Alma 的 PiP 是「操控期间亮着的监督窗」：动作经 activity 续命，停手 90s 自动收起
// （notes/19 §5、notes/01）。用户的选择不该因此被改掉 —— 所以「偏好」和「此刻显示」
// 必须是两件事，否则开关会自己跳回去。
test("the preview lights up with activity, times out on its own, and re-arms on the next action", async () => {
  const visible: boolean[] = [];
  const calls: string[] = [];
  const driver: ComputerDriver = {
    start: async () => undefined, stop: async () => undefined,
    list: async () => ({ data: { apps: [] }, images: [] }),
    observe: async () => ({ data: { capture_id: "c1", pid: 1, window_id: 10, screenshot_width: 100, screenshot_height: 100, screenshot_frame_valid: true, elements: [] }, images: [{ mimeType: "image/jpeg", dataBase64: "aGVsbG8=" }] }),
    act: async (...args) => { calls.push(args[1].action); return { data: { effect: "confirmed" }, images: [] }; }
  };
  const controller = new ComputerUseController(driver, {
    enabled: true,
    refreshPreview: async () => undefined,
    setPreviewVisible: shown => visible.push(shown),
    previewIdleMs: 40
  });
  const target = { pid: 1, windowId: "10" };
  try {
    // 用户打开 PiP → 立刻可见
    controller.setPreview(true);
    assert.deepEqual(visible, [true], "打开时应当立刻显示");
    assert.equal(controller.status().preview, true);

    // 停手之后自己收起 —— 但偏好还在
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.deepEqual(visible, [true, false], "停手后监督窗应自动收起");
    assert.equal(controller.status().preview, true, "自动收起不能改掉用户的开关");

    // 下一次动作把它重新亮起来
    await controller.observe("s", target);
    await controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Return" });
    assert.deepEqual(visible, [true, false, true], "新动作应把监督窗重新亮起");

    // 用户手动关掉 → 收起且偏好归位
    controller.setPreview(false);
    assert.equal(controller.status().preview, false);
    assert.equal(visible[visible.length - 1], false);
    await new Promise(resolve => setTimeout(resolve, 90));
    const afterClose = visible.length;
    assert.equal(visible[afterClose - 1], false, "关掉之后不该再被定时器翻出来");
  } finally {
    controller.setPreview(false);
  }
});

// 「对哪个应用、成了没有、为什么没成」要留下；而**动作参数不留**
// —— text 是用户输入、elementToken 是私有引用，留档就等于把用户敲的东西存起来。
test("the audit trail records which app and why it failed, but never the arguments", async () => {
  const f = fixture(); await f.controller.enable(); f.controller.setLogging(true);
  await f.controller.observe("s", target);

  await f.controller.act("s", { ...target, action: "press_key", captureId: "c1", key: "Return" });
  const ok = f.controller.audit();
  assert.equal(ok.length, 1);
  assert.equal(ok[0]?.action, "press_key");
  assert.equal("args" in (ok[0] ?? {}), false, "参数（可能含用户输入）不得进审计");

  // 失败：带错误码
  f.setAction(async () => ({ data: { effect: "refused", code: "background_unavailable" }, images: [] }));
  await f.controller.observe("s", target);
  await f.controller.act("s", { ...target, action: "click", captureId: "c1", x: 1, y: 2 });
  const refused = f.controller.audit().at(-1);
  assert.equal(refused?.outcome, "refused");
  assert.equal(refused?.errorCode, "background_unavailable", "失败原因要能直接看出");
});

test("screenshot drag endpoints stay inside the observed frame while screen-space can be negative", async () => {
  const { controller, calls } = fixture(true);
  await controller.observe("s", target);
  const drag = { ...target, captureId: "c1", action: "drag" as const, x1: -1, y1: 0, x2: 10, y2: 10 };
  await assert.rejects(controller.act("s", drag), /capture_coordinates_out_of_bounds/);
  assert.deepEqual(calls, []);
  await assert.rejects(controller.act("s", { ...drag, x1: 0, y2: 80 }), /capture_coordinates_out_of_bounds/);
  await controller.act("s", { ...drag, coordinateSpace: "screen" });
  assert.deepEqual(calls, ["drag"]); await controller.disable();
});
