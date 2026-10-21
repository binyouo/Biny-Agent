import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// Exercise the real service; Electron, socket and CDP are external boundaries.
const hooks = registerHooks({ load(url, context, next) {
  if (/\/electron\/index\.js$/u.test(url)) return { format: "module", shortCircuit: true,
    source: "export class BrowserWindow {} export class WebContentsView {} export const clipboard = {}; export const session = {};" };
  return next(url, context);
} });
const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
hooks.deregister();

interface Command { method: string; params: Record<string, unknown> }
interface Contents { isDestroyed(): boolean; debugger: { isAttached(): boolean; attach(version: string): void; sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> } }
interface Response { ok: boolean; error?: string; result?: { url: string; title: string } }
interface EmbeddedTab { view: { webContents: Contents; setVisible(visible: boolean): void }; state: { id: string; environmentId: string }; navigation: number; inspection: number }
interface EmbeddedProject { revision: number; tabs: Map<string, EmbeddedTab>; activeId?: string }
interface BrowserSnapshot { activeId?: string; tabs: { id: string }[] }
interface Socket { once(name: string, listener: () => void): void; off(name: string, listener: () => void): void; write(value: string): void }
interface Subject {
  automationTail: Promise<void>;
  window?: { isDestroyed(): boolean; webContents: Contents };
  automationContents?: Contents;
  environmentWindows: Map<string, { isDestroyed(): boolean; webContents: Contents }>;
  embeddedProjects: Map<string, EmbeddedProject>;
  desktopWindow?: { isDestroyed(): boolean; contentView: { removeChildView(view: EmbeddedTab["view"]): void }; webContents: { send(channel: string, state: BrowserSnapshot): void } };
  browserAction(projectId: string, action: { type: "select" | "close"; tabId: string }): BrowserSnapshot;
  previewActivity: undefined;
  computerUse: undefined;
  ensureContents(owner?: Contents): Promise<Contents>;
  handleAutomationRequest(line: string, token: string, socket: Socket): Promise<void>;
  press(selector: string | undefined, key: string, signal?: AbortSignal): Promise<unknown>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
interface Options { pause?: "focus" | "keyDown"; pauseEnsureCall?: number; focusException?: boolean; key?: string; closeOnAttach?: boolean; target?: "automation" | "environment" }
function fixture(options: Options = {}) {
  const subject = new DesktopBrowserService(async () => "unused-cookie-jar.json") as unknown as Subject;
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
    subject.ensureContents = async (owner?: Contents): Promise<Contents> => {
      if (++calls === options.pauseEnsureCall) { reached.resolve(); await release.promise; }
      return await realEnsure.call(subject, owner);
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

// These gates pause the real sendDebuggerCommand -> debugger.sendCommand await,
// not service preparation. User select/close runs through real browserAction,
// outside the automation queue. No real Electron, sockets or page scripts run.
type PressStage = "focus" | "keyDown" | "keyUp";
function ownershipFixture(stage: PressStage, separateEnvironment: boolean) {
  const subject = new DesktopBrowserService(async () => "unused-cookie-jar.json") as unknown as Subject;
  const reached = deferred(), release = deferred();
  const events: string[] = [], responses: Response[] = [];
  const listeners = new Set<() => void>();
  const socket: Socket = {
    once(name, listener) { assert.equal(name, "close"); listeners.add(listener); },
    off(name, listener) { assert.equal(name, "close"); listeners.delete(listener); },
    write(value) { responses.push(JSON.parse(value) as Response); }
  };
  const makeContents = (owner: "A" | "B") => {
    let destroyed = false;
    return {
      isDestroyed: () => destroyed,
      close() { destroyed = true; },
      debugger: {
        isAttached: () => true,
        attach() { assert.fail("already attached inert debugger"); },
        async sendCommand(method: string, params: Record<string, unknown>) {
          assert.equal(destroyed, false, "never dispatch to destroyed contents");
          let action: PressStage | "state";
          if (method === "Runtime.evaluate") {
            assert.equal(typeof params.expression, "string");
            if ((params.expression as string).includes("element.focus()")) action = "focus";
            else {
              assert.equal(params.expression, "({ url: location.href, title: document.title })");
              action = "state";
            }
          } else {
            assert.equal(method, "Input.dispatchKeyEvent");
            assert.ok(params.type === "keyDown" || params.type === "keyUp");
            assert.equal(params.key, "Enter");
            action = params.type;
          }
          events.push(`${owner}:${action}`);
          if (owner === "A" && action === stage) { reached.resolve(); await release.promise; }
          return { result: { value: action === "state" ? { url: `https://${owner.toLowerCase()}.invalid/`, title: owner } : undefined } };
        }
      }
    };
  };
  const a = makeContents("A"), b = makeContents("B");
  const tab = (id: string, contents: Contents, environmentId: string): EmbeddedTab => ({
    view: { webContents: contents, setVisible() {} },
    state: { id, environmentId }, navigation: 0, inspection: 0
  });
  const group: EmbeddedProject = { revision: 0, activeId: "A", tabs: new Map([
    ["A", tab("A", a, "default")],
    ["B", tab("B", b, separateEnvironment ? "00000000-0000-4000-8000-000000000001" : "default")]
  ]) };
  subject.embeddedProjects = new Map([["project", group]]);
  subject.environmentWindows = new Map();
  subject.automationTail = Promise.resolve();
  subject.automationContents = a;
  subject.desktopWindow = {
    isDestroyed: () => false,
    contentView: { removeChildView(view) { assert.equal(view.webContents, a); } },
    webContents: { send(channel, snapshot) { assert.equal(channel, "desktop:browser:state"); assert.equal(snapshot.activeId, "B"); } }
  };
  const request = (selector: boolean): Promise<void> => subject.handleAutomationRequest(JSON.stringify({
    id: "ownership", token: "fixture-token", method: "press", args: { selector: selector ? "#search" : undefined, key: "Enter" }
  }), "fixture-token", socket);
  const selectB = () => {
    const snapshot = subject.browserAction("project", { type: "select", tabId: "B" });
    assert.equal(snapshot.activeId, "B");
    assert.equal(subject.automationContents, b);
  };
  const closeOwner = () => subject.browserAction("project", { type: "close", tabId: "A" });
  const cancel = () => { for (const listener of [...listeners]) listener(); listeners.clear(); };
  const assertSelection = () => { assert.equal(group.activeId, "B"); assert.equal(subject.automationContents, b); };
  return { request, selectB, closeOwner, cancel, assertSelection, reached, release, events, responses, listeners };
}

const ownershipCases = [
  { stage: "focus", selector: true },
  { stage: "keyDown", selector: true }, { stage: "keyDown", selector: false },
  { stage: "keyUp", selector: true }, { stage: "keyUp", selector: false }
] as const;
const pressEvents = (owner: string, selector: boolean): string[] => [
  ...(selector ? [`${owner}:focus`] : []), `${owner}:keyDown`, `${owner}:keyUp`, `${owner}:state`
];

for (const separateEnvironment of [false, true]) {
  for (const { stage, selector } of ownershipCases) {
    test(`press retains owner across ${stage} response and tab selection, selector=${selector}, otherEnvironment=${separateEnvironment}`, testOptions, async () => {
      const f = ownershipFixture(stage, separateEnvironment);
      const run = f.request(selector);
      try {
        await f.reached.promise;
        f.selectB();
      } finally { f.release.resolve(); }
      await run;
      assert.deepEqual(f.events, pressEvents("A", selector));
      assert.equal(f.responses[0]?.ok, true);
      assert.deepEqual(f.responses[0]?.result, { url: "https://a.invalid/", title: "A" });
      f.assertSelection();
      assert.equal(f.listeners.size, 0);
      await f.request(false);
      assert.deepEqual(f.events, [...pressEvents("A", selector), ...pressEvents("B", false)]);
      assert.deepEqual(f.responses[1]?.result, { url: "https://b.invalid/", title: "B" });
      f.assertSelection();
      assert.equal(f.listeners.size, 0);
    });
  }
}

for (const { stage, selector } of ownershipCases.filter(({ stage }) => stage !== "keyUp")) {
  test(`selection plus cancellation during ${stage} preserves dispatch boundary, selector=${selector}`, testOptions, async () => {
    const f = ownershipFixture(stage, true);
    const run = f.request(selector);
    try { await f.reached.promise; f.selectB(); f.cancel(); }
    finally { f.release.resolve(); }
    await run;
    assert.deepEqual(f.events, stage === "focus" ? ["A:focus"] : pressEvents("A", selector));
    assert.equal(f.responses[0]?.ok, stage !== "focus");
    if (stage !== "focus") assert.deepEqual(f.responses[0]?.result, { url: "https://a.invalid/", title: "A" });
    f.assertSelection();
    assert.equal(f.listeners.size, 0);
  });
}

for (const { stage, selector } of ownershipCases) {
  test(`closed press owner never falls back after ${stage}, selector=${selector}`, testOptions, async () => {
    // Hardening control: Electron may reject a pending command on destruction;
    // this fake resolves it to verify no subsequent command moves to another tab.
    const f = ownershipFixture(stage, true);
    const run = f.request(selector);
    try { await f.reached.promise; f.selectB(); f.closeOwner(); }
    finally { f.release.resolve(); }
    await run;
    const expected = pressEvents("A", selector);
    assert.deepEqual(f.events, expected.slice(0, expected.indexOf(`A:${stage}`) + 1));
    assert.equal(f.responses[0]?.ok, false);
    assert.match(f.responses[0]?.error ?? "", /closed|关闭/);
    f.assertSelection();
    assert.equal(f.listeners.size, 0);
  });
}
