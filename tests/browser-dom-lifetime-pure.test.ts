import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import nodeTest from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

function test(name: string, body: () => Promise<void>): void {
  void nodeTest(name, { timeout: 2_000 }, body);
}

// Actual method/branch extraction, not an Electron or page integration test.
const source = readFileSync(new URL("../src/desktop/electron/main/DesktopBrowserService.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("service.ts", source, ts.ScriptTarget.Latest, true);
const branches = new Map<string, string>();
const methods: string[] = [];
const fields: string[] = [];
const selectedMethods = new Set(["watchDomSnapshotNavigation", "click", "type", "press", "pageOperation", "evaluate", "sendDebuggerCommand"]);
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && selectedMethods.has(node.name.getText(tree))) methods.push(node.getText(tree));
  if (ts.isPropertyDeclaration(node) && ["domSnapshots", "domSnapshotInvalidators"].includes(node.name.getText(tree))) fields.push(node.getText(tree));
  if (ts.isIfStatement(node)) {
    for (const method of ["dom_snapshot", "dom_action"]) if (node.expression.getText(tree) === `method === "${method}"`) {
      assert.ok(!branches.has(method)); branches.set(method, node.getText(tree));
    }
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(methods.length, selectedMethods.size); assert.equal(fields.length, 2); assert.equal(branches.size, 2);
const compiled = ts.transpileModule(`class Subject {
${fields.join("\n")}
${methods.join("\n")}
async run(method, args, contents, signal) { const onAction = undefined; ${[...branches.values()].join("\n")} }
} this.Subject = Subject;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
type Result = { snapshotId: string; url: string; elements: Array<{ ref: string }> };
type Subject = {
  domSnapshots: WeakMap<Page, object>;
  domSnapshotInvalidators: WeakMap<Page, unknown>;
  run(method: string, args: Record<string, unknown>, page: Page, signal?: AbortSignal): Promise<Result>;
  pageOperation(operation: string): Promise<unknown>;
  click(...args: unknown[]): Promise<void>; type(...args: unknown[]): Promise<void>; press(...args: unknown[]): Promise<void>;
  ensureContents(owner?: Page): Promise<Page>; pageState(): Promise<unknown>;
};
class Page extends EventEmitter {
  dead = false;
  loading = false;
  commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  commandHook?: (method: string, params: Record<string, unknown>) => Promise<void>;
  debugger = {
    isAttached: () => true,
    attach: () => {},
    sendCommand: async (method: string, params: Record<string, unknown>) => {
      this.commands.push({ method, params });
      await this.commandHook?.(method, params);
      const operation = String(params.expression).match(/\)\("([^"]+)"/u)?.[1];
      return { result: { value: operation === "dom_snapshot" ? payload() : operation === "click" ? { x: 3, y: 4 } : {} } };
    }
  };
  url = "https://example.test/same";
  isDestroyed(): boolean { return this.dead; }
  isLoadingMainFrame(): boolean { return this.loading; }
  getURL(): string { return this.url; }
  navigate(main = true, inPlace = false): void { this.emit("did-start-navigation", {}, this.url, inPlace, main); }
  destroy(): void { this.dead = true; this.emit("destroyed"); }
}
const target = { tag: "button", name: "Send", selector: "#send", box: { x: 1, y: 1, width: 20, height: 20 } };
const payload = () => ({ url: "https://example.test/same", title: "Page", elements: [target] });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(fullHelpers = false) {
  let sequence = 0;
  const sandbox = { z, randomUUID: () => `snapshot-${++sequence}`, browserDomSnapshotSchema: z.object({}),
    browserPageOperation: function inertPageScript() {},
    asRecord: (value: unknown) => typeof value === "object" && value !== null ? value : {},
    browserDomActionSchema: z.object({ snapshotId: z.string(), ref: z.string(), action: z.object({ m: z.enum(["click", "type", "press"]), text: z.string().optional(), key: z.string().optional() }) }) };
  vm.createContext(sandbox); vm.runInContext(compiled, sandbox, { timeout: 1000 });
  const subject = new (sandbox as unknown as { Subject: new () => Subject }).Subject();
  const page = new Page(); const actions: unknown[][] = [];
  subject.ensureContents = async owner => owner ?? page;
  subject.pageState = async () => ({});
  if (!fullHelpers) {
    subject.pageOperation = async operation => operation === "dom_snapshot" ? payload() : {};
    subject.click = subject.type = subject.press = async (...args) => { actions.push(args); };
  }
  const capture = (signal?: AbortSignal) => subject.run("dom_snapshot", {}, page, signal);
  const act = (snapshot: Result, m = "click", signal?: AbortSignal) => subject.run("dom_action", { snapshotId: snapshot.snapshotId, ref: "e1", action: { m, text: "text", key: "Enter" } }, page, signal);
  return { subject, page, actions, capture, act };
}

test("repeated capture/navigation retains one destruction listener", async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) { await f.capture(); f.page.navigate(); }
  assert.equal(f.page.listenerCount("destroyed"), 1);
  await f.capture(); assert.equal(f.page.listenerCount("did-start-navigation"), 1);
  f.page.destroy(); assert.equal(f.page.listenerCount("did-start-navigation"), 0);
  assert.equal(f.page.listenerCount("destroyed"), 0);
  assert.equal(f.subject.domSnapshots.has(f.page), false);
  assert.equal(f.subject.domSnapshotInvalidators.has(f.page), false);
});
for (const inPlace of [false, true]) test(`pending snapshot rejects main navigation (inPlace=${inPlace})`, async () => {
  const f = fixture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const pending = f.capture(); const rejected = assert.rejects(pending, /DOM/);
  f.page.navigate(true, inPlace); gate.resolve(payload()); await rejected;
  assert.equal(f.subject.domSnapshots.has(f.page), false); f.page.destroy();
});
test("iframe navigation preserves pending snapshot", async () => {
  const f = fixture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const pending = f.capture(); f.page.navigate(false); gate.resolve(payload()); await pending;
  assert.equal(f.subject.domSnapshots.has(f.page), true); f.page.destroy();
});
test("close during capture cannot publish into destroyed page", async () => {
  const f = fixture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const pending = f.capture(); const rejected = assert.rejects(pending, /DOM/); f.page.destroy(); gate.resolve(payload()); await rejected;
  assert.equal(f.subject.domSnapshots.has(f.page), false); assert.equal(f.page.listenerCount("destroyed"), 0);
});
test("older capture completion cannot replace newer accepted snapshot", async () => {
  const f = fixture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const old = f.capture(); const rejected = assert.rejects(old, /DOM/);
  f.subject.pageOperation = async () => payload(); const newer = await f.capture(); const owned = f.subject.domSnapshots.get(f.page);
  gate.resolve(payload()); await rejected; assert.equal(f.subject.domSnapshots.get(f.page), owned);
  await f.act(newer); assert.equal(f.actions.length, 1); f.page.destroy();
});
for (const m of ["click", "type", "press"]) for (const event of ["navigation", "close", "new-snapshot"]) test(`${m} refuses stale target validation after ${event}`, async () => {
  const f = fixture(); const old = await f.capture(); const gate = deferred<unknown>();
  f.subject.pageOperation = operation => operation === "dom_target" ? gate.promise : Promise.resolve(payload());
  const pending = f.act(old, m); const rejected = assert.rejects(pending, /DOM/);
  let newest: object | undefined;
  if (event === "navigation") f.page.navigate();
  if (event === "close") f.page.destroy();
  if (event === "new-snapshot") { await f.capture(); newest = f.subject.domSnapshots.get(f.page); }
  gate.resolve({}); await rejected; assert.equal(f.actions.length, 0);
  if (newest) assert.equal(f.subject.domSnapshots.get(f.page), newest);
  if (!f.page.dead) f.page.destroy();
});
for (const stage of ["capture", "action"]) test(`abort during ${stage} does not publish or dispatch`, async () => {
  const f = fixture(); const previous = await f.capture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const controller = new AbortController(); const error = new Error("test cancellation");
  const pending = stage === "capture" ? f.capture(controller.signal) : f.act(previous, "click", controller.signal);
  const rejected = assert.rejects(pending, e => e === error); controller.abort(error); gate.resolve(stage === "capture" ? payload() : {}); await rejected;
  assert.equal(f.actions.length, 0); f.page.destroy();
});
test("page rejection preserves its error and allows fresh capture", async () => {
  const f = fixture(); const error = new Error("page failure"); f.subject.pageOperation = async () => { throw error; };
  await assert.rejects(f.capture(), e => e === error); f.subject.pageOperation = async () => payload();
  const good = await f.capture(); await f.act(good); assert.equal(f.actions.length, 1); f.page.destroy();
});
test("ordinary snapshot and single-use action remain functional", async () => {
  const f = fixture(); const snapshot = await f.capture(); await f.act(snapshot);
  await assert.rejects(f.act(snapshot), /DOM/); assert.equal(f.actions.length, 1); f.page.destroy();
});
test("another page navigation does not invalidate owner", async () => {
  const f = fixture(); const snapshot = await f.capture(); const other = new Page();
  await f.subject.run("dom_snapshot", {}, other); other.navigate(); await f.act(snapshot);
  assert.equal(f.actions.length, 1); other.destroy(); f.page.destroy();
});
test("older capture finishing first is superseded while newest is pending", async () => {
  const f = fixture(); const first = deferred<unknown>(); const second = deferred<unknown>(); let calls = 0;
  f.subject.pageOperation = () => ++calls === 1 ? first.promise : second.promise;
  const old = f.capture(); const rejected = assert.rejects(old, /DOM/); const newer = f.capture();
  first.resolve(payload()); await rejected; assert.equal(f.subject.domSnapshots.has(f.page), false);
  second.resolve(payload()); await newer; assert.equal(f.subject.domSnapshots.has(f.page), true); f.page.destroy();
});
test("failed newest capture does not revive older pending capture", async () => {
  const f = fixture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const old = f.capture(); const rejected = assert.rejects(old, /DOM/); const error = new Error("new failed");
  f.subject.pageOperation = async () => { throw error; }; await assert.rejects(f.capture(), e => e === error);
  gate.resolve(payload()); await rejected; assert.equal(f.subject.domSnapshots.has(f.page), false); f.page.destroy();
});
test("already destroyed page is refused before page operation", async () => {
  const f = fixture(); let calls = 0; f.subject.pageOperation = async () => { calls++; return payload(); }; f.page.destroy();
  await assert.rejects(f.capture(), /DOM/); assert.equal(calls, 0); assert.equal(f.page.listenerCount("destroyed"), 0);
});
test("iframe navigation during target validation preserves action", async () => {
  const f = fixture(); const snapshot = await f.capture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const pending = f.act(snapshot); f.page.navigate(false); gate.resolve({}); await pending;
  assert.equal(f.actions.length, 1); f.page.destroy();
});
test("target validation rejection never consumes snapshot or dispatches", async () => {
  const f = fixture(); const snapshot = await f.capture(); const owned = f.subject.domSnapshots.get(f.page); const error = new Error("target changed");
  f.subject.pageOperation = async () => { throw error; }; await assert.rejects(f.act(snapshot), e => e === error);
  assert.equal(f.actions.length, 0); assert.equal(f.subject.domSnapshots.get(f.page), owned); f.page.destroy();
});
test("malformed snapshot response cannot replace an accepted snapshot", async () => {
  const f = fixture(); await f.capture(); const owned = f.subject.domSnapshots.get(f.page);
  f.subject.pageOperation = async () => ({ url: "bad" }); await assert.rejects(f.capture());
  assert.equal(f.subject.domSnapshots.get(f.page), owned); f.page.destroy();
});
for (const m of ["click", "type", "press"]) for (const stage of ["reveal", "wait", "focus", "dispatch-owner"]) test(`actual ${m} helper stops before input after ${stage} navigation`, async () => {
  const f = fixture(true); const snapshot = await f.capture(); const entered = deferred<void>(); const release = deferred<void>();
  if (stage === "dispatch-owner") {
    let count = 0;
    f.subject.ensureContents = async owner => { if (++count === 5) { entered.resolve(); await release.promise; } return owner ?? f.page; };
  } else {
    f.page.commandHook = async (_method, params) => {
      const operation = String(params.expression).match(/\)\("([^"]+)"/u)?.[1];
      if (operation === (stage === "focus" ? m : stage)) { entered.resolve(); await release.promise; }
    };
  }
  const pending = f.act(snapshot, m); const rejected = assert.rejects(pending, /DOM/);
  await entered.promise; f.page.navigate(); release.resolve(); await rejected;
  assert.equal(f.page.commands.filter(c => c.method.startsWith("Input.")).length, 0); f.page.destroy();
});
for (const m of ["click", "type", "press"]) test(`actual ${m} helper dispatches normally with retained owner`, async () => {
  const f = fixture(true); const snapshot = await f.capture(); await f.act(snapshot, m);
  const inputs = f.page.commands.filter(c => c.method.startsWith("Input."));
  assert.equal(inputs.length, m === "type" ? 1 : 2); f.page.destroy();
});
for (const m of ["click", "press"]) test(`actual ${m} releases already pressed input after navigation`, async () => {
  const f = fixture(true); const snapshot = await f.capture();
  f.page.commandHook = async (_method, params) => { if (params.type === (m === "click" ? "mousePressed" : "keyDown")) f.page.navigate(); };
  await f.act(snapshot, m);
  const inputs = f.page.commands.filter(c => c.method.startsWith("Input."));
  assert.deepEqual(inputs.map(c => c.params.type), m === "click" ? ["mousePressed", "mouseReleased"] : ["keyDown", "keyUp"]); f.page.destroy();
});
test("debugger attach reentrancy cannot bypass final generation check", async () => {
  const f = fixture(true); const snapshot = await f.capture();
  let attaches = 0;
  f.page.debugger.isAttached = () => ++attaches !== 5; f.page.debugger.attach = () => f.page.navigate();
  await assert.rejects(f.act(snapshot), /DOM/);
  assert.equal(attaches, 5);
  assert.equal(f.page.commands.filter(c => c.method.startsWith("Input.")).length, 0); f.page.destroy();
});
test("already loading main frame refuses capture until failed navigation stops", async () => {
  const f = fixture(); f.page.loading = true; await assert.rejects(f.capture(), /DOM/);
  f.page.emit("did-fail-load", {}, -2, "fake", f.page.url, true); f.page.loading = false;
  await f.capture(); assert.equal(f.subject.domSnapshots.has(f.page), true); f.page.destroy();
});
for (const event of ["did-navigate", "did-navigate-in-page"]) test(`capture invalidated by ${event} commit without an observed start`, async () => {
  const f = fixture(); const gate = deferred<unknown>(); f.subject.pageOperation = () => gate.promise;
  const pending = f.capture(); const rejected = assert.rejects(pending, /DOM/);
  f.page.emit(event, {}, f.page.url, true); gate.resolve(payload()); await rejected;
  assert.equal(f.subject.domSnapshots.has(f.page), false); f.page.destroy();
  assert.equal(f.page.listenerCount(event), 0);
});
test("subframe in-page commit does not invalidate main snapshot", async () => {
  const f = fixture(); const snapshot = await f.capture(); f.page.emit("did-navigate-in-page", {}, f.page.url, false);
  await f.act(snapshot); assert.equal(f.actions.length, 1); f.page.destroy();
});
