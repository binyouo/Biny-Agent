/**
 * 设置快照预热：点击设置入口先发出一次 IPC，Provider 挂载时复用同一个 promise，
 * 既不能让"加载中"抢镜，也不能重复读盘。
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { defaultConfig } from "../src/config/schema.js";
import type { DesktopSettingsSnapshot } from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const imports = registerHooks({ load(url, context, next) {
  if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  return next(url, context);
} });
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
dom.window.HTMLElement.prototype.scrollTo = () => {};
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, React,
  navigator: dom.window.navigator,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true
})) {
  savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
after(() => {
  dom.window.close();
  imports.deregister();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const { createRoot } = await import("react-dom/client");
const { SettingsDraftProvider, warmSettingsSnapshot } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftProvider.js");
const { useSettingsDraft } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function snapshot(projectId: string): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  return {
    projectId, hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "system", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/tmp/settings-prewarm" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat,
    toolExecutionMode: config.agent.toolExecutionMode,
    subagent: { enabled: false, runtime: "builtin" }, externalSubagentBlockers: [],
    permission: config.permission, webSearch: config.web.search,
    models: { configured: [], connections: [], embeddingModels: [], modelProfiles: {} },
    skills: { projectId, projectKey: projectId, globalDefaults: {}, projectOverrides: {}, activations: [] }
  } as DesktopSettingsSnapshot;
}

function binyFor(calls: string[], overrides: Record<string, unknown> = {}) {
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: async (projectId: string) => {
        calls.push(`snapshot:${projectId}`);
        return snapshot(projectId);
      },
      activitySettings: async () => { calls.push("activity"); return { activity: structuredClone(defaultConfig.activity), configRevision: "a:1" }; },
      releaseSettingsCredentials: async () => {},
      ...overrides
    }
  });
}

function mount(projectId?: string, sessionId?: string) {
  const root = createRoot(dom.window.document.getElementById("root")!);
  let context: SettingsDraftContextValue | undefined;
  function Probe() { context = useSettingsDraft(); return null; }
  return {
    context: () => { assert.ok(context); return context; },
    async render(active: boolean) {
      await act(async () => root.render(React.createElement(SettingsDraftProvider, {
        active, projectId, sessionId, sessionRunning: false,
        onCommitted: () => {}, onFontPreview: () => {}, onThemePreview: () => {},
        onNotify: () => {}, children: React.createElement(Probe)
      })));
    },
    async unmount() { await act(async () => root.unmount()); }
  };
}

test("预热 in-flight 的 IPC 被 Provider 订阅，不重复读盘", async () => {
  const calls: string[] = [];
  const gate = deferred<DesktopSettingsSnapshot>();
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: (projectId: string) => { calls.push(`snapshot:${projectId}`); return gate.promise; },
      activitySettings: async () => { throw new Error("unexpected"); },
      releaseSettingsCredentials: async () => {}
    }
  });
  warmSettingsSnapshot("project", "session");
  assert.deepEqual(calls, ["snapshot:project"]);
  const view = mount("project", "session");
  await view.render(true);
  assert.deepEqual(calls, ["snapshot:project"], "mount 复用预热请求而不是再发一次");
  await act(async () => gate.resolve(snapshot("project")));
  await view.render(true);
  assert.equal(view.context().snapshot?.projectId, "project");
  assert.equal(view.context().loading, false);
  await view.unmount();
});

test("预热 resolve 后快照进模块缓存，打开即用 stale 渲染并后台校验", async () => {
  const calls: string[] = [];
  const second = deferred<DesktopSettingsSnapshot>();
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: (projectId: string) => {
        calls.push(`snapshot:${projectId}`);
        return calls.length === 1 ? Promise.resolve(snapshot(projectId)) : second.promise;
      },
      activitySettings: async () => { throw new Error("unexpected"); },
      releaseSettingsCredentials: async () => {}
    }
  });
  warmSettingsSnapshot("project", "session");
  // 等 warm promise 完成并写进 persisted 缓存（其 .then 在 microtask 跑）。
  await act(async () => { await Promise.resolve(); });
  const view = mount("project", "session");
  await view.render(true);
  assert.equal(view.context().snapshot?.projectId, "project");
  assert.equal(view.context().loading, false);
  assert.equal(view.context().revalidating, true, "stale 渲染后仍要后台校验");
  assert.deepEqual(calls, ["snapshot:project", "snapshot:project"], "后台校验发了一次新 IPC");
  await act(async () => second.resolve(snapshot("project")));
  await view.render(true);
  assert.equal(view.context().revalidating, false);
  await view.unmount();
});

test("没有预热时 Provider 自己发 IPC（首次打开仍然走正常加载）", async () => {
  const calls: string[] = [];
  binyFor(calls);
  const view = mount("project", "session");
  await view.render(true);
  assert.deepEqual(calls, ["snapshot:project"]);
  assert.equal(view.context().snapshot?.projectId, "project");
  await view.unmount();
});

test("预热失败且 Provider 未消费时，打开设置回退到正常加载而不是卡在错误", async () => {
  const calls: string[] = [];
  let first = true;
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: async (projectId: string) => {
        calls.push(`snapshot:${projectId}`);
        if (first) { first = false; throw new Error("warm failed"); }
        return snapshot(projectId);
      },
      activitySettings: async () => { throw new Error("unexpected"); },
      releaseSettingsCredentials: async () => {}
    }
  });
  warmSettingsSnapshot("project", "session");
  // 等热请求失败后从 map 里自清。
  await new Promise(resolve => setImmediate(resolve));
  const view = mount("project", "session");
  await view.render(true);
  assert.equal(calls.length, 2, "失败的预热 promise 已过期，Provider 重新读");
  assert.equal(view.context().snapshot?.projectId, "project");
  await view.unmount();
});

test("无项目时不发 settingsSnapshot", async () => {
  const calls: string[] = [];
  binyFor(calls);
  warmSettingsSnapshot(undefined, undefined);
  assert.deepEqual(calls, []);
});

test("Provider 卸载重挂后用模块缓存先渲染，不发 loading 态", async () => {
  const calls: string[] = [];
  const gate = deferred<DesktopSettingsSnapshot>();
  let second = false;
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: (projectId: string) => {
        calls.push(`snapshot:${projectId}`);
        return second ? gate.promise : Promise.resolve(snapshot(projectId));
      },
      activitySettings: async () => { throw new Error("unexpected"); },
      releaseSettingsCredentials: async () => {}
    }
  });
  const first = mount("project", "session");
  await first.render(true);
  assert.equal(first.context().snapshot?.projectId, "project");
  await first.unmount();

  second = true;
  const secondView = mount("project", "session");
  await secondView.render(true);
  // 第二次挂载应直接用上次快照渲染（revalidating），不发 loading。
  assert.equal(secondView.context().snapshot?.projectId, "project");
  assert.equal(secondView.context().loading, false);
  assert.equal(secondView.context().revalidating, true);
  await act(async () => gate.resolve(snapshot("project")));
  await secondView.render(true);
  assert.equal(secondView.context().revalidating, false);
  await secondView.unmount();
});
