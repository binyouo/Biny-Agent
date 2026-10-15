/**
 * Computer History 数字/语言输入的提交节奏：一次编辑只提交一次。
 *
 * 每次提交都会走 ActivityRecorderService.applySettings 的完整重启路径（停采集器、
 * 重开 SQLite、reconcile 快照目录、重启调度），所以逐键提交会把「输入一个五位数」
 * 变成四次重启，并中断正在进行的分析。DOM 断言不代替人工界面验收。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { ActivityRuntimeSnapshot } from "../src/activity/types.js";
import type { DesktopActivitySettingsInput } from "../src/desktop/protocol.js";

test("数字与语言输入只在提交时机落盘，逐键编辑不重复重启采集器", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
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
    sessions: 0, events: 0, fallbackCaptures: 0, storageBytes: 0, recentSessions: [],
    analysis: { failed: 0, pending: 0 }
  } as ActivityRuntimeSnapshot;
  const commits: Array<Partial<DesktopActivitySettingsInput>> = [];
  let activity: DesktopActivitySettingsInput = { ...defaultActivitySettings, enabled: true };
  let failCommit = false;
  let commitGate: Promise<void> | undefined;
  Object.defineProperty(dom.window, "biny", { configurable: true, value: {
    activitySettings: async () => ({ activity, configRevision: "0" }),
    updateActivitySettings: async (patch: Partial<DesktopActivitySettingsInput>) => {
      commits.push(patch);
      await commitGate;
      if (failCommit) throw new Error("采集设置保存失败");
      activity = { ...activity, ...patch };
      return { activity, configRevision: String(commits.length) };
    },
    previewAppearance: async () => undefined,
    updateSettingsDraftState: async () => undefined,
    releaseSettingsCredentials: async () => undefined,
    activitySnapshot: async () => runtime,
    activityPermissions: async () => ({ platform: "darwin", screenRecording: "denied", accessibility: false, openSettingsCapable: true }),
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
  const { SettingsDraftProvider } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDraftProvider.tsx") as typeof import("../src/desktop/renderer/src/components/settings/SettingsDraftProvider.js");
  const root = createRoot(document.getElementById("root")!);
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(SettingsDraftProvider, {
        active: true, sessionRunning: false,
        onCommitted: () => undefined, onFontPreview: () => undefined,
        onThemePreview: () => undefined, onNotify: () => undefined,
        children: createElement(ActivityRuntimeProvider, { active: true }, createElement(SettingsActivity))
      }));
    });
  };
  const type = async (selector: string, value: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>(selector);
    assert.ok(input, selector);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const blur = async (selector: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>(selector);
    assert.ok(input, selector);
    // React 通过冒泡的 focusout 委托 onBlur；不冒泡的 blur 到不了根监听器。
    await act(async () => { input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  };
  try {
    await render();
    // 展开折叠的采集参数区，数字字段在其中。
    const capture = document.getElementById("activity-capture") as HTMLDetailsElement;
    capture.open = true;
    await render();

    // 输入五位数：逐键期间不得提交，提交时机（blur）才落一次。
    await type("#activity-debounce", "1");
    await type("#activity-debounce", "12");
    await type("#activity-debounce", "123");
    await type("#activity-debounce", "1234");
    assert.deepEqual(commits, [], "逐键编辑不得提交，否则每敲一位就重启一次采集器");
    await blur("#activity-debounce");
    assert.equal(commits.length, 1, "提交时机落盘一次");
    assert.equal(commits[0]?.captureDebounceMs, 3_000, "低于下限的输入按边界收敛");

    // 回车同样是提交时机。
    commits.length = 0;
    await type("#activity-debounce", "8000");
    assert.deepEqual(commits, [], "输入过程不提交");
    const input = document.querySelector<HTMLInputElement>("#activity-debounce")!;
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(commits.length, 1, "回车提交一次");
    assert.equal(commits[0]?.captureDebounceMs, 8_000);
    await blur("#activity-debounce");
    assert.equal(commits.length, 1, "回车后失焦不重复提交已保存的值");

    // 保存失败后，同一数字仍能再次显式提交。
    commits.length = 0;
    failCommit = true;
    await type("#activity-debounce", "9000");
    await blur("#activity-debounce");
    assert.equal(commits.length, 1);
    assert.match(document.body.textContent ?? "", /采集设置保存失败/u);
    assert.equal(input.value, "9000", "保存失败保留编辑值");
    failCommit = false;
    await blur("#activity-debounce");
    assert.equal(commits.length, 2, "同一数字保存失败后可重试");
    assert.equal(activity.captureDebounceMs, 9_000);

    // 无效或未改变的数字不写入采集配置。
    commits.length = 0;
    await type("#activity-debounce", "");
    await blur("#activity-debounce");
    assert.equal(input.value, "9000");
    assert.deepEqual(commits, []);

    // OCR 语言列表同理：逗号分隔的多段输入只在提交时机落盘。
    commits.length = 0;
    await type("#activity-ocr-languages", "en-US, zh");
    await type("#activity-ocr-languages", "en-US, zh-Hans");
    assert.deepEqual(commits, [], "语言输入过程不提交");
    await blur("#activity-ocr-languages");
    assert.equal(commits.length, 1, "语言列表提交一次");
    assert.deepEqual(commits[0]?.ocrLanguages, ["en-US", "zh-Hans"]);
    await blur("#activity-ocr-languages");
    assert.equal(commits.length, 1, "未改变语言列表不重复提交");

    // Enter 与随后的 blur 共享在途提交，不能在串行保存队列里再排一次重启。
    commits.length = 0;
    let releaseCommit!: () => void;
    commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    await type("#activity-ocr-languages", "en-US, ja-JP");
    const languages = document.querySelector<HTMLInputElement>("#activity-ocr-languages")!;
    try {
      await act(async () => { languages.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      assert.equal(commits.length, 1, "语言列表支持回车提交");
      await blur("#activity-ocr-languages");
    } finally {
      await act(async () => { releaseCommit(); });
      commitGate = undefined;
    }
    assert.equal(commits.length, 1, "语言提交未返回时失焦不会排队重复保存");
    assert.deepEqual(activity.ocrLanguages, ["en-US", "ja-JP"]);

    for (const [selector, intermediate, latest, savedValue] of [
      ["#activity-debounce", "10000", "11000", () => String(activity.captureDebounceMs)],
      ["#activity-ocr-languages", "en-US, fr-FR", "en-US, de-DE", () => activity.ocrLanguages.join(", ")]
    ] as const) {
      const original = savedValue();
      // 第一笔尚未返回时改回旧值，第二次明确提交仍须保留。
      commits.length = 0;
      let releaseFirst!: () => void;
      commitGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      try {
        await type(selector, intermediate);
        await blur(selector);
        await type(selector, original);
        await blur(selector);
      } finally {
        await act(async () => { releaseFirst(); });
        commitGate = undefined;
      }
      assert.equal(commits.length, 2, `${selector} 在途时改回旧值仍应保存`);
      assert.equal(savedValue(), original);

      // 第一笔成功、第二笔失败时，输入框保留最后编辑值供显式重试。
      commitGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      try {
        await type(selector, intermediate);
        await blur(selector);
        await type(selector, latest);
        await blur(selector);
        commitGate = secondGate;
        await act(async () => { releaseFirst(); });
        failCommit = true;
        await act(async () => { releaseSecond(); });
        assert.equal(document.querySelector<HTMLInputElement>(selector)?.value, latest, "旧成功结果不覆盖后续失败草稿");
      } finally {
        releaseFirst();
        releaseSecond();
        commitGate = undefined;
        failCommit = false;
      }
      await blur(selector);
      assert.equal(savedValue(), latest, "最后一次失败的编辑可直接重试");

      commits.length = 0;
      commitGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      try {
        await type(selector, intermediate);
        await blur(selector);
        await type(selector, selector === "#activity-debounce" ? "10000.0" : "en-US,  fr-FR");
        await blur(selector);
      } finally {
        await act(async () => { releaseFirst(); });
        commitGate = undefined;
      }
      assert.equal(commits.length, 1, "同一规范值的显式提交合并在途请求");
      // 后续保存返回的新快照应能回填已保存字段，不能将其永久当成未保存草稿。
      activity = { ...activity, captureDebounceMs: 12_000, ocrLanguages: ["en-US", "ko-KR"] };
      await type("#activity-heartbeat", String(activity.heartbeatMs + 1_000));
      await blur("#activity-heartbeat");
      assert.equal(document.querySelector<HTMLInputElement>(selector)?.value, savedValue(), "同值合并保存成功后不残留草稿状态");
    }
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
