/** 导入附件经隔离暂存写入；失败不得删除已有文件或并发替换内容。 */
import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { splitAttachmentReferences, withAttachmentReferences } from "../src/attachments/references.js";
import { attachmentRoot, readAttachment, readAttachmentContext } from "../src/attachments/store.js";
import { refreshSessionIndex } from "../src/session/catalog.js";
import { createSessionFile, ensureAgentDirs, listSessionFiles } from "../src/session/store.js";
import { refreshSessionIndex } from "../src/session/catalog.js";
import { BINY_BUNDLE_FORMAT, BINY_BUNDLE_VERSION, exportSessionBundle, importSessionFile, SessionImportCleanupError } from "../src/session/transfer.js";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-import-attachment-tx-")));
  const workspace = path.join(root, "project");
  await fs.mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    // 导入的后台索引刷新仍会写目录；排空后才能还原环境并移除 fixture。
    await refreshSessionIndex(workspace);
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  await ensureAgentDirs(workspace);
  const directory = attachmentRoot(workspace);
  const source = path.join(workspace, "import.json");
  const bytes = Buffer.from("imported attachment bytes");
  await fs.writeFile(source, JSON.stringify({
    format: BINY_BUNDLE_FORMAT, version: BINY_BUNDLE_VERSION,
    manifest: { sessionId: "source", exportedAt: "2026-10-07T00:00:00Z", eventCount: 1, attachmentCount: 1, skippedAttachments: [] },
    events: [{ type: "user_message", content: withAttachmentReferences("file quotes @attachments/original.pdf", [{ name: "report..pdf", path: "@attachments/original.pdf", mimeType: "application/pdf", size: bytes.length }]), attachments: [{ name: "report..pdf", path: "@attachments/original.pdf", mimeType: "application/pdf", size: bytes.length }] }],
    attachments: [{ name: "report..pdf", sourcePath: "@attachments/original.pdf", mimeType: "application/pdf", size: bytes.length,
      data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }]
  }));
  return { root, workspace, directory, source, bytes };
}

test("session creation failure leaves no published attachment and preserves existing historical files", async (t) => {
  const f = await fixture(t);
  const historical = path.join(f.directory, "historical.pdf");
  await fs.writeFile(historical, "original history");
  const open = fs.open;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    if (String(file).endsWith(".jsonl")) throw Object.assign(new Error("session write denied"), { code: "EACCES" });
    return await open(file, ...rest as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]);
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), /session write denied/u);
  assert.equal(await fs.readFile(historical, "utf8"), "original history");
  assert.deepEqual(await fs.readdir(f.directory), ["historical.pdf"], "staged bytes are cleaned without publishing an orphan");
  assert.deepEqual(await listSessionFiles(f.workspace), []);
});

test("partial staged attachment write failure removes only its own new files", async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  let intercepted = false;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    const handle = await open(file, ...rest as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]);
    if (String(file).startsWith(f.directory + path.sep) && !intercepted) {
      intercepted = true;
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async () => {
        await writeFile(f.bytes.subarray(0, 7));
        throw new Error("injected attachment write failure");
      };
    }
    return handle;
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), /injected attachment write failure/u);
  assert.equal(intercepted, true, "attachment write uses an exclusive owned handle");
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.deepEqual(await listSessionFiles(f.workspace), []);
});

test("a staged file replaced before failure is preserved instead of deleted as an owned attachment", async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  let replaced: string | undefined;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    const handle = await open(file, ...rest as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]);
    if (String(file).startsWith(f.directory + path.sep) && !replaced) {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...args: Parameters<FileHandle["writeFile"]>) => {
        await writeFile(...args);
        replaced = String(file);
        await fs.unlink(replaced);
        await fs.writeFile(replaced, "concurrent replacement", { flag: "wx" });
        throw new Error("failure after concurrent replacement");
      };
    }
    return handle;
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), /failure after concurrent replacement/u);
  assert.ok(replaced);
  assert.equal(await fs.readFile(replaced, "utf8"), "concurrent replacement");
  assert.deepEqual(await listSessionFiles(f.workspace), []);
});


test("committed batch references are readable and re-exportable; parallel imports keep separate namespaces", async (t) => {
  const f = await fixture(t);
  const imported = await Promise.all([importSessionFile(f.workspace, f.source), importSessionFile(f.workspace, f.source)]);
  const references = await Promise.all(imported.map(async (session) => {
    const bundle = JSON.parse((await exportSessionBundle(f.workspace, session.sessionId)).content);
    assert.equal(bundle.attachments.length, 1);
    assert.equal(bundle.attachments[0].data, f.bytes.toString("base64"));
    const ref = bundle.events[0].attachments[0];
    assert.match(ref.path, /^@attachments\/import-[a-f0-9]{32}\/[^/]+-report\.pdf$/u);
    assert.equal(ref.name, "report..pdf");
    const parsed = splitAttachmentReferences(bundle.events[0].content);
    assert.equal(parsed.text, "file quotes @attachments/original.pdf", "user prose is not rewritten");
    assert.equal(parsed.attachments[0].path, ref.path);
    assert.equal(parsed.attachments[0].name, "report.pdf");
    assert.equal((await readAttachment(f.workspace, ref))?.data, f.bytes.toString("base64"));
    assert.equal((await fs.stat(path.join(f.directory, ref.path.split("/")[1]))).mode & 0o777, 0o700);
    return ref.path;
  }));
  assert.notEqual(references[0].split("/")[1], references[1].split("/")[1]);
});

for (const parent of [true, false]) {
  test(`fixed namespace ${parent ? "parent" : "leaf"} symlink cannot enter read, context or exported bytes`, async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "private.txt"), "outside secret");
    await fs.writeFile(path.join(outside, "private.txt.context"), "outside private context");
    const namespace = `import-${"a".repeat(32)}`;
    const directory = path.join(f.directory, namespace);
    if (parent) await fs.symlink(outside, directory);
    else {
      await fs.mkdir(directory);
      await fs.symlink(path.join(outside, "private.txt"), path.join(directory, "private.txt"));
      await fs.symlink(path.join(outside, "private.txt.context"), path.join(directory, "private.txt.context"));
    }
    const ref = { name: "private.txt", mimeType: "text/plain", path: `@attachments/${namespace}/private.txt` };
    await assert.rejects(readAttachment(f.workspace, ref), /attachment_path_invalid/u);
    await assert.rejects(readAttachmentContext(f.directory, ref.path), /attachment_path_invalid/u);
    await createSessionFile(f.workspace, "unsafe-reference", Buffer.from(JSON.stringify({ type: "user_message", content: "file", attachments: [ref] }) + "\n"));
    await assert.rejects(exportSessionBundle(f.workspace, "unsafe-reference"), /attachment_path_invalid/u);
    assert.equal(await fs.readFile(path.join(outside, "private.txt"), "utf8"), "outside secret");
  });
}

test("cleanup claim protects a replacement arriving after ownership check, before owned-file unlink", async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  const lstat = fs.lstat;
  let original: string | undefined;
  let cleanup = false;
  let replaced = false;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    if (String(file).endsWith(".jsonl")) { cleanup = true; throw new Error("session creation failed"); }
    const handle = await open(file, ...rest as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]);
    if (String(file).startsWith(f.directory + path.sep) && !original) original = String(file);
    return handle;
  });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const info = await lstat(...args);
    if (cleanup && !replaced && String(args[0]).includes(`${path.sep}.cleanup-`)) {
      assert.ok(original);
      await fs.writeFile(original, "new occupant after ownership check", { flag: "wx" });
      replaced = true;
    }
    return info;
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), error => error instanceof SessionImportCleanupError
    && error.message.includes("attachment_import_cleanup_uncertain") && error.retainedAttachmentPaths.length > 0);
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(original!, "utf8"), "new occupant after ownership check");
  assert.deepEqual(await listSessionFiles(f.workspace), []);
});

test("namespace collision never claims or cleans an existing batch", async (t) => {
  const f = await fixture(t);
  const original = path.join(f.directory, `import-${"a".repeat(32)}`);
  await fs.mkdir(original, { mode: 0o750 });
  await fs.writeFile(path.join(original, "existing.txt"), "old batch");
  const before = await fs.stat(original);
  const randomBytes = crypto.randomBytes;
  let directories = 0;
  t.mock.method(crypto, "randomBytes", (size: number) => size === 16
    ? Buffer.from((directories++ === 0 ? "a" : "b").repeat(32), "hex") : randomBytes(size));
  syncBuiltinESMExports();
  const imported = await importSessionFile(f.workspace, f.source);
  assert.equal(directories, 2);
  assert.equal(await fs.readFile(path.join(original, "existing.txt"), "utf8"), "old batch");
  assert.equal((await fs.stat(original)).ino, before.ino);
  assert.equal((await fs.stat(original)).mode, before.mode);
  const bundle = JSON.parse((await exportSessionBundle(f.workspace, imported.sessionId)).content);
  assert.match(bundle.events[0].attachments[0].path, new RegExp(`^@attachments/import-${"b".repeat(32)}/`));
});

test("cleanup I/O failure retains owned files and reports uncertainty without masking the import error", async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  const rename = fs.rename;
  let original: string | undefined;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    if (String(file).endsWith(".jsonl")) throw new Error("primary session failure");
    const handle = await open(file, ...rest as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]);
    if (String(file).startsWith(f.directory + path.sep) && !original) original = String(file);
    return handle;
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[0]) === original) throw Object.assign(new Error("cleanup write denied"), { code: "EACCES" });
    return await rename(...args);
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), error => error instanceof SessionImportCleanupError
    && error.message.includes("primary session failure") && error.message.includes("attachment_import_cleanup_uncertain")
    && error.retainedAttachmentPaths.includes(original!) && error.message.includes(JSON.stringify(original!)));
  assert.deepEqual(await fs.readFile(original!), f.bytes);
});


test("cleanup directory ownership I/O failure preserves primary cause and reports retained batch", async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  const lstat = fs.lstat;
  let cleanup = false;
  const primary = new Error("primary session failure");
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    if (String(file).endsWith(".jsonl")) { cleanup = true; throw primary; }
    return await open(file, ...rest as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]);
  });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (cleanup && String(args[0]).startsWith(f.directory + path.sep)) throw Object.assign(new Error("cleanup directory stat denied"), { code: "EACCES" });
    return await lstat(...args);
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), error => error instanceof SessionImportCleanupError
    && error.cause === primary && error.retainedAttachmentPaths.length === 1);
  assert.equal((await fs.readdir(f.directory)).length, 1);
  assert.deepEqual(await listSessionFiles(f.workspace), []);
});


test("new batch ownership read failure retains the unconfirmed directory with its location", async (t) => {
  const f = await fixture(t);
  const lstat = fs.lstat;
  let directory: string | undefined;
  const failure = Object.assign(new Error("initial batch ownership unavailable"), { code: "EACCES" });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]).startsWith(f.directory + path.sep)) { directory = String(args[0]); throw failure; }
    return await lstat(...args);
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), error => error instanceof SessionImportCleanupError
    && error.cause === failure && error.message.includes(JSON.stringify(directory)));
  assert.equal((await fs.readdir(f.directory)).length, 1);
  assert.deepEqual(await listSessionFiles(f.workspace), []);
});
