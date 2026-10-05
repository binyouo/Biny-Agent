/** Deferred IPC fakes exercise visible settings state; no plugins are installed or executed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import type { DesktopPluginRegistrySnapshot, DesktopPluginSummary, DesktopSkillCatalogSnapshot, DesktopSkillFilePreview } from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function catalog(name = ""): DesktopSkillCatalogSnapshot {
  return { skills: [], inventory: [], unmanagedSkills: [], managedSources: [], warnings: [], diagnostics: [],
    plugins: name ? [{ id: name, name, path: `.biny/plugins/${name}`, scope: "project", status: "disabled",
      moduleCount: 1, managed: true, enabled: false }] : [] };
}

function registry(name = ""): DesktopPluginRegistrySnapshot {
  return { registryUrl: "https://example.invalid/registry.json", stale: false,
    plugins: name ? [{ id: name, name, version: "1", category: "Test", description: "", details: "", tags: [],
      repository: "https://example.invalid/inert", path: name, featured: false }] : [] };
}

async function harness(api: Record<string, unknown> = {}) {
  const imports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { biny: { skillCatalog: async () => catalog(), pluginRegistry: async () => registry(),
    refreshPluginRegistry: async () => registry(), skillVersion: async () => undefined, ...api } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsExtensionsView } = await import("../src/desktop/renderer/src/components/settings/SettingsExtensionsView.js");
  const { SettingsDraftContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const root = createRoot(document.getElementById("root")!);
  const errors: string[] = [];
  const onError = (message: string) => errors.push(message);
  const context = {} as SettingsDraftContextValue;
  const render = async (projectId: string | undefined, kind: "plugins" | "skills" = "plugins", strict = false) => {
    const node = React.createElement(SettingsDraftContext.Provider, { value: context },
      React.createElement(SettingsExtensionsView, { kind, projectId, onError }));
    await React.act(async () => root.render(strict ? React.createElement(React.StrictMode, {}, node) : node));
  };
  const button = (label: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
    assert.ok(result, `Missing button: ${label}`); return result;
  };
  return { React, errors, render, button, text: () => document.body.textContent ?? "",
    async click(label: string) { await React.act(async () => button(label).click()); },
    async leave() { await React.act(async () => root.render(null)); },
    async close() {
      await React.act(() => root.unmount()); dom.window.close(); imports.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

test("a late initial catalog and registry cannot replace a newer plugin refresh", async () => {
  const oldCatalog = deferred<DesktopSkillCatalogSnapshot>();
  const oldRegistry = deferred<DesktopPluginRegistrySnapshot>();
  let reads = 0;
  const h = await harness({ skillCatalog: () => ++reads === 1 ? oldCatalog.promise : Promise.resolve(catalog("new-installed")),
    pluginRegistry: () => oldRegistry.promise, refreshPluginRegistry: async () => registry("new-market") });
  try {
    await h.render("project");
    await h.click("刷新");
    assert.match(h.text(), /new-installed/);
    await h.React.act(async () => { oldCatalog.resolve(catalog("old-installed")); oldRegistry.resolve(registry("old-market")); });
    assert.match(h.text(), /new-installed/);
    assert.doesNotMatch(h.text(), /old-installed/);
    await h.click("应用市场");
    assert.match(h.text(), /new-market/);
    assert.doesNotMatch(h.text(), /old-market/);
  } finally { await h.close(); }
});

test("obsolete refresh failures do not notify or release a newer refresh's loading state", async () => {
  const first = deferred<DesktopPluginRegistrySnapshot>();
  const second = deferred<DesktopPluginRegistrySnapshot>();
  let refreshes = 0;
  const h = await harness({ refreshPluginRegistry: () => ++refreshes === 1 ? first.promise : second.promise });
  try {
    await h.render("project");
    await h.click("刷新"); await h.click("刷新");
    await h.React.act(async () => first.reject(new Error("obsolete refresh failed")));
    assert.deepEqual(h.errors, []);
    assert.match(h.text(), /正在扫描本机扩展/);
    await h.React.act(async () => second.resolve(registry("current-market")));
    assert.doesNotMatch(h.text(), /正在扫描本机扩展/);
    await h.click("应用市场"); assert.match(h.text(), /current-market/);
  } finally { await h.close(); }
});

test("switching project immediately clears old cards and ignores the old pending catalog", async () => {
  const oldRefresh = deferred<DesktopSkillCatalogSnapshot>();
  const nextCatalog = deferred<DesktopSkillCatalogSnapshot>();
  let oldReads = 0;
  const h = await harness({ skillCatalog: (project: string) => project === "old"
    ? ++oldReads === 1 ? Promise.resolve(catalog("old-project")) : oldRefresh.promise : nextCatalog.promise });
  try {
    await h.render("old"); assert.match(h.text(), /old-project/);
    await h.click("刷新");
    await h.render("new");
    assert.doesNotMatch(h.text(), /old-project/);
    assert.match(h.text(), /正在扫描本机扩展/);
    await h.React.act(async () => nextCatalog.resolve(catalog("new-project")));
    await h.React.act(async () => oldRefresh.resolve(catalog("late-old-project")));
    assert.match(h.text(), /new-project/);
    assert.doesNotMatch(h.text(), /late-old-project/);
  } finally { await h.close(); }
});

for (const action of ["install", "enable", "uninstall"] as const) {
  test(`leaving settings prevents ${action} completion from starting another catalog request`, async () => {
    const mutation = deferred<DesktopPluginSummary>();
    let reads = 0;
    const h = await harness({ skillCatalog: async () => { reads++; return catalog("inert-plugin"); },
      pluginRegistry: async () => registry("inert-plugin"), installPlugin: () => mutation.promise,
      setPluginEnabled: () => mutation.promise, uninstallPlugin: () => mutation.promise });
    try {
      await h.render("project");
      if (action === "install") { await h.click("应用市场"); await h.click("安装"); }
      else if (action === "uninstall") await h.click("卸载");
      else {
        const toggle = document.querySelector<HTMLButtonElement>('[aria-label="启用插件 inert-plugin"]');
        assert.ok(toggle);
        await h.React.act(async () => toggle.click());
      }
      await h.leave();
      await h.React.act(async () => mutation.resolve(catalog("inert-plugin").plugins[0]!));
      assert.equal(reads, 1, "a disposed view must not start a new catalog request");
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test("leaving settings suppresses a pending catalog failure", async () => {
  const pending = deferred<DesktopSkillCatalogSnapshot>();
  const h = await harness({ skillCatalog: () => pending.promise });
  try {
    await h.render("project"); await h.leave();
    await h.React.act(async () => pending.reject(new Error("closed view failed")));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("a current load failure releases loading and allows a successful retry", async () => {
  let reads = 0;
  const h = await harness({ skillCatalog: async () => {
    if (++reads === 1) throw new Error("current load failed");
    return catalog("recovered-plugin");
  } });
  try {
    await h.render("project");
    assert.deepEqual(h.errors, ["current load failed"]);
    assert.doesNotMatch(h.text(), /正在扫描本机扩展/);
    await h.click("刷新");
    assert.match(h.text(), /recovered-plugin/);
  } finally { await h.close(); }
});


test("an older successful refresh cannot release the latest request's loading state", async () => {
  const old = deferred<DesktopPluginRegistrySnapshot>();
  const latest = deferred<DesktopPluginRegistrySnapshot>();
  let calls = 0;
  const h = await harness({ refreshPluginRegistry: () => ++calls === 1 ? old.promise : latest.promise });
  try {
    await h.render("project"); await h.click("刷新"); await h.click("刷新");
    await h.React.act(async () => old.resolve(registry()));
    assert.match(h.text(), /正在扫描本机扩展/);
    await h.React.act(async () => latest.resolve(registry()));
    assert.doesNotMatch(h.text(), /正在扫描本机扩展/);
  } finally { await h.close(); }
});

test("project changes isolate pending mutations and failures while current actions recover", async () => {
  const old = deferred<DesktopPluginSummary>();
  const current = deferred<DesktopPluginSummary>();
  const calls: string[] = [];
  const h = await harness({ skillCatalog: async (project: string) => { calls.push(project); return catalog(project); },
    setPluginEnabled: (project: string) => project === "old" ? old.promise : current.promise });
  const toggle = (): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(button); return button;
  };
  try {
    await h.render("old"); await h.React.act(async () => toggle().click());
    await h.render("new"); assert.equal(toggle().disabled, false);
    await h.React.act(async () => toggle().click());
    assert.equal(toggle().disabled, true);
    await h.React.act(async () => old.reject(new Error("old mutation failed")));
    assert.equal(toggle().disabled, true);
    assert.deepEqual(h.errors, []); assert.deepEqual(calls, ["old", "new"]);
    await h.React.act(async () => current.reject(new Error("current mutation failed")));
    assert.equal(toggle().disabled, false);
    assert.deepEqual(h.errors, ["current mutation failed"]);
  } finally { await h.close(); }
});

function skillCatalog(): DesktopSkillCatalogSnapshot {
  const skill = { id: "shared-skill", ref: "global:shared-skill", name: "Shared skill", description: "", scope: "global" as const,
    source: "biny" as const, engine: "biny" as const, linkedEngines: [], precedence: 1,
    absolutePath: "/inert/skill", mdPath: "/inert/skill/SKILL.md", frontmatter: {},
    files: [{ name: "SKILL.md", path: "SKILL.md", kind: "file" as const, size: 1 }] };
  return { ...catalog(), skills: [skill], inventory: [skill] };
}

test("project changes clear expanded skill previews and ignore obsolete preview failures", async () => {
  const oldPreview = deferred<DesktopSkillFilePreview>();
  const newPreview = deferred<DesktopSkillFilePreview>();
  let reads = 0;
  const h = await harness({ skillCatalog: async () => skillCatalog(),
    readSkillFile: () => ++reads === 1 ? oldPreview.promise : newPreview.promise });
  try {
    await h.render("old", "skills"); await h.click("查看内容");
    assert.match(h.text(), /正在读取内容/);
    await h.render("new", "skills");
    assert.ok(h.button("查看内容"));
    assert.doesNotMatch(h.text(), /正在读取内容/);
    await h.click("查看内容");
    await h.React.act(async () => oldPreview.reject(new Error("obsolete preview failed")));
    assert.deepEqual(h.errors, []); assert.match(h.text(), /正在读取内容/);
    await h.React.act(async () => newPreview.resolve({ path: "SKILL.md", content: "current-preview", bytes: 15, binary: false, truncated: false }));
    assert.match(h.text(), /current-preview/);
  } finally { await h.close(); }
});

test("Strict Mode setup replay leaves only the current catalog result eligible", async () => {
  const old = deferred<DesktopSkillCatalogSnapshot>();
  let reads = 0;
  const h = await harness({ skillCatalog: () => ++reads === 1 ? old.promise : Promise.resolve(catalog("current-strict")) });
  try {
    await h.render("project", "plugins", true);
    assert.equal(reads, 2);
    assert.match(h.text(), /current-strict/);
    await h.React.act(async () => old.resolve(catalog("obsolete-strict")));
    assert.match(h.text(), /current-strict/);
    assert.doesNotMatch(h.text(), /obsolete-strict/);
  } finally { await h.close(); }
});

test("removing the selected project invalidates pending reads without starting another", async () => {
  const old = deferred<DesktopSkillCatalogSnapshot>();
  let reads = 0;
  const h = await harness({ skillCatalog: () => { reads++; return old.promise; } });
  try {
    await h.render("old"); await h.render(undefined);
    assert.match(h.text(), /请先打开一个项目/);
    assert.equal(reads, 1);
    await h.React.act(async () => old.reject(new Error("removed project failed")));
    assert.deepEqual(h.errors, []);
    assert.match(h.text(), /请先打开一个项目/);
  } finally { await h.close(); }
});
