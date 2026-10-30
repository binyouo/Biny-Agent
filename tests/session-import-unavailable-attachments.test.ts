import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentRoot, attachmentFilePath, createAttachmentImportBatch, readAttachment, readAttachmentBytes, saveAttachment } from "../src/attachments/store.js";
import { splitAttachmentReferences, withAttachmentReferences } from "../src/attachments/references.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import { exportSessionBundle, importSessionFile, type BinySessionBundle, type BinySessionBundleAttachment } from "../src/session/transfer.js";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-unavailable-import-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.after(async () => {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const source = path.join(root, "source"), target = path.join(root, "target");
  await fs.mkdir(source); await fs.mkdir(target);
  await ensureAgentDirs(source); await ensureAgentDirs(target);
  const file = path.join(root, "bundle.json");
  const reference = { name: "report.png", path: "@attachments/source-report.png", mimeType: "image/png", size: 6 };
  const bytes = Buffer.from("source");
  const attachment: BinySessionBundleAttachment = { ...reference, sourcePath: reference.path, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
  const bundle: BinySessionBundle = { format: "biny-session-bundle", version: 2,
    manifest: { sessionId: "source", exportedAt: "2026-10-30T00:00:00Z", eventCount: 1, attachmentCount: 1, skippedAttachments: [] },
    events: [{ type: "user_message", content: withAttachmentReferences("Review report", [reference]), attachments: [reference] }], attachments: [attachment] };
  const importBundle = async (value = bundle) => { await fs.writeFile(file, JSON.stringify(value)); return await importSessionFile(target, file); };
  const userOf = async (id: string) => {
    const event = (await readStoredSessionEvents(target, id)).events.find(event => event.type === "user_message");
    assert.ok(event?.type === "user_message"); return event;
  };
  await fs.writeFile(attachmentFilePath(attachmentRoot(target), reference.path)!, "unrelated local picture");
  return { root, source, target, file, reference, attachment, bundle, importBundle, userOf };
}

test("export-omitted attachment is reported missing and cannot bind the destination's old path", async t => {
  const f = await fixture(t);
  const saved = await saveAttachment(f.source, "report.png", "image/png", Buffer.from("source"));
  await createSessionFile(f.source, "source", Buffer.from(JSON.stringify({ type: "user_message", content: withAttachmentReferences("review", [saved]), attachments: [saved] }) + "\n"));
  await fs.unlink(attachmentFilePath(attachmentRoot(f.source), saved.path)!);
  const bundle = JSON.parse((await exportSessionBundle(f.source, "source")).content) as BinySessionBundle;
  await fs.writeFile(attachmentFilePath(attachmentRoot(f.target), saved.path)!, "unrelated");
  const result = await f.importBundle(bundle);
  assert.equal(result.attachmentsRestored, 0); assert.equal(result.attachmentsSkipped, 1);
  assert.deepEqual(result.skippedAttachmentIssues, [{ name: saved.name, reason: "missing" }]);
  const user = await f.userOf(result.sessionId), ref = user.attachments![0]!;
  assert.notEqual(ref.path, saved.path); assert.equal(await readAttachment(f.target, ref), undefined);
  assert.equal(splitAttachmentReferences(user.content).attachments[0]!.path, ref.path);
  assert.equal((await fs.readFile(attachmentFilePath(attachmentRoot(f.target), saved.path)!)).toString(), "unrelated");
});

test("checksum-rejected media remains unavailable even when the source path exists locally", async t => {
  const f = await fixture(t); f.bundle.attachments[0]!.sha256 = "0".repeat(64);
  const result = await f.importBundle(), ref = (await f.userOf(result.sessionId)).attachments![0]!;
  assert.equal(result.attachmentsSkipped, 1); assert.equal(result.skippedAttachmentIssues[0]!.reason, "invalid");
  assert.equal(await readAttachment(f.target, ref), undefined);
  assert.equal((await readAttachmentBytes(f.target, f.reference.path))!.toString(), "unrelated local picture");
});

test("legacy generated lists are remapped without rewriting ordinary prose mentions", async t => {
  const f = await fixture(t); f.bundle.attachments = [];
  f.bundle.events = [{ type: "user_message", content: withAttachmentReferences(`Quoted path ${f.reference.path}`, [f.reference]) }];
  const result = await f.importBundle(), user = await f.userOf(result.sessionId);
  const parsed = splitAttachmentReferences(user.content);
  assert.equal(parsed.text, `Quoted path ${f.reference.path}`); assert.equal(user.attachments, undefined);
  assert.notEqual(parsed.attachments[0]!.path, f.reference.path);
  assert.equal(await readAttachment(f.target, parsed.attachments[0]!), undefined); assert.equal(result.attachmentsSkipped, 1);
});

test("mixed valid and unavailable references preserve valid bytes and deduplicate unavailable paths", async t => {
  const f = await fixture(t), missing = { ...f.reference, name: "missing.png", path: "@attachments/missing.png" };
  f.bundle.events = [{ type: "user_message", content: withAttachmentReferences("review", [f.reference, missing]), attachments: [f.reference, missing] },
    { type: "user_message", content: withAttachmentReferences("again", [missing]), attachments: [missing] }];
  const result = await f.importBundle(), refs = (await f.userOf(result.sessionId)).attachments!;
  assert.equal(result.attachmentsRestored, 1); assert.equal(result.attachmentsSkipped, 1);
  assert.equal((await readAttachmentBytes(f.target, refs[0]!.path))!.toString(), "source");
  assert.equal(await readAttachment(f.target, refs[1]!), undefined);
  const users = (await readStoredSessionEvents(f.target, result.sessionId)).events.filter(e => e.type === "user_message");
  assert.equal(users[1]!.attachments![0]!.path, refs[1]!.path);
});

for (const malformed of [false, true]) test(`ambiguous duplicate source paths reject before import (malformed=${malformed})`, async t => {
  const f = await fixture(t);
  const duplicate: unknown = malformed ? { sourcePath: f.reference.path } : { ...f.attachment, sha256: "0".repeat(64) };
  (f.bundle.attachments as unknown[]).push(duplicate);
  const before = await fs.readdir(attachmentRoot(f.target));
  await assert.rejects(f.importBundle(), /重复/u);
  assert.deepEqual(await fs.readdir(attachmentRoot(f.target)), before);
});

test("unavailable references stay unavailable across repeated export/import", async t => {
  const f = await fixture(t); f.bundle.attachments = [];
  const first = await f.importBundle();
  const ref1 = (await f.userOf(first.sessionId)).attachments![0]!;
  const again = JSON.parse((await exportSessionBundle(f.target, first.sessionId)).content) as BinySessionBundle;
  assert.equal(again.attachments.length, 0); assert.deepEqual(again.manifest.skippedAttachments, [f.reference.name]);
  const second = await f.importBundle(again), ref2 = (await f.userOf(second.sessionId)).attachments![0]!;
  assert.equal(second.attachmentsSkipped, 1); assert.notEqual(ref1.path, ref2.path);
  assert.equal(await readAttachment(f.target, ref2), undefined);
});

test("reservations create no substitute file, isolate later saves, and roll back their directory", async t => {
  const f = await fixture(t), batch = await createAttachmentImportBatch(f.target);
  const reserved = await batch.reserveMissing("same.png");
  const saved = await batch.save("same.png", "image/png", Buffer.from("valid"));
  assert.notEqual(saved.path, reserved); assert.equal(await readAttachmentBytes(f.target, reserved), undefined);
  assert.equal((await readAttachmentBytes(f.target, saved.path))!.toString(), "valid");
  assert.deepEqual(await batch.rollback(), []);
  await assert.rejects(fs.stat(path.dirname(attachmentFilePath(attachmentRoot(f.target), reserved)!)), { code: "ENOENT" });
});

test("session publication failure rolls back missing-only and mixed import batches", async t => {
  const f = await fixture(t), open = fs.open;
  const before = await fs.readdir(attachmentRoot(f.target));
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".jsonl")) throw Object.assign(new Error("synthetic session write failure"), { code: "EIO" });
    return await open(...args);
  });
  for (const entries of [[], [f.attachment]]) {
    f.bundle.attachments = entries;
    const missing = { ...f.reference, path: "@attachments/missing.png" };
    f.bundle.events = [{ type: "user_message", content: "review", attachments: [f.reference, missing] }];
    await assert.rejects(f.importBundle(), /synthetic session write failure/u);
    assert.deepEqual(await fs.readdir(attachmentRoot(f.target)), before);
  }
});

for (const scenario of ["absent-payload-array", "malformed-entry", "oversize", "base64", "size"] as const) {
  test(`unavailable ${scenario} cannot use the destination's source-path occupant`, async t => {
    const f = await fixture(t);
    let expectedReason: "missing" | "too-large" | "invalid" = "invalid";
    if (scenario === "absent-payload-array") {
      delete (f.bundle as Partial<BinySessionBundle>).attachments;
      // A descriptive manifest is not attachment identity or restoration evidence.
      f.bundle.manifest.skippedAttachments = ["unrelated manifest name"];
      expectedReason = "missing";
    } else if (scenario === "malformed-entry") {
      f.bundle.attachments = [{ sourcePath: f.reference.path, name: f.reference.name, data: false } as unknown as BinySessionBundleAttachment];
      expectedReason = "missing";
    } else if (scenario === "oversize") {
      f.bundle.attachments[0]!.size = 50 * 1024 * 1024 + 1;
      expectedReason = "too-large";
    } else if (scenario === "base64") f.bundle.attachments[0]!.data = "!!!!";
    else f.bundle.attachments[0]!.size += 1;
    const result = await f.importBundle(), user = await f.userOf(result.sessionId);
    const reference = user.attachments![0]!;
    assert.equal(result.attachmentsRestored, 0); assert.equal(result.attachmentsSkipped, 1);
    assert.deepEqual(result.skippedAttachmentIssues, [{ name: f.reference.name, reason: expectedReason }]);
    assert.notEqual(reference.path, f.reference.path);
    assert.equal(splitAttachmentReferences(user.content).attachments[0]!.path, reference.path);
    assert.equal(await readAttachment(f.target, reference), undefined);
    assert.equal((await readAttachmentBytes(f.target, f.reference.path))!.toString(), "unrelated local picture");
  });
}

test("valid payload with a content-only legacy reference preserves media and rewrites its generated list", async t => {
  const f = await fixture(t);
  f.bundle.events = [{ type: "user_message", content: withAttachmentReferences("review", [f.reference]) }];
  const result = await f.importBundle(), user = await f.userOf(result.sessionId);
  assert.equal(user.attachments, undefined);
  const reference = splitAttachmentReferences(user.content).attachments[0]!;
  assert.equal(result.attachmentsRestored, 1); assert.equal(result.attachmentsSkipped, 0);
  assert.notEqual(reference.path, f.reference.path);
  assert.equal(Buffer.from((await readAttachment(f.target, reference))!.data, "base64").toString(), "source");
});
