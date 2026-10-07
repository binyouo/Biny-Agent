/** 应用名称选择映射到既有排除标识；DOM 回归不代替桌面人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

test("暂停时仍可按名称排除同名应用，保存标识并保留未知旧条目；现有采集测试未覆盖设置交互", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div><div id='details'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let catalogFailure = false;
  Object.assign(dom.window, { biny: {
    activityApplications: async () => {
      if (catalogFailure) throw new Error("应用目录暂不可用");
      return [
        { bundleId: "test.saved", name: "Saved App", path: "/Applications/Saved.app" },
        { bundleId: "test.notes.one", name: "Notes", path: "/Applications/Notes.app" },
        { bundleId: "test.notes.two", name: "Notes", path: "/Users/test/Applications/Notes.app" }
      ];
    },
    activitySnapshot: async () => ({ state: "paused", sessions: 0, events: 0, storageBytes: 0, recentSessions: [] }),
    activityPermissions: async () => ({ platform: "other", screenRecording: "granted", accessibility: true, openSettingsCapable: false }),
    onActivityEvent: () => () => undefined
  } });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createServer } = await import("vite");
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true, entries: [] } });
  const { SettingsActivity } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsActivity.tsx") as typeof import("../src/desktop/renderer/src/components/settings/SettingsActivity.js");
  const { SettingsDraftContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDraftContext.ts") as typeof import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const { ActivityRuntimeProvider } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/ActivityRuntimeContext.tsx") as typeof import("../src/desktop/renderer/src/components/settings/ActivityRuntimeContext.js");
  const { SettingsDetailHostContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDetailHostContext.ts") as typeof import("../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js");
  const root = createRoot(document.getElementById("root")!);
  const writes: string[][] = [];
  let saveFailure = false;
  const draft = { activity: { ...defaultActivitySettings, enabled: false, sensitiveApplications: ["test.saved", "test.missing"] },
    updateActivityImmediately: async (patch) => {
      if (saveFailure) throw new Error("设置保存失败");
      if (patch.sensitiveApplications) writes.push([...patch.sensitiveApplications]);
      draft.activity = { ...draft.activity!, ...patch };
      render();
    } } as SettingsDraftContextValue;
  const render = (): void => root.render(createElement(SettingsDetailHostContext.Provider, { value: document.getElementById("details") },
    createElement(SettingsDraftContext.Provider, { value: draft }, createElement(ActivityRuntimeProvider, { active: true }, createElement(SettingsActivity)))));
  const click = async (label: string): Promise<void> => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label);
    assert.ok(button, `missing button: ${label}`);
    assert.equal(button.disabled, false);
    await act(async () => { button.click(); });
  };
  try {
    await act(async () => render());
    const section = document.getElementById("activity-sensitive-apps")!;
    assert.match(section.textContent ?? "", /不记录的应用/u);
    assert.match(section.textContent ?? "", /Saved App/u);
    assert.match(section.textContent ?? "", /test\.missing/u, "无法解析名称的旧标识必须保留");
    assert.equal(section.querySelector("textarea"), null, "名称选择替代手填标识");
    await click("添加应用");
    const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索应用"]')!;
    assert.ok(search);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "Notes");
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const choices = document.querySelectorAll('[data-application-choice]');
    assert.equal(choices.length, 2, "同名应用保留不同身份和路径");
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /\/Users\/test\/Applications\/Notes\.app/u);
    await click("不记录 Notes（test.notes.two）");
    assert.deepEqual(writes, [["test.saved", "test.missing", "test.notes.two"]]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    saveFailure = true;
    await click("恢复记录 Saved App");
    assert.match(section.textContent ?? "", /设置保存失败/u);
    assert.ok(draft.activity!.sensitiveApplications.includes("test.saved"), "失败不提前移除排除规则");
    saveFailure = false;
    await click("恢复记录 Saved App");
    assert.deepEqual(draft.activity!.sensitiveApplications, ["test.missing", "test.notes.two"]);
    await click("添加应用");
    const existing = document.querySelector<HTMLButtonElement>('button[aria-label="不记录 Notes（test.notes.two）"]');
    assert.ok(existing?.disabled, "已排除条目不能重复添加");
    await click("关闭应用列表");

    catalogFailure = true;
    await click("刷新应用列表");
    assert.match(section.textContent ?? "", /应用目录暂不可用/u);
    assert.match(section.textContent ?? "", /Notes/u, "刷新失败保留已知名称和配置");
    catalogFailure = false;
    await click("重试加载应用列表");
    assert.doesNotMatch(section.textContent ?? "", /应用目录暂不可用/u);
    assert.deepEqual(draft.activity!.sensitiveApplications, ["test.missing", "test.notes.two"]);
  } finally {
    await act(async () => root.unmount());
    await vite.close(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
