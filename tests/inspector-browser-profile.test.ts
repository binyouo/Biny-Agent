/** 临时 Chromium 配置验证发现和本地 Cookie 解密，不读取真实浏览器凭据。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { listBrowserProfiles, readBrowserProfileCookies } from "../src/desktop/electron/main/browserProfileCookies.js";

test("仅发现已知浏览器配置，解密其 Cookie 并忽略过期条目", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-profile-test-"));
  try {
    const browser = path.join(root, "Google", "Chrome");
    const profile = path.join(browser, "Default");
    await mkdir(path.join(profile, "Network"), { recursive: true });
    await writeFile(path.join(browser, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" }, "Profile 1": { name: "Outside" } } } }));
    await symlink(root, path.join(browser, "Profile 1"));
    const database = new DatabaseSync(path.join(profile, "Network", "Cookies"));
    database.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)");
    const key = pbkdf2Sync("test keychain value", "saltysalt", 1003, 16, "sha1");
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update("session-value", "utf8"), cipher.final()]);
    database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(".example.test", "session", "", encrypted, "/", 0, 1, 1, 1);
    const hashedCipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    const hashed = Buffer.concat([Buffer.from("v10"), hashedCipher.update(Buffer.concat([createHash("sha256").update(".example.test").digest(), Buffer.from("hashed-value")])), hashedCipher.final()]);
    database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(".example.test", "hashed", "", hashed, "/", 0, 1, 0, 1);
    database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(".example.test", "old", "expired", Buffer.alloc(0), "/", 1, 1, 0, 0);
    // Chromium 的微秒时间戳超过 JS 安全整数，真实配置会在 SQLite 读取时直接抛 RangeError。
    database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(".example.test", "future", "persistent", Buffer.alloc(0), "/", 13_454_407_831_095_631n, 1, 0, 0);
    database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(".example.test", "no-expiry", "persistent", Buffer.alloc(0), "/", 9_223_372_036_854_775_807n, 1, 0, 0);
    database.close();
    const profiles = await listBrowserProfiles(root);
    assert.deepEqual(profiles.map((item) => ({ id: item.id, appName: item.appName, profileName: item.profileName })), [{ id: "chrome:Default", appName: "Google Chrome", profileName: "Person 1" }]);
    const result = await readBrowserProfileCookies(profiles[0]!, "test keychain value");
    assert.deepEqual(result.cookies.map(({ name, value }) => ({ name, value })), [{ name: "session", value: "session-value" }, { name: "hashed", value: "hashed-value" }, { name: "future", value: "persistent" }, { name: "no-expiry", value: "persistent" }]);
    assert.equal(result.cookies.find((cookie) => cookie.name === "future")?.expirationDate, Number((13_454_407_831_095_631n - 11_644_473_600_000_000n) / 1_000_000n));
    assert.equal(result.cookies.find((cookie) => cookie.name === "no-expiry")?.expirationDate, 253_402_300_799);
    assert.equal(result.failed, 0);
    const wrongKey = await readBrowserProfileCookies(profiles[0]!, "incorrect key");
    assert.equal(wrongKey.cookies.length, 2);
    assert.equal(wrongKey.failed, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
