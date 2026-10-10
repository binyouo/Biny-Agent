import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createRunDeadlineSignal } from "../src/cli/runDeadline.js";

const maxTimeoutMs = 2_147_483_647;
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
const startMs = 1_800_000_000_000;

for (const { name, durationMs, marginMs = 1_000 } of [
  { name: "short deadline", durationMs: 5_000 },
  { name: "maximum timer delay", durationMs: maxTimeoutMs + 1_000 },
  { name: "one millisecond over the timer limit", durationMs: maxTimeoutMs + 1_001 },
  { name: "30-day deadline", durationMs: thirtyDaysMs },
  { name: "zero safety margin", durationMs: 5_000, marginMs: 0 },
  { name: "expired deadline", durationMs: -1 },
  { name: "deadline within the safety margin", durationMs: 500 }
]) {
  test(`run deadline preserves timing for ${name}`, (context) => {
    const clock = fakeClock(context);
    const deadline = createRunDeadlineSignal(startMs + durationMs, marginMs);
    context.after(() => deadline.dispose());
    const stopAtMs = Math.max(startMs, startMs + durationMs - marginMs);
    assert.equal(deadline.signal.aborted, false, "initial cancellation remains asynchronous");
    const first = clock.timers[0]!;
    context.diagnostic(`requested=${first.delayMs}, normalized=${first.effectiveMs}`);
    clock.advanceTo(startMs + 1);
    assert.equal(deadline.signal.aborted, stopAtMs <= startMs + 1, "must not abort a future deadline after 1 ms");
    assert.equal(first.delayMs, Math.min(maxTimeoutMs, stopAtMs - startMs));
    if (stopAtMs > startMs + 1) {
      if (stopAtMs - startMs > maxTimeoutMs) {
        clock.advanceTo(startMs + maxTimeoutMs);
        assert.equal(deadline.signal.aborted, false, "first long-deadline segment must only rearm");
        assert.equal(clock.timers[1]?.delayMs, stopAtMs - clock.now());
      }
      clock.advanceTo(stopAtMs - 1);
      assert.equal(deadline.signal.aborted, false);
      clock.advanceTo(stopAtMs);
    }
    assertTimeout(deadline.signal);
    assert.ok(clock.timers.every((timer) => timer.delayMs >= 0 && timer.delayMs <= maxTimeoutMs));
    assert.ok(clock.timers.every((timer) => timer.unrefCalls === 1));
    assert.equal(clock.pending().length, 0);
  });
}

for (const durationMs of [-10_000, 500]) {
  test(`initially due deadline (${durationMs} ms ahead) still aborts if the clock moves back`, (context) => {
    const clock = fakeClock(context);
    const deadline = createRunDeadlineSignal(startMs + durationMs);
    context.after(() => deadline.dispose());
    assert.equal(deadline.signal.aborted, false);
    assert.equal(clock.timers[0]?.delayMs, 0);
    clock.fireAt(clock.timers[0]!, startMs - 1_000);
    assertTimeout(deadline.signal);
    assert.equal(clock.timers.length, 1, "an initially due callback must not rearm");
  });
}

test("work reserve and hard deadline remain independent across long timer segments", (context) => {
  const clock = fakeClock(context);
  const deadlineAtMs = startMs + thirtyDaysMs;
  const reserveMs = 15_000;
  // Match runCommand's two existing helper calls without loading the CLI/runtime.
  const hard = createRunDeadlineSignal(deadlineAtMs);
  const work = createRunDeadlineSignal(deadlineAtMs - reserveMs, 0);
  context.after(() => { hard.dispose(); work.dispose(); });
  clock.advanceTo(startMs + 1);
  assert.equal(work.signal.aborted, false);
  assert.equal(hard.signal.aborted, false);
  clock.advanceTo(startMs + maxTimeoutMs);
  assert.equal(work.signal.aborted, false);
  assert.equal(hard.signal.aborted, false);
  clock.advanceTo(deadlineAtMs - reserveMs);
  assertTimeout(work.signal);
  assert.equal(hard.signal.aborted, false);
  clock.advanceTo(deadlineAtMs - 1_001);
  assert.equal(hard.signal.aborted, false);
  clock.advanceTo(deadlineAtMs - 1_000);
  assertTimeout(hard.signal);
  assert.equal(clock.pending().length, 0);
});

for (const late of [false, true]) {
  test(`long-deadline callback rechecks absolute time when ${late ? "late" : "the clock moves back"}`, (context) => {
    const clock = fakeClock(context);
    const stopAtMs = startMs + thirtyDaysMs;
    const deadline = createRunDeadlineSignal(stopAtMs, 0);
    context.after(() => deadline.dispose());
    const callbackAtMs = late ? stopAtMs + 5_000 : startMs + maxTimeoutMs - 1_000;
    clock.fireAt(clock.timers[0]!, callbackAtMs);
    assert.equal(deadline.signal.aborted, late);
    if (late) {
      assertTimeout(deadline.signal);
      assert.equal(clock.timers.length, 1, "late callback must not rearm");
    } else {
      assert.equal(clock.timers[1]?.delayMs, stopAtMs - callbackAtMs);
      clock.advanceTo(stopAtMs);
      assertTimeout(deadline.signal);
    }
    assert.equal(clock.pending().length, 0);
  });
}

for (const rearmed of [false, true]) {
  test(`dispose cancels ${rearmed ? "a rearmed" : "the initial"} timer and ignores an already queued callback`, (context) => {
    const clock = fakeClock(context);
    const stopAtMs = startMs + thirtyDaysMs;
    const deadline = createRunDeadlineSignal(stopAtMs, 0);
    context.after(() => deadline.dispose());
    if (rearmed) clock.advanceTo(startMs + maxTimeoutMs);
    const current = clock.timers.at(-1)!;
    const timerCount = clock.timers.length;
    deadline.dispose();
    deadline.dispose();
    assert.equal(current.cancelled, true);
    assert.equal(clock.pending().length, 0);
    // A callback already queued before clearTimeout must neither rearm nor abort.
    clock.fireAt(current, stopAtMs - 1);
    clock.fireAt(current, stopAtMs + 1);
    assert.equal(deadline.signal.aborted, false);
    assert.equal(clock.timers.length, timerCount);
  });
}

function assertTimeout(signal: AbortSignal): void {
  assert.equal(signal.aborted, true);
  assert.ok(signal.reason instanceof DOMException);
  assert.equal(signal.reason.name, "TimeoutError");
  assert.equal(signal.reason.message, "Run stopped at the external deadline boundary.");
}

interface RecordedTimer {
  callback(): void;
  delayMs: number;
  effectiveMs: number;
  dueAtMs: number;
  cancelled: boolean;
  fired: boolean;
  unrefCalls: number;
  unref(): RecordedTimer;
}

function fakeClock(context: TestContext) {
  let nowMs = startMs;
  const timers: RecordedTimer[] = [];
  context.mock.method(Date, "now", () => nowMs);
  context.mock.method(globalThis, "setTimeout", (callback: () => void, delayMs = 1) => {
    // Node 22 clamps delays outside [1, 2^31-1] to 1 ms. No native timer runs.
    const effectiveMs = delayMs >= 1 && delayMs <= maxTimeoutMs ? Math.trunc(delayMs) : 1;
    const timer: RecordedTimer = {
      callback, delayMs, effectiveMs, dueAtMs: nowMs + effectiveMs,
      cancelled: false, fired: false, unrefCalls: 0,
      unref() { this.unrefCalls += 1; return this; }
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  });
  context.mock.method(globalThis, "clearTimeout", (timer: unknown) => {
    const recorded = timers.find((candidate) => candidate === timer);
    assert.ok(recorded, "only the helper's recorded timers may be cleared");
    recorded.cancelled = true;
  });
  const pending = () => timers.filter((timer) => !timer.cancelled && !timer.fired);
  function fireAt(timer: RecordedTimer, timeMs: number): void {
    nowMs = timeMs;
    timer.fired = true;
    timer.callback();
  }
  function advanceTo(timeMs: number): void {
    assert.ok(timeMs >= nowMs);
    nowMs = timeMs;
    for (const timer of pending()) {
      if (timer.dueAtMs <= nowMs) fireAt(timer, nowMs);
    }
  }
  return { timers, pending, fireAt, advanceTo, now: () => nowMs };
}
