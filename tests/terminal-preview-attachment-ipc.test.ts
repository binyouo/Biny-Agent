import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Actual IPC handler and complete terminal manager; PTY import/spawn and timers
// are inert. No Electron, process, shell command, HTTP or native module runs.
const read = (name: string) => readFileSync(new URL(`../src/desktop/electron/main/${name}.ts`, import.meta.url), "utf8");
const ipc = ts.createSourceFile("ipc.ts", read("ipc"), ts.ScriptTarget.Latest, true);
let handler: ts.ArrowFunction | undefined;
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ipc) === "handle" && node.arguments[0]?.getText(ipc) === "desktopIpc.createTerminal") {
    assert.ok(ts.isArrowFunction(node.arguments[1]!)); handler = node.arguments[1] as ts.ArrowFunction;
  }
  ts.forEachChild(node, visit);
}
visit(ipc); assert.ok(handler);
const source = ts.createSourceFile("manager.ts", read("DesktopTerminalManager"), ts.ScriptTarget.Latest, true);
const manager = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopTerminalManager");
const sanitize = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "sanitizeSize");
assert.ok(manager); assert.ok(sanitize);
const managerText = manager.getText(source); assert.equal(managerText.split('await import("node-pty")').length, 2);
function compile(value: string) { return ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function schema(sourceText: string, name: string) {
  const file = ts.createSourceFile("schemas.ts", sourceText, ts.ScriptTarget.Latest, true);
  const declarations = file.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
  const found = declarations.find(node => node.name.getText(file) === name); assert.ok(found?.initializer);
  return vm.runInNewContext(compile(`(${found.initializer.getText(file)})`), { z });
}
const idSchema = schema(read("settingsSaveInputSchema"), "idSchema");
const terminalSizeSchema = schema(read("ipc"), "terminalSizeSchema");
function fixture() {
  const output: Record<string, any> = {}, ptys: any[] = []; let next = 0, gate: Promise<void> | undefined;
  vm.runInNewContext(compile(managerText.replace('await import("node-pty")', 'await fakePtyModule()') + "\n" + sanitize!.getText(source)), {
    exports: output, maxReplayBytes: 262144, randomUUID: () => `terminal-${++next}`, process: { env: {} },
    defaultShell: () => ({ kind: "posix" }), interactiveShellInvocation: () => ({ executable: "inert", args: [] }),
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    async fakePtyModule() { if (gate) await gate; return { spawn() {
      const pty: any = { writes: [], sizes: [], resize(...size: number[]) { this.sizes.push(size); }, write(value: string) { this.writes.push(value); }, kills: 0, killError: undefined, syncExit: false, kill() { this.kills++; if (this.killError) throw this.killError; if (this.syncExit) this.exit({ exitCode: 0 }); },
        onData(callback: unknown) { this.data = callback; }, onExit(callback: unknown) { this.exit = callback; } };
      ptys.push(pty); return pty;
    } }; }
  });
  const terminals = new output.DesktopTerminalManager(() => {});
  const project = { id: "project", path: "/inert", missing: false };
  const environment = { context: { terminals, projects: { requireProject(id: string) { assert.equal(id, project.id); return project; } } }, z,
    idSchema, terminalSizeSchema };
  const attach = vm.runInNewContext(compile(`(${handler!.getText(ipc)})`), environment) as (...args: unknown[]) => Promise<any>;
  return { terminals, ptys, project, attach: (slot = "preview", cols = 80) => attach({}, "project", cols, 24, slot),
    hold() { const deferredGate = deferred(); gate = deferredGate.promise; return deferredGate; } };
}

test("missing preview attachment never creates a bare shell", async () => {
  const f = fixture(); await assert.rejects(f.attach(), /开发服务器已退出/); assert.equal(f.ptys.length, 0);
});
test("listed preview exiting before attachment reports an exited server, then dedicated restart creates once", async () => {
  const f = fixture(); await f.terminals.startPreview("project", "/inert", "npm run dev");
  assert.equal(f.terminals.list("project").length, 1); f.ptys[0].exit({ exitCode: 1 });
  await assert.rejects(f.attach(), /开发服务器已退出/); assert.equal(f.ptys.length, 1);
  const gate = f.hold(), a = f.terminals.startPreview("project", "/inert", "npm run dev"), b = f.terminals.startPreview("project", "/inert", "npm run dev");
  gate.resolve(); const [first, second] = await Promise.all([a, b]);
  assert.equal(first.terminalId, second.terminalId); assert.equal(f.ptys.length, 2);
  assert.deepEqual(f.ptys[1].writes, ["npm run dev; exit\r"]);
});
test("existing preview attaches without respawn, command replay or launch-state replacement", async () => {
  const f = fixture(), existing = await f.terminals.startPreview("project", "/inert", "npm run dev");
  f.ptys[0].data("output"); const result = await f.attach("preview", 99);
  assert.equal(result.terminalId, existing.terminalId); assert.equal(result.replay, "output"); assert.equal(result.sequence, 1);
  assert.equal(f.ptys.length, 1); assert.deepEqual(f.ptys[0].writes, ["npm run dev; exit\r"]);
  assert.deepEqual(f.ptys[0].sizes.at(-1), [99, 24]); assert.equal(f.terminals.previewStatus("project").kind, "starting");
});
test("ordinary slots still create and reuse their own terminal", async () => {
  const f = fixture(), first = await f.attach("ordinary"), second = await f.attach("ordinary");
  assert.equal(first.terminalId, second.terminalId); assert.equal(f.ptys.length, 1); assert.deepEqual(f.ptys[0].writes, []);
});
test("invalid dimensions and unavailable project still fail before native preparation", async () => {
  const f = fixture(); await assert.rejects(f.attach("preview", 1));
  f.project.missing = true; await assert.rejects(f.attach(), /目录不可用/); assert.equal(f.ptys.length, 0);
});

test("failed preview kill retains its concrete handle and state for an explicit retry", async () => {
  const f = fixture(), handle = await f.terminals.startPreview("project", "/inert", "npm run dev");
  const error = Error("kill failed"); f.ptys[0].killError = error;
  assert.throws(() => f.terminals.dispose(handle.terminalId), reason => reason === error);
  assert.equal(f.terminals.list("project")[0]?.terminalId, handle.terminalId);
  assert.equal(f.terminals.previewStatus("project").kind, "starting");
  f.ptys[0].killError = undefined; f.terminals.dispose(handle.terminalId);
  assert.equal(f.ptys[0].kills, 2); assert.equal(f.terminals.list("project").length, 0);
  assert.equal(f.terminals.previewStatus("project").kind, "stopped");
});
test("synchronous exit during kill and old late exit cannot remove a replacement", async () => {
  const f = fixture(), old = await f.attach("ordinary"); f.ptys[0].syncExit = true;
  f.terminals.dispose(old.terminalId); assert.equal(f.terminals.list("project").length, 0);
  const fresh = await f.attach("ordinary"); f.ptys[0].exit({ exitCode: 0 });
  assert.equal(f.terminals.list("project")[0]?.terminalId, fresh.terminalId);
});
test("failed kill restores non-stopping state so natural preview failure is still reported", async () => {
  const f = fixture(), handle = await f.terminals.startPreview("project", "/inert", "npm run dev");
  f.ptys[0].killError = Error("kill failed"); assert.throws(() => f.terminals.dispose(handle.terminalId));
  f.ptys[0].exit({ exitCode: 1 }); assert.equal(f.terminals.previewStatus("project").kind, "failed");
});
