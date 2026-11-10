import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import type { DesktopAppearanceSnapshot } from "../src/desktop/protocol.js";
import { AppearancePreviewCoordinator } from "../src/desktop/appearanceCoordinator.js";
import { highlightFencedCode } from "../src/desktop/renderer/src/syntaxHighlight.js";
import { applyAppearance, readAppearanceCache, APPEARANCE_CACHE_KEY } from "../src/desktop/renderer/src/appearance.js";

test("first paint ignores saved palettes and skins while preserving mode and font", async () => {
  const snapshot: DesktopAppearanceSnapshot = { themePreference: "dark", fontPreference: { family: "system", size: 17 } };
  const cache = new Map<string, string>([[APPEARANCE_CACHE_KEY, JSON.stringify({ version: 1, snapshot: { ...snapshot, appearancePreference: { darkTheme: "longhorn-dark" } }, variants: { dark: { skin: "longhorn-dark", themeId: "longhorn-dark", variables: { "--bg": "#17171a", "--accent": "#8578c7" } } } })]]);
  const html = await readFile(new URL("../src/desktop/renderer/index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(script);
  const storage = { getItem: (key: string) => cache.get(key), setItem: (key: string, value: string) => cache.set(key, value) };
  const boot = (mode: "light" | "dark" = "dark") => {
    const values = new Map<string, string>();
    const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) }, classList: { toggle: () => {} } };
    runInNewContext(script, { window: { location: { search: `?theme=${mode}` }, matchMedia: () => ({ matches: true }) }, localStorage: storage, document: { documentElement: root }, URLSearchParams });
    return { root, values };
  };
  const stale = boot();
  assert.equal(stale.values.has("--accent"), false);
  assert.equal(stale.values.has("--bg"), false);
  assert.equal(stale.values.get("--app-font-size"), "17");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, matchMedia: () => ({ matches: true }) } });
  try {
    assert.deepEqual(readAppearanceCache(), snapshot);
    applyAppearance(stale.root as unknown as HTMLElement, snapshot);
    assert.deepEqual(readAppearanceCache(), snapshot);
    const fresh = boot();
    assert.equal(fresh.values.has("--bg"), false);
    assert.equal(fresh.values.has("--accent"), false);
    assert.equal(fresh.root.dataset.appearanceSkin, undefined);
    applyAppearance(fresh.root as unknown as HTMLElement, { ...snapshot, themePreference: "light" });
    assert.equal(fresh.values.has("--accent"), false);
    assert.equal(fresh.values.has("--bg"), false);
    assert.equal(fresh.root.dataset.theme, "light");
    assert.equal(fresh.root.dataset.appearanceSkin, undefined);
    const light = boot("light");
    assert.equal(light.values.has("--accent"), false);
    assert.equal(light.root.dataset.appearanceSkin, undefined);
    assert.equal(light.values.get("--app-font-size"), "17");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("grouped preferences have one surface and shared row spacing, while a disabled save stays neutral", async () => {
  const { JSDOM } = await import("jsdom");
  const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
  const sources = await Promise.all(["biny", "desktop-v2", "settings", "settings-controls"].map(name =>
    readFile(new URL(`styles/${name}.css`, renderer), "utf8")));
  const dom = new JSDOM('<dialog open class="desktop-settings-dialog"><section class="settings-modal"><main class="settings-content"><div class="settings-scroll"><div class="settings-preferences"><section class="settings-preference-section"><h3>回复显示</h3><div class="settings-row-group"><div class="settings-switch-row"><span class="settings-switch-copy"><strong>流式响应</strong></span><input class="settings-switch" role="switch" type="checkbox" checked /></div><div class="settings-preference-row">字体</div></div></section></div></div><footer class="settings-page-footer"><button class="settings-action settings-save-button" disabled>保存</button></footer></main></section></dialog>');
  try {
    for (const source of sources) {
      const style = dom.window.document.createElement("style");
      style.textContent = source;
      dom.window.document.head.append(style);
    }
    const computed = (selector: string): CSSStyleDeclaration => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    const section = computed(".settings-preference-section");
    assert.equal(section.borderWidth, "0px", "分组不应嵌套第二层卡片边框");
    assert.equal(Number.parseFloat(section.padding), 0, "分组标题不能被第二层卡片挤入");
    assert.equal(section.background, "rgba(0, 0, 0, 0)");
    assert.equal(computed(".settings-row-group").borderWidth, "0px");
    const row = computed(".settings-switch-row");
    assert.equal(row.padding, computed(".settings-preference-row").padding);
    assert.equal(row.minHeight, computed(".settings-preference-row").minHeight);
    assert.notEqual(row.cursor, "pointer", "不可操作的说明区不能提示整行可点击");
    assert.equal(computed(".settings-switch").cursor, "pointer");
    assert.equal(computed(".settings-switch").appearance, "none");
    assert.equal(computed(".settings-save-button").background, "var(--surface-soft)");
    assert.equal(computed(".settings-save-button").color, "var(--text-tertiary)");
  } finally { dom.window.close(); }
});

test("preview is transient, clone-safe and released only by its current owner", () => {
  const saved: DesktopAppearanceSnapshot = { themePreference: "system", fontPreference: { family: "system", size: 14 } };
  const published: DesktopAppearanceSnapshot[] = [];
  const coordinator = new AppearancePreviewCoordinator({ read: () => saved, publish: snapshot => published.push(snapshot) });
  const first = { ...saved, themePreference: "light" as const, fontPreference: { family: "PingFang SC", size: 17 } };
  coordinator.preview(1, first);
  first.fontPreference.size = 20;
  assert.equal(coordinator.snapshot().fontPreference.size, 17);
  coordinator.preview(2, { ...saved, themePreference: "dark" });
  coordinator.release(1);
  assert.equal(coordinator.snapshot().themePreference, "dark");
  coordinator.release(2);
  assert.deepEqual(coordinator.snapshot(), saved);
  assert.equal(saved.fontPreference.size, 14);
  coordinator.preview(3, first);
  coordinator.committed();
  assert.deepEqual(published.at(-1), saved);
});

test("default Markdown quote highlighting uses readable foregrounds instead of comment colors", async () => {
  const highlighted = await highlightFencedCode("> quoted text", "markdown");
  assert.match(highlighted.html, /--shiki-light:#383a42/iu);
  assert.match(highlighted.html, /--shiki-dark:#abb2bf/iu);
  assert.doesNotMatch(highlighted.html, /--shiki-light-font-style:italic/iu);
});

test("设置进入原生模态层前不显示，打开后不做几何变形，外壳共用圆角", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><head><style>.library-open { display: flex; animation: entry 200ms; }</style></head><body><div class="desktop-root biny-root"></div><dialog class="desktop-settings-dialog library-open"></dialog>');
  try {
    for (const name of ["biny", "desktop-v2"]) {
      const style = dom.window.document.createElement("style");
      style.textContent = await readFile(new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), "utf8");
      dom.window.document.head.append(style);
    }
    const dialog = dom.window.document.querySelector('dialog')!;
    assert.equal(dom.window.getComputedStyle(dialog).display, "none", "Dialog 的打开类不能在 showModal 前露出非模态内容");
    dialog.setAttribute("open", "");
    const computed = dom.window.getComputedStyle(dialog);
    assert.equal(computed.animation, "none", "设置打开不能继承依赖库的缩放和位移");
    assert.equal(computed.borderRadius, "var(--biny-radius-window)");
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('.biny-root')!).borderRadius, "var(--biny-radius-window)");
  } finally { dom.window.close(); }
});


test("legacy palettes are dropped without losing mode, font, sessions or preference revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-legacy-theme-"));
  try {
    const file = path.join(root, "state.json");
    await writeFile(file, JSON.stringify({ version: 2, themePreference: "dark", fontPreference: { family: "PingFang SC", size: 18 },
      preferenceRevision: 7, selectedSessionIds: { project: "session" }, sidebarWidth: 300,
      appearancePreference: { darkTheme: "custom:old", lightTheme: "win98", customThemes: [{ name: "old" }], win98Trail: true } }));
    const state = new DesktopStateStore(file);
    await state.load();
    assert.deepEqual(state.settingsPreferences(), { revision: 7, themePreference: "dark", fontPreference: { family: "PingFang SC", size: 18 } });
    assert.equal(state.selectedSessionId("project"), "session");
    assert.equal(state.sidebarWidth(), 300);
    await state.setFontPreference({ family: "PingFang SC", size: 19 });
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(Object.hasOwn(stored, "appearancePreference"), false);
    assert.equal(stored.themePreference, "dark");
    assert.equal(stored.fontPreference.size, 19);
    assert.equal(stored.preferenceRevision, 8);
    assert.deepEqual(stored.selectedSessionIds, { project: "session" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("settings rejects removed palette inputs before any write", () => {
  assert.equal(settingsSaveInputSchema.safeParse({ expectedPreferenceRevision: 0, expectedConfigRevision: "missing",
    appearancePreference: { darkTheme: "tokyonight", lightTheme: null, customThemes: [], win98Trail: true } }).success, false);
});
