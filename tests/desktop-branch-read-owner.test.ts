import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Only parse App source; no App, Electron, Host, Git, or transport module is imported.
const source = ts.createSourceFile("App.tsx", readFileSync(path.join(process.cwd(), "src/desktop/renderer/src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean, optional = false): ts.Node | undefined {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(source);
  if (optional && matches.length === 0) return undefined;
  assert.equal(matches.length, 1, "Expected one production node");
  return matches[0]!;
}
function variable(name: string, optional = false): ts.VariableDeclaration | undefined {
  return find(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name, optional) as ts.VariableDeclaration | undefined;
}
function effect(hook: string, marker: string, optional = false): ts.CallExpression | undefined {
  return find(node => ts.isCallExpression(node) && node.expression.getText(source) === hook
    && Boolean(node.arguments[0]?.getText(source).includes(marker)), optional) as ts.CallExpression | undefined;
}
const ownerEffect = effect("useLayoutEffect", "branchProjectRef.current = composerProject?.id", true);
const readEffect = effect("useEffect", "void loadProjectBranches(projectId)")!;
const ownerRef = variable("branchProjectRef", true);
assert.equal(Boolean(ownerEffect), Boolean(ownerRef), "Owner ref and layout synchronization must be introduced together");
const declarations = [variable("branchRequestRef")!, ...(ownerRef ? [ownerRef] : []), variable("loadProjectBranches")!];
const project = variable("composerProject")!;
const allowedCalls = new Set(["useRef", "useCallback", "useLayoutEffect", "useEffect", "projects.find",
  "window.biny.listProjectBranches", "setProjectBranches", "setBranchesLoading", "setWarning", "errorMessage", "loadProjectBranches"]);
function audit(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  assert.equal(ts.isNewExpression(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  ts.forEachChild(node, audit);
}
for (const node of [...declarations, project, readEffect, ...(ownerEffect ? [ownerEffect] : [])]) audit(node);
const extracted = `${declarations.map(node => `const ${node.getText(source)};`).join("\n")}
function render(projects, workspace, draftProjectId, selectedSessionId) {
  const ${project.getText(source)};
  return { commit: ${ownerEffect?.arguments[0]?.getText(source) ?? "() => undefined"}, read: ${readEffect.arguments[0]!.getText(source)} };
}`;
assert.equal(/require\s*\(|import\s*\(|process|setTimeout|fetch\s*\(/u.test(extracted), false);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Branch = { name: string; current: boolean };
const branches = (name: string): Branch[] => [{ name, current: true }];
function fixture() {
  const state = { branches: branches("initial"), loading: false, warnings: [] as string[], writes: 0 };
  const reads: Array<{ projectId: string; result: ReturnType<typeof deferred<Branch[]>> }> = [];
  const context = createContext({
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    window: { biny: { listProjectBranches(projectId: string) {
      const result = deferred<Branch[]>(); reads.push({ projectId, result }); return result.promise;
    } } },
    setProjectBranches: (value: Branch[]) => { state.branches = value; state.writes++; },
    setBranchesLoading: (value: boolean) => { state.loading = value; state.writes++; },
    setWarning: (value: string) => { state.warnings.push(value); state.writes++; },
    errorMessage: (error: Error) => error.message
  }, { codeGeneration: { strings: false, wasm: false } });
  const evaluate = (text: string): unknown => {
    const emitted = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
    assert.equal(emitted.diagnostics?.length ?? 0, 0);
    return new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  };
  evaluate(extracted);
  let cleanup: (() => void) | undefined;
  const render = (workspaceId?: string, draftProjectId?: string, selectedSessionId?: string) => {
    Object.assign(context, { workspaceId, draftProjectId, selectedSessionId });
    return evaluate('render([{id: "a"}, {id: "b"}], workspaceId ? {project: {id: workspaceId}} : undefined, draftProjectId, selectedSessionId)') as { commit(): (() => void) | undefined; read(): void };
  };
  const commit = (workspaceId?: string, draftProjectId?: string, selectedSessionId?: string) => {
    const next = render(workspaceId, draftProjectId, selectedSessionId);
    cleanup?.(); cleanup = next.commit(); return next;
  };
  const load = (id: string): Promise<void> => { context.requestedId = id; return evaluate("loadProjectBranches(requestedId)") as Promise<void>; };
  return {
    state, reads, render, commit, load,
    // On the baseline the forbidden read exists: settle it so red means a business
    // assertion failure, not a hung promise or missing fixture symbol.
    async staleRead(id: string): Promise<void> {
      const start = reads.length; const pending = load(id);
      for (const read of reads.slice(start)) read.result.resolve(branches(`unexpected-${id}`));
      await pending;
    },
    unmount: () => { cleanup?.(); },
    sequence: () => evaluate("branchRequestRef.current") as number,
    owner: () => ownerRef ? evaluate("branchProjectRef.current") as string | undefined : undefined
  };
}
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

test("branch owner is committed in layout, not by an abandoned render", async () => {
  if (ownerEffect) assert.equal(ownerEffect.arguments[1]?.getText(source), "[composerProject?.id]");
  assert.equal(readEffect.arguments[1]?.getText(source), "[composerProject?.id, loadProjectBranches]");
  const h = fixture(); h.commit("a"); h.render("b");
  if (ownerEffect) assert.equal(h.owner(), "a");
  const pending = h.load("a"); h.reads[0]!.result.resolve(branches("a")); await pending;
  assert.equal(h.state.branches[0]?.name, "a");
});

test("late A completion cannot start an A read after B has loaded", async () => {
  const h = fixture(); h.commit("a");
  const completion = deferred<void>();
  // Models only the post-await read call shared by switch/create/Inspector callbacks.
  const lateRead = completion.promise.then(() => h.load("a"));
  h.commit("b").read(); h.reads[0]!.result.resolve(branches("b")); await flush();
  const before = { sequence: h.sequence(), writes: h.state.writes };
  completion.resolve(); await flush();
  for (const read of h.reads.slice(1)) read.result.resolve(branches("unexpected-a"));
  await lateRead;
  assert.deepEqual(h.reads.map(read => read.projectId), ["b"]);
  assert.equal(h.state.branches[0]?.name, "b");
  assert.equal(h.state.loading, false);
  assert.deepEqual({ sequence: h.sequence(), writes: h.state.writes }, before);
});

test("late A read cannot steal B's pending sequence or loading", async () => {
  const h = fixture(); h.commit("b").read();
  const sequence = h.sequence(); const writes = h.state.writes;
  await h.staleRead("a");
  assert.equal(h.sequence(), sequence); assert.equal(h.state.writes, writes);
  assert.equal(h.state.loading, true); assert.equal(h.reads.length, 1);
  h.reads[0]!.result.resolve(branches("b")); await flush();
  assert.equal(h.state.branches[0]?.name, "b"); assert.equal(h.state.loading, false);
});

for (const outcome of ["success", "error"] as const) {
  test(`old ${outcome} and finally cannot publish after B layout commit before passive refresh`, async () => {
    const h = fixture(); h.commit("a"); const pending = h.load("a");
    h.commit("b"); const writes = h.state.writes;
    if (outcome === "success") h.reads[0]!.result.resolve(branches("old-a"));
    else h.reads[0]!.result.reject(new Error("old-a"));
    await pending;
    assert.equal(h.state.writes, writes); assert.deepEqual(h.state.warnings, []);
    // The pre-existing array/ loading are cleared by the passive effect, not by this fix.
    assert.equal(h.state.loading, true);
  });
  test(`same-project newer read survives older ${outcome} and finally`, async () => {
    const h = fixture(); h.commit("a");
    const first = h.load("a"); const second = h.load("a");
    if (outcome === "success") h.reads[0]!.result.resolve(branches("old"));
    else h.reads[0]!.result.reject(new Error("old"));
    await first; assert.equal(h.state.loading, true); assert.deepEqual(h.state.warnings, []);
    h.reads[1]!.result.resolve(branches("new")); await second;
    assert.equal(h.state.branches[0]?.name, "new"); assert.equal(h.state.loading, false);
  });
}

test("current read failure retains existing clearing and warning behavior", async () => {
  const h = fixture(); h.commit("a"); const pending = h.load("a");
  h.reads[0]!.result.reject(new Error("current")); await pending;
  assert.equal(h.state.branches.length, 0); assert.deepEqual(h.state.warnings, ["current"]);
  assert.equal(h.state.loading, false);
});

test("draft B owns branch reads while workspace A still owns an existing session", async () => {
  const h = fixture(); h.commit("a", "b").read();
  if (ownerEffect) assert.equal(h.owner(), "b"); assert.equal(h.reads[0]?.projectId, "b");
  await h.staleRead("a"); assert.equal(h.reads.length, 1);
  h.reads[0]!.result.resolve(branches("b")); await flush();
  h.commit("a", "b", "session-a").read();
  if (ownerEffect) assert.equal(h.owner(), "a"); assert.equal(h.reads[1]?.projectId, "a");
  h.reads[1]!.result.resolve(branches("a")); await flush();
  assert.equal(h.state.branches[0]?.name, "a");
});

test("A to B to A allows a late A completion to refresh the current A", async () => {
  const h = fixture(); h.commit("a").read(); h.commit("b").read(); h.commit("a").read();
  const pending = h.load("a"); assert.equal(h.reads.length, 4);
  h.reads[3]!.result.resolve(branches("refreshed-a")); await pending;
  for (const read of h.reads.slice(0, 3)) read.result.resolve(branches("obsolete"));
  await flush(); assert.equal(h.state.branches[0]?.name, "refreshed-a"); assert.equal(h.state.loading, false);
});

test("no project retires reads and clears the list via the existing passive effect", async () => {
  const h = fixture(); h.commit("a"); const pending = h.load("a");
  h.commit().read(); const writes = h.state.writes; const sequence = h.sequence();
  await h.staleRead("a"); h.reads[0]!.result.reject(new Error("removed")); await pending;
  assert.equal(h.sequence(), sequence); assert.equal(h.state.writes, writes);
  assert.equal(h.state.branches.length, 0); assert.equal(h.state.loading, false);
  assert.deepEqual(h.state.warnings, []);
});

test("layout cleanup prevents reads and settlement after unmount", async () => {
  const h = fixture(); h.commit("a"); const pending = h.load("a"); h.unmount();
  const writes = h.state.writes; const sequence = h.sequence();
  await h.staleRead("a"); h.reads[0]!.result.resolve(branches("old")); await pending;
  assert.equal(h.state.writes, writes); assert.equal(h.sequence(), sequence);
});
