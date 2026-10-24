import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Read product source as text only. Native strip mode evaluates selected declarations
// against fake model, filesystem, recorder and timer boundaries; no product imports.
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}
function declaration(ast: ts.SourceFile, name: string): string {
  const item = ast.statements.find(node => (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(ast) === name));
  assert.ok(item, name);
  return item.getText(ast).replace(/^export /, "");
}
function method(ast: ts.SourceFile, owner: string, name: string): string {
  const item = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === owner);
  assert.ok(item && ts.isClassDeclaration(item), owner);
  const member = item.members.find(node => node.name?.getText(ast) === name);
  assert.ok(member, name);
  return member.getText(ast);
}
const sessionSource = source("agent/AgentSession.ts");
const analysisSource = source("agent/context/emotionAnalysis.ts");
const storageSource = source("agent/context/emotionStorage.ts");
const sessionMethods = ["close", "analyzeContextEmotion", "startNewSession", "resume", "settleSessionMemory", "closeReplacedSession"]
  .map(name => method(sessionSource, "AgentSession", name)).join("\n");
const analysisCode = ["analysisDelayMs", "recentMessageLimit", "recentMessageMaxChars", "autoEmotionResultSchema", "analyzeContextEmotion", "normalizeMessages", "EmotionAnalysisScheduler"]
  .map(name => declaration(analysisSource, name)).join("\n");
const storageCode = ["contextDirectoryName", "renderEmotionDocument", "safeFileName"].map(name => declaration(storageSource, name)).join("\n");
const selectedCode = `${analysisCode}\n${storageCode}\nclass Storage {${["writeContext", "writeState"].map(name => method(storageSource, "EmotionStorage", name)).join("\n")}}\nclass Session {${sessionMethods}}`;
const selectedAst = ts.createSourceFile("selected.ts", selectedCode, ts.ScriptTarget.Latest, true);
function audit(node: ts.Node): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword, "no dynamic imports");
  assert.ok(!ts.isImportDeclaration(node), "no product imports");
  if (ts.isIdentifier(node)) assert.ok(!["process", "require", "fetch", "eval", "Function"].includes(node.text), "no ambient effects");
  ts.forEachChild(node, audit);
}
audit(selectedAst);
const selectedJs = stripTypeScriptTypes(selectedCode, { mode: "strip" });
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function microtasks(): Promise<void> { for (let index = 0; index < 80; index += 1) await Promise.resolve(); }
interface Scheduler {
  schedule(sessionId: string, messageId?: string): void;
  cancel(): void;
  cancelAndDrain(): Promise<void>;
  close(): Promise<void>;
}
interface Harness {
  session: { close(): Promise<void>; startNewSession(): Promise<string>; resume(session: string): Promise<unknown>; recorder: { sessionId: string; closed: boolean } };
  scheduler: Scheduler;
  fire(): void;
  timerCount(): number;
}
type Gate = "rename" | "sync" | "none";
function fixture(gate: Gate = "rename", activityPending = false) {
  const entered = deferred(), release = deferred(), activity = deferred();
  const log: string[] = [], files = new Map<string, string>();
  let blocked = false;
  let nextId = 0;
  async function stage(name: string): Promise<void> {
    log.push(name);
    if (name === gate && !blocked) { blocked = true; entered.resolve(); await release.promise; }
  }
  const fs = {
    mkdir: async () => { await stage("mkdir"); }, chmod: async () => undefined,
    realpath: async (file: string) => file, stat: async () => ({ size: 1 }),
    open: async (file: string) => ({
      writeFile: async (text: string) => { files.set(file, text); },
      sync: async () => { await stage("sync"); }, close: async () => undefined
    }),
    rename: async (from: string, to: string) => { await stage("rename"); files.set(to, files.get(from)!); files.delete(from); log.push("committed"); },
    unlink: async (file: string) => { files.delete(file); log.push("unlink"); }
  };
  // This scaffold replaces only external boundaries of the extracted methods.
  // The actual lifecycle methods decide when fake recorders close and usage resets.
  const setup = `
    const timers = new Map(); let nextTimer = 0;
    class SessionRecorder {
      constructor(root, id = 'new-session', file = 'new.jsonl') { this.sessionId = id; this.filePath = file; this.closed = false; }
      async flush() {} runtimeContextSnapshot() { return {runId: 'old-run'}; }
      recordWithRuntimeContext() { log.push('metadata:' + this.closed); if (this.closed) throw new Error('Recorder closed'); }
      record() {} async close() { this.closed = true; log.push('recorder-close:' + this.sessionId); }
      repairTailForAppend() {} restoreToolCallSequence() {} restoreMessageParent() {}
    }
    class TurnStore { async load() { return undefined; } }
    const ensureAgentDirs = async () => undefined;
    const resolveSessionFile = async (root, name) => name === 'old-session' ? 'old.jsonl' : 'other.jsonl';
    const sessionIdFromFile = file => file === 'old.jsonl' ? 'old-session' : 'other-session';
    const assertSessionFileSize = () => undefined, sessionFileFingerprint = () => ({});
    const tryReadSessionSnapshot = async () => undefined, snapshotToReplay = () => undefined;
    const readSessionEvents = async () => [], readSessionCatalogRecord = async () => undefined;
    const replaySessionEvents = () => ({messages: [], usage: [], modelRequests: [], events: [], messageTree: [], messageReferences: [], recoveredToolResults: [], totalMessageCount: 0});
    const writeSessionSnapshot = async () => undefined, maxToolCallSequence = () => 0;
    const activeSessionMessageIds = () => new Set(), activeSessionEventsForPath = events => events;
    const undeliveredMessageNotices = () => [], resolveChatPersonalization = () => ({}), defaultChatPersonalizationOverride = {};
    const session = new Session();
    session.recorder = new SessionRecorder('/synthetic', 'old-session', 'old.jsonl');
    session.options = {permissionManager: {resetSession() {log.push('reset');}}};
    session.persistenceRoot = () => '/synthetic';
    session.closeActivityContext = async () => { if (activityPending) await activity; };
    session.sessionSearchIndex = {close: async () => undefined}; session.titleAbort = new AbortController();
    session.pendingMemoryTasks = new Set(); session.pendingCrystalTasks = new Set(); session.closed = false;
    session.memoryRetriever = session.localMemory = session.crystalService = {close() {}};
    session.takeRelatedUsage = () => undefined; session.toolModel = () => ({});
    session.recentEmotionMessages = async () => [{role:'user', text:'hello'}];
    session.recordModelUsage = () => undefined; session.recordModelRequest = async () => undefined;
    session.activeConfig = {context: {memory: {}}};
    session.contextMemory = {restore() {}, invalidateWorkspace() {}, setPersonalization() {}};
    session.beginOperation = () => () => undefined;
    session.rehydrateSessionMessages = async messages => messages;
    session.readPersonalizationState = async () => ({config: session.activeConfig, state: {resolved: {}}});
    session.emotionStorage = new Storage(); session.emotionStorage.root = '/synthetic/emotions';
    session.emotionStorage.readBase = async () => ({energy:5}); session.emotionStorage.readContext = async () => undefined;
    const scheduler = new EmotionAnalysisScheduler({
      analyze: (...args) => session.analyzeContextEmotion(...args),
      timers: {setTimeout(callback) { const handle = {id: ++nextTimer, unref() {}}; timers.set(handle, callback); return handle; }, clearTimeout(handle) {timers.delete(handle);}}
    });
    session.emotionAnalysisScheduler = scheduler;
    ({session, scheduler, fire() {const [handle, callback] = timers.entries().next().value; timers.delete(handle); callback();}, timerCount() {return timers.size;}});
  `;
  const harness = runInNewContext(`${selectedJs}\n${setup}`, {
    z, Promise, AbortController, AbortSignal, Date, Set, Map, Math, JSON, Error, AggregateError, path, fs, log,
    activityPending, activity: activity.promise,
    randomUUID: () => `inert-${++nextId}`, autoEmotionSystemPrompt: "inert prompt", DEFAULT_EMOTION_STATE: { energy: 5 },
    generateNativeText: async () => ({ text: '{"mood":"happy","valence":8,"reason":"success"}' })
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Harness;
  return { ...harness, log, files, entered, release, activity };
}
async function begin(f: ReturnType<typeof fixture>): Promise<void> {
  f.scheduler.schedule("old-session", "assistant-id"); f.fire(); await f.entered.promise;
}

test("close joins admitted rename and records success before recorder close", { timeout: 5000 }, async () => {
  const f = fixture(); await begin(f);
  let closed = false; const closing = f.session.close().then(() => { closed = true; });
  await microtasks(); assert.equal(closed, false, "close must join admitted emotion commit");
  assert.equal(f.session.recorder.closed, false);
  f.release.resolve(); await closing;
  assert.ok(f.log.includes("metadata:false")); assert.ok(f.log.includes("recorder-close:old-session"));
  assert.ok(f.log.indexOf("metadata:false") < f.log.indexOf("recorder-close:old-session"));
  assert.equal(f.files.size, 1); assert.ok(f.log.includes("committed"));
  await f.session.close();
});

for (const transition of ["new", "same", "other"] as const) {
  test(`${transition} session transition joins analysis before recorder/usage reset`, { timeout: 5000 }, async () => {
    const f = fixture(); await begin(f); const previous = f.session.recorder;
    let done = false;
    const switching = (transition === "new" ? f.session.startNewSession() : f.session.resume(transition === "same" ? "old-session" : "other-session"))
      .then(() => { done = true; });
    await microtasks(); assert.equal(done, false); assert.equal(previous.closed, false); assert.equal(f.log.includes("reset"), false);
    f.release.resolve(); await switching;
    assert.ok(f.log.includes("metadata:false")); assert.ok(f.log.includes("recorder-close:old-session"));
    assert.ok(f.log.indexOf("metadata:false") < f.log.indexOf("recorder-close:old-session"));
    assert.ok(f.log.includes("reset"));
    assert.ok(f.log.indexOf("metadata:false") < f.log.indexOf("reset"));
    assert.equal(f.session.recorder.sessionId, transition === "same" ? "old-session" : transition === "new" ? "new-session" : "other-session");
    f.scheduler.schedule(f.session.recorder.sessionId); assert.equal(f.timerCount(), 1, "nonterminal drain permits next session analysis");
    await f.scheduler.close();
  });
}

test("final close seals scheduler synchronously before unrelated activity join", { timeout: 5000 }, async () => {
  const f = fixture("none", true); f.scheduler.schedule("old-session");
  const closing = f.session.close();
  assert.equal(f.timerCount(), 0);
  f.scheduler.schedule("old-session"); assert.equal(f.timerCount(), 0);
  f.activity.resolve(); await closing; assert.equal(f.log.includes("mkdir"), false);
});

test("rescheduled and ordinarily cancelled older work remains owned", { timeout: 5000 }, async () => {
  const f = fixture(); await begin(f);
  f.scheduler.cancel(); // Must remain synchronous and not drop the blocked task.
  f.scheduler.schedule("old-session", "new-message");
  let closed = false; const closing = f.session.close().then(() => { closed = true; });
  await microtasks(); assert.equal(closed, false); assert.equal(f.timerCount(), 0);
  f.release.resolve(); await closing; assert.ok(f.log.includes("metadata:false"));
});

test("abort before rename preserves cancellation and joins temporary cleanup", { timeout: 5000 }, async () => {
  const f = fixture("sync"); await begin(f);
  let closed = false; const closing = f.session.close().then(() => { closed = true; });
  await microtasks(); assert.equal(closed, false);
  f.release.resolve(); await closing;
  assert.equal(f.log.includes("committed"), false); assert.equal(f.files.size, 0);
  assert.equal(f.log.some(item => item.startsWith("metadata:")), false);
  assert.ok(f.log.includes("unlink")); assert.ok(f.log.includes("recorder-close:old-session"));
  assert.ok(f.log.indexOf("unlink") < f.log.indexOf("recorder-close:old-session"));
});

test("late write rejection settles without metadata or blocking repeated close", { timeout: 5000 }, async () => {
  const f = fixture(); await begin(f);
  const first = f.session.close(), second = f.session.close();
  f.release.reject(new Error("synthetic rename failure")); await Promise.all([first, second]);
  assert.equal(f.log.includes("committed"), false); assert.equal(f.files.size, 0);
  assert.equal(f.log.some(item => item.startsWith("metadata:")), false);
});

test("normal valid model success still commits and records metadata", { timeout: 5000 }, async () => {
  const f = fixture("none"); f.scheduler.schedule("old-session", "assistant-id"); f.fire();
  await microtasks(); assert.ok(f.log.includes("committed")); assert.ok(f.log.includes("metadata:false"));
  await f.session.close(); assert.equal(f.files.size, 1);
});

test("synchronous analysis throw is isolated and admitted task settles", { timeout: 5000 }, async () => {
  // A separate context handle exposes only the injected timer, never real timers.
  let fire: (() => void) | undefined;
  const actual = runInNewContext(`${selectedJs}\nnew EmotionAnalysisScheduler({analyze() {throw new Error('synthetic sync error');}, timers: timers})`, {
    z, Promise, AbortController, Set, Error,
    timers: { setTimeout(callback: () => void) { fire = callback; return { unref() {} }; }, clearTimeout() {} }
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Scheduler;
  actual.schedule("old-session"); assert.ok(fire); assert.doesNotThrow(() => fire!()); await actual.close();
});

test("older cancelled commit remains owned after newer analysis finishes", { timeout: 5000 }, async () => {
  const f = fixture(); await begin(f);
  f.scheduler.schedule("old-session", "newer-message"); f.fire(); await microtasks();
  assert.equal(f.log.filter(item => item === "metadata:false").length, 1, "newer analysis has settled");
  let closed = false; const closing = f.session.close().then(() => { closed = true; });
  await microtasks(); assert.equal(closed, false, "older cancelled task is still owned after current controller clears");
  f.release.resolve(); await closing;
  assert.equal(f.log.filter(item => item === "metadata:false").length, 2);
});
