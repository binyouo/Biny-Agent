import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read source only. Never import the desktop entrypoint, StateStore or product services.
// The VM limits synchronous entry; an external watchdog must bound async continuations.
const root = path.resolve(process.env.BINY_SELECTION_CLEANUP_SOURCE_ROOT ?? process.cwd());
const parse = (name: string) => ts.createSourceFile(name, readFileSync(path.join(root, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const main = parse("src/desktop/electron/main/index.ts");
const store = parse("src/desktop/electron/main/DesktopStateStore.ts");
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
const bootstraps: ts.ArrowFunction[] = [];
function find(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(main) === "bootstrap") {
    assert.ok(node.initializer && ts.isArrowFunction(node.initializer)); bootstraps.push(node.initializer);
  }
  ts.forEachChild(node, find);
}
find(main);
const bootstrap = one(bootstraps, "actual bootstrap callback");
const owner = one(store.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopStateStore"), "StateStore");
const method = (name: string) => one(owner.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(store) === name), name);
// A baseline has no new owner API. Extract only what its actual bootstrap uses;
// never install a substitute ownership algorithm to make the baseline pass.
const usesOwner = bootstrap.getText(main).includes("state.captureSelectedSessionLifetime(");
const names = ["project", "projects", "upsertProject", "removeProject", "setProjectName", "setProjectPinned", "reorderProjects", "selectedSessionId", "setSelectedSession", "commitSelection", "activeProjectId", "setActiveProject", "activeView"];
if (usesOwner) names.push("captureSelectedSessionLifetime");
const methods = names.map(method);
const fields = usesOwner ? [one(owner.members.filter((node): node is ts.PropertyDeclaration => ts.isPropertyDeclaration(node) && node.name.getText(store) === "selectedSessionTokens"), "selection token storage")] : [];
const allowedCalls = new Set([
  "projects.refreshAllProjects", "state.activeProjectId", "allProjects.some", "allProjects.at", "state.setActiveProject", "state.activeView",
  "state.captureSelectedSessionLifetime", "agents.prepareWorkspace", "state.selectedSessionId", "workspace?.sessions.some", "ownsSelection",
  "state.setSelectedSession", "agents.sidebarSessions", "app.getVersion", "state.projects", "state.sidebarWidth", "state.filePanelWidth",
  "appearance.snapshot", "configStore.load", "this.state.projects.find", "this.state.projects.some", "this.state.projects.map", "this.state.projects.findIndex",
  "this.state.projects.push", "this.state.projects.filter", "this.state.projects.at", "this.save", "this.selectedSessionTokens.get", "this.selectedSessionTokens.set",
  "byId.get", "seen.has", "ordered.push", "seen.add"
]);
function audit(node: ts.Node, source: ts.SourceFile): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.ok(["Error", "Map", "Set", "WeakMap"].includes(node.expression.getText(source)));
  ts.forEachChild(node, child => audit(child, source));
}
audit(bootstrap, main);
for (const node of [...methods, ...fields]) audit(node, store);
function compile(code: string): string {
  assert.equal(/\b(?:require|fetch|eval)\b|import\s*\(/u.test(code), false);
  const result = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
const stateCode = compile("({" + [...methods.map(node => node.getText(store)), ...fields.map(node => `${node.name.getText(store)}: ${node.initializer!.getText(store)}`)].join(",\n") + "})");
const bootstrapCode = compile(`(${bootstrap.getText(main)})`);
const vmOptions = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };
interface Project { id: string; name: string; path: string; pinned: boolean; addedAt: string }
interface State {
  state: { projects: Project[]; selectedSessionIds: Record<string, string>; activeProjectId?: string; activeView: string };
  save(): Promise<void>;
  project(id: string): Project | undefined;
  projects(): Project[];
  upsertProject(project: Project): Promise<void>;
  removeProject(id: string): Promise<void>;
  setProjectName(id: string, name: string): Promise<void>;
  setProjectPinned(id: string, pinned: boolean): Promise<void>;
  reorderProjects(ids: string[]): Promise<void>;
  selectedSessionId(id: string): string | undefined;
  setSelectedSession(id: string, sessionId: string | undefined): Promise<void>;
  commitSelection(id: string, sessionId: string | undefined, view: string): Promise<void>;
}
interface Result { selectedSessionId?: string; workspace?: { selectedSessionId?: string }; activeProjectId?: string }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(selected: string | null = "old", sessionIds: string[] = []) {
  const project: Project = { id: "p", name: "Project", path: "/inert/p", pinned: false, addedAt: "fixed" };
  let saves = 0;
  const state = Object.assign(runInNewContext(stateCode, {}, vmOptions) as State, {
    state: { projects: [project, { ...project, id: "q" }], selectedSessionIds: selected === null ? {} : { p: selected }, activeProjectId: "p", activeView: "chat" },
    save: async () => { saves += 1; }, sidebarWidth: () => 200, filePanelWidth: () => 300
  });
  const workspace = { project: { ...project }, sessions: sessionIds.map(id => ({ id })) };
  const entered = deferred<void>(), pendingWorkspace = deferred<typeof workspace>();
  let preparations = 0;
  const run = runInNewContext(bootstrapCode, {
    state, initialTarget: undefined,
    projects: { refreshAllProjects: async () => state.projects() },
    agents: { prepareWorkspace: () => { preparations += 1; entered.resolve(); return pendingWorkspace.promise; }, sidebarSessions: async () => [] },
    app: { getVersion: () => "inert" }, process: { platform: "inert" },
    appearance: { snapshot: () => ({ themePreference: "system", fontPreference: {}, appearancePreference: {} }) },
    configStore: { load: async () => ({ chat: { response: {} } }) }
  }, vmOptions) as () => Promise<Result>;
  const result = run();
  return { state, entered: entered.promise, project: { ...project }, preparations: () => preparations, saves: () => saves,
    finish: () => { pendingWorkspace.resolve(workspace); return result; } };
}

test("unchanged missing selection is still cleared", async () => {
  const f = fixture(); await f.entered; const result = await f.finish();
  assert.equal(f.state.selectedSessionId("p"), undefined); assert.equal(f.saves(), 1);
  assert.equal(result.selectedSessionId, undefined); assert.equal(f.preparations(), 1);
});
test("unchanged valid selection is restored without cleanup", async () => {
  const f = fixture("old", ["old"]); await f.entered; const result = await f.finish();
  assert.equal(f.state.selectedSessionId("p"), "old"); assert.equal(f.saves(), 0);
  assert.equal(result.selectedSessionId, "old"); assert.equal(result.workspace?.selectedSessionId, "old");
});
test("absent selection needs no cleanup write", async () => {
  const f = fixture(null); await f.entered; await f.finish();
  assert.equal(f.state.selectedSessionId("p"), undefined); assert.equal(f.saves(), 0);
});
test("a newer setter selection survives old workspace cleanup", async () => {
  const f = fixture(); await f.entered; await f.state.setSelectedSession("p", "new"); const result = await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "new", true);
  // The narrow fix deliberately does not change the existing bootstrap reply calculation.
  assert.equal(result.selectedSessionId, undefined); assert.equal(result.workspace?.selectedSessionId, undefined);
});
test("a newer committed selection survives old workspace cleanup", async () => {
  const f = fixture(); await f.entered; await f.state.commitSelection("p", "new", "runtime"); await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "new", true);
});
test("setter A-to-B-to-A changes retire the original cleanup permission", async () => {
  const f = fixture(); await f.entered; await f.state.setSelectedSession("p", "new"); await f.state.setSelectedSession("p", "old"); await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "old", true);
});
test("commit A-to-B-to-A changes retire the original cleanup permission", async () => {
  const f = fixture(); await f.entered; await f.state.commitSelection("p", "new", "chat"); await f.state.commitSelection("p", "old", "chat"); await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "old", true);
});
test("same-value setter selection also retires cleanup permission", async () => {
  const f = fixture(); await f.entered; await f.state.setSelectedSession("p", "old"); await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "old", true);
});
test("same-value committed selection also retires cleanup permission", async () => {
  const f = fixture(); await f.entered; await f.state.commitSelection("p", "old", "runtime"); await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "old", true);
});
test("identical-field upsert retires the captured project record", async () => {
  const f = fixture(); await f.entered; await f.state.upsertProject({ ...f.project }); await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "old", true);
});
test("remove and identical-field re-add cannot clear its new selection", async () => {
  const f = fixture(); await f.entered; await f.state.removeProject("p"); await f.state.upsertProject({ ...f.project }); await f.state.setSelectedSession("p", "old"); await f.finish();
  assert.equal(f.state.selectedSessionId("p") === "old", true);
});
test("another project's selection write does not invalidate current cleanup", async () => {
  const f = fixture(); await f.entered; await f.state.setSelectedSession("q", "other"); await f.state.commitSelection("q", "other", "chat"); await f.finish();
  assert.equal(f.state.selectedSessionId("p"), undefined); assert.equal(f.state.selectedSessionId("q"), "other");
});
test("ordinary pin name and order changes preserve cleanup permission", async () => {
  const f = fixture(); await f.entered; await f.state.setProjectPinned("p", true); await f.state.setProjectName("p", "renamed"); await f.state.reorderProjects(["q", "p"]); await f.finish();
  assert.equal(f.state.selectedSessionId("p"), undefined); assert.equal(f.state.project("p")?.name, "renamed");
});
test("unknown-project setter behavior remains compatible", async () => {
  const f = fixture("old", ["old"]); await f.entered; await f.state.setSelectedSession("unknown", "accepted"); await f.finish();
  assert.equal(f.state.selectedSessionId("unknown"), "accepted"); assert.equal(f.state.selectedSessionId("p"), "old");
});
test("unknown-project commit retains its existing rejection", async () => {
  const f = fixture("old", ["old"]); await f.entered;
  await assert.rejects(f.state.commitSelection("unknown", "rejected", "chat"), /Unknown project: unknown/u);
  await f.finish(); assert.equal(f.state.selectedSessionId("unknown"), undefined);
});
test("a selection written during cleanup save remains the newer value", async () => {
  const f = fixture(); await f.entered;
  const saved = deferred<void>(), entered = deferred<void>(); let first = true;
  f.state.save = () => { if (!first) return Promise.resolve(); first = false; entered.resolve(); return saved.promise; };
  const result = f.finish(); await entered.promise; await f.state.setSelectedSession("p", "new-after-clear"); saved.resolve(); await result;
  assert.equal(f.state.selectedSessionId("p"), "new-after-clear");
});
test("a newer cleared selection remains cleared without an extra cleanup write", async () => {
  const f = fixture(); await f.entered; await f.state.setSelectedSession("p", undefined); await f.finish();
  assert.equal(f.state.selectedSessionId("p"), undefined); assert.equal(f.saves(), 1);
});
