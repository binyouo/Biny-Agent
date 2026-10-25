/** Actual importer with inert boundaries: no product imports, profile I/O, SQLite or cryptography. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const sourcePath = new URL("../src/desktop/electron/main/browserProfileCookies.ts", import.meta.url);
const sourceText = readFileSync(sourcePath, "utf8");
const source = ts.createSourceFile(sourcePath.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["readBrowserProfileCookies", "isNotFound"];
const functions = names.map(name => {
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `exactly one ${name}`);
  assert.ok(matches[0]?.body);
  return matches[0];
});
const allowedCalls = new Set([
  "cookieDatabasePath", "fs.mkdtemp", "path.join", "os.tmpdir", "fs.copyFile", "isNotFound",
  "database.prepare", "database.prepare(\"SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite FROM cookies LIMIT 100000\").all",
  "pbkdf2Sync", "Date.now", "/^[.]?[a-z\\d-]+(?:\\.[a-z\\d-]+)*$/iu.test", "BigInt", "Math.min", "Number",
  "Buffer.from", "Buffer.alloc", "decryptCookie", "cookies.push", "row.path.startsWith", "domain.startsWith", "database?.close", "fs.rm"
]);
function inspect(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `unexpected call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.ok(["Error", "DatabaseSync"].includes(node.expression.getText(source)), "unexpected constructor");
  if (ts.isIdentifier(node)) assert.ok(!["require", "eval", "process", "globalThis", "fetch", "createDecipheriv", "createHash"].includes(node.text), "unexpected capability");
  ts.forEachChild(node, inspect);
}
functions.forEach(inspect);
// Keep full function text; remove only its module export keyword and erasable types.
const extracted = functions.map(node => node.getText(source).replace(/^export /u, "")).join("\n");
const executable = stripTypeScriptTypes(`${extracted}\nreadBrowserProfileCookies;`, { mode: "strip" });

interface ResultCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  expirationDate?: number;
  hostOnly: boolean;
}
interface ImportResult { cookies: ResultCookie[]; failed: number }
type Importer = (profile: Readonly<{ profilePath: string }>, secret: string) => Promise<ImportResult>;
type Row = Readonly<Record<string, unknown>>;
const now = 1_800_000_000.5;
const profilePath = "/synthetic/profile";
const databasePath = "/synthetic/profile/Cookies";
const temporaryPath = "/synthetic/tmp/biny-cookie-import-fixed";
const copiedPath = `${temporaryPath}/Cookies`;
const secret = "synthetic-no-secret";
const query = "SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite FROM cookies LIMIT 100000";
function row(expires: string, overrides: Record<string, unknown> = {}): Row {
  return Object.freeze({ host_key: "example.test", name: "session", value: "plain", encrypted_value: Object.freeze(new Uint8Array()), path: "/", expires_utc: expires, is_secure: 1, is_httponly: 1, samesite: 1, ...overrides });
}
function expected(expirationDate: number | undefined, overrides: Partial<ResultCookie> = {}): ResultCookie {
  return { name: "session", value: "plain", domain: "example.test", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate, hostOnly: true, ...overrides };
}
async function read(rowsInput: readonly Row[]): Promise<ImportResult> {
  const rows = Object.freeze([...rowsInput]);
  const before = structuredClone(rows);
  const profile = Object.freeze({ profilePath });
  const calls: string[] = [];
  const key = Object.freeze({ synthetic: "not-a-key" });
  class InertDatabase {
    constructor(target: string, options: { readOnly: boolean }) {
      assert.equal(target, copiedPath);
      assert.equal(options.readOnly, true);
      assert.deepEqual(Object.keys(options), ["readOnly"]);
      calls.push("open");
    }
    prepare(sql: string): { all(): readonly Row[] } {
      assert.equal(sql, query);
      calls.push("prepare");
      return { all() { calls.push("all"); return rows; } };
    }
    close(): void { calls.push("close"); }
  }
  const boundary = {
    Buffer, Uint8Array,
    Date: Object.freeze({ now: () => now * 1000 }),
    DatabaseSync: InertDatabase,
    cookieDatabasePath: async (target: string) => { assert.equal(target, profilePath); calls.push("lookup"); return databasePath; },
    os: Object.freeze({ tmpdir: () => "/synthetic/tmp" }),
    path: Object.freeze({ join: (...parts: string[]) => {
      assert.ok(parts.every(part => typeof part === "string"));
      const joined = parts.join("/");
      assert.ok(["/synthetic/tmp/biny-cookie-import-", copiedPath].includes(joined));
      return joined;
    } }),
    fs: Object.freeze({
      mkdtemp: async (prefix: string) => { assert.equal(prefix, "/synthetic/tmp/biny-cookie-import-"); calls.push("mkdtemp"); return temporaryPath; },
      copyFile: async (from: string, to: string) => {
        const suffix = from.slice(databasePath.length);
        assert.ok(["", "-wal", "-shm"].includes(suffix));
        assert.equal(from, `${databasePath}${suffix}`);
        assert.equal(to, `${copiedPath}${suffix}`);
        calls.push(`copy${suffix}`);
        if (suffix) throw Object.freeze({ code: "ENOENT" });
      },
      rm: async (target: string, options: { recursive: boolean; force: boolean }) => {
        assert.equal(target, temporaryPath);
        assert.equal(options.recursive, true);
        assert.equal(options.force, true);
        assert.deepEqual(Object.keys(options), ["recursive", "force"]);
        calls.push("rm");
      }
    }),
    pbkdf2Sync: (input: string, salt: string, iterations: number, length: number, digest: string) => {
      assert.deepEqual([input, salt, iterations, length, digest], [secret, "saltysalt", 1003, 16, "sha1"]);
      calls.push("derive-inert-key");
      return key;
    },
    decryptCookie: () => assert.fail("plaintext-only fixture must not call decryption")
  };
  // Timeout bounds definition loading, not later async function calls; test timeouts bound each case.
  const importer = runInNewContext(executable, boundary, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 1000 }) as Importer;
  try {
    const result = await importer(profile, secret);
    // Convert only cross-realm containers, preserving undefined expiration and exact Number values.
    return { cookies: Array.from(result.cookies, cookie => ({ ...cookie })), failed: result.failed };
  } finally {
    assert.deepEqual(rows, before, "synthetic input rows remain unchanged");
    assert.deepEqual(profile, { profilePath });
    assert.deepEqual(calls, ["lookup", "mkdtemp", "copy", "copy-wal", "copy-shm", "open", "prepare", "all", "derive-inert-key", "close", "rm"], "synthetic close and removal occur once, in order; not a real filesystem cleanup test");
  }
}
interface Case { name: string; rows: readonly Row[]; cookies: ResultCookie[]; failed?: number }
const cases: Case[] = [
  { name: "retains a cookie still valid during its final fractional second", rows: [row("13444473600900000")], cookies: [expected(1_800_000_000.9)] },
  { name: "preserves a future microsecond timestamp beyond the Chromium safe-integer range", rows: [row("13454407831095631")], cookies: [expected(1_809_934_231.095631)] },
  { name: "preserves a one-microsecond remainder in a future expiration", rows: [row("13454407831000001")], cookies: [expected(1_809_934_231.000001)] },
  { name: "filters an expired fractional timestamp", rows: [row("13444473600400000")], cookies: [] },
  { name: "filters expiration exactly equal to now", rows: [row("13444473600500000")], cookies: [] },
  { name: "preserves an integer-second future expiration", rows: [row("13444473601000000")], cookies: [expected(1_800_000_001)] },
  { name: "filters an expired integer-second timestamp", rows: [row("13444473600000000")], cookies: [] },
  { name: "preserves zero-expiration session cookies", rows: [row("0")], cookies: [expected(undefined)] },
  { name: "retains the existing negative-raw session branch", rows: [row("-1")], cookies: [expected(undefined)] },
  { name: "clamps the maximum signed SQLite integer to the existing cap", rows: [row("9223372036854775807")], cookies: [expected(253_402_300_799)] },
  { name: "preserves a timestamp exactly at the existing cap", rows: [row("265046774399000000")], cookies: [expected(253_402_300_799)] },
  { name: "clamps a fractional timestamp above the existing cap", rows: [row("265046774399500000")], cookies: [expected(253_402_300_799)] },
  { name: "filters a positive Chromium timestamp before the Unix epoch", rows: [row("11644473599500000")], cookies: [] },
  { name: "filters the Unix epoch rather than treating it as a session", rows: [row("11644473600000000")], cookies: [] },
  { name: "preserves a legitimate empty plaintext value", rows: [row("0", { value: "" })], cookies: [expected(undefined, { value: "" })] },
  { name: "counts a missing plaintext value as failed", rows: [row("0", { value: undefined })], cookies: [], failed: 1 },
  { name: "counts a non-string plaintext value as failed", rows: [row("0", { value: 4 })], cookies: [], failed: 1 },
  { name: "returns an empty successful row list without synthetic resource leakage", rows: [], cookies: [] },
  { name: "keeps returned order and failure accounting with fractional, expired, session and invalid-value rows", rows: [
    row("13444473600900000", { name: "fractional" }), row("13444473600400000", { name: "expired" }),
    row("0", { name: "empty", value: "" }), row("0", { name: "invalid", value: undefined }),
    row("13444473601000000", { name: "integer" })
  ], cookies: [expected(1_800_000_000.9, { name: "fractional" }), expected(undefined, { name: "empty", value: "" }), expected(1_800_000_001, { name: "integer" })], failed: 1 }
];
for (const scenario of cases) {
  test(scenario.name, { timeout: 5000 }, async () => {
    assert.deepEqual(await read(scenario.rows), { cookies: scenario.cookies, failed: scenario.failed ?? 0 });
  });
}
