/** Inert log facade only: no files, processes, runtime services or user configuration. */
import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import { mock, test } from "node:test";
import { readManagedProcessLog } from "../src/runtime/managedProcessLog.js";

const binding = { path: "/inert-managed-log", device: 1n, inode: 2n };
function fixture(initial: readonly number[] | Buffer) {
  let bytes = Buffer.from(initial);
  let closes = 0;
  let calls = 0;
  let inode = 2n;
  let descriptorInode = 2n;
  let limit = Infinity;
  let afterRead: ((call: number) => void) | undefined;
  const trace: Array<{ position: number; length: number; bytesRead: number }> = [];
  const metadata = () => ({ dev: 1n, ino: inode, nlink: 1n, size: BigInt(bytes.length),
    isFile: () => true, isSymbolicLink: () => false });
  const handle = {
    stat: async () => ({ ...metadata(), ino: descriptorInode }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = bytes.copy(buffer, offset, position, position + Math.min(length, limit));
      trace.push({ position, length, bytesRead });
      afterRead?.(++calls);
      return { bytesRead, buffer };
    },
    close: async () => { closes++; }
  };
  mock.method(fs, "lstat", async (name: string) => { assert.equal(name, binding.path); return metadata(); });
  mock.method(fs, "realpath", async (name: string) => { assert.equal(name, binding.path); return name; });
  mock.method(fs, "open", async (name: string, flags: number) => {
    assert.equal(name, binding.path);
    assert.equal(flags, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    return handle;
  });
  return {
    read: (options = {}, final = false, signal?: AbortSignal) => readManagedProcessLog(binding, options, signal, { final }),
    append: (suffix: readonly number[] | Buffer) => { bytes = Buffer.concat([bytes, Buffer.from(suffix)]); },
    replace: (value: readonly number[]) => { bytes = Buffer.from(value); },
    inspect: (hook: (call: number) => void) => { afterRead = hook; },
    limit: (value: number) => { limit = value; },
    changeIdentity: (descriptor = false) => { if (descriptor) descriptorInode++; else inode++; },
    closes: () => closes,
    trace
  };
}

await test("live two/three/four-byte prefixes retain the cursor until their suffix arrives", async () => {
  for (const character of ["é", "你", "🙂"]) {
    const encoded = Buffer.from(character);
    for (let split = 1; split < encoded.length; split++) {
      const f = fixture(Buffer.concat([Buffer.from("A"), encoded.subarray(0, split)]));
      try {
        const first = await f.read();
        assert.equal(first.content, "A");
        assert.equal(first.nextOffset, 1);
        assert.equal(first.pendingUtf8Bytes, split);
        assert.equal(first.hasMore, false);
        const idle = await f.read({ offset: first.nextOffset });
        assert.equal(idle.content, "");
        assert.equal(idle.nextOffset, 1);
        assert.equal(idle.hasMore, false);
        assert.equal(idle.pendingUtf8Bytes, split);
        f.append(encoded.subarray(split));
        const next = await f.read({ offset: idle.nextOffset });
        assert.equal(first.content + next.content, `A${character}`);
        assert.equal(next.nextOffset, encoded.length + 1);
        assert.equal(next.pendingUtf8Bytes, undefined);
        assert.equal(next.hasMore, false);
      } finally { mock.restoreAll(); }
    }
  }
});

await test("live prefixes spanning tiny pages peek only to the snapshot and never spin", async () => {
  const f = fixture([0x41, 0xf0, 0x9f, 0x99]);
  try {
    const first = await f.read({ maxBytes: 2 });
    assert.equal(first.content, "A");
    assert.equal(first.nextOffset, 1);
    assert.equal(first.pendingUtf8Bytes, 3);
    assert.equal(first.hasMore, false);
    assert.deepEqual(f.trace, [{ position: 0, length: 2, bytesRead: 2 }, { position: 2, length: 2, bytesRead: 2 }]);
    const tiny = await f.read({ offset: 1, maxBytes: 1 });
    assert.equal(tiny.nextOffset, 1);
    assert.equal(tiny.pendingUtf8Bytes, 3);
    assert.equal(tiny.hasMore, false);
    f.append([0x82]);
    await assert.rejects(f.read({ offset: 1, maxBytes: 1 }), /use at least 4/u);
    assert.equal((await f.read({ offset: 1, maxBytes: 4 })).content, "🙂");
  } finally { mock.restoreAll(); }
});

await test("final or default reads flush incomplete tails, including after an idle live read", async () => {
  for (const prefix of [[0xc2], [0xe4, 0xbd], [0xf0, 0x9f, 0x99]]) {
    const f = fixture(prefix);
    try {
      assert.equal((await f.read()).nextOffset, 0);
      const final = await f.read({}, true);
      assert.equal(final.content, Buffer.from(prefix).toString("utf8"));
      assert.equal(final.nextOffset, prefix.length);
      assert.equal(final.pendingUtf8Bytes, undefined);
      assert.equal(final.hasMore, false);
      assert.deepEqual(await readManagedProcessLog(binding), final);
    } finally { mock.restoreAll(); }
  }
});

await test("a suffix appended after stat is not read or used to finalize the old snapshot", async () => {
  const f = fixture([0x41, 0xe4, 0xbd]);
  try {
    f.inspect((call) => { if (call === 1) f.append([0xa0]); });
    const page = await f.read({ maxBytes: 2 });
    assert.equal(page.content, "A");
    assert.equal(page.totalBytes, 3);
    assert.equal(page.nextOffset, 1);
    assert.equal(page.pendingUtf8Bytes, 2);
    assert.equal(page.hasMore, false);
    assert.ok(f.trace.every(({ position, length }) => position + length <= 3));
    const final = await f.read({ offset: page.nextOffset }, true);
    assert.equal(final.content, "你");
    assert.equal(final.nextOffset, 4);
  } finally { mock.restoreAll(); }
});

await test("invalid prefixes are consumed, including restricted second-byte ranges", async () => {
  for (const prefix of [[0xc0], [0xff], [0x80], [0xe1, 0x41], [0xe0, 0x9f], [0xed, 0xa0], [0xf0, 0x8f], [0xf4, 0x90], [0xf0, 0x90, 0x41]]) {
    const f = fixture(prefix);
    try {
      const page = await f.read({ maxBytes: 1 });
      assert.equal(page.content, Buffer.from(prefix).subarray(0, 1).toString("utf8"));
      assert.equal(page.nextOffset, 1);
      assert.equal(page.pendingUtf8Bytes, undefined);
      assert.equal(page.hasMore, prefix.length > 1);
    } finally { mock.restoreAll(); }
  }
});

await test("complete boundary characters retain pagination and too-small errors", async () => {
  for (const character of ["é", "你", "🙂"]) {
    const f = fixture(Buffer.from(`A${character}Z`));
    try {
      const page = await f.read({ maxBytes: 2 });
      assert.equal(page.content, "A");
      assert.equal(page.nextOffset, 1);
      assert.equal(page.hasMore, true);
      assert.equal(page.pendingUtf8Bytes, undefined);
      await assert.rejects(f.read({ offset: 1, maxBytes: 1 }), /maxBytes.*UTF-8/u);
      assert.equal((await f.read({ offset: 1, maxBytes: Buffer.byteLength(character) })).content, character);
    } finally { mock.restoreAll(); }
  }
});

await test("explicit offsets and tails never retreat to an earlier leading byte", async () => {
  const f = fixture([0x41, 0xe4, 0xbd]);
  try {
    for (const options of [{ offset: 2 }, { fromEnd: true, maxBytes: 1 }]) {
      const page = await f.read(options);
      assert.equal(page.content, "�");
      assert.equal(page.startOffset, 2);
      assert.equal(page.nextOffset, 3);
      assert.equal(page.pendingUtf8Bytes, undefined);
      assert.equal(page.hasMore, false);
    }
    const empty = await f.read({ offset: 100 });
    assert.equal(empty.content, "");
    assert.equal(empty.nextOffset, 3);
    assert.equal(empty.hasMore, false);
  } finally { mock.restoreAll(); }
});

await test("short peeks still prove the prefix through the snapshot tail", async () => {
  const f = fixture([0x41, 0xf0, 0x9f, 0x99]);
  try {
    f.inspect((call) => { if (call === 1) f.limit(1); });
    const page = await f.read({ maxBytes: 2 });
    assert.equal(page.content, "A");
    assert.equal(page.pendingUtf8Bytes, 3);
    assert.equal(page.hasMore, false);
    assert.deepEqual(f.trace.map((read) => read.bytesRead), [2, 1, 1]);
  } finally { mock.restoreAll(); }
});

for (const mutation of ["zero", "truncate", "path", "descriptor", "abort"] as const) {
  await test(`inert ${mutation} during partial inspection rejects and closes`, async () => {
    const f = fixture([0x41, 0xf0, 0x9f, 0x99]);
    const controller = new AbortController();
    const reason = new Error("inert cancellation");
    try {
      f.inspect((call) => {
        if (call === 1 && mutation === "zero") f.limit(0);
        if (call === 1 && mutation === "truncate") f.replace([0x41, 0xf0]);
        if (call === 2 && mutation === "path") f.changeIdentity();
        if (call === 2 && mutation === "descriptor") f.changeIdentity(true);
        if (call === 2 && mutation === "abort") controller.abort(reason);
      });
      await assert.rejects(f.read({ maxBytes: 2 }, false, controller.signal), (error) =>
        mutation === "abort" ? error === reason : error instanceof Error && /retry|original/u.test(error.message));
      assert.equal(f.closes(), 1);
    } finally { mock.restoreAll(); }
  });
}

await test("legal restricted second-byte boundaries remain pending", async () => {
  for (const prefix of [[0xe0, 0xa0], [0xed, 0x9f], [0xf0, 0x90], [0xf4, 0x8f]]) {
    const f = fixture(prefix);
    try {
      const page = await f.read();
      assert.equal(page.content, "");
      assert.equal(page.nextOffset, 0);
      assert.equal(page.pendingUtf8Bytes, 2);
      assert.equal(page.hasMore, false);
    } finally { mock.restoreAll(); }
  }
});
