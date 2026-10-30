import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Exercise the actual preload and registered IPC callback without importing
// Electron, credential stores or the Host. Validation uses real Zod; unrelated
// existing argument schemas and runtime resources are explicit inert boundaries.
const root = process.env.BINY_FAST_MODE_SOURCE_ROOT ?? process.cwd();
function parse(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(path.join(root, relative), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function collect<T extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node): void {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
function compile(code: string): string {
  const result = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}
  });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return result.outputText;
}
const preload = parse("src/desktop/electron/preload/index.ts");
const properties = collect(preload, ts.isPropertyAssignment).filter(node => node.name.getText(preload) === "sendPrompt");
assert.equal(properties.length, 1);
assert.ok(ts.isArrowFunction(properties[0]!.initializer));
const preloadCode = compile(`(${properties[0]!.initializer.getText(preload)});`);
const ipc = parse("src/desktop/electron/main/ipc.ts");
const registrations = collect(ipc, ts.isCallExpression).filter(node => node.expression.getText(ipc) === "handleRecoveryGated" && node.arguments[0]?.getText(ipc) === "desktopIpc.sendPrompt");
assert.equal(registrations.length, 1);
const registrationCode = compile(`${registrations[0]!.getText(ipc)};`);
type Send = (...args: unknown[]) => Promise<unknown>;
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const passthrough = z.unknown();
function fixture(managerSend?: Send): {send: Send; handler: Handler; calls: unknown[][]; invokes: unknown[][]} {
  const calls: unknown[][] = [];
  const invokes: unknown[][] = [];
  let handler: Handler | undefined;
  const context = {
    z, desktopIpc: {sendPrompt: "send-prompt"},
    idSchema: passthrough, promptSchema: passthrough, attachmentSchema: passthrough,
    chatPersonalizationSchema: passthrough, idempotencyKeySchema: passthrough,
    promptContextSchema: passthrough, agentCapabilitySelectionSchema: passthrough,
    context: {agents: {sendPrompt: async (...args: unknown[]): Promise<unknown> => {
      calls.push(args);
      return managerSend ? await managerSend(...args) : {sessionId: "s"};
    }}},
    handleRecoveryGated(channel: string, callback: Handler): void {
      assert.equal(channel, "send-prompt");
      assert.equal(handler, undefined);
      handler = callback;
    }
  };
  vm.runInNewContext(registrationCode, context, {timeout: 1000});
  const registered = handler as Handler | undefined;
  assert.ok(registered);
  const send = vm.runInNewContext(preloadCode, {
    desktopIpc: context.desktopIpc,
    ipcRenderer: {invoke: async (channel: unknown, ...args: unknown[]): Promise<unknown> => {
      assert.equal(channel, "send-prompt");
      invokes.push(args);
      return await registered({}, ...args);
    }}
  }, {timeout: 1000}) as Send;
  return {send, handler: registered, calls, invokes};
}
const args = ["p", undefined, "hello", [], undefined, undefined, "nonce", undefined, {tools: "auto", skills: "auto"}];
for (const mode of [true, false, undefined]) test(`desktop submission preserves fastMode=${String(mode)} across both IPC boundaries`, async () => {
  const f = fixture();
  await f.send(...args, mode);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Array.from(f.invokes[0]!), [...args, mode]);
  assert.deepEqual(Array.from(f.calls[0]!), [...args, mode]);
});
test("old callers may omit the optional fast-mode argument", async () => {
  const f = fixture();
  await f.send(...args);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![9], undefined);
});
for (const value of [null, "true", 1, {}]) test(`untrusted fastMode=${JSON.stringify(value)} is rejected before Manager admission`, async () => {
  const f = fixture();
  await assert.rejects(f.handler({}, ...args, value), z.ZodError);
  assert.equal(f.calls.length, 0);
});
test("admission failures remain rejections instead of successful receipts", async () => {
  const expected = new Error("admission refused");
  const f = fixture(async () => {throw expected;});
  await assert.rejects(f.send(...args, true), error => error === expected);
});

const managerSource = parse("src/desktop/electron/main/DesktopAgentManager.ts");
const managerDeclarations = collect(managerSource, ts.isClassDeclaration).filter(node => node.name?.text === "DesktopAgentManager");
assert.equal(managerDeclarations.length, 1);
const managerMethods = managerDeclarations[0]!.members.filter(ts.isMethodDeclaration).filter(node => ["sendPrompt", "sendPromptOnce"].includes(node.name.getText(managerSource)));
assert.equal(managerMethods.length, 2);
const managerCode = compile(`class Manager { ${managerMethods.map(node => node.getText(managerSource)).join("\n")} }; Manager;`);
interface TestManager {
  sendPrompt: Send;
  runIdempotently: (project: unknown, operation: unknown, key: unknown, action: () => Promise<unknown>) => Promise<unknown>;
  state: {selectedSessionId(): string; setSelectedSession(): Promise<void>};
  draftSessionIds: Map<string, string>;
  projects: {requireProject(): {path: string}};
  runtimeForPrompt(): Promise<unknown>;
}
for (const mode of [true, false, undefined]) test(`Manager forwards fastMode=${String(mode)} to the Host submit argument, not modelRoute`, async () => {
  const submitted: unknown[][] = [];
  const Constructor = vm.runInNewContext(managerCode, {
    perfNow: () => 0, recordPerfPhase: () => undefined, runtimeIsBusy: () => false,
    loadAgentAttachments: async (_path: unknown, attachments: unknown) => attachments,
    isSessionWriterConflictError: () => false,
    errorFromHostOperation: () => new Error("Host admission rejected")
  }, {timeout: 1000}) as new () => TestManager;
  const manager = new Constructor();
  manager.runIdempotently = async (_project, _operation, _key, action) => await action();
  manager.state = {selectedSessionId: () => "s", setSelectedSession: async () => undefined};
  manager.draftSessionIds = new Map();
  manager.projects = {requireProject: () => ({path: "/inert/project"})};
  manager.runtimeForPrompt = async () => ({snapshot: {info: {sessionId: "s"}}, managed: {runtime: {
    submitRunForSession: async (...values: unknown[]) => {
      submitted.push(values);
      return {accepted: true, result: {runId: "r", messageId: "m"}};
    }
  }}});
  const f = fixture(async (...values) => await manager.sendPrompt(...values));
  await f.send(...args, mode);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]![0], "s");
  assert.equal(submitted[0]![6], mode);
  assert.equal(submitted[0]!.length, 7);
});
