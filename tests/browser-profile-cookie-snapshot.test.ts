/** Real temporary SQLite only; plaintext synthetic cookies, no browser or Keychain access. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import sqlite, { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { BrowserProfileRecord } from "../src/desktop/electron/main/browserProfileCookies.js";

// Wrap only the SQLite backup export used by the real importer. Native SQLite,
// source files and the complete production module remain real.
const sqliteBoundary = "data:text/javascript," + encodeURIComponent(`
  import sqlite from 'node:sqlite';
  export const DatabaseSync = sqlite.DatabaseSync;
  export const backup = (...args) => sqlite.backup(...args);
`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:sqlite" && context.parentURL?.includes("browserProfileCookies")) {
      return { url: sqliteBoundary, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
const { readBrowserProfileCookies } = await (async () => {
  try { return await import("../src/desktop/electron/main/browserProfileCookies.js"); }
  finally { hooks.deregister(); }
})();

async function fixture(t: TestContext, wal: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cookie-snapshot-"));
  const source = path.join(root, "Cookies");
  const database = new DatabaseSync(source);
  t.after(async () => { t.mock.restoreAll(); database.close(); await fs.rm(root, { recursive: true, force: true }); });
  database.exec(`PRAGMA journal_mode=${wal ? "WAL" : "DELETE"}; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER)`);
  const insert = database.prepare("INSERT INTO cookies VALUES ('example.invalid',?, ?,X'', '/',0,1,1,1)");
  insert.run("old", "synthetic-old");
  if (wal) database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  insert.run("new", "synthetic-new");
  const profile: BrowserProfileRecord = { id: "synthetic", source: "synthetic", appName: "synthetic", profileName: "synthetic", profilePath: root, keychainService: "unused", keychainAccount: "unused" };
  const before = database.prepare("SELECT * FROM cookies ORDER BY name").all();
  const temporary: string[] = [];
  const mkdtemp = fs.mkdtemp;
  t.mock.method(fs, "mkdtemp", async (...args: Parameters<typeof fs.mkdtemp>) => {
    const directory = await mkdtemp(...args);
    if (typeof directory === "string" && String(args[0]).includes("biny-cookie-import-")) temporary.push(directory);
    return directory;
  });
  return {
    source, database, profile,
    async unchangedAndClean() {
      assert.deepEqual(database.prepare("SELECT * FROM cookies ORDER BY name").all(), before);
      assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.ok(temporary.length > 0);
      for (const directory of temporary) await assert.rejects(fs.stat(directory), { code: "ENOENT" });
    }
  };
}

for (const wal of [false, true]) test(`reads complete stable ${wal ? "WAL" : "rollback-journal"} database`, async t => {
  const f = await fixture(t, wal);
  const result = await readBrowserProfileCookies(f.profile, "synthetic-unused");
  assert.deepEqual(Array.from(result.cookies, cookie => cookie.name).sort(), ["new", "old"]);
  assert.equal(result.failed, 0);
  await f.unchangedAndClean();
});

test("checkpoint during snapshot creation cannot omit already committed cookies", async t => {
  const f = await fixture(t, true);
  // Both rows exist before the call. Checkpoint changes physical storage only.
  const originalCopy = fs.copyFile;
  const originalBackup = sqlite.backup;
  let checkpoints = 0;
  const checkpoint = () => { f.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); checkpoints++; };
  t.mock.method(fs, "copyFile", async (...args: Parameters<typeof fs.copyFile>) => {
    const result = await originalCopy(...args);
    if (args[0] === f.source) checkpoint();
    return result;
  });
  t.mock.method(sqlite, "backup", async (...args: Parameters<typeof sqlite.backup>) => {
    checkpoint();
    return await originalBackup(...args);
  });
 
  const result = await readBrowserProfileCookies(f.profile, "synthetic-unused");
  assert.equal(checkpoints, 1);
  await f.unchangedAndClean();
  assert.deepEqual(Array.from(result.cookies, cookie => cookie.name).sort(), ["new", "old"]);
  assert.equal(result.failed, 0);
});

for (const failureAt of ["backup", "copy-open"] as const) test(`${failureAt} failure closes databases and removes temporary snapshot`, async t => {
  const f = await fixture(t, true);
  const failure = new Error(`Synthetic ${failureAt} failure`);
  const originalBackup = sqlite.backup;
  let sourceConnection: DatabaseSync | undefined;
  t.mock.method(sqlite, "backup", async (...args: Parameters<typeof sqlite.backup>) => {
    sourceConnection = args[0];
    if (failureAt === "backup") throw failure;
    const result = await originalBackup(...args);
    // Remove only the private completed snapshot, making read-only open fail.
    await fs.unlink(String(args[1]));
    return result;
  });
 
  if (failureAt === "backup") await assert.rejects(readBrowserProfileCookies(f.profile, "synthetic-unused"), error => error === failure);
  else await assert.rejects(readBrowserProfileCookies(f.profile, "synthetic-unused"));
  const closedSource = sourceConnection;
  assert.ok(closedSource);
  assert.throws(() => closedSource.prepare("SELECT 1"), /not open|closed/iu);
  await f.unchangedAndClean();
});
