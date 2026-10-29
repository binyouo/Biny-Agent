import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { Editor, type TUI } from "@earendil-works/pi-tui";
import { editorTheme } from "../src/tui/theme/index.js";
import type { AgentAttachment } from "../src/agent/AgentSession.js";

interface ProbeRuntime {
  getSnapshot(session?: string): { info: { sessionId: string; workspaceRoot: string }; state: { kind: string } };
  startDraft(): Promise<void>;
  ensureSession(): Promise<void>;
  close(): Promise<void>;
  submitRunForSession(session: string, text: string, attachments: AgentAttachment[]): Promise<{ accepted: boolean }>;
  queueRunMessageForSession(session: string, text: string, delivery: string, attachments: AgentAttachment[]): Promise<{ accepted: boolean }>;
}
interface ProbeTarget { runtime: ProbeRuntime; sessionId: string; workspaceRoot: string }
interface ProbeInput {
  id: number;
  text: string;
  attachments: AgentAttachment[];
  target: Promise<ProbeTarget | undefined>;
  origin?: ProbeTarget;
  phase: "queued" | "dispatched" | "accepted" | "failed";
  uncertain?: boolean;
}
interface ProbeDialog { title: string; onSelect(item: { value: string }): void }
interface ProbeApp {
  runtime?: ProbeRuntime;
  startRuntimePromise?: Promise<void>;
  startRuntime(): Promise<void>;
  editor: { addToHistory(value: string): void; getExpandedText(): string };
  pendingAttachments: AgentAttachment[];
  pendingSubmissions: Map<number, ProbeInput>;
  recoverableInputs: Map<number, ProbeInput>;
  sessionModelSwitches: WeakMap<ProbeRuntime, Map<string, Promise<void>>>;
  sessionWriterConflict?: { sessionId: string };
  exiting?: boolean;
  lastCtrlCAt: number;
  dialog: ProbeDialog;
  submit(text: string, attachments?: AgentAttachment[]): Promise<void>;
  steerCurrentInput(): Promise<void>;
  restoreRecoverableInput(input: ProbeInput, confirmed: boolean): void;
  showRecoverableInputs(): void;
  requestExit(): Promise<void>;
  showSessionWriterConflict(conflict: { sessionId: string }): Promise<void>;
  clearSessionWriterConflict(): void;
  applyModel(alias: string): void;
  setPendingAttachments(attachments: AgentAttachment[]): void;
  setEditorText(text: string): void;
  notify(message: string): void;
  dispatch(event: unknown): void;
  handleGlobalKey(key: string): { consume?: boolean } | undefined;
}
const attachment = (name: string): AgentAttachment => ({ name, mimeType: "image/png", data: "aW5lcnQ=" });
const onlyRecovery = (app: ProbeApp): ProbeInput => {
  assert.equal(app.recoverableInputs.size, 1);
  const input = [...app.recoverableInputs.values()][0];
  assert.ok(input); return input;
};

const file = readFileSync(new URL("../src/tui/app.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.ts", file, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "BinyTui");
assert.ok(declaration);
const names = ["notifySubmissionStatus", "captureSubmissionTarget", "takeSubmittedInput", "submit", "submitPrompt", "submissionIsCurrent", "retainSubmittedInput", "restoreRecoverableInput", "showRecoverableInputs", "requestExit", "steerCurrentInput", "ensureSessionWriteAccess", "handleSlashCommand", "restartRuntimeForNewChat", "startNewChat", "ensureRuntimeStarted", "restoreSubmittedInput", "applyModel", "showSessionWriterConflict", "hasSubmissionCapacity", "handleGlobalKey", "exit"];
const methods = names.map((name) => {
  const method = declaration.members.find((node) => node.name?.getText(ast) === name);
  if (!method) {
    assert.ok(!["submit", "submitPrompt", "handleSlashCommand", "startNewChat"].includes(name), `required method ${name}`);
    return "";
  }
  return method.getText(ast);
});
const ctrlCHelpers = ["isDoubleCtrlC", "ctrlCAction", "editorSubmissionUndo"].map((name) => {
  const fn = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn); return fn.getText(ast).replace(/^export /u, "");
}).join("\n");
const code = ts.transpileModule(`${ctrlCHelpers} class Subject { ${methods.join("\n")} }; globalThis.Subject = Subject;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
// Only application methods execute. Runtime, history, renderer, and editor are inert seams.
function fixture() {
  const sandbox = {
    ctrlCExitWindowMs: 500,
    drainRuntimeBeforeExit: async () => undefined,
    matchesKey: (data: string, key: string) => data === key,
    isSlashCommandSubmission: (text: string) => text.startsWith("/"), isSkillInvocationText: () => false,
    appendInputHistory: async () => undefined, describeError: String,
    runtimeIsBusy: (snapshot: { busy?: boolean }) => !!snapshot?.busy,
    errorFromHostOperation: () => new Error("explicit rejection"),
    isSessionWriterConflictError: (error: unknown) => error instanceof Error && error.message === "writer conflict",
    editorSubmissionUndo: () => ({ clear() {} }),
    modelPresentationFromChoice: () => ({}), modelPresentationFromInfo: (info: unknown) => info,
    readStoredSessionEvents: async (): Promise<{ events: unknown[] }> => ({ events: [] }), sessionEventsToTranscript: (events: unknown) => events,
    SessionWriterConflictComponent: class {}

  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  // The dynamically extracted class deliberately has no product constructor/imports.
  const app = vm.runInContext("new Subject()", context) as ProbeApp;
  let focus = "A", draft = "";
  const sends: Array<{ session: string; text: string; attachments: AgentAttachment[]; delivery: string }> = [];
  const notices: string[] = [];
  let reply = async () => ({ accepted: true });
  const runtime: ProbeRuntime = {
    getSnapshot: (session = focus) => ({ info: { sessionId: session, workspaceRoot: "/project" }, state: { kind: "idle" } }),
    startDraft: async () => { focus = "B"; },
    ensureSession: async () => undefined, close: async () => undefined,
    submitRunForSession: async (session: string, text: string, attachments: AgentAttachment[]) => {
      sends.push({ session, text, attachments, delivery: "run" }); return await reply();
    },
    queueRunMessageForSession: async (session: string, text: string, delivery: string, attachments: AgentAttachment[]) => {
      sends.push({ session, text, attachments, delivery }); return await reply();
    }
  };
  Object.assign(app, {
    runtime, submissionSequence: 0, promptSubmissionQueue: Promise.resolve(), pendingAttachments: [],
    pendingSubmissions: new Map(), recoverableInputs: new Map(), sessionModelSwitches: new WeakMap(), ownedSessionIds: new Set(),
    editor: { addToHistory() {}, getExpandedText: () => draft, undoStack: { clear() {} } }, chatContainer: { reset() {} },
    setEditorText: (text: string) => { draft = text; }, setPendingAttachments: (value: AgentAttachment[]) => { app.pendingAttachments = value; },
    notify: (text: string) => notices.push(text), dispatch() {}, clearSessionWriterConflict() { app.sessionWriterConflict = undefined; }, announceCurrentSession() {},
    editorContainer: { addChild() {}, removeChild() {} }, ui: { setFocus() {}, requestRender() {}, stop() {} }, status: { dispose() {}, showExitHint() {} },
    modelSwitchGeneration: 0, modelSwitchQueue: Promise.resolve(), state: { provider: "inert" }, applyModelPresentation() {},
    refreshContextUsage: async () => undefined, refreshUsage: async () => undefined, showCommandResult() {},
    showSelect: (options: ProbeDialog) => { app.dialog = options; }
  });
  return { app, runtime, sends, notices, sandbox, setFocus: (id: string) => { focus = id; }, setDraft: (text: string) => { draft = text; }, draft: () => draft, reply: (fn: typeof reply) => { reply = fn; } };
}

test("queued Enter keeps original session and attachments across actual /new", async () => {
  const f = fixture(), gate = deferred<{ accepted: boolean }>();
  f.reply(() => gate.promise);
  const first = f.app.submit("first"); await flush();
  const image = attachment("A.png");
  const second = f.app.submit("second", [image]);
  await f.app.submit("/new"); gate.resolve({ accepted: true }); await Promise.all([first, second]);
  assert.deepEqual(f.sends.map((x) => [x.session, x.text]), [["A", "first"], ["A", "second"]]);
  assert.equal(f.sends[1]?.attachments[0], image);
});

test("late rejection retains origin input without merging B draft or attachments", async () => {
  const f = fixture(), gate = deferred<{ accepted: boolean }>(); f.reply(() => gate.promise);
  const p = f.app.submit("A input", [attachment("A")]); await flush();
  f.setFocus("B"); f.setDraft("B draft"); f.app.pendingAttachments = [attachment("B")];
  gate.resolve({ accepted: false }); await p;
  assert.equal(f.draft(), "B draft"); assert.equal(f.app.pendingAttachments[0]?.name, "B");
  assert.equal(f.app.recoverableInputs.size, 1);
  const input = onlyRecovery(f.app);
  assert.equal(input.origin?.sessionId, "A"); assert.equal(input.attachments[0]?.name, "A");
  f.app.restoreRecoverableInput(input, false); assert.equal(f.draft(), "B draft");
  f.setFocus("A"); f.app.restoreRecoverableInput(input, false); assert.equal(f.draft(), "B draft");
  f.setDraft(""); f.app.pendingAttachments = []; f.app.restoreRecoverableInput(input, false);
  assert.equal(f.draft(), "A input"); assert.equal(f.app.pendingAttachments[0]?.name, "A");
  assert.equal(f.app.recoverableInputs.size, 0); assert.equal(f.sends.length, 1);
});

test("uncertain acknowledgment never auto-restores even empty original editor", async () => {
  const f = fixture(); f.reply(async () => { throw Error("lost receipt"); });
  await f.app.submit("might have run"); assert.equal(f.draft(), "");
  const input = onlyRecovery(f.app); assert.equal(input.uncertain, true);
  f.app.restoreRecoverableInput(input, false); assert.equal(f.draft(), "");
  assert.match(f.app.dialog.title, /重复执行/u);
  f.app.dialog.onSelect({ value: "restore" }); assert.equal(f.draft(), "might have run");
  assert.equal(f.sends.length, 1); assert.equal(f.app.recoverableInputs.size, 0);
});

test("accepted input is not recoverable when local history/rendering throws", async () => {
  const f = fixture(); f.app.editor.addToHistory = () => { throw Error("history UI failed"); };
  await f.app.submit("accepted"); assert.equal(f.sends.length, 1);
  assert.equal(f.app.recoverableInputs.size, 0); assert.equal(f.draft(), "");
  assert.ok(f.notices.some((x) => x.includes("已接纳")));
});

test("pending startup resolves intended new session before capturing queued inputs", async () => {
  const f = fixture(), ready = deferred(); f.setFocus("old primary"); f.app.startRuntimePromise = ready.promise;
  const a = f.app.submit("one"), b = f.app.submit("two"); await flush(); assert.equal(f.sends.length, 0);
  f.setFocus("intended startup session"); f.app.startRuntimePromise = undefined; ready.resolve(); await Promise.all([a, b]);
  assert.deepEqual(f.sends.map((x) => x.session), ["intended startup session", "intended startup session"]);
});

test("submission waits only its origin model switch captured before local queue", async () => {
  const f = fixture(), firstReceipt = deferred<{ accepted: boolean }>(), modelA = deferred(), modelB = deferred();
  // Avoid an unhandled rejection in this synthetic publisher, like applyModel's real observer.
  void modelB.promise.catch(() => undefined);
  f.reply(() => firstReceipt.promise); const first = f.app.submit("first"); await flush();
  const switches = new Map([["A", modelA.promise]]); f.app.sessionModelSwitches.set(f.runtime, switches);
  const second = f.app.submit("second"); f.setFocus("B"); switches.set("B", modelB.promise);
  firstReceipt.resolve({ accepted: true }); await flush(); assert.equal(f.sends.length, 1);
  modelB.reject(Error("B switch rejected")); modelA.resolve(); await Promise.all([first, second]);
  assert.equal(f.sends[1]?.session, "A"); assert.equal(f.app.recoverableInputs.size, 0);
});

test("steer keeps original target and uses same safe late-rejection recovery", async () => {
  const f = fixture(), gate = deferred<{ accepted: boolean }>(); f.reply(() => gate.promise); f.setDraft("steer A");
  const p = f.app.steerCurrentInput(); await flush(); f.setFocus("B"); f.setDraft("B next");
  gate.resolve({ accepted: false }); await p;
  assert.equal(f.sends[0]?.session, "A"); assert.equal(f.sends[0]?.delivery, "steer");
  assert.equal(f.draft(), "B next"); assert.equal(f.app.recoverableInputs.size, 1);
});

test("runtime replacement during write access never sends through another client", async () => {
  const f = fixture(), access = deferred(); f.runtime.ensureSession = () => access.promise;
  const p = f.app.submit("A input"); await flush(); f.app.runtime = { ...f.runtime };
  access.resolve(); await p; assert.equal(f.sends.length, 0); assert.equal(f.app.recoverableInputs.size, 1);
});

test("exit fences queued and pre-dispatch work, while explicit requestExit requires discard", async () => {
  const f = fixture(), access = deferred(); f.runtime.ensureSession = () => access.promise;
  const first = f.app.submit("first"), second = f.app.submit("second"); await flush();
  await f.app.requestExit(); assert.equal(f.app.exiting, undefined);
  f.app.dialog.onSelect({ value: "cancel" }); assert.equal(f.app.exiting, undefined);
  f.app.dialog.onSelect({ value: "exit" }); access.resolve(); await Promise.all([first, second]);
  assert.equal(f.sends.length, 0);
});

test("recovered editor-owned input still requires explicit exit discard", async () => {
  const f = fixture(); f.reply(async () => ({ accepted: false })); await f.app.submit("rejected");
  assert.equal(f.draft(), "rejected"); assert.equal(f.app.recoverableInputs.size, 0);
  await f.app.requestExit(); assert.equal(f.app.exiting, undefined); assert.match(f.app.dialog.title, /当前草稿/u);
});

test("partial recovery keeps payload and prevents duplicate merge until editor is cleared", async () => {
  const f = fixture(); f.setDraft("new draft"); f.reply(async () => ({ accepted: false })); await f.app.submit("recover me", [attachment("image")]);
  const input = onlyRecovery(f.app); f.setDraft("");
  const setAttachments = f.app.setPendingAttachments; f.app.setPendingAttachments = () => { throw Error("render failure"); };
  f.app.restoreRecoverableInput(input, false); assert.equal(f.app.recoverableInputs.size, 1); assert.equal(f.draft(), "recover me");
  f.app.restoreRecoverableInput(input, false); assert.equal(f.draft(), "recover me");
  f.setDraft(""); f.app.setPendingAttachments = setAttachments; f.app.restoreRecoverableInput(input, false);
  assert.equal(f.app.recoverableInputs.size, 0); assert.equal(f.app.pendingAttachments[0]?.name, "image");
});

test("unbound startup recovery confirmation cannot move input into a later focus", async () => {
  const f = fixture(); f.app.runtime = undefined; f.app.startRuntime = async () => undefined;
  await f.app.submit("startup input"); assert.equal(f.sends.length, 0);
  const input = onlyRecovery(f.app); assert.equal(input.origin, undefined);
  f.app.runtime = f.runtime; f.app.restoreRecoverableInput(input, false);
  const confirmation = f.app.dialog; f.setFocus("B"); confirmation.onSelect({ value: "restore" });
  assert.equal(f.draft(), ""); assert.equal(f.app.recoverableInputs.size, 1);
  f.app.restoreRecoverableInput(input, false); f.app.dialog.onSelect({ value: "restore" });
  assert.equal(f.draft(), "startup input"); assert.equal((input as ProbeInput).origin?.sessionId, "B");
});

test("late writer conflict is retained without opening a modal for another session", async () => {
  const f = fixture(), access = deferred(); f.runtime.ensureSession = () => access.promise;
  let conflicts = 0; f.app.showSessionWriterConflict = async () => { conflicts++; };
  const pending = f.app.submit("A input"); await flush(); f.setFocus("B");
  access.reject(Error("writer conflict")); await pending;
  assert.equal(conflicts, 0); assert.equal(f.draft(), ""); assert.equal(f.app.recoverableInputs.size, 1);
});

test("real applyModel wiring scopes waits by session and removes only its own completion", async () => {
  const f = fixture(), modelA = deferred<{ modelLabel: string; reasoningLabel: string }>(), modelB = deferred<{ modelLabel: string; reasoningLabel: string }>();
  Object.assign(f.runtime, { switchModel: async (_alias: string, _thinking: unknown, session: string) => await (session === "A" ? modelA.promise : modelB.promise) });
  f.app.applyModel("model A"); const pendingA = f.app.sessionModelSwitches.get(f.runtime)?.get("A"); assert.ok(pendingA);
  f.setFocus("B"); f.app.applyModel("model B"); const pendingB = f.app.sessionModelSwitches.get(f.runtime)?.get("B"); assert.ok(pendingB);
  f.setFocus("A"); const input = f.app.submit("A while switching"); await flush(); assert.equal(f.sends.length, 0);
  modelA.resolve({ modelLabel: "A", reasoningLabel: "off" }); await input;
  assert.equal(f.sends[0]?.session, "A"); assert.equal(f.app.sessionModelSwitches.get(f.runtime)?.get("A"), undefined);
  assert.equal(f.app.sessionModelSwitches.get(f.runtime)?.get("B"), pendingB);
  modelB.resolve({ modelLabel: "B", reasoningLabel: "off" }); await pendingB; await pendingA;
});

test("writer-conflict history resolving after focus change cannot replace new transcript", async () => {
  const f = fixture(), history = deferred<{ events: unknown[] }>(), events: unknown[] = [];
  f.sandbox.readStoredSessionEvents = () => history.promise;
  f.app.dispatch = (event: unknown) => events.push(event);
  const conflict = { sessionId: "A" };
  const shown = f.app.showSessionWriterConflict(conflict); await flush();
  f.setFocus("B"); f.app.clearSessionWriterConflict(); history.resolve({ events: [{ from: "A" }] }); await shown;
  assert.equal(events.length, 0); assert.equal(f.app.sessionWriterConflict, undefined);
});

test("steer undo incompatibility remains caught with untouched text and attachments", async () => {
  const f = fixture(); f.setDraft("original"); const image = attachment("image"); f.app.pendingAttachments = [image];
  f.sandbox.editorSubmissionUndo = () => { throw Error("incompatible editor"); };
  await f.app.steerCurrentInput(); assert.equal(f.draft(), "original"); assert.equal(f.app.pendingAttachments[0], image);
  assert.equal(f.sends.length, 0); assert.equal(f.app.pendingSubmissions.size, 0);
});

test("steer synchronous clear failure rolls back editor ownership without duplicate recovery", async () => {
  const f = fixture(); f.setDraft("original"); const image = attachment("image"); f.app.pendingAttachments = [image];
  let clears = 0; const set = f.app.setPendingAttachments;
  f.app.setPendingAttachments = (items: AgentAttachment[]) => { if (++clears === 1) throw Error("clear failed"); set(items); };
  await f.app.steerCurrentInput(); assert.equal(f.draft(), "original"); assert.equal(f.app.pendingAttachments[0], image);
  assert.equal(f.sends.length, 0); assert.equal(f.app.pendingSubmissions.size, 0); assert.equal(f.app.recoverableInputs.size, 0);
});

test("reconnected original project/session requires explicit recovery confirmation, never dispatch", async () => {
  const f = fixture(); f.setDraft("other draft"); f.reply(async () => ({ accepted: false })); await f.app.submit("saved A");
  const input = onlyRecovery(f.app); const replacement = { ...f.runtime };
  f.app.runtime = replacement; f.setDraft(""); f.app.restoreRecoverableInput(input, false);
  assert.equal(f.draft(), ""); assert.match(f.app.dialog.title, /同项目\/同会话/u);
  f.app.dialog.onSelect({ value: "restore" }); assert.equal(f.draft(), "saved A");
  assert.equal(f.sends.length, 1); assert.equal(input.origin?.runtime, replacement);
});

test("per-record discard is explicit and does not claim cancellation of uncertain requests", async () => {
  const f = fixture(); f.reply(async () => { throw Error("lost receipt"); }); await f.app.submit("uncertain");
  const input = onlyRecovery(f.app); f.app.showRecoverableInputs();
  f.app.dialog.onSelect({ value: String(input.id) }); f.app.dialog.onSelect({ value: "discard" });
  assert.match(f.app.dialog.title, /不撤销/u); assert.equal(f.app.recoverableInputs.size, 1);
  f.app.dialog.onSelect({ value: "cancel" }); assert.equal(f.app.recoverableInputs.size, 1);
  f.app.dialog.onSelect({ value: "discard" }); assert.equal(f.app.recoverableInputs.size, 0); assert.equal(f.sends.length, 1);
});

test("capacity backpressure consumes real Enter/steer before touching the editor", async () => {
  const f = fixture();
  for (let id = 1; id <= 20; id++) f.app.recoverableInputs.set(id, { id, text: "saved", attachments: [], target: Promise.resolve(undefined), phase: "failed" });
  f.setDraft("keep this draft"); const image = attachment("keep image"); f.app.pendingAttachments = [image];
  assert.equal(f.app.handleGlobalKey("enter")?.consume, true);
  await f.app.steerCurrentInput();
  assert.equal(f.draft(), "keep this draft"); assert.equal(f.app.pendingAttachments[0], image);
  assert.equal(f.app.pendingSubmissions.size, 0); assert.equal(f.sends.length, 0);
});

test("exit wording distinguishes dispatched request from unsent local input", async () => {
  const f = fixture(), gate = deferred<{ accepted: boolean }>(); f.reply(() => gate.promise);
  const p = f.app.submit("in flight"); await flush(); await f.app.requestExit();
  assert.match(f.app.dialog.title, /1 条已派发.*可能已接纳\/执行.*退出不保证撤销/u);
  f.app.dialog.onSelect({ value: "exit" }); gate.resolve({ accepted: true }); await p;
  assert.equal(f.sends.length, 1); assert.equal(f.app.recoverableInputs.size, 0);
});

test("accepted steer plus repeated notification errors can never roll back into B draft", async () => {
  const f = fixture(), gate = deferred<{ accepted: boolean }>(); f.reply(() => gate.promise);
  f.setDraft("A steer"); const p = f.app.steerCurrentInput(); await flush();
  f.setFocus("B"); f.setDraft("B draft"); let notices = 0;
  f.app.notify = () => { notices++; throw Error("notification failed"); };
  gate.resolve({ accepted: true }); await p;
  assert.equal(f.sends.length, 1); assert.equal(f.draft(), "B draft");
  assert.equal(f.app.recoverableInputs.size, 0); assert.equal(f.app.pendingSubmissions.size, 0); assert.equal(notices, 1);
});

test("actual double Ctrl+C never silently clears an editor-owned recovery", async () => {
  const f = fixture(); f.reply(async () => ({ accepted: false })); await f.app.submit("recovered draft");
  assert.equal(f.draft(), "recovered draft"); f.app.lastCtrlCAt = 0;
  f.app.handleGlobalKey("ctrl+c"); assert.equal(f.draft(), "recovered draft"); assert.equal(f.app.exiting, undefined);
  f.app.handleGlobalKey("ctrl+c"); assert.equal(f.draft(), "recovered draft"); assert.equal(f.app.exiting, undefined);
  assert.match(f.app.dialog.title, /当前草稿/u); f.app.dialog.onSelect({ value: "cancel" });
  assert.equal(f.draft(), "recovered draft"); assert.equal(f.app.exiting, undefined);
});


function realEditorFixture() {
  const f = fixture();
  // Editor is real; its TUI drawing scheduler is inert. No terminal is started.
  const editor = new Editor({ requestRender() {} } as TUI, editorTheme());
  f.app.editor = editor;
  f.app.setEditorText = (text) => editor.setText(text);
  return { ...f, editor };
}

test("real Editor preserves newer long paste while refused steer waits for manual recovery", async () => {
  const f = realEditorFixture(), gate = deferred<{ accepted: boolean }>(); f.reply(() => gate.promise);
  const original = "original 👩🏽‍💻 cafe\u0301\n".repeat(11).trimEnd();
  f.editor.handleInput(`\u001b[200~${original}\u001b[201~`); f.app.pendingAttachments = [attachment("original.png")];
  const p = f.app.steerCurrentInput(); await flush();
  const newer = "newer pasted line\n".repeat(11).trimEnd();
  f.editor.handleInput(`\u001b[200~${newer}\u001b[201~`); f.app.pendingAttachments = [attachment("newer.png")];
  gate.resolve({ accepted: false }); await p;
  assert.equal(f.editor.getExpandedText(), newer); assert.equal(f.app.pendingAttachments[0]?.name, "newer.png");
  const input = onlyRecovery(f.app); assert.equal(input.text, original); assert.equal(input.attachments[0]?.name, "original.png");
  f.app.restoreRecoverableInput(input, false); assert.equal(f.editor.getExpandedText(), newer);
  f.editor.setText(""); f.app.pendingAttachments = []; f.app.restoreRecoverableInput(input, false);
  assert.equal(f.editor.getExpandedText(), original); assert.equal(f.app.pendingAttachments[0]?.name, "original.png");
  assert.equal(f.app.recoverableInputs.size, 0); assert.equal(f.sends.length, 1);
});

test("real Editor submit clears text but full recovery capacity preserves it through fallback", async () => {
  const f = realEditorFixture();
  for (let id = 1; id <= 20; id++) f.app.recoverableInputs.set(id, { id, text: "saved", attachments: [], target: Promise.resolve(undefined), phase: "failed" });
  let submission: Promise<void> | undefined;
  f.editor.onSubmit = (text) => { submission = f.app.submit(text); };
  f.editor.setText("keep my Enter input"); f.app.pendingAttachments = [attachment("keep.png")];
  // Exercise the post-clear onSubmit fallback as well as the main key guard.
  f.editor.handleInput("\r"); await submission;
  assert.equal(f.editor.getExpandedText(), "keep my Enter input"); assert.equal(f.app.pendingAttachments[0]?.name, "keep.png");
  assert.equal(f.sends.length, 0); assert.equal(f.app.recoverableInputs.size, 20);
});

test("real Editor undo cannot resurrect accepted steer before admission completes", async () => {
  const f = realEditorFixture(), gate = deferred<{ accepted: boolean }>(); f.reply(() => gate.promise);
  f.editor.handleInput(`\u001b[200~${"original paste\n".repeat(11)}\u001b[201~`);
  const p = f.app.steerCurrentInput(); await flush(); f.editor.handleInput("\u001f");
  assert.equal(f.editor.getExpandedText(), ""); gate.resolve({ accepted: true }); await p;
  f.editor.handleInput("\u001f"); assert.equal(f.editor.getExpandedText(), ""); assert.equal(f.sends.length, 1);
});
