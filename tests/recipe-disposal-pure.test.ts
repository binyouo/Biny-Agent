import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

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
const sessionSource = source("agent/AgentSession.ts"), recipesSource = source("session/recipes.ts");
const runtimeSource = source("runtime/InteractiveAgentRuntime.ts");
const requiredMethods = ["close", "startNewSession", "resume", "settleSessionMemory", "closeReplacedSession", "enqueueRecipeSuggestions"];
const sessionMethods = requiredMethods.map(name => method(sessionSource, "AgentSession", name));
const owner = sessionSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AgentSession");
assert.ok(owner && ts.isClassDeclaration(owner));
// Optional only to replay the exact pre-fix source as a regression control.
for (const name of ["collectRecipeSuggestions", "drainRecipeSuggestions", "pendingRecipeTasks", "recipeSuggestionsClosed"]) {
  const member = owner.members.find(node => node.name?.getText(sessionSource) === name);
  if (member) sessionMethods.push(member.getText(sessionSource));
}
let runtimeCallback: ts.ArrowFunction | undefined;
function findCallback(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setOnRecipeReady") {
    const argument = node.arguments[0]; assert.ok(argument && ts.isArrowFunction(argument));
    assert.equal(runtimeCallback, undefined); runtimeCallback = argument;
  }
  ts.forEachChild(node, findCallback);
}
findCallback(runtimeSource); assert.ok(runtimeCallback);
const recipeCode = ["recipeIds", "correctionPattern", "fileReferencePattern", "maxAnchorTextLength", "freshRecipeSuggestions", "collectRecipeFacts", "recipeDefinitions", "buildRecipePrompt", "successfulToolResult", "hasToolFailure", "isMcpTool", "stringField", "isRecord", "isNotFound"]
  .map(name => declaration(recipesSource, name)).join("\n");
// Deliberately omit the real store's unrelated clear/remove operation.
const storeCode = `class RecipeStateStore {${["constructor", "read", "set", "sessionDirectory"].map(name => {
  if (name !== "constructor") return method(recipesSource, "RecipeStateStore", name);
  const item = recipesSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "RecipeStateStore");
  assert.ok(item && ts.isClassDeclaration(item)); const constructor = item.members.find(ts.isConstructorDeclaration); assert.ok(constructor); return constructor.getText(recipesSource);
}).join("\n")}}`;
const selected = `${recipeCode}\n${storeCode}\nclass Session {${sessionMethods.join("\n")}}\nfunction installCallback() {return ${runtimeCallback.getText(runtimeSource)};}`;
const ast = ts.createSourceFile("selected.ts", selected, ts.ScriptTarget.Latest, true);
function audit(node: ts.Node): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword); assert.ok(!ts.isImportDeclaration(node));
  if (ts.isIdentifier(node)) assert.ok(!["process", "require", "fetch", "eval", "Function"].includes(node.text));
  ts.forEachChild(node, audit);
}
audit(ast);
const selectedJs = stripTypeScriptTypes(selected, { mode: "strip" });
function deferred() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function microtasks(): Promise<void> { for (let index = 0; index < 100; index += 1) await Promise.resolve(); }
interface Notice { sessionId: string; runId: string; recipe: { id: string; extractPrompt: string } }
interface Harness {
  session: {
    close(): Promise<void>; startNewSession(): Promise<string>; resume(name: string): Promise<unknown>;
    enqueueRecipeSuggestions(options: { runId?: string }): Promise<void>;
    recorder: { sessionId: string; closed: boolean };
  };
}
const qualifyingEvents = [
  { type: "user_message", content: "Read input.md", messageId: "user-one" },
  { type: "tool_call", tool: "Write", toolCallId: "write-one", args: { path: "output.md" } },
  { type: "tool_result", tool: "Write", toolCallId: "write-one", executionStatus: "succeeded", result: {} },
  { type: "tool_call", tool: "mcp_example_export", toolCallId: "mcp-one", args: {} },
  { type: "tool_result", tool: "mcp_example_export", toolCallId: "mcp-one", executionStatus: "succeeded", result: {} }
];
function fixture(options: { gate?: "readEvents" | "writeFile"; state?: string; qualifying?: boolean; callbackThrows?: boolean; activityPending?: boolean } = {}) {
  const entered = deferred(), release = deferred(), activity = deferred();
  const log: string[] = [], notices: Notice[] = [], files = new Map<string, string>();
  let blocked = false, nextId = 0;
  if (options.state) files.set("/synthetic/recipe-state/old-session/mcp-pipeline.json", JSON.stringify({ version: 1, state: options.state }));
  async function stage(name: string): Promise<void> {
    log.push(name);
    if (name === options.gate && !blocked) { blocked = true; entered.resolve(); await release.promise; }
  }
  const fs = {
    realpath: async (file: string) => file, stat: async () => ({ size: 1 }),
    mkdir: async (directory: string) => { log.push(`mkdir:${directory}`); },
    chmod: async () => undefined,
    readdir: async (directory: string) => [...files.keys()].filter(file => path.dirname(file) === directory).map(file => ({ name: path.basename(file), isFile: () => true })),
    readFile: async (file: string) => { assert.ok(files.has(file)); return files.get(file)!; },
    writeFile: async (file: string, text: string) => { await stage("writeFile"); files.set(file, text); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); log.push(`committed:${to}`); },
    unlink: async (file: string) => { files.delete(file); log.push("unlink"); }
  };
  const setup = `
    class SessionRecorder {
      constructor(root, id = 'new-session', file = 'new.jsonl') { this.sessionId = id; this.filePath = file; this.closed = false; }
      async flush() {log.push('flush:' + this.sessionId);} record() {}
      async close() {this.closed = true; log.push('recorder-close:' + this.sessionId);}
      repairTailForAppend() {} restoreToolCallSequence() {} restoreMessageParent() {}
    }
    class TurnStore {async load() {return undefined;}}
    const ensureAgentDirs = async () => undefined;
    const resolveSessionFile = async (root, name) => name === 'old-session' ? 'old.jsonl' : 'other.jsonl';
    const sessionIdFromFile = file => file === 'old.jsonl' ? 'old-session' : 'other-session';
    const assertSessionFileSize = () => undefined, sessionFileFingerprint = () => ({});
    const tryReadSessionSnapshot = async () => undefined, snapshotToReplay = () => undefined;
    const readSessionEvents = async file => {if (file === 'old.jsonl') await stage('readEvents'); return events;};
    const readSessionCatalogRecord = async () => undefined;
    const replaySessionEvents = () => ({messages: [], usage: [], modelRequests: [], events: [], messageTree: [], messageReferences: [], recoveredToolResults: [], totalMessageCount: 0});
    const writeSessionSnapshot = async () => undefined, maxToolCallSequence = () => 0;
    const activeSessionMessageIds = () => new Set(), activeSessionEventsForPath = events => events;
    const undeliveredMessageNotices = () => [], resolveChatPersonalization = () => ({}), defaultChatPersonalizationOverride = {};
    const session = new Session(); session.recorder = new SessionRecorder('/synthetic','old-session','old.jsonl');
    session.options = {permissionManager: {resetSession() {log.push('reset');}}};
    session.persistenceRoot = () => '/synthetic'; session.closeActivityContext = async () => {if (activityPending) await activity;};
    session.sessionSearchIndex = {close: async () => undefined}; session.titleAbort = new AbortController();
    session.emotionAnalysisScheduler = {close: async () => undefined, cancelAndDrain: async () => undefined};
    session.pendingMemoryTasks = new Set(); session.closed = false;
    session.memoryRetriever = session.localMemory = {close(){}}; session.takeRelatedUsage = () => undefined;
    session.activeConfig = {context:{memory:{}}}; session.contextMemory = {restore(){},invalidateWorkspace(){},setPersonalization(){}};
    session.beginOperation = () => () => undefined; session.rehydrateSessionMessages = async messages => messages;
    session.readPersonalizationState = async () => ({config:session.activeConfig,state:{resolved:{}}});
    const runtime = {commandRuntime:{agent:{getInfo:()=>({sessionId:session.recorder.sessionId})}},emit(notice) {notices.push(notice); log.push('notice:' + notice.sessionId); if(callbackThrows) throw new Error('synthetic UI error');}};
    session.options.onRecipeReady = installCallback.call(runtime);
    ({session});
  `;
  const harness = runInNewContext(`${selectedJs}\n${setup}`, {
    Promise, AbortController, Set, Map, Date, Math, JSON, Error, AggregateError, path, fs, log, notices, stage,
    events: options.qualifying === false ? [{ type: "user_message", content: "hello" }] : qualifyingEvents,
    randomUUID: () => `inert-${++nextId}`, redactSecrets: (text: string) => text,
    activityPending: options.activityPending ?? false, activity: activity.promise, callbackThrows: options.callbackThrows ?? false
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Harness;
  return { ...harness, log, notices, files, entered, release, activity };
}
function assertNoticeBeforeClose(f: ReturnType<typeof fixture>): void {
  assert.ok(f.log.includes("notice:old-session")); assert.ok(f.log.includes("recorder-close:old-session"));
  assert.ok(f.log.indexOf("notice:old-session") < f.log.indexOf("recorder-close:old-session"));
  assert.equal(f.notices[0]?.sessionId, "old-session"); assert.equal(f.notices[0]?.runId, "old-run");
  assert.match(f.notices[0]!.recipe.extractPrompt, /old-session/u);
  assert.match(f.notices[0]!.recipe.extractPrompt, /output.md/u);
  assert.ok(f.files.has("/synthetic/recipe-state/old-session/mcp-pipeline.json"));
  assert.equal([...f.files.keys()].some(file => file.includes("new-session") || file.includes("other-session")), false);
}

for (const gate of ["readEvents", "writeFile"] as const) {
  test(`close joins recipe ${gate} through state write and synchronous UI callback`, { timeout: 5000 }, async () => {
    const f = fixture({ gate }); const runOptions = { runId: "old-run" };
    const task = f.session.enqueueRecipeSuggestions(runOptions); await f.entered.promise;
    runOptions.runId = "mutated-run";
    let closed = false; const closing = f.session.close().then(() => {closed = true;});
    await microtasks(); assert.equal(closed, false, "close must join admitted recipe work");
    assert.equal(f.session.recorder.closed, false);
    f.release.resolve(); await Promise.all([task, closing]); assertNoticeBeforeClose(f);
    const count = f.notices.length; await f.session.close(); assert.equal(f.notices.length, count);
  });
}
for (const transition of ["new", "same", "other"] as const) {
  test(`${transition} session transition keeps old recipe state and UI identity before swap`, { timeout: 5000 }, async () => {
    const f = fixture({ gate: "readEvents" }); const old = f.session.recorder;
    const task = f.session.enqueueRecipeSuggestions({ runId: "old-run" }); await f.entered.promise;
    let done = false; const switching = (transition === "new" ? f.session.startNewSession() : f.session.resume(transition === "same" ? "old-session" : "other-session")).then(() => {done = true;});
    await microtasks(); assert.equal(done, false); assert.equal(old.closed, false); assert.equal(f.log.includes("reset"), false);
    f.release.resolve(); await Promise.all([task, switching]); assertNoticeBeforeClose(f);
    assert.ok(f.log.includes("reset")); assert.ok(f.log.indexOf("notice:old-session") < f.log.indexOf("reset"));
    assert.equal(f.session.recorder.sessionId, transition === "same" ? "old-session" : transition === "new" ? "new-session" : "other-session");
    await f.session.enqueueRecipeSuggestions({ runId: "fresh-run" });
    assert.equal(f.notices.length, transition === "same" ? 1 : 2, "nonterminal drain preserves future recipe detection");
    if (transition !== "same") assert.equal(f.notices[1]?.sessionId, f.session.recorder.sessionId);
    await f.session.close();
  });
}

test("terminal seal rejects later recipe admission before unrelated activity join", { timeout: 5000 }, async () => {
  const f = fixture({ activityPending: true }); const closing = f.session.close();
  await f.session.enqueueRecipeSuggestions({ runId: "late-run" }); assert.equal(f.log.length, 0);
  f.activity.resolve(); await closing; assert.equal(f.files.size, 0); assert.equal(f.notices.length, 0);
});

test("normal recipe succeeds once and recorded state suppresses later duplicates", { timeout: 5000 }, async () => {
  const f = fixture(); await f.session.enqueueRecipeSuggestions({ runId: "old-run" });
  assert.equal(f.notices.length, 1); await f.session.enqueueRecipeSuggestions({ runId: "next-run" });
  assert.equal(f.notices.length, 1); await f.session.close(); assertNoticeBeforeClose(f);
});
for (const state of ["notified", "dismissed", "extracted"] as const) {
  test(`${state} recipe state remains suppressed`, { timeout: 5000 }, async () => {
    const f = fixture({ state }); await f.session.enqueueRecipeSuggestions({ runId: "old-run" }); await f.session.close();
    assert.equal(f.notices.length, 0); assert.equal(f.log.includes("writeFile"), false);
  });
}

test("nonqualifying history never starts recipe persistence", { timeout: 5000 }, async () => {
  const f = fixture({ qualifying: false }); await f.session.enqueueRecipeSuggestions({ runId: "old-run" }); await f.session.close();
  assert.equal(f.files.size, 0); assert.equal(f.notices.length, 0); assert.equal(f.log.includes("writeFile"), false);
});

test("late write rejection settles and repeated close does not notify", { timeout: 5000 }, async () => {
  const f = fixture({ gate: "writeFile" }); const task = f.session.enqueueRecipeSuggestions({ runId: "old-run" }); await f.entered.promise;
  const first = f.session.close(), second = f.session.close(); f.release.reject(new Error("synthetic write failure"));
  await Promise.all([task, first, second]); assert.equal(f.notices.length, 0); assert.equal(f.files.size, 0);
});

test("synchronous UI failure remains isolated after notified state persists", { timeout: 5000 }, async () => {
  const f = fixture({ callbackThrows: true }); await f.session.enqueueRecipeSuggestions({ runId: "old-run" }); await f.session.close();
  assert.equal(f.notices.length, 1); assertNoticeBeforeClose(f);
});

test("older recipe remains owned after a newer task has settled", { timeout: 5000 }, async () => {
  const f = fixture({ gate: "readEvents" }); const older = f.session.enqueueRecipeSuggestions({ runId: "old-run" }); await f.entered.promise;
  await f.session.enqueueRecipeSuggestions({ runId: "newer-run" }); assert.equal(f.notices.length, 1);
  let closed = false; const closing = f.session.close().then(() => {closed = true;});
  await microtasks(); assert.equal(closed, false); f.release.resolve(); await Promise.all([older, closing]);
  assert.equal(f.notices.length, 1, "older read sees notified state and remains suppressed");
});
