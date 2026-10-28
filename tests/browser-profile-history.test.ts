import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readBrowserProfileHistory, type BrowserProfileRecord } from "../src/desktop/electron/main/browserProfileCookies.js";

test("reads bounded Chromium visit history from a live WAL database and filters URL or title", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-profile-history-"));
  try {
    const profilePath = path.join(root, "Default");
    await mkdir(profilePath);
    const database = new DatabaseSync(path.join(profilePath, "History"));
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
    const older = BigInt(Date.parse("2026-01-01T00:00:00.000Z")) * 1_000n + 11_644_473_600_000_000n;
    const newer = BigInt(Date.parse("2026-02-01T00:00:00.000Z")) * 1_000n + 11_644_473_600_000_000n;
    database.prepare("INSERT INTO urls VALUES (?, ?, ?)").run(1, "https://github.com/openai", "OpenAI on GitHub");
    database.prepare("INSERT INTO urls VALUES (?, ?, ?)").run(2, "https://example.test/report", "Quarterly report");
    database.prepare("INSERT INTO visits VALUES (?, ?, ?)").run(1, 1, older);
    database.prepare("INSERT INTO visits VALUES (?, ?, ?)").run(2, 2, newer);
    database.prepare("INSERT INTO visits VALUES (?, ?, ?)").run(3, 1, newer + 1_000n);
    const profile: BrowserProfileRecord = {
      id: "chrome:Default", source: "chrome", appName: "Google Chrome", profileName: "Default",
      profilePath, keychainService: "unused", keychainAccount: "unused"
    };
    try {
      const recent = await readBrowserProfileHistory(profile, undefined, 2);
      assert.deepEqual(recent, [
        { url: "https://github.com/openai", title: "OpenAI on GitHub", visitedAt: "2026-02-01T00:00:00.001Z" },
        { url: "https://example.test/report", title: "Quarterly report", visitedAt: "2026-02-01T00:00:00.000Z" }
      ]);
      assert.deepEqual(await readBrowserProfileHistory(profile, "GITHUB", 10), [
        { url: "https://github.com/openai", title: "OpenAI on GitHub", visitedAt: "2026-02-01T00:00:00.001Z" },
        { url: "https://github.com/openai", title: "OpenAI on GitHub", visitedAt: "2026-01-01T00:00:00.000Z" }
      ]);
      assert.deepEqual(await readBrowserProfileHistory(profile, "quarterly", 10), [
        { url: "https://example.test/report", title: "Quarterly report", visitedAt: "2026-02-01T00:00:00.000Z" }
      ]);
      await assert.rejects(readBrowserProfileHistory(profile, " ", 10), /搜索词长度/u);
      await assert.rejects(readBrowserProfileHistory(profile, undefined, 101), /条数/u);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a Chromium History database symlink outside the profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-profile-history-link-"));
  try {
    const profilePath = path.join(root, "Default");
    const outside = path.join(root, "outside");
    await mkdir(profilePath);
    const database = new DatabaseSync(outside);
    database.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
    database.close();
    await symlink(outside, path.join(profilePath, "History"));
    const profile: BrowserProfileRecord = {
      id: "chrome:Default", source: "chrome", appName: "Google Chrome", profileName: "Default",
      profilePath, keychainService: "unused", keychainAccount: "unused"
    };
    await assert.rejects(readBrowserProfileHistory(profile, undefined, 10), /没有历史记录数据库/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
