import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveToolResult, readToolResultArchive, resolveToolResultArchivePath } from "../src/session/toolResultArchive.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";

test("public archive reader must enforce its byte cap when the regular file grows after initial stat", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-archive-growth-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try {
    const archived = await archiveToolResult({ workspaceRoot: root, sessionId: "growth", toolCallId: "original", sequence: 1, tool: "fixture", result: "small valid content" });
    const target = resolveToolResultArchivePath(root, archived.archivePath);
    const cap = 64 * 1024 * 1024;
    const initialBytes = (await fs.stat(target)).size;
    const originalOpen = fs.open;
    let appended = false;
    let actualReadBytes = 0;
    let closed = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.readFile.bind(handle);
      const originalChunkRead = handle.read.bind(handle);
      const originalClose = handle.close.bind(handle);
      t.mock.method(handle, "stat", (async (...statArgs: Parameters<FileHandle["stat"]>) => {
        const observed = await originalStat(...statArgs);
        if (!appended) {
          appended = true;
          // Real concurrent growth, preserving valid JSON by adding whitespace.
          await fs.appendFile(target, " ".repeat(cap + 1 - initialBytes));
        }
        return observed;
      }) as FileHandle["stat"]);
      t.mock.method(handle, "readFile", async (...readArgs: Parameters<FileHandle["readFile"]>) => {
        const content = await originalRead(...readArgs);
        actualReadBytes = typeof content === "string" ? Buffer.byteLength(content) : content.length;
        return content;
      });
      t.mock.method(handle, "read", (async (...readArgs: Parameters<FileHandle["read"]>) => {
        const result = await originalChunkRead(...readArgs);
        actualReadBytes += result.bytesRead;
        return result;
      }) as FileHandle["read"]);
      t.mock.method(handle, "close", async () => { await originalClose(); closed += 1; });
      return handle;
    });
    const tool = createReadToolResultTool({ workspaceRoot: root, ignore: [] });
    const execution = await tool.resolveExecution({ archivePath: archived.archivePath, length: 20 });
    assert.ok("execute" in execution);
    let result: unknown;
    let failure: unknown;
    try { result = await execution.execute({ toolCallId: "read-growing", operationId: "read-growing" }); }
    catch (error) { failure = error; }
    assert.equal(appended, true);
    assert.equal(closed, 1);
    assert.equal((await fs.stat(target)).size, cap + 1);
    assert.ok(actualReadBytes <= cap + 1, "reader must never consume more than cap plus one sentinel byte");
    assert.ok(failure instanceof Error && /exceeding.*read limit/u.test(failure.message), "growth must be rejected by the advertised archive byte bound");
    assert.equal(result, undefined);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function withArchive(run: (root: string, reference: string, target: string, original: Buffer) => Promise<void>, output = "small valid content"): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-archive-bounds-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try {
    const result = await archiveToolResult({ workspaceRoot: root, sessionId: "bounds", toolCallId: "original", sequence: 1, tool: "fixture", result: output });
    const target = resolveToolResultArchivePath(root, result.archivePath);
    await run(root, result.archivePath, target, await fs.readFile(target));
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("exactly 64 MiB reads preserve content and use at most one sentinel byte", async (t) => {
  await withArchive(async (root, reference, target, original) => {
    const cap = 64 * 1024 * 1024;
    await fs.appendFile(target, " ".repeat(cap - original.length));
    const originalOpen = fs.open;
    let bytes = 0;
    let requested = 0;
    let closed = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "read", (async (...values: unknown[]) => {
        const [buffer, offset, length, position] = values;
        assert.ok(Buffer.isBuffer(buffer));
        assert.equal(typeof offset, "number");
        assert.equal(typeof length, "number");
        assert.equal(typeof position, "number");
        requested += Number(length);
        const result = await read(buffer, Number(offset), Number(length), Number(position));
        bytes += result.bytesRead;
        return result;
      }) as FileHandle["read"]);
      t.mock.method(handle, "close", async () => { await close(); closed += 1; });
      return handle;
    });
    const envelope = await readToolResultArchive(root, reference);
    assert.equal(envelope.output, "small valid content");
    assert.equal(bytes, cap);
    assert.equal(requested, cap + 1);
    assert.equal(closed, 1);
  });
});

test("initial cap+1 size is rejected before reading and the handle still closes", async (t) => {
  await withArchive(async (root, reference, target) => {
    const cap = 64 * 1024 * 1024;
    await fs.truncate(target, cap + 1);
    const originalOpen = fs.open;
    let reads = 0;
    let closed = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "read", (async (...values: Parameters<FileHandle["read"]>) => { reads += 1; return read(...values); }) as FileHandle["read"]);
      t.mock.method(handle, "close", async () => { await close(); closed += 1; });
      return handle;
    });
    await assert.rejects(readToolResultArchive(root, reference), { message: `Archived tool result is ${String(cap + 1)} bytes, exceeding the ${String(cap)}-byte read limit.` });
    assert.equal(reads, 0);
    assert.equal(closed, 1);
  });
});

test("short reads preserve Unicode and retain only actual data rather than unused chunk capacity", async (t) => {
  const output = "x" + "😀中𐐷\r\n".repeat(100);
  await withArchive(async (root, reference, target, original) => {
    const originalOpen = fs.open;
    const originalConcat = Buffer.concat;
    let reads = 0;
    let retainedCapacity = 0;
    let concatenations = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", (async (...values: unknown[]) => {
        const [buffer, offset, length, position] = values;
        assert.ok(Buffer.isBuffer(buffer));
        reads += 1;
        return read(buffer, Number(offset), Math.min(Number(length), 7), Number(position));
      }) as FileHandle["read"]);
      return handle;
    });
    t.mock.method(Buffer, "concat", (list: readonly Uint8Array[], length?: number) => {
      if (length === original.length) {
        concatenations += 1;
        retainedCapacity = [...new Set(list.map((buffer) => buffer.buffer))].reduce((sum, buffer) => sum + buffer.byteLength, 0);
      }
      return originalConcat(list, length);
    });
    const result = await readToolResultArchive(root, reference);
    assert.equal(result.output, output);
    assert.ok(reads > 2);
    assert.equal(concatenations, 1);
    assert.ok(retainedCapacity <= original.length + 64 * 1024, "short chunks must not each pin a separate 64 KiB allocation");
  }, output);
});

test("shrink after the initial stat retains valid EOF behavior without claiming an immutable snapshot", async (t) => {
  await withArchive(async (root, reference, target, original) => {
    await fs.appendFile(target, " ".repeat(128 * 1024));
    const originalOpen = fs.open;
    let shrunk = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const stat = handle.stat.bind(handle);
      t.mock.method(handle, "stat", (async (...values: Parameters<FileHandle["stat"]>) => {
        const result = await stat(...values);
        if (!shrunk) { shrunk = true; await fs.truncate(target, original.length); }
        return result;
      }) as FileHandle["stat"]);
      return handle;
    });
    assert.equal((await readToolResultArchive(root, reference)).output, "small valid content");
    assert.equal(shrunk, true);
  });
});

test("growth after EOF is rejected by final size check without reading the appended bytes", async (t) => {
  await withArchive(async (root, reference, target, original) => {
    const cap = 64 * 1024 * 1024;
    const originalOpen = fs.open;
    let appended = false;
    let bytesRead = 0;
    const append = async () => {
      if (appended) return;
      appended = true;
      await fs.appendFile(target, " ".repeat(cap + 1 - original.length));
    };
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const read = handle.read.bind(handle);
      const readFile = handle.readFile.bind(handle);
      t.mock.method(handle, "read", (async (...values: Parameters<FileHandle["read"]>) => {
        const result = await read(...values);
        bytesRead += result.bytesRead;
        if (result.bytesRead === 0) await append();
        return result;
      }) as FileHandle["read"]);
      // Keep the same public boundary meaningful against the frozen old reader.
      t.mock.method(handle, "readFile", async (...values: Parameters<FileHandle["readFile"]>) => {
        const result = await readFile(...values);
        bytesRead += typeof result === "string" ? Buffer.byteLength(result) : result.length;
        await append();
        return result;
      });
      return handle;
    });
    await assert.rejects(readToolResultArchive(root, reference), /exceeding.*read limit/u);
    assert.equal(appended, true);
    assert.equal(bytesRead, original.length);
  });
});

test("read I/O failure preserves its original error and closes the archive handle", async (t) => {
  await withArchive(async (root, reference, target) => {
    const originalOpen = fs.open;
    const expected = Object.assign(new Error("synthetic archive read EIO"), { code: "EIO" });
    let closed = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const close = handle.close.bind(handle);
      t.mock.method(handle, "read", () => Promise.reject(expected));
      t.mock.method(handle, "readFile", () => Promise.reject(expected));
      t.mock.method(handle, "close", async () => { await close(); closed += 1; });
      return handle;
    });
    await assert.rejects(readToolResultArchive(root, reference), (error: unknown) => error === expected);
    assert.equal(closed, 1);
  });
});

test("malformed under-limit JSON keeps its parse error and nonregular targets keep their regular-file error", async () => {
  await withArchive(async (root, reference, target) => {
    await fs.writeFile(target, "{");
    await assert.rejects(readToolResultArchive(root, reference), SyntaxError);
    await fs.rm(target);
    await fs.mkdir(target);
    await assert.rejects(readToolResultArchive(root, reference), /not a regular file/u);
  });
});

test("mid-read abort drains one pending native read but starts no later chunks and returns no page", async (t) => {
  await withArchive(async (root, reference, target) => {
    const originalOpen = fs.open;
    const controller = new AbortController();
    const reason = new Error("cancel the second archive chunk");
    let reads = 0;
    let completed = 0;
    let closed = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "read", (async (...values: Parameters<FileHandle["read"]>) => {
        reads += 1;
        const pending = read(...values);
        if (reads === 2) controller.abort(reason);
        const result = await pending;
        completed += 1;
        return result;
      }) as FileHandle["read"]);
      t.mock.method(handle, "close", async () => { await close(); closed += 1; });
      return handle;
    });
    const execution = await createReadToolResultTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ archivePath: reference });
    assert.ok("execute" in execution);
    await assert.rejects(execution.execute({ signal: controller.signal, toolCallId: "mid-read-abort", operationId: "mid-read-abort" }), (error: unknown) => error === reason);
    assert.equal(reads, 2);
    assert.equal(completed, 2);
    assert.equal(closed, 1);
  }, "x".repeat(200_000));
});
