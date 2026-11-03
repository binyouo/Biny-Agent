import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readBrowserProfileHistory, type BrowserProfileRecord } from "../src/desktop/electron/main/browserProfileCookies.js";

async function fixture(run: (profile: BrowserProfileRecord, database: DatabaseSync) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-history-unicode-"));
  let database: DatabaseSync | undefined;
  try {
    const profilePath = path.join(root, "Default");
    await mkdir(profilePath);
    database = new DatabaseSync(path.join(profilePath, "History"));
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
    await run({ id: "chrome:Default", source: "chrome", appName: "Google Chrome", profileName: "Default", profilePath,
      keychainService: "unused", keychainAccount: "unused" }, database);
  } finally { database?.close(); await rm(root, { recursive: true, force: true }); }
}
function add(database: DatabaseSync, id: number, title: string | null, url = `https://example.test/${id}`): void {
  database.prepare("INSERT INTO urls VALUES (?, ?, ?)").run(id, url, title);
  database.prepare("INSERT INTO visits VALUES (?, ?, ?)").run(id, id, 13_380_163_200_000_000n + BigInt(id) * 1_000n);
}
for (const [title, query] of [["München Trip", "MÜNCHEN"], ["CAFÉ notes", "café"], ["ПРИВЕТ report", "привет"], ["ΑΘΗΝΑ", "αθηνα"]]) {
  test(`Unicode title lowercase matching: ${query}`, async () => fixture(async (profile, database) => {
    add(database, 1, title!);
    const result = await readBrowserProfileHistory(profile, query, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.title, title);
  }));
}
test("Unicode URL matching preserves original URL bytes", async () => fixture(async (profile, database) => {
  add(database, 1, "travel", "https://example.test/MÜNCHEN");
  assert.equal((await readBrowserProfileHistory(profile, "münchen", 10))[0]?.url, "https://example.test/MÜNCHEN");
}));
test("filter is applied before recent visit limit and preserves descending order", async () => fixture(async (profile, database) => {
  add(database, 1, "CAFÉ first"); add(database, 2, "CAFÉ second");
  for (let id = 3; id <= 12; id++) add(database, id, "unrelated");
  const result = await readBrowserProfileHistory(profile, "café", 1);
  assert.deepEqual(result.map(row => row.title), ["CAFÉ second"]);
}));
test("ASCII and literal substring punctuation retain existing semantics", async () => fixture(async (profile, database) => {
  add(database, 1, "Quarterly 100%_report 'x'"); add(database, 2, "Quarterly 100xxreport");
  assert.equal((await readBrowserProfileHistory(profile, "QUARTERLY", 10)).length, 2);
  assert.deepEqual((await readBrowserProfileHistory(profile, "%_report 'x'", 10)).map(row => row.title), ["Quarterly 100%_report 'x'"]);
}));
test("NULL title does not become literal null and no-query results remain unchanged", async () => fixture(async (profile, database) => {
  add(database, 1, null); add(database, 2, "second");
  assert.deepEqual(await readBrowserProfileHistory(profile, "null", 10), []);
  assert.deepEqual((await readBrowserProfileHistory(profile, undefined, 2)).map(row => row.title), ["second", ""]);
}));
test("lowercasing does not introduce accent removal, normalization or full case folding", async () => fixture(async (profile, database) => {
  add(database, 1, "Straße café");
  for (const query of ["STRASSE", "cafe", "cafe\u0301"]) assert.deepEqual(await readBrowserProfileHistory(profile, query, 10), []);
}));
test("live WAL search leaves source database bytes and rows intact", async () => fixture(async (profile, database) => {
  add(database, 1, "CAFÉ");
  const file = path.join(profile.profilePath, "History");
  const before = await readFile(file), wal = await readFile(`${file}-wal`);
  const rows = database.prepare("SELECT * FROM urls").all();
  assert.equal((await readBrowserProfileHistory(profile, "café", 10)).length, 1);
  assert.deepEqual(await readFile(file), before); assert.deepEqual(await readFile(`${file}-wal`), wal);
  assert.deepEqual(database.prepare("SELECT * FROM urls").all(), rows);
}));
