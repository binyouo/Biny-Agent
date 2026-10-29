/** Real export writer/callers with inert filesystem seams; no product import graph. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
const constants = { O_WRONLY: 1, O_CREAT: 64, O_EXCL: 128, O_NOFOLLOW: 256, O_NONBLOCK: 512 };
type Entry = { ino: bigint; type: string; bytes: string; mode: bigint; nlink: bigint; revision: bigint };
type Receipt = { file: string; committed: true; warnings: string[] };
type WriteApi = { writeSessionExportFile(file: string, content: string): Promise<Receipt> };
function error(code: string) { return Object.assign(new Error(code), { code }); }
function compile(text: string, globals: Record<string, unknown>): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, { exports, ...globals });
  return exports;
}
function extract(file: string, names: string[], className?: string): string {
  const text = source(file), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declaration = className ? tree.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === className) : undefined;
  const nodes = declaration && ts.isClassDeclaration(declaration) ? declaration.members : tree.statements;
  const selected = names.map(name => {
    const node = nodes.find(n => "name" in n && n.name && (n.name as ts.Node).getText(tree) === name);
    assert.ok(node, name); return node.getText(tree);
  }).join("\n");
  return className ? `export class ${className} { ${selected} }` : selected;
}
function rig(options: { existing?: boolean; type?: string; links?: bigint; platform?: string; fail?: string[]; readonly?: boolean; mutate?: "target" | "temporary" | "parent" | "appeared"; inspectFails?: boolean } = {}) {
  const files = new Map<string, Entry>();
  const target = "/exports/backup.json";
  const entry = (ino: bigint, bytes: string, type = "file", nlink = 1n): Entry => ({ ino, bytes, type, nlink, mode: 0o644n, revision: 1n });
  if (options.existing !== false) files.set(target, entry(1n, "OLD COMPLETE", options.type, options.links));
  const log: string[] = [];
  let nextInode = 10n, temp = "", stageClosed = false, stageWrites = 0, authorization = 0, random = 0;
  const stats = (e: Entry) => ({ ...e, dev: 1n, size: BigInt(e.bytes.length), mtimeNs: e.revision, ctimeNs: e.revision, isFile: () => e.type === "file", isDirectory: () => e.type === "directory", isSymbolicLink: () => e.type === "symlink" });
  const step = (name: string) => { log.push(name); if (options.fail?.includes(name)) throw error(name); };
  const io = {
    async writeFile(p: string, content: string, options: { encoding: string; mode: number }) {
      assert.equal(p, target); assert.equal(options.encoding, "utf8"); assert.equal(options.mode, 0o600);
      const e = files.get(p) ?? entry(nextInode++, ""); files.set(p, e); e.bytes = content.slice(0, 3); step("legacyWrite"); e.bytes = content;
    },
    async chmod(p: string, mode: number) { step("legacyChmod"); files.get(p)!.mode = BigInt(mode); },
    async realpath(p: string) { step("realpath"); assert.equal(p, "/exports"); return stageWrites && options.mutate === "parent" ? "/other" : p; },
    async lstat(p: string) {
      step("lstat");
      if (p === "/exports") return stats(entry(2n, "", "directory"));
      if (p === target && stageWrites && options.mutate === "target") files.set(target, entry(99n, "OTHER WRITER"));
      if (p === temp && stageClosed && options.mutate === "temporary") files.set(temp, entry(99n, "FOREIGN"));
      if (p === temp && log.includes("unlink") && options.inspectFails) throw error("INSPECTION_FAILED");
      const e = files.get(p); if (!e) throw error("ENOENT"); return stats(e);
    },
    async open(p: string, flags: number, mode?: number) {
      step("open");
      const staging = Boolean(flags & constants.O_CREAT);
      let e: Entry;
      if (staging) {
        assert.ok(flags & constants.O_EXCL); assert.equal(mode, 0o600);
        if (files.has(p)) throw error("EEXIST");
        temp = p; stageClosed = false; e = entry(nextInode++, ""); e.mode = BigInt(mode!); files.set(p, e);
      } else {
        authorization++; assert.equal(flags & constants.O_WRONLY, constants.O_WRONLY); assert.equal(flags & constants.O_CREAT, 0);
        if (options.readonly) throw error("EACCES");
        const found = files.get(p); if (!found) throw error("ENOENT"); e = found;
      }
      return {
        async stat() { step(staging ? "stageStat" : "authorizeStat"); return stats(e); },
        async chmod(mode: number) { step("chmod"); e.mode = BigInt(mode); },
        async writeFile(content: string) { assert.equal(e.mode, 0o600n); stageWrites++; e.bytes = content.slice(0, 3); e.revision++; step("write"); e.bytes = content; },
        async sync() { step("sync"); },
        async close() { step(staging ? "close" : "authorizeClose"); if (staging) stageClosed = true; }
      };
    },
    async rename(from: string, to: string) { assert.ok(stageClosed); step("rename"); const e = files.get(from)!; files.set(to, e); files.delete(from); },
    async link(from: string, to: string) { assert.ok(stageClosed); step("link"); if (options.mutate === "appeared") files.set(to, entry(99n, "OTHER WRITER")); if (files.has(to)) throw error("EEXIST"); const e = files.get(from)!; e.nlink++; files.set(to, e); },
    async unlink(p: string) { step("unlink"); const e = files.get(p); if (!e) throw error("ENOENT"); e.nlink--; files.delete(p); }
  };
  const api = compile(source("src/session/exportFile.ts"), {
    process: { platform: options.platform ?? "linux", pid: 123 },
    require(name: string) {
      if (name === "node:fs") return { constants, promises: io };
      if (name === "node:path") return path.posix;
      if (name === "node:crypto") return { randomBytes: () => ({ toString: () => `unique${++random}` }) };
      if (name === "../utils/windowsSecurity.js") return { async restrictWindowsPathAccess(p: string, kind: string) { assert.equal(p, temp); assert.equal(kind, "file"); assert.equal(files.get(p)?.bytes, ""); step("acl"); } };
      throw new Error(`Forbidden product import: ${name}`);
    }
  }) as unknown as WriteApi;
  return { api, io, files, log, target, state: () => ({ temp, stageWrites, authorization }) };
}
for (const existing of [false, true]) {
  test(`explicit export publishes complete private content, existing=${existing}`, async () => {
    const r = rig({ existing }); const result = await r.api.writeSessionExportFile(r.target, "NEW COMPLETE");
    assert.equal(result.committed, true); assert.equal(result.warnings.length, 0);
    assert.equal(r.files.get(r.target)?.bytes, "NEW COMPLETE"); assert.equal(r.files.get(r.target)?.mode, 0o600n);
    assert.equal(r.files.get(r.target)?.nlink, 1n); assert.equal(r.files.size, 1);
    assert.ok(r.log.indexOf("close") < r.log.indexOf(existing ? "rename" : "link"));
    assert.equal(r.state().authorization, existing ? 2 : 0);
  });
  for (const stage of ["stageStat", "chmod", "write", "sync", "close", existing ? "rename" : "link"]) {
    test(`explicit export preserves prior output on ${stage}, existing=${existing}`, async () => {
      const r = rig({ existing, fail: [stage] });
      await assert.rejects(r.api.writeSessionExportFile(r.target, "NEW COMPLETE"), (e: unknown) => {
        const failure = e as { committed: boolean; code: string; cause: { code: string } };
        assert.equal(failure.committed, false); assert.equal(failure.code, stage); assert.equal(failure.cause.code, stage); return true;
      });
      assert.equal(r.files.get(r.target)?.bytes, existing ? "OLD COMPLETE" : undefined);
      assert.ok(!r.log.includes(existing ? "link" : "rename"), "never use an alternate publication operation");
    });
  }
}
for (const type of ["symlink", "directory", "fifo"]) test(`reject ${type} without staging or writes`, async () => {
  const r = rig({ type }); await assert.rejects(r.api.writeSessionExportFile(r.target, "NEW"), /regular, single-link/); assert.equal(r.state().stageWrites, 0); assert.equal(r.state().temp, "");
});
for (const options of [{ links: 2n }, { readonly: true }]) test(`reject non-authorized replacement ${String(options.links ?? "readonly")}`, async () => {
  const r = rig(options); await assert.rejects(r.api.writeSessionExportFile(r.target, "NEW")); assert.equal(r.state().temp, ""); assert.equal(r.files.get(r.target)?.bytes, "OLD COMPLETE");
});
for (const mutate of ["target", "temporary", "parent", "appeared"] as const) test(`observed ${mutate} change prevents publication`, async () => {
  const r = rig({ mutate, existing: mutate !== "appeared" }); await assert.rejects(r.api.writeSessionExportFile(r.target, "NEW"));
  assert.equal(r.files.get(r.target)?.bytes, mutate === "target" || mutate === "appeared" ? "OTHER WRITER" : "OLD COMPLETE");
  if (mutate === "temporary") assert.equal(r.files.get(r.state().temp)?.bytes, "FOREIGN");
});
test("postcommit cleanup is a success warning, not an export failure", async () => {
  const r = rig({ existing: false, fail: ["unlink"] }); const result = await r.api.writeSessionExportFile(r.target, "NEW");
  assert.equal(result.committed, true); assert.ok(result.warnings.length >= 2); assert.equal(r.files.get(r.target)?.bytes, "NEW"); assert.equal(r.files.get(r.target)?.nlink, 2n);
  await assert.rejects(r.api.writeSessionExportFile(r.target, "SECOND"), /single-link/);
});
for (const committed of [false, true]) test(`inspection failure cannot hide primary or commit, committed=${committed}`, async () => {
  const r = rig({ existing: false, fail: committed ? ["unlink"] : ["write", "unlink"], inspectFails: true });
  if (committed) { const result = await r.api.writeSessionExportFile(r.target, "NEW"); assert.equal(result.committed, true); assert.ok(result.warnings.some(w => w.includes("could not be verified"))); }
  else await assert.rejects(r.api.writeSessionExportFile(r.target, "NEW"), (e: unknown) => { const failure = e as { cause: { code: string }; warnings: string[] }; assert.equal(failure.cause.code, "write"); assert.ok(failure.warnings.some(w => w.includes("could not be verified"))); return true; });
});
test("successful new output can be exported again", async () => { const r = rig({ existing: false }); await r.api.writeSessionExportFile(r.target, "FIRST"); await r.api.writeSessionExportFile(r.target, "SECOND"); assert.equal(r.files.get(r.target)?.bytes, "SECOND"); assert.equal(r.files.get(r.target)?.nlink, 1n); });
for (const fail of [undefined, "legacyWrite", "legacyChmod"]) test(`Windows retains legacy direct writer, failure=${String(fail)}`, async () => {
  const r = rig({ platform: "win32", fail: fail ? [fail] : [] });
  if (fail) await assert.rejects(r.api.writeSessionExportFile(r.target, "NEW COMPLETE"));
  else { const result = await r.api.writeSessionExportFile(r.target, "NEW COMPLETE"); assert.equal(result.committed, true); assert.equal(result.warnings.length, 0); }
  assert.equal(r.state().temp, ""); assert.equal(r.log.includes("open"), false); assert.equal(r.log.includes("acl"), false);
  assert.equal(r.files.get(r.target)?.bytes, fail === "legacyWrite" ? "NEW" : "NEW COMPLETE", "legacy failure/truncation behavior is intentionally not claimed fixed");
  assert.deepEqual(r.log, fail === "legacyWrite" ? ["legacyWrite"] : ["legacyWrite", "legacyChmod"]);
});

type CliApi = { sessionExportCommand(root: string, session: string, options: { out?: string; json?: boolean }): Promise<void> };
function cli(r: ReturnType<typeof rig>, json: boolean) {
  const printed: string[] = [], warnings: string[] = [], legacy: string[] = [];
  const api = compile(extract("src/cli/commands/sessionTransfer.ts", ["sessionExportCommand", "writeExportFile"]), {
    path: path.posix, process: { cwd: () => "/exports" },
    console: { log: (s: string) => printed.push(s), warn: (s: string) => warnings.push(s) },
    ensureAgentDirs: async () => {}, exportSessionBundle: async () => ({ baseName: "session", extension: "json", content: "NEW COMPLETE" }),
    writeSessionExportFile: r.api.writeSessionExportFile,
    fs: { async writeFile(_p: string, _content: string, options: { flag: string }) { assert.equal(options.flag, "wx"); legacy.push("wx"); }, async chmod() { legacy.push("chmod"); } }
  }) as unknown as CliApi;
  return { run: (out?: string) => api.sessionExportCommand("/workspace", "session", { ...(out === undefined ? {} : { out }), json }), printed, warnings, legacy };
}
for (const json of [false, true]) test(`actual CLI explicit output consumes commit warnings, json=${json}`, async () => {
  const r = rig({ existing: false, fail: ["unlink"] }), caller = cli(r, json);
  await caller.run(r.target); assert.equal(caller.legacy.length, 0, "no postcommit pathname chmod on explicit output");
  if (json) { const receipt = JSON.parse(caller.printed[0]!); assert.equal(receipt.committed, true); assert.ok(receipt.warnings.length); }
  else { assert.match(caller.printed[0]!, /^Exported biny session/); assert.ok(caller.warnings.every(s => s.startsWith("Export saved; warning:"))); assert.ok(caller.warnings.length); }
});
test("actual CLI default output retains wx then chmod", async () => {
  const r = rig(), caller = cli(r, true); await caller.run(); assert.deepEqual(caller.legacy, ["wx", "chmod"]); assert.equal(r.state().temp, ""); assert.equal(JSON.parse(caller.printed[0]!).committed, undefined);
});
test("actual CLI explicit failure does not print success or run pathname chmod", async () => {
  const r = rig({ fail: ["write"] }), caller = cli(r, false); await assert.rejects(caller.run(r.target)); assert.equal(caller.printed.length, 0); assert.equal(caller.legacy.length, 0); assert.equal(r.files.get(r.target)?.bytes, "OLD COMPLETE");
});

type DesktopResult = { committed: boolean; warnings: string[]; snapshot?: unknown; file?: string };
function desktop(r: ReturnType<typeof rig>, refreshFails = false) {
  const service = compile(extract("src/desktop/electron/main/DesktopProjectService.ts", ["writeSessionExport"], "DesktopProjectService"), { writeSessionExportFile: r.api.writeSessionExportFile }) as unknown as { DesktopProjectService: { prototype: { writeSessionExport(file: string, exported: { content: string }): Promise<Receipt> } } };
  const manager = compile(extract("src/desktop/electron/main/DesktopAgentManager.ts", ["exportSession"], "DesktopAgentManager"), {}) as unknown as { DesktopAgentManager: { prototype: { exportSession(project: string, session: string, format: string, target?: string): Promise<DesktopResult> } } };
  let admissions = 0;
  const receiver = {
    projects: { requireProject: () => ({ id: "project" }), buildSessionExport: async () => ({ content: "NEW COMPLETE" }), writeSessionExport: service.DesktopProjectService.prototype.writeSessionExport },
    assertNoRunningTasks() { admissions++; },
    async workspaceSnapshot() { if (refreshFails) throw error("REFRESH_FAILED"); return { project: { id: "project" } }; }
  };
  return { run: (target?: string) => manager.DesktopAgentManager.prototype.exportSession.call(receiver, "project", "session", "biny", target), admissions: () => admissions };
}
test("actual Desktop writer/manager preserve commit with cleanup and refresh warnings", async () => {
  const r = rig({ existing: false, fail: ["unlink"] }), caller = desktop(r, true);
  const result = await caller.run(r.target); assert.equal(caller.admissions(), 1); assert.equal(result.committed, true); assert.equal(result.snapshot, undefined); assert.ok(result.warnings.some(s => s.includes("REFRESH_FAILED"))); assert.ok(result.warnings.some(s => s.includes("staging"))); assert.equal(r.files.get(r.target)?.bytes, "NEW COMPLETE");
});
test("actual Desktop cancellation does not construct staging output", async () => { const r = rig(), caller = desktop(r); const result = await caller.run(); assert.equal(result.committed, false); assert.equal(caller.admissions(), 0); assert.equal(r.state().temp, ""); });
test("actual Desktop failure preserves previous file and no committed response", async () => { const r = rig({ fail: ["rename"] }), caller = desktop(r); await assert.rejects(caller.run(r.target)); assert.equal(r.files.get(r.target)?.bytes, "OLD COMPLETE"); });
test("actual renderer export branch reports saved result and warnings without demanding retry", async () => {
  const text = source("src/desktop/renderer/src/App.tsx"), tree = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: string | undefined;
  const visit = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(tree) === 'action === "export-bundle" || action === "export-claude"') body = node.thenStatement.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(body);
  const toast: string[] = [], warning: string[] = [];
  const api = compile(`export async function consume() ${body}`, {
    window: { biny: { exportSession: async () => ({ committed: true, warnings: ["owned stage requires inspection"] }) } },
    session: { projectId: "project", id: "session" }, action: "export-bundle",
    mergeProjectSnapshot() { throw new Error("no snapshot available"); }, setToast: (s: string) => toast.push(s), setWarning: (s: string) => warning.push(s)
  }) as unknown as { consume(): Promise<void> };
  await api.consume(); assert.deepEqual(toast, ["会话已导出"]); assert.match(warning[0]!, /无需重新导出/);
});

test("authorization stat and close double failure preserves primary error", async () => {
  const r = rig({ fail: ["authorizeStat", "authorizeClose"] });
  await assert.rejects(r.api.writeSessionExportFile(r.target, "NEW"), (e: unknown) => {
    const failure = e as { code: string; cause: { code: string }; warnings: string[] };
    assert.equal(failure.code, "authorizeStat"); assert.equal(failure.cause.code, "authorizeStat"); assert.ok(failure.warnings.some(w => w.includes("authorizeClose"))); return true;
  });
  assert.equal(r.state().temp, ""); assert.equal(r.files.get(r.target)?.bytes, "OLD COMPLETE");
});
