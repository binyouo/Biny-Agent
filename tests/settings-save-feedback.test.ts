/** Real settings provider and model controls; only IPC/DOM facilities are inert. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import type { DesktopSettingsSaveResult, DesktopSettingsSnapshot } from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

function snapshot(): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  return {
    projectId: "project", hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "system", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/synthetic/activity" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat,
    toolExecutionMode: config.agent.toolExecutionMode, subagent: { enabled: false, runtime: "builtin" }, externalSubagentBlockers: [],
    permission: config.permission, webSearch: config.web.search,
    models: { configured: [], connections: [], embeddingModels: [], defaultModel: "default", thinking: "off", modelProfiles: {} },
    skills: { projectId: "project", projectKey: "project", globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}
async function fixture(withProject = true) {
  const hooks = registerHooks({ load(url, context, next) {
    if (/\.(svg|png|css)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://settings.test", pretendToBeVisual: true });
  const React = await import("react");
  const base = snapshot();
  const writes: Array<ReturnType<typeof Promise.withResolvers<DesktopSettingsSaveResult>>> = [];
  const preferences: Array<ReturnType<typeof Promise.withResolvers<"light">>> = [];
  const notifications: string[] = [];
  Object.assign(dom.window, { biny: {
    settingsSnapshot: async () => base, activitySettings: async () => ({ activity: base.activity }),
    previewAppearance: async () => {}, updateSettingsDraftState: async () => {}, releaseSettingsCredentials: async () => {},
    saveSettings: async () => { const gate = Promise.withResolvers<DesktopSettingsSaveResult>(); writes.push(gate); return await gate.promise; },
    setThemePreference: async () => { const gate = Promise.withResolvers<"light">(); preferences.push(gate); return await gate.promise; }
  } });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
    Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle, CSS: { escape: (value: string) => value },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { SettingsDraftProvider } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftProvider.js");
  const { useSettingsDraft } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const { SettingsToolModel } = await import("../src/desktop/renderer/src/components/settings/SettingsToolModel.js");
  const { SettingsVisionModel } = await import("../src/desktop/renderer/src/components/settings/SettingsVisionModel.js");
  let current!: SettingsDraftContextValue;
  function Probe() { current = useSettingsDraft(); return null; }
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(SettingsDraftProvider, {
    active: true, projectId: withProject ? "project" : undefined, sessionRunning: false,
    onCommitted() {}, onFontPreview() {}, onThemePreview() {}, onNotify: message => notifications.push(message),
    children: React.createElement(React.Fragment, null, React.createElement(Probe),
      React.createElement(SettingsToolModel, { onTest: async () => ({ ok: true, message: "inert" }), onNotify: message => notifications.push(message) }),
      React.createElement(SettingsVisionModel, { onNotify: message => notifications.push(message) }))
  })));
  return { React, base, writes, preferences, notifications, current: () => current,
    async click(selector: string) {
      const element = document.querySelector<HTMLElement>(selector); assert.ok(element, selector);
      await React.act(async () => element.click());
    },
    async close() {
      await React.act(() => root.unmount());
      await React.act(async () => {
        for (const gate of writes) gate.resolve({ status: "committed", journalId: "cleanup", appliedFields: [], snapshot: base });
        for (const gate of preferences) gate.resolve("light");
        await Promise.allSettled([...writes.map(gate => gate.promise), ...preferences.map(gate => gate.promise)]);
      });
      dom.window.close(); hooks.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

for (const outcome of ["committed", "rolled_back", "throw"] as const) test(`即时模型 ${outcome} 保留独立的手动保存错误`, async () => {
  const h = await fixture();
  try {
    await h.React.act(() => h.current().setChatParams({ ...h.base.chatParams, temperature: 0.2 }));
    let manual!: ReturnType<SettingsDraftContextValue["saveAll"]>;
    await h.React.act(() => { manual = h.current().saveAll(); });
    await h.React.act(async () => { h.writes[0]!.resolve({ status: "rolled_back", snapshot: h.base, message: "manual write failed" }); await manual; });
    assert.equal(h.current().saveError, "manual write failed");
    let immediate!: ReturnType<SettingsDraftContextValue["saveModels"]>;
    await h.React.act(() => { immediate = h.current().saveModels({ upserts: [], removeAliases: [], toolModel: { alias: undefined } }); });
    assert.equal(h.current().saveError, "manual write failed");
    assert.equal(h.current().manualSaving, false);
    assert.equal(h.current().saveState, "saving", "关闭保护仍知道即时事务尚未结束");
    await h.React.act(async () => {
      if (outcome === "throw") h.writes[1]!.reject(new Error("model write failed"));
      else if (outcome === "committed") h.writes[1]!.resolve({ status: outcome, journalId: "model", appliedFields: ["models"], snapshot: h.base });
      else h.writes[1]!.resolve({ status: outcome, snapshot: h.base, message: "model write failed" });
      await immediate.catch(() => undefined);
    });
    assert.equal(h.current().saveError, "manual write failed");
    assert.equal(h.current().manualSaving, false);
  } finally { await h.close(); }
});

for (const outcome of ["committed", "rolled_back", "throw"] as const) test(`手动提交 ${outcome} 只在该事务期间报告 manualSaving`, async () => {
  const h = await fixture();
  try {
    await h.React.act(() => h.current().setChatParams({ ...h.base.chatParams, temperature: 0.2 }));
    let saving!: ReturnType<SettingsDraftContextValue["saveAll"]>;
    await h.React.act(() => { saving = h.current().saveAll(); });
    assert.equal(h.current().manualSaving, true);
    await h.React.act(async () => {
      if (outcome === "throw") h.writes[0]!.reject(new Error("manual write failed"));
      else if (outcome === "committed") h.writes[0]!.resolve({ status: outcome, journalId: "manual", appliedFields: ["chatParams"], snapshot: h.base });
      else h.writes[0]!.resolve({ status: outcome, snapshot: h.base, message: "manual write failed" });
      await saving;
    });
    assert.equal(h.current().manualSaving, false);
  } finally { await h.close(); }
});

for (const model of ["工具模型", "视觉模型"] as const) for (const outcome of ["rolled_back", "recovery_required"] as const) test(`${model} 的 ${outcome} 回执在本项显示失败`, async () => {
  const h = await fixture();
  try {
    if (model === "视觉模型") await h.click('[aria-label="启用视觉模型"]');
    else {
      await h.click('[aria-label="工具模型"]');
      await h.click('.settings-model-picker-option');
    }
    await h.React.act(async () => { h.writes[0]!.resolve(outcome === "rolled_back"
      ? { status: outcome, snapshot: h.base, message: `${model} write failed` }
      : { status: outcome, journalId: "recovery", message: `${model} recovery required` }); });
    const section = document.getElementById(model === "工具模型" ? "tool-model" : "vision-model")!;
    assert.match(section.querySelector('[role="alert"]')?.textContent ?? "", new RegExp(model));
    if (outcome === "rolled_back") {
      assert.equal(h.current().saveError, undefined);
      assert.deepEqual(h.notifications, [], "仍在本项时不重复发通知");
    }
    else {
      assert.equal(h.current().saveState, "recovery_required");
      assert.equal(h.current().saveError, `${model} recovery required`);
    }
  } finally { await h.close(); }
});

test("关闭等待涵盖后来入队的模型保存，后续成功不掩盖前序失败", async () => {
  const h = await fixture();
  try {
    await h.click('[aria-label="工具模型"]');
    await h.click('.settings-model-picker-option');
    let settled = false;
    const flush = h.current().flushModelEdits!().then(result => { settled = true; return result; });
    await h.click('[aria-label="启用视觉模型"]');
    assert.equal(h.writes.length, 1, "第二次提交仍在串行队列等待");
    await h.React.act(async () => h.writes[0]!.resolve({ status: "rolled_back", snapshot: h.base, message: "tool model failed" }));
    assert.equal(h.writes.length, 2);
    assert.equal(settled, false, "关闭继续等待后来入队的提交");
    await h.React.act(async () => h.writes[1]!.resolve({ status: "committed", journalId: "vision", appliedFields: ["models"], snapshot: h.base }));
    assert.equal(await flush, false, "后一次成功不能把本轮等待中的失败算作全部成功");
    assert.match(document.querySelector('#tool-model [role="alert"]')?.textContent ?? "", /tool model failed/u);
    assert.equal(await h.current().flushModelEdits!(), true, "下一次主动关闭不会永远受旧错误阻止");
  } finally { await h.close(); }
});

test("无项目的外观即时保存失败仍有反馈，不占用手动保存错误", async () => {
  const h = await fixture(false);
  try {
    await h.React.act(() => h.current().setThemePreference("light"));
    await h.React.act(async () => { h.preferences[0]!.reject(new Error("preference write failed")); });
    assert.deepEqual(h.notifications, ["preference write failed"]);
    assert.equal(h.current().saveError, undefined);
    assert.equal(h.current().manualSaving, false);
  } finally { await h.close(); }
});
