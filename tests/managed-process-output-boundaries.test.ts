/** Static page boundaries use retained temporary logs; no managed process is launched. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { bindManagedProcessLog, readManagedProcessLog, type ManagedProcessLogBinding } from "../src/runtime/managedProcessLog.js";
import { createBashOutputTool, type BashOutputArgs } from "../src/tools/process/managedProcesses.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-output-boundaries-")));
let count = 0;
async function fixture(content: string | Buffer): Promise<ManagedProcessLogBinding> {
  const logPath = path.join(root, `fixture-${String(++count)}.log`);
  const handle = await fs.open(logPath, "wx+");
  try { await handle.writeFile(content); return await bindManagedProcessLog(logPath, handle); }
  finally { await handle.close(); }
}

function publicReader(binding: ManagedProcessLogBinding) {
  const processId = "00000000-0000-4000-8000-000000000083";
  const service = new ManagedProcessService({ workspaceRoot: root });
  service.outputPath = (id) => { assert.equal(id, processId); return binding.path; };
  service.status = async (id) => {
    assert.equal(id, processId);
    return { processId, pid: 1, command: "retained-log-fixture-never-launched", cwd: root,
      state: "exited", logPath: binding.path, startedAt: "2026-10-05T00:00:00Z", exitCode: 0,
      cleanup: { status: "not_needed" } };
  };
  service.readOutput = async (id, options, signal) => {
    assert.equal(id, processId);
    return { processId, ...await readManagedProcessLog(binding, options, signal) };
  };
  const tool = createBashOutputTool(service);
  return async (args: Omit<BashOutputArgs, "processId"> = {}, signal?: AbortSignal) => {
    const execution = tool.resolveExecution({ processId, ...args });
    assert.ok(!("isError" in execution));
    const result = await execution.execute({ toolCallId: `fixture-${String(++count)}`, signal });
    assert.ok(result.output);
    return result.output;
  };
}

try {
  await test("public BashOutput continuation preserves UTF-8 across its default page boundary", async () => {
    const text = `${"a".repeat(64 * 1024 - 1)}你🙂 tail`;
    const read = publicReader(await fixture(text));
    const first = await read();
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 64 * 1024 - 1);
    assert.equal(Buffer.byteLength(first.content), first.nextOffset);
    const second = await read({ offset: first.nextOffset });
    assert.equal(first.content + second.content === text, true);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextOffset, Buffer.byteLength(text));
  });

  await test("two-, three-, and four-byte characters survive bounded repeated pagination", async () => {
    for (const maxBytes of [4, 5, 6, 7, 8]) {
      for (let prefix = 0; prefix < 9; prefix++) {
        const text = `${"a".repeat(prefix)}é你🙂é你🙂 tail`;
        const read = publicReader(await fixture(text));
        let offset = 0;
        let content = "";
        for (let pages = 0; pages < 30; pages++) {
          const page = await read({ offset, maxBytes });
          assert.equal(page.startOffset, offset);
          assert.ok(page.nextOffset > offset);
          assert.ok(page.nextOffset - offset <= maxBytes);
          assert.ok(Buffer.byteLength(page.content) <= maxBytes);
          assert.doesNotMatch(page.content, /\uFFFD/u);
          content += page.content;
          offset = page.nextOffset;
          if (!page.hasMore) break;
        }
        assert.equal(content, text);
        assert.equal(offset, Buffer.byteLength(text));
      }
    }
  });

  await test("a complete first character too wide for the page yields an actionable error", async () => {
    for (const character of ["é", "你", "🙂"]) {
      const width = Buffer.byteLength(character);
      const read = publicReader(await fixture(`${character} tail`));
      for (let maxBytes = 1; maxBytes < width; maxBytes++) {
        await assert.rejects(read({ maxBytes }), (error) => error instanceof RangeError
          && /maxBytes.*UTF-8/u.test(error.message) && error.message.includes(String(width)));
      }
      assert.equal((await read({ maxBytes: width })).content, character,
        "retrying at the same initial offset with enough capacity recovers the character");
    }
  });

  await test("malformed lookalikes and binary bytes retain existing replacement decoding", async () => {
    for (const [source, maxBytes] of [
      [[0xc2, 0x41], 1], [[0xe1, 0x80, 0x41], 2], [[0xf0, 0x90, 0x80, 0x41], 3],
      [[0xe0, 0x80, 0x80, 0x41], 2], [[0xed, 0xa0, 0x80, 0x41], 2],
      [[0xf4, 0x90, 0x80, 0x80, 0x41], 2], [[0xc0, 0x80, 0x41], 1],
      [[0xff, 0x41], 1], [[0x80, 0x41], 1], [[0, 0x41], 1]
    ] as const) {
      const bytes = Buffer.from(source);
      const page = await publicReader(await fixture(bytes))({ maxBytes });
      assert.equal(page.content, bytes.subarray(0, maxBytes).toString("utf8"));
      assert.equal(page.nextOffset, maxBytes);
      assert.equal(page.startOffset, 0);
    }
  });

  await test("explicit byte offsets and bounded tails keep ownership of their starting byte", async () => {
    const log = await fixture("你🙂Z");
    const read = publicReader(log);
    const middle = await read({ offset: 1, maxBytes: 2 });
    assert.equal(middle.content, Buffer.from("你").subarray(1).toString("utf8"));
    assert.equal(middle.startOffset, 1);
    assert.equal(middle.nextOffset, 3);
    assert.equal(middle.omittedBefore, true);
    const tail = await publicReader(await fixture("你"))({ fromEnd: true, maxBytes: 2 });
    assert.equal(tail.content, Buffer.from("你").subarray(1).toString("utf8"));
    assert.equal(tail.startOffset, 1);
    assert.equal(tail.nextOffset, 3);
    assert.equal(tail.hasMore, false);
    assert.equal((await read({ offset: 100, maxBytes: 1 })).nextOffset, 8);
  });

  await test("actual EOF incomplete sequences keep existing replacement semantics", async () => {
    for (const bytes of [Buffer.from([0xc2]), Buffer.from([0xe4, 0xbd]), Buffer.from([0xf0, 0x9f, 0x99])]) {
      const page = await publicReader(await fixture(bytes))({ maxBytes: bytes.length });
      assert.equal(page.content, bytes.toString("utf8"));
      assert.equal(page.nextOffset, bytes.length);
      assert.equal(page.hasMore, false);
    }
  });

  await test("character-boundary inspection consumes no peeked bytes and is bounded to three", async () => {
    const log = await fixture("a🙂Z");
    const read = publicReader(log);
    const realOpen = fs.open;
    const observed: Array<{ position: number; length: number; bytesRead: number }> = [];
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const original = handle.read.bind(handle);
      mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await original(buffer, offset, length, position);
        observed.push({ position, length, bytesRead: result.bytesRead });
        return result;
      });
      return handle;
    });
    try {
      const first = await read({ maxBytes: 2 });
      assert.deepEqual(observed, [{ position: 0, length: 2, bytesRead: 2 }, { position: 2, length: 3, bytesRead: 3 }]);
      assert.equal(first.content, "a");
      assert.equal(first.nextOffset, 1);
      assert.equal((await read({ offset: first.nextOffset, maxBytes: 4 })).content, "🙂");
    } finally { mock.restoreAll(); }
  });

  await test("canceling a boundary inspection releases the handle and preserves the abort reason", async () => {
    const log = await fixture("a🙂Z");
    const read = publicReader(log);
    const controller = new AbortController();
    const reason = new Error("cancel during bounded character inspection");
    const realOpen = fs.open;
    let reads = 0;
    let closes = 0;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const original = handle.read.bind(handle);
      mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await original(buffer, offset, length, position);
        if (++reads === 2) controller.abort(reason);
        return result;
      });
      const close = handle.close.bind(handle);
      mock.method(handle, "close", async () => { await close(); closes++; });
      return handle;
    });
    try {
      await assert.rejects(read({ maxBytes: 2 }, controller.signal), (error) => error === reason);
      assert.equal(reads, 2);
      assert.equal(closes, 1);
    } finally { mock.restoreAll(); }
  });

  await test("short inspection reads still prove completion without exceeding three inspected bytes", async () => {
    const log = await fixture("a🙂Z");
    const read = publicReader(log);
    const realOpen = fs.open;
    let reads = 0;
    let inspected = 0;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const original = handle.read.bind(handle);
      mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const first = ++reads === 1;
        const result = await original(buffer, offset, first ? length : Math.min(1, length), position);
        if (!first) inspected += result.bytesRead;
        return result;
      });
      return handle;
    });
    try {
      const page = await read({ maxBytes: 2 });
      assert.equal(page.content, "a");
      assert.equal(page.nextOffset, 1);
      assert.equal(inspected, 3);
      assert.equal(reads, 4);
    } finally { mock.restoreAll(); }
  });

  for (const mutation of ["before-inspection-truncate", "after-inspection-truncate", "zero-read", "path-replacement"] as const) {
    await test(`${mutation} during boundary inspection rejects without consuming a cursor`, async () => {
      const log = await fixture("a🙂Z");
      const read = publicReader(log);
      const realOpen = fs.open;
      let calls = 0;
      let closes = 0;
      mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]) !== log.path) return handle;
        const original = handle.read.bind(handle);
        mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          const call = ++calls;
          if (call === 2 && mutation === "zero-read") return { bytesRead: 0, buffer };
          const result = await original(buffer, offset, length, position);
          if ((call === 1 && mutation === "before-inspection-truncate")
            || (call === 2 && mutation === "after-inspection-truncate")) await fs.truncate(log.path, 2);
          if (call === 2 && mutation === "path-replacement") {
            await fs.rename(log.path, `${log.path}.original`);
            await fs.writeFile(log.path, "replacement temporary fixture");
          }
          return result;
        });
        const close = handle.close.bind(handle);
        mock.method(handle, "close", async () => { await close(); closes++; });
        return handle;
      });
      try {
        await assert.rejects(read({ maxBytes: 2 }), /retry|original/u);
        assert.equal(closes, 1);
      } finally { mock.restoreAll(); }
      if (mutation === "path-replacement") {
        await fs.rm(log.path);
        await fs.rename(`${log.path}.original`, log.path);
      } else if (mutation.endsWith("truncate")) {
        await fs.appendFile(log.path, Buffer.from("🙂Z").subarray(1));
      }
      const retry = await read({ maxBytes: 2 });
      assert.equal(retry.content, "a");
      assert.equal(retry.nextOffset, 1);
      assert.equal((await read({ offset: retry.nextOffset, maxBytes: 4 })).content, "🙂");
    });
  }
} finally {
  mock.restoreAll();
  await fs.rm(root, { recursive: true, force: true });
}
