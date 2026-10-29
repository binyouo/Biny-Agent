import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUseController, type ComputerDriver } from "../src/computer/controller.js";
import type { ComputerPreview, WindowTarget } from "../src/computer/protocol.js";

const target = { pid: 42, windowId: "900" };
const image = { mimeType: "image/jpeg", dataBase64: "aGVsbG8=" } as const;
const driver: ComputerDriver = {
  start: async () => undefined, stop: async () => undefined,
  list: async () => ({ data: {}, images: [] }),
  observe: async (_session, input) => ({ data: { pid: input.pid, window_id: Number(input.windowId), capture_id: "c1", screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true }, images: [image] }),
  act: async () => ({ data: { effect: "confirmed" }, images: [] })
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("background preview yields to input for 1.2 seconds from dispatch and keeps the action observation", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 0, captures = 0;
  const frames: (ComputerPreview | undefined)[] = [];
  const slowAction = deferred();
  let holdAction = false;
  const controller = new ComputerUseController({ ...driver, act: async () => { if (holdAction) await slowAction.promise; return { data: { effect: "confirmed" }, images: [] }; } }, {
    enabled: true, now: () => now, preview: frame => frames.push(frame),
    refreshPreview: async input => { captures++; return { image, target: input!, capturedAt: now }; }
  });
  try {
    await controller.observe("s", target); controller.setPreview(true);
    t.mock.timers.tick(334); await flush();
    assert.equal(captures, 1);
    now = 1_000;
    await controller.act("s", { ...target, captureId: "c1", action: "press_key", key: "Return" });
    assert.ok(frames.some(frame => frame?.capturedAt === 1_000), "the action observation is published immediately");
    now = 2_199; t.mock.timers.tick(334); await flush();
    assert.equal(captures, 1, "background capture waits until 1.2 seconds after dispatch");
    now = 2_200; t.mock.timers.tick(334); await flush();
    assert.equal(captures, 2);

    now = 3_000; holdAction = true;
    const action = controller.act("s", { ...target, captureId: "c1", action: "press_key", key: "Return" });
    await flush(); now = 4_500; t.mock.timers.tick(334); await flush();
    assert.equal(captures, 2, "no capture overlaps an active input");
    slowAction.resolve(); await action;
    t.mock.timers.tick(334); await flush();
    assert.equal(captures, 3, "a long action does not start a second cooldown after completion");
  } finally { slowAction.resolve(); controller.setPreview(false); t.mock.timers.reset(); }
});

test("launch activity also yields background preview capture", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 0, captures = 0;
  const controller = new ComputerUseController({ ...driver, launchApp: async () => ({ data: { pid: 42 }, images: [] }) }, {
    enabled: true, now: () => now, authorizeLaunch: async () => undefined,
    refreshPreview: async () => { captures++; return undefined; }
  });
  try {
    controller.setPreview(true); t.mock.timers.tick(334); await flush();
    assert.equal(captures, 1);
    now = 1_000; await controller.launch("s", "test.fixture");
    now = 2_199; t.mock.timers.tick(334); await flush();
    assert.equal(captures, 1);
    now = 2_200; t.mock.timers.tick(334); await flush();
    assert.equal(captures, 2);
  } finally { controller.setPreview(false); t.mock.timers.reset(); }
});

test("preview permits only one capture until it settles, even across close and reopen", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const pending = deferred();
  const requests: { target?: WindowTarget; signal: AbortSignal }[] = [];
  const frames: (ComputerPreview | undefined)[] = [];
  const controller = new ComputerUseController(driver, {
    enabled: true, preview: frame => frames.push(frame),
    refreshPreview: async (input, signal) => {
      requests.push({ target: input, signal });
      await pending.promise;
      return { image, target: input ?? { pid: 0, windowId: "screen" }, capturedAt: 7 };
    }
  });
  try {
    await controller.observe("s", target);
    controller.setPreview(true);
    t.mock.timers.tick(2_000); await flush();
    assert.equal(requests.length, 1, "slow capture must not accumulate requests");
    assert.deepEqual(requests[0]!.target, target);
    controller.setPreview(false);
    assert.equal(requests[0]!.signal.aborted, true);
    controller.setPreview(true);
    t.mock.timers.tick(1_000); await flush();
    assert.equal(requests.length, 1, "reopening cannot overlap an unsettled capture");
    pending.resolve(); await flush();
    assert.equal(frames.some(frame => frame?.capturedAt === 7), false, "closed preview cannot publish late pixels into a replacement surface");
    t.mock.timers.tick(334); await flush();
    assert.equal(requests.length, 2);
    assert.ok(frames.some(frame => frame?.capturedAt === 7), "replacement capture can publish a frame");
  } finally { pending.resolve(); controller.setPreview(false); t.mock.timers.reset(); }
});

test("pause and a replacement observation discard late preview frames", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  for (const change of ["pause", "target"] as const) {
    const pending = deferred();
    const frames: (ComputerPreview | undefined)[] = [];
    let signal: AbortSignal | undefined;
    const controller = new ComputerUseController(driver, {
      enabled: true, preview: frame => frames.push(frame),
      refreshPreview: async (input, inputSignal) => {
        signal = inputSignal; await pending.promise;
        return { image, target: input!, capturedAt: 9 };
      }
    });
    try {
      await controller.observe("s", target); controller.setPreview(true);
      t.mock.timers.tick(334); await flush();
      if (change === "pause") {
        controller.control("pause");
        assert.equal(signal?.aborted, true);
      } else {
        await controller.observe("s", { pid: 43, windowId: "901" });
        assert.equal(signal?.aborted, true, "new observations invalidate the pending preview request");
      }
      pending.resolve(); await flush();
      assert.equal(frames.some(frame => frame?.capturedAt === 9), false, change);
    } finally { pending.resolve(); controller.setPreview(false); }
  }
  t.mock.timers.reset();
});

test("failed preview capture releases its slot for the next scheduled refresh", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let calls = 0;
  const frames: (ComputerPreview | undefined)[] = [];
  const controller = new ComputerUseController(driver, {
    preview: frame => frames.push(frame),
    refreshPreview: async () => {
      if (++calls === 1) throw new Error("capture_failed");
      return { image, target: { pid: 0, windowId: "screen" }, capturedAt: 11 };
    }
  });
  try {
    controller.setPreview(true); t.mock.timers.tick(334); await flush();
    t.mock.timers.tick(334); await flush();
    assert.equal(calls, 2);
    assert.ok(frames.some(frame => frame?.capturedAt === 11));
  } finally { controller.setPreview(false); t.mock.timers.reset(); }
});
