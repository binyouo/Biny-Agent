/** Deferred renderer IPC fakes; no skill file or version operation is executed. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopSkillCatalogSnapshot, DesktopSkillFilePreview } from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function catalog(names = ["Alpha"]): DesktopSkillCatalogSnapshot {
  const skills = names.map(name => ({ id: name, ref: `global:${name}`, name, description: "", scope: "global" as const,
    source: "biny" as const, engine: "biny" as const, linkedEngines: [], precedence: 1,
    absolutePath: `/inert/${name}`, mdPath: `/inert/${name}/SKILL.md`, frontmatter: {},
    files: [{ name: "SKILL.md", path: "SKILL.md", kind: "file" as const, size: 1 }] }));
  return { skills, inventory: skills, plugins: [], unmanagedSkills: [], managedSources: [], warnings: [], diagnostics: [] };
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
  Object.assign(dom.window, { biny: { skillCatalog: async () => catalog(), skillVersion: async () => undefined, ...api } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsExtensionsView } = await import("../src/desktop/renderer/src/components/settings/SettingsExtensionsView.js");
  const { SettingsDraftContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const root = createRoot(document.getElementById("root")!); const errors: string[] = [];
  await React.act(async () => root.render(React.createElement(SettingsDraftContext.Provider, { value: {} as SettingsDraftContextValue },
    React.createElement(SettingsExtensionsView, { kind: "skills", projectId: "project", onError: message => errors.push(message) }))));
  return { React, errors, text: () => document.body.textContent ?? "",
    async toggle(name = "Alpha") {
      const card = [...document.querySelectorAll(".settings-skill-card")].find(element => element.querySelector("h4")?.textContent === name);
      const button = card?.querySelector<HTMLButtonElement>(".settings-skill-content-toggle"); assert.ok(button, name);
      await React.act(async () => button.click());
    },
    async click(label: string) {
      const button = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label); assert.ok(button, label);
      await React.act(async () => button.click());
    },
    async close() {
      await React.act(() => root.unmount()); dom.window.close(); imports.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

test("collapse and reopen keeps the latest same-skill preview after an older success", async () => {
  const old = deferred<DesktopSkillFilePreview>(); const latest = deferred<DesktopSkillFilePreview>(); let reads = 0;
  const h = await harness({ readSkillFile: () => ++reads === 1 ? old.promise : latest.promise });
  try {
    await h.toggle(); await h.toggle(); await h.toggle(); assert.equal(reads, 2);
    await h.React.act(async () => latest.resolve(preview("latest-body"))); assert.match(h.text(), /latest-body/);
    await h.React.act(async () => old.resolve(preview("obsolete-body")));
    assert.match(h.text(), /latest-body/); assert.doesNotMatch(h.text(), /obsolete-body/);
  } finally { await h.close(); }
});

test("an obsolete preview error cannot notify or clear the latest read's loading state", async () => {
  const old = deferred<DesktopSkillFilePreview>(); const latest = deferred<DesktopSkillFilePreview>(); let reads = 0;
  const h = await harness({ readSkillFile: () => ++reads === 1 ? old.promise : latest.promise });
  try {
    await h.toggle(); await h.toggle(); await h.toggle();
    await h.React.act(async () => old.reject(new Error("obsolete preview error")));
    assert.deepEqual(h.errors, []); assert.match(h.text(), /正在读取内容/);
    await h.React.act(async () => latest.resolve(preview("latest-body")));
    assert.match(h.text(), /latest-body/); assert.doesNotMatch(h.text(), /正在读取内容/);
  } finally { await h.close(); }
});

test("an obsolete successful preview cannot clear the latest read's loading state", async () => {
  const old = deferred<DesktopSkillFilePreview>(); const latest = deferred<DesktopSkillFilePreview>(); let reads = 0;
  const h = await harness({ readSkillFile: () => ++reads === 1 ? old.promise : latest.promise });
  try {
    await h.toggle(); await h.toggle(); await h.toggle();
    await h.React.act(async () => old.resolve(preview("obsolete-body")));
    assert.match(h.text(), /正在读取内容/); assert.doesNotMatch(h.text(), /obsolete-body/);
    await h.React.act(async () => latest.resolve(preview("latest-body"))); assert.match(h.text(), /latest-body/);
  } finally { await h.close(); }
});

for (const success of [true, false]) {
  test(`a collapsed pending preview ${success ? "success" : "failure"} is no longer owned by the view`, async () => {
    const old = deferred<DesktopSkillFilePreview>(); let reads = 0;
    const h = await harness({ readSkillFile: () => ++reads === 1 ? old.promise : Promise.resolve(preview("reopened-body")) });
    try {
      await h.toggle(); await h.toggle();
      await h.React.act(async () => { if (success) old.resolve(preview("closed-body")); else old.reject(new Error("closed preview failed")); });
      assert.deepEqual(h.errors, []);
      await h.toggle(); assert.equal(reads, 2);
      assert.match(h.text(), /reopened-body/); assert.doesNotMatch(h.text(), /closed-body/);
    } finally { await h.close(); }
  });
}

test("switching to another skill suppresses failures from the abandoned preview", async () => {
  const old = deferred<DesktopSkillFilePreview>(); const latest = deferred<DesktopSkillFilePreview>();
  const h = await harness({ skillCatalog: async () => catalog(["Alpha", "Beta"]), readSkillFile: (id: string) => id === "Alpha" ? old.promise : latest.promise });
  try {
    await h.toggle("Alpha"); await h.toggle("Beta");
    await h.React.act(async () => old.reject(new Error("alpha preview failed")));
    assert.deepEqual(h.errors, []); assert.match(h.text(), /正在读取内容/);
    await h.React.act(async () => latest.resolve(preview("beta-body"))); assert.match(h.text(), /beta-body/);
  } finally { await h.close(); }
});

test("version changes invalidate pending reads before clearing cached previews", async () => {
  const old = deferred<DesktopSkillFilePreview>(); let reads = 0; const changes: string[] = [];
  const version = { id: "before", revision: "12345678901234567890", source: { owner: "example", repository: "inert" } };
  const h = await harness({ skillVersion: async () => version,
    updateSkillVersion: async (id: string, expected: string) => { changes.push(`${id}:${expected}`); return { version: { ...version, id: "after" } }; },
    readSkillFile: () => ++reads === 1 ? old.promise : Promise.resolve(preview("updated-body")) });
  try {
    await h.toggle(); await h.click("检查并更新"); assert.deepEqual(changes, ["Alpha:before"]);
    await h.React.act(async () => old.resolve(preview("before-update-body")));
    await h.toggle(); assert.equal(reads, 2); assert.match(h.text(), /updated-body/);
    assert.doesNotMatch(h.text(), /before-update-body/);
  } finally { await h.close(); }
});

test("a current read failure releases loading and a reopened preview can retry", async () => {
  let reads = 0; const h = await harness({ readSkillFile: async () => {
    if (++reads === 1) throw new Error("current preview failed"); return preview("retry-body");
  } });
  try {
    await h.toggle(); assert.deepEqual(h.errors, ["current preview failed"]); assert.doesNotMatch(h.text(), /正在读取内容/);
    await h.toggle(); await h.toggle(); assert.equal(reads, 2); assert.match(h.text(), /retry-body/);
  } finally { await h.close(); }
});

test("completed previews remain cached across collapse and reopen", async () => {
  let reads = 0; const h = await harness({ readSkillFile: async () => { reads++; return preview("cached-body"); } });
  try {
    await h.toggle(); await h.toggle(); await h.toggle(); assert.equal(reads, 1); assert.match(h.text(), /cached-body/);
  } finally { await h.close(); }
});
