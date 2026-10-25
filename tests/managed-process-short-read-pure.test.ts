/** Actual-source reader with inert byte storage; no process or real log file is opened. */
import assert from "node:assert/strict";
import { Buffer, isUtf8 } from "node:buffer";
import { constants, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

interface Output {
  content: string;
  startOffset: number;
  nextOffset: number;
  totalBytes: number;
  hasMore: boolean;
  omittedBefore: boolean;
  pendingUtf8Bytes?: number;
}
interface ReadOptions { offset?: number; maxBytes?: number; fromEnd?: boolean }
type Reader = (logBinding: typeof binding, options?: ReadOptions, signal?: AbortSignal, context?: { final: boolean }) => Promise<Output>;
const binding = { path: "/inert-managed-short-read", device: 1n, inode: 2n };
const sourcePath = path.join(process.cwd(), "src/runtime/managedProcessLog.ts");
const source = readFileSync(sourcePath, "utf8");
const marker = "export async function readManagedProcessLog(";
assert.equal(source.split(marker).length, 2);
const closure = source.slice(source.indexOf(marker)).replace(marker, "async function readManagedProcessLog(");
assert.doesNotMatch(closure, /\b(?:import|require|process)\s*[.(]/u);
const script = new vm.Script(`${stripTypeScriptTypes(closure, { mode: "strip" })}\nreadManagedProcessLog;`, { filename: sourcePath });

function fixture(initial: string | Buffer, limits: readonly number[] = [], repeatedLimit = Infinity) {
  let bytes = Buffer.from(initial);
  let calls = 0;
  let closes = 0;
  let inode = 2n;
  let descriptorInode = 2n;
  let hook: ((call: number) => void) | undefined;
  const trace: Array<{ position: number; offset: number; length: number; bytesRead: number }> = [];
  const metadata = () => ({ dev: 1n, ino: inode, nlink: 1n, size: BigInt(bytes.length),
    isFile: () => true, isSymbolicLink: () => false });
  const file = {
    stat: async () => ({ ...metadata(), ino: descriptorInode }),
    close: async () => { closes++; },
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const limit = limits[calls] ?? repeatedLimit;
      const bytesRead = bytes.copy(buffer, offset, position, position + Math.min(length, limit));
      trace.push({ position, offset, length, bytesRead });
      calls++;
      hook?.(calls);
      return { bytesRead, buffer };
    }
  };
  const fs = {
    lstat: async (name: string) => { assert.equal(name, binding.path); return metadata(); },
    realpath: async (name: string) => { assert.equal(name, binding.path); return name; },
    open: async (name: string, flags: number) => {
      assert.equal(name, binding.path);
      assert.equal(flags, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      return file;
    }
  };
  const read = script.runInNewContext({ fs, constants, Buffer, isUtf8, Error, RangeError }) as Reader;
  return {
    read: (options: ReadOptions = {}, final = true, signal?: AbortSignal) => read(binding, options, signal, { final }),
    inspect: (next: (call: number) => void) => { hook = next; },
    append: (suffix: Buffer) => { bytes = Buffer.concat([bytes, suffix]); },
    truncate: (size: number) => { bytes = bytes.subarray(0, size); },
    changeIdentity: (descriptor: boolean) => { if (descriptor) descriptorInode++; else inode++; },
    closes: () => closes,
    trace
  };
}

await test("positive initial short reads do not reject an adequate UTF-8 page", async () => {
  const header = "[biny] fixture header\r\n";
  const offset = Buffer.byteLength(header);
  for (const character of ["é", "你", "🙂"]) {
    const content = `${character}é你\r\ntrailing line`;
    for (let firstRead = 1; firstRead < Buffer.byteLength(character); firstRead++) {
      const f = fixture(header + content, [firstRead]);
      const page = await f.read({ offset, maxBytes: 64 });
      assert.equal(page.content, content);
      assert.equal(page.startOffset, offset);
      assert.equal(page.nextOffset, Buffer.byteLength(header + content));
      assert.equal(page.hasMore, false);
      assert.equal(f.closes(), 1);
      assert.deepEqual(f.trace.map(({ position, offset: target }) => [position, target]), [[offset, 0], [offset + firstRead, firstRead]]);
    }
  }
});

await test("repeated one-byte reads fill pages while preserving tail and continuation offsets", async () => {
  const text = "head\r\n🙂é你\r\nlast";
  const f = fixture(text, [], 1);
  let offset = 0;
  let combined = "";
  for (let pages = 0; pages < 20; pages++) {
    const page = await f.read({ offset, maxBytes: 5 });
    assert.ok(page.nextOffset > offset);
    assert.ok(page.nextOffset - offset <= 5);
    combined += page.content;
    offset = page.nextOffset;
    if (!page.hasMore) break;
  }
  assert.equal(combined, text);
  const tail = await fixture(text, [], 1).read({ fromEnd: true, maxBytes: 4 });
  assert.equal(tail.content, "last");
  assert.equal(tail.startOffset, Buffer.byteLength(text) - 4);
  assert.equal(tail.omittedBefore, true);
});

await test("full reads and genuinely undersized capacities retain their existing contract", async () => {
  assert.equal((await fixture("🙂done").read({ maxBytes: 64 })).content, "🙂done");
  for (const maxBytes of [1, 2, 3]) {
    const f = fixture("🙂done", [], 1);
    await assert.rejects(f.read({ maxBytes }), /use at least 4/u);
    assert.equal(f.closes(), 1);
  }
});

await test("short reads remain bounded by the original live snapshot even after an append", async () => {
  const f = fixture(Buffer.from([0x41, 0xf0, 0x9f, 0x99]), [], 1);
  f.inspect(call => { if (call === 1) f.append(Buffer.from([0x82, 0x5a])); });
  const first = await f.read({ maxBytes: 64 }, false);
  assert.equal(first.content, "A");
  assert.equal(first.totalBytes, 4);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.pendingUtf8Bytes, 3);
  assert.equal(first.hasMore, false);
  assert.ok(f.trace.every(({ position, length }) => position + length <= 4));
  const last = await f.read({ offset: first.nextOffset }, true);
  assert.equal(last.content, "🙂Z");
  assert.equal(last.nextOffset, 6);
  assert.equal(f.closes(), 2);
});

await test("final incomplete scalars, malformed bytes and explicit mid-byte offsets are unchanged", async () => {
  for (const bytes of [Buffer.from([0xe4, 0xbd]), Buffer.from([0xff, 0xc0, 0x80])]) {
    const page = await fixture(bytes, [], 1).read();
    assert.equal(page.content, bytes.toString("utf8"));
    assert.equal(page.nextOffset, bytes.length);
  }
  const page = await fixture("🙂", [], 1).read({ offset: 1 });
  assert.equal(page.content, Buffer.from("🙂").subarray(1).toString("utf8"));
  assert.equal(page.nextOffset, 4);
});

await test("zero reads stop immediately without inventing bytes or advancing over an unread suffix", async () => {
  for (const initial of [0, 1]) {
    const f = fixture("ABC", initial === 0 ? [0] : [1, 0]);
    const page = await f.read();
    assert.equal(page.content, initial === 0 ? "" : "A");
    assert.equal(page.nextOffset, initial);
    assert.equal(page.hasMore, true);
    assert.equal(f.trace.length, initial + 1);
    assert.equal(f.closes(), 1);
  }
});

await test("aborting between positive short reads preserves the reason and closes once", async () => {
  const f = fixture("🙂done", [], 1);
  const controller = new AbortController();
  const reason = new Error("cancel inert accumulation");
  f.inspect(call => { if (call === 2) controller.abort(reason); });
  await assert.rejects(f.read({}, true, controller.signal), error => error === reason);
  assert.equal(f.trace.length, 2);
  assert.equal(f.closes(), 1);
});

await test("Unicode partial-then-zero reads retain the existing boundary classification", async () => {
  const complete = fixture("🙂done", [1, 0]);
  await assert.rejects(complete.read(), /use at least 4/u);
  assert.equal(complete.closes(), 1);
  for (const final of [false, true]) {
    const f = fixture(Buffer.from([0xf0, 0x9f]), [1, 0]);
    const page = await f.read({}, final);
    assert.equal(page.content, final ? "�" : "");
    assert.equal(page.nextOffset, final ? 1 : 0);
    assert.equal(page.pendingUtf8Bytes, final ? undefined : 2);
    assert.equal(page.hasMore, final);
    assert.equal(f.closes(), 1);
  }
});

await test("truncation during accumulation preserves existing final and live prefix handling", async () => {
  for (const final of [false, true]) {
    const f = fixture(Buffer.from([0xf0, 0x9f]), [], 1);
    f.inspect(call => { if (call === 1) f.truncate(1); });
    if (final) {
      const page = await f.read({}, true);
      assert.equal(page.content, "�");
      assert.equal(page.nextOffset, 1);
      assert.equal(page.totalBytes, 2);
      assert.equal(page.hasMore, true);
    } else {
      await assert.rejects(f.read({}, false), /changed during boundary inspection/u);
    }
    assert.equal(f.closes(), 1);
    assert.equal(f.trace.length, 2);
  }
  for (const final of [false, true]) {
    const f = fixture("🙂done", [], 1);
    f.inspect(call => { if (call === 1) f.truncate(2); });
    await assert.rejects(f.read({}, final), /changed during boundary inspection/u);
    assert.equal(f.closes(), 1);
  }
});

for (const descriptor of [false, true]) {
  await test(`changed ${descriptor ? "descriptor" : "path"} identity during accumulation still rejects`, async () => {
    const f = fixture("🙂done", [], 1);
    f.inspect(call => { if (call === 2) f.changeIdentity(descriptor); });
    await assert.rejects(f.read(), /original/u);
    assert.equal(f.closes(), 1);
  });
}
