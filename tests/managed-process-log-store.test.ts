import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ManagedProcessLogStore } from "../src/runtime/managedProcessLogStore.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-log-store-"));
  const store = new ManagedProcessLogStore(path.join(root, "logs"), {
    segmentBytes: 4, processBytes: 12, pendingBytes: 8, totalBytes: 16, completedLogs: 1
  });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, create: (dispose = () => {}) => store.create(randomUUID(), dispose) };
}

test("slow disk drops bounded pending output, keeps draining, and cursors expose interior gaps", async t => {
  const f = await fixture(t);
  const log = await f.create();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const realOpen = fs.open;
  let gated = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]).endsWith(".seg")) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", async (...parameters: Parameters<typeof handle.write>) => {
        if (!gated) { gated = true; entered.resolve(); await release.promise; }
        return write(...parameters);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    log.accept(Buffer.from("AAAA"));
    await entered.promise;
    for (const chunk of ["BBBB", "CCCC", "DDDD", "EEEE"]) log.accept(Buffer.from(chunk));
    const controller = new AbortController();
    const reason = new Error("cancel blocked flush");
    const reading = log.read({}, controller.signal);
    controller.abort(reason);
    await assert.rejects(reading, error => error === reason);
    release.resolve();
    await log.finish();
    const first = await log.read();
    assert.equal(first.content, "AAAA"); assert.equal(first.nextOffset, 4); assert.equal(first.hasMore, true);
    const next = await log.read({ offset: 4 });
    assert.deepEqual(next.gap, { startOffset: 4, endOffset: 12 });
    assert.equal(next.content, "DDDDEEEE"); assert.equal(next.nextOffset, 20);
    assert.equal(next.totalBytes, 20); assert.equal(next.droppedBytes, 8);
    assert.equal(await log.tail(), "DDDDEEEE", "readiness uses the latest contiguous tail after a gap");
  } finally { release.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("partial disk failure is visible and later capture continues without replaying lost bytes", async t => {
  const f = await fixture(t);
  const log = await f.create();
  const realOpen = fs.open;
  let fail = true;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]).endsWith(".seg")) {
      const write = handle.write.bind(handle);
      let written = false;
      t.mock.method(handle, "write", async (bytes: Buffer, offset: number, length: number, position: number) => {
        if (!fail) return write(bytes, offset, length, position);
        if (written) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        written = true; return write(bytes, offset, 2, position);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    log.accept(Buffer.from("ABCD")); await log.flush(); fail = false;
    log.accept(Buffer.from("EFGH")); await log.finish();
    const first = await log.read();
    assert.equal(first.content, "AB"); assert.equal(first.droppedBytes, 2); assert.match(first.logError!, /disk full/u);
    const next = await log.read({ offset: first.nextOffset });
    assert.deepEqual(next.gap, { startOffset: 2, endOffset: 4 }); assert.equal(next.content, "EFGH");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("shared disk quota evicts oldest segments and completed record quota releases ownership", async t => {
  const f = await fixture(t);
  let disposed = false;
  const first = await f.create(() => { disposed = true; });
  for (const chunk of ["AAAA", "BBBB", "CCCC"]) { first.accept(Buffer.from(chunk)); await first.flush(); }
  const second = await f.create();
  for (const chunk of ["DDDD", "EEEE", "FFFF"]) { second.accept(Buffer.from(chunk)); await second.flush(); }
  const output = await first.read();
  assert.deepEqual(output.gap, { startOffset: 0, endOffset: 8 }); assert.equal(output.content, "CCCC");
  assert.equal((await second.read()).content, "DDDDEEEEFFFF");
  await first.finish(); await second.finish();
  assert.equal(disposed, true);
  await assert.rejects(first.read(), /expired/u);
  assert.equal((await fs.readdir(f.store.root)).length, 1);
});

test("UTF-8 spans segment boundaries and live partial characters stay available for continuation", async t => {
  const f = await fixture(t);
  const log = await f.create();
  log.accept(Buffer.from([0x41, 0xe4, 0xbd])); await log.flush();
  const partial = await log.read({ maxBytes: 2 });
  assert.equal(partial.content, "A"); assert.equal(partial.nextOffset, 1); assert.equal(partial.pendingUtf8Bytes, 2);
  log.accept(Buffer.from([0xa0, 0x42])); await log.finish();
  await assert.rejects(log.read({ offset: 1, maxBytes: 2 }), /too small/u);
  const next = await log.read({ offset: 1, maxBytes: 3 });
  assert.equal(next.content, "你"); assert.equal(next.nextOffset, 4); assert.equal(next.hasMore, true);
  assert.equal((await log.read({ offset: 4 })).content, "B");
});

test("restart expires completed logs and refuses to steal logs with a live owner", async t => {
  const f = await fixture(t);
  const log = await f.create(); log.accept(Buffer.from("AAAA")); await log.flush();
  const competing = new ManagedProcessLogStore(f.store.root);
  await assert.rejects(competing.initialize(), /live process/u); await competing.close();
  await log.finish(); await f.store.close();
  const recovered = new ManagedProcessLogStore(f.store.root, { completedAgeMs: 1 });
  const clock = Date.now(); t.mock.method(Date, "now", () => clock + 1000);
  try { await recovered.initialize(); assert.deepEqual(await fs.readdir(f.store.root), []); }
  finally { await recovered.close(); }
});

test("replaced segments are refused and outside files survive retention cleanup", async t => {
  const f = await fixture(t);
  const log = await f.create(); log.accept(Buffer.from("AAAA")); await log.flush();
  const outside = path.join(f.root, "outside"); await fs.writeFile(outside, "KEEP");
  const segment = log.segments[0]!.binding.path;
  await fs.unlink(segment); await fs.symlink(outside, segment);
  await assert.rejects(log.read(), /changed|symbolic|identity|regular/iu);
  assert.equal(await fs.readFile(outside, "utf8"), "KEEP");
});

test("failed owner marker creation releases its files so the next Host can initialize", async t => {
  const f = await fixture(t);
  const realOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]).endsWith("owner.json")) t.mock.method(handle, "writeFile", async () => { throw new Error("marker disk full"); });
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.create(), /marker disk full/u); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readdir(f.store.root), []);
  const log = await f.create(); log.accept(Buffer.from("SAFE")); await log.finish();
  assert.equal((await log.read()).content, "SAFE");
});

test("lifecycle writes rotate within their budget and refuse symlink targets", async t => {
  const f = await fixture(t);
  await f.store.initialize();
  const filename = path.join(f.root, "lifecycle.jsonl");
  for (const character of ["A", "B", "C"]) await f.store.recordLifecycle(filename, character.repeat(600_000));
  assert.equal((await fs.stat(filename)).size, 600_001);
  assert.equal((await fs.stat(`${filename}.1`)).size, 600_001);
  assert.equal((await fs.readFile(`${filename}.1`, "utf8")).startsWith("B"), true);
  await assert.rejects(f.store.recordLifecycle(filename, "x".repeat(1024 * 1024)), /exceeds/u);
  const outside = path.join(f.root, "outside"); await fs.writeFile(outside, "KEEP");
  await fs.unlink(filename); await fs.symlink(outside, filename);
  await assert.rejects(f.store.recordLifecycle(filename, "must not append"));
  assert.equal(await fs.readFile(outside, "utf8"), "KEEP");
});
