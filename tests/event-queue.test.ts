import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { EventQueue } from "../src/agent/core/EventQueue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

for (const rejected of [false, true]) {
  test(`queued events take priority over already ${rejected ? "rejected" : "fulfilled"} pending`, async () => {
    const queue = new EventQueue<string>();
    const pending = rejected ? Promise.reject(new Error("fixture")) : Promise.resolve("value");
    void pending.catch(() => undefined);
    queue.push("first", "second");
    assert.equal(await queue.waitForEventOr(pending), undefined);
    assert.deepEqual(queue.drain(), ["first", "second"]);
    assert.deepEqual(queue.drain(), []);
  });
}

test("already fulfilled pending wins when push follows wait registration", async () => {
  const queue = new EventQueue<string>();
  const waiting = queue.waitForEventOr(Promise.resolve("value"));
  queue.push("event");
  assert.equal(await waiting, "value");
  assert.deepEqual(queue.drain(), ["event"]);
});

for (const rejected of [false, true]) {
  for (const order of ["push-first", "pending-first", "push-microtask-first"] as const) {
    test(`${order} preserves ${rejected ? "rejection" : "fulfillment"} race timing`, async () => {
      const queue = new EventQueue<string>();
      const pending = deferred<string>();
      const reason = new Error("fixture");
      const waiting = queue.waitForEventOr(pending.promise);
      const checked = rejected && order !== "push-microtask-first"
        ? assert.rejects(waiting, (error: unknown) => error === reason)
        : assert.doesNotReject(async () => {
            assert.equal(await waiting, order === "push-microtask-first" ? undefined : "value");
          });
      const settle = () => { if (rejected) pending.reject(reason); else pending.resolve("value"); };
      if (order === "pending-first") {
        settle();
        queue.push("event");
      } else {
        queue.push("event");
        if (order === "push-microtask-first") await Promise.resolve();
        settle();
      }
      await checked;
      assert.deepEqual(queue.drain(), ["event"]);
    });
  }
}

test("multiple waiters wake but only the first drain consumes the FIFO", async () => {
  const queue = new EventQueue<string>();
  const pending = deferred<string>();
  const first = queue.waitForEventOr(pending.promise);
  const second = queue.waitForEventOr(pending.promise);
  queue.push("first", "second");
  assert.equal(await first, undefined);
  assert.deepEqual(queue.drain(), ["first", "second"]);
  assert.equal(await second, undefined);
  assert.deepEqual(queue.drain(), []);
  pending.resolve("done");
});

test("multiple waiters receive the same pending value by identity", async () => {
  const queue = new EventQueue<string>();
  const pending = deferred<object>();
  const value = {};
  const first = queue.waitForEventOr(pending.promise);
  const second = queue.waitForEventOr(pending.promise);
  pending.resolve(value);
  assert.equal(await first, value);
  assert.equal(await second, value);
});

test("undefined pending values retain their existing wake-shaped result", async () => {
  const queue = new EventQueue<string>();
  assert.equal(await queue.waitForEventOr(Promise.resolve(undefined)), undefined);
});

test("normal consumer drains callbacks before handling a terminal iterator result", async () => {
  const queue = new EventQueue<string>();
  const pending = deferred<IteratorResult<string>>();
  const order: string[] = [];
  const consumer = (async () => {
    const next = await queue.waitForEventOr(pending.promise);
    order.push(...queue.drain());
    if (next?.done) order.push("terminal");
  })();
  queue.push("callback");
  pending.resolve({ done: true, value: "done" });
  await consumer;
  assert.deepEqual(order, ["callback", "terminal"]);
});

test("pending rejection still skips the normal post-await drain", async () => {
  const queue = new EventQueue<string>();
  const pending = deferred<string>();
  const order: string[] = [];
  const consumer = (async () => {
    try {
      await queue.waitForEventOr(pending.promise);
      order.push(...queue.drain());
    } catch { order.push("catch"); }
  })();
  queue.push("callback");
  pending.reject(new Error("fixture"));
  await consumer;
  assert.deepEqual(order, ["catch"]);
  assert.deepEqual(queue.drain(), ["callback"]);
});

for (const rejected of [false, true]) {
  test(`retiring one ${rejected ? "rejected" : "fulfilled"} waiter does not orphan another`, async () => {
    const queue = new EventQueue<string>();
    const firstPending = deferred<string>();
    const secondPending = deferred<string>();
    const first = queue.waitForEventOr(firstPending.promise);
    const second = queue.waitForEventOr(secondPending.promise);
    if (rejected) {
      const checked = assert.rejects(first, /fixture/u);
      firstPending.reject(new Error("fixture"));
      await checked;
    } else {
      firstPending.resolve("first");
      assert.equal(await first, "first");
    }
    queue.push("second");
    assert.equal(await second, undefined);
    assert.deepEqual(queue.drain(), ["second"]);
    secondPending.resolve("done");
  });
}

test("old-generation cleanup cannot replace a push-created wake with a new waiter", async () => {
  const queue = new EventQueue<string>();
  const firstPending = deferred<string>();
  const secondPending = deferred<string>();
  const first = queue.waitForEventOr(firstPending.promise);
  queue.push("first");
  assert.deepEqual(queue.drain(), ["first"]);
  const second = queue.waitForEventOr(secondPending.promise);
  assert.equal(await first, undefined);
  queue.push("second");
  assert.equal(await second, undefined);
  assert.deepEqual(queue.drain(), ["second"]);
  firstPending.resolve("done");
  secondPending.resolve("done");
});

for (const rejected of [false, true]) {
  test(`reusing a ${rejected ? "rejected" : "fulfilled"} promise preserves values and timing`, async () => {
    const queue = new EventQueue<string>();
    const value = { fixture: true };
    const pending = rejected ? Promise.reject(value) : Promise.resolve(value);
    for (let index = 0; index < 20; index += 1) {
      const waiting = queue.waitForEventOr(pending);
      const checked = rejected ? assert.rejects(waiting, (reason: unknown) => reason === value) : waiting;
      queue.push(String(index));
      if (rejected) await checked;
      else assert.equal(await checked, value);
      assert.deepEqual(queue.drain(), [String(index)]);
    }
  });
}

test("late losing pending rejections remain observed after event delivery", async () => {
  const queue = new EventQueue<string>();
  const pending = deferred<string>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const waiting = queue.waitForEventOr(pending.promise);
    queue.push("event");
    assert.equal(await waiting, undefined);
    assert.deepEqual(queue.drain(), ["event"]);
    pending.reject(new Error("late fixture"));
    await nextTurn();
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("different queues sharing pending remain independent", async () => {
  const firstQueue = new EventQueue<string>();
  const secondQueue = new EventQueue<string>();
  const pending = deferred<string>();
  const first = firstQueue.waitForEventOr(pending.promise);
  const second = secondQueue.waitForEventOr(pending.promise);
  firstQueue.push("first");
  assert.equal(await first, undefined);
  assert.deepEqual(firstQueue.drain(), ["first"]);
  pending.resolve("value");
  assert.equal(await second, "value");
  assert.deepEqual(secondQueue.drain(), []);
});

test("empty pushes do not wake a waiter or add payloads", async () => {
  const queue = new EventQueue<string>();
  const pending = deferred<string>();
  const waiting = queue.waitForEventOr(pending.promise);
  queue.push();
  pending.resolve("value");
  assert.equal(await waiting, "value");
  assert.deepEqual(queue.drain(), []);
});


// This narrow white-box contract verifies reachability without GC/timing
// assertions. Accept both main's Promise field and the generation record so the
// same test fails on old lifetime behavior, not merely a representation change.
function currentWakePromise(queue: object): Promise<void> {
  const wake: unknown = Reflect.get(queue, "wake");
  if (wake instanceof Promise) return wake as Promise<void>;
  assert.ok(typeof wake === "object" && wake !== null);
  const promise: unknown = Reflect.get(wake, "promise");
  assert.ok(promise instanceof Promise);
  return promise as Promise<void>;
}

for (const rejected of [false, true]) {
  test(`last quiet ${rejected ? "rejection" : "fulfillment"} drops its unresolved wake`, async () => {
    const queue = new EventQueue<string>();
    const previous = currentWakePromise(queue);
    let woke = false;
    void previous.then(() => { woke = true; });
    if (rejected) {
      await assert.rejects(queue.waitForEventOr(Promise.reject(new Error("fixture"))), /fixture/u);
    } else {
      assert.equal(await queue.waitForEventOr(Promise.resolve("value")), "value");
    }
    assert.notEqual(currentWakePromise(queue), previous,
      "the queue must stop retaining consumed race results through its idle wake");
    await nextTurn();
    assert.equal(woke, false, "retirement drops the old wake without resolving it");
  });
}

test("wake remains reachable for an active waiter and retires after the last leaves", async () => {
  const queue = new EventQueue<string>();
  const firstPending = deferred<string>();
  const secondPending = deferred<string>();
  const previous = currentWakePromise(queue);
  const first = queue.waitForEventOr(firstPending.promise);
  const second = queue.waitForEventOr(secondPending.promise);
  firstPending.resolve("first");
  assert.equal(await first, "first");
  assert.equal(currentWakePromise(queue), previous, "the other waiter still owns this wake");
  secondPending.resolve("second");
  assert.equal(await second, "second");
  assert.notEqual(currentWakePromise(queue), previous, "the final waiter releases the generation");
});
