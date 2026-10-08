import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentReadLimitError, attachmentFilePath, attachmentRoot, readAttachmentBytes, readAttachmentContext, saveAttachment, saveAttachmentContext } from "../src/attachments/store.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { BINY_BUNDLE_ATTACHMENT_LIMIT, exportSessionBundle, type BinySessionBundle } from "../src/session/transfer.js";

test("bundle export must skip an already oversized attachment without calling an unbounded read that aborts export", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-bound-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  let recorder: SessionRecorder | undefined;
  try {
    const reference = await saveAttachment(root, "large-stored.bin", "application/octet-stream", Buffer.from("seed"));
    recorder = new SessionRecorder(root, "oversized-export");
    await recorder.recordAndFlush({ type: "user_message", content: "a saved attachment", attachments: [reference] });
    await recorder.close();
    recorder = undefined;
    const target = attachmentFilePath(attachmentRoot(root), reference.path)!;
    // A sparse extent: logical size only, not a multi-gigabyte allocation/write.
    // Installed Node source was checked first: readFile throws above 2**31-1
    // before allocating a read buffer. The external runner also bounds lifetime.
    const logicalSize = 2 ** 31;
    await fs.truncate(target, logicalSize);
    const stat = await fs.stat(target);
    assert.equal(stat.size, logicalSize);
    assert.ok(stat.blocks * 512 < 1024 * 1024, "the fixture must remain physically sparse");
    let result: Awaited<ReturnType<typeof exportSessionBundle>> | undefined;
    let failure: unknown;
    try { result = await exportSessionBundle(root, "oversized-export"); }
    catch (error) { failure = error; }
    assert.equal(failure, undefined, "oversized attachments are documented as skipped, not fatal to the entire bundle export");
    assert.ok(result);
    const bundle = JSON.parse(result.content) as BinySessionBundle;
    assert.equal(bundle.manifest.attachmentCount, 0);
    assert.deepEqual(bundle.manifest.skippedAttachments, [reference.name]);
    assert.deepEqual(bundle.attachments, []);
    assert.equal((await fs.stat(target)).size, logicalSize);
  } finally {
    await recorder?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function exportFixture(run: (root: string, target: string, reference: Awaited<ReturnType<typeof saveAttachment>>, sessionId: string) => Promise<void>, bytes = Buffer.from("initial")): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-budget-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try {
    const reference = await saveAttachment(root, "attachment.bin", "application/octet-stream", bytes);
    const recorder = new SessionRecorder(root, "export-budget");
    try { await recorder.recordAndFlush({ type: "user_message", content: "synthetic attachment", attachments: [reference] }); }
    finally { await recorder.close(); }
    await run(root, attachmentFilePath(attachmentRoot(root), reference.path)!, reference, recorder.sessionId);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("initially over 50 MiB is skipped without reading data and source references remain intact", async (t) => {
  await exportFixture(async (root, target, reference, sessionId) => {
    await fs.truncate(target, BINY_BUNDLE_ATTACHMENT_LIMIT + 1);
    const originalOpen = fs.open;
    let opened = 0;
    let closed = 0;
    let reads = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      opened += 1;
      const close = handle.close.bind(handle);
      t.mock.method(handle, "read", () => { reads += 1; throw new Error("oversized data should not be read"); });
      t.mock.method(handle, "readFile", () => { reads += 1; throw new Error("oversized data should not be read"); });
      t.mock.method(handle, "close", async () => { await close(); closed += 1; });
      return handle;
    });
    const bundle = JSON.parse((await exportSessionBundle(root, sessionId)).content) as BinySessionBundle;
    assert.deepEqual(bundle.manifest.skippedAttachments, [reference.name]);
    assert.equal(bundle.manifest.attachmentCount, 0);
    assert.deepEqual(bundle.attachments, []);
    const event = bundle.events.find((entry) => entry.type === "user_message");
    assert.ok(event?.type === "user_message");
    assert.deepEqual(event.attachments, [reference]);
    assert.deepEqual({ opened, closed, reads }, { opened: 1, closed: 1, reads: 0 });
  });
});

test("exactly 50 MiB is fully embedded with correct size and checksum", async () => {
  await exportFixture(async (root, target, reference, sessionId) => {
    await fs.truncate(target, BINY_BUNDLE_ATTACHMENT_LIMIT);
    const bundle = JSON.parse((await exportSessionBundle(root, sessionId)).content) as BinySessionBundle;
    assert.deepEqual(bundle.manifest.skippedAttachments, []);
    assert.equal(bundle.manifest.attachmentCount, 1);
    const attachment = bundle.attachments[0]!;
    assert.equal(attachment.sourcePath, reference.path);
    assert.equal(attachment.size, BINY_BUNDLE_ATTACHMENT_LIMIT);
    assert.equal(attachment.data.length, 4 * Math.ceil(BINY_BUNDLE_ATTACHMENT_LIMIT / 3));
    const hash = createHash("sha256").update("initial");
    const zeros = Buffer.alloc(64 * 1024);
    let left = BINY_BUNDLE_ATTACHMENT_LIMIT - Buffer.byteLength("initial");
    while (left > 0) { const count = Math.min(left, zeros.length); hash.update(zeros.subarray(0, count)); left -= count; }
    assert.equal(attachment.sha256, hash.digest("hex"));
    assert.equal(attachment.data.startsWith(Buffer.from("initial").toString("base64").slice(0, 8)), true);
    assert.equal((await fs.stat(target)).size, BINY_BUNDLE_ATTACHMENT_LIMIT);
  });
});

test("growth after the initial stat is skipped with no more than cap+1 bytes consumed", async (t) => {
  await exportFixture(async (root, target, reference, sessionId) => {
    const originalOpen = fs.open;
    let grown = false;
    let consumed = 0;
    let readFileCalls = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const stat = handle.stat.bind(handle);
      const read = handle.read.bind(handle);
      const readFile = handle.readFile.bind(handle);
      t.mock.method(handle, "stat", (async (...values: Parameters<FileHandle["stat"]>) => {
        const result = await stat(...values);
        if (!grown) { grown = true; await fs.truncate(target, BINY_BUNDLE_ATTACHMENT_LIMIT + 1); }
        return result;
      }) as FileHandle["stat"]);
      t.mock.method(handle, "read", (async (...values: Parameters<FileHandle["read"]>) => {
        const result = await read(...values); consumed += result.bytesRead; return result;
      }) as FileHandle["read"]);
      t.mock.method(handle, "readFile", async (...values: Parameters<FileHandle["readFile"]>) => { readFileCalls += 1; return readFile(...values); });
      return handle;
    });
    const bundle = JSON.parse((await exportSessionBundle(root, sessionId)).content) as BinySessionBundle;
    assert.equal(grown, true);
    assert.deepEqual(bundle.manifest.skippedAttachments, [reference.name]);
    assert.equal(bundle.manifest.attachmentCount, 0);
    assert.equal(readFileCalls, 0, "bounded export must not delegate to an unbounded readFile");
    assert.equal(consumed, BINY_BUNDLE_ATTACHMENT_LIMIT + 1);
  });
});

test("short reads preserve exact bytes, and default reads keep their prior unbounded interface", async (t) => {
  const bytes = Buffer.from("中文 😀 binary\0\xff\n", "utf8");
  await exportFixture(async (root, target, reference, sessionId) => {
    const originalOpen = fs.open;
    let chunks = 0;
    let wholeReads = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const read = handle.read.bind(handle);
      const readFile = handle.readFile.bind(handle);
      t.mock.method(handle, "read", (async (...values: unknown[]) => {
        const [buffer, offset, length, position] = values;
        assert.ok(Buffer.isBuffer(buffer));
        chunks += 1;
        return read(buffer, Number(offset), Math.min(Number(length), 3), Number(position));
      }) as FileHandle["read"]);
      t.mock.method(handle, "readFile", async (...values: Parameters<FileHandle["readFile"]>) => { wholeReads += 1; return readFile(...values); });
      return handle;
    });
    const bundle = JSON.parse((await exportSessionBundle(root, sessionId)).content) as BinySessionBundle;
    assert.deepEqual(Buffer.from(bundle.attachments[0]!.data, "base64"), bytes);
    assert.ok(chunks > 1);
    assert.equal(wholeReads, 0);
    assert.deepEqual(await readAttachmentBytes(root, reference.path), bytes);
    assert.equal(wholeReads, 1, "omitting the optional budget retains the default reader's path");
    await assert.rejects(readAttachmentBytes(root, reference.path, bytes.length - 1), (error: unknown) => error instanceof AttachmentReadLimitError && error.actualBytes === bytes.length && error.maxBytes === bytes.length - 1);
  }, bytes);
});

for (const kind of ["directory", "symlink", "hardlink"] as const) {
  test(`${kind} attachment remains a binding/type error, not an oversized skip`, async () => {
    await exportFixture(async (root, target, _reference, sessionId) => {
      const other = path.join(root, "other-synthetic.bin");
      await fs.writeFile(other, "preserved");
      await fs.rm(target);
      if (kind === "directory") await fs.mkdir(target);
      else if (kind === "symlink") await fs.symlink(other, target);
      else await fs.link(other, target);
      await assert.rejects(exportSessionBundle(root, sessionId), /attachment_path_invalid/u);
      assert.equal(await fs.readFile(other, "utf8"), "preserved");
    });
  });
}

for (const stage of ["open", "stat", "read", "close"] as const) {
  test(`export ${stage} EIO remains the original error rather than a skipped attachment`, async (t) => {
    await exportFixture(async (root, target, _reference, sessionId) => {
      const originalOpen = fs.open;
      const expected = Object.assign(new Error(`synthetic ${stage} EIO`), { code: "EIO" });
      let closed = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) === target && stage === "open") throw expected;
        const handle = await originalOpen(...args);
        if (String(args[0]) !== target) return handle;
        const close = handle.close.bind(handle);
        if (stage === "stat") t.mock.method(handle, "stat", () => Promise.reject(expected));
        if (stage === "read") t.mock.method(handle, "read", () => Promise.reject(expected));
        t.mock.method(handle, "close", async () => { await close(); closed += 1; if (stage === "close") throw expected; });
        return handle;
      });
      await assert.rejects(exportSessionBundle(root, sessionId), (error: unknown) => error === expected);
      assert.equal(closed, stage === "open" ? 0 : 1);
    });
  });
}

test("a file changed during the bounded read retains the binding error", async (t) => {
  await exportFixture(async (root, target, _reference, sessionId) => {
    const originalOpen = fs.open;
    let replaced = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== target) return handle;
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", (async (...values: Parameters<FileHandle["read"]>) => {
        const result = await read(...values);
        if (!replaced) {
          replaced = true;
          const next = path.join(root, "replacement.tmp");
          await fs.writeFile(next, "external replacement");
          await fs.rename(next, target);
        }
        return result;
      }) as FileHandle["read"]);
      return handle;
    });
    await assert.rejects(exportSessionBundle(root, sessionId), /attachment_path_invalid/u);
    assert.equal(await fs.readFile(target, "utf8"), "external replacement");
  });
});

test("missing and oversize references are deduplicated while surviving data and events remain", async () => {
  await exportFixture(async (root, target, reference) => {
    const retainedBytes = Buffer.from("surviving report");
    const retained = await saveAttachment(root, "small.txt", "text/plain", retainedBytes);
    const missing = await saveAttachment(root, "missing.txt", "text/plain", Buffer.from("gone"));
    await fs.rm(attachmentFilePath(attachmentRoot(root), missing.path)!);
    await fs.truncate(target, BINY_BUNDLE_ATTACHMENT_LIMIT + 1);
    const recorder = new SessionRecorder(root, "mixed-export");
    const references = [reference, retained, missing];
    try {
      await recorder.recordAndFlush({ type: "user_message", content: "all attachments", attachments: references });
      await recorder.recordAndFlush({ type: "user_message", content: "repeated attachment", attachments: [reference] });
    } finally { await recorder.close(); }
    const before = await fs.readFile(recorder.filePath);
    const bundle = JSON.parse((await exportSessionBundle(root, recorder.sessionId)).content) as BinySessionBundle;
    assert.deepEqual(bundle.manifest.skippedAttachments, [reference.name, missing.name]);
    assert.equal(bundle.manifest.attachmentCount, 1);
    assert.deepEqual(Buffer.from(bundle.attachments[0]!.data, "base64"), retainedBytes);
    const event = bundle.events.find((entry) => entry.type === "user_message");
    assert.ok(event?.type === "user_message");
    assert.deepEqual(event.attachments, references);
    assert.deepEqual(await fs.readFile(recorder.filePath), before);
  });
});

test("hidden-context limit and error behavior remain unchanged", async () => {
  await exportFixture(async (root, _target, reference) => {
    const storedRoot = attachmentRoot(root);
    await saveAttachmentContext(storedRoot, reference.path, "unchanged context");
    assert.equal(await readAttachmentContext(storedRoot, reference.path), "unchanged context");
    await fs.writeFile(`${attachmentFilePath(storedRoot, reference.path)!}.context`, "x".repeat(128001));
    await assert.rejects(readAttachmentContext(storedRoot, reference.path), (error: unknown) => error instanceof Error && !(error instanceof AttachmentReadLimitError) && error.message === "attachment_context_invalid");
  });
});
