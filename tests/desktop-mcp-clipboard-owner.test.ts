/** Real MCP editor; clipboard reads and all desktop requests are synthetic boundaries. */
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import type { DesktopApi, DesktopMcpServerDraft, DesktopMcpServerSummary, DesktopMcpSnapshot } from "../src/desktop/protocol.js";

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
type CloseMethod = "cancel" | "close" | "escape" | "backdrop";

async function fixture(t: TestContext, overrides: Partial<Pick<DesktopApi, "mcpUpsertServer" | "mcpSnapshot">> = {}) {
  const capabilities: Array<string | undefined> = [];
  const notices: Array<{ kind: "error" | "success"; message: string }> = [];
  const api = {
    mcpSnapshot: async () => structuredClone(snapshot),
    mcpRefreshCatalog: async () => structuredClone(snapshot.catalog),
    ...overrides
  } satisfies Pick<DesktopApi, "mcpSnapshot" | "mcpRefreshCatalog">;
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
  const onError = (message: string) => { notices.push({ kind: "error", message }); };
  const onSuccess = (message: string) => { notices.push({ kind: "success", message }); };
  const onCapabilitiesChanged = (projectId?: string) => { capabilities.push(projectId); };
  const render = async (host: HTMLElement | null = document.getElementById("details"), projectId = "project-A") => {
    await step(() => root.render(React.createElement(SettingsDetailHostContext.Provider,
      { value: host }, React.createElement(McpServersView, { projectId, onError, onSuccess, onCapabilitiesChanged }))));
  };
  await render();
  return { notices, capabilities, click, fill, field, close, unmount, render };
}



const importedText = (name = "imported") => JSON.stringify({ mcpServers: { [name]: { command: `${name}-command`, args: [] } } });
type ReadOutcome = "valid" | "invalid" | "reject";
async function clipboardFixture(t: TestContext, overrides: Parameters<typeof fixture>[1] = {}) {
  const reads: Array<ReturnType<typeof deferred<string>>> = [];
  const previous = Object.getOwnPropertyDescriptor(dom.window.navigator, "clipboard");
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: {
    readText: () => { const read = deferred<string>(); reads.push(read); return read.promise; }
  } });
  const h = await fixture(t, overrides);
  t.after(async () => {
    await h.unmount();
    await React.act(async () => { for (const read of reads) read.resolve("{}"); });
    await Promise.allSettled(reads.map(read => read.promise));
    if (previous) Object.defineProperty(dom.window.navigator, "clipboard", previous);
    else Reflect.deleteProperty(dom.window.navigator, "clipboard");
  });
  const finish = async (index: number, outcome: ReadOutcome = "valid", name = "imported") => {
    await React.act(async () => {
      if (outcome === "reject") reads[index]!.reject(new Error("synthetic clipboard rejection"));
      else reads[index]!.resolve(outcome === "invalid" ? "{}" : importedText(name));
    });
  };
  const read = async () => { const count = reads.length; await h.click("从剪贴板导入"); assert.equal(reads.length, count + 1); };
  return { ...h, reads, read, finish };
}

for (const outcome of ["valid", "invalid", "reject"] as const) {
  test(`current clipboard read reports ${outcome}`, async t => {
    const h = await clipboardFixture(t); await h.click("编辑 A"); await h.read(); await h.finish(0, outcome);
    if (outcome === "valid") {
      assert.equal(h.field("服务器名称").value, "imported");
      assert.equal(h.field("命令").value, "imported-command");
      assert.deepEqual(h.notices, [{ kind: "success", message: "已从剪贴板导入 MCP 配置，请检查后保存。" }]);
    } else {
      assert.equal(h.field("命令").value, "synthetic-A");
      assert.deepEqual(h.notices, [{ kind: "error", message: outcome === "invalid" ? "剪贴板中没有可识别的 MCP 配置。" : "synthetic clipboard rejection" }]);
    }
  });
  for (const destination of ["edited", "draft-ABA", "B", "closed", "host-hidden", "host-reopened", "project", "unmounted"] as const) {
    test(`clipboard ${outcome} is retired after ${destination}`, async t => {
      const h = await clipboardFixture(t); await h.click("编辑 A"); await h.read();
      if (destination === "B") { await h.close("cancel"); await h.click("编辑 B"); }
      if (destination === "edited" || destination === "draft-ABA" || destination === "B") await h.fill("命令", "new user text");
      if (destination === "draft-ABA") await h.fill("命令", "synthetic-A");
      if (destination === "closed") await h.close("cancel");
      if (destination === "host-hidden" || destination === "host-reopened") await h.render(null);
      if (destination === "host-reopened") await h.render();
      if (destination === "project") await h.render(document.getElementById("details"), "project-B");
      if (destination === "unmounted") await h.unmount();
      await h.finish(0, outcome);
      assert.deepEqual(h.notices, [], "Retired read is not a configuration write and must stay silent");
      if (destination === "closed" || destination === "unmounted") {
        assert.equal(document.querySelector(".biny-mcp-dialog") === null, true); return;
      }
      if (destination === "host-hidden") await h.render();
      assert.equal(h.field("服务器名称").value, destination === "B" ? "B" : "A");
      assert.equal(h.field("命令").value, destination === "edited" || destination === "B" ? "new user text" : "synthetic-A");
      // Retiring one read must not disable a fresh explicit import.
      await h.read(); await h.finish(1, "valid", "current");
      assert.equal(h.field("命令").value, "current-command");
    });
  }
}

for (const outcome of ["valid", "invalid", "reject"] as const) {
  test(`older repeated clipboard ${outcome} cannot replace the latest import`, async t => {
    const h = await clipboardFixture(t); await h.click("编辑 A"); await h.read(); await h.read();
    await h.finish(1, "valid", "newer"); const notices = structuredClone(h.notices);
    await h.finish(0, outcome, "older");
    assert.equal(h.field("命令").value, "newer-command"); assert.deepEqual(h.notices, notices);
  });
}

test("replacing a still-visible host element preserves the clipboard owner", async t => {
  const h = await clipboardFixture(t); await h.click("编辑 A"); await h.read();
  const replacement = document.createElement("div"); document.body.append(replacement);
  try { await h.render(replacement); await h.finish(0); assert.equal(h.field("命令").value, "imported-command"); }
  finally { await h.unmount(); replacement.remove(); }
});

for (const first of ["save", "clipboard"] as const) {
  test(`${first} completion preserves the other operation's ownership`, async t => {
    const save = deferred<DesktopMcpSnapshot>();
    const submitted: DesktopMcpServerDraft[] = [];
    const h = await clipboardFixture(t, { mcpUpsertServer: async (_project, _original, draft) => {
      submitted.push(structuredClone(draft)); return await save.promise;
    } });
    t.after(async () => { await React.act(async () => save.resolve(structuredClone(snapshot))); });
    await h.click("编辑 A"); await h.read(); await h.click("保存");
    assert.equal(submitted[0]!.command, "synthetic-A", "Only the submitted draft crosses the inert save boundary");
    if (first === "save") {
      await React.act(async () => save.resolve(structuredClone(snapshot)));
      assert.equal(document.querySelector(".biny-mcp-dialog") === null, true);
      await h.finish(0);
      assert.equal(document.querySelector(".biny-mcp-dialog") === null, true);
      assert.deepEqual(h.notices, [{ kind: "success", message: "MCP 服务器已保存。" }]);
    } else {
      await h.finish(0);
      await React.act(async () => save.resolve(structuredClone(snapshot)));
      assert.equal(h.field("命令").value, "imported-command", "An explicit import that completes while save is pending remains an unsaved new draft");
      assert.deepEqual(h.notices.map(item => item.message), ["已从剪贴板导入 MCP 配置，请检查后保存。", "MCP 服务器已保存。"]);
    }
    assert.equal(submitted.length, 1, "Clipboard never dispatches an automatic save");
  });
}

for (const outcome of ["valid", "invalid", "reject"] as const) {
  test(`older clipboard ${outcome} cannot publish while its replacement is still pending`, async t => {
    const h = await clipboardFixture(t); await h.click("编辑 A"); await h.read(); await h.read();
    await h.finish(0, outcome, "older");
    assert.equal(h.field("命令").value, "synthetic-A"); assert.deepEqual(h.notices, []);
    await h.finish(1, "valid", "newer");
    assert.equal(h.field("命令").value, "newer-command");
    assert.deepEqual(h.notices, [{ kind: "success", message: "已从剪贴板导入 MCP 配置，请检查后保存。" }]);
  });
}
