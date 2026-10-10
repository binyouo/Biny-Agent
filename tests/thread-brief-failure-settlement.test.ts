/** 报告失败仍结算当前摘要请求；存储和生成均为内存替身，不启动模型或数据库。 */
import assert from "node:assert/strict";
import { ThreadBriefService } from "../src/session/threadBriefService.js";
import type { ThreadBriefStore } from "../src/session/threadBriefStore.js";

type Internals = {
  generate(sessionId: string, manual: boolean, signal: AbortSignal): Promise<void>;
  draining?: Promise<void>;
  controller?: AbortController;
};
type Outcome = { status: "pending" | "fulfilled" | "rejected"; error?: unknown };
function observe(promise: Promise<void>): Outcome {
  const outcome: Outcome = { status: "pending" };
  void promise.then(() => { outcome.status = "fulfilled"; }, (error: unknown) => { outcome.status = "rejected"; outcome.error = error; });
  return outcome;
}
function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const failures: string[] = [];
for (const mode of ["store", "change", "clock", "stringify", "normal", "abort", "close"] as const) {
  const primary: unknown = mode === "stringify" ? { toString() { throw secondary; } } : new Error("generation failed");
  const secondary = new Error("reporting failed");
  const gate = deferred();
  const generated: string[] = [];
  let reports = 0;
  let changes = 0;
  let closed = 0;
  const store = {
    setError() { reports += 1; if (mode === "store") throw secondary; },
    close() { closed += 1; }
  } as unknown as ThreadBriefStore;
  const service = new ThreadBriefService({
    store,
    readThread: async () => undefined,
    getModel: async () => undefined,
    now: () => { if (mode === "clock") throw secondary; return new Date("2026-10-10T00:00:00Z"); },
    onChange: () => { changes += 1; if (mode === "change") throw secondary; }
  });
  const internals = service as unknown as Internals;
  internals.generate = async (id, _manual, signal) => {
    generated.push(id);
    if (id === "A") {
      await gate.promise;
      if (mode === "close") signal.throwIfAborted();
      throw primary;
    }
  };
  const first = observe(service.enqueue("A", true));
  // Attach immediately: a broken baseline must not create an unhandled rejection in this fixture.
  const drainPromise = internals.draining!;
  const drain = observe(drainPromise);
  const secondPromise = service.enqueue("B", true);
  const second = observe(secondPromise);
  if (mode === "abort") internals.controller!.abort(primary);
  const closing = mode === "close" ? service.close() : undefined;
  if (closing) observe(closing);
  gate.release();
  if (mode === "close") await closing;
  else await secondPromise;
  // B's completion proves queue progress; no timers or waiting on a potentially orphaned A.
  await drainPromise.catch(() => undefined);
  await Promise.resolve();
  if (mode !== "close") await service.close();
  try {
    assert.equal(first.status, "rejected", `${mode}: A must settle`);
    assert.equal(drain.status, "fulfilled", `${mode}: reporting failure must not reject the internal drain`);
    assert.equal(closed, 1, `${mode}: close must reach the store`);
    if (mode === "close") {
      assert.equal(second.status, "rejected");
      assert.match(String(first.error), /摘要服务已关闭/u);
      assert.match(String(second.error), /摘要服务已关闭/u);
      assert.deepEqual(generated, ["A"]);
    } else {
      assert.equal(second.status, "fulfilled");
      assert.deepEqual(generated, ["A", "B"]);
    }
    if (["store", "change", "clock", "stringify"].includes(mode)) {
      assert.ok(first.error instanceof AggregateError);
      assert.deepEqual(first.error.errors, [primary, secondary]);
      assert.equal(first.error.cause, primary);
      assert.equal(first.error.message, "摘要生成失败，且未能报告错误。");
    } else if (mode !== "close") assert.equal(first.error, primary, `${mode}: preserve the original rejection identity`);
    assert.equal(reports, ["abort", "close", "clock", "stringify"].includes(mode) ? 0 : 1);
    assert.equal(changes, ["normal", "change"].includes(mode) ? 1 : 0);
    console.log(`PASS ${mode}`);
  } catch (error) {
    failures.push(`${mode}: ${String(error)}; A=${first.status}; drain=${drain.status}; B=${second.status}; closed=${closed}`);
  }
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log("thread brief failure settlement tests passed");
