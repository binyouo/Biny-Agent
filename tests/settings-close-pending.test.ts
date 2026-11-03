/** 真实设置外壳关闭流程；IPC 写入用闸门控制，原生确认用可观察替身。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import type { DesktopSettingsSaveInput, DesktopSettingsSaveResult, DesktopSettingsSnapshot } from "../src/desktop/protocol.js";

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

async function fixture(withProject: boolean) {
  const hooks = registerHooks({ load(url, context, next) {
    if (/\.(svg|png|css)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://settings.test", pretendToBeVisual: true });
  const React = await import("react");
  const base = snapshot();
  const writes: Array<{ input: DesktopSettingsSaveInput; gate: ReturnType<typeof Promise.withResolvers<DesktopSettingsSaveResult>> }> = [];
  const preferences: Array<ReturnType<typeof Promise.withResolvers<"light">>> = [];
  const notifications: string[] = [];
  const confirmations: string[] = [];
  let closes = 0;
  Object.assign(dom.window, {
    confirm: (message: string) => { confirmations.push(message); return false; },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    biny: {
      quickChatSettings: async () => ({ autoHideOnBlur: true, injectScreenContext: false, clickThrough: false }),
      settingsSnapshot: async () => base, activitySettings: async () => ({ activity: base.activity }),
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {}, releaseSettingsCredentials: async () => {},
      saveSettings: async (_project: string, input: DesktopSettingsSaveInput) => {
        const gate = Promise.withResolvers<DesktopSettingsSaveResult>(); writes.push({ input, gate }); return await gate.promise;
      },
      setThemePreference: async () => { const gate = Promise.withResolvers<"light">(); preferences.push(gate); return await gate.promise; }
    }
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
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
  const { SettingsOverlay } = await import("../src/desktop/renderer/src/components/settings/SettingsOverlay.js");
  const root = createRoot(document.getElementById("root")!);
  function Host() {
    const [open, setOpen] = React.useState(true);
    const props = {
      open, version: "test", projects: [], modelSetupRequired: false, sessionRunning: false,
      targetTab: withProject ? "聊天" : "通用",
      workspace: withProject ? { project: { id: "project", name: "Project" }, models: [], connections: [] } : undefined,
      themePreference: "system", fontPreference: { family: "system", size: 14 },
      onThemePreference() {}, onFontPreference() {}, onSettingsCommitted() {},
      onNotify(message: string) { notifications.push(message); },
      onClose() { closes += 1; setOpen(false); }
    };
    return React.createElement(SettingsOverlay, props as unknown as React.ComponentProps<typeof SettingsOverlay>);
  }
  await React.act(async () => root.render(React.createElement(Host)));
  return { React, base, writes, preferences, notifications, confirmations, closes: () => closes,
    async click(selector: string) {
      const element = document.querySelector<HTMLElement>(selector); assert.ok(element, selector);
      await React.act(async () => element.click());
    },
    async close() {
      await React.act(() => root.unmount());
      await React.act(async () => {
        for (const { gate } of writes) gate.resolve({ status: "committed", journalId: "cleanup", appliedFields: [], snapshot: base });
        for (const gate of preferences) gate.resolve("light");
        await Promise.allSettled([...writes.map(({ gate }) => gate.promise), ...preferences.map(gate => gate.promise)]);
      });
      dom.window.close(); hooks.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

for (const outcome of ["committed", "failed"] as const) test(`无项目外观 ${outcome} 后继续关闭，不把等待误报为未保存草稿`, async () => {
  const h = await fixture(false);
  try {
    await h.click('[aria-label="外观"] input[value="light"]');
    assert.equal(h.preferences.length, 1);
    assert.equal(document.querySelector<HTMLButtonElement>('.settings-footer-actions button')?.disabled, false);
    await h.click('.settings-footer-actions button');
    assert.equal(h.closes(), 0, "关闭须等待已发出的写入结束");
    assert.equal(h.confirmations.length, 0);
    await h.React.act(async () => {
      if (outcome === "committed") h.preferences[0]!.resolve("light");
      else h.preferences[0]!.reject(new Error("preference write failed"));
    });
    assert.equal(h.confirmations.length, 0, "即时操作结束后没有手动草稿，不询问丢弃");
    assert.equal(h.closes(), 1);
    assert.deepEqual(h.notifications, outcome === "failed" ? ["preference write failed"] : []);
  } finally { await h.close(); }
});

for (const outcome of ["committed", "committed_with_edit", "rolled_back", "recovery_required"] as const) test(`手动保存 ${outcome} 后按实际草稿和恢复状态决定关闭`, async () => {
  const h = await fixture(true);
  try {
    await h.click('[aria-label="启用流式响应"]');
    await h.click('.settings-save-button');
    assert.equal(h.writes.length, 1);
    if (outcome === "committed_with_edit" || outcome === "recovery_required") await h.click('[aria-label="启用流式响应"]');
    await h.click('[aria-label="关闭设置"]');
    assert.equal(h.closes(), 0);
    assert.equal(h.confirmations.length, 0, "提交期间不询问丢弃");
    await h.React.act(async () => {
      h.writes[0]!.gate.resolve(outcome === "rolled_back"
        ? { status: outcome, snapshot: h.base, message: "manual write failed" }
        : outcome === "recovery_required"
          ? { status: outcome, journalId: "recovery", message: "manual recovery required" }
          : { status: "committed", journalId: "manual", appliedFields: ["chatParams"],
            snapshot: { ...h.base, chatParams: h.writes[0]!.input.chatParams! } });
    });
    if (outcome === "committed") {
      assert.equal(h.confirmations.length, 0, "提交成功且无剩余草稿应继续关闭");
      assert.equal(h.closes(), 1);
    } else {
      assert.equal(h.confirmations.length, 1, "保留新编辑、失败草稿与零草稿恢复边界的关闭确认");
      assert.equal(h.closes(), 0, "取消确认后仍停留在设置");
      if (outcome === "rolled_back" || outcome === "recovery_required") {
        assert.match(document.querySelector('.settings-save-error')?.textContent ?? "", /manual/u);
      }
    }
  } finally { await h.close(); }
});
