/** Actual-source boundary fixtures; no product, Host, SQLite or native imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}
const store = source("session/store.ts"), cleanup = source("session/cleanup.ts");
function declaration(ast: ts.SourceFile, name: string, optional = false): string {
  const node = ast.statements.find(item => (ts.isFunctionDeclaration(item) || ts.isClassDeclaration(item)) && item.name?.text === name);
  if (!node && optional) return "";
  assert.ok(node, name);
  return node.getText(ast).replace(/^export /u, "");
}
function method(file: string, owner: string, name: string): string {
  const ast = source(file), node = ast.statements.find(item => ts.isClassDeclaration(item) && item.name?.text === owner);
  assert.ok(node && ts.isClassDeclaration(node), owner);
  const member = node.members.find(item => item.name?.getText(ast) === name);
  assert.ok(member, name);
  return member.getText(ast);
}
const selected = [
  declaration(store, "SessionFileNotFoundError", true), // baseline has no marker; no stub changes its behavior
  declaration(store, "resolveSessionFileAt"), declaration(store, "deleteSessionFile"),
  declaration(cleanup, "deleteSessionArtifacts"),
  `class Project {${method("desktop/electron/main/DesktopProjectService.ts", "DesktopProjectService", "deleteSession")}}`,
  `class Manager {${["deleteSessions", "deleteSessionData"].map(name => method("desktop/electron/main/DesktopAgentManager.ts", "DesktopAgentManager", name)).join("\n")}}`
].join("\n");
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node));
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isIdentifier(node)) assert.ok(!["process", "require", "fetch", "eval", "Function"].includes(node.text));
  ts.forEachChild(node, audit);
}
audit(ts.createSourceFile("selected.ts", selected, ts.ScriptTarget.Latest, true));
const javascript = stripTypeScriptTypes(selected, { mode: "strip" });
type Phase = "success" | "missing" | "missing-explicit" | "missing-unbound" | "resolve-enoent" | "open" | "open-enoent" | "rename" | "rename-enoent" | "identity" | "truncate" | "sync" | "close" | "sidecar";
function fixture(phase: Phase) {
  const calls: string[] = [];
  const missing = phase.startsWith("missing");
  const state = { transcript: missing ? undefined : "durable history", checkpoint: "exact paused context", catalog: "custom title and memory override", recipe: "dismissed", index: true };
  const reason = Object.assign(new Error(`fixture ${phase}`), { code: phase.includes("enoent") ? "ENOENT" : "EPERM" });
  let moved = false, closed = false;
  const handle = {
    async truncate() { calls.push("truncate"); if (phase === "truncate") throw reason; state.transcript = ""; },
    async sync() { if (phase === "sync") throw reason; },
    async stat() { return { dev: 1, ino: 2, size: state.transcript?.length ?? 0 }; },
    async close() { closed = true; if (phase === "close") throw reason; }
  };
  const bindings = {
    path, realpath: async (value: string) => value,
    fs: { async rename() { calls.push("rename"); if (phase === "rename" || phase === "rename-enoent") throw reason; moved = true; } },
    resolveSessionStorage: async () => { if (phase === "resolve-enoent") throw reason; return {}; },
    isLatestAlias: () => false,
    explicitSessionFileName: () => phase === "missing-explicit" ? "A.jsonl" : undefined,
    findSessionFileByName: async () => { calls.push("binding"); return missing ? undefined : "/synthetic/A.jsonl"; },
    listSessionFileEntries: async () => { calls.push("binding"); return []; },
    openSessionHandle: async () => { calls.push("open"); if (phase === "open" || phase === "open-enoent") throw reason; return handle; },
    sessionDeleteTombstoneName: () => ".deleted-A",
    assertSessionBinding: async () => ({ dev: 1, ino: 2 }),
    assertSessionStorage: async () => { calls.push("binding"); if (phase === "missing-unbound") throw reason; },
    isHandleBoundToPath: async () => phase !== "identity",
    preserveUnexpectedTombstone: async () => { calls.push("preserve-replacement"); return true; },
    projectSessionsDir: (value: string) => `${value}/sessions`,
    deleteSessionCatalogRecord: async () => { calls.push("delete-catalog"); if (phase === "sidecar") throw reason; state.catalog = ""; },
    deleteInterruptedTurn: async () => { calls.push("delete-checkpoint"); state.checkpoint = ""; },
    RecipeStateStore: class { async clear() { calls.push("delete-recipe"); state.recipe = ""; } },
    SessionSearchIndex: class { async forgetSession() { calls.push("forget-index"); state.index = false; } },
    runtimeIsBusy: () => false, Set, Map, Error
  };
  const harness = runInNewContext(`${javascript}\n
    const project = new Project();
    project.storage = {ensureProjectData: async () => '/synthetic'};
    project.state = {selectedSessionId: () => undefined};
    const manager = new Manager(); manager.getRuntime = async () => undefined;
    manager.projects = {requireProject: id => ({id}), deleteSession: (...args) => project.deleteSession(...args)};
    manager.liveEvents = new Map(); manager.state = {selectedSessionId: () => undefined};
    ({run: () => manager.deleteSessions([{projectId: 'P', sessionId: 'A'}]), direct: () => deleteSessionArtifacts('/synthetic', 'A')});`, bindings,
  { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as {
    run(): Promise<{ deleted: unknown[]; failures: Array<{ error: string }> }>;
    direct(): Promise<void>;
  };
  return { ...harness, state, calls, reason, moved: () => moved, closed: () => closed };
}

for (const phase of ["resolve-enoent", "open", "open-enoent", "rename", "rename-enoent", "missing-unbound"] as const) {
  test(`Desktop failed deletion preserves recovery data before removal: ${phase}`, async () => {
    const f = fixture(phase), result = await f.run();
    assert.equal(result.deleted.length, 0);
    assert.equal(f.moved(), false);
    assert.equal(f.state.transcript, phase === "missing-unbound" ? undefined : "durable history");
    assert.equal(f.state.checkpoint, "exact paused context");
    assert.equal(result.failures[0]?.error, f.reason.message);
    assert.equal(f.state.catalog, "custom title and memory override");
    assert.equal(f.state.recipe, "dismissed");
    assert.equal(f.state.index, true);
    assert.ok(!f.calls.some(call => call.startsWith("delete-") || call === "forget-index"));
  });
}
for (const phase of ["identity", "truncate", "sync", "close"] as const) {
  test(`uncertain/post-rename failure conservatively retains sidecars: ${phase}`, async () => {
    const f = fixture(phase), result = await f.run();
    assert.equal(result.deleted.length, 0); assert.equal(result.failures.length, 1);
    assert.equal(f.closed(), true); assert.equal(f.moved(), true);
    assert.equal(f.state.transcript, phase === "identity" || phase === "truncate" ? "durable history" : "");
    assert.equal(f.state.checkpoint, "exact paused context");
    assert.equal(f.state.catalog, "custom title and memory override");
    if (phase === "identity") assert.ok(f.calls.includes("preserve-replacement"));
  });
}
for (const phase of ["missing", "missing-explicit"] as const) {
  test(`validated absent transcript still clears orphan sidecars: ${phase}`, async () => {
    const f = fixture(phase), result = await f.run();
    assert.equal(result.deleted.length, 0);
    assert.match(result.failures[0]?.error ?? "", /Session (?:file )?not found/u);
    assert.equal(f.state.checkpoint, ""); assert.equal(f.state.catalog, "");
    assert.equal(f.state.recipe, ""); assert.equal(f.state.index, false);
    assert.ok(f.calls.includes("binding"), "absence must be witnessed in a still-bound namespace");
  });
}
test("successful deletion clears all sidecars and reports success", async () => {
  const f = fixture("success"), result = await f.run();
  assert.equal(result.deleted.length, 1); assert.equal(result.failures.length, 0);
  assert.equal(f.state.transcript, ""); assert.equal(f.state.checkpoint, ""); assert.equal(f.state.catalog, "");
  assert.equal(f.state.recipe, ""); assert.equal(f.state.index, false);
});
test("committed deletion still attempts every sidecar when one fails", async () => {
  const f = fixture("sidecar"); await assert.rejects(f.direct(), error => error === f.reason);
  assert.equal(f.state.transcript, ""); assert.equal(f.state.catalog, "custom title and memory override");
  assert.equal(f.state.checkpoint, ""); assert.equal(f.state.recipe, ""); assert.equal(f.state.index, false);
});
test("pre-removal original error identity is preserved", async () => {
  const f = fixture("rename"); await assert.rejects(f.direct(), error => error === f.reason);
  assert.equal(f.state.checkpoint, "exact paused context");
});
