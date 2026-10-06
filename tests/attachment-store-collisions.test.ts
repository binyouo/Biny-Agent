import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentPathPrefix, ensureAttachmentRoot, saveAttachment } from "../src/attachments/store.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

const timestamp = 1_800_000_000_000;
const fileName = (hex: string, name = "note.txt") => `${timestamp}-${hex}-${name}`;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-attachment-collisions-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const directory = await ensureAttachmentRoot(workspace);
  return { root, workspace, directory };
}

function names(t: TestContext, hexes: string[]) {
  t.mock.method(Date, "now", () => timestamp);
  let index = 0;
  const random = t.mock.method(crypto, "randomBytes", (size: number) => {
    assert.equal(size, 3);
    const hex = hexes[index++];
    assert.ok(hex, "unexpected extra attachment name generation");
    return Buffer.from(hex, "hex");
  });
  syncBuiltinESMExports();
  return random;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("saveAttachment retains metadata, name sanitization, bytes and private file mode", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["folder/a b(1).txt", "a_b_1_.txt"], ["中文.txt", "中文.txt"],
    ["", "attachment"], [".", "attachment"], ["..", "attachment"],
    ["a".repeat(190), "a".repeat(180)], ["x..y.txt", "x..y.txt"]
  ];
  names(t, cases.map((_, index) => index.toString(16).padStart(6, "0")));
  for (const [index, [input, safeName]] of cases.entries()) {
    assert.ok(input !== undefined && safeName !== undefined);
    const bytes = index === 0 ? new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4) : new Uint8Array();
    const reference = await saveAttachment(f.workspace, input, "application/x-test", bytes);
    const generated = fileName(index.toString(16).padStart(6, "0"), safeName);
    assert.deepEqual(reference, { name: safeName, mimeType: "application/x-test", path: `${attachmentPathPrefix}${generated}`, size: bytes.byteLength });
    assert.deepEqual(await fs.readFile(path.join(f.directory, generated)), Buffer.from(bytes));
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(f.directory, generated))).mode & 0o777, 0o600 & ~process.umask());
  }
});

test("saveAttachment retries an occupied file without changing its bytes or mode", async (t) => {
  const f = await fixture(t);
  const occupied = path.join(f.directory, fileName("000001"));
  await fs.writeFile(occupied, "existing attachment", { mode: 0o640 });
  const before = await fs.stat(occupied);
  const random = names(t, ["000001", "000002"]);
  const bytes = Buffer.from("new attachment");
  const reference = await saveAttachment(f.workspace, "note.txt", "text/plain", bytes);
  assert.equal(await fs.readFile(occupied, "utf8"), "existing attachment");
  assert.equal((await fs.stat(occupied)).mode, before.mode);
  assert.equal(reference.path, `${attachmentPathPrefix}${fileName("000002")}`);
  assert.deepEqual(reference, { name: "note.txt", mimeType: "text/plain", path: reference.path, size: bytes.byteLength });
  assert.deepEqual(await fs.readFile(path.join(f.directory, fileName("000002"))), bytes);
  assert.equal(random.mock.callCount(), 2);
});

for (const dangling of [false, true]) {
  test(`saveAttachment never follows an occupied ${dangling ? "dangling " : ""}symlink`, async (t) => {
    const f = await fixture(t);
    const target = path.join(f.root, "target.txt");
    if (!dangling) await fs.writeFile(target, "target content");
    const occupied = path.join(f.directory, fileName("000001"));
    await fs.symlink(target, occupied);
    names(t, ["000001", "000002"]);
    const reference = await saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("new attachment"));
    assert.equal(await fs.readlink(occupied), target);
    if (dangling) await assert.rejects(fs.stat(target), { code: "ENOENT" });
    else assert.equal(await fs.readFile(target, "utf8"), "target content");
    assert.equal(reference.path, `${attachmentPathPrefix}${fileName("000002")}`);
    assert.equal(await fs.readFile(path.join(f.directory, fileName("000002")), "utf8"), "new attachment");
  });
}

test("saveAttachment retries after a concurrent save claims the selected name", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const selected = path.join(f.directory, fileName("000001"));
  const random = names(t, ["000001", "000001", "000002"]);
  const selectedGate = gate();
  const claimedGate = gate();
  t.after(() => claimedGate.resolve());
  const writeFile = fs.writeFile;
  let first = true;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === selected && first) {
      first = false;
      selectedGate.resolve();
      await claimedGate.promise;
    }
    await writeFile(...args);
  });
  const pending = saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("first caller"));
  await selectedGate.promise;
  let claimant;
  try { claimant = await saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("second caller")); }
  finally { claimedGate.resolve(); }
  const retried = await pending;
  assert.equal(await fs.readFile(selected, "utf8"), "second caller");
  assert.equal(claimant.path, `${attachmentPathPrefix}${fileName("000001")}`);
  assert.equal(retried.path, `${attachmentPathPrefix}${fileName("000002")}`);
  assert.equal(await fs.readFile(path.join(f.directory, fileName("000002")), "utf8"), "first caller");
  assert.equal(random.mock.callCount(), 3);
});

test("saveAttachment stops after ten collisions and preserves every occupied file", async (t) => {
  const f = await fixture(t);
  const hexes = Array.from({ length: 11 }, (_, index) => index.toString(16).padStart(6, "0"));
  for (const hex of hexes.slice(0, 10)) await fs.writeFile(path.join(f.directory, fileName(hex)), `existing ${hex}`);
  const random = names(t, hexes);
  const writeFile = fs.writeFile;
  let lastError: unknown;
  const writes = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    try { await writeFile(...args); }
    catch (error) { lastError = error; throw error; }
  });
  await assert.rejects(saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("new attachment")), error => {
    assert.equal(error, lastError);
    assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
    assert.equal((error as NodeJS.ErrnoException).path, path.join(f.directory, fileName(hexes[9]!)));
    return true;
  });
  assert.equal(writes.mock.callCount(), 10);
  assert.equal(random.mock.callCount(), 10);
  for (const hex of hexes.slice(0, 10)) assert.equal(await fs.readFile(path.join(f.directory, fileName(hex)), "utf8"), `existing ${hex}`);
  await assert.rejects(fs.stat(path.join(f.directory, fileName(hexes[10]!))), { code: "ENOENT" });
});

test("saveAttachment can succeed on the final allowed attempt", async (t) => {
  const f = await fixture(t);
  const hexes = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(6, "0"));
  for (const hex of hexes.slice(0, 9)) await fs.writeFile(path.join(f.directory, fileName(hex)), `existing ${hex}`);
  const random = names(t, hexes);
  const reference = await saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("new attachment"));
  assert.equal(reference.path, `${attachmentPathPrefix}${fileName(hexes[9]!)}`);
  assert.equal(await fs.readFile(path.join(f.directory, fileName(hexes[9]!)), "utf8"), "new attachment");
  assert.equal(random.mock.callCount(), 10);
  for (const hex of hexes.slice(0, 9)) assert.equal(await fs.readFile(path.join(f.directory, fileName(hex)), "utf8"), `existing ${hex}`);
});

for (const code of ["EACCES", "ENOSPC", "EIO", undefined]) {
  test(`saveAttachment propagates ${code ?? "an uncoded error"} without retry or cleanup`, async (t) => {
    const f = await fixture(t);
    const random = names(t, ["000001", "000002"]);
    const failure = Object.assign(new Error("injected write failure"), { code });
    const writeFile = fs.writeFile;
    const writes = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      // A late write failure may leave a partial file. This change must not delete it.
      if (code === "EIO") await writeFile(args[0], "partial", args[2]);
      throw failure;
    });
    await assert.rejects(saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("new attachment")), error => error === failure);
    assert.equal(writes.mock.callCount(), 1);
    assert.equal(random.mock.callCount(), 1);
    if (code === "EIO") assert.equal(await fs.readFile(path.join(f.directory, fileName("000001")), "utf8"), "partial");
  });
}

test("saveAttachment stops retrying when a collision is followed by another I/O error", async (t) => {
  const f = await fixture(t);
  const occupied = path.join(f.directory, fileName("000001"));
  await fs.writeFile(occupied, "existing attachment");
  const random = names(t, ["000001", "000002", "000003"]);
  const failure = Object.assign(new Error("injected disk failure after collision"), { code: "ENOSPC" });
  const writeFile = fs.writeFile;
  const writes = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] !== occupied) throw failure;
    await writeFile(...args);
  });
  await assert.rejects(saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("new attachment")), error => error === failure);
  assert.equal(writes.mock.callCount(), 2);
  assert.equal(random.mock.callCount(), 2);
  assert.equal(await fs.readFile(occupied, "utf8"), "existing attachment");
});

test("saveAttachment does not retry name-generation errors", async (t) => {
  const f = await fixture(t);
  const failure = Object.assign(new Error("injected entropy failure"), { code: "EEXIST" });
  const random = t.mock.method(crypto, "randomBytes", () => { throw failure; });
  syncBuiltinESMExports();
  await assert.rejects(saveAttachment(f.workspace, "note.txt", "text/plain", Buffer.from("new attachment")), error => error === failure);
  assert.equal(random.mock.callCount(), 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
});
