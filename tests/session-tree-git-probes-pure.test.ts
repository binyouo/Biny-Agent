/** Actual source methods with inert inspection/storage collaborators; no product imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Project = { id: string; path: string; name: string; branch?: string; dirty: boolean; missing: boolean };
type Options = { parentSessionId?: string; cursor?: string; limit?: number; includeArchived?: boolean; includePinnedSessions?: boolean };
type Item = { id: string; pinned?: boolean };
type Page = { projectId: string; parentSessionId?: string; revision: string; sessions: unknown[]; pinnedSessions?: unknown[]; nextCursor?: string; revisionChanged: boolean };
type Inspection = (project: Project, refreshGit?: boolean) => Promise<Project>;
type ServicePage = (project: Project, runtime: unknown, events: unknown, options?: Options) => Promise<Page>;
type ManagerPage = (projectId: string, options?: Options) => Promise<Page>;
const sourceRoot = process.env.BINY_SESSION_TREE_SOURCE_ROOT ?? process.cwd();

function method(file: string, className: string, name: string, calls: readonly string[]): string {
  const source = ts.createSourceFile(file, readFileSync(path.join(sourceRoot, file), "utf8"), ts.ScriptTarget.Latest, true);
  const classes = source.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === className);
  assert.equal(classes.length, 1);
  const methods = classes[0]!.members.filter(ts.isMethodDeclaration).filter(node => node.name.getText(source) === name);
  assert.equal(methods.length, 1);
  const selected = methods[0]!;
  assert.ok(selected.body);
  const allowed = new Set(calls);
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node), "no imports in selected method");
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression.getText(source);
      assert.ok(allowed.has(callee), `unreviewed callee: ${callee}`);
      seen.add(callee);
    }
    ts.forEachChild(node, visit);
  };
  visit(selected);
  assert.deepEqual([...seen].sort(), [...allowed].sort(), "selected method closure changed");
  return selected.getText(source);
}

const inspectText = method("src/desktop/electron/main/DesktopProjectService.ts", "DesktopProjectService", "inspectProject", [
  "directoryExists", "Promise.all", "gitOutput", "branch?.trim", "Boolean", "status?.trim"
]);
const servicePageText = method("src/desktop/electron/main/DesktopProjectService.ts", "DesktopProjectService", "listSessionTreePage", [
  "this.storage.ensureProjectData", "ensureAgentDirs", "listSessionCatalog", "querySessionCatalogItems", "catalog.filter",
  "Map", "[...page.items, ...(pinnedItems ?? [])].map", "RuntimeEventAuthority.readLatestSessionRuns", "visible.keys", "[...visible].map", "desktopSessionSummary",
  "latestRuns.get", "page.items.map", "summaries.get", "pinnedItems?.map"
]);
const managerText = method("src/desktop/electron/main/DesktopAgentManager.ts", "DesktopAgentManager", "listSessionTreePage", [
  "this.projects.inspectProject", "this.projects.requireProject", "this.projects.listSessionTreePage", "this.runtimeSnapshots", "this.projectEvents"
]);

function fixture(input: { exists?: boolean; storedMissing?: boolean; items?: Item[]; pinned?: Item[]; nextCursor?: string; revisionChanged?: boolean; gitUnavailable?: boolean } = {}) {
  const project: Project = Object.freeze({ id: "project", path: "/space 名/worktree ", name: "Project", branch: "saved", dirty: true, missing: input.storedMissing ?? false });
  const existence: string[] = [];
  const probes: { cwd: string; args: string[] }[] = [];
  const storage: string[] = [];
  const queries: Options[] = [];
  const snapshots = Object.freeze([{ value: "snapshot" }]);
  const events = new Map();
  const items = input.items ?? [{ id: "child" }];
  const pinned = input.pinned ?? [];
  const catalog = [...items, ...pinned];
  const failures: { require?: Error; directory?: Error; storage?: Error; catalog?: Error; query?: Error; ledger?: Error; snapshots?: Error; events?: Error } = {};
  let exists = input.exists ?? true;
  const context = vm.createContext({
    directoryExists: async (cwd: string) => { existence.push(cwd); if (failures.directory) throw failures.directory; return exists; },
    gitOutput: async (cwd: string, args: string[]) => {
      probes.push({ cwd, args: Array.from(args) });
      return input.gitUnavailable ? undefined : args[0] === "branch" ? "fresh\n" : " M changed.txt\n";
    },
    ensureAgentDirs: async (root: string) => { assert.equal(root, project.path); },
    listSessionCatalog: async (root: string) => { assert.equal(root, project.path); if (failures.catalog) throw failures.catalog; return catalog; },
    querySessionCatalogItems: (received: Item[], options: Options) => {
      assert.equal(received, catalog); queries.push(options); if (failures.query) throw failures.query;
      return { items, revision: "revision", nextCursor: input.nextCursor, revisionChanged: input.revisionChanged ?? false };
    },
    RuntimeEventAuthority: class {
      constructor(root: string) { assert.equal(root, project.path); }
      static async readLatestSessionRuns(_root: string, ids: string[]) {
        if (failures.ledger) throw failures.ledger;
        return new Map(ids.map(id => [id, `run:${id}`]));
      }
    },
    desktopSessionSummary: (id: string, item: Item, receivedSnapshots: unknown, receivedEvents: unknown, run: unknown) => {
      assert.equal(id, project.id); assert.equal(receivedSnapshots, snapshots); assert.equal(receivedEvents, events);
      return { id: item.id, projectId: id, run };
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = `class Inspection { ${inspectText} }\nclass Service { ${servicePageText} }\nclass Manager { ${managerText} }\n({ inspect: Inspection.prototype.inspectProject, page: Service.prototype.listSessionTreePage, manager: Manager.prototype.listSessionTreePage });`;
  const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const extracted = vm.runInContext(compiled.outputText, context, { timeout: 1_000 }) as { inspect: Inspection; page: ServicePage; manager: ManagerPage };
  const service = {
    storage: { ensureProjectData: async (current: Project) => { storage.push(current.path); if (failures.storage) throw failures.storage; return current.path; } },
    inspectProject: extracted.inspect,
    listSessionTreePage: extracted.page,
    requireProject: (id: string) => { assert.equal(id, project.id); if (failures.require) throw failures.require; return project; }
  };
  const manager = {
    projects: service,
    runtimeSnapshots: (id: string) => { assert.equal(id, project.id); if (failures.snapshots) throw failures.snapshots; return snapshots; },
    projectEvents: (id: string) => { assert.equal(id, project.id); if (failures.events) throw failures.events; return events; }
  };
  return { project, existence, probes, storage, queries, failures, service,
    setExists: (value: boolean) => { exists = value; },
    page: (options?: Options) => extracted.manager.call(manager, project.id, options) };
}

function expectedPage(options: Options = {}, items: Item[] = [{ id: "child" }], extra: Partial<Page> = {}): string {
  return JSON.stringify({ projectId: "project", parentSessionId: options.parentSessionId, revision: "revision",
    sessions: items.map(item => ({ id: item.id, projectId: "project", run: `run:${item.id}` })),
    pinnedSessions: undefined, nextCursor: undefined, revisionChanged: false, ...extra });
}

test("root session page preserves output while skipping both Git probes", async () => {
  const f = fixture(); const before = JSON.stringify(f.project);
  assert.equal(JSON.stringify(await f.page()), expectedPage());
  assert.equal(JSON.stringify(f.queries), "[{}]");
  assert.deepEqual(f.existence, [f.project.path]); assert.deepEqual(f.storage, [f.project.path]);
  assert.equal(JSON.stringify(f.project), before);
  assert.equal(f.probes.length, 0);
});

test("child cursor page preserves options, pins and next cursor without Git", async () => {
  const options = Object.freeze({ parentSessionId: "parent", cursor: "cursor", limit: 32, includeArchived: true, includePinnedSessions: true });
  const pinned = [{ id: "pinned", pinned: true }];
  const f = fixture({ pinned, nextCursor: "next" });
  assert.equal(JSON.stringify(await f.page(options)), expectedPage(options, [{ id: "child" }], {
    pinnedSessions: [{ id: "pinned", projectId: "project", run: "run:pinned" }], nextCursor: "next"
  }));
  assert.equal(f.queries[0], options); assert.equal(f.probes.length, 0);
});

test("revision-changed empty page is returned unchanged without Git", async () => {
  const options = { parentSessionId: "parent", cursor: "old", includePinnedSessions: true };
  const f = fixture({ items: [], revisionChanged: true, pinned: [{ id: "pinned", pinned: true }] });
  assert.equal(JSON.stringify(await f.page(options)), expectedPage(options, [], { revisionChanged: true }));
  assert.equal(f.queries[0], options); assert.equal(f.probes.length, 0);
});

test("missing directories still return the original empty page without storage or probes", async () => {
  const f = fixture({ exists: false });
  assert.equal(JSON.stringify(await f.page({ parentSessionId: "parent" })), JSON.stringify({
    projectId: "project", parentSessionId: "parent", revision: "sha256:empty", sessions: [], revisionChanged: false
  }));
  assert.deepEqual(f.existence, [f.project.path]); assert.equal(f.storage.length, 0); assert.equal(f.queries.length, 0); assert.equal(f.probes.length, 0);
});

test("each page rechecks directory existence, including recovery, without stale inspection caching", async () => {
  const f = fixture({ exists: false });
  await f.page(); f.setExists(true);
  assert.equal(JSON.stringify(await f.page()), expectedPage());
  f.setExists(false); assert.equal((await f.page()).revision, "sha256:empty");
  assert.equal(f.existence.length, 3); assert.equal(f.storage.length, 1); assert.equal(f.probes.length, 0);
});

test("non-repository helper results are unnecessary to session paging", async () => {
  const f = fixture({ gitUnavailable: true });
  assert.equal(JSON.stringify(await f.page()), expectedPage()); assert.equal(f.probes.length, 0);
});

test("stored missing state is rechecked instead of hiding a restored project", async () => {
  const f = fixture({ storedMissing: true });
  assert.equal(JSON.stringify(await f.page()), expectedPage());
  assert.equal(f.project.missing, true, "inspection must not mutate the stored record");
  assert.deepEqual(f.existence, [f.project.path]); assert.equal(f.probes.length, 0);
});

test("inspection default and explicit refresh retain both probes and normal Git projection", async () => {
  for (const refresh of [undefined, true]) {
    const f = fixture(); const result = await f.service.inspectProject(f.project, refresh);
    assert.equal(JSON.stringify(result), JSON.stringify({ ...f.project, branch: "fresh", dirty: true, missing: false }));
    assert.deepEqual(f.probes, [
      { cwd: f.project.path, args: ["branch", "--show-current"] },
      { cwd: f.project.path, args: ["status", "--porcelain", "--ignore-submodules=all"] }
    ]);
    assert.equal(f.project.branch, "saved"); assert.equal(f.existence.length, 1);
  }
});

test("explicit lightweight inspection preserves saved Git facts and does not mutate input", async () => {
  const f = fixture(); const result = await f.service.inspectProject(f.project, false);
  assert.equal(JSON.stringify(result), JSON.stringify(f.project)); assert.notEqual(result, f.project);
  assert.equal(f.probes.length, 0); assert.equal(f.existence.length, 1);
});

test("lookup, directory, paging and projection errors retain identity", async () => {
  for (const stage of ["require", "directory", "storage", "catalog", "query", "ledger", "snapshots", "events"] as const) {
    const f = fixture(); const error = new Error(stage); f.failures[stage] = error;
    await assert.rejects(f.page(), (caught: unknown) => caught === error);
  }
});
