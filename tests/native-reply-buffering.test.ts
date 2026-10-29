/** Fixed AST selections only: no native driver import, socket, process, or real cleanup. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("nativeDriver.ts", readFileSync(
  new URL("../src/computer/nativeDriver.ts", import.meta.url), "utf8"
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const classes = source.statements.filter(ts.isClassDeclaration);
const driver = classes.find(node => node.name?.text === "NativeProcessDriver");
assert.ok(driver);
const methodNames = ["onData", "onReply", "call", "failHost", "isExpectedIdle", "failAndRetire", "detach", "stop", "stopHost"];
const methods = methodNames.map(name => {
  const matches = driver.members.filter(ts.isMethodDeclaration).filter(node => node.name.getText(source) === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!.getText(source);
});
const errors = classes.filter(node => node.name?.text === "NativeCommandError");
assert.equal(errors.length, 1);
const emitted = ts.transpileModule(`${errors[0]!.getText(source)}\nclass Receiver {\n${methods.join("\n")}\n}\nglobalThis.receiver = new Receiver();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b/.test(emitted.outputText), false);
const receiverScript = new Script(emitted.outputText);
const cap = 2 * 1024 * 1024;

interface Counts { copied: number; scanned: number; allocations: number; maxCapacity: number }
class MeasuredBuffer {
  readonly bytes: Buffer;
  readonly counts: Counts;
  constructor(bytes: Buffer, counts: Counts) { this.bytes = bytes; this.counts = counts; }
  get length(): number { return this.bytes.length; }
  subarray(start?: number, end?: number): MeasuredBuffer { return new MeasuredBuffer(this.bytes.subarray(start, end), this.counts); }
  copy(target: MeasuredBuffer, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const copied = this.bytes.copy(target.bytes, targetStart, sourceStart, sourceEnd);
    this.counts.copied += copied;
    return copied;
  }
  indexOf(value: number, offset = 0): number {
    const result = this.bytes.indexOf(value, offset);
    this.counts.scanned += Math.max(0, (result < 0 ? this.length : result + 1) - offset);
    return result;
  }
}
interface Host {
  buffer: MeasuredBuffer; bufferStart: number; bufferEnd: number; bufferScan: number; bufferOverflowed: boolean;
  closed: boolean; connected: boolean; lastActivityAt: number; socket: { write(value: string): void; destroy(): void };
  decoder: { write(value: MeasuredBuffer): string };
}
interface Reply { data: unknown; images: unknown[] }
interface Job { timer: number; cleanup(): void; resolve(value: Reply): void; reject(error: Error): void }
interface Receiver {
  host?: Host; idleTimeout: number; pending: Map<string, Job>; eventListeners: Set<(name: string, data: unknown) => void>;
  onReply(line: string): void; shape(value: unknown): Reply; armIdle(): void;
  failAndRetire(host: Host, reason: string): void;
  assertLive(): void; ensureHost(): Promise<void>;
}

function fixture() {
  const counts: Counts = { copied: 0, scanned: 0, allocations: 0, maxCapacity: 0 };
  const allocated = (length: number): MeasuredBuffer => {
    counts.allocations++;
    counts.maxCapacity = Math.max(counts.maxCapacity, length);
    return new MeasuredBuffer(Buffer.alloc(length), counts);
  };
  const buffers = Object.freeze({
    alloc: allocated, allocUnsafeSlow: allocated,
    concat(parts: MeasuredBuffer[]): MeasuredBuffer {
      const result = allocated(parts.reduce((total, part) => total + part.length, 0));
      let offset = 0;
      for (const part of parts) offset += part.copy(result, offset);
      return result;
    }
  });
  const timers = new Map<number, () => void>();
  const cleared: number[] = [], deleted: string[] = [], writes: string[] = [], lines: string[] = [], failures: string[] = [];
  let timerId = 0, requestId = 0, destroyed = 0, idle = 0;
  let onWrite: (() => void) | undefined;
  const context = createContext({
    Buffer: buffers, maxIpcBytes: cap, maxPending: 32,
    screenshotCommands: new Set(["get_app_state"]), screenshotTimeoutMs: 30_000, requestTimeoutMs: 20_000, shutdownTimeoutMs: 2_000,
    crypto: Object.freeze({ randomUUID: () => `request-${++requestId}` }),
    performance: Object.freeze({ now: () => 0 }),
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => { cleared.push(id); timers.delete(id); },
    rmSync: (name: string, options: { force: boolean }) => { assert.deepEqual(options.force, true); deleted.push(name); }
  }, { codeGeneration: { strings: false, wasm: false } });
  receiverScript.runInContext(context, { timeout: 1000 });
  const receiver = context.receiver as Receiver;
  const decoder = new StringDecoder("utf8");
  const host: Host = {
    buffer: new MeasuredBuffer(Buffer.alloc(0), counts), bufferStart: 0, bufferEnd: 0, bufferScan: 0, bufferOverflowed: false,
    closed: false, connected: true, lastActivityAt: 0,
    socket: { write: value => { writes.push(value); onWrite?.(); }, destroy: () => { destroyed++; } },
    decoder: { write: value => decoder.write(value.bytes) }
  };
  receiver.host = host;
  receiver.idleTimeout = 900_000;
  receiver.pending = new Map();
  receiver.eventListeners = new Set();
  receiver.shape = data => ({ data, images: [] });
  receiver.armIdle = () => { idle++; };
  receiver.assertLive = () => undefined;
  receiver.ensureHost = async () => undefined;
  const actualReply = receiver.onReply.bind(receiver);
  receiver.onReply = line => { lines.push(line); actualReply(line); };
  const actualFailure = receiver.failAndRetire.bind(receiver);
  receiver.failAndRetire = (target, reason) => { failures.push(reason); actualFailure(target, reason); };
  context.host = host;
  function invoke(expression: string): unknown {
    return new Script(expression).runInContext(context, { timeout: 10_000 });
  }
  function feed(chunks: Buffer[]): void {
    context.chunks = chunks.map(bytes => new MeasuredBuffer(bytes, counts));
    invoke("for (const chunk of chunks) receiver.onData(host, chunk);");
  }
  function job(id: string) {
    const results: Reply[] = [], errors: Error[] = [];
    let cleanup = 0;
    receiver.pending.set(id, { timer: ++timerId, cleanup: () => { cleanup++; }, resolve: value => { results.push(value); }, reject: error => { errors.push(error); } });
    return { results, errors, get cleanup() { return cleanup; } };
  }
  async function request(signal?: AbortSignal): Promise<{ id: string; result: Promise<unknown> }> {
    context.signal = signal;
    const written = new Promise<void>(resolve => { onWrite = resolve; });
    const result = Promise.resolve(invoke('receiver.call("list_apps", {}, signal)')).then(value => value, error => error);
    try {
      await Promise.race([written, result.then(value => {
        throw new Error(`Inert call settled before socket.write: ${String(value && typeof value === "object" && "message" in value ? value.message : value)}`);
      })]);
    } finally { onWrite = undefined; }
    const id = (JSON.parse(writes.at(-1)!) as { id: string }).id;
    return { id, result };
  }
  return { host, receiver, counts, timers, cleared, deleted, writes, lines, failures, feed, job, request, invoke,
    get destroyed() { return destroyed; }, get idle() { return idle; } };
}
function frame(id: string, data: unknown): Buffer { return Buffer.from(JSON.stringify({ id, ok: true, data }) + "\n"); }

test("large legal AX text frames use linear copy and scan work across chunk sizes", () => {
  const size = 1024 * 1024;
  const empty = frame("large", { elements: [{ role: "AXTextArea", value: "" }] });
  const value = "x".repeat(size - empty.length);
  const bytes = frame("large", { elements: [{ role: "AXTextArea", value }] });
  assert.equal(bytes.length, size);
  for (const chunkSize of [16 * 1024, 1024, 65_537]) {
    const f = fixture(), result = f.job("large");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) chunks.push(bytes.subarray(offset, offset + chunkSize));
    f.feed(chunks);
    assert.equal(JSON.stringify(result.results[0]?.data), JSON.stringify({ elements: [{ role: "AXTextArea", value }] }));
    assert.equal(result.cleanup, 1);
    console.log(JSON.stringify({ size, chunkSize, ...f.counts }));
    assert.ok(f.counts.copied <= 4 * bytes.length, `repeated prefix copies: ${f.counts.copied}`);
    assert.ok(f.counts.scanned <= bytes.length, `repeated prefix scans: ${f.counts.scanned}`);
    assert.ok(f.counts.maxCapacity <= cap);
  }
});

test("one-byte chunks do not create per-chunk retained metadata or allocations", () => {
  const f = fixture(), bytes = frame("small", "x".repeat(32_000));
  f.job("small");
  f.feed(Array.from(bytes, byte => Buffer.from([byte])));
  assert.ok(f.counts.allocations <= 8, `allocations grew with chunks: ${f.counts.allocations}`);
  assert.ok(f.counts.copied <= 4 * bytes.length);
  assert.ok(f.counts.scanned <= bytes.length);
});

test("UTF-8 split at every byte, multiple frames, empty frames and partial suffix retain order", () => {
  const bytes = Buffer.concat([Buffer.from("\n"), frame("a", "中文😀"), frame("b", "fin")]);
  for (let split = 0; split <= bytes.length; split++) {
    const f = fixture(), a = f.job("a"), b = f.job("b");
    f.feed([bytes.subarray(0, split), Buffer.alloc(0), bytes.subarray(split)]);
    assert.equal(a.results[0]?.data, "中文😀");
    assert.equal(b.results[0]?.data, "fin");
    assert.equal(f.lines.length, 2);
  }
  const f = fixture(), a = f.job("a"), b = f.job("b");
  f.feed([Buffer.concat([frame("a", 1), frame("b", 2).subarray(0, 10)])]);
  assert.equal(a.results.length, 1); assert.equal(b.results.length, 0);
  f.feed([frame("b", 2).subarray(10)]);
  assert.equal(b.results[0]?.data, 2);
});

test("the shared decoder preserves existing malformed UTF-8 behavior across LF frames", () => {
  const f = fixture();
  f.feed([Buffer.from([0xe4, 10]), Buffer.from([0xb8, 0xad, 10])]);
  assert.deepEqual(f.lines, ["中"], "decoder.write receives complete frames without LF, even for malformed input");
  assert.equal(f.host.closed, false, "invalid JSON is ignored, not a transport failure");
});

test("aggregate cap rejects the entire incoming chunk before dispatching an early frame", () => {
  const f = fixture(), first = f.job("a");
  f.feed([Buffer.from(" ".repeat(cap - 10))]);
  f.feed([Buffer.concat([frame("a", 1), Buffer.alloc(20, 32)])]);
  assert.equal(first.results.length, 0); assert.equal(first.errors.length, 1);
  assert.match(first.errors[0]!.message, /driver_ipc_budget_exceeded/);
  assert.deepEqual(f.lines, []); assert.equal(f.receiver.host, undefined);
  f.feed([frame("a", 2), Buffer.alloc(0)]);
  assert.deepEqual(f.lines, [], "an already-overflowed connection must never resume dispatch");
  assert.deepEqual(f.failures, Array(3).fill("driver_ipc_budget_exceeded"));
  const exact = fixture(), result = exact.job("a");
  const reply = frame("a", 1);
  exact.feed([Buffer.concat([Buffer.alloc(cap - reply.length, 32), reply])]);
  assert.equal(result.results[0]?.data, 1);
  const needsLf = fixture();
  needsLf.feed([Buffer.alloc(cap, 32), Buffer.from("\n")]);
  assert.deepEqual(needsLf.lines, []);
  assert.equal(needsLf.failures.length, 1, "LF is part of the aggregate budget");
});

test("consumption precedes callbacks and a thrown callback leaves subsequent frames available", () => {
  const f = fixture(), a = f.job("a"), b = f.job("b");
  const actual = f.receiver.onReply;
  let once = true;
  f.receiver.onReply = line => { actual(line); if (once) { once = false; throw new Error("listener failure"); } };
  assert.throws(() => f.feed([Buffer.concat([frame("a", 1), frame("b", 2)])]), /listener failure/);
  assert.equal(a.results.length, 1); assert.equal(b.results.length, 0);
  f.feed([Buffer.alloc(0)]);
  assert.equal(a.results.length, 1); assert.equal(b.results[0]?.data, 2);
});

test("capacity reuse never scans stale bytes outside the active payload", () => {
  const f = fixture(), a = f.job("a"), b = f.job("b");
  const reply = frame("a", "x".repeat(5000));
  f.feed([reply.subarray(0, 4000), Buffer.concat([reply.subarray(4000), frame("b", 2).subarray(0, 5)])]);
  assert.equal(a.results.length, 1); assert.equal(b.results.length, 0);
  f.feed([frame("b", 2).subarray(5)]);
  assert.equal(b.results[0]?.data, 2);
  assert.equal(f.lines.length, 2);
});

test("nonzero consumed prefixes survive both in-place compaction and geometric growth", () => {
  for (const addition of [600, 1800]) {
    const f = fixture();
    f.feed([Buffer.from("a".repeat(599) + "\n" + "b".repeat(400))]);
    f.feed([Buffer.from("b".repeat(addition)), Buffer.from("\n")]);
    assert.deepEqual(f.lines, ["a".repeat(599), "b".repeat(400 + addition)]);
    assert.equal(f.host.closed, false);
  }
});

test("synchronous reply reentry retains all already-received frames before new data", () => {
  const f = fixture(), a = f.job("a"), b = f.job("b"), c = f.job("c");
  const actual = f.receiver.onReply;
  let once = true;
  f.receiver.onReply = line => {
    actual(line);
    if (once) { once = false; f.feed([frame("c", 3)]); }
  };
  f.feed([Buffer.concat([frame("a", 1), frame("b", 2)])]);
  assert.deepEqual([a.results[0]?.data, b.results[0]?.data, c.results[0]?.data], [1, 2, 3]);
  assert.deepEqual(f.lines.map(line => (JSON.parse(line) as { id: string }).id), ["a", "b", "c"]);
});

test("timeout and cancellation keep partial frames for late-reply cleanup without real I/O", async () => {
  for (const reason of ["timeout", "cancel"]) {
    const f = fixture(), controller = new AbortController();
    const request = await f.request(controller.signal);
    const bytes = frame(request.id, { screenshot: "inert-late-image.jpg" });
    f.feed([bytes.subarray(0, 12)]);
    if (reason === "cancel") controller.abort();
    else { const callback = f.timers.values().next().value; assert.ok(callback); callback(); }
    const error = await request.result;
    assert.ok(error && typeof error === "object" && "message" in error);
    assert.match(String(error.message), reason === "cancel" ? /driver_request_aborted/ : /driver_request_timeout/);
    f.feed([bytes.subarray(12)]);
    assert.deepEqual(f.deleted, ["inert-late-image.jpg"]);
    assert.equal(f.receiver.pending.size, 0);
  }
});

test("error replies, invalid JSON, event delivery, stop and detach keep existing cleanup semantics", async () => {
  const f = fixture(), failed = f.job("bad"), events: string[] = [];
  f.receiver.eventListeners.add(name => { events.push(name); });
  f.feed([Buffer.from('not-json\n{"event":"notice","data":1}\n{"id":"bad","ok":false,"error":{"code":"denied"}}\n')]);
  assert.deepEqual(events, ["notice"]); assert.equal(failed.cleanup, 1);
  assert.equal(failed.errors[0]?.message, "denied"); assert.equal(f.host.closed, false);
  for (const method of ["stop", "detach"]) {
    const next = fixture(), pending = next.job("pending");
    next.feed([Buffer.from('{"id":"pending"')]);
    await next.invoke(`receiver.${method}()`);
    assert.equal(next.destroyed, 1); assert.equal(next.host.closed, true);
    assert.equal(pending.cleanup, 1); assert.equal(pending.errors.length, 1);
    assert.equal(next.receiver.pending.size, 0);
  }
});
