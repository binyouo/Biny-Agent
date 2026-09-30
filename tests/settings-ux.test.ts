/** 设置操作契约使用 IPC fake；颜色、尺寸和原生控件体验由用户人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { defaultConfig } from "../src/config/schema.js";
import type { AppearanceSnapshot } from "../src/appearance/types.js";
import type { DesktopSettingsSaveInput, DesktopSettingsSnapshot } from "../src/desktop/protocol.js";

function snapshot(): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  return {
    projectId: "project", hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "system", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/tmp/settings-test" }, identity: config.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat,
    permission: config.permission, webSearch: config.web.search,
    models: { configured: [], connections: [], embeddingModels: [], defaultModel: "default", thinking: "off", modelProfiles: {} },
    skills: { projectId: "project", projectKey: "project", globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}

async function harness(api: Record<string, unknown> = {}) {
  const imports = registerHooks({ load(url, context, next) {
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  const React = await import("react");
  const confirmations: string[] = [];
  dom.window.confirm = message => { confirmations.push(message ?? ""); return false; };
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    biny: { updateSettingsDraftState: async () => {}, releaseSettingsCredentials: async () => {}, previewAppearance: async () => {},
      settingsSnapshot: async () => snapshot(), onActivityEvent: () => () => {}, activitySnapshot: async () => { throw new Error("offline"); },
      activityPermissions: async () => { throw new Error("offline"); }, ...api }
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
    Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: { escape: (value: string) => value }, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const render = async (node: React.ReactNode) => { await React.act(async () => root.render(node)); };
  const click = async (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    assert.ok(element, selector);
    await React.act(async () => element.click());
  };
  const input = async (selector: string, value: string) => {
    const element = document.querySelector<HTMLInputElement>(selector);
    assert.ok(element, selector);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const overlay = async (extra: Record<string, unknown> = {}, appearance?: AppearanceSnapshot) => {
    const { SettingsOverlay } = await import("../src/desktop/renderer/src/components/settings/SettingsOverlay.js");
    const props = { open: true, version: "test", workspace: { project: { id: "project", name: "Project" }, models: [], connections: [] },
      themePreference: "system", fontPreference: { family: "system", size: 14 }, sessionRunning: false,
      onNotify() {}, onThemePreference() {}, onFontPreference() {}, onSettingsCommitted() {}, onClose() {}, ...extra };
    const node = React.createElement(SettingsOverlay, props as unknown as React.ComponentProps<typeof SettingsOverlay>);
    if (appearance) {
      const { AppearanceProvider } = await import("../src/desktop/renderer/src/AppearanceProvider.js");
      await render(React.createElement(AppearanceProvider, { snapshot: appearance, children: node }));
    } else await render(node);
  };
  return { React, dom, confirmations, render, click, input, overlay, async close() {
    await React.act(() => root.unmount()); dom.window.close(); imports.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

test("外观分段选择支持原生单选语义，自定义字体与字号重置可用", async () => {
  const h = await harness();
  try {
    const { SettingsAppearance } = await import("../src/desktop/renderer/src/components/settings/SettingsAppearance.js");
    let theme = "";
    let font = { family: "Custom Font", size: 18 };
    await h.render(h.React.createElement(SettingsAppearance, { theme: "system", font, onThemeChange: value => { theme = value; }, onFontChange: value => { font = value; } }));
    assert.equal(document.querySelectorAll('[role="radiogroup"][aria-label="外观"] input[type="radio"]').length, 3);
    await h.click('input[type="radio"][value="dark"]');
    assert.equal(theme, "dark");
    assert.equal(document.querySelector<HTMLSelectElement>('#appearance-font-family')?.value, "Custom Font");
    await h.click('[aria-label="恢复默认字体"]');
    assert.deepEqual(font, { family: "system", size: 14 });
  } finally { await h.close(); }
});

test("搜索按设置内容定位子页，空结果可清除，跨页草稿继续保留", async () => {
  const h = await harness();
  try {
    await h.overlay();
    await h.click('input[type="radio"][value="dark"]');
    await h.input('[aria-label="搜索设置"]', "流式");
    assert.match(document.querySelector('[aria-label="设置搜索结果"]')?.textContent ?? "", /聊天偏好/u);
    await h.click('[aria-label="设置搜索结果"] button');
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "聊天偏好");
    assert.equal(document.activeElement, document.querySelector('.settings-titlebar h2'));
    const advanced = document.querySelector<HTMLDetailsElement>('details.settings-advanced');
    assert.ok(advanced);
    assert.equal(advanced.open, false);
    assert.match(advanced.textContent ?? "", /采样|温度/u);
    assert.ok(document.querySelector('[aria-label="启用流式响应"]'));
    await h.React.act(async () => {
      advanced.open = true;
      advanced.dispatchEvent(new h.dom.window.Event("toggle"));
    });
    assert.ok(document.querySelector('[aria-label="压缩阈值"]'));
    await h.input('[aria-label="搜索设置"]', "no_such_setting");
    assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /没有找到/u);
    await h.click('[aria-label="清除设置搜索"]');
    await h.click('.settings-nav-list button');
    assert.equal(document.querySelector<HTMLInputElement>('input[value="dark"]')?.checked, true);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
  } finally { await h.close(); }
});

test("独立页面切换保留未保存主题和关闭确认，Activity Record 搜索别名仍定位中文页面", async () => {
  const h = await harness({ quickChatSettings: async () => ({ autoHideOnBlur: true, injectScreenContext: false, clickThrough: false }) });
  try {
    await h.overlay();
    await h.click('input[value="dark"]');
    const quick = [...document.querySelectorAll<HTMLButtonElement>(".settings-nav-list button")].find(button => button.textContent === "快速对话");
    assert.ok(quick); quick.focus();
    await h.React.act(() => quick.click());
    assert.equal(document.querySelector(".settings-titlebar h2")?.textContent, "快速对话");
    assert.equal(document.activeElement, quick);
    await h.input('[aria-label="搜索设置"]', "Activity Record");
    assert.match(document.querySelector('[aria-label="设置搜索结果"]')?.textContent ?? "", /活动记录/u);
    await h.click('[aria-label="设置搜索结果"] button');
    assert.equal(document.querySelector(".settings-titlebar h2")?.textContent, "活动记录");
    await h.click(".settings-nav-list button");
    assert.equal(document.querySelector<HTMLInputElement>('input[value="dark"]')?.checked, true);
    assert.match(document.querySelector(".settings-page-footer")?.textContent ?? "", /未保存/u);
    await h.click('[aria-label="关闭设置"]');
    assert.equal(h.confirmations.length, 1);
    assert.match(h.confirmations[0] ?? "", /未保存|关闭/u);
    assert.match(document.querySelector(".settings-page-footer")?.textContent ?? "", /未保存/u);
  } finally { await h.close(); }
});

test("设置加载失败持续显示重试入口，重试期间不声称已保存", async () => {
  let attempt = 0;
  const deferred = Promise.withResolvers<DesktopSettingsSnapshot>();
  const h = await harness({ settingsSnapshot: async () => { if (++attempt === 1) throw new Error("读取失败"); return await deferred.promise; } });
  try {
    await h.overlay();
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /读取失败/u);
    assert.doesNotMatch(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
    await h.click('[aria-label="重新加载设置"]');
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /加载/u);
    await h.React.act(async () => deferred.resolve(snapshot()));
    assert.equal(document.querySelector('[aria-label="重新加载设置"]'), null);
    assert.equal(document.querySelectorAll('[role="radiogroup"][aria-label="外观"] input').length, 3);
    assert.equal(attempt, 2);
  } finally { await h.close(); }
});

test("保存失败保留草稿并就地显示原因，重试提交同一组更改", async () => {
  const writes: DesktopSettingsSaveInput[] = [];
  const h = await harness({ saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
    writes.push(input);
    if (writes.length === 1) return { status: "rolled_back", snapshot: snapshot(), draftRetained: true, message: "磁盘暂时不可写" };
    return { status: "committed", journalId: "test", appliedFields: ["themePreference"], snapshot: { ...snapshot(), themePreference: input.themePreference } };
  } });
  try {
    await h.overlay();
    await h.click('input[value="dark"]');
    await h.click('.settings-save-button');
    assert.match(document.querySelector('.settings-page-footer [role="alert"]')?.textContent ?? "", /磁盘暂时不可写/u);
    assert.equal(document.querySelector<HTMLInputElement>('input[value="dark"]')?.checked, true);
    await h.click('.settings-save-button');
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.themePreference, "dark");
    assert.equal(document.querySelector('.settings-page-footer [role="alert"]'), null);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
  } finally { await h.close(); }
});

test("运行中允许保存外观，但共享设置更改明确说明禁用原因", async () => {
  const h = await harness({ settingsSnapshot: async () => ({ ...snapshot(), hasRunningTasks: true }) });
  try {
    await h.overlay();
    await h.click('input[value="dark"]');
    assert.equal(document.querySelector<HTMLButtonElement>('.settings-save-button')?.disabled, false);
    await h.input('[aria-label="搜索设置"]', "流式");
    await h.click('[aria-label="设置搜索结果"] button');
    await h.click('[aria-label="启用流式响应"]');
    assert.equal(document.querySelector<HTMLButtonElement>('.settings-save-button')?.disabled, true);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /任务运行中/u);
    assert.match(document.querySelector('.settings-save-button')?.getAttribute("aria-describedby") ?? "", /settings-save-status/u);
  } finally { await h.close(); }
});

test("快速对话读取失败可重试，写入失败保留待保存值并提供明确重试", async () => {
  const saved = { autoHideOnBlur: true, injectScreenContext: false, clickThrough: false };
  let reads = 0;
  let writes = 0;
  const write = Promise.withResolvers<never>();
  const h = await harness({ quickChatSettings: async () => { if (++reads === 1) throw new Error("读取失败"); return saved; },
    setQuickChatSettings: async (value: typeof saved) => { if (++writes === 1) return await write.promise; return value; } });
  try {
    const { SettingsQuickChat } = await import("../src/desktop/renderer/src/components/settings/SettingsQuickChat.js");
    await h.render(h.React.createElement(SettingsQuickChat));
    await h.click('[aria-label="重新加载快速对话设置"]');
    await h.click('[role="switch"][aria-label="失焦时自动隐藏"]');
    assert.equal(document.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled, true);
    await h.React.act(async () => write.reject(new Error("无法写入偏好")));
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /无法写入偏好/u);
    assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
    assert.equal(document.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled, false);
    await h.click('[aria-label="重试保存快速对话设置"]');
    assert.equal(writes, 2);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally { await h.close(); }
});

test("没有项目也能修改外观，偏好保存成功后才更新界面", async () => {
  const saved = Promise.withResolvers<"dark">();
  const writes: string[] = [];
  const previews: string[] = [];
  const h = await harness({ activitySettings: async () => ({ activity: snapshot().activity, configRevision: "config:1" }),
    setThemePreference: async (value: string) => { writes.push(value); return await saved.promise; } });
  try {
    await h.overlay({ workspace: undefined, onThemePreference: (value: string) => previews.push(value) });
    await h.click('input[value="dark"]');
    assert.deepEqual(writes, ["dark"]);
    assert.deepEqual(previews, []);
    assert.equal(document.querySelector<HTMLInputElement>('input[value="dark"]')?.closest('fieldset')?.disabled, true);
    await h.React.act(async () => saved.resolve("dark"));
    assert.deepEqual(previews, ["dark"]);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /即时保存/u);
  } finally { await h.close(); }
});

test("关闭的模型选择菜单不抢占设置页焦点", async () => {
  const h = await harness();
  try {
    const { SettingsModelPicker } = await import("../src/desktop/renderer/src/components/settings/SettingsModelPicker.js");
    await h.render(h.React.createElement(SettingsModelPicker, { ariaLabel: "模型", groups: [], placeholder: "选择模型", onChange() {} }));
    assert.notEqual(document.activeElement, document.querySelector('[aria-label="搜索模型或服务商"]'));
  } finally { await h.close(); }
});

test("删除自定义主题先确认，取消或保存失败均不丢失主题", async () => {
  const h = await harness();
  try {
    const { SettingsThemes } = await import("../src/desktop/renderer/src/components/settings/SettingsThemes.js");
    const { BUILTIN_PALETTES, DEFAULT_APPEARANCE, cloneAppearanceTheme } = await import("../src/appearance/index.js");
    const custom = cloneAppearanceTheme(BUILTIN_PALETTES.nord, "test-theme", "测试配色");
    const preference = { ...structuredClone(DEFAULT_APPEARANCE), darkTheme: "custom:test-theme", customThemes: [custom] };
    const before = structuredClone(preference);
    const writes: typeof preference[] = [];
    let failSave = false;
    await h.render(h.React.createElement(SettingsThemes, { preference, onChange(next) {
      if (failSave) throw new Error("主题偏好暂时不可写");
      writes.push(next as typeof preference);
    } }));
    await h.click('[aria-label="删除 测试配色"]');
    assert.deepEqual(writes, []);
    assert.ok(document.querySelector('dialog[aria-label="删除主题"]')?.textContent?.includes("测试配色"));
    await h.click('dialog[aria-label="删除主题"] [aria-label="取消删除主题"]');
    assert.deepEqual(writes, []);
    assert.deepEqual(preference, before);
    await h.click('[aria-label="删除 测试配色"]');
    failSave = true;
    await h.click('dialog[aria-label="删除主题"] [aria-label="确认删除主题"]');
    assert.deepEqual(writes, []);
    assert.match(document.querySelector('dialog[aria-label="删除主题"] [role="alert"]')?.textContent ?? "", /暂时不可写/u);
    failSave = false;
    await h.click('dialog[aria-label="删除主题"] [aria-label="确认删除主题"]');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.customThemes, []);
    assert.equal(writes[0]?.darkTheme, null);
    assert.equal(writes[0]?.lightTheme, preference.lightTheme);
    assert.deepEqual(preference, before);
  } finally { await h.close(); }
});

test("窗口拖影选项只在选中对应结构皮肤时出现", async () => {
  const h = await harness();
  try {
    const { SettingsThemes } = await import("../src/desktop/renderer/src/components/settings/SettingsThemes.js");
    const { DEFAULT_APPEARANCE } = await import("../src/appearance/index.js");
    const preference = structuredClone(DEFAULT_APPEARANCE);
    await h.render(h.React.createElement(SettingsThemes, { preference, onChange() {} }));
    assert.equal(document.querySelector(".theme-trail-option") === null, true);
    await h.render(h.React.createElement(SettingsThemes, { preference: { ...preference, lightTheme: "win98" }, onChange() {} }));
    assert.equal(document.querySelector<HTMLInputElement>('.theme-trail-option input')?.checked, true);
    await h.render(h.React.createElement(SettingsThemes, { preference: { ...preference, lightTheme: "winxp", win98Trail: false }, onChange() {} }));
    assert.equal(document.querySelector(".theme-trail-option") === null, true);
  } finally { await h.close(); }
});

test("打开设置时切换结构皮肤保留当前分页、未保存修改和内容节点", async () => {
  const h = await harness();
  try {
    const { DEFAULT_APPEARANCE } = await import("../src/appearance/index.js");
    const noop = () => {};
    const props = { onNotify: noop, onThemePreference: noop, onFontPreference: noop, onAppearancePreference: noop, onSettingsCommitted: noop, onClose: noop };
    const initial: AppearanceSnapshot = { themePreference: "dark", appearancePreference: structuredClone(DEFAULT_APPEARANCE), fontPreference: { family: "system", size: 14 } };
    await h.overlay(props, initial);
    await h.click('.settings-nav-list button:nth-of-type(2)');
    const streaming = document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]');
    assert.ok(streaming);
    assert.equal(streaming.type, "checkbox");
    const original = streaming.checked;
    await h.click('[aria-label="启用流式响应"]');
    const content = document.querySelector(".settings-content");
    assert.ok(content);
    const unsaved = document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked;
    assert.equal(typeof unsaved, "boolean");
    assert.notEqual(unsaved, original);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
    for (const skin of ["win98", "winxp", "longhorn", "longhorn-dark"]) {
      const appearancePreference = { ...structuredClone(DEFAULT_APPEARANCE), lightTheme: skin === "longhorn-dark" ? null : skin, darkTheme: skin === "longhorn-dark" ? skin : null };
      await h.overlay(props, { ...initial, themePreference: skin === "longhorn-dark" ? "dark" : "light", appearancePreference });
      assert.equal(document.documentElement.dataset.appearanceSkin, skin);
      assert.equal(document.querySelector(".settings-modal")?.classList.contains("is-retro-settings"), true, skin);
      assert.equal(document.querySelector(".settings-content"), content, skin);
      assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "聊天偏好", skin);
      assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, unsaved, skin);
      assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
    }
    await h.overlay(props, initial);
    assert.equal(document.documentElement.dataset.appearanceSkin, "default");
    assert.equal(document.querySelector(".settings-modal")?.classList.contains("is-retro-settings"), false);
    assert.equal(document.querySelector(".settings-content"), content);
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "聊天偏好");
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, unsaved);
  } finally { await h.close(); }
});
