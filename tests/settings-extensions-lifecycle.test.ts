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
  return { skills: [], inventory: [], unmanagedSkills: [], warnings: [], diagnostics: [],
    plugins: name ? [{ id: name, name, path: `.biny/plugins/${name}`, scope: "project", status: "disabled",
      moduleCount: 1, managed: true, enabled: false, pluginId: name }] : [] };
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
  Object.assign(dom.window, { biny: { skillCatalog: async () => catalog(), pluginCatalog: async () => catalog(), pluginRegistry: async () => registry(),
    refreshPluginRegistry: async () => registry(), skillVersion: async () => undefined, ...api } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsExtensionsView } = await import("../src/desktop/renderer/src/components/settings/SettingsExtensionsView.js");
  const { SettingsDraftContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const { SettingsDetailHostContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js");
  const dialogHost = document.createElement("div");
  document.body.append(dialogHost);
  const root = createRoot(document.getElementById("root")!);
  const errors: string[] = [];
  const onError = (message: string) => errors.push(message);
  const context = {} as SettingsDraftContextValue;
  const render = async (projectId: string | undefined, kind: "plugins" | "skills" = "plugins", strict = false, active = true) => {
    const node = React.createElement(SettingsDraftContext.Provider, { value: context },
      React.createElement(SettingsDetailHostContext.Provider, { value: dialogHost },
        React.createElement(SettingsExtensionsView, { active, kind, projectId, onError })));
    await React.act(async () => root.render(strict ? React.createElement(React.StrictMode, {}, node) : node));
  };
  const button = (label: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
    assert.ok(result, `Missing button: ${label}`); return result;
  };
  const tab = (label: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(element => element.textContent?.trim().startsWith(label));
    assert.ok(result, `Missing tab: ${label}`); return result;
  };
  return { React, errors, render, button, tab, text: () => document.body.textContent ?? "",
    async clickTab(label: string) { await React.act(async () => tab(label).click()); },
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

test("an inactive settings page ignores a late catalog failure and reloads when reactivated; unmount tests miss retained pages", async () => {
  const old = deferred<DesktopSkillCatalogSnapshot>();
  let reads = 0;
  const h = await harness({ pluginCatalog: () => ++reads === 1 ? old.promise : Promise.resolve(catalog("current-plugin")) });
  try {
    await h.render("project");
    await h.render("project", "plugins", false, false);
    await h.React.act(async () => { old.reject(new Error("inactive catalog failed")); await old.promise.catch(() => {}); });
    assert.deepEqual(h.errors, [], "hidden-page failures must not become notifications for the current page");
    assert.equal(reads, 1);
    await h.render("project");
    assert.equal(reads, 2);
    assert.match(h.text(), /current-plugin/u);
  } finally { await h.close(); }
});

test("managed plugins render without waiting on their background registry read, which the market tab reuses", async () => {
  const market = deferred<DesktopPluginRegistrySnapshot>();
  let skillReads = 0;
  let marketReads = 0;
  const h = await harness({
    skillCatalog: async () => { skillReads++; return catalog("local-installed"); },
    pluginCatalog: async () => catalog("local-installed"),
    pluginRegistry: () => { marketReads++; return market.promise; }
  });
  try {
    await h.render("project");
    assert.match(h.text(), /local-installed/u, "local plugins do not depend on a market receipt");
    assert.equal(skillReads, 0);
    assert.equal(marketReads, 1, "managed plugins trigger one background registry read for update checks");
    await h.clickTab("应用市场");
    assert.equal(marketReads, 1, "switching tabs reuses the in-flight read instead of reissuing it");
    await h.clickTab("已安装");
    assert.match(h.text(), /local-installed/u);
    await h.React.act(async () => market.resolve(registry("market-result")));
    assert.match(h.text(), /local-installed/u);
  } finally { await h.close(); }
});

test("an installed list of only unmanaged plugins does not read the registry until the market opens", async () => {
  let marketReads = 0;
  const unmanaged = { ...catalog("loose-plugin").plugins[0]!, managed: false, pluginId: undefined };
  const h = await harness({
    pluginCatalog: async () => ({ ...catalog(), plugins: [unmanaged] }),
    pluginRegistry: () => { marketReads++; return registry(); }
  });
  try {
    await h.render("project");
    assert.match(h.text(), /loose-plugin/u);
    assert.equal(marketReads, 0);
    await h.clickTab("应用市场");
    assert.equal(marketReads, 1);
  } finally { await h.close(); }
});

test("a late initial catalog and registry cannot replace a newer plugin refresh", async () => {
  const oldCatalog = deferred<DesktopSkillCatalogSnapshot>();
  const oldRegistry = deferred<DesktopPluginRegistrySnapshot>();
  let reads = 0;
  const h = await harness({ pluginCatalog: () => ++reads === 1 ? oldCatalog.promise : Promise.resolve(catalog("new-installed")),
    pluginRegistry: () => oldRegistry.promise, refreshPluginRegistry: async () => registry("new-market") });
  try {
    await h.render("project");
    await h.clickTab("应用市场");
    await h.click("刷新");
    await h.clickTab("已安装");
    await h.click("刷新");
    assert.match(h.text(), /new-installed/);
    await h.React.act(async () => { oldCatalog.resolve(catalog("old-installed")); oldRegistry.resolve(registry("old-market")); });
    assert.match(h.text(), /new-installed/);
    assert.doesNotMatch(h.text(), /old-installed/);
    await h.clickTab("应用市场");
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
    await h.clickTab("应用市场");
    await h.click("刷新"); await h.click("刷新");
    await h.React.act(async () => first.reject(new Error("obsolete refresh failed")));
    assert.deepEqual(h.errors, []);
    assert.match(h.text(), /正在扫描本机扩展/);
    await h.React.act(async () => second.resolve(registry("current-market")));
    assert.doesNotMatch(h.text(), /正在扫描本机扩展/);
    await h.clickTab("应用市场"); assert.match(h.text(), /current-market/);
  } finally { await h.close(); }
});

test("switching project immediately clears old cards and ignores the old pending catalog", async () => {
  const oldRefresh = deferred<DesktopSkillCatalogSnapshot>();
  const nextCatalog = deferred<DesktopSkillCatalogSnapshot>();
  let oldReads = 0;
  const h = await harness({ pluginCatalog: (project: string) => project === "old"
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
    const h = await harness({ pluginCatalog: async () => { reads++; return catalog("inert-plugin"); },
      pluginRegistry: async () => registry("inert-plugin"), installPlugin: () => mutation.promise,
      setPluginEnabled: () => mutation.promise, uninstallPlugin: () => mutation.promise });
    try {
      await h.render("project");
      if (action === "install") { await h.clickTab("应用市场"); await h.click("安装"); }
      else if (action === "uninstall") {
        const trash = document.querySelector<HTMLButtonElement>('[aria-label="卸载插件 inert-plugin"]');
        assert.ok(trash);
        await h.React.act(async () => trash.click());
        await h.click("卸载");
      }
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
  const h = await harness({ pluginCatalog: () => pending.promise });
  try {
    await h.render("project"); await h.leave();
    await h.React.act(async () => pending.reject(new Error("closed view failed")));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("a current load failure releases loading and allows a successful retry", async () => {
  let reads = 0;
  const h = await harness({ pluginCatalog: async () => {
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
    await h.render("project"); await h.clickTab("应用市场"); await h.click("刷新"); await h.click("刷新");
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
  const h = await harness({ pluginCatalog: async (project: string) => { calls.push(project); return catalog(project); },
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

function pluginToggle(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    .find(candidate => candidate.getAttribute("aria-label")?.endsWith(`插件 ${name}`));
  assert.ok(button, `Missing plugin toggle: ${name}`);
  return button;
}

for (const scope of ["project", "global"] as const) {
  test(`a ${scope} plugin toggle applies its committed summary without reloading unrelated plugins`, async () => {
    const first = { ...catalog("first").plugins[0]!, scope };
    const other = { ...catalog("other").plugins[0]!, id: first.id, scope: scope === "project" ? "global" as const : "project" as const };
    let reads = 0;
    const h = await harness({
      pluginCatalog: async () => { reads++; return { ...catalog(), plugins: [first, other] }; },
      setPluginEnabled: async () => ({ ...first, enabled: true, status: "missing", moduleCount: 0, error: "Entry disappeared" })
    });
    try {
      await h.render("project");
      await h.React.act(async () => pluginToggle("first").click());
      assert.equal(reads, 1, "the single-plugin receipt must not trigger another catalog scan");
      assert.equal(pluginToggle("first").getAttribute("aria-checked"), "true");
      assert.equal(pluginToggle("other").getAttribute("aria-checked"), "false");
      assert.match(h.text(), /Entry disappeared/u, "the UI uses the complete server receipt");
    } finally { await h.close(); }
  });
}

for (const firstOutcome of ["success", "failure"] as const) {
  test(`parallel plugin toggles preserve each row when the first ${firstOutcome} arrives last`, async () => {
    const first = catalog("first").plugins[0]!;
    const second = catalog("second").plugins[0]!;
    const firstSave = deferred<DesktopPluginSummary>();
    const secondSave = deferred<DesktopPluginSummary>();
    let reads = 0;
    const h = await harness({
      pluginCatalog: async () => { reads++; return { ...catalog(), plugins: [first, second] }; },
      setPluginEnabled: (_project: string, id: string) => id === "first" ? firstSave.promise : secondSave.promise
    });
    try {
      await h.render("project");
      await h.React.act(async () => pluginToggle("first").click());
      await h.React.act(async () => pluginToggle("second").click());
      assert.equal(pluginToggle("first").disabled, true);
      assert.equal(pluginToggle("second").disabled, true);
      await h.React.act(async () => secondSave.resolve({ ...second, enabled: true, status: "configured" }));
      assert.equal(pluginToggle("first").disabled, true, "another receipt cannot release this row");
      assert.equal(pluginToggle("second").getAttribute("aria-checked"), "true");
      await h.React.act(async () => {
        if (firstOutcome === "success") firstSave.resolve({ ...first, enabled: true, status: "configured" });
        else firstSave.reject(new Error("First save failed"));
      });
      assert.equal(pluginToggle("first").disabled, false);
      assert.equal(pluginToggle("first").getAttribute("aria-checked"), firstOutcome === "success" ? "true" : "false");
      assert.equal(pluginToggle("second").getAttribute("aria-checked"), "true");
      assert.deepEqual(h.errors, firstOutcome === "success" ? [] : ["First save failed"]);
      assert.equal(reads, 1);
    } finally { await h.close(); }
  });
}

for (const reload of ["refresh", "hide-return"] as const) {
  test(`a plugin receipt applies after a pre-commit ${reload} replaced the row`, async () => {
    let authority: DesktopPluginSummary = { ...catalog("first").plugins[0]!, status: "failed", error: "Previous failure" };
    const commit = deferred<void>();
    let reads = 0;
    const h = await harness({
      pluginCatalog: async () => { reads++; return { ...catalog(), plugins: [{ ...authority }] }; },
      setPluginEnabled: async () => {
        await commit.promise;
        authority = { ...authority, enabled: true, status: "configured", error: undefined };
        return { ...authority };
      }
    });
    try {
      await h.render("project");
      await h.React.act(async () => pluginToggle("first").click());
      if (reload === "refresh") await h.click("刷新");
      else {
        await h.render("project", "plugins", false, false);
        await h.render("project");
      }
      assert.equal(pluginToggle("first").getAttribute("aria-checked"), "false");
      assert.equal(pluginToggle("first").disabled, true);
      assert.match(h.text(), /Previous failure/u);
      await h.React.act(async () => commit.resolve());
      assert.equal(authority.enabled, true, "the mutation has now committed after the catalog read");
      assert.equal(reads, 2, "the confirmed receipt does not trigger another catalog scan");
      assert.equal(pluginToggle("first").getAttribute("aria-checked"), "true");
      assert.equal(pluginToggle("first").disabled, false);
      assert.doesNotMatch(h.text(), /Previous failure/u, "the complete committed summary replaces pre-commit metadata");
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test("a plugin receipt does not recreate a row removed by a catalog refresh", async () => {
  const first = catalog("first").plugins[0]!;
  const save = deferred<DesktopPluginSummary>();
  let reads = 0;
  const h = await harness({
    pluginCatalog: async () => ++reads === 1 ? catalog("first") : catalog(),
    setPluginEnabled: () => save.promise
  });
  try {
    await h.render("project");
    await h.React.act(async () => pluginToggle("first").click());
    await h.click("刷新");
    await h.React.act(async () => save.resolve({ ...first, enabled: true, status: "configured" }));
    assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(reads, 2);
  } finally { await h.close(); }
});

test("a successful plugin receipt cannot update or release a same-id row in another project", async () => {
  const first = catalog("same-id").plugins[0]!;
  const oldSave = deferred<DesktopPluginSummary>();
  const currentSave = deferred<DesktopPluginSummary>();
  const h = await harness({
    pluginCatalog: async () => catalog("same-id"),
    setPluginEnabled: (project: string) => project === "old" ? oldSave.promise : currentSave.promise
  });
  try {
    await h.render("old");
    await h.React.act(async () => pluginToggle("same-id").click());
    await h.render("new");
    await h.React.act(async () => pluginToggle("same-id").click());
    await h.React.act(async () => oldSave.resolve({ ...first, enabled: true, status: "configured" }));
    assert.equal(pluginToggle("same-id").getAttribute("aria-checked"), "false");
    assert.equal(pluginToggle("same-id").disabled, true);
    await h.React.act(async () => currentSave.resolve({ ...first, enabled: true, status: "configured" }));
    assert.equal(pluginToggle("same-id").getAttribute("aria-checked"), "true");
    assert.equal(pluginToggle("same-id").disabled, false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("a catalog read started before a plugin receipt cannot overwrite that committed row", async () => {
  const first = catalog("first").plugins[0]!;
  const refresh = deferred<DesktopSkillCatalogSnapshot>();
  let reads = 0;
  const h = await harness({
    pluginCatalog: () => ++reads === 1 ? Promise.resolve({ ...catalog(), plugins: [first] }) : refresh.promise,
    setPluginEnabled: async () => ({ ...first, enabled: true, status: "configured" })
  });
  try {
    await h.render("project");
    await h.click("刷新");
    await h.React.act(async () => pluginToggle("first").click());
    await h.React.act(async () => refresh.resolve({ ...catalog(), plugins: [{ ...first }] }));
    assert.equal(reads, 2);
    assert.equal(pluginToggle("first").getAttribute("aria-checked"), "true");
    assert.equal(pluginToggle("first").disabled, false);
  } finally { await h.close(); }
});

test("a hidden plugin page ignores a pending toggle failure and can try again on return", async () => {
  const save = deferred<DesktopPluginSummary>();
  const h = await harness({ pluginCatalog: async () => catalog("first"), setPluginEnabled: () => save.promise });
  try {
    await h.render("project");
    await h.React.act(async () => pluginToggle("first").click());
    await h.render("project", "plugins", false, false);
    await h.React.act(async () => save.reject(new Error("Hidden save failed")));
    assert.deepEqual(h.errors, []);
    await h.render("project");
    assert.equal(pluginToggle("first").disabled, false);
    assert.equal(pluginToggle("first").getAttribute("aria-checked"), "false");
  } finally { await h.close(); }
});

function skillCatalog(): DesktopSkillCatalogSnapshot {
  const skill = { id: "shared-skill", ref: "global:shared-skill", name: "Shared skill", description: "", scope: "global" as const,
    source: "biny" as const, engine: "biny" as const, linkedEngines: [], precedence: 1,
    absolutePath: "/inert/skill", mdPath: "/inert/skill/SKILL.md", frontmatter: {},
    files: [{ name: "SKILL.md", path: "SKILL.md", kind: "file" as const, size: 1 }] };
  return { ...catalog(), skills: [skill], inventory: [skill] };
}

test("project skill content and version requests retain their project scope", async () => {
  const calls: unknown[][] = [];
  const scoped = skillCatalog();
  scoped.skills[0]!.scope = "project";
  const h = await harness({ skillCatalog: async () => scoped,
    readSkillFile: async (...args: unknown[]) => { calls.push(["file", ...args]); return { path: "SKILL.md", content: "scoped body", bytes: 11, binary: false, truncated: false }; },
    skillVersion: async (...args: unknown[]) => { calls.push(["version", ...args]); return undefined; } });
  try {
    await h.render("selected", "skills");
    await h.click("查看内容");
    assert.deepEqual(calls, [["file", "shared-skill", "SKILL.md", "selected"], ["version", "shared-skill", "selected"]]);
    assert.match(h.text(), /scoped body/u);
  } finally { await h.close(); }
});

test("returning to or refreshing skills reloads expanded content; project-change tests miss a stale preview in the same project", async () => {
  let content = "old instructions";
  let reads = 0;
  const h = await harness({ skillCatalog: async () => skillCatalog(), readSkillFile: async () => {
    reads += 1;
    return { path: "SKILL.md", content, bytes: content.length, binary: false, truncated: false };
  } });
  try {
    await h.render("project", "skills"); await h.click("查看内容");
    assert.match(h.text(), /old instructions/u);
    await h.render("project", "skills", false, false);
    content = "current English instructions";
    await h.render("project", "skills");
    assert.equal(reads, 2);
    assert.ok(h.button("收起内容"), "refresh preserves expansion");
    assert.match(h.text(), /current English instructions/u);
    assert.doesNotMatch(h.text(), /old instructions/u);
    content = "updated by manual refresh";
    await h.click("刷新");
    assert.equal(reads, 3);
    assert.match(h.text(), /updated by manual refresh/u);
  } finally { await h.close(); }
});

test("a retained hidden skill page ignores a late preview failure and reads current content on return", async () => {
  const oldPreview = deferred<DesktopSkillFilePreview>();
  const currentCatalog = deferred<DesktopSkillCatalogSnapshot>();
  let scans = 0;
  let reads = 0;
  const h = await harness({ skillCatalog: () => ++scans === 1 ? Promise.resolve(skillCatalog()) : currentCatalog.promise, readSkillFile: () => ++reads === 1 ? oldPreview.promise
    : Promise.resolve({ path: "SKILL.md", content: "current content", bytes: 15, binary: false, truncated: false }) });
  try {
    await h.render("project", "skills"); await h.click("查看内容");
    await h.render("project", "skills", false, false);
    await h.React.act(async () => { oldPreview.reject(new Error("hidden preview failed")); await oldPreview.promise.catch(() => {}); });
    assert.deepEqual(h.errors, []);
    await h.render("project", "skills");
    assert.equal(reads, 1, "wait for the fresh catalog before reading a retained entry");
    await h.React.act(async () => currentCatalog.resolve(skillCatalog()));
    assert.equal(reads, 2, "read once after the current catalog resolves");
    assert.match(h.text(), /current content/u);
    assert.doesNotMatch(h.text(), /正在读取内容/u);
  } finally { await h.close(); }
});

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
  const h = await harness({ pluginCatalog: () => ++reads === 1 ? old.promise : Promise.resolve(catalog("current-strict")) });
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
  const h = await harness({ pluginCatalog: () => { reads++; return old.promise; } });
  try {
    await h.render("old"); await h.render(undefined);
    assert.match(h.text(), /请先打开一个项目/);
    assert.equal(reads, 1);
    await h.React.act(async () => old.reject(new Error("removed project failed")));
    assert.deepEqual(h.errors, []);
    assert.match(h.text(), /请先打开一个项目/);
  } finally { await h.close(); }
});

test("plugin market reflects installation in the selected scope and keeps setup information visible", async () => {
  const installed = { ...catalog("inert-plugin").plugins[0]!, scope: "global" as const, version: "1", description: "Adds memory recall" };
  const market = registry("inert-plugin");
  market.plugins[0]!.details = "Requires a configured memory service.";
  const installs: string[] = [];
  const h = await harness({ pluginCatalog: async () => ({ ...catalog(), plugins: [installed] }),
    pluginRegistry: async () => market, installPlugin: async (_project: string, _id: string, scope: string) => { installs.push(scope); } });
  try {
    await h.render("project");
    assert.match(h.text(), /Adds memory recall/u);
    assert.doesNotMatch(h.text(), /1 个模块/u);
    await h.clickTab("应用市场");
    assert.match(h.text(), /Requires a configured memory service/u);
    const installedButton = document.querySelector<HTMLButtonElement>('[aria-label="Plugin 应用市场"] button');
    assert.equal(installedButton?.textContent, "重新安装");
    assert.equal(installedButton?.disabled, false);
    await h.clickTab("当前项目");
    await h.click("安装");
    assert.deepEqual(installs, ["project"]);
  } finally { await h.close(); }
});

test("installed plugins are grouped by location and both plugin folders remain accessible", async () => {
  const globalPlugin = { ...catalog("global-plugin").plugins[0]!, scope: "global" as const };
  const projectPlugin = catalog("project-plugin").plugins[0]!;
  const opened: string[] = [];
  const h = await harness({ pluginCatalog: async () => ({ ...catalog(), plugins: [projectPlugin, globalPlugin] }),
    openPluginDirectory: async (_project: string, scope: string) => { opened.push(scope); } });
  try {
    await h.render("project");
    const groups = [...document.querySelectorAll('[aria-label="已安装 Plugin"] section')];
    assert.equal(groups.length, 2);
    assert.match(groups[0]!.textContent ?? "", /全局插件.*global-plugin/u);
    assert.match(groups[1]!.textContent ?? "", /项目插件.*project-plugin/u);
    assert.equal(document.querySelector('[aria-label="搜索插件"]'), null);
    const menu = document.querySelector<HTMLDetailsElement>(".settings-plugin-directory-menu");
    assert.ok(menu);
    const openMenu = async () => { await h.React.act(async () => menu.querySelector("summary")!.click()); assert.equal(menu.open, true); };
    await openMenu();
    await h.click("全局文件夹");
    assert.equal(menu.open, false);
    await openMenu();
    await h.click("项目文件夹");
    assert.deepEqual(opened, ["global", "project"]);
  } finally { await h.close(); }
});

function setControlValue(element: HTMLInputElement | HTMLSelectElement, value: string, event = "input"): void {
  const view = element.ownerDocument.defaultView!;
  const prototype = element.tagName === "SELECT" ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new view.Event(event, { bubbles: true }));
}

test("an available update shows a badge and toolbar action; equal versions show neither", async () => {
  const outdated = { ...catalog("outdated").plugins[0]!, version: "1.0.0" };
  const current = { ...catalog("current").plugins[0]!, version: "1.2.0" };
  const market = { ...registry(), plugins: [
    { ...registry("outdated").plugins[0]!, version: "1.2.0" },
    { ...registry("current").plugins[0]!, version: "1.2.0" }
  ] };
  const installs: unknown[][] = [];
  const h = await harness({
    pluginCatalog: async () => ({ ...catalog(), plugins: [outdated, current] }),
    pluginRegistry: async () => market,
    installPlugin: async (...args: unknown[]) => { installs.push(args); }
  });
  try {
    await h.render("project");
    assert.match(h.text(), /全部更新 \(1\)/u);
    const card = [...document.querySelectorAll("article")].find(node => node.textContent?.includes("outdated"));
    assert.ok(card);
    assert.match(card.textContent ?? "", /v1\.2\.0/u);
    const update = [...card.querySelectorAll("button")].find(button => button.textContent?.trim() === "更新");
    assert.ok(update);
    await h.React.act(async () => update.click());
    assert.deepEqual(installs, [["project", "outdated", "project"]]);
    assert.doesNotMatch(h.text(), /全部更新 \(2\)/u);
  } finally { await h.close(); }
});

test("全部更新 runs each managed update sequentially, reports a failure, and reloads once at the end", async () => {
  const firstPlugin = { ...catalog("first").plugins[0]!, version: "1.0.0" };
  const secondPlugin = { ...catalog("second").plugins[0]!, scope: "global" as const, version: "1.0.0" };
  const market = { ...registry(), plugins: ["first", "second"].map(id => ({ ...registry(id).plugins[0]!, version: "2.0.0" })) };
  const calls: string[] = [];
  const saves = new Map<string, ReturnType<typeof deferred<DesktopPluginSummary>>>();
  let reads = 0;
  const h = await harness({
    pluginCatalog: async () => { reads++; return { ...catalog(), plugins: [firstPlugin, secondPlugin] }; },
    pluginRegistry: async () => market,
    installPlugin: (_project: string, id: string) => {
      calls.push(id);
      const save = deferred<DesktopPluginSummary>();
      saves.set(id, save);
      return save.promise;
    }
  });
  try {
    await h.render("project");
    assert.match(h.text(), /全部更新 \(2\)/u);
    const updateAll = [...document.querySelectorAll("button")].find(button => button.textContent?.includes("全部更新"));
    assert.ok(updateAll);
    await h.React.act(async () => updateAll.click());
    assert.deepEqual(calls, ["first"], "the second update must wait for the first receipt");
    const secondUninstall = document.querySelector<HTMLButtonElement>('[aria-label="卸载插件 second"]');
    assert.ok(secondUninstall?.disabled, "a queued update must reserve its row so uninstall cannot race and reinstall it");
    assert.equal(pluginToggle("second").disabled, true);
    await h.React.act(async () => saves.get("first")!.reject(new Error("first update failed")));
    assert.deepEqual(h.errors, ["first update failed"]);
    assert.deepEqual(calls, ["first", "second"], "a failed update does not stop the rest");
    await h.React.act(async () => saves.get("second")!.resolve({ ...secondPlugin }));
    assert.equal(reads, 2, "one catalog reload after the whole batch");
  } finally { await h.close(); }
});

test("plugin settings preserve unset enum values, allow decimal numbers, and clear a declared numeric default", async () => {
  const plugin: DesktopPluginSummary = {
    ...catalog("configurable").plugins[0]!,
    configuration: { properties: {
      mode: { type: "string", title: "模式", enum: ["fast", "safe"] },
      ratio: { type: "number", title: "比例", minimum: 0, maximum: 5, default: 1 }
    } }
  };
  const saves: unknown[][] = [];
  const h = await harness({
    pluginCatalog: async () => ({ ...catalog(), plugins: [plugin] }),
    setPluginSettings: async (...args: unknown[]) => { saves.push(args); return plugin; }
  });
  try {
    await h.render("project");
    await h.click("配置");
    const mode = document.querySelector<HTMLSelectElement>(".settings-plugin-config-dialog select")!;
    const ratio = document.querySelector<HTMLInputElement>('.settings-plugin-config-dialog input[type="number"]')!;
    assert.equal(mode.value, "", "an unset enum must not display a stored choice");
    await h.React.act(async () => setControlValue(ratio, "0.5"));
    assert.equal(ratio.checkValidity(), true, "fractional values satisfy a number declaration");
    await h.click("保存");
    assert.deepEqual(saves[0], ["project", "configurable", { ratio: 0.5 }, "project"]);
    await h.click("配置");
    const defaultRatio = document.querySelector<HTMLInputElement>('.settings-plugin-config-dialog input[type="number"]')!;
    assert.equal(defaultRatio.value, "1");
    await h.React.act(async () => setControlValue(defaultRatio, ""));
    assert.equal(defaultRatio.value, "", "clearing a number must leave the field editable");
    await h.click("保存");
    assert.deepEqual(saves[1], ["project", "configurable", {}, "project"]);
  } finally { await h.close(); }
});

test("removing a selected category leaves the remaining plugins reachable", async () => {
  const first = { ...catalog("first").plugins[0]!, category: "Memory" };
  const second = { ...catalog("second").plugins[0]!, category: "Tools" };
  let plugins = [first, second];
  const h = await harness({ pluginCatalog: async () => ({ ...catalog(), plugins }) });
  try {
    await h.render("project");
    await h.clickTab("Memory");
    assert.match(h.text(), /first/u);
    assert.doesNotMatch(h.text(), /second/u);
    plugins = [second];
    await h.click("刷新");
    assert.match(h.text(), /second/u);
    assert.doesNotMatch(h.text(), /该分类下没有插件/u);
  } finally { await h.close(); }
});

test("managed plugin actions use the manifest pluginId instead of the path directory name", async () => {
  const plugin = { ...catalog("legacy").plugins[0]!, path: ".biny/plugins/legacy-dir", pluginId: "legacy", version: "1.0.0" };
  const calls: unknown[][] = [];
  const market = { ...registry(), plugins: [{ ...registry("legacy").plugins[0]!, version: "2.0.0" }] };
  const h = await harness({
    pluginCatalog: async () => ({ ...catalog(), plugins: [plugin] }),
    pluginRegistry: async () => market,
    setPluginEnabled: async (...args: unknown[]) => { calls.push(["enable", ...args]); return { ...plugin, enabled: true }; },
    installPlugin: async (...args: unknown[]) => { calls.push(["update", ...args]); },
    uninstallPlugin: async (...args: unknown[]) => { calls.push(["uninstall", ...args]); }
  });
  try {
    await h.render("project");
    await h.React.act(async () => pluginToggle("legacy").click());
    const update = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "更新");
    assert.ok(update);
    await h.React.act(async () => update.click());
    const trash = document.querySelector<HTMLButtonElement>('[aria-label="卸载插件 legacy"]');
    assert.ok(trash);
    await h.React.act(async () => trash.click());
    await h.click("卸载");
    assert.deepEqual(calls, [
      ["enable", "project", "legacy", true, "project"],
      ["update", "project", "legacy", "project"],
      ["uninstall", "project", "legacy", "project"]
    ]);
  } finally { await h.close(); }
});

test("the plugin settings dialog shows stored and default values, saves the edited map, and keeps failures inline", async () => {
  const plugin: DesktopPluginSummary = {
    ...catalog("configurable").plugins[0]!,
    enabled: true,
    configuration: {
      title: "Configurable",
      properties: {
        flag: { type: "boolean", title: "启用功能", default: true },
        mode: { type: "string", title: "模式", enum: ["fast", "safe"], default: "fast" },
        note: { type: "string", title: "备注" },
        retries: { type: "number", title: "重试次数", minimum: 0, maximum: 5 }
      }
    },
    settings: { mode: "safe", retries: 3 }
  };
  let reads = 0;
  const saves: unknown[][] = [];
  const save = deferred<DesktopPluginSummary>();
  const h = await harness({
    pluginCatalog: async () => { reads++; return { ...catalog(), plugins: [plugin] }; },
    setPluginSettings: (...args: unknown[]) => { saves.push(args); return saves.length === 1 ? Promise.reject(new Error("写入失败")) : save.promise; }
  });
  try {
    await h.render("project");
    const configure = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "配置");
    assert.ok(configure, "a declared configuration opens the settings dialog");
    await h.React.act(async () => configure.click());
    const dialog = document.querySelector<HTMLElement>(".settings-plugin-config-dialog");
    assert.ok(dialog);
    const mode = dialog.querySelector<HTMLSelectElement>("select")!;
    assert.equal(mode.value, "safe", "stored values win over declaration defaults");
    const flag = dialog.querySelector<HTMLInputElement>('[role="switch"]')!;
    assert.equal(flag.checked, true, "a missing boolean falls back to its declared default");
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input.settings-field")];
    assert.equal(inputs.length, 2);
    const [note, retries] = inputs as [HTMLInputElement, HTMLInputElement];
    assert.equal(note.value, "");
    assert.equal(retries.value, "3");
    await h.React.act(async () => flag.click());
    await h.React.act(async () => setControlValue(mode, "fast", "change"));
    await h.React.act(async () => setControlValue(note, "hi"));
    await h.React.act(async () => setControlValue(retries, ""));
    await h.click("保存");
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0], ["project", "configurable", { flag: false, mode: "fast", note: "hi" }, "project"], "a cleared number omits the key");
    assert.match(dialog.textContent ?? "", /写入失败/u, "a rejected save keeps the dialog open with an inline error");
    assert.ok(dialog.querySelector('[role="alert"]'));
    assert.deepEqual(h.errors, [], "save failures do not become global notifications");
    await h.click("保存");
    assert.equal(saves.length, 2);
    await h.React.act(async () => save.resolve({ ...plugin, settings: { flag: false, mode: "fast", note: "hi" } }));
    assert.equal(document.querySelector(".settings-plugin-config-dialog"), null, "a saved receipt closes the dialog");
    assert.equal(reads, 1, "the receipt replaces the row without another catalog scan");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("a plugin without a configuration declaration has no settings entry point", async () => {
  const h = await harness({ pluginCatalog: async () => catalog("plain") });
  try {
    await h.render("project");
    assert.equal([...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "配置"), undefined);
  } finally { await h.close(); }
});

test("uninstall requires the in-app confirm; cancel makes no IPC call", async () => {
  const plugin = catalog("victim").plugins[0]!;
  const calls: unknown[][] = [];
  const h = await harness({
    pluginCatalog: async () => ({ ...catalog(), plugins: [plugin] }),
    uninstallPlugin: async (...args: unknown[]) => { calls.push(args); }
  });
  try {
    await h.render("project");
    const trash = document.querySelector<HTMLButtonElement>('[aria-label="卸载插件 victim"]');
    assert.ok(trash);
    await h.React.act(async () => trash.click());
    assert.ok(document.querySelector('[role="alertdialog"]'));
    await h.click("取消");
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.deepEqual(calls, []);
    await h.React.act(async () => trash.click());
    await h.click("卸载");
    assert.deepEqual(calls, [["project", "victim", "project"]]);
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
  } finally { await h.close(); }
});

test("installed categories filter the list and hide when only one category exists", async () => {
  const memory = { ...catalog("memory-plugin").plugins[0]!, category: "Memory" };
  const tools = { ...catalog("tool-plugin").plugins[0]!, category: "Tools" };
  const h = await harness({ pluginCatalog: async () => ({ ...catalog(), plugins: [memory, tools] }) });
  try {
    await h.render("project");
    const pills = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="插件分类"] button')];
    assert.deepEqual(pills.map(pill => pill.textContent?.trim()), ["全部", "Memory", "Tools"]);
    await h.React.act(async () => pills.find(pill => pill.textContent?.trim() === "Memory")!.click());
    assert.match(h.text(), /memory-plugin/u);
    assert.doesNotMatch(h.text(), /tool-plugin/u);
    await h.click("全部");
    assert.match(h.text(), /tool-plugin/u);
  } finally { await h.close(); }
});

test("a single installed category renders no filter pill row", async () => {
  const only = { ...catalog("only-plugin").plugins[0]!, category: "Tools" };
  const h = await harness({ pluginCatalog: async () => ({ ...catalog(), plugins: [only] }) });
  try {
    await h.render("project");
    assert.equal(document.querySelector('[aria-label="插件分类"]'), null);
  } finally { await h.close(); }
});

test("market cards show install, update, or installed actions and open sources externally", async () => {
  const older = { ...catalog("older").plugins[0]!, scope: "global" as const, version: "1.0.0" };
  const current = { ...catalog("current").plugins[0]!, scope: "global" as const, version: "1.2.0" };
  const market = { ...registry(), plugins: [
    { ...registry("fresh").plugins[0]!, name: "Fresh" },
    { ...registry("older").plugins[0]!, name: "Older", version: "1.2.0" },
    { ...registry("current").plugins[0]!, name: "Current", version: "1.2.0" }
  ] };
  const opened: string[] = [];
  const h = await harness({
    pluginCatalog: async () => ({ ...catalog(), plugins: [older, current] }),
    pluginRegistry: async () => market,
    openExternal: async (url: string) => { opened.push(url); }
  });
  try {
    await h.render("project");
    await h.clickTab("应用市场");
    assert.ok(h.button("安装"), "a missing plugin offers install");
    assert.ok(h.button("更新到 v1.2.0"), "an older installed plugin offers the registry version");
    assert.ok(h.button("重新安装"), "a current installed plugin can be reinstalled");
    assert.match(h.text(), /已安装/u);
    const source = [...document.querySelectorAll("button")].find(button => button.textContent?.includes("查看源码"));
    assert.ok(source);
    await h.React.act(async () => source.click());
    assert.equal(opened[0], "https://example.invalid/inert/tree/main/fresh");
  } finally { await h.close(); }
});
