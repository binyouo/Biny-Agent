/** 设置操作契约使用 IPC fake；颜色、尺寸和原生控件体验由用户人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { PROVIDER_ICON_DATA } from "../src/desktop/renderer/src/assets/provider-icon-data.js";
import { providerCatalog } from "../src/desktop/renderer/src/providerCatalog.js";
import { loadProviderIconData } from "../src/desktop/renderer/src/components/ProviderIconData.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import type { AppearanceSnapshot } from "../src/appearance/types.js";
import type { DesktopSettingsSaveInput, DesktopSettingsSnapshot, DesktopSkillCatalogEntry, DesktopSkillCatalogSnapshot } from "../src/desktop/protocol.js";
import type { ApplicationImportSnapshot } from "../src/imports/types.js";

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
      activityPermissions: async () => { throw new Error("offline"); },
      // 快速对话现在挂在通用页里，任何一次渲染设置外壳都会读它 —— 所以默认就要有桩。
      quickChatSettings: async () => ({ autoHideOnBlur: true, injectScreenContext: false, clickThrough: false }),
      setQuickChatSettings: async (value: unknown) => value, ...api }
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
    const props = { open: true, version: "test", projects: [], workspace: { project: { id: "project", name: "Project" }, models: [], connections: [] },
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

test("设置详情优先聚焦可用输入而非关闭按钮，Escape 返回原入口；导航测试未覆盖详情焦点", async () => {
  const h = await harness();
  const host = document.createElement("div");
  document.body.append(host);
  try {
    const { SettingsDetailLayer } = await import("../src/desktop/renderer/src/components/settings/SettingsDetailLayer.js");
    const { SettingsDetailHostContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js");
    function DetailExample(): React.ReactNode {
      const [open, setOpen] = h.React.useState(false);
      return h.React.createElement(SettingsDetailHostContext.Provider, { value: host },
        h.React.createElement("button", { id: "detail-trigger", onClick: () => setOpen(true) }, "编辑"),
        open ? h.React.createElement(SettingsDetailLayer, { onClose: () => setOpen(false), children:
          h.React.createElement("section", { role: "dialog", "aria-label": "编辑配置" },
            h.React.createElement("button", { onClick: () => setOpen(false) }, "关闭"),
            h.React.createElement("input", { disabled: true, "data-settings-detail-autofocus": true, "aria-label": "不可用字段" }),
            h.React.createElement("input", { "aria-label": "名称" }),
            h.React.createElement("input", { "data-settings-detail-autofocus": true, "aria-label": "服务地址" })
          )
        }) : null
      );
    }
    await h.render(h.React.createElement(DetailExample));
    document.querySelector<HTMLButtonElement>("#detail-trigger")!.focus();
    await h.click("#detail-trigger");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "服务地址");
    await h.React.act(() => document.activeElement!.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement?.textContent, "关闭");
    await h.React.act(() => document.activeElement!.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    assert.equal(document.activeElement?.getAttribute("aria-label"), "服务地址");
    await h.React.act(() => document.activeElement!.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement?.id, "detail-trigger");
  } finally { host.remove(); await h.close(); }
});

test("摘要配置不出现在设置导航和搜索中，旧页面目标回到通用", async () => {
  const h = await harness();
  try {
    await h.overlay({ targetTab: "数据" });
    assert.equal(document.querySelector(".settings-titlebar h2")?.textContent, "通用");
    assert.doesNotMatch(document.querySelector(".settings-nav-list")?.textContent ?? "", /对话摘要|数据/u);
    assert.equal(document.querySelector(".biny-thread-brief-settings"), null);
    await h.input('[aria-label="搜索设置"]', "对话摘要");
    assert.equal(document.querySelector('[aria-label="设置搜索结果"] button'), null);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /没有找到/u);
  } finally { await h.close(); }
});

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
    await h.overlay({ targetTab: "用户界面" });
    await h.click('input[type="radio"][value="dark"]');
    await h.input('[aria-label="搜索设置"]', "流式");
    assert.match(document.querySelector('[aria-label="设置搜索结果"]')?.textContent ?? "", /聊天偏好/u);
    await h.click('[aria-label="设置搜索结果"] button');
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "聊天偏好");
    assert.ok(document.activeElement === document.querySelector('.settings-titlebar h2'), "搜索跳转后应聚焦页面标题");
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
    await h.click('[data-settings-tab="用户界面"]');
    assert.equal(document.querySelector<HTMLInputElement>('input[value="dark"]')?.checked, true);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
  } finally { await h.close(); }
});

test("独立页面切换保留未保存主题和关闭确认，Activity Record 搜索别名仍定位中文页面", async () => {
  const h = await harness({ quickChatSettings: async () => ({ autoHideOnBlur: true, injectScreenContext: false, clickThrough: false }) });
  try {
    await h.overlay({ targetTab: "用户界面" });
    await h.click('input[value="dark"]');
    const navLabels = [...document.querySelectorAll<HTMLButtonElement>(".settings-nav-list button")].map(button => button.textContent);
    assert.ok(!navLabels.includes("快速对话"), "快速对话不再是独立页面，已并入通用");
    assert.ok(!navLabels.includes("工具模型"), "工具模型不再是独立页面，已并入通用");
    const general = [...document.querySelectorAll<HTMLButtonElement>(".settings-nav-list button")].find(button => button.textContent === "通用");
    assert.ok(general); general.focus();
    await h.React.act(() => general.click());
    assert.equal(document.querySelector(".settings-titlebar h2")?.textContent, "通用");
    assert.ok(document.querySelector("#vision-model"), "视觉模型在通用页里预留了位置");
    assert.ok(document.querySelector("#tool-model"), "工具模型卡片在通用页里");
    assert.ok(document.querySelector("#quickchat-behavior"), "快速对话卡片在通用页里");
    assert.ok(document.querySelector("#quickchat-shortcut") === null, "移除没有配置入口的快捷键展示块");
    assert.ok(document.activeElement === general, "切换页面后应保留导航按钮焦点");
    // 搜索别名走的是中文旧名（用户仍会这么叫），命中的页面标题已经是新名。
    await h.input('[aria-label="搜索设置"]', "电脑历史");
    assert.match(document.querySelector('[aria-label="设置搜索结果"]')?.textContent ?? "", /Computer History/u);
    await h.click('[aria-label="设置搜索结果"] button');
    assert.equal(document.querySelector(".settings-titlebar h2")?.textContent, "Computer History");
    await h.click('[data-settings-tab="用户界面"]');
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
    await h.overlay({ targetTab: "用户界面" });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /读取失败/u);
    assert.doesNotMatch(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
    await h.click('[aria-label="重新加载设置"]');
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /加载/u);
    await h.React.act(async () => deferred.resolve(snapshot()));
    assert.ok(document.querySelector('[aria-label="重新加载设置"]') === null, "加载成功后应移除重试入口");
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
    await h.overlay({ targetTab: "用户界面" });
    assert.equal(document.querySelector<HTMLButtonElement>('.settings-save-button')?.disabled, true);
    await h.click('input[value="dark"]');
    assert.equal(document.querySelector('.settings-footer-actions button')?.textContent, "取消");
    await h.click('.settings-save-button');
    assert.match(document.querySelector('.settings-page-footer [role="alert"]')?.textContent ?? "", /磁盘暂时不可写/u);
    assert.equal(document.querySelector<HTMLInputElement>('input[value="dark"]')?.checked, true);
    await h.click('.settings-save-button');
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.themePreference, "dark");
    assert.ok(document.querySelector('.settings-page-footer [role="alert"]') === null, "保存成功后应清除页脚错误");
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
  } finally { await h.close(); }
});

test("聊天偏好仅开关改变草稿，点击行和说明不切换；原保存用例未覆盖整行误触", async () => {
  const h = await harness();
  try {
    await h.overlay({ targetTab: "聊天" });
    const streaming = document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')!;
    assert.equal(streaming.checked, true);
    await h.React.act(() => streaming.parentElement!.click());
    await h.React.act(() => streaming.parentElement!.querySelector("strong")!.click());
    await h.React.act(() => streaming.parentElement!.querySelector("small")?.click());
    assert.equal(streaming.checked, true, "行、标题和说明不应触发开关");
    assert.equal(document.querySelector<HTMLButtonElement>(".settings-save-button")?.disabled, true);
    assert.equal(streaming.getAttribute("role"), "switch");
    assert.equal(streaming.getAttribute("aria-checked"), "true");
    const description = streaming.getAttribute("aria-describedby");
    assert.ok(description && document.getElementById(description)?.textContent, "开关保留说明的可访问关联");
    streaming.focus();
    assert.equal(document.activeElement, streaming);
    await h.click('[aria-label="启用流式响应"]');
    assert.equal(streaming.checked, false);
    assert.equal(streaming.getAttribute("aria-checked"), "false");
    assert.equal(document.querySelector<HTMLButtonElement>(".settings-save-button")?.disabled, false);
    await h.click('[aria-label="启用 Markdown 渲染"]');
    const math = document.querySelector<HTMLInputElement>('[aria-label="渲染单美元符号数学公式"]')!;
    const originalMath = math.checked;
    assert.equal(math.disabled, true);
    await h.React.act(() => math.click());
    assert.equal(math.checked, originalMath, "依赖被关闭的选项不能操作");
  } finally { await h.close(); }
});

test("运行中允许保存外观，但共享设置更改明确说明禁用原因", async () => {
  const h = await harness({ settingsSnapshot: async () => ({ ...snapshot(), hasRunningTasks: true }) });
  try {
    await h.overlay({ targetTab: "用户界面" });
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

test("运行中的工具模型选择仍可打开并即时保存，不夹带其它模型草稿", async () => {
  const writes: DesktopSettingsSaveInput[] = [];
  const running = { ...snapshot(), hasRunningTasks: true };
  const h = await harness({ settingsSnapshot: async () => running, saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
    writes.push(input);
    return { status: "committed", journalId: "test", appliedFields: ["models"], snapshot: running };
  } });
  try {
    await h.overlay({ sessionRunning: true });
    await h.input('[aria-label="搜索设置"]', "工具模型");
    await h.click('[aria-label="设置搜索结果"] button');
    const picker = document.querySelector('[aria-label="工具模型"]');
    assert.ok(picker);
    assert.notEqual(picker.getAttribute("aria-disabled"), "true");
    await h.click('[aria-label="工具模型"]');
    await h.click('.settings-model-picker-option');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.models, { upserts: [], removeAliases: [], toolModel: { alias: undefined } });
    assert.match(document.querySelector('#tool-model')?.textContent ?? "", /后续回合/u);
  } finally { await h.close(); }
});

test("首次打开导入不等待其他设置或重跑 bootstrap，来源可立即预览；静态内容测试未覆盖外壳加载门禁", async () => {
  const settings = Promise.withResolvers<DesktopSettingsSnapshot>();
  const imports = Promise.withResolvers<ApplicationImportSnapshot>();
  let bootstraps = 0;
  const chosen: string[] = [];
  const h = await harness({
    settingsSnapshot: async () => await settings.promise,
    applicationImports: async () => await imports.promise,
    onApplicationImportsChanged: () => () => {},
    bootstrap: async () => { bootstraps++; return { projects: [] }; },
    previewApplicationImport: async (source: string) => {
      chosen.push(source);
      return { id: "preview", source, label: "ChatGPT", items: [{ id: "chat", category: "sessions", label: "Conversation", detail: "" }], warnings: [] };
    }
  });
  try {
    await h.overlay({ targetTab: "导入", projects: [{ id: "project", name: "Project", path: "/fixture" }] });
    assert.ok(!document.querySelector('.settings-load-state'), "导入页不依赖模型和聊天设置快照");
    assert.equal(document.querySelectorAll('.import-source-row').length, 3);
    assert.equal(bootstraps, 0, "不得为项目列表重新初始化客户端及所有项目");
    await h.click('[aria-label="从 ChatGPT 导入"]');
    assert.deepEqual(chosen, ["chatgpt"]);
    assert.equal(document.querySelector<HTMLSelectElement>('.import-target select')?.value, "project");
    assert.equal(document.querySelector<HTMLButtonElement>('.import-preview-dialog footer .settings-primary-button')?.disabled, false);
  } finally {
    settings.resolve(snapshot());
    imports.resolve({ sources: [], history: [], sync: { enabled: false, hasSelection: false } });
    await h.close();
  }
});

test("导入页切换后保留已读历史，隐藏时停止订阅；首次可见测试未覆盖页签卸载", async () => {
  const previous: ApplicationImportSnapshot = { sources: [], history: [{ id: "cached", source: "claude", label: "Claude Code",
    time: "2026-10-08T00:00:00Z", workspaceRoot: "/fixture", results: [{ id: "chat", category: "sessions", label: "Imported chat", status: "imported" }]
  }], sync: { enabled: false, hasSelection: false } };
  const refresh = Promise.withResolvers<ApplicationImportSnapshot>();
  let reads = 0;
  const listeners = new Set<() => void>();
  const h = await harness({
    applicationImports: async () => ++reads === 1 ? previous : await refresh.promise,
    onApplicationImportsChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }
  });
  const props = { targetTab: "导入", onThemePreference() {}, onFontPreference() {}, onNotify() {} };
  try {
    await h.overlay(props);
    const history = document.querySelector('.import-history');
    assert.ok(history);
    assert.equal(listeners.size, 1);
    await h.overlay({ ...props, targetTab: "聊天" });
    assert.ok(history.isConnected, "切换设置页不丢弃已读取的导入历史");
    assert.ok(history.closest('[hidden]'));
    assert.equal(listeners.size, 0);
    assert.equal(reads, 1);
    await h.overlay(props);
    assert.equal(reads, 2);
    assert.ok(document.querySelector('.import-history') === history, "重新校验期间保留原记录，不重建空页面");
    assert.ok(!history.closest('[hidden]'));
    await h.React.act(async () => refresh.resolve(previous));
    await h.overlay({ ...props, open: false });
    assert.equal(listeners.size, 0);
  } finally { refresh.resolve(previous); await h.close(); }
});

test("导入缓存刷新不能覆盖已保存的同步开关；保留历史测试未覆盖刷新与写入竞态", async () => {
  const previous: ApplicationImportSnapshot = { sources: [], history: [], sync: { enabled: false, hasSelection: true } };
  const refresh = Promise.withResolvers<ApplicationImportSnapshot>();
  let reads = 0;
  const writes: boolean[] = [];
  const h = await harness({
    applicationImports: async () => ++reads === 1 ? previous : await refresh.promise,
    onApplicationImportsChanged: () => () => {},
    setApplicationImportSync: async (enabled: boolean) => { writes.push(enabled); return { ...previous, sync: { ...previous.sync, enabled } }; }
  });
  const props = { targetTab: "导入", onThemePreference() {}, onFontPreference() {}, onNotify() {} };
  try {
    await h.overlay(props);
    await h.overlay({ ...props, open: false });
    await h.overlay(props);
    await h.click('[aria-label="保持导入同步"]');
    assert.deepEqual(writes, [true]);
    await h.React.act(async () => refresh.resolve(previous));
    assert.equal(document.querySelector('[aria-label="保持导入同步"]')?.getAttribute("aria-checked"), "true");
  } finally { refresh.resolve(previous); await h.close(); }
});

test("关闭再打开设置直接显示已读取内容；仅测 Provider 未覆盖外壳卸载导致的缓存丢失", async () => {
  const refresh = Promise.withResolvers<DesktopSettingsSnapshot>();
  let reads = 0;
  const h = await harness({ settingsSnapshot: async () => ++reads === 1 ? snapshot() : await refresh.promise });
  const props = { targetTab: "用户界面", onThemePreference() {}, onFontPreference() {}, onNotify() {} };
  try {
    await h.overlay(props);
    assert.ok(document.querySelector('input[type="radio"][value="system"]'));
    await h.overlay({ ...props, open: false });
    assert.equal(reads, 1);
    await h.overlay(props);
    assert.equal(reads, 2);
    assert.ok(!document.querySelector(".settings-load-state"), "后台校验不能把已有设置换回加载页");
    assert.ok(document.querySelector('input[type="radio"][value="system"]'));
    await h.React.act(async () => refresh.resolve({ ...snapshot(), themePreference: "dark", preferenceRevision: 2 }));
    assert.equal(document.querySelector<HTMLInputElement>('input[type="radio"][value="dark"]')?.checked, true);
  } finally { refresh.resolve(snapshot()); await h.close(); }
});

test("关闭设置不读取新项目，首次打开其他项目不展示旧项目缓存", async () => {
  const refresh = Promise.withResolvers<DesktopSettingsSnapshot>();
  const reads: string[] = [];
  const h = await harness({ settingsSnapshot: async (projectId: string) => {
    reads.push(projectId);
    return projectId === "project" ? snapshot() : await refresh.promise;
  } });
  const props = { targetTab: "用户界面", onThemePreference() {}, onFontPreference() {}, onNotify() {} };
  const other = { project: { id: "other", name: "Other" }, models: [], connections: [] };
  try {
    await h.overlay({ ...props, open: false });
    assert.deepEqual(reads, []);
    await h.overlay(props);
    await h.overlay({ ...props, open: false });
    await h.overlay({ ...props, open: false, workspace: other });
    assert.deepEqual(reads, ["project"]);
    await h.overlay({ ...props, workspace: other });
    assert.ok(!document.querySelector('input[type="radio"]'), "新项目不能短暂编辑旧项目缓存");
    await h.React.act(async () => refresh.resolve({ ...snapshot(), projectId: "other", themePreference: "light" }));
    assert.equal(document.querySelector<HTMLInputElement>('input[type="radio"][value="light"]')?.checked, true);
  } finally { refresh.resolve(snapshot()); await h.close(); }
});

test("关闭设置保留浏览器状态但停止轮询；重新打开在刷新完成前仍显示旧状态", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const refresh = Promise.withResolvers<unknown>();
  let reads = 0;
  const status = { running: true, connected: true, browsers: [{ browserId: "chrome", browserName: "Chrome" }] };
  const h = await harness({ browserRelayStatus: async () => ++reads === 1 ? status : await refresh.promise,
    browserRelayInstall: async () => {}, browserRelayOpenChrome: async () => {}, browserRelaySetup: async () => {}, browserRelayDisconnect: async () => {} });
  const props = { targetTab: "浏览器", onThemePreference() {}, onFontPreference() {}, onNotify() {} };
  try {
    await h.overlay(props);
    assert.equal(reads, 1);
    const before = document.querySelector('.browser-connection-status')?.textContent;
    assert.ok(before?.includes("Chrome"));
    await h.overlay({ ...props, open: false });
    await h.React.act(async () => context.mock.timers.tick(6000));
    assert.equal(reads, 1);
    await h.overlay(props);
    assert.equal(reads, 2);
    assert.equal(document.querySelector('.browser-connection-status')?.textContent, before);
    await h.React.act(async () => refresh.resolve(status));
  } finally { refresh.resolve(status); await h.close(); context.mock.timers.reset(); }
});

test("缓存设置关闭后详情层不再拦截主界面的 Escape；页面缓存测试未覆盖全局键盘监听", async () => {
  const h = await harness();
  const props = { targetTab: "模型", onThemePreference() {}, onFontPreference() {}, onNotify() {} };
  try {
    await h.overlay(props);
    await h.click('.provider-settings-toolbar > button');
    assert.ok(document.querySelector('[role="dialog"][aria-label="添加自定义服务商"]'));
    await h.overlay({ ...props, open: false });
    const escape = new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await h.React.act(() => document.body.dispatchEvent(escape));
    assert.equal(escape.defaultPrevented, false, "关闭的设置不能消费聊天区的快捷键");
    assert.ok(!document.querySelector('.settings-detail-layer'));
  } finally { await h.close(); }
});

test("记忆页重开保留已确认的空列表，后台刷新不再把列表替换成加载文案", async () => {
  const refresh = Promise.withResolvers<void>();
  let reads = 0;
  const h = await harness();
  const maintenance = { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
  const props = { targetTab: "记忆", onThemePreference() {}, onFontPreference() {}, onNotify() {},
    onLoadMemoryStats: async () => {
      if (++reads > 1) await refresh.promise;
      return { configRevision: "config:1", revision: 0, settings: defaultConfig.context.memory, totalEntries: 0,
        memoryStats: { total: 0, autoGenerated: 0, manualAdded: 0 }, maintenance };
    },
    onLoadMemoryEntries: async () => ({ revision: 0, entries: [], total: 0, offset: 0, limit: 20 }),
    onLoadArchivedMemory: async () => ({ revision: 0, entries: [], total: 0, offset: 0, limit: 25 }),
    onSleepStatus: async () => maintenance, onSleepRuns: async () => [],
    onLoadMemoryEmbeddingStatus: async () => { throw new Error("No embedding provider configured"); }
  };
  try {
    await h.overlay(props);
    assert.match(document.querySelector('.activity-memory-empty')?.textContent ?? "", /暂无记忆/u);
    await h.overlay({ ...props, open: false });
    await h.overlay(props);
    assert.equal(reads, 2);
    assert.match(document.querySelector('.activity-memory-empty')?.textContent ?? "", /暂无记忆/u);
    assert.ok(!document.querySelector('.activity-memory-empty-hint'));
  } finally { await h.React.act(async () => refresh.resolve()); await h.close(); }
});

test("设置后台刷新保留刚修改的草稿并更新未编辑字段；重开可见性测试未覆盖刷新覆盖输入", async () => {
  const refresh = Promise.withResolvers<DesktopSettingsSnapshot>();
  let reads = 0;
  const h = await harness({ settingsSnapshot: async () => ++reads === 1 ? snapshot() : await refresh.promise });
  const props = { targetTab: "用户界面", onThemePreference() {}, onFontPreference() {}, onNotify() {} };
  try {
    await h.overlay(props);
    await h.overlay({ ...props, open: false });
    await h.overlay(props);
    await h.click('input[type="radio"][value="dark"]');
    await h.React.act(async () => refresh.resolve({ ...snapshot(), fontPreference: { family: "system", size: 18 }, preferenceRevision: 2 }));
    assert.equal(document.querySelector<HTMLInputElement>('input[type="radio"][value="dark"]')?.checked, true);
    assert.equal(document.querySelector<HTMLInputElement>('.font-size-input')?.value, "18");
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
  } finally { refresh.resolve(snapshot()); await h.close(); }
});

test("丢弃外观草稿并关闭设置恢复已保存预览；保留缓存不能留下取消的主题", async () => {
  const h = await harness();
  h.dom.window.confirm = () => true;
  try {
    const { SettingsOverlay } = await import("../src/desktop/renderer/src/components/settings/SettingsOverlay.js");
    const callbacks = { onNotify() {}, onFontPreference() {}, onSettingsCommitted() {} };
    function Host() {
      const [open, setOpen] = h.React.useState(true);
      const [theme, setTheme] = h.React.useState("system");
      const props = { ...callbacks, open, version: "test", targetTab: "用户界面",
        workspace: { project: { id: "project", name: "Project" }, models: [], connections: [] },
        themePreference: theme, fontPreference: { family: "system", size: 14 }, sessionRunning: false,
        onThemePreference: setTheme, onClose: () => setOpen(false)
      };
      return h.React.createElement(h.React.Fragment, null,
        h.React.createElement("output", { "data-theme-preview": true }, theme),
        h.React.createElement(SettingsOverlay, props as unknown as React.ComponentProps<typeof SettingsOverlay>));
    }
    await h.render(h.React.createElement(Host));
    await h.click('input[type="radio"][value="dark"]');
    assert.equal(document.querySelector('[data-theme-preview]')?.textContent, "dark");
    await h.click('[aria-label="关闭设置"]');
    assert.equal(document.querySelector<HTMLDialogElement>('dialog.desktop-settings-dialog')?.open, false);
    assert.equal(document.querySelector('[data-theme-preview]')?.textContent, "system");
  } finally { await h.close(); }
});

test("复用设置缓存期间公开重新校验状态，读取完成后恢复空闲", async () => {
  const refresh = Promise.withResolvers<DesktopSettingsSnapshot>();
  let reads = 0;
  const h = await harness({ settingsSnapshot: async () => ++reads === 1 ? snapshot() : await refresh.promise });
  try {
    const { SettingsDraftProvider } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftProvider.js");
    const { useSettingsDraft } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
    let current!: ReturnType<typeof useSettingsDraft>;
    function Probe() { current = useSettingsDraft(); return null; }
    const props = { projectId: "project", sessionRunning: false, onCommitted() {}, onFontPreview() {},
      onThemePreview() {}, onNotify() {}, children: h.React.createElement(Probe) };
    await h.render(h.React.createElement(SettingsDraftProvider, { ...props, active: true }));
    assert.equal(current.revalidating, false);
    const cached = current.snapshot;
    await h.render(h.React.createElement(SettingsDraftProvider, { ...props, active: false }));
    await h.render(h.React.createElement(SettingsDraftProvider, { ...props, active: true }));
    assert.equal(current.revalidating, true, "缓存刷新期间调用方必须能观察忙碌状态");
    assert.equal(current.loading, false);
    assert.equal(current.snapshot, cached);
    await h.React.act(async () => refresh.resolve({ ...snapshot(), preferenceRevision: 2 }));
    assert.equal(current.revalidating, false);
    assert.equal(current.snapshot?.preferenceRevision, 2);
  } finally { await h.close(); }
});

test("工具模型即时保存保留未提交的供应商模型草稿", async () => {
  const h = await harness({ saveSettings: async () => ({ status: "committed", journalId: "test", appliedFields: ["models"], snapshot: snapshot() }) });
  try {
    const { SettingsDraftProvider } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftProvider.js");
    const { useSettingsDraft } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
    let current!: ReturnType<typeof useSettingsDraft>;
    function Probe() { current = useSettingsDraft(); return null; }
    await h.render(h.React.createElement(SettingsDraftProvider, { active: true, projectId: "project", sessionRunning: true,
      onCommitted() {}, onFontPreview() {}, onThemePreview() {}, onNotify() {}, children: h.React.createElement(Probe) }));
    await h.React.act(() => current.removeModel("draft-model"));
    assert.deepEqual(current.draft?.models.removeAliases, ["draft-model"]);
    await h.React.act(async () => { await current.saveModels({ upserts: [], removeAliases: [], toolModel: {} }); });
    assert.deepEqual(current.draft?.models.removeAliases, ["draft-model"], "只保存工具模型不应清空未提交的模型操作");
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
    assert.ok(document.querySelector('[role="alert"]') === null, "保存成功后应清除错误");
  } finally { await h.close(); }
});

test("没有项目也能修改外观，偏好保存成功后才更新界面", async () => {
  const saved = Promise.withResolvers<"dark">();
  const writes: string[] = [];
  const previews: string[] = [];
  const h = await harness({ activitySettings: async () => ({ activity: snapshot().activity, configRevision: "config:1" }),
    setThemePreference: async (value: string) => { writes.push(value); return await saved.promise; } });
  try {
    await h.overlay({ workspace: undefined, onThemePreference: (value: string) => previews.push(value), targetTab: "用户界面" });
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
    assert.ok(document.activeElement !== document.querySelector('[aria-label="搜索模型或服务商"]'), "页面加载不应抢占搜索框焦点");
  } finally { await h.close(); }
});

test("设置模型选择跳过不可用项，Escape 先收起选择再退出详情；关闭态用例未覆盖嵌套返回", async () => {
  const h = await harness();
  const host = document.createElement("div");
  document.body.append(host);
  try {
    const { SettingsModelPicker } = await import("../src/desktop/renderer/src/components/settings/SettingsModelPicker.js");
    const { SettingsDetailLayer } = await import("../src/desktop/renderer/src/components/settings/SettingsDetailLayer.js");
    const { SettingsDetailHostContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js");
    let closed = 0;
    await h.render(h.React.createElement(SettingsDetailHostContext.Provider, { value: host },
      h.React.createElement(SettingsDetailLayer, { onClose: () => { closed++; }, children:
        h.React.createElement("section", { role: "dialog", "aria-label": "配置" }, h.React.createElement(SettingsModelPicker, {
          ariaLabel: "模型", placeholder: "选择模型", onChange() {}, groups: [{ key: "local", label: "本地", iconTone: "local", options: [
            { value: "missing", label: "未配置", disabled: true }, { value: "ready", label: "可用模型" }
          ] }]
        }))
      })
    ));
    const details = document.querySelector<HTMLDetailsElement>("details")!;
    await h.React.act(() => { details.open = true; details.dispatchEvent(new h.dom.window.Event("toggle")); });
    const press = async (key: string): Promise<void> => { await h.React.act(() => document.activeElement!.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); };
    await press("ArrowDown");
    assert.equal(document.activeElement?.textContent, "可用模型");
    await press("Escape");
    assert.equal(details.open, false);
    assert.equal(closed, 0);
    assert.ok(document.activeElement === details.querySelector("summary"));
    await press("Escape");
    assert.equal(closed, 1);
  } finally { host.remove(); await h.close(); }
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
      return Promise.resolve(true);
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
    await h.render(h.React.createElement(SettingsThemes, { preference, onChange: async () => true }));
    assert.equal(document.querySelector(".theme-trail-option") === null, true);
    await h.render(h.React.createElement(SettingsThemes, { preference: { ...preference, lightTheme: "win98" }, onChange: async () => true }));
    assert.equal(document.querySelector<HTMLInputElement>('.theme-trail-option input')?.checked, true);
    await h.render(h.React.createElement(SettingsThemes, { preference: { ...preference, lightTheme: "winxp", win98Trail: false }, onChange: async () => true }));
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
    await h.click('[data-settings-tab="聊天"]');
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
      assert.ok(document.querySelector(".settings-content") === content, `${skin}: 切换皮肤不应重挂载设置内容`);
      assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "聊天偏好", skin);
      assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, unsaved, skin);
      assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
    }
    await h.overlay(props, initial);
    assert.equal(document.documentElement.dataset.appearanceSkin, "default");
    assert.equal(document.querySelector(".settings-modal")?.classList.contains("is-retro-settings"), false);
    assert.ok(document.querySelector(".settings-content") === content, "恢复皮肤不应重挂载设置内容");
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "聊天偏好");
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, unsaved);
  } finally { await h.close(); }
});

function skillCatalog(): DesktopSkillCatalogSnapshot {
  const skill = (name: string, scope: DesktopSkillCatalogEntry["scope"]): DesktopSkillCatalogEntry => ({
    id: name, ref: `${scope}:${name}`, name, scope, description: `Use ${name} for a repeatable workflow.`,
    source: scope === "builtin" ? "builtin" : "biny", precedence: 0, engine: "biny", linkedEngines: ["biny"],
    absolutePath: `/tmp/${scope}/${name}`, mdPath: `/tmp/${scope}/${name}/SKILL.md`,
    files: [{ name: "SKILL.md", path: "SKILL.md", kind: "file", size: 100 }], frontmatter: { name }
  });
  const skills = [skill("project-workflow", "project"), skill("global-workflow", "global"), skill("report", "builtin"), skill("diary", "builtin")];
  return { skills, inventory: skills, unmanagedSkills: [], plugins: [], managedSources: [], warnings: [], diagnostics: [] };
}

test("技能设置按内置、全局、项目展示，搜索保留来源分组与匹配数量", async () => {
  const h = await harness({ skillCatalog: async () => skillCatalog() });
  try {
    await h.overlay();
    await h.input('[aria-label="搜索设置"]', "skill");
    await h.click('[aria-label="设置搜索结果"] button');
    assert.deepEqual([...document.querySelectorAll('.settings-extension-group-title h3')].map(node => node.textContent), ["内置技能", "全局技能", "项目技能"]);
    assert.deepEqual([...document.querySelectorAll('[aria-label="内置技能"] h4')].map(node => node.textContent), ["diary", "report"]);
    assert.equal(document.querySelector('[aria-label="内置技能"] .settings-extension-group-title span')?.textContent, "2");
    assert.match(document.querySelector('.settings-extension-list-heading')?.textContent ?? "", /4 个技能/u);
    await h.input('[aria-label="搜索技能名称、描述或路径"]', "REPORT");
    assert.deepEqual([...document.querySelectorAll('.settings-extension-group-title h3')].map(node => node.textContent), ["内置技能"]);
    assert.match(document.querySelector('.settings-extension-list-heading')?.textContent ?? "", /1 \/ 4/u);
    await h.input('[aria-label="搜索技能名称、描述或路径"]', "/tmp/global/");
    assert.deepEqual([...document.querySelectorAll('.settings-extension-group-title h3')].map(node => node.textContent), ["全局技能"]);
    await h.input('[aria-label="搜索技能名称、描述或路径"]', "no-matching-skill");
    assert.equal(document.querySelectorAll('.settings-extension-group-title').length, 0);
    assert.match(document.querySelector('[aria-label="技能列表"]')?.textContent ?? "", /没有匹配/u);
  } finally { await h.close(); }
});

test("恢复自动输出额度清除全局覆盖并保留温度，原有手填数字不能阻止恢复模型默认", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-settings-auto-output-"));
  const credentials = { persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {} };
  const config = structuredClone(defaultConfig);
  config.chat.maxOutputTokens = 8192;
  config.chat.temperature = 0.3;
  await saveConfigFile(directory, config);
  const store = new DesktopConfigStore(directory, credentials);
  const before = await store.loadVersioned();
  const initial = { ...snapshot(), configRevision: before.revision, chatParams: before.config.chat };
  const writes: DesktopSettingsSaveInput[] = [];
  let saving: ReturnType<DesktopConfigStore["saveVersioned"]> | undefined;
  const settingsView = await harness({
    settingsSnapshot: async () => initial,
    saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
      writes.push(input);
      const payload = settingsSaveInputSchema.parse(JSON.parse(JSON.stringify(input)));
      const candidate = structuredClone(before.config);
      candidate.chat = payload.chatParams!;
      saving = store.saveVersioned(candidate, payload.expectedConfigRevision!);
      const saved = await saving;
      return { status: "committed", journalId: "test", appliedFields: ["chatParams"], snapshot: { ...initial, configRevision: saved.revision, chatParams: saved.config.chat } };
    }
  });
  try {
    await settingsView.overlay({ targetTab: "聊天" });
    await settingsView.React.act(async () => {
      const advanced = document.querySelector<HTMLDetailsElement>("details.settings-advanced")!;
      advanced.open = true;
      advanced.dispatchEvent(new settingsView.dom.window.Event("toggle"));
    });
    assert.equal(document.querySelector<HTMLInputElement>("#chat-max-output-tokens")?.value, "8192");
    await settingsView.click('[aria-label="恢复自动输出额度"]');
    assert.equal(document.querySelector<HTMLInputElement>("#chat-max-output-tokens")?.value, "");
    assert.match(document.querySelector(".chat-params-settings")?.textContent ?? "", /自动跟随当前模型/u);
    await settingsView.click(".settings-save-button");
    assert.ok(saving);
    await settingsView.React.act(async () => { await saving; });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.chatParams?.maxOutputTokens, undefined);
    assert.equal(writes[0]?.chatParams?.temperature, 0.3);
    assert.equal(document.querySelector('[aria-label="恢复自动输出额度"]'), null);
    const expected = structuredClone(before.config.chat);
    delete expected.maxOutputTokens;
    assert.deepEqual((await loadConfigFile(directory)).chat, expected);
  } finally { await settingsView.close(); await rm(directory, { recursive: true, force: true }); }
});

test("自动技能提取与技能开关进入统一草稿，保存时保留聊天参数与来源继承", async () => {
  const initial = snapshot();
  initial.chatParams.temperature = 0.3;
  initial.skills.globalDefaults["builtin:diary"] = false;
  const writes: DesktopSettingsSaveInput[] = [];
  const h = await harness({ settingsSnapshot: async () => initial, skillCatalog: async () => skillCatalog(),
    readSkillFile: async () => ({ path: "/tmp/builtin/diary/SKILL.md", content: "# Diary\nReusable workflow.", binary: false, truncated: false, bytes: 27 }),
    skillVersion: async () => undefined,
    saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
      writes.push(input);
      return { status: "committed", journalId: "test", appliedFields: ["skills", "chatParams"], snapshot: { ...initial, chatParams: input.chatParams } };
    } });
  try {
    await h.overlay();
    await h.input('[aria-label="搜索设置"]', "自动技能提取");
    await h.click('[aria-label="设置搜索结果"] button');
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "技能");
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用自动技能提取"]')?.checked, true);
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="最少工具调用次数"]')?.value, "5");
    assert.deepEqual([...document.querySelectorAll('#skill-extraction p')].map(node => node.textContent), [
      "从长对话中自动提取可复用的技能", "工具调用次数低于此值的对话将被跳过"
    ]);
    assert.equal(document.querySelector('[aria-label="启用技能 diary"]')?.getAttribute("aria-checked"), "false");
    await h.click('[aria-label="启用技能 diary"]');
    assert.equal(document.querySelector('[aria-label="停用技能 diary"]')?.getAttribute("aria-checked"), "true");
    const card = document.querySelector('[aria-label="停用技能 diary"]')?.closest('article');
    assert.ok(card);
    assert.deepEqual([...card.querySelectorAll('.settings-skill-card-footer button')].map(node => node.textContent), ["查看内容"]);
    assert.equal(card.querySelector('.settings-skill-card-heading')?.textContent, "diary");
    await h.click('[aria-label="内置技能"] .settings-skill-content-toggle');
    assert.match(document.querySelector('[aria-label="diary 内容"]')?.textContent ?? "", /Reusable workflow/u);
    const restore = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="diary 内容"] button')].find(button => button.textContent === "恢复继承");
    assert.ok(restore, "展开内容后仍可管理继承状态");
    await h.React.act(() => restore.click());
    assert.equal(document.querySelector('[aria-label="启用技能 diary"]')?.getAttribute("aria-checked"), "false");
    await h.click('[aria-label="启用技能 diary"]');
    await h.input('[aria-label="最少工具调用次数"]', "9");
    await h.click('[aria-label="启用自动技能提取"]');
    assert.ok(document.querySelector('[aria-label="最少工具调用次数"]') === null, "关闭后收起阈值控件");
    assert.equal(writes.length, 0, "开关与阈值应等待统一保存");
    await h.click('.settings-save-button');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.chatParams?.skillExtraction, { enabled: false, minToolCalls: 9 });
    assert.equal(writes[0]?.chatParams?.temperature, 0.3);
    assert.deepEqual(writes[0]?.skills, { globalDefaults: { "builtin:diary": false }, projectOverrides: { "builtin:diary": true } });
  } finally { await h.close(); }
});

test("图标入口只给没有自带品牌图标的服务商：内置服务商用自带的，自定义服务商才可选", async () => {
  const base = snapshot();
  const deepseek = providerCatalog.find((item) => item.id === "deepseek");
  assert.ok(deepseek?.baseUrl, "目录里应当有 DeepSeek 的接入地址");
  const builtIn = { providerAlias: "deepseek", providerType: deepseek.value, baseUrl: deepseek.baseUrl, requiresApiKey: true, hasCredential: true };
  const custom = { providerAlias: "我的中转站", providerType: "openai-compatible", displayName: "我的中转站", baseUrl: "https://relay.example.com/v1", requiresApiKey: true, hasCredential: true };
  // 先把图标数据灌进缓存，这样列表行的品牌标首帧就画得出来（不必等动态 import）。
  await loadProviderIconData();
  const h = await harness({ settingsSnapshot: async () => ({ ...base, models: { ...base.models, connections: [builtIn, custom] } }) });
  try {
    await h.overlay({ targetTab: "模型" });
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".provider-row")];
    const rowFor = (needle: string): HTMLButtonElement => {
      const row = rows.find((element) => (element.textContent ?? "").includes(needle));
      assert.ok(row, "列表里应当有 " + needle + " 这一行（实际：" + rows.map((element) => element.textContent).join(" / ") + "）");
      return row;
    };

    // 内置服务商：画它自带的品牌图标，并且没有图标选择入口。
    await h.React.act(async () => { rowFor("DeepSeek").click(); });
    assert.equal(
      document.querySelector(".provider-row.is-active svg.provider-logo")?.getAttribute("viewBox"),
      PROVIDER_ICON_DATA.DeepSeek!.vb,
      "DeepSeek 这一行应当画它自带的品牌图标"
    );
    assert.equal(document.querySelector('label[for$="-icon"]'), null, "自带图标的服务商不该有图标选择入口");
    const pane = document.querySelector(".provider-detail-pane");
    assert.ok(document.querySelector('label[for$="-api-key"]'), "面板其它字段照常出现（面板实际内容：" + (pane?.textContent ?? "空").slice(0, 400) + "）");

    // 自定义服务商（没有品牌）：才给选择入口。
    await h.React.act(async () => { rowFor("我的中转站").click(); });
    assert.ok(document.querySelector('label[for$="-icon"]'), "自定义服务商应当能选图标");
  } finally { await h.close(); }
});

test("工具模型选择器只显示模型名一行，并画服务商自己的图标", async () => {
  await loadProviderIconData();
  const base = snapshot();
  const freeRelay = {
    providerAlias: "free", providerType: "openai-compatible", displayName: "free",
    icon: "Apple", baseUrl: "http://127.0.0.1:3425/v1", requiresApiKey: true, hasCredential: true
  };
  const model = {
    alias: "free-deepseek", displayName: "Deepseek-V4.1-Flash", provider: "free",
    providerType: "openai-compatible", model: "workbuddy-ai/deepseek-v4.1-flash",
    baseUrl: "http://127.0.0.1:3425/v1", efforts: [], thinkingLevelMap: {}, defaultThinking: "off", showInPicker: true
  };
  const h = await harness({
    settingsSnapshot: async () => ({
      ...base,
      models: {
        ...base.models, connections: [freeRelay], configured: [model],
        toolModel: "free-deepseek", resolvedToolModel: "free-deepseek"
      } as never
    })
  });
  try {
    await h.overlay({ targetTab: "通用" });
    const trigger = document.querySelector<HTMLElement>("#tool-model .settings-model-picker-trigger");
    assert.ok(trigger, "工具模型卡片里应当有选择器");
    const copy = trigger.querySelector(".settings-model-picker-trigger-copy");
    assert.equal(copy?.children.length, 1, "选择器只显示一行（实际：" + (copy?.textContent ?? "") + "）");
    assert.match(trigger.textContent ?? "", /Deepseek-V4\.1-Flash/u, "显示模型名");
    assert.doesNotMatch(trigger.textContent ?? "", /free/u, "不该再把服务商名当第二行显示");
    assert.doesNotMatch(document.querySelector("#tool-model")?.textContent ?? "", /当前使用/u, "不再回显「当前使用」");
    // 比 innerHTML 而不是 viewBox：Apple 和兜底字形的 viewBox 都是 "0 0 24 24"，只比那个等于没比。
    const logo = document.querySelector("#tool-model .settings-model-picker-provider-mark .provider-logo");
    assert.equal(
      logo?.innerHTML,
      PROVIDER_ICON_DATA.Apple!.body,
      "自定义服务商应当画用户在服务商页挑的那个图标（实际画的是：" + (logo?.innerHTML ?? "(没有图标)") + "）"
    );
  } finally { await h.close(); }
});
test("保存响应保留等待期间修改的聊天草稿，再次保存使用新的修订号", async () => {
  const initial = snapshot();
  const originalStreaming = initial.chatParams.response?.streaming ?? true;
  const saved = Promise.withResolvers<DesktopSettingsSnapshot>();
  const writes: DesktopSettingsSaveInput[] = [];
  const projections: Array<{ dirty: boolean; canSave: boolean; open: boolean }> = [];
  const h = await harness({ settingsSnapshot: async () => initial,
    updateSettingsDraftState: async (value: typeof projections[number]) => { projections.push(value); },
    saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
      writes.push(input);
      const committed = writes.length === 1 ? await saved.promise : {
        ...initial, configRevision: "config:3", chatParams: input.chatParams!
      };
      return { status: "committed", journalId: "test", appliedFields: ["chatParams"], snapshot: committed };
    } });
  try {
    await h.overlay({ targetTab: "聊天" });
    await h.click('[aria-label="启用流式响应"]');
    await h.click('.settings-save-button');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.chatParams?.response?.streaming, !originalStreaming);
    assert.equal(document.querySelector<HTMLButtonElement>('.settings-save-button')?.disabled, true);
    await h.click('[aria-label="启用流式响应"]');
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, originalStreaming);
    await h.React.act(async () => saved.resolve({ ...initial, configRevision: "config:2", chatParams: writes[0]!.chatParams! }));
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, originalStreaming,
      "保存的旧响应不得覆盖请求发出后用户已作出的更新");
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
    assert.deepEqual(projections.at(-1), { dirty: true, canSave: true, open: true });
    await h.click('.settings-save-button');
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.expectedConfigRevision, "config:2");
    assert.equal(writes[1]?.chatParams?.response?.streaming, originalStreaming);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
    assert.deepEqual(projections.at(-1), { dirty: false, canSave: false, open: true });
  } finally { await h.close(); }
});

test("保存期间跨页编辑保留，已提交字段跟随后端归一化且关闭仍需明确确认", async () => {
  const initial = snapshot();
  const saved = Promise.withResolvers<DesktopSettingsSnapshot>();
  const writes: DesktopSettingsSaveInput[] = [];
  let closes = 0;
  const h = await harness({ settingsSnapshot: async () => initial,
    saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
      writes.push(input);
      return { status: "committed", journalId: "test", appliedFields: ["chatParams"], snapshot: await saved.promise };
    } });
  try {
    await h.overlay({ targetTab: "聊天", onClose: () => { closes += 1; } });
    await h.click('[aria-label="启用流式响应"]');
    await h.click('.settings-save-button');
    const web = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav-list button')].find(button => button.textContent === "网络搜索");
    assert.ok(web);
    await h.React.act(() => web.click());
    await h.click('[aria-label="可视化 Agent 浏览"]');
    await h.click('[aria-label="关闭设置"]');
    assert.equal(h.confirmations.length, 0, "保存期间暂不询问丢弃尚在提交中的设置");
    const committed = { ...initial, configRevision: "config:2", chatParams: { ...writes[0]!.chatParams!, temperature: 0.4 } };
    await h.React.act(async () => saved.resolve(committed));
    assert.equal(h.confirmations.length, 1, "提交后仍存在新草稿，关闭必须确认");
    assert.equal(closes, 0, "取消关闭不丢弃新编辑");
    assert.equal(document.querySelector('[aria-label="可视化 Agent 浏览"]')?.getAttribute("aria-checked"), String(!initial.webSearch.visibleBrowsing));
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /未保存/u);
    h.dom.window.confirm = () => true;
    await h.click('[aria-label="关闭设置"]');
    assert.equal(closes, 1);
    assert.equal(document.querySelector('[aria-label="可视化 Agent 浏览"]')?.getAttribute("aria-checked"), String(initial.webSearch.visibleBrowsing));
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
    assert.equal(writes.length, 1, "明确丢弃不触发新保存");
  } finally { await h.close(); }
});

test("跨页新编辑重试只保存剩余字段，不重复提交已归一化的聊天参数", async () => {
  const initial = snapshot();
  const saved = Promise.withResolvers<DesktopSettingsSnapshot>();
  const writes: DesktopSettingsSaveInput[] = [];
  let committed = initial;
  const h = await harness({ settingsSnapshot: async () => initial,
    saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
      writes.push(input);
      committed = writes.length === 1 ? await saved.promise : {
        ...committed, configRevision: "config:3", webSearch: { ...committed.webSearch, ...input.webSearch }
      };
      return { status: "committed", journalId: "test", appliedFields: [], snapshot: committed };
    } });
  try {
    await h.overlay({ targetTab: "聊天" });
    await h.click('[aria-label="启用流式响应"]');
    await h.click('.settings-save-button');
    const web = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav-list button')].find(button => button.textContent === "网络搜索");
    assert.ok(web);
    await h.React.act(() => web.click());
    await h.click('[aria-label="可视化 Agent 浏览"]');
    await h.React.act(async () => saved.resolve({ ...initial, configRevision: "config:2", chatParams: { ...writes[0]!.chatParams!, temperature: 0.4 } }));
    await h.click('.settings-save-button');
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.expectedConfigRevision, "config:2");
    assert.equal(writes[1]?.chatParams, undefined, "服务端归一化后的已提交组不应再次作为旧值提交");
    assert.equal(writes[1]?.webSearch?.visibleBrowsing, !initial.webSearch.visibleBrowsing);
    assert.equal(committed.chatParams.temperature, 0.4);
    assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
  } finally { await h.close(); }
});

for (const response of ["rejected", "conflict"] as const) {
  test(`保存${response}仍保留等待期间的新选择并允许重试`, async () => {
    const initial = snapshot();
    const saved = Promise.withResolvers<unknown>();
    const writes: DesktopSettingsSaveInput[] = [];
    const h = await harness({ settingsSnapshot: async () => initial,
      saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
        writes.push(input);
        if (writes.length === 1) return await saved.promise;
        return { status: "committed", journalId: "test", appliedFields: [], snapshot: { ...initial, chatParams: input.chatParams! } };
      } });
    try {
      await h.overlay({ targetTab: "聊天" });
      await h.click('[aria-label="启用流式响应"]');
      await h.click('.settings-save-button');
      await h.click('[aria-label="显示令牌使用情况"]');
      const latest = document.querySelector<HTMLInputElement>('[aria-label="显示令牌使用情况"]')!.checked;
      await h.React.act(async () => {
        if (response === "rejected") saved.reject(new Error("写入失败"));
        else saved.resolve({ status: "rolled_back", snapshot: { ...initial, configRevision: "config:2" }, draftRetained: true, message: "配置冲突" });
      });
      assert.equal(document.querySelector<HTMLInputElement>('[aria-label="显示令牌使用情况"]')?.checked, latest);
      assert.match(document.querySelector('.settings-page-footer [role="alert"]')?.textContent ?? "", /写入失败|配置冲突/u);
      await h.click('.settings-save-button');
      assert.equal(writes.length, 2);
      assert.equal(writes[1]?.expectedConfigRevision, response === "conflict" ? "config:2" : "config:1");
      assert.equal(writes[1]?.chatParams?.response?.showTokenUsage, latest);
      assert.match(document.querySelector('.settings-page-footer')?.textContent ?? "", /所有更改已保存/u);
    } finally { await h.close(); }
  });
}

for (const response of ["committed", "rejected", "conflict"] as const) {
  test(`项目切换后忽略旧项目的${response}保存响应`, async () => {
    const initial = snapshot();
    const next = { ...snapshot(), projectId: "next", configRevision: "next:1" };
    const saved = Promise.withResolvers<unknown>();
    const writes: Array<{ project: string; input: DesktopSettingsSaveInput }> = [];
    const committed: DesktopSettingsSnapshot[] = [];
    const notices: string[] = [];
    const h = await harness({ settingsSnapshot: async (project: string) => project === "next" ? next : initial,
      saveSettings: async (project: string, input: DesktopSettingsSaveInput) => {
        writes.push({ project, input });
        if (project === "project") return await saved.promise;
        return { status: "committed", journalId: "test", appliedFields: [], snapshot: { ...next, chatParams: input.chatParams! } };
      } });
    const props = { targetTab: "聊天", onNotify: (message: string) => notices.push(message), onSettingsCommitted: (value: DesktopSettingsSnapshot) => committed.push(value) };
    try {
      await h.overlay(props);
      await h.click('[aria-label="启用流式响应"]');
      await h.click('.settings-save-button');
      await h.overlay({ ...props, workspace: { project: { id: "next", name: "Next" }, models: [], connections: [] } });
      await h.click('[aria-label="显示令牌使用情况"]');
      const latest = document.querySelector<HTMLInputElement>('[aria-label="显示令牌使用情况"]')!.checked;
      await h.React.act(async () => {
        if (response === "rejected") saved.reject(new Error("旧项目写入失败"));
        else saved.resolve(response === "committed"
          ? { status: "committed", journalId: "old", appliedFields: [], snapshot: { ...initial, chatParams: writes[0]!.input.chatParams! } }
          : { status: "rolled_back", snapshot: initial, draftRetained: true, message: "旧项目冲突" });
      });
      assert.deepEqual(committed, []);
      assert.deepEqual(notices, []);
      assert.equal(document.querySelector<HTMLInputElement>('[aria-label="显示令牌使用情况"]')?.checked, latest);
      assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, next.chatParams.response?.streaming ?? true);
      assert.ok(document.querySelector('.settings-page-footer [role="alert"]') === null);
      await h.click('.settings-save-button');
      assert.equal(writes.length, 2);
      assert.equal(writes[1]?.project, "next");
      assert.equal(writes[1]?.input.expectedConfigRevision, "next:1");
    } finally { await h.close(); }
  });
}

for (const closeVia of ["titlebar", "escape", "html-dialog-cancel", "backdrop"] as const) {
  test(`${closeVia} 关闭在草稿改回旧基线后仍等待保存，保留新草稿直到明确丢弃`, async () => {
    // 真正的 DOM 与临时配置存储；IPC 只用闸门延迟，不启动 Electron 或访问真实凭据。
    const directory = await mkdtemp(path.join(os.tmpdir(), "biny-settings-close-save-"));
    const credentials = { persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {} };
    const config = structuredClone(defaultConfig);
    config.chat.response = { streaming: true };
    await saveConfigFile(directory, config);
    const store = new DesktopConfigStore(directory, credentials);
    const initial = await store.loadVersioned();
    const asSnapshot = (value: typeof initial): DesktopSettingsSnapshot => ({
      ...snapshot(), configRevision: value.revision, chatParams: value.config.chat
    });
    const gate = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const writes: DesktopSettingsSaveInput[] = [];
    const projections: Array<{ dirty: boolean; canSave: boolean; open: boolean }> = [];
    const committed: DesktopSettingsSnapshot[] = [];
    let closes = 0;
    const h = await harness({
      settingsSnapshot: async () => asSnapshot(initial),
      updateSettingsDraftState: async (value: typeof projections[number]) => { projections.push(value); },
      saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
        writes.push(structuredClone(input));
        try {
          await gate.promise;
          const candidate = structuredClone(initial.config);
          candidate.chat = structuredClone(input.chatParams!);
          const saved = await store.saveVersioned(candidate, input.expectedConfigRevision!);
          return { status: "committed", journalId: "close-save-test", appliedFields: ["chatParams"], snapshot: asSnapshot(saved) };
        } finally { completed.resolve(); }
      }
    });
    try {
      const { SettingsOverlay } = await import("../src/desktop/renderer/src/components/settings/SettingsOverlay.js");
      function Host() {
        const [open, setOpen] = h.React.useState(true);
        const props = { open, version: "test", targetTab: "聊天", modelSetupRequired: false,
          workspace: { project: { id: "project", name: "Project" }, models: [], connections: [] },
          themePreference: "system", fontPreference: { family: "system", size: 14 }, sessionRunning: false,
          onNotify() {}, onThemePreference() {}, onFontPreference() {},
          onSettingsCommitted(value: DesktopSettingsSnapshot) { committed.push(value); },
          onClose() { closes += 1; setOpen(false); }
        };
        return h.React.createElement(SettingsOverlay, props as unknown as React.ComponentProps<typeof SettingsOverlay>);
      }
      await h.render(h.React.createElement(Host));
      const original = initial.config.chat.response?.streaming ?? true;
      await h.click('[aria-label="启用流式响应"]');
      await h.click('.settings-save-button');
      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.chatParams?.response?.streaming, !original);
      await h.click('[aria-label="启用流式响应"]');
      assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, original);
      assert.deepEqual(projections.at(-1), { dirty: true, canSave: false, open: true }, "原生关闭握手仍需保护尚未完成的保存事务");
      assert.equal(document.querySelector<HTMLButtonElement>('.settings-footer-actions button')?.disabled, true);
      assert.match(document.querySelector('#settings-save-status')?.textContent ?? "", /保存中/u);
      const requestClose = async () => {
        const dialog = document.querySelector('dialog.desktop-settings-dialog');
        assert.ok(dialog);
        if (closeVia === "titlebar") await h.click('[aria-label="关闭设置"]');
        else if (closeVia === "backdrop") await h.click('dialog.desktop-settings-dialog');
        else await h.React.act(async () => {
          dialog.dispatchEvent(closeVia === "escape"
            ? new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
            : new h.dom.window.Event("cancel", { cancelable: true }));
        });
      };
      await requestClose();
      const closesWhileSaving = closes;
      // 已发出的保存仍会落盘；关闭操作不能暗示它被取消，也不能提前丢弃后续编辑。
      assert.equal((await loadConfigFile(directory)).chat.response?.streaming ?? true, original);
      await h.React.act(async () => { gate.resolve(); await completed.promise; });
      assert.equal((await loadConfigFile(directory)).chat.response?.streaming, !original);
      assert.equal(closesWhileSaving, 0, "即使 dirtyCount 为 0，也不能在保存完成前关闭");
      assert.equal(closes, 0, "取消确认后设置保持打开");
      assert.equal(h.confirmations.length, 1, "保存结束后仅询问一次是否丢弃新草稿");
      assert.equal(committed.length, 1, "保持挂载以接收实际提交的快照");
      assert.equal(document.querySelector<HTMLInputElement>('[aria-label="启用流式响应"]')?.checked, original);
      assert.deepEqual(projections.at(-1), { dirty: true, canSave: true, open: true });
      assert.match(document.querySelector('#settings-save-status')?.textContent ?? "", /未保存/u);
      assert.equal(writes.length, 1, "关闭与取消确认不重复保存");
      h.dom.window.confirm = message => { h.confirmations.push(message ?? ""); return true; };
      await requestClose();
      assert.equal(h.confirmations.length, 2);
      assert.equal(closes, 1);
      assert.equal(document.querySelector<HTMLDialogElement>('dialog.desktop-settings-dialog')?.open ?? false, false, "关闭对话框但保留已读取设置，不再要求销毁缓存节点");
      assert.equal((await loadConfigFile(directory)).chat.response?.streaming, !original, "明确丢弃只丢弃草稿，不回滚已提交配置");
      assert.equal(writes.length, 1);
    } finally {
      await h.React.act(async () => { gate.resolve(); if (writes.length) await completed.promise; });
      await h.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
