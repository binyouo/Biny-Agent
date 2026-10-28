/** Actual request control flow with inert transport/schema boundaries; no server or browser. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const readSource = (name: string): ts.SourceFile => ts.createSourceFile(name,
  readFileSync(path.join(process.cwd(), name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const relaySource = readSource("src/browser/BrowserRelay.ts");
const relayClass = relaySource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "BrowserRelay");
assert.ok(relayClass);
const request = relayClass.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "request");
assert.ok(request);
const protocolSource = readSource("src/browser/relayProtocol.ts");
const mutation = protocolSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "isRelayMutation");
const relayError = protocolSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "BrowserRelayError");
assert.ok(mutation); assert.ok(relayError);
const allowedCalls = new Set([
  "relaySchemas[method].parse", "signal?.throwIfAborted", "this.status", "Promise.all", "browsers.map", "this.request", "this.connections.get",
  "randomUUID", "isRelayMutation", "resolve", "complete", "clearTimeout", "signal?.removeEventListener", "reject", "finish", "failure",
  "connection.socket.terminate", "setTimeout", "signal?.addEventListener", "connection.socket.send", "JSON.stringify", "abort",
  "z.array(relayTabSchema).max(1000).parse", "z.array(relayTabSchema).max", "z.array", "relayBinarySchema.parse", "relayPageSchema.parse", "relayOpenedTabSchema.parse",
  "z.object({ success: z.literal(true), url: relayTabSchema.shape.url }).safeParse", "z.object", "z.literal", "this.activity", "console.error", "super"
]);
function check(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const target = node.expression.getText();
    assert.ok(allowedCalls.has(target)
      || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "includes" && ts.isArrayLiteralExpression(node.expression.expression),
    `Unreviewed handoff call: ${target}`);
  }
  if (ts.isNewExpression(node)) assert.ok(["Promise", "BrowserRelayError"].includes(node.expression.getText()));
  ts.forEachChild(node, check);
}
check(request); check(mutation); check(relayError);
const source = [relayError.getText(protocolSource).replace(/^export\s+/u, ""), mutation.getText(protocolSource).replace(/^export\s+/u, ""),
  `class ExtractedRelay { ${request.getText(relaySource)} }`, "globalThis.api = { ExtractedRelay, BrowserRelayError };"].join("\n");
assert.equal(/createServer|WebSocketServer|authenticated|pairingUrl|handleHttp|private async save|private attach/u.test(source), false);
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(|\beval\s*\(/u.test(emitted.outputText), false);

type Method = "click" | "read" | "screenshot";
interface Pending { preview: boolean; completed: Promise<void>; resolve(value: unknown): void; reject(error: Error): void }
interface Socket {
  readyState: number;
  send(value: string, callback: (error?: Error) => void): void;
  terminate(): void;
}
interface Connection { id: string; name: string; socket: Socket; pending?: Pending }
interface Relay {
  connections: Map<string, Connection>;
  timeoutMs: number;
  request(method: Method, input: { browserId: string; tabId: number }, signal?: AbortSignal, sessionId?: string, preview?: boolean): Promise<unknown>;
}
interface Api {
  ExtractedRelay: new() => Relay;
  BrowserRelayError: new(code: string, message: string) => Error & { code: string };
}
function fixture() {
  const timers = new Map<number, () => void>(); let timerId = 0; let requestId = 0;
  const identity = { parse: (value: unknown): unknown => value };
  const context = createContext({
    relaySchemas: { click: identity, read: identity, screenshot: identity },
    relayBinarySchema: identity, relayPageSchema: identity, relayOpenedTabSchema: identity, relayTabSchema: { shape: { url: "inert" } },
    z: { literal: (value: unknown): unknown => value, object: () => ({ safeParse: (value: unknown) => ({ success: true, data: value }) }) },
    randomUUID: () => `request-${++requestId}`, WebSocket: { OPEN: 1 },
    setTimeout: (callback: () => void): number => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number): void => { timers.delete(id); },
    console: { error: (): never => { throw new Error("No activity notification in this fixture"); } }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  const api = context.api as Api;
  const sends: string[] = []; const delivered: string[] = []; let terminations = 0;
  const socket: Socket = {
    readyState: 1,
    send(value, callback) {
      sends.push(value);
      if (socket.readyState !== 1) { queueMicrotask(() => callback(new Error("closed socket"))); return; }
      delivered.push(value); callback();
    },
    terminate() { terminations += 1; socket.readyState = 2; }
  };
  const connection: Connection = { id: "synthetic-browser", name: "Synthetic browser", socket };
  const relay = new api.ExtractedRelay();
  relay.connections = new Map([[connection.id, connection]]); relay.timeoutMs = 15000;
  const target = { browserId: connection.id, tabId: 7 };
  const run = (method: Method = "click", signal?: AbortSignal, preview = false) => relay.request(method, target, signal, undefined, preview);
  const outcome = (promise: Promise<unknown>) => promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error: error as Error & { code?: string } }));
  const preview = () => {
    const result = outcome(run("screenshot", undefined, true));
    const pending = connection.pending; assert.ok(pending);
    return { result, pending };
  };
  const finish = (value: unknown = { success: true, url: "https://example.test/" }): void => { assert.ok(connection.pending); connection.pending.resolve(value); };
  return { relay, socket, connection, target, run, outcome, preview, finish, timers, sends, delivered, api,
    terminations: () => terminations };
}
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

test("successful preview hands off once to the original open connection", async () => {
  const f = fixture(), frame = f.preview(), action = f.outcome(f.run());
  assert.equal(f.sends.length, 1);
  frame.pending.resolve({ mimeType: "image/png", data: "eA==" });
  await frame.result; await flush();
  assert.equal(f.sends.length, 2); assert.equal(f.delivered.length, 2);
  f.finish(); assert.equal((await action).error, undefined); assert.equal(f.timers.size, 0);
});
for (const method of ["click", "read"] as const) {
  for (const transition of ["closed", "removed", "replaced"] as const) {
    test(`${method} is not dispatched after preview connection is ${transition}`, async () => {
      const f = fixture(), frame = f.preview(), action = f.outcome(f.run(method));
      if (transition === "closed") f.socket.readyState = 3;
      else if (transition === "removed") f.relay.connections.delete(f.connection.id);
      else f.relay.connections.set(f.connection.id, { ...f.connection, pending: undefined });
      frame.pending.reject(new f.api.BrowserRelayError("unavailable", "synthetic preview ended"));
      await frame.result; await flush();
      // The old implementation can dispatch on a stale-but-open object. Settle it
      // so the regression is an assertion failure rather than a hanging fixture.
      if (f.connection.pending) f.finish();
      const result = await action;
      assert.equal(result.error?.code, "invalid");
      assert.equal(f.sends.length, 1); assert.equal(f.delivered.length, 1);
      assert.equal(f.timers.size, 0);
    });
  }
}
test("actual preview timeout retires the connection before a waiting mutation", async () => {
  const f = fixture(), frame = f.preview(), action = f.outcome(f.run());
  const timeout = [...f.timers.values()][0]; assert.ok(timeout); timeout();
  await frame.result;
  const result = await action;
  assert.equal(result.error?.code, "invalid"); assert.equal(f.sends.length, 1);
  assert.equal(f.delivered.length, 1); assert.equal(f.terminations(), 1); assert.equal(f.timers.size, 0);
});
test("a new pending request after preview retains busy classification", async () => {
  const f = fixture(), frame = f.preview(), action = f.outcome(f.run());
  frame.pending.resolve({});
  const competitor = f.outcome(f.run("read"));
  await frame.result;
  assert.equal((await action).error?.code, "busy"); assert.equal(f.sends.length, 2);
  f.finish({ text: "inert" }); await competitor; assert.equal(f.timers.size, 0);
});
test("cancellation observed after waiting prevents dispatch without cancelling the preview", async () => {
  const f = fixture(), frame = f.preview(), controller = new AbortController();
  const action = f.outcome(f.run("click", controller.signal));
  const reason = new Error("synthetic caller cancellation"); controller.abort(reason);
  frame.pending.resolve({}); await frame.result;
  assert.equal((await action).error, reason); assert.equal(f.sends.length, 1); assert.equal(f.terminations(), 0);
});
for (const method of ["click", "read"] as const) {
  test(`already dispatched ${method} keeps its existing timeout classification`, async () => {
    const f = fixture(), action = f.outcome(f.run(method));
    assert.equal(f.delivered.length, 1);
    const timeout = [...f.timers.values()][0]; assert.ok(timeout); timeout();
    assert.equal((await action).error?.code, method === "click" ? "unknown" : "unavailable");
    assert.equal(f.sends.length, 1); assert.equal(f.terminations(), 1); assert.equal(f.timers.size, 0);
  });
}
test("preview failure while the same connection remains open permits the next operation", async () => {
  const f = fixture(), frame = f.preview(), action = f.outcome(f.run());
  frame.pending.reject(new f.api.BrowserRelayError("invalid", "synthetic screenshot failure"));
  await frame.result; await flush();
  assert.equal(f.delivered.length, 2); f.finish(); assert.equal((await action).error, undefined);
});
