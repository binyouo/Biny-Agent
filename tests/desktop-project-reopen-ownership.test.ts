import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Actual project opening/state mutation methods; filesystem inspection, Git,
// directory initialization and snapshot writes are inert barriers; actual save
// snapshot capture and write serialization are retained.
const read = (name: string) => readFileSync(new URL(`../src/desktop/electron/main/${name}.ts`, import.meta.url), "utf8");
function extract(source: string, owner: string, names: string[], optional: string[] = []) {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const classes = file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === owner);
  assert.equal(classes.length, 1);
  return names.map(name => {
    const found = classes[0]!.members.filter(node => (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && node.name?.getText(file) === name);
    if (!found.length && optional.includes(name)) return "";
    assert.equal(found.length, 1, name); return found[0]!.getText(file);
  }).join("\n");
}
function fixtureClass(body: string, environment: Record<string, any> = {}) {
  const output: Record<string, any> = {};
  const compiled = ts.transpileModule(`export class Fixture {${body}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.deepEqual(compiled.diagnostics, []);
  vm.runInNewContext(compiled.outputText, { exports: output, structuredClone, ...environment });
  return output.Fixture;
}
const stateSource = read("DesktopStateStore");
const State = fixtureClass(extract(stateSource, "DesktopStateStore", ["writeTail", "save", "enqueueWrite", "projectOpenOwners", "projectInspectionTokens", "projectGitInspectionTokens", "projects", "project", "openProject", "upsertProject", "setProjectName", "setProjectPinned", "removeProject", "refreshProjectInspection"], ["projectOpenOwners", "openProject"]));
const serviceSource = read("DesktopProjectService");
const serviceMethods = extract(serviceSource, "DesktopProjectService", ["createProject"]);
const file = ts.createSourceFile("service.ts", serviceSource, ts.ScriptTarget.Latest, true);
const identities = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "projectId");
assert.equal(identities.length, 1);
const identityEnv: Record<string, any> = { createHash };
vm.runInNewContext(ts.transpileModule(`${identities[0]!.getText(file)}; globalThis.identify=projectId;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, identityEnv);
const identify: (value: string) => string = identityEnv.identify;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush(): Promise<void> { for (let index = 0; index < 30; index++) await Promise.resolve(); }
type Boundary = "stat" | "inspect" | "storage" | "save";
const root = path.resolve("/inert/project");
function original(directory = root) {
  return { id: identify(directory), path: directory, name: "Original", iconDataUrl: "old-icon", pinned: false,
    addedAt: "2020-01-01T00:00:00.000Z", lastOpenedAt: "2020-01-02T00:00:00.000Z", branch: "old", dirty: true, missing: false };
}
function fixture(existing = true) {
  const barriers = new Map<string, ReturnType<typeof deferred>>();
  const failures = new Set<Boundary>(); const saved: any[][] = [];
  let inspected = 0, initialized = 0, failWrites = 0;
  const boundary = async (kind: Boundary, directory = root) => {
    const key = `${kind}:${directory}`, gate = barriers.get(key); barriers.delete(key);
    if (gate) await gate.promise;
    if (failures.has(kind)) throw Error(`${kind} failed`);
  };
  const state = Object.assign(new State(), {
    state: { projects: existing ? [original()] : [], selectedSessionIds: {}, activeProjectId: existing ? identify(root) : undefined },
    settingsPreferences() { return { revision: 0 }; },
    async writeSnapshot(snapshot: { projects: any[] }) { await boundary("save"); if (failWrites > 0) { failWrites--; throw Error("snapshot write failed"); } saved.push(structuredClone(snapshot.projects)); }
  });
  const Service = fixtureClass(serviceMethods, { path, projectId: identify, fs: { async stat(directory: string) { await boundary("stat", directory); return { isDirectory: () => true }; } } });
  const service = Object.assign(new Service(), { state,
    async inspectProject(project: any) { inspected++; await boundary("inspect", project.path); return { ...project, branch: "main", dirty: false, missing: false }; },
    storage: { async ensureProjectData(project: any) { initialized++; await boundary("storage", project.path); } }
  });
  return { state, service, saved, failures, failNextWrite() { failWrites++; },
    hold(kind: Boundary, directory = root) { const gate = deferred(); barriers.set(`${kind}:${directory}`, gate); return gate; },
    current: () => state.project(identify(root)), calls: () => ({ inspected, initialized }) };
}

for (const boundary of ["stat", "inspect", "storage", "save"] as const) {
  test(`${boundary}: preserve completed rename and pin; return latest stored metadata`, async () => {
    const f = fixture(), gate = f.hold(boundary), opened = f.service.createProject(root);
    await flush();
    const edits = Promise.all([f.state.setProjectName(identify(root), "Renamed"), f.state.setProjectPinned(identify(root), true)]);
    if (boundary === "save") gate.resolve();
    await edits;
    gate.resolve(); const result = await opened;
    assert.equal(result.name, "Renamed"); assert.equal(result.pinned, true);
    assert.equal(f.current().name, "Renamed"); assert.equal(f.current().pinned, true);
    assert.equal(result.addedAt, original().addedAt); assert.equal(result.iconDataUrl, "old-icon");
    assert.ok(result.lastOpenedAt > original().lastOpenedAt);
    assert.equal(f.saved.at(-1)?.[0]?.name, "Renamed");
    if (boundary === "save") {
      assert.deepEqual(f.saved.map(rows => [rows[0]?.name, rows[0]?.pinned]),
        [["Original", false], ["Renamed", false], ["Renamed", true]]);
    }
  });

  test(`${boundary}: removal retires pending reopen without resurrecting project`, async () => {
    const f = fixture(), gate = f.hold(boundary), opened = f.service.createProject(root);
    const rejected = assert.rejects(opened, /changed while opening/);
    await flush(); const removed = f.state.removeProject(identify(root));
    gate.resolve(); await removed; await rejected;
    assert.equal(f.current(), undefined); assert.deepEqual(f.state.projects(), []);
  });

  test(`${boundary}: identical remove/re-add incarnation is never overwritten`, async () => {
    const f = fixture(), gate = f.hold(boundary), opened = f.service.createProject(root);
    const rejected = assert.rejects(opened, /changed while opening/);
    await flush();
    const edits = Promise.all([f.state.removeProject(identify(root)), f.state.upsertProject(original()),
      f.state.setProjectName(identify(root), "Re-added"), f.state.setProjectPinned(identify(root), true)]);
    const before = JSON.stringify(f.current()); gate.resolve(); await edits; await rejected;
    assert.equal(JSON.stringify(f.current()), before);
    assert.equal(JSON.stringify(f.saved.at(-1)?.[0]), before);
    if (boundary === "save") assert.equal(f.saved[1]?.length, 0);
  });
}

test("upsert of a completed new icon incarnation retires stale reopen", async () => {
  const f = fixture(), gate = f.hold("storage"), opened = f.service.createProject(root);
  const rejected = assert.rejects(opened, /changed while opening/); await flush();
  await f.state.upsertProject({ ...original(), iconDataUrl: "new-icon" }); gate.resolve(); await rejected;
  assert.equal(f.current().iconDataUrl, "new-icon");
});

for (const existing of [false, true]) {
  test(`${existing ? "existing" : "new"} project keeps explicit icon and timestamp contract`, async () => {
    const f = fixture(existing); const result = await f.service.createProject(root, "explicit-icon");
    assert.equal(result.iconDataUrl, "explicit-icon"); assert.equal(f.current().iconDataUrl, "explicit-icon");
    assert.equal(result.id, identify(root)); assert.equal(result.path, root);
    if (existing) assert.equal(result.addedAt, original().addedAt);
    else { assert.equal(result.addedAt, result.lastOpenedAt); assert.equal(result.name, path.basename(root)); assert.equal(result.pinned, false); }
  });
}

test("same-path contender cannot release owner; different project opens independently", async () => {
  const f = fixture(), gate = f.hold("inspect"), first = f.service.createProject(root); await flush();
  try {
    await assert.rejects(f.service.createProject(root), /already being opened/);
    await assert.rejects(f.service.createProject(root), /already being opened/);
    const other = await f.service.createProject(path.resolve("/inert/other"));
    assert.equal(other.name, "other"); assert.equal(f.calls().inspected, 2);
  } finally { gate.resolve(); await first; }
  await f.service.createProject(root);
});

test("retired old owner's finally does not unlock new open", async () => {
  const f = fixture(), oldGate = f.hold("inspect"), old = f.service.createProject(root);
  const oldRejected = assert.rejects(old, /changed while opening/); await flush();
  await f.state.removeProject(identify(root));
  const newGate = f.hold("storage"), fresh = f.service.createProject(root, "fresh-icon"); await flush();
  oldGate.resolve(); await oldRejected;
  try { await assert.rejects(f.service.createProject(root), /already being opened/); }
  finally { newGate.resolve(); await fresh; }
  assert.equal(f.current().iconDataUrl, "fresh-icon");
});

test("new-project preparation never merges an intervening explicit registration", async () => {
  const f = fixture(false), gate = f.hold("stat"), pending = f.service.createProject(root);
  const rejected = assert.rejects(pending, /changed while opening/); await flush();
  await f.state.upsertProject({ ...original(), name: "Registered elsewhere", pinned: true });
  const before = JSON.stringify(f.current()); gate.resolve(); await rejected;
  assert.equal(JSON.stringify(f.current()), before);
});

test("new registration then removal does not restore an older pending creation", async () => {
  const f = fixture(false), gate = f.hold("stat"), pending = f.service.createProject(root);
  const rejected = assert.rejects(pending, /changed while opening/); await flush();
  await f.state.upsertProject(original()); await f.state.removeProject(identify(root));
  gate.resolve(); await rejected; assert.equal(f.current(), undefined);
});

for (const boundary of ["stat", "inspect", "storage", "save"] as const) {
  test(`${boundary} failure releases owner for retry`, async () => {
    const f = fixture(); f.failures.add(boundary);
    await assert.rejects(f.service.createProject(root), new RegExp(`${boundary} failed`));
    f.failures.delete(boundary); const reopened = await f.service.createProject(root);
    assert.equal(reopened.id, identify(root)); assert.equal(reopened.name, "Original");
  });
}

test("returned project is detached from persistent state", async () => {
  const f = fixture(); const opened = await f.service.createProject(root);
  opened.name = "Mutated return"; assert.equal(f.current().name, "Original");
});

test("pre-open inspection cannot replay stale branch/name after open commits", async () => {
  const f = fixture(), gate = deferred();
  const refresh = f.state.refreshProjectInspection(identify(root), async () => { await gate.promise; return { branch: "stale", dirty: true, missing: false }; });
  const opened = await f.service.createProject(root); await f.state.setProjectName(identify(root), "Current");
  gate.resolve(); await refresh;
  assert.equal(f.current().branch, opened.branch); assert.equal(f.current().name, "Current");
});

// Later writes cannot complete ahead of a held snapshot; failures must not
// poison the real writeTail, nor hold the opening owner after rejection.
test("failed opening snapshot drains queued metadata writes and permits retry", async () => {
  const f = fixture(), gate = f.hold("save"); f.failNextWrite();
  const opened = f.service.createProject(root);
  const rejected = assert.rejects(opened, /snapshot write failed/);
  await flush();
  let finished = false;
  const edits = Promise.all([f.state.setProjectName(identify(root), "Renamed"), f.state.setProjectPinned(identify(root), true)]).then(() => { finished = true; });
  await flush(); assert.equal(finished, false); assert.equal(f.saved.length, 0);
  gate.resolve(); await rejected; await edits;
  assert.deepEqual(f.saved.map(rows => [rows[0]?.name, rows[0]?.pinned]), [["Renamed", false], ["Renamed", true]]);
  const retried = await f.service.createProject(root);
  assert.equal(retried.name, "Renamed"); assert.equal(retried.pinned, true);
});

test("failed opening snapshot cannot block queued removal and identical re-add", async () => {
  const f = fixture(), gate = f.hold("save"); f.failNextWrite();
  const opened = f.service.createProject(root); const rejected = assert.rejects(opened, /snapshot write failed/);
  await flush();
  const edits = Promise.all([f.state.removeProject(identify(root)), f.state.upsertProject(original())]);
  const before = JSON.stringify(f.current());
  gate.resolve(); await rejected; await edits;
  assert.equal(f.saved[0]?.length, 0); assert.equal(JSON.stringify(f.saved.at(-1)?.[0]), before);
  assert.equal(JSON.stringify(f.current()), before);
  await f.service.createProject(root);
});
