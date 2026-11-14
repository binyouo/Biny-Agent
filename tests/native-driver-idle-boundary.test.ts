import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { test, type TestContext } from "node:test";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

// Exercise the real driver, substituting only the external transport and clock.
// No native binary, Unix socket listener or macOS permissions are required.
async function fixture(t: TestContext, requestTimeoutMs = 10_000) {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  const idleCallbacks: (() => void)[] = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 100) idleCallbacks.push(() => callback(...args));
    return schedule(callback, delay, ...args);
  });
  const hosts: ReturnType<typeof makeHost>[] = [];
  function makeHost() {
    const writes: { id?: string; cmd: string }[] = [];
    let destroyed = false;
    return {
      socket: {
        writable: true,
        write(frame: string) { writes.push(JSON.parse(frame)); return true; },
        destroy() { destroyed = true; }
      },
      socketPath: "inert", buffer: Buffer.alloc(0), bufferStart: 0, bufferEnd: 0,
      bufferScan: 0, bufferOverflowed: false, closed: false, connected: true,
      stdout: "", decoder: new StringDecoder("utf8"), lastActivityAt: now,
      writes, get destroyed() { return destroyed; }
    };
  }
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: "/inert/native-driver-test", idleTimeoutMs: 100, requestTimeoutMs
  });
  // The private adapter seam is used only to supply a connected transport.
  const internal = driver as unknown as {
    adoptExisting(): Promise<ReturnType<typeof makeHost>>;
    onData(host: ReturnType<typeof makeHost>, chunk: Buffer): void;
  };
  t.mock.method(internal, "adoptExisting", async () => {
    const host = makeHost(); hosts.push(host); return host;
  });
  t.after(async () => { await driver.dispose(); });
  await driver.start();
  const tick = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  const dispatch = async (signal?: AbortSignal) => {
    const host = hosts.at(-1)!;
    const completion = driver.actRaw("type_text", { text: "hello" }, 42, signal)
      .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    // ensureHost admission is async even when the host is already connected.
    await Promise.resolve(); await Promise.resolve();
    const id = host.writes.filter(frame => frame.id).at(-1)!.id!;
    return { completion, id, host };
  };
  const reply = (request: Awaited<ReturnType<typeof dispatch>>, ok = true) => {
    internal.onData(request.host, Buffer.from(JSON.stringify({ id: request.id, ok,
      data: {}, error: { code: "controlled_error", inputNotDispatched: true } }) + "\n"));
  };
  return { driver, hosts, tick, dispatch, reply, idleCallbacks };
}

test("a request dispatched just before idle expiry is not interrupted", async t => {
  const f = await fixture(t);
  f.tick(99);
  const request = await f.dispatch();
  f.tick(1);
  assert.equal(request.host.destroyed, false);
  f.reply(request);
  assert.equal((await request.completion).error, undefined);
});

test("pending work survives multiple idle windows", async t => {
  const f = await fixture(t);
  const request = await f.dispatch();
  for (let i = 0; i < 4; i++) { f.tick(100); assert.equal(request.host.destroyed, false); }
  f.reply(request);
  assert.equal((await request.completion).error, undefined);
});

test("one reply does not make another concurrent request idle", async t => {
  const f = await fixture(t);
  const first = await f.dispatch();
  const second = await f.dispatch();
  f.reply(first);
  assert.equal((await first.completion).error, undefined);
  f.tick(100);
  assert.equal(second.host.destroyed, false);
  f.reply(second);
  assert.equal((await second.completion).error, undefined);
});

for (const settlement of ["error", "abort", "timeout"] as const) {
  test(`${settlement} near the old deadline retains a fresh idle window and eventually retires`, async t => {
    const f = await fixture(t, 20);
    f.tick(99);
    const controller = new AbortController();
    const request = await f.dispatch(controller.signal);
    if (settlement === "error") f.reply(request, false);
    if (settlement === "abort") controller.abort();
    if (settlement === "timeout") f.tick(20);
    const result = await request.completion;
    if (settlement === "error") assert.equal(result.value?.errorCode, "controlled_error");
    else assert.ok(result.error);
    if (settlement !== "timeout") f.tick(1);
    assert.equal(request.host.destroyed, false);
    f.tick(100);
    assert.equal(request.host.destroyed, true);
  });
}

test("a genuinely idle host is retired", async t => {
  const f = await fixture(t);
  f.tick(100);
  assert.equal(f.hosts[0]!.destroyed, true);
});

test("successful completion starts a new idle window", async t => {
  const f = await fixture(t);
  const request = await f.dispatch();
  f.tick(80);
  f.reply(request);
  await request.completion;
  f.tick(99);
  assert.equal(request.host.destroyed, false);
  f.tick(1);
  assert.equal(request.host.destroyed, true);
});

for (const method of ["stop", "dispose"] as const) {
  test(`${method} still interrupts pending work immediately`, async t => {
    const f = await fixture(t);
    const request = await f.dispatch();
    await f.driver[method]();
    assert.equal(request.host.destroyed, true);
    assert.match(String((await request.completion).error), /driver_stopped/u);
  });
}

test("an old host deadline does not retire a replacement host", async t => {
  const f = await fixture(t);
  f.tick(80);
  await f.driver.stop();
  await f.driver.start();
  // Simulate an already queued callback even though stop cancelled its timer.
  f.idleCallbacks[0]!();
  f.tick(20);
  assert.equal(f.hosts[1]!.destroyed, false);
  f.tick(80);
  assert.equal(f.hosts[1]!.destroyed, true);
});
