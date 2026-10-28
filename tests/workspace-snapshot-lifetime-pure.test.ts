import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source text only: never import/construct either product class. All I/O and runtime
// boundaries below are inert deferred promises. Run under an external watchdog:
// VM timeout bounds evaluation, not transpilation or async continuations invoked later.
const root = process.env.BINY_WORKSPACE_LIFETIME_SOURCE_ROOT ?? process.cwd();
const parse = (file: string) => ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const managerSource = parse("src/desktop/electron/main/DesktopAgentManager.ts");
const stateSource = parse("src/desktop/electron/main/DesktopStateStore.ts");
function owner(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const matches = source.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!;
}
function method(source: ts.SourceFile, parent: ts.ClassDeclaration, name: string): ts.MethodDeclaration {
  const matches = parent.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  assert.equal(matches.length, 1, name);
  assert.ok(matches[0]!.body);
  return matches[0]!;
}
const snapshot = method(managerSource, owner(managerSource, "DesktopAgentManager"), "workspaceSnapshot");
const stateOwner = owner(stateSource, "DesktopStateStore");
// A baseline without the new API must reach the behavioral late-result assertion,
// not fail during extraction. No substitute lifetime implementation is installed.
const usesLifetime = snapshot.getText(managerSource).includes("this.state.captureProjectLifetime(");
const stateMethods = ["project", "projects", "upsertProject", "removeProject", "setProjectName", "setProjectPinned", "reorderProjects", "selectedSessionId"];
if (usesLifetime) stateMethods.push("captureProjectLifetime");
const extractedState = stateMethods.map(name => method(stateSource, stateOwner, name));
const allowedCalls = new Set([
  "this.state.captureProjectLifetime", "isProjectCurrent", "this.projects.refreshStoredProject",
  "this.residentRuntime", "this.runtimeSnapshots", "Promise.all", "this.configStore.load",
  "this.configStore.load(project.path).catch", "this.projects.listWorkspaceSessions", "this.projectEvents",
  "restoreProviderCatalogs", "Object.keys", "listConfiguredModelChoices", "filterPickerModelChoices",
  "pickerModels.some", "modelRuntimeInfo", "pickerModels.sort", "Number", "this.readRuntimeProjection",
  "runtime?.getSnapshot", "Object.fromEntries", "this.runtimeSnapshots(projectId).map",
  "this.state.selectedSessionId", "this.runtimeErrors.get", "describeModelConnections",
  "this.state.projects.find", "this.state.projects.map", "this.state.projects.findIndex",
  "this.state.projects.push", "this.state.projects.filter", "this.state.projects.at", "this.save",
  "byId.get", "seen.has", "ordered.push", "seen.add"
]);
for (const [nodes, source] of [[[snapshot], managerSource], [extractedState, stateSource]] as const) {
  for (const node of nodes) {
    const visit = (child: ts.Node): void => {
      assert.ok(!ts.isImportDeclaration(child));
      if (ts.isCallExpression(child)) assert.ok(allowedCalls.has(child.expression.getText(source)), `unreviewed call: ${child.expression.getText(source)}`);
      if (ts.isNewExpression(child)) assert.ok(["Error", "Map", "Set"].includes(child.expression.getText(source)), `unreviewed constructor: ${child.expression.getText(source)}`);
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
}
function compile(text: string): string {
  const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
const stateCode = compile("({" + extractedState.map(node => node.getText(stateSource)).join(",\n") + "})");
const snapshotCode = compile("({" + snapshot.getText(managerSource) + "})");
const vmOptions = { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } };
interface Project { id: string; path: string; name: string; pinned: boolean; addedAt: string }
interface State {
  state: { projects: Project[]; selectedSessionIds: Record<string, string>; activeProjectId?: string };
  save(): Promise<void>;
  captureProjectLifetime?: (id: string) => () => boolean;
  project(id: string): Project | undefined;
  projects(): Project[];
  upsertProject(project: Project): Promise<void>;
  removeProject(id: string): Promise<void>;
  setProjectName(id: string, name: string): Promise<void>;
  setProjectPinned(id: string, pinned: boolean): Promise<void>;
  reorderProjects(ids: string[]): Promise<void>;
  selectedSessionId(id: string): string | undefined;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function gate<T>(value: T) {
  const pending = deferred<T>();
  const entered = deferred<void>();
  return { entered: entered.promise, read: () => { entered.resolve(); return pending.promise; }, release: () => pending.resolve(value) };
}
const project = (): Project => ({ id: "p", path: "/inert/project", name: "Project", pinned: false, addedAt: "fixed" });
function stateFixture(): State {
  const api = runInNewContext(stateCode, {}, vmOptions) as State;
  return Object.assign(api, {
    state: { projects: [project(), { ...project(), id: "other" }], selectedSessionIds: { p: "history" }, activeProjectId: "p" },
    save: () => { const saved = deferred<void>(); saved.resolve(); return saved.promise; }
  });
}
interface Snapshot { project: Project; sessions: { id: string }[]; permissionMode: string; runtimeProjection?: unknown }
type Phase = "config" | "sessions" | "catalogs" | "projection";
function fixture(refreshDetails = true) {
  const state = stateFixture();
  const config = { providers: { inert: {} }, permission: { mode: "ask" }, context: { memory: {} }, chat: {}, defaultModel: "none" };
  const sessions = [{ id: "history" }];
  const projection = { tasks: { tasks: [], hasMore: false }, graphs: [] };
  const stages = {
    inspection: gate(project()), config: gate(config), sessions: gate({ sessions, sessionPage: { sessions } }),
    catalogs: gate([]), projection: gate(projection)
  };
  const runtime = { isRetired: false, getSnapshot: () => ({ info: { sessionId: "history" }, permissionMode: "ask" }) };
  const managed = { runtime };
  const api = runInNewContext(snapshotCode, {
    restoreProviderCatalogs: stages.catalogs.read,
    listConfiguredModelChoices: () => [], filterPickerModelChoices: () => [],
    modelRuntimeInfo: () => { throw new Error("empty picker must not resolve model info"); },
    describeModelConnections: () => []
  }, vmOptions) as { workspaceSnapshot(this: object, id: string, refresh: boolean): Promise<Snapshot> };
  const receiver = {
    state, projects: { refreshStoredProject: stages.inspection.read, listWorkspaceSessions: stages.sessions.read },
    configStore: { load: stages.config.read }, residentRuntime: () => managed, runtimeSnapshots: () => [],
    projectEvents: () => new Map(), modelsStore: {}, readRuntimeProjection: stages.projection.read, runtimeErrors: new Map()
  };
  const pending = api.workspaceSnapshot.call(receiver, "p", refreshDetails);
  // Attach rejection handling immediately, before deliberately advancing mutations.
  const outcome = pending.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  async function reach(phase: Phase): Promise<void> {
    await stages.inspection.entered;
    stages.inspection.release();
    await Promise.all([stages.config.entered, stages.sessions.entered]);
    if (phase === "config") { stages.sessions.release(); return; }
    if (phase === "sessions") { stages.config.release(); return; }
    stages.config.release(); stages.sessions.release();
    await stages.catalogs.entered;
    if (phase === "catalogs") return;
    stages.catalogs.release();
    await stages.projection.entered;
  }
  const finish = async () => {
    for (const stage of Object.values(stages)) stage.release();
    return await outcome;
  };
  return { state, reach, finish, projection };
}
function rejected(result: Awaited<ReturnType<ReturnType<typeof fixture>["finish"]>>): void {
  assert.equal(result.value === undefined, true, "retired workspace must reject, not return a late snapshot");
  assert.match(String(result.error), /Project was removed or replaced while loading workspace: p/u);
}

test("normal workspace completes every inert read and returns the assembled snapshot", { timeout: 2_000 }, async () => {
  const f = fixture(); await f.reach("projection");
  const result = await f.finish();
  assert.equal(result.error, undefined);
  assert.equal(result.value?.project.id, "p");
  assert.equal(result.value?.sessions[0]?.id, "history");
  assert.equal(result.value?.permissionMode, "ask");
  assert.equal(result.value?.runtimeProjection, f.projection);
});

for (const phase of ["config", "sessions", "catalogs", "projection"] as const) {
  for (const mutation of ["remove", "same-fields-readd", "same-fields-upsert"] as const) {
    test(`${mutation} while ${phase} is pending rejects the old workspace`, { timeout: 2_000 }, async () => {
      const f = fixture(); await f.reach(phase);
      const original = f.state.project("p")!;
      if (mutation !== "same-fields-upsert") await f.state.removeProject("p");
      if (mutation !== "remove") await f.state.upsertProject(original);
      rejected(await f.finish());
    });
  }
}

test("pin, rename and reorder preserve the stored lifetime during a late read", { timeout: 2_000 }, async () => {
  const f = fixture(); await f.reach("projection");
  await f.state.setProjectPinned("p", true);
  await f.state.setProjectName("p", "Renamed");
  await f.state.reorderProjects(["other", "p"]);
  const result = await f.finish();
  assert.equal(result.error, undefined);
  assert.equal(result.value?.project.id, "p");
  assert.equal(f.state.project("p")?.pinned, true);
  assert.equal(f.state.project("p")?.name, "Renamed");
  assert.equal(f.state.projects()[1]?.id, "p");
});

test("capture source API presence and stored identity contract", { timeout: 2_000 }, async () => {
  if (!usesLifetime) {
    assert.equal(stateOwner.members.some(node => ts.isMethodDeclaration(node) && node.name.getText(stateSource) === "captureProjectLifetime"), false);
    assert.equal(snapshot.getText(managerSource).includes("captureProjectLifetime"), false);
    // Baseline control checks API absence only, not lifetime behavior.
    return;
  }
  const state = stateFixture();
  const current = state.captureProjectLifetime!("p");
  assert.equal(current(), true);
  const copy = state.project("p")!; copy.name = "Copy only";
  assert.notEqual(state.project("p"), state.project("p"));
  assert.equal(current(), true);
  await state.setProjectPinned("p", true); await state.setProjectName("p", "Changed"); await state.reorderProjects(["other", "p"]);
  assert.equal(current(), true);
  const identical = state.project("p")!;
  await state.upsertProject(identical);
  assert.equal(current(), false);
  const replacement = state.captureProjectLifetime!("p");
  assert.equal(replacement(), true);
  await state.removeProject("p"); await state.upsertProject(identical);
  assert.equal(replacement(), false);
  const absent = state.captureProjectLifetime!("absent");
  assert.equal(absent(), false);
  await state.upsertProject({ ...project(), id: "absent" });
  assert.equal(absent(), false);
});


test("existence-only snapshots still reject removal after the catalog await", { timeout: 2_000 }, async () => {
  const f = fixture(false); await f.reach("catalogs");
  await f.state.removeProject("p");
  rejected(await f.finish());
});
