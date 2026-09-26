/** Activity 设置页从 Desktop IPC 读取实时系统权限；DOM 断言不代替人工界面验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { ActivityRuntimeSnapshot } from "../src/activity/types.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

test("权限刷新读取实时系统权限，不沿用采集器的上次状态；其他平台不显示 macOS 授权卡", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.document.documentElement.dataset.platform = "darwin";
  const runtime = {
    state: "paused", collectorAvailable: true, screenRecordingGranted: false,
    accessibilityGranted: false, fallbackAvailable: false, screenLocked: false,
    sessions: 0, events: 0, fallbackCaptures: 0, storageBytes: 0, recentSessions: []
  } as ActivityRuntimeSnapshot;
  let granted = false;
  let permissionFailure = false;
  let permissionReads = 0;
  Object.defineProperty(dom.window, "biny", { configurable: true, value: {
    activitySnapshot: async () => runtime,
    activityPermissions: async () => {
      permissionReads += 1;
      if (permissionFailure) throw new Error("系统权限不可读");
      return { platform: "darwin", screenRecording: granted ? "granted" : "denied",
        accessibility: granted, openSettingsCapable: true };
    },
    onActivityEvent: () => () => undefined
  } });
  const React = await import("react");
  const { act, createElement } = React;
  const { createRoot } = await import("react-dom/client");
  const { createServer } = await import("vite");
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom",
    optimizeDeps: { noDiscovery: true, entries: [] } });
  const { ActivityRuntimeProvider } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/ActivityRuntimeContext.tsx") as typeof import("../src/desktop/renderer/src/components/settings/ActivityRuntimeContext.js");
  const { SettingsActivity } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsActivity.tsx") as typeof import("../src/desktop/renderer/src/components/settings/SettingsActivity.js");
  const { SettingsDraftContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDraftContext.ts") as typeof import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const root = createRoot(document.getElementById("root")!);
  const draft = { activity: { ...defaultActivitySettings, enabled: false },
    updateActivityImmediately: async () => undefined } as SettingsDraftContextValue;
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(SettingsDraftContext.Provider, { value: draft },
        createElement(ActivityRuntimeProvider, { active: true }, createElement(SettingsActivity))));
    });
  };
  try {
    await render();
    assert.match(document.getElementById("activity-permissions")?.textContent ?? "", /屏幕录制需授权/u);
    granted = true;
    const refresh = document.querySelector<HTMLButtonElement>("button[aria-label='刷新 macOS 权限状态']");
    assert.ok(refresh);
    await act(async () => { refresh.click(); });
    assert.ok(permissionReads >= 2, "主动刷新必须再次读取系统权限");
    assert.match(document.getElementById("activity-permissions")?.textContent ?? "", /屏幕录制已授权/u);
    assert.equal(runtime.screenRecordingGranted, false, "设置页显示不能修改采集器的安全门禁");

    permissionFailure = true;
    await act(async () => { refresh.click(); });
    assert.match(document.getElementById("activity-permissions")?.textContent ?? "", /屏幕录制读取失败/u);
    assert.match(document.getElementById("activity-permissions")?.textContent ?? "", /系统权限读取失败：系统权限不可读/u);
    assert.doesNotMatch(document.getElementById("activity-permissions")?.textContent ?? "", /屏幕录制已授权/u);

    dom.window.document.documentElement.dataset.platform = "other";
    await render();
    assert.equal(document.getElementById("activity-permissions"), null);
  } finally {
    await act(() => root.unmount());
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
