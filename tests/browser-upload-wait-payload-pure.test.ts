/** Actual command AST with inert Chrome API; no page expression or product module executes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Data = Record<string, unknown>;
type Input = Data & { tabId: number; selector?: string; timeoutMs?: number; files?: ReadonlyArray<Readonly<{ name: string; mimeType: string; data: string }>> };
type Frame = { frameId: string; contextId: number; documentId: string; sessionId?: string; url: string };
type Call = { method: string; target: Data; params: Data };
type PageCall = { operation: string; input: Data; target: Data; method: string; contextId?: unknown };
type State = { attached: Set<number>; dialogs: Set<number>; contexts: Map<number, Map<string, Frame>>; connected(): boolean };
type Api = {
  tabs: { get(id: number): Promise<Data>; query(): Promise<Data[]>; update(id: number, input: Data): Promise<Data> };
  debugger: { attach(target: Data, version: string): Promise<void>; detach(target: Data): Promise<void>; sendCommand(target: Data, method: string, params: Data): Promise<Data> };
};
type Command = (api: Api, command: { method: string; args: Input }, state: State) => Promise<unknown>;
const sourceRoot = process.env.BINY_UPLOAD_WAIT_SOURCE_ROOT ?? process.cwd();
const sourcePath = path.join(sourceRoot, "src/browser-extension/commands.js");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "performBrowserCommand");
assert.equal(declarations.length, 1);
const declaration = declarations[0]!;
assert.ok(declaration.body);
const forbidden = new Set(["process", "require", "fetch", "WebSocket", "XMLHttpRequest", "chrome", "eval", "Function", "globalThis"]);
const inspect = (node: ts.Node): void => {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node), "selected function must not import modules");
  if (ts.isIdentifier(node)) assert.ok(!forbidden.has(node.text), `unreviewed capability ${node.text}`);
  if (ts.isNewExpression(node)) assert.ok(["Error", "URL", "Promise"].includes(node.expression.getText(source)), "unreviewed constructor");
  ts.forEachChild(node, inspect);
};
inspect(declaration);
// Keep the entire actual function, including validation, routing, deadline and post-result guards.
const commandText = declaration.getText(source).replace(/^export\s+/u, "");
assert.ok(commandText.startsWith("async function performBrowserCommand("));
const pageSentinel = "function inertPageProgram() {}";
function record(value: unknown): Data {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Data;
}
function plain(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
function parsePageExpression(expression: unknown): { operation: string; input: Data } {
  assert.equal(typeof expression, "string");
  const parsed = ts.createSourceFile("captured-expression.js", expression as string, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.statements.length, 1);
  const statement = parsed.statements[0]!;
  assert.ok(ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression));
  const call = statement.expression;
  assert.equal(call.expression.getText(parsed), `(${pageSentinel})`);
  assert.equal(call.arguments.length, 2);
  const operation: unknown = JSON.parse(call.arguments[0]!.getText(parsed));
  assert.equal(typeof operation, "string");
  return { operation: operation as string, input: record(JSON.parse(call.arguments[1]!.getText(parsed))) };
}

function fixture(options: { frame?: Frame; frameCost?: number; disconnected?: boolean } = {}) {
  let connected = !options.disconnected;
  let clock = 1000;
  let url = "https://example.com/upload";
  const calls: Call[] = [];
  const pages: PageCall[] = [];
  const serializedFileCharacters: number[] = [];
  const contexts = new Map<number, Map<string, Frame>>([[1, new Map(options.frame ? [[options.frame.frameId, { ...options.frame }]] : [])]]);
  const state: State = { attached: new Set([1]), dialogs: new Set(), contexts, connected: () => connected };
  const hooks: { page?: (call: PageCall) => void; frame?: () => void; failWait?: Error; pageException?: string; failUpload?: Error } = {};
  const api: Api = {
    tabs: {
      get: async id => { assert.equal(id, 1); return { id, url }; },
      query: async () => [{ id: 1, windowId: 2, title: "Page", active: true, url }],
      update: async (id, input) => { assert.equal(id, 1); assert.equal(typeof input.url, "string"); url = input.url as string; return { id, url }; }
    },
    debugger: {
      attach: async () => { throw new Error("fixture forbids native attachment"); },
      detach: async () => { throw new Error("fixture forbids native detachment"); },
      sendCommand: async (target, method, params) => {
        calls.push({ method, target, params });
        if (method === "Page.getFrameTree") { clock += options.frameCost ?? 0; hooks.frame?.(); return { frameTree: { frame: { id: "main" } } }; }
        if (method === "DOM.resolveNode") return { object: { objectId: "object-42" } };
        if (method === "Runtime.releaseObject") return {};
        if (method.startsWith("Input.")) {
          assert.ok(["Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent"].includes(method));
          return {};
        }
        if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgo=" };
        assert.ok(method === "Runtime.evaluate" || method === "Runtime.callFunctionOn", `unexpected API: ${method}`);
        let decoded: { operation: string; input: Data };
        if (method === "Runtime.evaluate") decoded = parsePageExpression(params.expression);
        else {
          assert.equal(params.functionDeclaration, `function(operation,args) { return (${pageSentinel})(operation,args,this); }`);
          assert.ok(Array.isArray(params.arguments) && params.arguments.length === 2);
          const operation = record(params.arguments[0]).value;
          assert.equal(typeof operation, "string");
          decoded = { operation: operation as string, input: record(record(params.arguments[1]).value) };
        }
        assert.equal(params.returnByValue, true); assert.equal(params.awaitPromise, true);
        const call: PageCall = { ...decoded, target, method, contextId: params.contextId };
        pages.push(call);
        if (call.operation === "wait" && hooks.failWait) throw hooks.failWait;
        if (call.operation === "upload" && hooks.failUpload) throw hooks.failUpload;
        hooks.page?.(call);
        if (hooks.pageException) return { exceptionDetails: { text: hooks.pageException } };
        return { result: { value: call.operation === "wait" ? true : { x: 10, y: 20, count: 1 } } };
      }
    }
  };
  const context = vm.createContext({
    URL,
    Date: { now: () => clock },
    JSON: { stringify: (value: unknown) => {
      if (value && typeof value === "object" && Array.isArray(record(value).files)) {
        serializedFileCharacters.push((record(value).files as unknown[]).reduce<number>((size, file) => {
          const data = record(file).data; assert.equal(typeof data, "string"); return size + (data as string).length;
        }, 0));
      }
      return JSON.stringify(value);
    } },
    pageOperation: { toString: () => pageSentinel },
    setTimeout: () => { throw new Error("fixture forbids real timers"); }
  }, { codeGeneration: { strings: false, wasm: false } });
  const command = vm.runInContext(`${commandText}\nperformBrowserCommand;`, context, { timeout: 1000 }) as Command;
  return { state, calls, pages, hooks, serializedFileCharacters,
    disconnect: () => { connected = false; }, setUrl: (next: string) => { url = next; },
    run: (method: string, args: Input) => command(api, { method, args }, state) };
}
const files = Object.freeze([Object.freeze({ name: "report.txt", mimeType: "text/plain", data: "aGVsbG8=" })]);
const target = Object.freeze({ browserId: "00000000-0000-4000-8000-000000000000", tabId: 1 });
const child: Frame = { frameId: "child", contextId: 9, documentId: "document-a", sessionId: "child-session", url: "https://example.org/" };
function upload(overrides: Partial<Input> = {}): Input { return Object.freeze({ ...target, selector: "#file", files, ...overrides }); }
function operations(pages: PageCall[]): string[] { return pages.map(call => call.operation); }

test("ordinary upload waits with only locating fields and sends intact files once", async () => {
  const f = fixture(); const args = upload({ timeoutMs: 7000 }); const before = JSON.stringify(args);
  assert.deepEqual(plain(await f.run("upload", args)), { success: true, url: "https://example.com/upload" });
  assert.deepEqual(operations(f.pages), ["wait", "upload"]);
  assert.deepEqual(plain(f.pages[0]!.input), { selector: "#file", state: "attached", timeoutMs: 7000 });
  assert.deepEqual(plain(f.pages[1]!.input), plain(args));
  assert.deepEqual(f.serializedFileCharacters, [8]);
  assert.equal(JSON.stringify(args), before);
  assert.ok(f.pages.every(call => call.method === "Runtime.evaluate"));
});

test("legal 8 MiB file has one base64-bearing serialization, independent of wait cost", async () => {
  const rawBytes = 8 * 1024 * 1024; const encodedCharacters = 4 * Math.ceil(rawBytes / 3);
  assert.equal(encodedCharacters, 11184812); assert.ok(encodedCharacters < 12 * 1024 * 1024);
  const data = "A".repeat(encodedCharacters - 1) + "=";
  const args = upload({ files: [{ name: "large.bin", mimeType: "application/octet-stream", data }] });
  assert.ok(JSON.stringify({ method: "upload", args }).length < 13 * 1024 * 1024);
  const f = fixture(); await f.run("upload", args);
  assert.equal(record((f.pages[1]!.input.files as unknown[])[0]).data, data);
  assert.deepEqual(f.serializedFileCharacters, [encodedCharacters]);
  assert.equal(JSON.stringify(f.pages[0]!.input).includes(data), false);
});

test("backend upload retains child routing, object release, and complete upload identity", async () => {
  const f = fixture({ frame: child });
  const args = upload({ selector: "backend=42", frameId: child.frameId, documentId: child.documentId });
  await f.run("upload", args);
  assert.deepEqual(operations(f.pages), ["wait", "upload"]);
  assert.deepEqual(plain(f.pages[0]!.input), { selector: "backend=42", state: "attached", timeoutMs: 5000 });
  assert.equal(f.pages[1]!.input, args);
  assert.ok(f.pages.every(call => call.method === "Runtime.callFunctionOn"));
  assert.ok(f.pages.every(call => JSON.stringify(call.target) === JSON.stringify({ tabId: 1, sessionId: child.sessionId })));
  assert.deepEqual(f.calls.filter(call => call.method === "DOM.resolveNode").map(call => plain(call.params)), [
    { backendNodeId: 42, executionContextId: 9 }, { backendNodeId: 42, executionContextId: 9 }
  ]);
  assert.equal(f.calls.filter(call => call.method === "Runtime.releaseObject").length, 2);
  assert.deepEqual(f.serializedFileCharacters, [8]);
});

test("ordinary child selector retains context and session targets despite small wait input", async () => {
  const f = fixture({ frame: child }); const args = upload({ frameId: child.frameId, documentId: child.documentId });
  await f.run("upload", args);
  assert.ok(f.pages.every(call => call.contextId === 9 && call.target.sessionId === child.sessionId));
  assert.deepEqual(plain(f.pages[0]!.input), { selector: "#file", state: "attached", timeoutMs: 5000 });
  assert.deepEqual(plain(f.pages[1]!.input), plain(args));
});

test("wait transport errors retain identity and cannot dispatch upload", async () => {
  for (const backend of [false, true]) {
    const f = fixture(backend ? { frame: child } : {}); const failure = new Error("wait failed"); f.hooks.failWait = failure;
    const args = upload(backend ? { selector: "backend=42", frameId: child.frameId, documentId: child.documentId } : {});
    await assert.rejects(f.run("upload", args), (error: unknown) => error === failure);
    assert.deepEqual(operations(f.pages), ["wait"]);
    assert.equal(f.calls.filter(call => call.method === "Runtime.releaseObject").length, backend ? 1 : 0);
  }
});

test("page wait exceptions stop before upload and preserve the reported reason", async () => {
  const f = fixture(); f.hooks.pageException = "input missing";
  await assert.rejects(f.run("upload", upload()), /input missing/u);
  assert.deepEqual(operations(f.pages), ["wait"]);
});

test("connection loss after wait prevents upload", async () => {
  const f = fixture(); f.hooks.page = call => { if (call.operation === "wait") f.disconnect(); };
  await assert.rejects(f.run("upload", upload()), /中断/u);
  assert.deepEqual(operations(f.pages), ["wait"]);
});

test("child document replacement after wait prevents upload", async () => {
  const f = fixture({ frame: child });
  f.hooks.page = call => { if (call.operation === "wait") f.state.contexts.get(1)!.set(child.frameId, { ...child, documentId: "replacement" }); };
  await assert.rejects(f.run("upload", upload({ frameId: child.frameId, documentId: child.documentId })), /文档已变化/u);
  assert.deepEqual(operations(f.pages), ["wait"]);
});

test("stale documents and unbound backend references fail before page dispatch", async () => {
  const f = fixture({ frame: child });
  await assert.rejects(f.run("upload", upload({ frameId: child.frameId, documentId: "old" })), /文档已变化/u);
  assert.deepEqual(f.pages, []);
  const unbound = fixture();
  await assert.rejects(unbound.run("upload", upload({ selector: "backend=42" })), /文档/u);
  assert.deepEqual(unbound.pages, []);
});

test("deadline clipping, default wait, explicit zero and exhausted time remain unchanged", async () => {
  for (const [timeoutMs, frameCost, expected] of [[undefined, 0, 5000], [undefined, 7000, 1000], [6000, 1500, 4500], [0, 0, 0], [100, 200, 0]] as const) {
    const f = fixture({ frameCost }); await f.run("upload", upload({ timeoutMs }));
    assert.equal(f.pages[0]!.input.timeoutMs, expected);
    assert.deepEqual(Object.keys(f.pages[0]!.input).sort(), ["selector", "state", "timeoutMs"]);
  }
});

test("invalid upload and disconnected requests do not dispatch page operations", async () => {
  for (const args of [upload({ files: [] }), upload({ selector: "" }), upload({ timeoutMs: 8001 }), upload({ files: [{ name: "bad/name", mimeType: "text/plain", data: "AA==" }] })]) {
    const f = fixture(); await assert.rejects(f.run("upload", args)); assert.deepEqual(f.pages, []);
  }
  const f = fixture({ disconnected: true }); await assert.rejects(f.run("upload", upload()), /中断/u); assert.deepEqual(f.calls, []);
});

test("upload error identity and exactly one upload command dispatch remain unchanged", async () => {
  const f = fixture(); const failure = new Error("upload failed"); f.hooks.failUpload = failure;
  await assert.rejects(f.run("upload", upload()), (error: unknown) => error === failure);
  assert.deepEqual(operations(f.pages), ["wait", "upload"]);
});

test("non-upload fill retains full input through attached, reveal, visible and fill", async () => {
  const f = fixture(); const args = { ...target, selector: "#text", value: "hello", timeoutMs: 4000 };
  await f.run("fill", args);
  assert.deepEqual(operations(f.pages), ["wait", "reveal", "wait", "fill"]);
  assert.deepEqual(f.pages.map(call => plain(call.input)), [
    { ...args, state: "attached" }, args, { ...args, state: "visible" }, args
  ]);
  assert.deepEqual(f.calls.filter(call => call.method === "Input.insertText").map(call => plain(call.params)), [{ text: "hello" }]);
});

test("standalone wait and selector-free press keep existing command paths", async () => {
  const waiting = fixture(); const args = { ...target, selector: "#ready", state: "visible", timeoutMs: 2000 };
  await waiting.run("wait", args); assert.deepEqual(plain(waiting.pages[0]!.input), args);
  const pressing = fixture(); await pressing.run("press", { ...target, key: "Escape" });
  assert.deepEqual(pressing.pages, []);
  assert.deepEqual(pressing.calls.map(call => call.method), ["Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
});
