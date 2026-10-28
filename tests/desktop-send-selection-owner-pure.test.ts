import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source-inert schedule proof, not a transport/Host integration test. Never import
// Manager, StateStore, attachments or product runtime. Async work needs an external watchdog.
const root = path.resolve(process.env.BINY_SEND_SELECTION_SOURCE_ROOT ?? process.cwd());
const parse = (name: string) => ts.createSourceFile(name, readFileSync(path.join(root, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const manager = parse("src/desktop/electron/main/DesktopAgentManager.ts");
const store = parse("src/desktop/electron/main/DesktopStateStore.ts");
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
function owner(source: ts.SourceFile, name: string) {
  return one(source.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name), name);
}
function method(source: ts.SourceFile, declaration: ts.ClassDeclaration, name: string) {
  return one(declaration.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === name), name);
}
const send = method(manager, owner(manager, "DesktopAgentManager"), "sendPromptOnce");
const stateOwner = owner(store, "DesktopStateStore");
const usesOwner = send.getText(manager).includes("this.state.captureSelectedSessionLifetime(");
const names = ["selectedSessionId", "setSelectedSession", "commitSelection", "upsertProject"];
// Parent negative control runs its actual string comparison, not a substitute algorithm.
if (usesOwner) names.push("captureSelectedSessionLifetime");
const methods = names.map(name => method(store, stateOwner, name));
// Parent PR506 has token writes even when its Manager still uses the old comparison.
const fields = [one(stateOwner.members.filter((node): node is ts.PropertyDeclaration => ts.isPropertyDeclaration(node) && node.name.getText(store) === "selectedSessionTokens"), "selection token storage")];
const allowedCalls = new Set([
  "perfNow", "this.state.captureSelectedSessionLifetime", "this.state.selectedSessionId", "this.draftSessionIds.get", "this.runtimeForPrompt",
  "this.projects.requireProject", "recordPerfPhase", "loadAgentAttachments", "runtimeIsBusy", "runtime.queueRunMessageForSession",
  "errorFromHostOperation", "this.draftSessionIds.delete", "ownsSelection", "this.state.setSelectedSession", "runtime.submitRunForSession",
  "this.state.projects.find", "this.state.projects.findIndex", "this.state.projects.push", "this.selectedSessionTokens.get", "this.selectedSessionTokens.set", "this.save"
]);
function audit(node: ts.Node, source: ts.SourceFile): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.ok(["Error", "WeakMap"].includes(node.expression.getText(source)));
  ts.forEachChild(node, child => audit(child, source));
}
audit(send, manager);
for (const node of [...methods, ...fields]) audit(node, store);
function compile(code: string): string {
  assert.equal(/\b(?:require|fetch|eval)\b|import\s*\(/u.test(code), false);
  const result = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
// Remove the TypeScript-only import type, never execute or resolve it.
const sendCode = compile(`({${send.getText(manager).replace(/^private\s+/u, "").replace(/HostOperationResult<import\("[^"]+"\)\.QueuedAgentMessage>/u, "unknown")}})`);
const stateCode = compile("({" + [...methods.map(node => node.getText(store)), ...fields.map(node => `${node.name.getText(store)}: ${node.initializer!.getText(store)}`)].join(",\n") + "})");
const vmOptions = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };
interface Project { id: string; name: string; path: string; pinned: boolean; addedAt: string }
interface State {
  state: { projects: Project[]; selectedSessionIds: Record<string, string>; activeProjectId?: string; activeView: string };
  save(): Promise<void>;
  selectedSessionId(id: string): string | undefined;
  setSelectedSession(id: string, sessionId: string | undefined): Promise<void>;
  commitSelection(id: string, sessionId: string | undefined, view: string): Promise<void>;
  upsertProject(project: Project): Promise<void>;
}
interface Receipt { sessionId: string; runId: string; messageId: string }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(busy: boolean, selected?: string, target = "T", stage: "runtime" | "attachments" | "admission" = "admission", accepted = true) {
  const project: Project = { id: "p", name: "Project", path: "/inert/p", pinned: false, addedAt: "fixed" };
  let saves = 0;
  const state = Object.assign(runInNewContext(stateCode, {}, vmOptions) as State, {
    state: { projects: [project, { ...project, id: "q" }], selectedSessionIds: selected === undefined ? {} : { p: selected }, activeProjectId: "p", activeView: "chat" },
    save: async () => { saves += 1; }
  });
  const entered = deferred<void>(), gate = deferred<void>();
  const boundary = async (name: typeof stage) => { if (stage === name) { entered.resolve(); await gate.promise; } };
  const calls: { kind: string; args: unknown[] }[] = [];
  const admission = async (kind: string, args: unknown[]) => {
    calls.push({ kind, args }); await boundary("admission");
    return accepted ? { accepted: true, result: { runId: "run", messageId: "message" } } : { accepted: false };
  };
  const attachments = [{ name: "inert attachment" }];
  const loaded = [{ kind: "inert loaded attachment" }];
  const runtime = {
    queueRunMessageForSession: (...args: unknown[]) => admission("queue", args),
    submitRunForSession: (...args: unknown[]) => admission("submit", args)
  };
  const subject = Object.assign(runInNewContext(sendCode, {
    perfNow: () => 0, recordPerfPhase: () => undefined,
    loadAgentAttachments: async (_path: string, value: unknown) => { assert.equal(value, attachments); await boundary("attachments"); return loaded; },
    runtimeIsBusy: () => busy, errorFromHostOperation: () => new Error("inert rejection")
  }, vmOptions) as { sendPromptOnce(...args: unknown[]): Promise<Receipt> }, {
    state, draftSessionIds: new Map([["p", target]]), projects: { requireProject: () => project },
    runtimeForPrompt: async (_id: string, requested: string) => {
      assert.equal(requested, target); await boundary("runtime");
      return { managed: { runtime }, snapshot: { info: { sessionId: target } } };
    }
  });
  const result = subject.sendPromptOnce("p", undefined, "prompt", attachments, "steer", undefined, "context", undefined, "message", true);
  // Observe rejection immediately without changing the result asserted by the test.
  void result.catch(() => undefined);
  return { state, project: { ...project }, calls, loaded, subject, saves: () => saves, entered: entered.promise,
    finish: () => { gate.resolve(); return result; } };
}
async function checkReceipt(f: ReturnType<typeof fixture>, busy: boolean, target = "T") {
  const receipt = await f.finish();
  assert.equal(JSON.stringify(receipt), JSON.stringify({ sessionId: target, runId: "run", messageId: "message" }));
  assert.equal(f.subject.draftSessionIds.has("p"), false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.kind, busy ? "queue" : "submit");
  const args = f.calls[0]!.args;
  assert.equal(args[0], target); assert.equal(args[1], "prompt");
  assert.equal(args[busy ? 3 : 2], f.loaded);
  if (busy) assert.equal(args[2], "steer");
  else { assert.equal(args[4], "context"); assert.equal(args[6], true); }
}
for (const busy of [false, true]) {
  const label = busy ? "queue" : "submit";
  test(`${label}: unchanged draft intentionally selects accepted session`, async () => {
    const f = fixture(busy); await f.entered; await checkReceipt(f, busy);
    assert.equal(f.state.selectedSessionId("p"), "T"); assert.equal(f.saves(), 1);
  });
  for (const stage of ["runtime", "attachments", "admission"] as const) {
    test(`${label}: newer same undefined at ${stage} survives old receipt`, async () => {
      const f = fixture(busy, undefined, "T", stage); await f.entered;
      await f.state.commitSelection("p", undefined, "chat"); await checkReceipt(f, busy);
      assert.equal(f.state.selectedSessionId("p") === undefined, true); assert.equal(f.saves(), 1);
    });
  }
  test(`${label}: undefined to B to undefined ABA survives`, async () => {
    const f = fixture(busy); await f.entered;
    await f.state.setSelectedSession("p", "B"); await f.state.setSelectedSession("p", undefined);
    await checkReceipt(f, busy); assert.equal(f.state.selectedSessionId("p") === undefined, true); assert.equal(f.saves(), 2);
  });
  test(`${label}: changed string B was already protected`, async () => {
    const f = fixture(busy); await f.entered; await f.state.commitSelection("p", "B", "chat");
    await checkReceipt(f, busy); assert.equal(f.state.selectedSessionId("p"), "B");
  });
  test(`${label}: ordinary target A ABA has no observable selection-value difference`, async () => {
    const f = fixture(busy, "A", "A"); await f.entered;
    await f.state.commitSelection("p", "B", "chat"); await f.state.commitSelection("p", "A", "chat");
    await checkReceipt(f, busy, "A"); assert.equal(f.state.selectedSessionId("p"), "A");
  });
  test(`${label}: another project's selection does not retire this send`, async () => {
    const f = fixture(busy); await f.entered; await f.state.commitSelection("q", "Q", "chat");
    await checkReceipt(f, busy); assert.equal(f.state.selectedSessionId("p"), "T"); assert.equal(f.state.selectedSessionId("q"), "Q");
  });
  test(`${label}: identical-field project replacement retires old write`, async () => {
    const f = fixture(busy); await f.entered; await f.state.upsertProject({ ...f.project });
    await checkReceipt(f, busy); assert.equal(f.state.selectedSessionId("p") === undefined, true); assert.equal(f.saves(), 1);
  });
  test(`${label}: rejected admission neither selects nor consumes draft`, async () => {
    const f = fixture(busy, undefined, "T", "admission", false); await f.entered;
    await assert.rejects(f.finish(), /inert rejection/u);
    assert.equal(f.state.selectedSessionId("p"), undefined); assert.equal(f.saves(), 0);
    assert.equal(f.subject.draftSessionIds.get("p"), "T"); assert.equal(f.calls.length, 1);
  });
}
