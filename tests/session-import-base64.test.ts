/** Synthetic local bundle roundtrips and compatibility with the former Base64 grammar. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { attachmentRoot, readAttachmentBytes, saveAttachment, type AttachmentReference } from "../src/attachments/store.js";
import { refreshSessionIndex } from "../src/session/catalog.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs, listSessionFiles } from "../src/session/store.js";
import { BINY_BUNDLE_ATTACHMENT_LIMIT, BINY_BUNDLE_FORMAT, BINY_BUNDLE_VERSION, exportSessionBundle,
  importSessionFile, type BinySessionBundle, type BinySessionBundleAttachment } from "../src/session/transfer.js";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-base64-grammar-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await ensureAgentDirs(source);
  await ensureAgentDirs(target);
  t.after(async () => {
    t.mock.restoreAll();
    // Imports schedule an index refresh; drain it before removing synthetic state.
    await Promise.all([refreshSessionIndex(source), refreshSessionIndex(target)]);
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, source, target, file: path.join(root, "bundle.json") };
}

function attachment(data: string, index: number): BinySessionBundleAttachment {
  const bytes = Buffer.from(data, "base64");
  return { name: `fixture-${index}.bin`, mimeType: "application/octet-stream", sourcePath: `@attachments/fixture-${index}.bin`,
    size: bytes.length, data, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function bundle(attachments: BinySessionBundleAttachment[]): BinySessionBundle {
  return {
    format: BINY_BUNDLE_FORMAT, version: BINY_BUNDLE_VERSION,
    manifest: { sessionId: "synthetic", exportedAt: "2026-10-08T00:00:00Z", eventCount: 1,
      attachmentCount: attachments.length, skippedAttachments: [] },
    events: [{ type: "user_message", content: "synthetic attachment validation", attachments: attachments.map((item) =>
      ({ name: item.name, mimeType: item.mimeType, path: item.sourcePath })) }],
    attachments
  };
}

// The previous production predicate is safe as an oracle only for these short cases.
function oldGrammar(value: string): boolean {
  assert.ok(value.length <= 256, "never run the repeated-group oracle on large data");
  return value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

async function checkGrammar(t: TestContext, values: readonly string[]): Promise<void> {
  const f = await fixture(t);
  const entries = values.map(attachment);
  const accepted = values.map(oldGrammar);
  await fs.writeFile(f.file, JSON.stringify(bundle(entries)));
  const imported = await importSessionFile(f.target, f.file);
  assert.equal(imported.attachmentsRestored, accepted.filter(Boolean).length);
  assert.equal(imported.attachmentsSkipped, accepted.filter((value) => !value).length);
  assert.deepEqual(imported.skippedAttachmentIssues, entries.flatMap((entry, index) =>
    accepted[index] ? [] : [{ name: entry.name, reason: "invalid" }]));
  const { events } = await readStoredSessionEvents(f.target, imported.sessionId);
  const event = events.find((entry) => entry.type === "user_message");
  assert.ok(event?.type === "user_message");
  assert.equal(event.attachments?.length, entries.length);
  for (const [index, entry] of entries.entries()) {
    const reference: AttachmentReference | undefined = event.attachments?.[index];
    assert.ok(reference);
    if (accepted[index]) {
      assert.notEqual(reference.path, entry.sourcePath);
      assert.deepEqual(await readAttachmentBytes(f.target, reference.path), Buffer.from(entry.data, "base64"));
    } else {
      assert.equal(reference.path, entry.sourcePath, `invalid case ${JSON.stringify(values[index])} must not be remapped`);
      assert.equal(await readAttachmentBytes(f.target, reference.path), undefined);
    }
  }
}

test("public import matches the old grammar exhaustively for short alphabet/padding/whitespace strings", async (t) => {
  const values = [""];
  let level = [""];
  for (let length = 1; length <= 5; length += 1) {
    level = level.flatMap((prefix) => ["A", "/", "=", "\n"].map((character) => prefix + character));
    values.push(...level);
  }
  assert.equal(values.length, 1365);
  await checkGrammar(t, values);
});

test("public import preserves alphabet, Unicode rejection, padding and noncanonical pad-bit acceptance", async (t) => {
  const values = ["", "AA==", "AB==", "A/==", "AAA=", "AAB=", "AA/=", "AAAA", "/+/+", "====", "A===", "=AAA",
    "A=AA", "AA=A", "AA==AAAA", "AAA=AAAA", "AAA", "AA", "A", "AAAA=", "AAAA==", "AAAA===", "AAAA====",
    "AAAA\n", "AAAA\r\n", "AA==\n", "AAA=\r", "AAAA\u2028", "AAAA\u2029"];
  // Every ASCII/Latin-1 byte in each quartet position, plus non-BMP/unpaired UTF-16.
  for (let code = 0; code <= 255; code += 1) {
    for (let index = 0; index < 4; index += 1) {
      values.push("AAAA".slice(0, index) + String.fromCharCode(code) + "AAAA".slice(index + 1));
    }
  }
  for (const character of ["中", "😀", "\ud800", "\udfff", "\u2028", "\u2029", "\ufeff", "\u200b"]) {
    values.push(`AAA${character}`, `${character}AAA`, `AAAA${character}`, `AA${character}=`);
  }
  assert.equal(oldGrammar("AB=="), true);
  assert.equal(oldGrammar("AAB="), true);
  await checkGrammar(t, values);
});

test("seeded multi-quartet cases keep the previous public acceptance language", async (t) => {
  let state = 0x6519a3d2;
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: string[] = [];
  for (let sample = 0; sample < 128; sample += 1) {
    const length = 4 * (1 + next() % 16);
    let value = "";
    for (let index = 0; index < length; index += 1) value += alphabet[next() % alphabet.length];
    const padding = sample % 3;
    if (padding > 0) value = value.slice(0, -padding) + "=".repeat(padding);
    values.push(value, value.slice(0, -1), value + "=", value.slice(0, -1) + "!", "_" + value.slice(1));
  }
  assert.equal(values.length, 640);
  await checkGrammar(t, values);
});

for (const extra of [0, 1, 2]) {
  test(`public export/import roundtrips 6 MiB + ${extra} bytes without a regexp stack failure`, async (t) => {
    const f = await fixture(t);
    const bytes = Buffer.alloc(6 * 1024 * 1024 + extra, 0x41);
    const reference = await saveAttachment(f.source, "valid-large.bin", "application/octet-stream", bytes);
    const recorder = new SessionRecorder(f.source, "large-base64-roundtrip");
    try { await recorder.recordAndFlush({ type: "user_message", content: "synthetic roundtrip", attachments: [reference] }); }
    finally { await recorder.close(); }
    const before = await fs.readFile(recorder.filePath);
    const exported = await exportSessionBundle(f.source, recorder.sessionId);
    const original = JSON.parse(exported.content) as BinySessionBundle;
    const item = original.attachments[0];
    assert.ok(item);
    assert.equal(item.data.length, 4 * Math.ceil(bytes.length / 3));
    assert.equal(item.data.endsWith("=="), extra === 1);
    assert.equal(item.data.endsWith("="), extra !== 0);
    await fs.writeFile(f.file, exported.content);
    const imported = await importSessionFile(f.target, f.file);
    assert.equal(imported.attachmentsRestored, 1);
    assert.equal(imported.attachmentsSkipped, 0);
    assert.deepEqual(imported.skippedAttachmentIssues, []);
    const { events } = await readStoredSessionEvents(f.target, imported.sessionId);
    const event = events.find((entry) => entry.type === "user_message");
    assert.ok(event?.type === "user_message");
    const restored = event.attachments?.[0];
    assert.ok(restored);
    assert.notEqual(restored.path, reference.path);
    assert.deepEqual(await readAttachmentBytes(f.target, restored.path), bytes);
    const reexported = JSON.parse((await exportSessionBundle(f.target, imported.sessionId)).content) as BinySessionBundle;
    assert.equal(reexported.attachments[0]?.data, item.data);
    assert.equal(reexported.attachments[0]?.sha256, item.sha256);
    assert.deepEqual(await fs.readFile(recorder.filePath), before);
    assert.equal(await fs.readFile(f.file, "utf8"), exported.content);
  });
}

test("large malformed near-end data and checksum/size damage skip independently without aborting the session", async (t) => {
  const f = await fixture(t);
  const valid = attachment(Buffer.alloc(6 * 1024 * 1024, 0x42).toString("base64"), 0);
  const entries = [
    valid,
    { ...valid, name: "bad-near-end.bin", sourcePath: "@attachments/bad-near-end.bin", data: valid.data.slice(0, -4) + "AA!A" },
    { ...attachment("YQ==", 2), size: 2 },
    { ...attachment("Yg==", 3), sha256: "0".repeat(64) },
    { ...attachment("Yw==", 4), sha256: "G".repeat(64) },
    { ...attachment("ZA==", 5), size: -1 },
    { ...attachment("ZQ==", 6), size: 0.5 },
    { ...attachment("Zg==", 7), size: BINY_BUNDLE_ATTACHMENT_LIMIT },
    { ...attachment("Zw==", 8), size: BINY_BUNDLE_ATTACHMENT_LIMIT + 1 },
    attachment("", 9)
  ];
  await fs.writeFile(f.file, JSON.stringify(bundle(entries)));
  const imported = await importSessionFile(f.target, f.file);
  assert.equal(imported.attachmentsRestored, 2);
  assert.equal(imported.attachmentsSkipped, 8);
  assert.deepEqual(imported.skippedAttachmentIssues, entries.slice(1, -1).map((item, index) =>
    ({ name: item.name, reason: index === 7 ? "too-large" : "invalid" })));
  const exported = JSON.parse((await exportSessionBundle(f.target, imported.sessionId)).content) as BinySessionBundle;
  assert.deepEqual(exported.attachments.map((item) => [item.name, item.sha256, item.size]),
    [valid, entries[9]!].map((item) => [item.name, item.sha256, item.size]));
});

test("encoded data above the existing cap stays too-large before Base64 decoding", async (t) => {
  const f = await fixture(t);
  const encodedLimit = Math.ceil(BINY_BUNDLE_ATTACHMENT_LIMIT / 3) * 4;
  const item = { ...attachment("", 0), data: "!".repeat(encodedLimit + 4) };
  await fs.writeFile(f.file, JSON.stringify(bundle([item])));
  const imported = await importSessionFile(f.target, f.file);
  assert.equal(imported.attachmentsRestored, 0);
  assert.equal(imported.attachmentsSkipped, 1);
  assert.deepEqual(imported.skippedAttachmentIssues, [{ name: item.name, reason: "too-large" }]);
  assert.deepEqual(await fs.readdir(attachmentRoot(f.target)), []);
});

test("session creation failure rolls back a provisionally restored 6 MiB attachment and preserves history", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(6 * 1024 * 1024, 0x43);
  const entries = [attachment(bytes.toString("base64"), 0), attachment("bGFzdA==", 1)];
  await fs.writeFile(f.file, JSON.stringify(bundle(entries)));
  const directory = attachmentRoot(f.target);
  const historical = path.join(directory, "historical.bin");
  await fs.writeFile(historical, "preserved historical bytes");
  const open = fs.open;
  const failure = new Error("synthetic session creation failure");
  let stagedFiles = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = String(args[0]);
    if (file.endsWith(".jsonl")) throw failure;
    if (file.startsWith(directory + path.sep) && !file.includes(`${path.sep}.cleanup-`)) stagedFiles += 1;
    return await open(...args);
  });
  await assert.rejects(importSessionFile(f.target, f.file), (error: unknown) => error === failure);
  assert.equal(stagedFiles, 2, "both valid attachments were staged before the session failure");
  assert.deepEqual(await fs.readdir(directory), ["historical.bin"]);
  assert.equal(await fs.readFile(historical, "utf8"), "preserved historical bytes");
  assert.deepEqual(await listSessionFiles(f.target), []);
});
