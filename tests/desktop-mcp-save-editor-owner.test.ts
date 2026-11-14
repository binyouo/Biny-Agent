/** Real MCP editor and detail-layer events; every desktop request is inert. */
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


async function savingFixture(t: TestContext) {
  const committed = structuredClone(snapshot);
  let snapshotReads = 0;
  const saves: Array<ReturnType<typeof deferred<DesktopMcpSnapshot>> & { projectId?: string; original?: string; draft: DesktopMcpServerDraft }> = [];
  const h = await fixture(t, {
    mcpSnapshot: async projectId => {
      snapshotReads += 1;
      const next = structuredClone(committed);
      if (projectId === "project-B") next.servers[0]!.commandOrUrl = "project-B-command";
      if (projectId === "project-A" && snapshotReads > 2) next.servers[0]!.commandOrUrl = "returned-project-A";
      return next;
    },
    mcpUpsertServer: async (projectId, original, draft) => {
      const pending = { ...deferred<DesktopMcpSnapshot>(), projectId, original, draft: structuredClone(draft) };
      saves.push(pending);
      const target = committed.servers.find(item => item.name === original);
      assert.ok(target);
      target.commandOrUrl = draft.command!;
      committed.configRevision = `committed-${saves.length}`;
      committed.saved = { runtimeRefresh: "completed" };
      return await pending.promise;
    }
  });
  t.after(async () => {
    await h.unmount();
    await React.act(async () => { for (const pending of saves) pending.resolve(structuredClone(committed)); });
    await Promise.allSettled(saves.map(pending => pending.promise));
  });
  const finish = async (index = 0, failure = false) => {
    const pending = saves[index]!;
    await React.act(async () => {
      if (failure) pending.reject(new Error("synthetic save rejected"));
      else pending.resolve(structuredClone(committed));
    });
  };
  const start = async () => {
    await h.click("编辑 A");
    await h.fill("命令", "saved-A");
    await h.click("保存");
    assert.equal(saves.length, 1);
    assert.equal(saves[0]!.projectId, "project-A");
    assert.equal(saves[0]!.original, "A");
    assert.equal(committed.servers[0]!.commandOrUrl, "saved-A", "IPC boundary has committed A before its delayed response");
  };
  return { ...h, saves, committed, finish, startSave: start };
}

for (const destination of ["B", "same-editor", "draft-ABA", "project", "project-ABA", "host-hidden", "host-reopened", "unmounted"] as const) {
  test(`save completion preserves newer editor ownership: ${destination}`, async t => {
    const h = await savingFixture(t);
    await h.startSave();
    if (destination === "B") { await h.close("cancel"); await h.click(`编辑 ${destination}`); }
    if (destination === "project" || destination === "project-ABA") await h.render(document.getElementById("details"), "project-B");
    if (destination === "project-ABA") await h.render();
    if (destination === "unmounted") await h.unmount();
    else await h.fill("命令", "new-user-draft");
    if (destination === "draft-ABA") await h.fill("命令", "saved-A");
    if (destination === "host-hidden" || destination === "host-reopened") await h.render(null);
    if (destination === "host-reopened") await h.render();
    await h.finish();
    assert.equal(h.capabilities.length, 1, "Committed settings still refresh capabilities");
    assert.deepEqual(h.capabilities, [undefined], "Global configuration invalidates all capabilities");
    assert.deepEqual(h.notices, [{ kind: "success", message: "MCP 服务器已保存。" }], "Committed save is still reported");
    if (destination === "unmounted") { assert.equal(document.querySelector(".biny-mcp-dialog"), null); return; }
    if (destination === "host-hidden") await h.render();
    assert.equal(h.field("命令").value, destination === "draft-ABA" ? "saved-A" : "new-user-draft", "Newly accepted input remains visible");
    // Busy ownership ends even though the old editor's presentation was retired.
    if (destination === "B" || destination === "same-editor") {
      await h.click("保存");
      assert.equal(h.saves[1]!.draft.command, "new-user-draft");
      await h.finish(1);
      assert.equal(document.querySelector(".biny-mcp-dialog"), null);
    }
    if (destination === "project" || destination === "project-ABA") {
      await h.close("cancel"); await h.click("编辑 A");
      assert.equal(h.field("命令").value, destination === "project" ? "project-B-command" : "returned-project-A", "Old project snapshot cannot overwrite the current project's projection");
    }
  });
}

for (const failure of [false, true]) {
  test(`current save ${failure ? "failure retains draft and retry" : "success closes editor"}`, async t => {
    const h = await savingFixture(t); await h.startSave(); await h.finish(0, failure);
    if (!failure) {
      assert.equal(document.querySelector(".biny-mcp-dialog"), null);
      assert.deepEqual(h.notices, [{ kind: "success", message: "MCP 服务器已保存。" }]);
    } else {
      assert.equal(h.field("命令").value, "saved-A");
      assert.deepEqual(h.notices, [{ kind: "error", message: "synthetic save rejected" }]);
      await h.click("保存"); await h.finish(1);
      assert.equal(document.querySelector(".biny-mcp-dialog"), null);
    }
  });
}

test("retired save failure leaves B editable and preserves save failure feedback", async t => {
  const h = await savingFixture(t); await h.startSave();
  await h.close("cancel"); await h.click("编辑 B"); await h.fill("命令", "B retry draft");
  await h.finish(0, true);
  assert.equal(h.field("命令").value, "B retry draft"); assert.deepEqual(h.notices, [{ kind: "error", message: "synthetic save rejected" }]);
  await h.click("保存"); await h.finish(1);
  assert.equal(document.querySelector(".biny-mcp-dialog"), null);
});

test("same-name busy card cannot be reopened until its save settles", async t => {
  const h = await savingFixture(t); await h.startSave(); await h.close("cancel");
  assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="编辑 A"]')!.disabled, true);
  await h.finish(); await h.click("编辑 A");
  assert.equal(h.field("命令").value, "saved-A");
});

for (const runtimeRefresh of ["failed", "not_needed"] as const) {
  test(`cross-project committed save preserves ${runtimeRefresh} feedback`, async t => {
    const h = await savingFixture(t); await h.startSave();
    await h.render(document.getElementById("details"), "project-B");
    h.committed.saved = { runtimeRefresh, message: runtimeRefresh === "failed" ? "连接刷新失败，请重试" : undefined };
    await h.finish();
    assert.deepEqual(h.capabilities, runtimeRefresh === "failed" ? [undefined] : []);
    assert.deepEqual(h.notices.filter(item => item.kind === "error"), runtimeRefresh === "failed" ? [{ kind: "error", message: "连接刷新失败，请重试" }] : []);
    assert.deepEqual(h.notices.filter(item => item.kind === "success"), [{ kind: "success", message: "MCP 服务器已保存。" }]);
    assert.ok(document.querySelector(".biny-mcp-dialog"));
  });
}
