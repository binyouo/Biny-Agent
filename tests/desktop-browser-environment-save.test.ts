import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopBrowserEnvironment, DesktopBrowserEnvironmentInput } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const initial: DesktopBrowserEnvironment = {
  id: "synthetic-environment", name: "Work", color: "#75c9f2",
  proxy: { mode: "fixed_servers", proxyRules: "http=proxy.invalid:1234", proxyBypassRules: "localhost" }
};
const submitted: DesktopBrowserEnvironmentInput = {
  name: "Saved name",
  proxy: { mode: "fixed_servers", proxyRules: "http=saved.invalid:1234", proxyBypassRules: "saved.invalid" }
};

async function fixture(t: TestContext) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react") } = {};
  const restore: Array<() => void> = [];
  const writes: Array<{ id?: string; input: DesktopBrowserEnvironmentInput; gate: ReturnType<typeof deferred<DesktopBrowserEnvironment>> }> = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const network: string[] = [];
  let rows: DesktopBrowserEnvironment[] = [
    { id: "default", name: "默认", color: "#aeb5c2", proxy: { mode: "system" } }, structuredClone(initial)
  ];

  // Register cleanup before imports or DOM replacement; even Red failures must
  // settle the inert IPC promises, unmount React, and restore global state.
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        for (const write of writes) write.gate.resolve({ ...initial, ...write.input });
        await Promise.allSettled(writes.map(write => write.gate.promise));
      });
    } catch (reason) { errors.push(reason); }
    try {
      if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount());
    } catch (reason) { errors.push(reason); }
    try { resources.dom?.window.close(); } catch (reason) { errors.push(reason); }
    for (const undo of restore.reverse()) {
      try { undo(); } catch (reason) { errors.push(reason); }
    }
    assert.deepEqual(network, [], "Environment UI tests must not contact external services");
    if (errors.length) throw new AggregateError(errors, "Environment fixture cleanup failed");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><button id="outside">Outside</button><div id="root"></div>', { url: "https://biny.test" });
  resources.dom = dom;
  const window = dom.window;
  const document = window.document;
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  t.mock.method(globalThis, "fetch", async () => { network.push("fetch"); throw new Error("Unexpected fetch"); });
  t.mock.method(Socket.prototype, "connect", () => { network.push("socket"); throw new Error("Unexpected socket"); });
  const write = (id: string | undefined, input: DesktopBrowserEnvironmentInput) => {
    const gate = deferred<DesktopBrowserEnvironment>();
    writes.push({ id, input: structuredClone(input), gate });
    return gate.promise;
  };
  // Only these renderer IPC endpoints exist. No native service, credentials,
  // cookie stores, proxy configuration, or browser page is initialized.
  replace(window, "biny", {
    browserEnvironments: async () => structuredClone(rows),
    createBrowserEnvironment: (input: DesktopBrowserEnvironmentInput) => write(undefined, input),
    updateBrowserEnvironment: (id: string, input: DesktopBrowserEnvironmentInput) => write(id, input)
  });
  const React = await import("react");
  resources.React = React;
  replace(globalThis, "React", React);
  const { createRoot } = await import("react-dom/client");
  const { BrowserEnvironmentMenu } = await import("../src/desktop/renderer/src/components/workspace/BrowserEnvironmentMenu.js");
  const root = createRoot(document.getElementById("root")!);
  resources.root = root;
  await React.act(async () => root.render(React.createElement(BrowserEnvironmentMenu, {
    current: initial, disabled: false, onOpen: id => opened.push(id), onNotice: message => notices.push(message)
  })));
  const element = <T extends Element>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    assert.ok(found, `Expected ${selector}`);
    return found;
  };
  const click = async (selector: string): Promise<void> => {
    await React.act(async () => { element<HTMLButtonElement>(selector).click(); });
  };
  const fields = (): Array<HTMLInputElement | HTMLSelectElement> => [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".inspector-browser-environment-form input, .inspector-browser-environment-form select")];
  const field = (label: string): HTMLInputElement | HTMLSelectElement => {
    const parent = [...document.querySelectorAll(".inspector-browser-environment-form label")].find(node => node.firstChild?.textContent === label);
    assert.ok(parent, `Expected field ${label}`);
    return parent.querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
  };
  const enter = async (label: string, value: string): Promise<boolean> => {
    const target = field(label);
    // JSDOM dispatchEvent can bypass native disabled semantics. Honor the
    // actual DOM admission state instead of manufacturing impossible input.
    if (target.disabled) return false;
    await React.act(async () => {
      const select = target.tagName === "SELECT";
      const prototype = select ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new window.Event(select ? "change" : "input", { bubbles: true }));
    });
    assert.equal(field(label).value, value, `Enabled ${label} must receive the real change event`);
    return true;
  };
  const form = () => document.querySelector(".inspector-browser-environment-form");
  const saveButton = ".inspector-browser-environment-form > div > button:first-child";
  const begin = async (kind: "create" | "update"): Promise<void> => {
    await click('.inspector-browser-environment-trigger');
    await click(kind === "create" ? ".inspector-browser-environment-create" : '[aria-label="编辑 Work"]');
    await enter("名称", submitted.name);
    await enter("代理", "fixed_servers");
    await enter("代理规则", submitted.proxy.proxyRules!);
    await enter("绕过规则", submitted.proxy.proxyBypassRules!);
  };
  const resolve = async (index: number): Promise<void> => {
    const entry = writes[index];
    assert.ok(entry);
    const result = { ...initial, id: entry.id ?? "created-environment", ...entry.input };
    rows = [...rows.filter(row => row.id !== result.id), result];
    await React.act(async () => { entry.gate.resolve(result); await entry.gate.promise; });
  };
  return {
    writes, notices, opened, document, fields, field, enter, form, click, begin, resolve, saveButton,
    async reject(index: number) {
      const entry = writes[index]!;
      await React.act(async () => {
        entry.gate.reject(new Error("Synthetic save failure"));
        await entry.gate.promise.catch(() => undefined);
      });
    },
    async key(key: string) {
      await React.act(async () => { field("名称").dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })); });
    },
    async dismiss(kind: "Escape" | "outside" | "trigger") {
      if (kind === "trigger") await click(".inspector-browser-environment-trigger");
      else await React.act(async () => {
        if (kind === "Escape") window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        else document.getElementById("outside")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
      });
    }
  };
}

for (const kind of ["create", "update"] as const) {
  test(`${kind} environment does not accept edits that a pending save will discard`, async t => {
    const h = await fixture(t);
    await h.begin(kind);
    await h.click(h.saveButton);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]!.id, kind === "create" ? undefined : initial.id);
    assert.deepEqual(h.writes[0]!.input, submitted);
    const pendingDisabled = h.fields().map(field => field.disabled);
    const accepted: string[] = [];
    for (const [label, value] of [["名称", "Later name"], ["代理规则", "http=later.invalid:5678"], ["绕过规则", "later.invalid"], ["代理", "direct"]]) {
      if (await h.enter(label!, value!)) accepted.push(label!);
    }
    await h.resolve(0);
    assert.equal(h.form(), null, "Successful save returns to the environment list");
    assert.deepEqual(h.writes[0]!.input, submitted, "The completed request contains only the originally submitted draft");
    assert.deepEqual(accepted, [], "The editor must not accept later changes and then discard them on save success");
    assert.deepEqual(pendingDisabled, [true, true, true, true]);
    assert.deepEqual(h.notices, [kind === "create" ? "浏览器环境已创建。" : "浏览器环境已更新。"]);
    await h.click('[aria-label="编辑 Saved name"]');
    assert.deepEqual(h.fields().map(field => field.value), [submitted.name, "fixed_servers", submitted.proxy.proxyRules, submitted.proxy.proxyBypassRules]);
    assert.ok(h.fields().every(field => !field.disabled), "A new editing session is enabled after saving");
  });
}

test("a failed save retains its draft, reenables every field, and permits a corrected retry", async t => {
  const h = await fixture(t);
  await h.begin("update");
  await h.click(h.saveButton);
  await h.reject(0);
  assert.match(h.document.querySelector('[role="alert"]')?.textContent ?? "", /Synthetic save failure/u);
  assert.deepEqual(h.fields().map(field => field.value), [submitted.name, "fixed_servers", submitted.proxy.proxyRules, submitted.proxy.proxyBypassRules]);
  assert.ok(h.fields().every(field => !field.disabled));
  await h.enter("名称", "Retry name");
  await h.enter("代理规则", "http=retry.invalid:5678");
  await h.enter("绕过规则", "retry.invalid");
  await h.key("Enter");
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[1]!.input, { name: "Retry name", proxy: { mode: "fixed_servers", proxyRules: "http=retry.invalid:5678", proxyBypassRules: "retry.invalid" } });
  await h.resolve(1);
  assert.equal(h.form(), null);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.deepEqual(h.notices, ["浏览器环境已更新。"]);
});

test("pending saves block duplicate save and cancel actions without changing the submitted request", async t => {
  const h = await fixture(t);
  await h.begin("create");
  await h.key("Enter");
  await h.click(h.saveButton);
  await h.click(".inspector-browser-environment-form > div > button:last-child");
  // Even a synthetic key event dispatched on the disabled input is rejected
  // by save's existing busy guard; normal typing is covered above.
  await h.key("Enter");
  assert.equal(h.writes.length, 1);
  assert.ok(h.form());
  await h.resolve(0);
  assert.equal(h.form(), null);
});

test("idle form changes and cancellation remain usable without issuing a save", async t => {
  const h = await fixture(t);
  await h.begin("update");
  assert.ok(h.fields().every(field => !field.disabled));
  await h.enter("代理", "direct");
  assert.equal(h.fields().length, 2);
  await h.enter("代理", "fixed_servers");
  assert.deepEqual(h.fields().map(field => field.value), [submitted.name, "fixed_servers", submitted.proxy.proxyRules, submitted.proxy.proxyBypassRules]);
  await h.click(".inspector-browser-environment-form > div > button:last-child");
  assert.equal(h.form(), null);
  assert.deepEqual(h.writes, []);
  await h.click('[aria-label="编辑 Work"]');
  assert.deepEqual(h.fields().map(field => field.value), [initial.name, "fixed_servers", initial.proxy.proxyRules, initial.proxy.proxyBypassRules]);
  assert.deepEqual(h.notices, []);
});

for (const kind of ["Escape", "outside", "trigger"] as const) {
  test(`${kind} dismissal during save does not reopen an old editor or admit a replacement`, async t => {
    const h = await fixture(t);
    await h.begin("update");
    await h.click(h.saveButton);
    await h.dismiss(kind);
    assert.equal(h.document.querySelector('[role="dialog"]'), null);
    await h.click(".inspector-browser-environment-trigger");
    assert.equal(h.form(), null);
    assert.equal(h.document.querySelector<HTMLButtonElement>(".inspector-browser-environment-create")?.disabled, true);
    await h.click(".inspector-browser-environment-create");
    assert.equal(h.form(), null);
    await h.resolve(0);
    assert.equal(h.form(), null);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.opened, []);
    await h.click(".inspector-browser-environment-create");
    assert.ok(h.form());
    await h.enter("名称", "Fresh draft");
    assert.equal(h.field("名称").value, "Fresh draft");
    assert.deepEqual(h.notices, ["浏览器环境已更新。"]);
  });
}
