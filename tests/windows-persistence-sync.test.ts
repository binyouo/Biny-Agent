/** Production persistence methods with inert filesystem boundaries; no Windows OS claim. */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const root = process.cwd();
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
function between(source: string, start: string, end: string): string {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, end);
  return source.slice(first, last).trim();
}
const imports = read("src/imports/service.ts");
const turn = read("src/session/turnStore.ts");
const settings = read("src/desktop/electron/main/DesktopSettingsTransaction.ts");
const helperPath = path.join(root, "src/utils/syncDirectory.ts");
const helper = existsSync(helperPath)
  ? readFileSync(helperPath, "utf8")
  : between(settings, "async function syncDirectory(", "function recoveryWriteFlags(");
const bodies = {
  imports: between(imports, "  private async writeState(", "  private async toSnapshot("),
  turn: between(turn, "  async save(", "  async load("),
  settings: between(settings, "  private async writeRecoveryPayload(", "  private async readRecoveryPayload(")
};
type Entry = keyof typeof bodies;
interface Subject {
  stateRoot: string;
  persistenceRoot: string;
  sessionId: string;
  filePath(): string;
  state: { settingsTransactionJournalPath(): string };
  writeState(value: unknown): Promise<unknown>;
  save(prompt: string, systemPrompt: undefined, messages: unknown[], steps: number): Promise<unknown>;
  writeRecoveryPayload(value: unknown): Promise<unknown>;
}
function fixture(entry: Entry, platform: string, failure?: "file" | "directory" | "rename" | "open-directory", readOnlyTemporary = false, helperSource = helper) {
  const calls: string[] = [];
  const error = new Error(`injected ${failure}`);
  const stat = { dev: 1, ino: 2, nlink: 1, isFile: () => true, isSymbolicLink: () => false };
  const fs = {
    async lstat() { return stat; },
    async writeFile() { calls.push("write"); },
    async open(file: string, flags: string | number) {
      const directory = file === "/state";
      if (readOnlyTemporary && flags === "r+") throw new Error("EACCES: umask-created read-only temporary");
      calls.push(`open:${directory ? "directory" : "file"}:${flags}`);
      if (directory && failure === "open-directory") throw error;
      return {
        async stat() { return stat; }, async writeFile() { calls.push("write"); }, async chmod() {},
        async sync() {
          calls.push(`sync:${directory ? "directory" : "file"}`);
          if (platform === "win32" && (directory || flags === "r")) throw new Error("EBADF: read-only FlushFileBuffers handle");
          if (failure === (directory ? "directory" : "file")) throw error;
        },
        async close() { calls.push(`close:${directory ? "directory" : "file"}`); }
      };
    },
    async rename() { calls.push("rename"); if (failure === "rename") throw error; },
    async link() { calls.push("link"); }, async unlink() { calls.push("unlink"); }, async rm() { calls.push("cleanup"); }
  };
  // Git may check source out as CRLF on Windows; remove the import in either form.
  const helperBody = helperSource.replace(/^import .*;\r?\n/u, "").replace("export async", "async");
  const code = `${helperBody}\nclass Subject { ${bodies[entry]} }\nglobalThis.Subject = Subject;`;
  const context = {
    fs, constants: { O_RDONLY: 0, O_DIRECTORY: 65536 }, process: { platform }, path,
    Buffer, JSON, Date, Error, structuredClone, randomUUID: () => "unique", randomBytes: () => ({ toString: () => "unique" }),
    stateSchema: { parse: (value: unknown) => value }, maxStateBytes: 100000, maxRecoveryPayloadBytes: 100000,
    removeOwnedTemporaryFile: async () => { calls.push("cleanup"); }, isNotFound: () => false,
    ensureAgentDirs: async () => {}, turnStateVersion: 5,
    projectCheckpointToolMetadata: (value: unknown) => value, redactBrowserToolMessages: (value: unknown) => value,
    ensureRecoveryDirectory: async () => "/state", recoveryPayloadFileName: () => "payload.json",
    assertRecoveryTargetMissing: async () => {}, recoveryWriteFlags: () => 193,
    assertRecoveryFileBinding: async () => {}, removeRecoveryFileIfBound: async () => { calls.push("cleanup"); },
    createHash: () => ({ update: () => ({ digest: () => "hash" }) })
  };
  const subject = runInNewContext(stripTypeScriptTypes(code) + "\nnew Subject()", context) as Subject;
  subject.stateRoot = "/state"; subject.persistenceRoot = "/workspace"; subject.sessionId = "session";
  subject.filePath = () => "/state/turn.json";
  subject.state = { settingsTransactionJournalPath: () => "/state/journal.json" };
  return { calls, error, run: async () => {
    if (entry === "imports") return subject.writeState({ version: 1 });
    if (entry === "turn") return subject.save("hello", undefined, [{ role: "user", content: "hello" }], 0);
    return subject.writeRecoveryPayload({ id: "payload" });
  } };
}
for (const entry of ["imports", "turn", "settings"] as const) {
  for (const platform of ["win32", "linux", "darwin"]) test(`${entry}: ${platform} publishes after file sync`, async () => {
    const f = fixture(entry, platform); await f.run();
    const publication = f.calls.indexOf(entry === "settings" ? "link" : "rename");
    assert.ok(f.calls.indexOf("sync:file") < publication);
    assert.ok(f.calls.includes("close:file"));
    assert.equal(f.calls.includes("sync:directory"), platform !== "win32");
    assert.equal(f.calls.some(call => call.startsWith("open:directory:")), platform !== "win32");
    if (platform !== "win32") assert.ok(f.calls.indexOf("sync:directory") > publication);
  });
  for (const platform of ["win32", "linux"]) test(`${entry}: ${platform} retains file flush failure`, async () => {
    const f = fixture(entry, platform, "file"); await assert.rejects(f.run, error => error === f.error);
    assert.ok(!f.calls.includes("rename") && !f.calls.includes("link"));
    assert.ok(f.calls.includes("close:file"));
  });
  for (const failure of ["directory", "open-directory"] as const) test(`${entry}: POSIX ${failure} failure propagates`, async () => {
    const f = fixture(entry, "linux", failure); await assert.rejects(f.run, error => error === f.error);
    assert.ok(f.calls.includes(entry === "settings" ? "link" : "rename"));
    if (failure === "directory") assert.ok(f.calls.includes("close:directory"));
  });
}

for (const platform of ["linux", "darwin"]) test(`turn: ${platform} retains readable temporary files created with umask 0222`, async () => {
  const f = fixture("turn", platform, undefined, true);
  await f.run();
  assert.ok(f.calls.includes("open:file:r"));
  assert.ok(f.calls.includes("rename"));
});

for (const [name, ending] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
  test(`helper fixture accepts ${name} source line endings`, async () => {
    const source = helper.replace(/\r?\n/gu, ending);
    const f = fixture("imports", "linux", undefined, false, source);
    await f.run();
    assert.ok(f.calls.includes("sync:file"));
    assert.ok(f.calls.includes("sync:directory"));
    assert.ok(f.calls.indexOf("sync:directory") > f.calls.indexOf("rename"));
  });
}
