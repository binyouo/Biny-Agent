/** Real MCP editor and detail-layer events; every desktop request is inert. */
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import type { DesktopApi, DesktopMcpServerDraft, DesktopMcpServerSummary, DesktopMcpSnapshot, DesktopMcpTestResult } from "../src/desktop/protocol.js";

const dom = new JSDOM("<!doctype html><div id='root'></div><div id='details'></div>", { url: "https://localhost/" });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const unexpected: string[] = [];
for (const [name, value] of Object.entries({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: () => { unexpected.push("fetch"); throw new Error("No network in MCP editor tests"); }
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
// React DOM must discover the DOM before installing its real input event handling.
const { createRoot } = await import("react-dom/client");
const { McpServersView } = await import("../src/desktop/renderer/src/components/McpServersView.js");
const { SettingsDetailHostContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js");
after(() => {
  dom.window.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  assert.deepEqual(unexpected, [], "No unexpected desktop or network calls");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function server(name: string): DesktopMcpServerSummary {
  return { name, transport: "stdio", commandOrUrl: `synthetic-${name}`, args: [], enabled: true,
    state: "not-started", toolNames: [], promptNames: [], hasResources: false,
    environmentKeys: ["SYNTHETIC_KEY"], headerNames: [] };
}
const snapshot: DesktopMcpSnapshot = { configRevision: "synthetic-revision", servers: [server("A"), server("B")],
  catalog: { status: "ready", source: "synthetic-catalog", entries: [], categories: [] } };
function result(label: string, success = true): DesktopMcpTestResult {
  return { success, state: success ? "connected" : "failed", toolNames: success ? ["first", "second"] : [],
    promptNames: success ? ["prompt"] : [], hasResources: success,
    ...(success ? { message: label } : { error: label }) };
}
type Outcome = "success" | "failure" | "throw";
type CloseMethod = "cancel" | "close" | "escape" | "backdrop";

async function fixture(t: TestContext) {
  type Call = ReturnType<typeof deferred<DesktopMcpTestResult>> & { projectId?: string; draft: DesktopMcpServerDraft; settled: boolean };
  const calls: Call[] = [];
  const notices: Array<{ kind: "error" | "success"; message: string }> = [];
  const api = {
    mcpSnapshot: async () => structuredClone(snapshot),
    mcpRefreshCatalog: async () => structuredClone(snapshot.catalog),
    mcpTestServer(projectId: string | undefined, draft: DesktopMcpServerDraft) {
      const gate = deferred<DesktopMcpTestResult>();
      const call = { ...gate, projectId, draft: structuredClone(draft), settled: false };
      calls.push(call);
      void gate.promise.then(() => { call.settled = true; }, () => { call.settled = true; });
      return gate.promise;
    }
  } satisfies Pick<DesktopApi, "mcpSnapshot" | "mcpRefreshCatalog" | "mcpTestServer">;
  Object.assign(dom.window, { biny: new Proxy(api, { get(target, key, receiver) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
    unexpected.push(String(key));
    throw new Error(`Unexpected desktop API ${String(key)}`);
  } }) });
  const root = createRoot(document.getElementById("root")!);
  let mounted = true;
  const step = async (work: () => void) => { await React.act(async () => { work(); }); };
  const unmount = async () => {
    if (!mounted) return;
    await step(() => root.unmount());
    mounted = false;
  };
  t.after(async () => {
    await unmount();
    await step(() => { for (const call of calls) if (!call.settled) call.resolve(result("cleanup", false)); });
    await Promise.allSettled(calls.map(call => call.promise));
    assert.equal(document.querySelector(".settings-detail-layer"), null);
  });
  const dialog = () => document.querySelector<HTMLFormElement>(".biny-mcp-dialog");
  const button = (label: string) => {
    const scope = dialog() ?? document.getElementById("root")!;
    const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
      .find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
    assert.ok(found, `Visible button ${label}; never interact behind the detail layer`);
    return found;
  };
  const click = async (label: string) => {
    const target = button(label);
    assert.equal(target.disabled, false, `${label} must be enabled`);
    await step(() => target.click());
  };
  const field = (label: string) => {
    const found = [...(dialog()?.querySelectorAll<HTMLInputElement>("input") ?? [])]
      .find(item => item.getAttribute("aria-label") === label || item.closest("label")?.querySelector("span")?.textContent?.replace(" *", "") === label);
    assert.ok(found, `Visible input ${label}`);
    return found;
  };
  const fill = async (label: string, value: string) => {
    const target = field(label);
    assert.equal(target.disabled, false);
    await step(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(field(label).value, value, "Real controlled input accepted the change");
  };
  const close = async (method: CloseMethod) => {
    assert.ok(dialog());
    if (method === "cancel" || method === "close") await click(method === "cancel" ? "取消" : "关闭");
    else await step(() => {
      if (method === "escape") document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else document.querySelector(".settings-detail-layer")!.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    });
    assert.equal(dialog(), null);
  };
  const settle = async (call: Call, outcome: Outcome, label: string) => {
    await step(() => outcome === "throw" ? call.reject(new Error(label)) : call.resolve(result(label, outcome === "success")));
  };
  const onError = (message: string) => { notices.push({ kind: "error", message }); };
  const onSuccess = (message: string) => { notices.push({ kind: "success", message }); };
  const render = async (host: HTMLElement | null = document.getElementById("details"), projectId = "project-A") => {
    await step(() => root.render(React.createElement(SettingsDetailHostContext.Provider,
      { value: host }, React.createElement(McpServersView, { projectId, onError, onSuccess }))));
  };
  await render();
  return { calls, notices, click, fill, field, close, settle, unmount, render,
    presentation: () => dialog()?.querySelector(".biny-mcp-test-result")?.textContent ?? "",
    async start() { await click("测试连接"); assert.ok(calls.at(-1)); return calls.at(-1)!; }
  };
}

for (const outcome of ["success", "failure", "throw"] as const) {
  test(`current editor reports its own connection-test ${outcome}`, async t => {
    const h = await fixture(t); await h.click("编辑 A"); const call = await h.start();
    assert.equal(call.projectId, "project-A"); assert.equal(call.draft.name, "A");
    assert.equal(call.draft.command, "synthetic-A");
    await h.settle(call, outcome, "current A");
    if (outcome === "throw") {
      assert.equal(h.presentation(), ""); assert.deepEqual(h.notices, [{ kind: "error", message: "current A" }]);
    } else {
      assert.match(h.presentation(), outcome === "success" ? /连接测试成功current A工具 2 · 提示 1 · 资源 有/ : /连接测试失败current A/);
      assert.deepEqual(h.notices, outcome === "success" ? [{ kind: "success", message: "current A" }] : []);
    }
  });
}

for (const method of ["cancel", "close", "escape", "backdrop"] as const) {
  for (const outcome of ["success", "failure", "throw"] as const) {
    test(`dismissed A cannot report its ${outcome} in untested B after ${method}`, async t => {
      const h = await fixture(t); await h.click("编辑 A"); const old = await h.start();
      await h.close(method); await h.click("编辑 B");
      assert.equal(h.field("服务器名称").value, "B"); assert.equal(h.presentation(), "");
      await h.settle(old, outcome, "obsolete A");
      assert.equal(h.field("服务器名称").value, "B");
      assert.equal(h.presentation(), "", "Untested B must not display A's connection result");
      assert.deepEqual(h.notices, [], "Dismissed request must not emit a stale notification");
      const current = await h.start(); assert.equal(current.draft.name, "B");
      await h.settle(current, "success", "current B");
      assert.match(h.presentation(), /current B/); assert.deepEqual(h.notices, [{ kind: "success", message: "current B" }]);
    });
  }
}

for (const outcome of ["success", "failure", "throw"] as const) {
  test(`older repeated connection test cannot replace the newer result with ${outcome}`, async t => {
    const h = await fixture(t); await h.click("编辑 A"); const old = await h.start(); const current = await h.start();
    assert.notEqual(old, current); assert.deepEqual(old.draft, current.draft);
    await h.settle(current, "success", "newer A"); const presentation = h.presentation();
    await h.settle(old, outcome, "older A");
    assert.equal(h.presentation(), presentation); assert.deepEqual(h.notices, [{ kind: "success", message: "newer A" }]);
  });
  for (const destination of ["closed", "unmounted", "new"] as const) {
    test(`connection-test ${outcome} is silent after editor is ${destination}`, async t => {
      const h = await fixture(t); await h.click("编辑 A"); const old = await h.start();
      if (destination === "unmounted") await h.unmount();
      else { await h.close("cancel"); if (destination === "new") await h.click("添加服务器"); }
      await h.settle(old, outcome, "obsolete A");
      assert.equal(h.presentation(), ""); assert.deepEqual(h.notices, []);
      if (destination === "new") assert.equal(h.field("服务器名称").value, "");
    });
  }
}

for (const label of ["命令", "环境变量值 1"] as const) {
  test(`changing ${label} retires both pending and already displayed results`, async t => {
    const h = await fixture(t); await h.click("编辑 A"); const old = await h.start();
    await h.fill(label, "changed value"); await h.settle(old, "success", "old configuration");
    assert.equal(h.presentation(), ""); assert.deepEqual(h.notices, []);
    const current = await h.start();
    if (label === "命令") assert.equal(current.draft.command, "changed value");
    else assert.deepEqual(current.draft.env, [{ key: "SYNTHETIC_KEY", action: "set", value: "changed value" }]);
    await h.settle(current, "success", "current configuration"); assert.match(h.presentation(), /current configuration/);
    await h.fill(label, "changed again"); assert.equal(h.presentation(), "", "A displayed test does not certify edited configuration");
  });
}

// SettingsOverlay's native Dialog keeps its children mounted when closed and
// provides a null detail host. A native outer-backdrop click can take this path
// without first invoking the nested editor's onClose callback.
for (const outcome of ["success", "failure", "throw"] as const) {
  test(`outer settings dismissal retires connection-test ${outcome} without discarding its draft`, async t => {
    const h = await fixture(t); await h.click("编辑 A"); await h.fill("命令", "unsaved command");
    const old = await h.start(); await h.render(null);
    assert.equal(document.querySelector(".biny-mcp-dialog"), null);
    await h.settle(old, outcome, "dismissed settings A");
    assert.deepEqual(h.notices, [], "Hidden settings must not emit stale connection-test notifications");
    await h.render();
    assert.equal(h.field("服务器名称").value, "A"); assert.equal(h.field("命令").value, "unsaved command");
    assert.equal(h.presentation(), "", "Reopening must not display a test retired with the old host lifetime");
    const current = await h.start(); await h.settle(current, "success", "reopened A");
    assert.match(h.presentation(), /reopened A/); assert.deepEqual(h.notices, [{ kind: "success", message: "reopened A" }]);
  });
}

test("a current visible editor keeps test ownership when its detail host element is replaced", async t => {
  const h = await fixture(t); await h.click("编辑 A"); const current = await h.start();
  const replacement = document.createElement("div"); document.body.append(replacement);
  try {
    await h.render(replacement); await h.settle(current, "success", "current visible A");
    assert.match(h.presentation(), /current visible A/);
    assert.deepEqual(h.notices, [{ kind: "success", message: "current visible A" }]);
  } finally { await h.unmount(); replacement.remove(); }
});

for (const outcome of ["success", "failure", "throw"] as const) {
  test(`project change retires connection-test ${outcome} but accepts the current project's test`, async t => {
    const h = await fixture(t); await h.click("编辑 A"); const old = await h.start();
    await h.render(document.getElementById("details"), "project-B");
    await h.settle(old, outcome, "old project A");
    assert.equal(h.presentation(), ""); assert.deepEqual(h.notices, []);
    const current = await h.start(); assert.equal(current.projectId, "project-B");
    await h.settle(current, "success", "current project B");
    assert.match(h.presentation(), /current project B/); assert.deepEqual(h.notices, [{ kind: "success", message: "current project B" }]);
  });
}
