import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DesktopSafeStorageCredentialStore, type SafeStorageCipher } from "../src/desktop/electron/main/DesktopSafeStorageCredentialStore.js";

const account = "provider:synthetic:apiKey";
const encoded = (value: string): string => Buffer.from(JSON.stringify({ [account]: value }).split("").reverse().join("")).toString("base64");
const fixtureCipher = (calls: string[], available = true): SafeStorageCipher => ({
  isAvailable: () => { calls.push("available"); return available; },
  encrypt: plain => { calls.push("encrypt"); return Buffer.from(plain.split("").reverse().join("")); },
  decrypt: payload => { calls.push("decrypt"); return payload.toString().split("").reverse().join(""); }
});

test("missing credential file returns empty without importing or querying safeStorage", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-empty-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  let sourceCalls = 0;
  const store = new DesktopSafeStorageCredentialStore(root, () => { sourceCalls++; throw new Error("Keychain must not be contacted for a missing file"); });
  assert.equal(await store.get(account), undefined);
  assert.equal(await store.get(account), undefined);
  assert.equal(sourceCalls, 0);
});

test("existing encrypted credentials retain availability checking, decryption and revision caching", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-valid-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "credentials.enc"), encoded("synthetic-value"));
  const calls: string[] = [];
  const store = new DesktopSafeStorageCredentialStore(root, () => { calls.push("source"); return fixtureCipher(calls); });
  assert.equal(await store.get(account), "synthetic-value");
  assert.equal(await store.get(account), "synthetic-value");
  assert.deepEqual(calls, ["source", "available", "decrypt"]);
});

test("existing damaged or denied ciphertext is never converted into an empty store", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-invalid-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "credentials.enc");
  await fs.writeFile(file, "damaged-ciphertext");
  const unavailable: string[] = [];
  await assert.rejects(new DesktopSafeStorageCredentialStore(root, () => fixtureCipher(unavailable, false)).get(account), /系统加密存储不可用/);
  assert.deepEqual(unavailable, ["available"]);
  const damaged: string[] = [];
  await assert.rejects(new DesktopSafeStorageCredentialStore(root, () => fixtureCipher(damaged)).get(account), /模型凭据解密失败/);
  assert.deepEqual(damaged, ["available", "decrypt"]);
  const denied: SafeStorageCipher = { ...fixtureCipher([]), decrypt: () => { throw new Error("synthetic permission denied"); } };
  await assert.rejects(new DesktopSafeStorageCredentialStore(root, () => denied).get(account), /模型凭据解密失败.*permission denied/);
  await assert.rejects(new DesktopSafeStorageCredentialStore(root, () => { throw new Error("synthetic authentication refused"); }).get(account), /authentication refused/);
  // An existing empty file also keeps the previous availability policy.
  await fs.writeFile(file, "");
  await assert.rejects(new DesktopSafeStorageCredentialStore(root, () => fixtureCipher([], false)).get(account), /系统加密存储不可用/);
});

test("filesystem read/stat permission denial propagates without a Keychain query or an empty fallback", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-denied-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "credentials.enc");
  await fs.writeFile(file, encoded("synthetic-value"));
  let sourceCalls = 0;
  const store = new DesktopSafeStorageCredentialStore(root, () => { sourceCalls++; throw new Error("Do not contact Keychain after filesystem denial"); });
  const denied = Object.assign(new Error("synthetic filesystem denial"), { code: "EACCES" });
  const read = t.mock.method(fs, "readFile", async (...args: unknown[]) => { assert.equal(args[0], file); throw denied; });
  await assert.rejects(store.get(account), error => error === denied);
  assert.equal(sourceCalls, 0); read.mock.restore();
  t.mock.method(fs, "stat", async (...args: unknown[]) => { assert.equal(args[0], file); throw denied; });
  await assert.rejects(store.get(account), error => error === denied);
  assert.equal(sourceCalls, 0);
});

test("a file appearing between missing stat and actual read still requires decryption", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-appearing-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "credentials.enc");
  const originalStat = fs.stat.bind(fs);
  let appeared = false;
  t.mock.method(fs, "stat", async (...args: unknown[]) => {
    assert.equal(args[0], file);
    try { return await originalStat(file, { bigint: true }); }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      appeared = true; await fs.writeFile(file, encoded("concurrent-synthetic")); throw error;
    }
  });
  const calls: string[] = [];
  const store = new DesktopSafeStorageCredentialStore(root, () => fixtureCipher(calls));
  assert.equal(await store.get(account), "concurrent-synthetic");
  assert.equal(appeared, true); assert.deepEqual(calls, ["available", "decrypt"]);
});

test("a cached missing file never conceals a later valid or damaged credential file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-missing-cache-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "credentials.enc");
  const calls: string[] = [];
  const store = new DesktopSafeStorageCredentialStore(root, () => fixtureCipher(calls));
  assert.equal(await store.get(account), undefined); assert.deepEqual(calls, []);
  await fs.writeFile(file, encoded("later-synthetic"));
  assert.equal(await store.get(account), "later-synthetic"); assert.deepEqual(calls, ["available", "decrypt"]);
  await fs.rm(file); assert.equal(await store.get(account), undefined);
  await fs.writeFile(file, "damaged-later");
  await assert.rejects(store.get(account), /模型凭据解密失败/);
});

test("a file appearing after ENOENT is observed by the next read without a poisoned empty cache", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-read-race-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "credentials.enc");
  const originalRead = fs.readFile.bind(fs);
  let first = true;
  t.mock.method(fs, "readFile", async (...args: unknown[]) => {
    assert.equal(args[0], file);
    if (!first) return await originalRead(file, "utf8");
    first = false;
    try { return await originalRead(file, "utf8"); }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      await fs.writeFile(file, encoded("appeared-after-read")); throw error;
    }
  });
  const calls: string[] = [];
  const store = new DesktopSafeStorageCredentialStore(root, () => fixtureCipher(calls));
  assert.equal(await store.get(account), undefined); assert.deepEqual(calls, []);
  assert.equal(await store.get(account), "appeared-after-read"); assert.deepEqual(calls, ["available", "decrypt"]);
});

test("first credential write still requires availability and encryption, and refusal writes no plaintext", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-new-credentials-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "credentials.enc");
  const refused = new DesktopSafeStorageCredentialStore(root, () => fixtureCipher([], false));
  await assert.rejects(refused.set(account, "synthetic-value"), /系统加密存储不可用/);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  const deniedCipher: SafeStorageCipher = { ...fixtureCipher([]), encrypt: () => { throw new Error("synthetic encryption permission refused"); } };
  await assert.rejects(new DesktopSafeStorageCredentialStore(root, () => deniedCipher).set(account, "synthetic-value"), /encryption permission refused/);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  const calls: string[] = [];
  const store = new DesktopSafeStorageCredentialStore(root, () => fixtureCipher(calls));
  await store.set(account, "synthetic-value");
  assert.deepEqual(calls, ["available", "encrypt"]);
  assert.equal((await fs.readFile(file, "utf8")).includes("synthetic-value"), false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
