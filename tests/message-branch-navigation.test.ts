/** Execute the actual App callback with only UI/transport boundaries substituted. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
const source = ts.createSourceFile("App.tsx", readFileSync("src/desktop/renderer/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function variable(name: string): ts.VariableDeclaration {
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) matches.push(node); ts.forEachChild(node, visit); };
  visit(source); assert.equal(matches.length, 1); return matches[0]!;
}
const callback = variable("openTurnBranch");
const pendingRef = variable("messageBranchPendingRef");
const openSession = variable("openSession");
const code = `${[openSession, pendingRef, callback].map(node => `const ${node.getText(source)};`).join("\n")}\nopenTurnBranch;`;
const allowedCalls = new Set(["useRef", "useCallback", "projectRemovalRef.current.get", "ownsSource", "window.biny.branchSessionAtMessage",
  "openSession", "commitNavigation", "pushNavigation", "setToast", "setWarning", "errorMessage",
  "setPendingNavigation", "setMemoryToggleBusy", "setLoading", "readDesktopSession", "mergeWorkspaceProject", "setRuntimePanelOpen",
  "setSelectedSessionId", "setDraftProjectId", "setDraftMemoryOverride", "setContextBudget", "setDocument", "setWriterConflict",
  "sessionTreePages.observe", "setSidebarSessions", "mergeProjectSessionPage", "setWorkspace", "window.biny.commitSelection",
  "window.biny.commitSelection(projectId, sessionId, activeView).catch"]);
function audit(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Error");
  assert.equal(ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  ts.forEachChild(node, audit);
}
audit(callback); audit(pendingRef); audit(openSession);
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const creation = deferred<string>();
  const reads = deferred<boolean>();
  const requests: string[][] = []; const opened: string[][] = [];
  const warnings: string[] = []; const toasts: string[] = []; const navigations: unknown[] = [];
  const projectRef = { current: "p" }; const selectedRef = { current: "s" }; const loadRequestRef = { current: 1 };
  const context = createContext({ useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn,
    projectRef, selectedRef, loadRequestRef, projectRemovalRef: { current: new Map() }, navigationRef: { current: "history" },
    desktopApiVersionMismatchMessage: "API mismatch", Error,
    window: { biny: { branchSessionAtMessage(...args: string[]) { requests.push(args); return creation.promise; },
      commitSelection: async () => undefined } },
    async readDesktopSession(_api: unknown, projectId: string, sessionId: string) {
      opened.push([projectId, sessionId]); await reads.promise;
      return { document: { session: { id: sessionId }, writerConflict: undefined } };
    },
    memoryToggleRequestRef: { current: 0 }, permissionModeRequestRef: { current: 0 },
    setPendingNavigation: () => undefined, setMemoryToggleBusy: () => undefined, setLoading: () => undefined,
    mergeWorkspaceProject: () => undefined, setRuntimePanelOpen: () => undefined,
    setSelectedSessionId: () => undefined, setDraftProjectId: () => undefined, setDraftMemoryOverride: () => undefined,
    setContextBudget: () => undefined, setDocument: () => undefined, setWriterConflict: () => undefined,
    sessionTreePages: { observe: () => undefined }, setSidebarSessions: () => undefined, setWorkspace: () => undefined,
    mergeProjectSessionPage: () => undefined,
    setWarning: (value: string) => warnings.push(value), setToast: (value: string) => toasts.push(value), errorMessage: (error: Error) => error.message,
    pushNavigation: (...args: unknown[]) => args, commitNavigation: (value: unknown) => navigations.push(value)
  }, { codeGeneration: { strings: false, wasm: false } });
  const emitted = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal(emitted.diagnostics?.length ?? 0, 0);
  const branch = new Script(emitted.outputText).runInContext(context, { timeout: 1000 }) as (project: string, session: string, message: string) => Promise<void>;
  return { branch, creation, reads, requests, opened, warnings, toasts, navigations, projectRef, selectedRef, loadRequestRef };
}
test("message branch sends selected identity once and opens the created child", async () => {
  const f = fixture(); const pending = f.branch("p", "s", "answer");
  await f.branch("p", "s", "answer"); assert.deepEqual(f.requests, [["p", "s", "answer"]]);
  f.creation.resolve("child"); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(f.opened, [["p", "child"]]);
  f.reads.resolve(true); await pending; assert.equal(f.toasts.length, 1); assert.equal(f.navigations.length, 1);
});
test("stale rendered menu and late branch creation cannot retarget newer navigation", async () => {
  const f = fixture(); await f.branch("other", "s", "answer"); assert.equal(f.requests.length, 0);
  const pending = f.branch("p", "s", "answer"); f.selectedRef.current = "newer"; f.loadRequestRef.current++;
  f.creation.resolve("child"); await pending; assert.equal(f.opened.length, 0); assert.equal(f.navigations.length, 0); assert.equal(f.toasts.length, 0);
});
test("branch rejection keeps the source and can be retried, without an unhandled rejection", async () => {
  const f = fixture(); const pending = f.branch("p", "s", "answer"); f.creation.reject(new Error("Cannot safely branch")); await pending;
  assert.deepEqual(f.warnings, ["Cannot safely branch"]); assert.equal(f.selectedRef.current, "s"); assert.equal(f.opened.length, 0);
  await f.branch("p", "s", "answer"); assert.equal(f.requests.length, 2);
});
test("created branch read failure explains that the child remains available", async () => {
  const f = fixture(); const pending = f.branch("p", "s", "answer"); f.creation.resolve("child"); await new Promise<void>(resolve => setImmediate(resolve));
  f.reads.reject(new Error("read failed")); await pending;
  assert.match(f.warnings[0]!, /分支已创建，但打开失败/u); assert.equal(f.selectedRef.current, "s"); assert.equal(f.navigations.length, 0);
});
test("superseded branch read does not commit navigation or toast", async () => {
  const f = fixture(); const pending = f.branch("p", "s", "answer"); f.creation.resolve("child"); await new Promise<void>(resolve => setImmediate(resolve));
  f.loadRequestRef.current++; f.selectedRef.current = "newer"; f.reads.resolve(false); await pending;
  assert.equal(f.navigations.length, 0); assert.equal(f.toasts.length, 0); assert.equal(f.warnings.length, 0);
});
test("leave and return to the same source still invalidates an older branch completion", async () => {
  const f = fixture(); const pending = f.branch("p", "s", "answer"); f.loadRequestRef.current += 2;
  f.creation.resolve("child"); await pending;
  assert.equal(f.opened.length, 0); assert.equal(f.navigations.length, 0); assert.equal(f.toasts.length, 0);
});
test("late failure from the previous source does not overwrite the current warning", async () => {
  const f = fixture(); const pending = f.branch("p", "s", "answer"); f.loadRequestRef.current++;
  f.creation.reject(new Error("old branch failure")); await pending; assert.equal(f.warnings.length, 0);
});
