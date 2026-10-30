import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { agentCapabilitySelectionSchema } from "../src/agent/capabilitySelection.js";

// Actual selected Composer/App callbacks, preload, IPC and Manager methods run
// together. Electron, storage, Host and rendering are inert boundaries: this is
// a submission-contract regression, not native UI or live-provider acceptance.
const root = process.env.BINY_FAST_MODE_SOURCE_ROOT ?? process.cwd();
function parse(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(path.join(root, relative), "utf8"), ts.ScriptTarget.Latest, true,
    relative.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function collect<T extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node): void {if (predicate(node)) result.push(node); ts.forEachChild(node, visit);}
  visit(source); return result;
}
function compile(code: string): string {
  const result = ts.transpileModule(code, {reportDiagnostics: true, compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}});
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return result.outputText;
}
function callback(source: ts.SourceFile, name: string): string {
  const declarations = collect(source, ts.isVariableDeclaration).filter(node => node.name.getText(source) === name);
  assert.equal(declarations.length, 1);
  const initializer = declarations[0]!.initializer;
  assert.ok(initializer);
  const expression = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
  assert.ok(expression && ts.isArrowFunction(expression));
  return compile(`(${expression.getText(source)});`);
}
const composer = parse("src/desktop/renderer/src/components/Composer.tsx");
const app = parse("src/desktop/renderer/src/App.tsx");
const preload = parse("src/desktop/electron/preload/index.ts");
const ipc = parse("src/desktop/electron/main/ipc.ts");
const managerSource = parse("src/desktop/electron/main/DesktopAgentManager.ts");
const properties = collect(preload, ts.isPropertyAssignment).filter(node => node.name.getText(preload) === "editPrompt");
assert.equal(properties.length, 1);
const preloadCode = compile(`(${properties[0]!.initializer.getText(preload)});`);
const registrations = collect(ipc, ts.isCallExpression).filter(node => node.expression.getText(ipc) === "handleRecoveryGated" && node.arguments[0]?.getText(ipc) === "desktopIpc.editPrompt");
assert.equal(registrations.length, 1);
const registrationCode = compile(`${registrations[0]!.getText(ipc)};`);
const classes = collect(managerSource, ts.isClassDeclaration).filter(node => node.name?.text === "DesktopAgentManager");
assert.equal(classes.length, 1);
const methods = classes[0]!.members.filter(ts.isMethodDeclaration).filter(node => ["editPrompt", "editPromptOnce"].includes(node.name.getText(managerSource)));
assert.equal(methods.length, 2);
const managerCode = compile(`class Manager {${methods.map(node => node.getText(managerSource)).join("\n")}}; Manager;`);
function plain(value: unknown): unknown { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown; }
type AsyncCall = (...args: unknown[]) => Promise<unknown>;
interface Manager {
  editPrompt: AsyncCall;
  runIdempotently(project: unknown, operation: unknown, key: unknown, action: () => Promise<unknown>): Promise<unknown>;
  resolveSessionRuntime(): Promise<unknown>;
  projects: {requireProject(): {path: string}; sessionUserMessageIdAtIndex(project: unknown, session: unknown, index: unknown): Promise<string>};
  runtimeErrors: Map<string, unknown>;
  state: {setSelectedSession(): Promise<void>};
}
function fixture(options: {selection?: unknown; fastMode?: unknown; running?: boolean; reject?: boolean; prepare?: () => Promise<void>} = {}) {
  const submitted: unknown[][] = [];
  const events: string[] = [];
  const errors: string[] = [];
  const drafts: unknown[] = [];
  let ipcHandler: AsyncCall | undefined;
  const Constructor = vm.runInNewContext(managerCode, {
    loadAgentAttachments: async (_path: unknown, attachments: unknown) => attachments,
    errorFromHostOperation: () => new Error("Host refused edit")
  }, {timeout: 1000}) as new () => Manager;
  const manager = new Constructor();
  manager.runIdempotently = async (_project, operation, key, action) => {
    assert.equal(operation, "edit"); assert.equal(key, "edit-nonce"); return await action();
  };
  manager.resolveSessionRuntime = async () => ({runtime: {
    getSnapshot: () => ({state: options.running ? {kind: "runs", activeRun: {runId: "old-run"}} : {kind: "idle"}}),
    cancelRunRequest: async (run: unknown, reason: unknown, session: unknown) => {
      assert.deepEqual([run, reason, session], ["old-run", "replaced", "s"]); events.push("cancel");
    },
    waitForIdle: async (session: unknown) => {assert.equal(session, "s"); events.push("idle");},
    submitRunForSession: async (...args: unknown[]) => {
      submitted.push(args); events.push("submit");
      return options.reject ? {accepted: false} : {accepted: true, result: {runId: "r", messageId: "replacement"}};
    }
  }});
  manager.projects = {
    requireProject: () => ({path: "/inert/project"}),
    sessionUserMessageIdAtIndex: async (_project, session, index) => {assert.equal(session, "s"); assert.equal(index, 1); return "target-user";}
  };
  manager.runtimeErrors = new Map();
  manager.state = {setSelectedSession: async () => {events.push("selection");}};
  const context: Record<string, unknown> = {
    z, desktopIpc: {editPrompt: "edit"}, idSchema: z.string(), userMessageIndexSchema: z.number(),
    promptSchema: z.string(), attachmentSchema: z.unknown(), idempotencyKeySchema: z.string().optional(),
    agentCapabilitySelectionSchema, context: {agents: manager},
    handleRecoveryGated: (_channel: string, handler: AsyncCall) => {ipcHandler = handler;}
  };
  vm.runInNewContext(registrationCode, context, {timeout: 1000});
  const handler = ipcHandler as AsyncCall | undefined;
  assert.ok(handler);
  const edit = vm.runInNewContext(preloadCode, {
    desktopIpc: context.desktopIpc,
    ipcRenderer: {invoke: async (channel: unknown, ...args: unknown[]) => {assert.equal(channel, "edit"); return await handler({}, ...args);}}
  }, {timeout: 1000}) as AsyncCall;
  const editingMessage = {turnId: "turn", userMessageIndex: 1, value: "old", nonce: 1,
    attachments: [{name: "image", path: "attachments/image.png", mimeType: "image/png"}]};
  const selectedRef = {current: "s"};
  const loadRequestRef = {current: 1};
  Object.assign(context, {
    window: {biny: {editPrompt: edit}, requestAnimationFrame: () => 0},
    projectRef: {current: "p"}, selectedRef, loadRequestRef,
    navigationRef: {current: {entries: [], index: 0}}, documentRef: {current: undefined},
    workspace: undefined, syntheticSession: () => ({id: "s"}),
    setSelectedSessionId: () => undefined, setDocument: () => undefined,
    refreshRuntimeFailure: async () => undefined, editingMessage,
    globalThis: {crypto: {randomUUID: () => "edit-nonce"}},
    setGenerationError: () => undefined, setEditInFlight: () => undefined, setEditingMessage: () => undefined,
    externalAgent: false, running: false, editing: true, attachments: [], pendingAttachments: [], recovery: undefined,
    currentDraft: () => ({value: "edited input", tokens: []}), materializeDraftReferences: (value: string) => value,
    project: {id: "p"}, busy: false, submitFlightRef: {current: false}, sessionWriterConflict: false,
    modelSetupRequired: false, memoryToggleBusy: false, setBusy: () => undefined, setPreparing: () => undefined,
    onPrepare: options.prepare ?? (async () => undefined), mounted: {current: true},
    isSubmissionCurrent: () => selectedRef.current === "s", editingMessageRef: {current: editingMessage},
    clearHistory: () => undefined, setDraft: (draft: unknown) => {drafts.push(draft);},
    onSubmitError: (message: string) => {errors.push(message);}, errorMessage: (error: Error) => error.message,
    inputRef: {current: undefined}, capabilitySelection: options.selection, fastMode: options.fastMode,
    onWarning: (message: string) => {errors.push(message);}
  });
  for (const name of ["editPrompt", "editUserMessage", "submitEditedMessage"]) context[name] = vm.runInNewContext(callback(app, name), context, {timeout: 1000});
  context.onSubmitEdit = context.submitEditedMessage;
  const submit = vm.runInNewContext(callback(composer, "submit"), context, {timeout: 1000}) as AsyncCall;
  return {submit, edit, handler, submitted, events, errors, drafts, selectedRef, loadRequestRef};
}
for (const selection of [{tools: "none", skills: "none"}, {tools: ["Read"], skills: ["review"]}, {tools: "auto", skills: "all"}]) {
  for (const fastMode of [true, false]) test(`edited input keeps ${JSON.stringify(selection)} and fastMode=${fastMode}`, async () => {
    const f = fixture({selection, fastMode}); await f.submit();
    assert.deepEqual(f.errors, []);
    assert.equal(f.submitted.length, 1);
    const args = f.submitted[0]!;
    assert.equal(args[0], "s"); assert.equal(args[1], "edited input");
    assert.deepEqual(plain(args[2]), [{name: "image", path: "attachments/image.png", mimeType: "image/png", size: 0}]);
    assert.deepEqual(plain(args[3]), {retryOfMessageId: "target-user", replaceUserMessageId: "target-user"});
    assert.equal(args[4], undefined); assert.deepEqual(plain(args[5]), selection);
    assert.equal(args[6], fastMode); assert.equal(args.length, 7);
  });
}
test("older edit callers can omit both new optional fields", async () => {
  const f = fixture(); await f.edit("p", "s", 1, "legacy", [], "edit-nonce");
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0]![5], undefined); assert.equal(f.submitted[0]![6], undefined);
});
for (const selection of [null, {tools: "invalid", skills: "auto"}, {tools: "none"}, {tools: "none", skills: "none", extra: true}]) test(`IPC rejects malformed edit selection ${JSON.stringify(selection)} before cancellation or submission`, async () => {
  const f = fixture({running: true});
  await assert.rejects(f.handler({}, "p", "s", 1, "edited", [], "edit-nonce", selection, true), z.ZodError);
  assert.deepEqual(f.events, []);
});
for (const mode of [null, "true", 1, {}]) test(`IPC rejects non-boolean edit fastMode ${JSON.stringify(mode)}`, async () => {
  const f = fixture();
  await assert.rejects(f.handler({}, "p", "s", 1, "edited", [], "edit-nonce", {tools: "none", skills: "none"}, mode), z.ZodError);
  assert.deepEqual(f.submitted, []);
});
test("editing a running turn preserves the existing cancel/wait/admit order", async () => {
  const selection = {tools: "none", skills: "none"};
  const f = fixture({selection, fastMode: true, running: true}); await f.submit();
  assert.deepEqual(f.events, ["cancel", "idle", "submit", "selection"]);
  assert.deepEqual(plain(f.submitted[0]![5]), selection);
});
test("failed admission restores edited text without claiming the edit succeeded", async () => {
  const f = fixture({selection: {tools: "none", skills: "none"}, fastMode: true, reject: true});
  await f.submit();
  assert.deepEqual(f.errors, ["Host refused edit"]);
  assert.deepEqual(plain(f.drafts.at(-1)), {value: "edited input", tokens: []});
  assert.ok(!f.events.includes("selection"));
});
test("navigation before prepare completes retires the edit without dispatch", async () => {
  let release: (() => void) | undefined;
  const prepare = new Promise<void>(resolve => {release = resolve;});
  const f = fixture({selection: {tools: "none", skills: "none"}, fastMode: true, prepare: () => prepare});
  const completion = f.submit(); f.selectedRef.current = "other"; release!(); await completion;
  assert.deepEqual(f.submitted, []); assert.deepEqual(f.drafts, []);
});
