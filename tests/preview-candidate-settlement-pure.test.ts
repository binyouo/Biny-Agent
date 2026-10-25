/** Actual preview settlement and log candidate branch; all I/O boundaries are inert. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const filename = "src/desktop/electron/main/DesktopTerminalManager.ts";
const source = ts.createSourceFile(filename, readFileSync(path.join(process.cwd(), filename), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopTerminalManager");
assert.ok(declaration);
function method(name: string): ts.MethodDeclaration {
  const result = declaration!.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.ok(result); return result;
}
const probe = method("probePreview"), status = method("previewStatus");
const onData: ts.CallExpression[] = [];
function findOnData(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "pty.onData") onData.push(node);
  ts.forEachChild(node, findOnData);
}
findOnData(method("spawnSession"));
assert.equal(onData.length, 1);
const callback = onData[0]!.arguments[0];
assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
const branches = callback.body.statements.filter((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(source) === 'slotId === "preview"');
assert.equal(branches.length, 1);
const branch = branches[0]!;
const allowedCalls = new Set([
  "this.previews.get", "Date.now", "this.dispose", "this.previewFailures.set", "fetch", "AbortSignal.timeout",
  "this.schedulePreviewProbe", "this.previewFailures.get", "session.replay.slice", "session.replay.slice(-8_000).replace",
  "clean.matchAll", "[...matches].at"
]);
function audit(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "URL");
  ts.forEachChild(node, audit);
}
for (const node of [probe, status, branch]) audit(node);
const extracted = `class ExtractedManager {
${probe.getText(source)}
${status.getText(source)}
updateCandidate(projectId: string, slotId: string, session: { id: string; replay: string }): void { ${branch.getText(source)} }
}
globalThis.ExtractedManager = ExtractedManager;`;
assert.equal(/spawnSession|node-pty|onData|this\.emit|constructor|setTimeout|clearTimeout|process|require|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);

interface Launch { terminalId: string; status: "starting" | "running"; url?: string; candidate?: string; deadline: number }
type Status = { kind: "starting" | "running" | "failed" | "stopped"; terminalId?: string; url?: string; error?: string };
interface Manager {
  previews: Map<string, Launch>;
  previewFailures: Map<string, string>;
  probePreview(projectId: string, launch: Launch): Promise<void>;
  previewStatus(projectId: string): Status;
  updateCandidate(projectId: string, slotId: string, session: { id: string; replay: string }): void;
  schedulePreviewProbe(projectId: string, launch: Launch): void;
  dispose(terminalId: string): void;
}
interface Request { url: string; options: { redirect: string; signal: object }; resolve(): void; reject(error: Error): void }
const A = "http://localhost:3000/", B = "http://127.0.0.1:4000/";
function fixture(candidate: string | undefined = A) {
  let now = 0;
  const requests: Request[] = [], scheduled: Array<{ projectId: string; launch: Launch }> = [], disposed: string[] = [];
  const marker = Object.freeze({ inert: true });
  const context = createContext({
    URL, Date: { now: () => now },
    AbortSignal: { timeout: (ms: number): object => { assert.equal(ms, 1000); return marker; } },
    fetch: (url: string, options: Request["options"]): Promise<void> => new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject }); })
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  const Constructor = context.ExtractedManager as new() => Manager;
  const manager = new Constructor();
  const launch: Launch = { terminalId: "terminal", status: "starting", deadline: 60000, candidate };
  manager.previews = new Map([["project", launch]]); manager.previewFailures = new Map();
  manager.schedulePreviewProbe = (projectId, target) => { scheduled.push({ projectId, launch: target }); };
  // Deliberately fake disposal: no product dispose method, PTY, timer, or session effects.
  manager.dispose = (terminalId) => { disposed.push(terminalId); manager.previews.delete("project"); };
  const log = (url: string, id = "terminal", slotId = "preview") => manager.updateCandidate("project", slotId, { id, replay: `ready ${url}\n` });
  const run = () => manager.probePreview("project", launch);
  const retry = () => { const next = scheduled.shift(); assert.ok(next); assert.equal(next.projectId, "project"); assert.equal(next.launch, launch); return manager.probePreview(next.projectId, next.launch); };
  const state = () => manager.previewStatus("project");
  return { manager, launch, requests, scheduled, disposed, marker, log, run, retry, state, setNow: (value: number) => { now = value; } };
}

test("A to B must probe B before publishing a running URL", async () => {
  const f = fixture(), first = f.run();
  assert.equal(f.requests[0]!.url, A); f.log(B); f.requests[0]!.resolve(); await first;
  assert.equal(f.state().kind, "starting"); assert.equal(f.launch.url, undefined); assert.equal(f.scheduled.length, 1);
  const second = f.retry(); assert.equal(f.requests[1]!.url, B); assert.equal(f.state().kind, "starting");
  f.requests[1]!.resolve(); await second;
  assert.equal(f.state().kind, "running"); assert.equal(f.state().url, B); assert.equal(f.scheduled.length, 0);
});
test("unchanged A publishes A with the existing fetch options", async () => {
  const f = fixture(), pending = f.run();
  assert.equal(f.requests[0]!.options.redirect, "manual"); assert.equal(f.requests[0]!.options.signal, f.marker);
  f.requests[0]!.resolve(); await pending;
  assert.equal(f.state().url, A); assert.equal(f.state().kind, "running"); assert.equal(f.scheduled.length, 0);
});
test("A to B to A accepts the successfully probed URL identity", async () => {
  const f = fixture(), pending = f.run(); f.log(B); f.log(A); f.requests[0]!.resolve(); await pending;
  assert.equal(f.state().url, A); assert.equal(f.state().kind, "running"); assert.equal(f.requests.length, 1); assert.equal(f.scheduled.length, 0);
});
test("rejected old fetch retries the latest candidate", async () => {
  const f = fixture(), pending = f.run(); f.log(B); f.requests[0]!.reject(new Error("inert refusal")); await pending;
  assert.equal(f.state().kind, "starting"); assert.equal(f.scheduled.length, 1);
  const next = f.retry(); assert.equal(f.requests[1]!.url, B); f.requests[1]!.resolve(); await next; assert.equal(f.state().url, B);
});
for (const transition of ["replacement", "removal"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`${transition} during ${outcome} cannot publish or reschedule the old launch`, async () => {
      const f = fixture(), pending = f.run();
      const replacement: Launch = { terminalId: "new", status: "starting", candidate: B, deadline: 60000 };
      if (transition === "replacement") f.manager.previews.set("project", replacement); else f.manager.previews.delete("project");
      if (outcome === "resolve") f.requests[0]!.resolve(); else f.requests[0]!.reject(new Error("inert refusal"));
      await pending;
      assert.equal(f.launch.status, "starting"); assert.equal(f.launch.url, undefined); assert.equal(replacement.url, undefined);
      assert.equal(f.state().kind, transition === "replacement" ? "starting" : "stopped"); assert.equal(f.scheduled.length, 0); assert.equal(f.disposed.length, 0);
    });
  }
}
test("deadline preserves bounded failure and calls only fake disposal", async () => {
  const f = fixture(); f.setNow(60000); await f.run();
  assert.deepEqual(f.disposed, ["terminal"]); assert.equal(f.state().kind, "failed");
  assert.equal(f.state().error, "开发服务器在 60 秒内未提供可访问的本地地址，请检查终端输出。");
  assert.equal(f.requests.length, 0); assert.equal(f.scheduled.length, 0);
});
test("missing candidate stays starting and schedules without fetching", async () => {
  const f = fixture(); delete f.launch.candidate; await f.run();
  assert.equal(f.state().kind, "starting"); assert.equal(f.requests.length, 0); assert.equal(f.scheduled.length, 1);
});
test("candidate cleared during response cannot publish an undefined running URL", async () => {
  const f = fixture(), pending = f.run(); delete f.launch.candidate; f.requests[0]!.resolve(); await pending;
  assert.equal(f.launch.status, "starting"); assert.equal(f.launch.url, undefined); assert.equal(f.scheduled.length, 1);
});
test("already running retains current URL and ignores further candidate logs", async () => {
  const f = fixture(); f.launch.status = "running"; f.launch.url = A; f.log(B); await f.run();
  assert.equal(f.launch.candidate, A); assert.equal(f.state().url, A); assert.equal(f.requests.length, 0); assert.equal(f.scheduled.length, 0);
});
test("stale launch at entry cannot fetch or schedule", async () => {
  const f = fixture(); f.manager.previews.delete("project"); await f.run();
  assert.equal(f.requests.length, 0); assert.equal(f.scheduled.length, 0); assert.equal(f.state().kind, "stopped");
});
test("actual log branch retains slot and terminal ownership plus loopback normalization", () => {
  const f = fixture(); f.log(B, "other"); assert.equal(f.launch.candidate, A);
  f.log(B, "terminal", "default"); assert.equal(f.launch.candidate, A);
  f.log("http://0.0.0.0:5173/"); assert.equal(f.launch.candidate, "http://127.0.0.1:5173/");
  f.log("\u001b[32mhttp://localhost:3000/\u001b[0m\nready http://127.0.0.1:4000/"); assert.equal(f.launch.candidate, B);
});
