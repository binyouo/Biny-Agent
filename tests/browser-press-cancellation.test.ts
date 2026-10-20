import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read product code as text only; no product imports or original constructor run.
// These tests exercise selected real methods against in-memory socket/CDP fakes.
const file = ts.createSourceFile("DesktopBrowserService.ts", readFileSync(new URL("../src/desktop/electron/main/DesktopBrowserService.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const owners = file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopBrowserService");
assert.equal(owners.length, 1);
const names = ["handleAutomationRequest", "enqueueAutomation", "executeAutomation", "ensureContents", "press", "evaluate", "sendDebuggerCommand", "pageState"];
const methods = names.map((name) => {
  const matches = owners[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
  assert.equal(matches.length, 1, name);
  assert.ok(matches[0]!.body);
  return matches[0]!;
});
const helpers = ["asRecord", "readString"].map((name) => {
  const matches = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, name);
  assert.ok(matches[0]!.body);
  return matches[0]!;
});
// Closed, receiver-specific call inventory. No computed calls or dynamic imports.
const callees = new Set([
  "asRecord", "JSON.parse", "readString", "controller.abort", "socket.once",
  "method.startsWith", "this.computerUse", "this.enqueueAutomation", "controller.signal.throwIfAborted",
  "this.readWebPage", "this.executeAutomation", "this.ensureContents", "this.previewActivity",
  "contents.getTitle", "contents.isDestroyed", "owner.isDestroyed", "contents.capturePage",
  "(await contents.capturePage()).resize", "(await contents.capturePage()).resize({ width: 1024 }).toJPEG",
  "image.toString", "console.error", "socket.off", "socket.write", "JSON.stringify", "String",
  "this.automationTail.then", "run.then", "isHttpUrl", "this.open", "this.openPage", "this.pageState",
  "this.readDom", "readNumber", "this.click", "this.fill", "this.press",
  "this.embeddedProjects.get", "this.embeddedProjects.get(shown.projectId)?.tabs.get",
  "this.browserEnvironments.list", "this.browserEnvironments.list().map", "this.browserEnvironments.get",
  "this.embeddedProjects.get(projectId)?.tabs.get", "this.prepareBrowserEnvironment",
  "this.desktopWindow.isDestroyed", "this.browserAction", "tab.view.webContents.isDestroyed",
  "tab.view.webContents.loadURL", "this.openInEnvironmentWindow", "this.automationContents.isDestroyed",
  "this.environmentWindows.values", "[...this.environmentWindows.values()].find", "window.isDestroyed",
  "embedded.view.webContents.isDestroyed", "this.window.isDestroyed", "this.evaluate",
  "this.sendDebuggerCommand", "Object.keys", "signal?.throwIfAborted",
  "debuggerSession.isAttached", "debuggerSession.attach", "debuggerSession.sendCommand", "value.trim"
]);
function audit(node: ts.Node): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword, "No dynamic imports in extracted code");
  if (ts.isNewExpression(node)) assert.ok(["Error", "AbortController"].includes(node.expression.getText(file)), "Unexpected construction");
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(file);
    const literalIncludes = ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "includes" && ts.isArrayLiteralExpression(node.expression.expression)
      && node.expression.expression.elements.every(ts.isStringLiteral);
    assert.ok(callees.has(callee) || literalIncludes, `Unexpected extracted call: ${callee}`);
  }
  ts.forEachChild(node, audit);
}
for (const node of [...methods, ...helpers]) audit(node);
const code = `class Subject {\n${methods.map(node => node.getText(file)).join("\n")}\n}\n${helpers.map(node => node.getText(file)).join("\n")}\nSubject;`;
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true }, reportDiagnostics: true });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Command { method: string; params: Record<string, unknown> }
interface Contents { isDestroyed(): boolean; debugger: { isAttached(): boolean; attach(version: string): void; sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> } }
interface Response { ok: boolean; error?: string }
interface Socket { once(name: string, listener: () => void): void; off(name: string, listener: () => void): void; write(value: string): void }
interface Subject {
  automationTail: Promise<void>;
  window?: { isDestroyed(): boolean; webContents: Contents };
  automationContents?: Contents;
  environmentWindows: Map<string, { isDestroyed(): boolean; webContents: Contents }>;
  embeddedProjects: Map<string, never>;
  previewActivity: undefined;
  computerUse: undefined;
  ensureContents(): Promise<Contents>;
  handleAutomationRequest(line: string, token: string, socket: Socket): Promise<void>;
  press(selector: string | undefined, key: string, signal?: AbortSignal): Promise<unknown>;
}
interface SubjectConstructor { new(): Subject }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
interface Options { pause?: "focus" | "keyDown"; pauseEnsureCall?: number; focusException?: boolean; key?: string; closeOnAttach?: boolean; target?: "automation" | "environment" }
function fixture(options: Options = {}) {
  const SubjectClass = runInNewContext(compiled.outputText, {
    AbortController, ToolOutcomeUnknownError: class ToolOutcomeUnknownError extends Error {}
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as SubjectConstructor;
  const subject = new SubjectClass();
  const events: string[] = [], commands: Command[] = [], responses: Response[] = [];
  const reached = deferred(), release = deferred();
  const listeners = new Map<string, Set<() => void>>();
  // Plain memory object: no real net.Socket, Electron, or EventEmitter instance.
  const socket: Socket = {
    once(name, listener) { const set = listeners.get(name) ?? new Set<() => void>(); set.add(listener); listeners.set(name, set); },
    off(name, listener) { listeners.get(name)?.delete(listener); },
    write(value) { responses.push(JSON.parse(value) as Response); }
  };
  const close = (): void => { const current = [...(listeners.get("close") ?? [])]; listeners.delete("close"); for (const listener of current) listener(); };
  const listenerCount = (): number => [...listeners.values()].reduce((count, set) => count + set.size, 0);
  const contents: Contents = { isDestroyed: () => false, debugger: {
    isAttached: () => !options.closeOnAttach,
    attach(version) {
      assert.equal(version, "1.3");
      assert.equal(options.closeOnAttach, true);
      events.push("attach"); close();
    },
    async sendCommand(method, params) {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        assert.equal(typeof params.expression, "string");
        const expression = params.expression as string;
        if (expression.includes("element.focus()")) {
          events.push("focus");
          if (options.pause === "focus") { reached.resolve(); await release.promise; }
          return options.focusException ? { exceptionDetails: { text: "fixture focus failed" } } : { result: { value: undefined } };
        }
        assert.equal(expression, "({ url: location.href, title: document.title })");
        events.push("state");
        return { result: { value: { url: "https://example.invalid/", title: "Fixture" } } };
      }
      assert.equal(method, "Input.dispatchKeyEvent");
      assert.ok(params.type === "keyDown" || params.type === "keyUp");
      assert.equal(params.key, options.key ?? "Enter");
      events.push(params.type);
      if (params.type === "keyDown" && options.pause === "keyDown") { reached.resolve(); await release.promise; }
      return {};
    }
  } };
  subject.window = { isDestroyed: () => false, webContents: contents };
  subject.environmentWindows = new Map();
  if (options.target === "automation") {
    subject.automationContents = contents;
    subject.window = undefined;
  } else if (options.target === "environment") {
    subject.environmentWindows.set("fixture", subject.window);
    subject.window = undefined;
  }
  subject.embeddedProjects = new Map<string, never>();
  subject.automationTail = Promise.resolve();
  subject.previewActivity = undefined;
  subject.computerUse = undefined;
  // Only explicit guard-placement tests insert artificial preparation latency.
  // Production ensureContents currently resolves synchronously; this wrapper
  // does not establish a real socket-close opportunity at that production point.
  if (options.pauseEnsureCall !== undefined) {
    const realEnsure = subject.ensureContents;
    let calls = 0;
    subject.ensureContents = async (): Promise<Contents> => {
      if (++calls === options.pauseEnsureCall) { reached.resolve(); await release.promise; }
      return await realEnsure.call(subject);
    };
  }
  const request = (selector: string | undefined = "#search"): Promise<void> => subject.handleAutomationRequest(JSON.stringify({
    id: "fixture", token: "fixture-token", method: "press", args: { selector, key: options.key ?? "Enter" }
  }), "fixture-token", socket);
  const noSelectorRequest = (): Promise<void> => subject.handleAutomationRequest(JSON.stringify({
    id: "fixture", token: "fixture-token", method: "press", args: { key: options.key ?? "Enter" }
  }), "fixture-token", socket);
  return { subject, request, noSelectorRequest, events, commands, responses, close, listenerCount, reached, release };
}
const testOptions = { timeout: 5000 };

test("final dispatch guard observes cancellation from an inert attach callback", testOptions, async () => {
  // This deliberately synchronous fake callback verifies guard placement only;
  // it does not claim that real debugger attachment causes cancellation.
  const f = fixture({ closeOnAttach: true }); await f.request();
  assert.deepEqual(f.events, ["attach"]);
  assert.equal(f.commands.length, 0);
  assert.equal(f.responses[0]?.ok, false);
  assert.equal(f.listenerCount(), 0);
});

test("socket close while focus CDP response is pending prevents later keyDown", testOptions, async () => {
  const f = fixture({ pause: "focus" }); const run = f.request();
  await f.reached.promise;
  assert.deepEqual(f.events, ["focus"]);
  f.close(); f.release.resolve(); await run;
  assert.deepEqual(f.events, ["focus"]);
  assert.equal(f.responses[0]?.ok, false);
  assert.equal(f.listenerCount(), 0);
});

for (const target of ["automation", "environment"] as const) {
  test(`socket close prevents keyDown for current ${target} contents`, testOptions, async () => {
    const f = fixture({ target, pause: "focus" }); const run = f.request();
    await f.reached.promise;
    assert.deepEqual(f.events, ["focus"]);
    f.close(); f.release.resolve(); await run;
    assert.deepEqual(f.events, ["focus"]);
    assert.equal(f.responses[0]?.ok, false);
    assert.equal(f.listenerCount(), 0);
  });
}

for (const selector of [true, false]) {
  test(`guard after artificial keyDown ensureContents wait, selector=${selector}`, testOptions, async () => {
    const f = fixture({ pauseEnsureCall: selector ? 3 : 2 });
    const run = selector ? f.request() : f.noSelectorRequest();
    await f.reached.promise;
    assert.deepEqual(f.events, selector ? ["focus"] : []);
    f.close(); f.release.resolve(); await run;
    assert.deepEqual(f.events, selector ? ["focus"] : []);
    assert.equal(f.responses[0]?.ok, false);
    assert.equal(f.listenerCount(), 0);
  });
}

test("guard after artificial focus ensureContents wait prevents focus dispatch", testOptions, async () => {
  const f = fixture({ pauseEnsureCall: 2 }); const run = f.request();
  await f.reached.promise;
  assert.deepEqual(f.events, []);
  f.close(); f.release.resolve(); await run;
  assert.deepEqual(f.events, []);
  assert.equal(f.responses[0]?.ok, false);
  assert.equal(f.listenerCount(), 0);
});

test("keyDown already dispatched before close still completes keyUp cleanup", testOptions, async () => {
  const f = fixture({ pause: "keyDown" }); const run = f.request();
  await f.reached.promise;
  assert.deepEqual(f.events, ["focus", "keyDown"]);
  f.close(); f.release.resolve(); await run;
  assert.deepEqual(f.events, ["focus", "keyDown", "keyUp", "state"]);
  assert.equal(f.responses[0]?.ok, true); // A fake recording, not delivery over a closed socket.
  assert.equal(f.listenerCount(), 0);
});

for (const key of ["Enter", "x"]) {
  for (const selector of [true, false]) {
    test(`normal press key=${key} selector=${selector}`, testOptions, async () => {
      const f = fixture({ key }); await (selector ? f.request() : f.noSelectorRequest());
      assert.deepEqual(f.events, selector ? ["focus", "keyDown", "keyUp", "state"] : ["keyDown", "keyUp", "state"]);
      const down = f.commands.find(command => command.params.type === "keyDown");
      assert.equal(down?.params.text, key.length === 1 ? key : undefined);
      assert.equal(f.responses[0]?.ok, true);
      assert.equal(f.listenerCount(), 0);
    });
  }
}

test("focus exceptionDetails propagates without dispatching keys", testOptions, async () => {
  const f = fixture({ focusException: true }); await f.request();
  assert.deepEqual(f.events, ["focus"]);
  assert.equal(f.responses[0]?.ok, false);
  assert.match(f.responses[0]?.error ?? "", /fixture focus failed/);
  assert.equal(f.listenerCount(), 0);
});

test("close before queued callback prevents all commands and removes listener", testOptions, async () => {
  const f = fixture(), gate = deferred(); f.subject.automationTail = gate.promise;
  const run = f.request(); f.close(); gate.resolve(); await run;
  assert.deepEqual(f.events, []);
  assert.equal(f.responses[0]?.ok, false);
  assert.equal(f.listenerCount(), 0);
});

for (const selector of ["#search", undefined]) {
  test(`already-aborted direct press has no dispatch, selector=${String(selector)}`, testOptions, async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(f.subject.press(selector, "Enter", controller.signal));
    assert.deepEqual(f.events, []);
    assert.equal(f.listenerCount(), 0);
  });
}

test("legacy direct press omitting optional signal remains valid", testOptions, async () => {
  const f = fixture(); await f.subject.press("#search", "Enter");
  assert.deepEqual(f.events, ["focus", "keyDown", "keyUp", "state"]);
  assert.equal(f.listenerCount(), 0);
});
