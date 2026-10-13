/** Backend version operations are deferred IPC fakes; no actual skills are changed. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopSkillCatalogSnapshot, DesktopSkillFilePreview } from "../src/desktop/protocol.js";
import type { ManagedSkillVersion } from "../src/extensions/skillVersions.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const initialVersion: ManagedSkillVersion = {
  format: 1, id: "11111111-1111-4111-8111-111111111111", previous: "22222222-2222-4222-8222-222222222222", name: "alpha",
  revision: "a".repeat(40), digest: "a".repeat(64), installedAt: "2026-01-01T00:00:00.000Z",
  source: { owner: "example", repository: "inert", branch: "main", directory: "alpha" }
};
const nextVersion: ManagedSkillVersion = { ...initialVersion, id: initialVersion.previous!, revision: "b".repeat(40) };
function catalog(names = ["Alpha"]): DesktopSkillCatalogSnapshot {
  const skills = names.map(name => ({ id: name, ref: `global:${name}`, name, description: "", scope: "global" as const,
    source: "biny" as const, engine: "biny" as const, linkedEngines: [], precedence: 1,
    absolutePath: `/inert/${name}`, mdPath: `/inert/${name}/SKILL.md`, frontmatter: {},
    files: [{ name: "SKILL.md", path: "SKILL.md", kind: "file" as const, size: 1 }] }));
  return { skills, inventory: skills, plugins: [], unmanagedSkills: [], warnings: [], diagnostics: [] };
}
const preview = (content: string): DesktopSkillFilePreview => ({ path: "SKILL.md", content, bytes: content.length, binary: false, truncated: false });

async function harness(api: Record<string, unknown> = {}) {
  const imports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom"); const React = await import("react");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const catalogs: Array<string | undefined> = []; const reads: string[] = []; const mutations: Array<[string, string]> = [];
  const mutation = deferred<unknown>(); let version = initialVersion;
  Object.assign(dom.window, { biny: {
    skillCatalog: async (project?: string) => { catalogs.push(project); return catalog(); },
    skillVersion: async () => version,
    readSkillFile: async (id: string) => { reads.push(id); return preview(version.id === initialVersion.id ? "before-version-change" : "after-version-change"); },
    updateSkillVersion: async (id: string, expected: string) => { mutations.push([id, expected]); return await mutation.promise; },
    rollbackSkillVersion: async (id: string, expected: string) => { mutations.push([id, expected]); return await mutation.promise; },
    ...api
  } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsExtensionsView } = await import("../src/desktop/renderer/src/components/settings/SettingsExtensionsView.js");
  const { SettingsDraftContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const root = createRoot(document.getElementById("root")!); const errors: string[] = [];
  const onError = (message: string) => errors.push(message);
  return { React, errors, catalogs, reads, mutations, text: () => document.body.textContent ?? "",
    async render(_view: "settings" = "settings", projectId = "project") {
      const node = React.createElement(SettingsDraftContext.Provider, { value: {} as SettingsDraftContextValue },
        React.createElement(SettingsExtensionsView, { kind: "skills", projectId, onError }));
      await React.act(async () => root.render(node));
    },
    async toggle(name = "Alpha") {
      const card = [...document.querySelectorAll(".settings-skill-card")].find(element => element.querySelector("h4")?.textContent === name);
      const button = card?.querySelector<HTMLButtonElement>(".settings-skill-content-toggle"); assert.ok(button, name);
      await React.act(async () => button.click());
    },
    async click(label: string) {
      const button = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label); assert.ok(button, label);
      await React.act(async () => button.click());
    },
    async finish(rollback = false) {
      version = nextVersion;
      await React.act(async () => mutation.resolve(rollback ? version : { version }));
    },
    async fail() { await React.act(async () => mutation.reject(new Error("fixture version failure"))); },
    async leave() { await React.act(async () => root.render(null)); },
    async close() {
      await React.act(() => root.unmount()); dom.window.close(); imports.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

for (const rollback of [false, true]) {
  test(`settings invalidates cached content when ${rollback ? "rollback" : "update"} completes after collapse`, async () => {
    const h = await harness();
    try {
      await h.render(); await h.toggle(); assert.match(h.text(), /before-version-change/);
      await h.click(rollback ? "回滚上一版本" : "检查并更新"); await h.toggle(); await h.finish(rollback);
      await h.toggle(); assert.match(h.text(), /after-version-change/); assert.doesNotMatch(h.text(), /before-version-change/);
      assert.deepEqual(h.mutations, [["Alpha", initialVersion.id]]); assert.equal(h.catalogs.length, 2); assert.equal(h.reads.length, 2);
    } finally { await h.close(); }
  });
}

test("completion from replaced controls invalidates the surviving settings parent's preview", async () => {
  const h = await harness();
  try {
    await h.render(); await h.toggle(); await h.click("检查并更新"); await h.toggle(); await h.toggle();
    assert.match(h.text(), /before-version-change/);
    await h.finish(); await h.toggle();
    assert.match(h.text(), /after-version-change/); assert.doesNotMatch(h.text(), /before-version-change/);
    assert.equal(h.catalogs.length, 2);
  } finally { await h.close(); }
});

test("a completed old-project mutation cannot collapse or reload a new settings parent", async () => {
  const h = await harness();
  try {
    await h.render("settings", "old"); await h.toggle(); await h.click("检查并更新");
    await h.render("settings", "new"); await h.toggle();
    await h.finish();
    assert.deepEqual(h.catalogs, ["old", "new"]); assert.deepEqual(h.errors, []);
    assert.ok(document.querySelector('[aria-expanded="true"]'));
    assert.match(h.text(), /before-version-change/);
  } finally { await h.close(); }
});

for (const view of ["settings"] as const) {
  for (const failure of [false, true]) {
    test(`${view} parent disposal suppresses detached mutation ${failure ? "errors" : "reloads"}`, async () => {
      const h = await harness();
      try {
        await h.render(view); if (view === "settings") await h.toggle();
        await h.click("检查并更新"); await h.leave();
        if (failure) await h.fail(); else await h.finish();
        assert.equal(h.catalogs.length, 1); assert.deepEqual(h.errors, []);
      } finally { await h.close(); }
    });
  }
}

test("detached failure keeps a valid completed cache and does not report to the surviving parent", async () => {
  const h = await harness();
  try {
    await h.render(); await h.toggle(); await h.click("检查并更新"); await h.toggle(); await h.fail(); await h.toggle();
    assert.equal(h.catalogs.length, 1); assert.equal(h.reads.length, 1); assert.deepEqual(h.errors, []);
    assert.match(h.text(), /before-version-change/);
  } finally { await h.close(); }
});

test("current controls still report a mutation error and release their busy state", async () => {
  const h = await harness();
  try {
    await h.render(); await h.toggle(); await h.click("检查并更新"); await h.fail();
    assert.deepEqual(h.errors, ["fixture version failure"]); assert.equal(h.catalogs.length, 1);
    const button = [...document.querySelectorAll("button")].find(element => element.textContent === "检查并更新");
    assert.ok(button); assert.equal(button.disabled, false);
  } finally { await h.close(); }
});

test("returning to the same project creates a new parent that ignores the original mutation callback", async () => {
  const h = await harness();
  try {
    await h.render("settings", "old"); await h.toggle(); await h.click("检查并更新");
    await h.render("settings", "other"); await h.render("settings", "old"); await h.toggle(); await h.finish();
    assert.deepEqual(h.catalogs, ["old", "other", "old"]); assert.deepEqual(h.errors, []);
    assert.ok(document.querySelector('[aria-expanded="true"]'));
  } finally { await h.close(); }
});

test("detached Alpha completion preserves Beta's pending settings preview and invalidates only Alpha", async () => {
  const beta = deferred<DesktopSkillFilePreview>(); const reads: string[] = [];
  const h = await harness({ skillCatalog: async () => catalog(["Alpha", "Beta"]),
    readSkillFile: (id: string) => { reads.push(id); return id === "Beta" ? beta.promise : Promise.resolve(preview(`Alpha-${reads.length}`)); } });
  try {
    await h.render(); await h.toggle("Alpha"); await h.click("检查并更新"); await h.toggle("Beta"); await h.finish();
    assert.ok(document.querySelector('[aria-label="Beta 内容"]')); assert.match(h.text(), /正在读取内容/);
    await h.React.act(async () => beta.resolve(preview("Beta current preview"))); assert.match(h.text(), /Beta current preview/);
    await h.toggle("Beta"); await h.toggle("Beta"); assert.deepEqual(reads, ["Alpha", "Beta"]);
    await h.toggle("Alpha"); assert.deepEqual(reads, ["Alpha", "Beta", "Alpha"]);
  } finally { await h.close(); }
});
