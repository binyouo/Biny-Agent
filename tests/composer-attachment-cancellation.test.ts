/** Real Composer/PromptInput DOM contracts; attachment persistence is a deferred synthetic boundary. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";

type Attachment = { name: string; path: string; mimeType: string; size: number };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Preparation = { name: string; gate: ReturnType<typeof deferred<Attachment>>; settled: boolean };
const requestFrame = (): number => 0;
const cancelFrame = (): void => {};

async function fixture(t: TestContext) {
  const restore: Array<() => void> = [];
  const preparations: Preparation[] = [];
  const inFlight = new Set<Promise<unknown>>();
  const commands: Array<{ value: string; gate: ReturnType<typeof deferred<void>>; settled: boolean }> = [];
  const resources: {
    dom?: import("jsdom").JSDOM;
    root?: import("react-dom/client").Root;
    React?: typeof import("react");
    hooks?: ReturnType<typeof registerHooks>;
  } = {};
  let networkCalls = 0;
  const attachment = (name: string): Attachment => ({ name, path: `/synthetic/attachments/${name}`, mimeType: "text/plain", size: 4 });
  // Register cleanup before acquiring globals, loader hooks, DOM or the root.
  t.after(async () => {
    const errors: unknown[] = [];
    const release = async (): Promise<void> => {
      for (const pending of preparations) {
        if (!pending.settled) { pending.settled = true; pending.gate.resolve(attachment(pending.name)); }
      }
      for (const command of commands) {
        if (!command.settled) { command.settled = true; command.gate.resolve(); }
      }
      await Promise.allSettled([...inFlight]);
    };
    try {
      if (resources.React) await resources.React.act(release); else await release();
    } catch (error) { errors.push(error); }
    try {
      if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount());
    } catch (error) { errors.push(error); }
    try { resources.hooks?.deregister(); } catch (error) { errors.push(error); }
    try { resources.dom?.window.close(); } catch (error) { errors.push(error); }
    for (const undo of restore.reverse()) {
      try { undo(); } catch (error) { errors.push(error); }
    }
    try { assert.equal(networkCalls, 0, "The renderer fixture must make no network requests"); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Failed to restore Composer attachment fixture");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (original) Object.defineProperty(target, key, original); else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const blockNetwork = (): never => { networkCalls++; throw new Error("Unexpected network request in attachment fixture"); };
  replace(globalThis, "fetch", blockNetwork);
  replace(Socket.prototype, "connect", blockNetwork);
  resources.hooks = registerHooks({ load(url, context, next) {
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://composer.test" });
  resources.dom = dom;
  const window = dom.window;
  const document = window.document;
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({
    window, document, self: window, navigator: window.navigator,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: LayoutObserver, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  replace(window, "fetch", blockNetwork);
  replace(window, "requestAnimationFrame", requestFrame);
  replace(window, "cancelAnimationFrame", cancelFrame);
  replace(window, "matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  replace(document, "fonts", { addEventListener() {}, removeEventListener() {} });
  replace(window.HTMLCanvasElement.prototype, "getContext", () => null);
  replace(window, "biny", { readInlineImage: async () => undefined });
  const React = await import("react");
  resources.React = React;
  replace(globalThis, "React", React);
  const { createRoot } = await import("react-dom/client");
  const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
  const drafts = new Map<string, import("../src/desktop/renderer/src/components/composer/composerDraft.js").ComposerDraftState>();
  const warnings: string[] = [];
  const sends: Array<{ text: string; attachments: Attachment[] }> = [];
  const noop = async (): Promise<void> => {};
  const base: Omit<React.ComponentProps<typeof Composer>, "project" | "draftKey"> = {
    drafts, models: [], memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
    running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
    focusToken: 0, capabilityDefaults: { tools: "none", skills: "none" }, skills: [], toolCatalog: [],
    onSend: async (text, attachments) => { sends.push({ text, attachments: attachments.map(item => ({ ...item })) }); },
    onMutateQueuedMessage: noop, onResume: noop, onSubmitEdit: noop, onCancelEdit() {},
    onSlashCommand(value) {
      const command = { value, gate: deferred<void>(), settled: false };
      commands.push(command);
      inFlight.add(command.gate.promise);
      void command.gate.promise.then(() => inFlight.delete(command.gate.promise), () => inFlight.delete(command.gate.promise));
      return command.gate.promise;
    },
    onStop: noop, onToggleMemory: noop, onSwitchModel: noop,
    onSaveAttachment(file) {
      const pending = { name: file.name, gate: deferred<Attachment>(), settled: false };
      preparations.push(pending);
      inFlight.add(pending.gate.promise);
      void pending.gate.promise.then(() => inFlight.delete(pending.gate.promise), () => inFlight.delete(pending.gate.promise));
      return pending.gate.promise;
    },
    onWarning(message) { warnings.push(message); },
    onSubmitError(message) { assert.fail(`Unexpected submit error: ${message}`); }
  };
  const root = createRoot(document.getElementById("root")!);
  resources.root = root;
  const render = async (key = "p:a"): Promise<void> => {
    const projectId = key.split(":")[0]!;
    await React.act(async () => root.render(React.createElement(Composer, { ...base, key, draftKey: key,
      project: { id: projectId, name: projectId, path: `/synthetic/${projectId}`, dirty: false, missing: false,
        pinned: false, addedAt: "", lastOpenedAt: "" } })));
  };
  const textarea = (): HTMLTextAreaElement => {
    const input = document.querySelector("textarea"); assert.ok(input); return input;
  };
  const button = (label: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label);
    assert.ok(found, `Missing public button: ${label}`); return found;
  };
  const buttonDisabled = (label: string): boolean => {
    const element = button(label);
    return element.disabled || element.getAttribute("aria-disabled") === "true";
  };
  const click = async (label: string): Promise<void> => { await React.act(async () => button(label).click()); };
  const input = async (value: string): Promise<void> => {
    await React.act(async () => {
      const element = textarea();
      assert.equal(element.disabled, false, "Typing requires an enabled native textarea");
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(textarea().value, value);
  };
  const dispatchFiles = (names: string[]): void => {
    const element = document.querySelector('input[type="file"]'); assert.ok(element);
    Object.defineProperty(element, "files", { configurable: true,
      value: names.map(name => new window.File(["file"], name, { type: "text/plain" })) });
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const select = async (...names: string[]): Promise<void> => { await React.act(async () => dispatchFiles(names)); };
  const selectTwice = async (): Promise<void> => {
    await React.act(async () => { dispatchFiles(["first.txt"]); dispatchFiles(["ignored.txt"]); });
  };
  const settle = async (index: number, outcome: "success" | "failure" = "success"): Promise<void> => {
    const pending = preparations[index]; assert.ok(pending); assert.equal(pending.settled, false);
    await React.act(async () => {
      pending.settled = true;
      if (outcome === "success") pending.gate.resolve(attachment(pending.name));
      else pending.gate.reject(new Error(`Could not prepare ${pending.name}`));
    });
  };
  const settleCommand = async (): Promise<void> => {
    assert.equal(commands.length, 1);
    const command = commands[0]!; assert.equal(command.settled, false);
    await React.act(async () => { command.settled = true; command.gate.resolve(); });
  };
  await render();
  return { document, textarea, button, buttonDisabled, click, input, select, selectTwice, settle, settleCommand, render, preparations, commands, sends, warnings };
}

for (const lateOutcome of ["success", "failure"] as const) {
  for (const order of ["old-first", "replacement-first"] as const) {
  test(`canceling the last pending attachment releases the composer before its late ${lateOutcome}, ${order}`, { timeout: 10_000 }, async t => {
    const h = await fixture(t);
    await h.input("Keep this text");
    await h.select("old.txt");
    assert.equal(h.preparations.length, 1);
    assert.equal(h.textarea().disabled, true, "A live attachment preparation disables the composer");
    await h.click("移除 old.txt");
    assert.equal(h.document.querySelector('[aria-label="待发送附件"]') === null, true);
    assert.equal(h.textarea().disabled, false, "Canceling the last attachment must release input while the detached operation is still pending");
    assert.equal(h.buttonDisabled("添加附件"), false);
    assert.equal(h.buttonDisabled("发送消息"), false);
    await h.input("Replacement text");
    await h.select("new.txt");
    assert.equal(h.preparations.length, 2, "A replacement attachment must be admitted before the canceled preparation settles");
    if (order === "old-first") {
      await h.settle(0, lateOutcome);
      assert.equal(h.textarea().disabled, true, "The canceled preparation cannot release the replacement's busy state");
      assert.equal(h.buttonDisabled("添加附件"), true);
      assert.equal(h.buttonDisabled("发送消息"), true);
      await h.select("third.txt");
      assert.equal(h.preparations.length, 2, "An old completion cannot admit a third preparation during the replacement");
    }
    await h.settle(1);
    assert.equal(h.textarea().disabled, false);
    assert.ok(h.button("移除 new.txt"));
    if (order === "replacement-first") await h.settle(0, lateOutcome);
    assert.equal(h.textarea().value, "Replacement text");
    assert.equal(h.document.querySelector('[aria-label="移除 old.txt"]') === null, true);
    assert.ok(h.button("移除 new.txt"));
    assert.deepEqual(h.warnings, [], "Canceled success or failure must not revive an attachment or surface a stale warning");
    await h.click("发送消息");
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0]!.text, "Replacement text");
    assert.deepEqual(h.sends[0]!.attachments.map(item => item.name), ["new.txt"]);
  });
  }
}

test("an old canceled preparation cannot release a later pending slash command", { timeout: 10_000 }, async t => {
  const h = await fixture(t);
  await h.select("old.txt");
  await h.click("移除 old.txt");
  assert.equal(h.textarea().disabled, false);
  await h.input("/goal show");
  await h.click("发送消息");
  assert.deepEqual(h.commands.map(item => item.value), ["/goal show"]);
  assert.equal(h.textarea().disabled, true);
  await h.settle(0, "failure");
  assert.equal(h.textarea().disabled, true, "The slash command still owns the busy composer");
  assert.equal(h.buttonDisabled("添加附件"), true);
  await h.select("third.txt");
  assert.equal(h.preparations.length, 1);
  assert.deepEqual(h.warnings, []);
  await h.settleCommand();
  assert.equal(h.textarea().disabled, false);
  assert.deepEqual(h.sends, []);
});

test("same-tick file changes cannot start two preparation batches", { timeout: 10_000 }, async t => {
  const h = await fixture(t);
  await h.selectTwice();
  assert.deepEqual(h.preparations.map(item => item.name), ["first.txt"]);
  await h.settle(0);
  assert.ok(h.button("移除 first.txt"));
  assert.equal(h.document.querySelector('[aria-label="移除 ignored.txt"]') === null, true);
});

test("ordinary multi-file preparation retains selection order when completion order is reversed", { timeout: 10_000 }, async t => {
  const h = await fixture(t);
  await h.select("first.txt", "second.txt");
  await h.settle(1);
  assert.equal(h.textarea().disabled, true);
  await h.settle(0);
  assert.equal(h.textarea().disabled, false);
  await h.click("发送消息");
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.sends[0]!.attachments.map(item => item.name), ["first.txt", "second.txt"]);
});

test("canceling one attachment keeps the active sibling busy but cannot delay its completed result", { timeout: 10_000 }, async t => {
  const h = await fixture(t);
  await h.select("canceled.txt", "kept.txt");
  await h.click("移除 canceled.txt");
  assert.equal(h.textarea().disabled, true, "The uncanceled sibling still owns preparation state");
  assert.equal(h.buttonDisabled("添加附件"), true);
  await h.settle(1);
  assert.equal(h.textarea().disabled, false, "An unresolved canceled sibling must not retain the completed attachment's busy state");
  assert.equal(h.document.querySelector('[aria-label="正在添加"]') === null, true);
  assert.ok(h.button("移除 kept.txt"));
  await h.click("发送消息");
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.sends[0]!.attachments.map(item => item.name), ["kept.txt"]);
  await h.settle(0);
  assert.equal(h.document.querySelector('[aria-label="待发送附件"]') === null, true);
  assert.deepEqual(h.warnings, []);
});

test("an active attachment still blocks duplicate admission and becomes sendable on completion", { timeout: 10_000 }, async t => {
  const h = await fixture(t);
  await h.select("kept.txt");
  assert.equal(h.textarea().disabled, true);
  assert.equal(h.buttonDisabled("添加附件"), true);
  assert.equal(h.buttonDisabled("发送消息"), true);
  await h.click("发送消息");
  assert.deepEqual(h.sends, [], "A focusable aria-disabled send button must reject actual activation");
  await h.select("ignored.txt");
  assert.equal(h.preparations.length, 1, "A second file event cannot bypass an active preparation");
  await h.settle(0);
  assert.equal(h.textarea().disabled, false);
  assert.ok(h.button("移除 kept.txt"));
  await h.click("发送消息");
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.sends[0]!.attachments.map(item => item.name), ["kept.txt"]);
});

test("a late attachment remains with its source draft across keyed session navigation", { timeout: 10_000 }, async t => {
  const h = await fixture(t);
  await h.select("source.txt");
  await h.render("q:b");
  await h.input("Other session draft");
  await h.settle(0);
  assert.equal(h.textarea().value, "Other session draft");
  assert.equal(h.document.querySelector('[aria-label="待发送附件"]') === null, true);
  await h.render("p:a");
  assert.ok(h.button("移除 source.txt"));
  assert.equal(h.textarea().disabled, false);
  await h.render("q:b");
  assert.equal(h.textarea().value, "Other session draft");
  assert.equal(h.document.querySelector('[aria-label="待发送附件"]') === null, true);
});
