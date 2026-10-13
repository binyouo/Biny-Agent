import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Fixed source-text reads only; no product imports or product I/O is executed.
const paths = {
  desktop: "src/desktop/electron/main/DesktopThreadBriefService.ts",
  engine: "src/session/threadBriefService.ts",
  tree: "src/session/messageTree.ts"
};
const files = Object.fromEntries(Object.entries(paths).map(([key, filename]) => [
  key, ts.createSourceFile(filename, readFileSync(new URL("../" + filename, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
])) as Record<keyof typeof paths, ts.SourceFile>;
function methods(file: ts.SourceFile, owner: string, names: string[], optional: string[] = []): ts.MethodDeclaration[] {
  const classes = file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === owner);
  assert.equal(classes.length, 1);
  return [...names, ...optional].flatMap(name => {
    const found = classes[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
    assert.equal(found.length, optional.includes(name) ? Math.min(found.length, 1) : 1);
    return found;
  });
}
function functions(file: ts.SourceFile, names: string[], optional = false): ts.FunctionDeclaration[] {
  return names.flatMap(name => {
    const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(found.length, optional ? Math.min(found.length, 1) : 1);
    return found;
  });
}
const desktop = methods(files.desktop, "DesktopThreadBriefService", ["readThread", "isVisibleThread", "isVisibleSuggestion"], ["canPersist"]);
const helper = functions(files.desktop, ["briefSource"], true);
const engine = methods(files.engine, "ThreadBriefService", ["enqueue", "startDrain", "drain", "close", "setConfig", "generate", "mayPersist"]);
const tree = functions(files.tree, ["sessionMessageTree", "activeSessionMessageIds", "compatibleSessionSelections"]);
const calls = new Set([
  "this.options.state.projects", "this.options.state.projects().find", "this.options.state.projects().some",
  "this.options.projects.dataRoot", "resolveSessionFile", "resolveSessionFile(root, sessionId).catch",
  "resolveSessionFile(root, thread.sessionId).catch", "resolveSessionFile(source.projectPath, thread.sessionId).catch",
  "sessionIdFromFile", "readSessionCatalogRecord", "stat", "readSessionEvents", "readSessionSummary",
  "Promise.all", "(await stat(file)).birthtime.toISOString", "summary.firstUserMessage.slice",
  "/^(?:⏰ Cron:|💓 Heartbeat)/u.test", "this.sources.set", "this.sources.get", "this.isVisibleThread",
  "stillRegistered", "briefSource", "sessionMessageTree", "activeSessionMessageIds",
  "sessionMessageTree(events).filter", "sessionMessageTree(events).filter((node) => active.has(node.id)).flatMap",
  "active.has", "nodes.filter", "nodes.filter((node) => active.has(node.id)).flatMap",
  "node.message.content.filter", 'node.message.content.filter((part) => part.type === "text").map',
  'node.message.content.filter((part) => part.type === "text").map((part) => part.text).join',
  "publicUserMessage", "selected.map", "createHash", 'createHash("sha256").update',
  'createHash("sha256").update(JSON.stringify(selected)).digest', "JSON.stringify",
  "this.store.setConfig", "this.controller?.abort", "this.options.onChange", "this.options.onChange?.",
  "Promise.reject", "Promise.resolve", "this.queue.some", "this.queue.push",
  "this.startDrain", "this.drain", "this.drain().finally", "this.queue.shift", "this.generate",
  "job.resolve", "job.reject", "this.store.setError", "redactSecrets", "String", "this.now",
  "this.now().toISOString", "redactSecrets(error instanceof Error ? error.message : String(error)).slice",
  "this.queue.splice", "this.store.close", "this.store.config", "this.options.readThread",
  "this.store.enabledAt", "signal.throwIfAborted", "thread.messages.map",
  "messages.filter", "messages.map", "messages.some", "message.role.toUpperCase", "message.text.includes", "material.includes",
  "fullMaterial.slice", 'createHash("sha256").update(material).digest',
  "this.store.brief", "this.options.getModel", "briefSchema.safeParse", "this.ask", "this.mayPersist",
  "this.store.putBrief", "this.suggest", "this.options.canPersist", "events.flatMap",
  "selectedSlots.delete", "selectedSlots.set", "nodes.map", "path.has", "path.add", "byId.get",
  "pathFor", "[...selectedSlots].every", "compatibleSessionSelections", "selectedSlots.values",
  "counts.has", "positions.has", "positions.set", "trail.push", "counts.get", "positions.get",
  "trail.splice", "cycle.reduce", "Number", "selected.has", "counts.set", "[...nodes].reverse",
  "[...nodes].reverse().find", "nodes.at", "choices.some", "byId.has", "roots.push",
  "children.get", "siblings.push", "children.set", "roots.map", "stack.pop", "ends.set",
  "starts.set", "stack.push", "starts.get", "ends.get", "ancestorOf", "selected.add"
]);
// Only the existing normalization chain rooted in the literal message mapper
// can use chained replace/trim/slice/filter; no ambient object is admitted.
function normalizingCall(node: ts.CallExpression, file: ts.SourceFile): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text === "join" && ts.isCallExpression(node.expression.expression)
    && node.expression.expression.expression.getText(file) === "messages.map") return true;
  if (!["replace", "trim", "slice", "filter"].includes(node.expression.name.text)) return false;
  const text = node.getText(file);
  return text.startsWith("redactSecrets(message.text)") || text.startsWith("thread.messages.map(");
}
function audit(node: ts.Node, file: ts.SourceFile): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isNewExpression(node)) assert.ok(["Error", "Promise", "AbortController", "AggregateError", "Set", "Map"].includes(node.expression.getText(file)), "unexpected constructor");
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(file)) || normalizingCall(node, file), "Unexpected extracted call: " + node.expression.getText(file));
  ts.forEachChild(node, child => audit(child, file));
}
for (const node of [...desktop, ...helper]) audit(node, files.desktop);
for (const node of engine) audit(node, files.engine);
for (const node of tree) audit(node, files.tree);
const extracted = [
  ...tree.map(node => node.getText(files.tree).replace(/^export /u, "")),
  ...helper.map(node => node.getText(files.desktop)),
  "class Desktop {\n" + desktop.map(node => node.getText(files.desktop)).join("\n") + "\n}",
  "class Engine {\n" + engine.map(node => node.getText(files.engine)).join("\n") + "\n}",
  "({ desktop: Desktop.prototype, engine: Engine.prototype });"
].join("\n");
type Message = { role: "assistant"; content: Array<{ type: "text"; text: string }> }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: Array<{ type: "text"; text: string }> };
type Event = { type: "agent_message"; messageId: string; parentMessageId?: string; slotId?: string; message: Message }
  | { type: "user_message"; messageId: string; parentMessageId?: string; slotId?: string; content: string }
  | { type: "message_version_selected"; messageId: string; slotId: string };
type Thread = { sessionId: string; projectId: string; title: string; createdAt: string; messages: Array<{ role: "user" | "assistant"; text: string }> };
type Project = { id: string; path: string; missing: boolean };
type Row = { sessionId: string; contentHash: string; materialLength: number; status: string; statusManual: boolean; autoTodo?: object; brief?: object };
type Config = { enabled: boolean; autoTodo: boolean; projectSuggestions: boolean; minUserTurns: number; minNewChars: number };
interface Desktop {
  options: { state: { projects(): Project[] }; projects: { dataRoot(project: Project): Promise<string> } };
  sources: WeakMap<object, object>;
  readThread(id: string): Promise<Thread | undefined>;
  isVisibleSuggestion(input: { threads: Thread[] }): Promise<boolean>;
  canPersist?(threads: Thread[]): Promise<boolean>;
}
interface Engine {
  store: {
    config(): Config; enabledAt(): string; brief(id: string): Row | undefined; putBrief(row: Row): void;
    setError(value: unknown): void; setConfig(config: Config): void; close(): void;
  };
  options: { readThread(id: string): Promise<Thread | undefined>; getModel(): Promise<object>; canPersist(threads: Thread[]): Promise<boolean>; onChange(): void };
  queue: unknown[]; closed: boolean; draining?: Promise<void>; controller?: AbortController;
  now(): Date; ask(): Promise<object>; suggest(): Promise<void>;
  enqueue(id: string, manual?: boolean): Promise<void>; close(): Promise<void>; setConfig(config: Config): void;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function initial(): Event[] {
  return [
    { type: "user_message", messageId: "u", content: "明天我会发布编辑器" },
    { type: "agent_message", messageId: "old", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "older" }] } },
    { type: "agent_message", messageId: "new", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "newer" }] } }
  ];
}
const answer = { topic: "发布", goal: "", objects: [], conclusions: [], followUp: { what: "发布编辑器", quote: "明天我会发布编辑器" } };
function fixture() {
  let events = initial(), projects: Project[] = [{ id: "project", path: "/fixture/project", missing: false }], exists = true;
  let reads = 0, roots = 0, writes = 0, changes = 0, errors = 0, asks = 0, suggestions = 0, closes = 0;
  let readHook: (() => Promise<void>) | undefined;
  let config: Config = { enabled: true, autoTodo: true, projectSuggestions: false, minUserTurns: 1, minNewChars: 0 };
  const rows = new Map<string, Row>();
  const prototypes = runInNewContext(stripTypeScriptTypes(extracted, { mode: "strip" }), {
    createHash, AbortController, redactSecrets: (text: string) => text, publicUserMessage: (text: string) => text,
    briefSchema: { safeParse: (data: object) => ({ success: true, data }) }, threadBriefPrompt: "fixture",
    resolveSessionFile: async (_root: string, id: string) => { if (!exists) throw new Error("missing"); return "/fixture/" + id + ".jsonl"; },
    sessionIdFromFile: (file: string) => file.slice("/fixture/".length, -".jsonl".length),
    readSessionCatalogRecord: async () => ({ createdAt: "2026-10-01", title: "fixture" }),
    stat: async () => { throw new Error("catalog fixture must avoid stat"); },
    readSessionSummary: async () => ({ createdAt: "2026-10-01", firstUserMessage: "fixture" }),
    readSessionEvents: async () => { reads++; if (readHook) await readHook(); return structuredClone(events); }
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as { desktop: Desktop; engine: Engine };
  const d = Object.create(prototypes.desktop) as Desktop;
  d.sources = new WeakMap();
  d.options = { state: { projects: () => projects }, projects: { dataRoot: async project => { roots++; return project.path; } } };
  const e = Object.create(prototypes.engine) as Engine;
  e.queue = []; e.closed = false; e.now = () => new Date("2026-10-12");
  e.store = {
    config: () => config, enabledAt: () => "2026-09-01", brief: id => rows.get(id),
    putBrief: row => { writes++; rows.set(row.sessionId, structuredClone(row)); },
    setError: () => { errors++; }, setConfig: value => { config = value; }, close: () => { closes++; }
  };
  e.options = {
    readThread: id => d.readThread(id), getModel: async () => ({}),
    canPersist: threads => d.canPersist ? d.canPersist(threads) : d.isVisibleSuggestion({ threads }),
    onChange: () => { changes++; }
  };
  e.ask = async () => { asks++; return structuredClone(answer); };
  e.suggest = async () => { suggestions++; };
  return {
    d, e, rows, setEvents(value: Event[]) { events = value; }, getEvents: () => structuredClone(events),
    setProjects(value: Project[]) { projects = value; }, remove() { exists = false; },
    onRead(hook?: () => Promise<void>) { readHook = hook; },
    counts: () => ({ reads, roots, writes, changes, errors, asks, suggestions, closes })
  };
}
type Outcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };
const observe = (promise: Promise<void>): Promise<Outcome> => promise.then(() => ({ status: "fulfilled" }), error => ({ status: "rejected", error }));
const switched = (): Event[] => [...initial(), { type: "message_version_selected", messageId: "old", slotId: "answer" }];
test("model wait branch switch discards A and settles queued B without touching manual state", async () => {
  const x = fixture(), entered = deferred<void>(), release = deferred<object>();
  const previous: Row = { sessionId: "A", contentHash: "previous", materialLength: 1, status: "done", statusManual: true, autoTodo: { what: "old preserved" } };
  x.rows.set("A", structuredClone(previous));
  let calls = 0;
  x.e.ask = async () => { if (++calls === 1) { entered.resolve(); return await release.promise; } return structuredClone(answer); };
  const a = observe(x.e.enqueue("A", true));
  await entered.promise;
  const b = observe(x.e.enqueue("B", true));
  x.setEvents(switched()); release.resolve(structuredClone(answer));
  assert.equal((await a).status, "fulfilled");
  assert.equal((await b).status, "fulfilled");
  await x.e.close();
  assert.deepEqual(x.rows.get("A"), previous);
  assert.ok(x.rows.has("B"));
  assert.equal(x.counts().writes, 1);
  assert.equal(x.counts().errors, 1, "only B clears the error");
  assert.equal(x.counts().changes, 1);
  assert.equal(x.counts().suggestions, 0);
  assert.equal(x.counts().closes, 1);
});
for (const kind of ["unchanged", "nonactive", "tool-only", "same-text-new-id", "deleted", "removed-project", "missing-project", "moved-project"] as const) {
  test("model wait: " + kind, async () => {
    const x = fixture(), entered = deferred<void>(), release = deferred<object>();
    x.e.ask = async () => { entered.resolve(); return await release.promise; };
    const pending = observe(x.e.enqueue("A", true));
    await entered.promise;
    const roots = x.counts().roots;
    if (kind === "nonactive") x.setEvents([...initial(), { type: "user_message", messageId: "inactive", parentMessageId: "old", content: "inactive" }, { type: "message_version_selected", messageId: "new", slotId: "answer" }]);
    if (kind === "same-text-new-id") x.setEvents([...initial(), { type: "agent_message", messageId: "copy", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "newer" }] } }]);
    if (kind === "tool-only") x.setEvents([...initial(), { type: "agent_message", messageId: "tool", parentMessageId: "new", message: { role: "toolResult", toolCallId: "call", toolName: "fixture", content: [{ type: "text", text: "diagnostic" }] } }]);
    if (kind === "deleted") x.remove();
    if (kind === "removed-project") x.setProjects([]);
    if (kind === "missing-project") x.setProjects([{ id: "project", path: "/fixture/project", missing: true }]);
    if (kind === "moved-project") x.setProjects([{ id: "project", path: "/fixture/other", missing: false }]);
    release.resolve(structuredClone(answer));
    assert.equal((await pending).status, "fulfilled");
    const success = kind === "unchanged" || kind === "nonactive" || kind === "tool-only";
    assert.equal(x.counts().writes, Number(success));
    assert.equal(x.counts().changes, Number(success));
    assert.equal(x.counts().errors, Number(success));
    assert.equal(x.counts().roots, roots, "final source guard must not initialize dataRoot");
    await x.e.close();
  });
}
for (const mode of ["abort", "close", "read-failure", "remove-during-read"] as const) {
  test("guard await: " + mode, async () => {
    const x = fixture(), entered = deferred<void>(), release = deferred<void>();
    x.e.ask = async () => {
      x.onRead(async () => { entered.resolve(); await release.promise; if (mode === "read-failure") throw new Error("read failed"); });
      return structuredClone(answer);
    };
    const pending = observe(x.e.enqueue("A", true));
    // Baseline has no freshness reread. Avoid waiting on a gate it cannot reach.
    if (!x.d.canPersist) {
      await pending; await x.e.close();
      assert.fail("missing final source reread");
    }
    await entered.promise;
    let closing: Promise<void> | undefined;
    if (mode === "abort") x.e.setConfig({ ...x.e.store.config(), enabled: false });
    if (mode === "close") closing = x.e.close();
    if (mode === "remove-during-read") x.setProjects([]);
    release.resolve();
    const result = await pending;
    assert.equal(result.status, mode === "remove-during-read" ? "fulfilled" : "rejected");
    assert.equal(x.counts().writes, 0);
    assert.equal(x.counts().errors, mode === "read-failure" ? 1 : 0);
    x.onRead();
    if (closing) await closing; else await x.e.close();
    assert.equal(x.counts().closes, 1);
  });
}
test("stored reference has no generation identity and keeps existing visibility policy", async () => {
  const x = fixture();
  const thread = await x.d.readThread("A"); assert.ok(thread);
  x.setEvents(switched());
  const reference = { ...thread };
  const before = x.counts();
  assert.equal(await x.e.options.canPersist([reference]), true);
  assert.equal(x.counts().reads, before.reads, "stored references must not re-read message content");
  assert.equal(x.counts().roots, before.roots + 1, "existing reference visibility policy retained");
  await x.e.close();
});

test("full source fingerprint detects changes after the model text cutoff", async () => {
  const x = fixture(), entered = deferred<void>(), release = deferred<object>();
  const source = initial();
  const last = source.at(-1)!; assert.equal(last.type, "agent_message");
  if (last.type !== "agent_message") throw new Error("fixture shape");
  last.message.content = [{ type: "text", text: "x".repeat(400) + "before" }];
  x.setEvents(source);
  x.e.ask = async () => { entered.resolve(); return await release.promise; };
  const pending = observe(x.e.enqueue("A", true));
  await entered.promise;
  last.message.content = [{ type: "text", text: "x".repeat(400) + "after" }];
  x.setEvents(source); release.resolve(structuredClone(answer));
  assert.equal((await pending).status, "fulfilled");
  assert.equal(x.counts().writes, 0);
  await x.e.close();
});

test("source reread failure rejects A but still drains and settles B", async () => {
  const x = fixture(), entered = deferred<void>(), release = deferred<void>();
  let calls = 0;
  x.e.ask = async () => {
    if (++calls === 1) x.onRead(async () => { x.onRead(); entered.resolve(); await release.promise; throw new Error("read failed"); });
    else x.onRead();
    return structuredClone(answer);
  };
  const a = observe(x.e.enqueue("A", true));
  if (!x.d.canPersist) { await a; await x.e.close(); assert.fail("missing final source reread"); }
  await entered.promise;
  const b = observe(x.e.enqueue("B", true));
  release.resolve();
  assert.equal((await a).status, "rejected");
  assert.equal((await b).status, "fulfilled");
  assert.equal(x.rows.has("A"), false);
  assert.equal(x.rows.has("B"), true);
  assert.equal(x.counts().writes, 1);
  assert.equal(x.counts().errors, 2);
  await x.e.close();
  assert.equal(x.counts().closes, 1);
});
