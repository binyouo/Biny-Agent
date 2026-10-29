/** Actual-source queue/transport regression; no product module, Host, provider or tool is started. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Selection = { tools: string | string[]; skills: string | string[] };
interface Item { messageId: string; input: string; attachments: object[]; capabilitySelection?: Selection }
interface Run { runId: string; sessionId: string; allowUserInput: boolean; capabilitySelection?: Selection }
interface Runtime {
  queuedMessages: Item[]; activeRun: Run; state: { kind: string }; closed: boolean;
  publishSnapshot(): void; startRun(...args: unknown[]): void;
  commandRuntime: { agent: { queueSteering(...args: unknown[]): Promise<void>; recordError(error: unknown): void } };
  enqueue(input: string, attachments?: object[], ids?: { messageId: string }, selection?: Selection): Promise<unknown>;
  steer(input: string, attachments?: object[], ids?: { messageId: string }, selection?: Selection): Promise<unknown>;
  updateQueuedRunMessage(id: string, input: string): Promise<void>;
  removeQueuedRunMessage(id: string): Promise<void>;
  moveQueuedRunMessage(id: string, target: string, after: boolean): Promise<void>;
  steerQueuedRunMessage(id: string): Promise<void>;
  startQueuedMessageRun(previous: Run): void;
}
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL("../src/" + file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}
function unique<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T, predicate: (node: T) => boolean): T {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => { if (guard(node) && predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(root); assert.equal(matches.length, 1); return matches[0]!;
}
function method(file: string, name: string): string {
  const ast = source(file);
  return unique(ast, ts.isMethodDeclaration, node => node.name.getText(ast) === name).getText(ast);
}
const runtimeFile = "runtime/InteractiveAgentRuntime.ts";
const methods = ["enqueue", "steer", "queueMessage", "requireQueuedMessage", "updateQueuedRunMessage", "removeQueuedRunMessage", "moveQueuedRunMessage", "steerQueuedRunMessage", "startQueuedMessageRun"];
const runtimeText = `class Runtime { ${methods.map(name => method(runtimeFile, name)).join("\n")} }`;
const managerText = `class Manager { ${method("desktop/electron/main/DesktopAgentManager.ts", "sendPromptOnce")} }`;
const clientText = `class Client { ${["queueRunMessage", "queueRunMessageForSession", "enqueue", "steer"].map(name => method("runtime/host/client.ts", name)).join("\n")} }`;
const host = source("runtime/host/server.ts");
const hostText = ["queue", "run.queue"].map((name, index) => {
  const clause = unique(host, ts.isCaseClause, node => ts.isStringLiteral(node.expression) && node.expression.text === name);
  return `async function host${index}(payload) { const runtime = this.runtime; const connection = {}; const admissionOperation = 'queue'; ${clause.statements.map(n => n.getText(host)).join("\n")} }`;
}).join("\n");
const code = [runtimeText, managerText, clientText, hostText, "({ Runtime, Manager, Client, host0, host1 })"].join("\n");
const audit = (node: ts.Node): void => {
  assert(!ts.isImportDeclaration(node)); assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isIdentifier(node)) assert(!["process", "require", "fetch", "eval", "Function"].includes(node.text));
  ts.forEachChild(node, audit);
};
audit(ts.createSourceFile("inert.ts", code, ts.ScriptTarget.Latest, true));
interface Client {
  focusedSessionId: string; currentRevision(): string; assertQueueable(): void;
  request(operation: string, payload: Record<string, unknown>): Promise<unknown>;
  queueRunMessage(input: string, delivery: string, attachments: object[], ids: object, selection: Selection): Promise<unknown>;
  enqueue(input: string, attachments: object[], ids: object, selection: Selection): Promise<unknown>;
  steer(input: string, attachments: object[], ids: object, selection: Selection): Promise<unknown>;
}
interface Manager {
  state: object; projects: object; draftSessionIds: Map<string, string>; runtimeForPrompt(): Promise<unknown>;
  sendPromptOnce(...args: unknown[]): Promise<unknown>;
}
interface Host {
  runtime: Runtime; assertRevision(): void; ensureSessionWriter(): Promise<void>; assertRequestAdmission(): void;
  executeAdmission(fn: () => Promise<unknown>): Promise<unknown>;
}
const extracted = runInNewContext(stripTypeScriptTypes(code, { mode: "strip" }), {
  isDeepStrictEqual, structuredClone, randomUUID: () => "generated", perfNow: () => 0,
  recordPerfPhase: () => {}, loadAgentAttachments: async () => [], runtimeIsBusy: () => true,
  errorFromHostOperation: () => new Error("unexpected rejection"), normalizeRequestIds: (ids: object) => ids,
  readRequestIds: (payload: { messageId?: string }) => ({ messageId: payload.messageId }),
  requiredString: (value: string) => value, readAttachments: (value: unknown) => value,
  readCapabilitySelection: (value: unknown) => value
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as {
  Runtime: new () => Runtime; Manager: new () => Manager; Client: new () => Client;
  host0(this: Host, payload: Record<string, unknown>): Promise<unknown>;
  host1(this: Host, payload: Record<string, unknown>): Promise<unknown>;
};
const all: Selection = { tools: "all", skills: "all" };
const none: Selection = { tools: "none", skills: "none" };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture(selection: Selection | undefined = all) {
  const runtime = new extracted.Runtime(); const calls: unknown[][] = []; const steering: unknown[][] = []; const errors: unknown[] = [];
  runtime.queuedMessages = []; runtime.closed = false; runtime.state = { kind: "runs" };
  runtime.activeRun = { runId: "initial", sessionId: "S", allowUserInput: true, capabilitySelection: selection };
  runtime.publishSnapshot = () => {}; runtime.startRun = (...args) => { calls.push(args); };
  runtime.commandRuntime = { agent: { queueSteering: async (...args) => { steering.push(args); }, recordError: error => { errors.push(error); } } };
  const enqueue = async (id: string, selected?: Selection) => await runtime.enqueue(id, [], { messageId: id }, selected);
  const start = () => runtime.startQueuedMessageRun(runtime.activeRun);
  return { runtime, calls, steering, errors, enqueue, start };
}

test("Desktop accepted next-turn none crosses actual manager, client, Host and runtime", async () => {
  const f = fixture(); const client = new extracted.Client(); client.focusedSessionId = "S"; client.currentRevision = () => "1";
  const host: Host = { runtime: f.runtime, assertRevision: () => {}, ensureSessionWriter: async () => {}, assertRequestAdmission: () => {}, executeAdmission: async fn => await fn() };
  client.request = async (_operation, payload) => ({ accepted: true, result: await extracted.host1.call(host, payload) });
  const manager = new extracted.Manager(); manager.state = { selectedSessionId: () => "S", setSelectedSession: async () => {} };
  manager.projects = { requireProject: () => ({ path: "/inert" }) }; manager.draftSessionIds = new Map();
  manager.runtimeForPrompt = async () => ({ managed: { runtime: client }, snapshot: { info: { sessionId: "S" } } });
  await manager.sendPromptOnce("P", "S", "queued", [], undefined, undefined, undefined, none, "message", false);
  f.start(); assert.deepEqual(plain(f.calls[0]?.[6]), none);
});
for (const operation of ["enqueue", "steer"] as const) test(`legacy client ${operation} transports explicit selection`, async () => {
  const f = fixture(none); const client = new extracted.Client(); client.focusedSessionId = "S"; client.currentRevision = () => "1"; client.assertQueueable = () => {};
  const host: Host = { runtime: f.runtime, assertRevision: () => {}, ensureSessionWriter: async () => {}, assertRequestAdmission: () => {}, executeAdmission: async fn => await fn() };
  let payloadSeen: Record<string, unknown> | undefined;
  client.request = async (_operation, payload) => { payloadSeen = payload; return await extracted.host0.call(host, payload); };
  await client[operation]("queued", [], { messageId: "q" }, none);
  assert.deepEqual(plain(payloadSeen?.capabilitySelection), none);
});
test("mixed adjacent selections form ordered batches without union", async () => {
  const f = fixture(); await f.enqueue("a", none); await f.enqueue("b", none); await f.enqueue("c", all); await f.enqueue("d", none);
  f.start(); assert.equal(f.calls[0]?.[0], "a\n\nb"); assert.deepEqual(plain(f.calls[0]?.[6]), none);
  f.start(); assert.equal(f.calls[1]?.[0], "c"); assert.deepEqual(plain(f.calls[1]?.[6]), all);
  f.start(); assert.equal(f.calls[2]?.[0], "d"); assert.equal(f.runtime.queuedMessages.length, 0);
});
test("selection arrays are captured, not shared with callers", async () => {
  const f = fixture(); const chosen = { tools: ["Read"], skills: ["review"] }; await f.enqueue("a", chosen);
  chosen.tools.push("Bash"); chosen.skills.length = 0; f.start(); assert.deepEqual(plain(f.calls[0]?.[6]), { tools: ["Read"], skills: ["review"] });
});
test("omitted selection inherits at admission, not after another batch", async () => {
  const f = fixture(); await f.enqueue("a", none); await f.enqueue("b"); f.start(); f.runtime.activeRun.capabilitySelection = none; f.start();
  assert.deepEqual(plain(f.calls[1]?.[6]), all);
});
test("legacy entries freeze before first mixed batch changes predecessor", async () => {
  const f = fixture(); await f.enqueue("a", none); f.runtime.queuedMessages.push({ messageId: "old", input: "old", attachments: [] });
  f.start(); f.runtime.activeRun.capabilitySelection = none; f.start(); assert.deepEqual(plain(f.calls[1]?.[6]), all);
});
test("synchronous start rejection restores exact order and choices", async () => {
  const f = fixture(); await f.enqueue("a", none); await f.enqueue("b", all); const before = plain(f.runtime.queuedMessages);
  f.runtime.startRun = () => { throw new Error("admission rejected"); }; f.start();
  assert.deepEqual(plain(f.runtime.queuedMessages), before); assert.equal(f.errors.length, 1);
  f.runtime.startRun = (...args) => { f.calls.push(args); }; f.start(); assert.equal(f.calls[0]?.[0], "a");
});
test("direct steering with different choices rejects without altering run", async () => {
  const f = fixture(); await assert.rejects(f.runtime.steer("q", [], { messageId: "q" }, none));
  assert.equal(f.steering.length, 0); assert.deepEqual(f.runtime.activeRun.capabilitySelection, all);
});
test("queued steering mismatch preserves item and same selection still works", async () => {
  const f = fixture(); await f.enqueue("a", none); await f.enqueue("b", all);
  await assert.rejects(f.runtime.steerQueuedRunMessage("a")); assert.equal(f.runtime.queuedMessages[0]?.messageId, "a");
  await f.runtime.steerQueuedRunMessage("b"); assert.equal(f.steering.length, 1); assert.equal(f.runtime.queuedMessages.length, 1);
});
test("failed compatible steering restores pending item", async () => {
  const f = fixture(); await f.enqueue("a", all); f.runtime.commandRuntime.agent.queueSteering = async () => { throw new Error("steer rejected"); };
  await assert.rejects(f.runtime.steerQueuedRunMessage("a")); assert.equal(f.runtime.queuedMessages[0]?.messageId, "a");
});
test("edit, reorder and remove retain item-specific capability selection", async () => {
  const f = fixture(); await f.enqueue("a", none); await f.enqueue("b", all); await f.enqueue("c", none);
  await f.runtime.updateQueuedRunMessage("a", "edited"); await f.runtime.moveQueuedRunMessage("c", "a", false); await f.runtime.removeQueuedRunMessage("b");
  f.start(); assert.equal(f.calls[0]?.[0], "c\n\nedited"); assert.deepEqual(plain(f.calls[0]?.[6]), none);
});
test("none, empty array, auto and all are not conflated", async () => {
  const f = fixture(); for (const [index, tools] of ["none", [], "auto", "all"].entries()) await f.enqueue(String(index), { tools, skills: "none" });
  for (let index = 0; index < 4; index += 1) { f.start(); assert.equal(f.calls[index]?.[0], String(index)); }
});
test("closed runtime leaves all queued input untouched", async () => {
  const f = fixture(); await f.enqueue("a", none); f.runtime.closed = true; f.start(); assert.equal(f.calls.length, 0); assert.equal(f.runtime.queuedMessages.length, 1);
});
