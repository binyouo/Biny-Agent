import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only extracted methods run, with inert runtime/files/save boundaries. No product
// module imports or actual Host, recorder, storage, provider or network resources.
const root = path.resolve(process.env.BINY_SESSION_ACTION_SOURCE_ROOT ?? process.cwd());
const parse = (file: string) => ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
const manager = parse("src/desktop/electron/main/DesktopAgentManager.ts");
const store = parse("src/desktop/electron/main/DesktopStateStore.ts");
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
function method(source: ts.SourceFile, className: string, name: string): ts.MethodDeclaration {
  const declaration = one(source.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === className), className);
  return one(declaration.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === name), name);
}
const actions = ["resumeInterruptedTurn", "retryPrompt", "editPromptOnce", "duplicateSession"] as const;
type Action = typeof actions[number];
const actionMethods = actions.map(name => method(manager, "DesktopAgentManager", name));
const stateNames = ["captureSelectedSessionLifetime", "selectedSessionId", "setSelectedSession", "commitSelection"];
const stateMethods = stateNames.map(name => method(store, "DesktopStateStore", name));
const declaration = one(store.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopStateStore"), "state");
const field = one(declaration.members.filter((node): node is ts.PropertyDeclaration => ts.isPropertyDeclaration(node) && node.name.getText(store) === "selectedSessionTokens"), "tokens");
const allowed = new Set([
  "this.state.captureSelectedSessionLifetime", "this.resolveSessionRuntime", "runtime.startInterruptedTurnForSession", "ownsSelection", "this.state.setSelectedSession", "this.observeRunCompletion",
  "this.runIdempotently", "runtime.getSnapshot", "this.projects.requireProject", "splitAttachmentReferences", "parsed.attachments.map", "loadAgentAttachments", "runtime.submitRunForSession", "errorFromHostOperation",
  "runtime.cancelRunRequest", "runtime.waitForIdle", "this.projects.sessionUserMessageIdAtIndex", "this.runtimeErrors.delete", "this.projects.duplicateSession", "this.workspaceSnapshot",
  "this.state.projects.find", "this.selectedSessionTokens.get", "this.selectedSessionTokens.set", "this.save"
]);
function audit(node: ts.Node, source: ts.SourceFile): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  if (ts.isCallExpression(node)) assert.ok(allowed.has(node.expression.getText(source)), `Unreviewed call ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.ok(["WeakMap", "Error"].includes(node.expression.getText(source)));
  ts.forEachChild(node, child => audit(child, source));
}
for (const node of actionMethods) audit(node, manager);
for (const node of [...stateMethods, field]) audit(node, store);
function compile(text: string): string {
  assert.equal(/\b(?:require|fetch|eval)\b|import\s*\(/u.test(text), false);
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal((output.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return output.outputText;
}
const managerCode = compile(`({${actionMethods.map(node => node.getText(manager).replace(/^private\s+/u, "")).join(",\n")}})`);
const storeCode = compile(`({${stateMethods.map(node => node.getText(store)).join(",\n")}, ${field.name.getText(store)}: ${field.initializer!.getText(store)}})`);
const options = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };
interface State {
  state: { projects: { id: string }[]; selectedSessionIds: Record<string, string>; activeView: string };
  selectedSessionId(id: string): string | undefined;
  commitSelection(id: string, sessionId: string | undefined, view: string): Promise<void>;
}
interface Subject {
  resumeInterruptedTurn(p: string, s: string): Promise<unknown>;
  retryPrompt(p: string, s: string, target: string, input: string, attachments: unknown[], key: string): Promise<unknown>;
  editPromptOnce(p: string, s: string, index: number, input: string, attachments: unknown[]): Promise<unknown>;
  duplicateSession(p: string, s: string): Promise<unknown>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(action: Action, stage: "first" | "admission" = "admission", outcome: "success" | "reject" | "denied" | "noop" = "success") {
  const entered = deferred<void>(), gate = deferred<void>();
  let saves = 0;
  const state = Object.assign(runInNewContext(storeCode, {}, options) as State, {
    state: { projects: [{ id: "p" }, { id: "q" }], selectedSessionIds: { p: "A", q: "Q" }, activeView: "chat" }, save: async () => { saves += 1; }
  });
  const calls: string[] = [];
  const wait = async (name: typeof stage) => { if (stage === name) { entered.resolve(); await gate.promise; } };
  const admit = async () => { calls.push("admitted"); await wait("admission"); if (outcome === "reject") throw new Error("inert rejection"); };
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" } }),
    startInterruptedTurnForSession: async () => { await admit(); return outcome === "noop" ? undefined : { runId: "run", messageId: "message", completion: "completion" }; },
    submitRunForSession: async () => { await admit(); return outcome === "denied" ? { accepted: false } : { accepted: true, result: { runId: "run", messageId: "message" } }; },
    cancelRunRequest: async () => { calls.push("cancel"); }, waitForIdle: async () => undefined
  };
  const subject = Object.assign(runInNewContext(managerCode, {
    splitAttachmentReferences: (input: string) => ({ text: input, attachments: [] }),
    loadAgentAttachments: async () => [], errorFromHostOperation: () => new Error("inert admission failure")
  }, options) as Subject, {
    state, runtimeErrors: new Map(),
    resolveSessionRuntime: async () => { await wait("first"); return { runtime }; },
    runIdempotently: async (_p: string, _kind: string, _key: string, run: () => Promise<unknown>) => await run(),
    projects: { requireProject: () => ({ id: "p", path: "/inert" }), sessionUserMessageIdAtIndex: async () => "target",
      duplicateSession: async () => { await wait("first"); await admit(); return "T"; } },
    workspaceSnapshot: async () => { calls.push("snapshot"); return { selectedSessionId: state.selectedSessionId("p"), created: "T" }; },
    observeRunCompletion: (_p: string, completion: unknown) => { assert.equal(completion, "completion"); calls.push("observed"); }
  });
  const result = action === "retryPrompt" ? subject.retryPrompt("p", "A", "target", "prompt", [], "key")
    : action === "editPromptOnce" ? subject.editPromptOnce("p", "A", 0, "prompt", []) : subject[action]("p", "A");
  void result.catch(() => undefined);
  return { state, calls, saves: () => saves, entered: entered.promise, finish: () => { gate.resolve(); return result; } };
}
for (const action of actions) {
  for (const stage of ["first", "admission"] as const) {
    for (const navigation of ["unchanged", "different", "draft", "other-project", "same-target-aba"] as const) {
      test(`${action}: ${stage} / ${navigation}`, async () => {
        const f = fixture(action, stage); await f.entered;
        if (navigation === "different") await f.state.commitSelection("p", "B", "chat");
        if (navigation === "draft") await f.state.commitSelection("p", undefined, "chat");
        if (navigation === "other-project") await f.state.commitSelection("q", "R", "chat");
        if (navigation === "same-target-aba") { await f.state.commitSelection("p", "B", "chat"); await f.state.commitSelection("p", "A", "chat"); }
        const savesBefore = f.saves();
        const result = await f.finish();
        // Returning to A is a selection-value negative control for actions whose
        // target remains A: the parent may perform an idempotent save. Duplicate
        // creates T, so returning to A genuinely supersedes its selection write.
        if (navigation !== "same-target-aba" || action === "duplicateSession") {
          assert.equal(f.saves() - savesBefore, navigation === "unchanged" || navigation === "other-project" ? 1 : 0);
        }
        const expected = navigation === "different" ? "B" : navigation === "draft" ? undefined
          : navigation === "same-target-aba" ? "A" : action === "duplicateSession" ? "T" : "A";
        assert.equal(f.state.selectedSessionId("p"), expected);
        assert.equal(f.calls.filter(call => call === "admitted").length, 1);
        if (action === "duplicateSession") assert.equal((result as { created: string }).created, "T");
        else assert.equal(JSON.stringify(result), JSON.stringify({ sessionId: "A", runId: "run", messageId: "message" }));
        if (action === "resumeInterruptedTurn") assert.ok(f.calls.includes("observed"));
      });
    }
  }
  test(`${action}: rejected operation preserves navigation and rejection`, async () => {
    const f = fixture(action, "admission", "reject"); await f.entered; await f.state.commitSelection("p", "B", "chat");
    await assert.rejects(f.finish(), /inert rejection/u); assert.equal(f.state.selectedSessionId("p"), "B");
    assert.equal(f.calls.includes("observed"), false);
  });
}
test("resume: no submitted turn is still undefined", async () => {
  const f = fixture("resumeInterruptedTurn", "admission", "noop"); await f.entered; await f.state.commitSelection("p", "B", "chat");
  assert.equal(await f.finish(), undefined); assert.equal(f.state.selectedSessionId("p"), "B"); assert.equal(f.calls.includes("observed"), false);
});

for (const action of ["retryPrompt", "editPromptOnce"] as const) {
  test(`${action}: rejected admission result never selects or returns a receipt`, async () => {
    const f = fixture(action, "admission", "denied"); await f.entered;
    await assert.rejects(f.finish(), /inert admission failure/u);
    assert.equal(f.state.selectedSessionId("p"), "A"); assert.equal(f.saves(), 0);
  });
}
