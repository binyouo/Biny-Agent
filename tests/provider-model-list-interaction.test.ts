/**
 * 模型列表的交互契约：开关一个模型不改变它在列表里的位置，批量写入期间给出忙碌反馈
 * 且不能重复触发。
 *
 * 模型列表以目录顺序展示。若按启用状态重排，点开一个模型会让该行从当前位置跳到列表
 * 另一头，连续启用多个模型时每次都要重新找位置，滚动位置也随之丢失。批量写入（「全选」
 * 可能一次提交上千个模型）期间必须能看出正在进行，并挡住重复点击。
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { defaultConfig } from "../src/config/schema.js";
import type {
  DesktopModelConnection,
  DesktopSettingsSaveInput,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot
} from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const catalogModelCount = 40;

const imports = registerHooks({ load(url, context, next) {
  if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  return next(url, context);
} });
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
dom.window.HTMLElement.prototype.scrollTo = () => {};
Object.assign(dom.window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, React, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
  navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => { throw new Error("Unexpected network request"); }
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
const { ProviderSettings } = await import("../src/desktop/renderer/src/components/settings/ProviderSettings.js");
const { SettingsDraftProvider } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftProvider.js");
const { useSettingsDraft } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");

/** 目录按固定顺序给出，模型名带序号便于断言行序。 */
function catalogEntries(): ModelCatalogEntry[] {
  return Array.from({ length: catalogModelCount }, (_unused, index) => ({
    id: `vendor/model-${String(index).padStart(2, "0")}`,
    displayName: `Model ${String(index).padStart(2, "0")}`,
    provider: "openrouter",
    capabilities: { tools: true, reasoning: true, streaming: true },
    reasoningEfforts: ["high"],
    reasoningEffortsSource: "declared" as const
  }));
}

/** 初始只启用目录里的第一个模型。 */
function configuredModels(): DesktopSettingsSnapshot["models"]["configured"] {
  const first = catalogEntries()[0]!;
  return [{
    alias: `openrouter-${first.id}`, displayName: first.displayName, model: first.id,
    modelKey: `openrouter\u0000${first.id}`, provider: "openrouter", providerType: "openrouter",
    available: true, source: "configured", efforts: ["high"], defaultThinking: "high",
    thinkingLevelMap: {}, showInPicker: true
  }];
}

function snapshot(): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  const connection: DesktopModelConnection = {
    providerAlias: "openrouter", providerType: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1", protocol: "openai-compatible",
    requiresApiKey: true, hasCredential: true, credentialSource: "config"
  };
  return {
    projectId: "project", hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "system", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/tmp/provider-model-list" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat,
    toolExecutionMode: config.agent.toolExecutionMode,
    subagent: { enabled: false, runtime: "builtin" }, externalSubagentBlockers: [],
    permission: config.permission, webSearch: config.web.search,
    models: {
      configured: configuredModels(), connections: [connection], embeddingModels: [],
      defaultModel: undefined, thinking: "off", modelProfiles: {}
    },
    skills: { projectId: "project", projectKey: "project", globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}

/**
 * 保存把本次 upsert 与显示偏好并回快照，让界面能观察到启用状态变化——否则「开关后行序
 * 是否改变」根本无从断言。`gate` 存在时写入挂起，用来观察进行中的界面状态。
 */
async function harness(options: { gate?: Promise<void>; firstFailure?: "rejected" | "rolled_back" } = {}) {
  const writes: DesktopSettingsSaveInput[] = [];
  const notifications: string[] = [];
  let current = snapshot();
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: async () => current,
      stageSettingsCredential: async () => { throw new Error("Unexpected credential staging"); },
      releaseSettingsCredentials: async () => {},
      saveSettings: async (_projectId: string, input: DesktopSettingsSaveInput): Promise<DesktopSettingsSaveResult> => {
        writes.push(input);
        if (options.gate) await options.gate;
        if (writes.length === 1 && options.firstFailure) {
          if (options.firstFailure === "rejected") throw new Error("保存连接失败");
          return { status: "rolled_back", draftRetained: true, message: "配置已被修改，请重试", snapshot: current };
        }
        const upserts = input.models?.upserts ?? [];
        const profiles = input.models?.modelProfiles?.openrouter ?? {};
        const configured = [...current.models.configured];
        for (const upsert of upserts) {
          if (configured.some(model => model.model === upsert.model)) continue;
          configured.push({
            alias: upsert.alias, displayName: upsert.displayName, model: upsert.model,
            modelKey: `openrouter\u0000${upsert.model}`, provider: "openrouter", providerType: "openrouter",
            available: true, source: "configured", efforts: ["high"], defaultThinking: "high",
            thinkingLevelMap: {}, showInPicker: profiles[upsert.model]?.showInPicker ?? true
          });
        }
        const next = configured.map(model => profiles[model.model] === undefined
          ? model
          : { ...model, showInPicker: profiles[model.model]!.showInPicker });
        current = {
          ...current, configRevision: `config:${String(writes.length + 1)}`,
          models: { ...current.models, configured: next, modelProfiles: input.models?.modelProfiles ?? current.models.modelProfiles }
        };
        return { status: "committed", journalId: "synthetic", appliedFields: [], snapshot: current };
      }
    }
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let draftContext: SettingsDraftContextValue | undefined;
  function Content() {
    const context = useSettingsDraft();
    draftContext = context;
    return React.createElement(ProviderSettings, {
      active: true, loading: false, projectId: "project", catalogs: { openrouter: catalogEntries() },
      models: context.snapshot?.models.configured ?? [], connections: context.snapshot?.models.connections ?? [],
      defaultModelAlias: context.snapshot?.models.defaultModel,
      onReadModelApiKey: async () => "synthetic-key",
      onFetchCatalog: async (providerAlias: string) => ({ providerAlias, source: "fetched" as const, fetchedAt: "", models: catalogEntries() }),
      onTest: async () => ({ ok: true, message: "synthetic" }),
      onStartLogin: async () => { throw new Error("Unexpected login"); },
      onCompleteLogin: async () => { throw new Error("Unexpected login"); },
      onCancelLogin: async () => {}, onNotify: (message: string) => notifications.push(message), onOpenExternal: async () => { throw new Error("Unexpected external URL"); }
    });
  }
  await act(async () => root.render(React.createElement(SettingsDraftProvider, {
    active: true, projectId: "project", sessionRunning: false, onCommitted: () => {},
    onFontPreview: () => {}, onThemePreview: () => {}, onNotify: (message: string) => notifications.push(message), children: React.createElement(Content)
  })));
  const document = dom.window.document;
  const providerRow = [...document.querySelectorAll<HTMLButtonElement>(".provider-row")].find(row => row.textContent?.includes("OpenRouter"));
  assert.ok(providerRow, "OpenRouter 服务商行存在");
  await act(async () => { providerRow.click(); });
  /** 列表当前行序（模型名），用于断言开关后位置不变。 */
  const rowOrder = (): string[] => [...document.querySelectorAll(".provider-model-row .provider-model-name")]
    .map(element => element.textContent ?? "");
  const toggles = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".provider-model-row .model-toggle")];
  const selectAll = (): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>(".settings-link")]
    .find(button => /全选|正在保存/u.test(button.textContent ?? ""));
  return {
    writes: () => writes,
    feedback: () => [...notifications, ...document.querySelectorAll(".provider-inline-notice")].map(value => typeof value === "string" ? value : value.textContent ?? ""),
    rowOrder,
    toggles,
    selectAll,
    toggleAt: async (index: number) => { await act(async () => { toggles()[index]!.click(); }); },
    clickSelectAll: async () => { await act(async () => { selectAll()!.click(); }); },
    draftContext: () => { assert.ok(draftContext); return draftContext; },
    close: async () => {
      await act(async () => { root.unmount(); });
      Reflect.deleteProperty(dom.window, "biny");
    }
  };
}

test("开关一个模型不改变它在列表里的位置", async () => {
  const h = await harness();
  try {
    const before = h.rowOrder();
    assert.equal(before.length, catalogModelCount, "整份目录都列出来");
    // 启用列表中间偏后的模型：按启用状态重排会把它挪到最前面。
    const targetIndex = catalogModelCount - 2;
    const targetName = before[targetIndex]!;
    assert.equal(targetName, `Model ${String(targetIndex).padStart(2, "0")}`);
    await h.toggleAt(targetIndex);
    assert.equal(h.writes().length, 1, "单个开关提交一次");
    const after = h.rowOrder();
    assert.deepEqual(after, before, "行序保持目录顺序，被点的行不能跳到列表另一头");
    assert.equal(after.indexOf(targetName), targetIndex, "目标行仍在原位置");
  } finally {
    await h.close();
  }
});

test("批量写入期间显示进行中并挡住重复触发", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({ gate });
  try {
    assert.equal(h.selectAll()?.disabled, false, "空闲时可点");
    // 不 await：写入挂起在 gate 上，正是需要观察的进行中状态。
    await act(async () => { h.selectAll()!.click(); });
    const busy = h.selectAll();
    assert.equal(busy?.disabled, true, "写入进行中必须挡住重复点击");
    assert.equal(busy?.getAttribute("aria-busy"), "true", "进行中状态对辅助技术可见");
    assert.match(busy?.textContent ?? "", /正在保存/u, "进行中有可见文案");
    const writesDuringFlight = h.writes().length;
    assert.equal(writesDuringFlight, 1);
    // 再点一次不应排入第二个事务。
    await act(async () => { busy?.click(); });
    assert.equal(h.writes().length, writesDuringFlight, "重复点击不得再排一次事务");
    release?.();
    await act(async () => { await h.draftContext().flushModelEdits(); });
    assert.equal(h.writes().length, 1, "保存队列排空后仍只提交一次");
    const settled = h.selectAll();
    assert.equal(settled?.disabled, false, "写入结束后恢复可点");
    assert.match(settled?.textContent ?? "", /取消全选/u, "整份目录启用后入口变为取消全选");
  } finally {
    release?.();
    await act(async () => { await h.draftContext().flushModelEdits(); });
    await h.close();
  }
});

for (const action of ["单个开关", "全选"] as const) {
  test(`${action}重复点击和交叉点击不排入额外保存事务`, async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await harness({ gate });
    try {
      await act(async () => {
        const trigger = action === "全选" ? h.selectAll()! : h.toggles()[2]!;
        trigger.click();
        trigger.click();
        h.toggles()[3]!.click();
      });
      const disabledDuringSave = h.toggles().every(toggle => toggle.disabled);
      await h.toggleAt(4);
      release?.();
      await act(async () => { await h.draftContext().flushModelEdits(); });
      assert.equal(h.writes().length, 1, "排空真实保存队列后仍只有一次 IPC 写入");
      assert.ok(disabledDuringSave, "保存期间所有模型行明确禁用");
      assert.ok(h.toggles().every(toggle => !toggle.disabled), "保存完成后所有模型行恢复可用");
      assert.equal(h.selectAll()?.disabled, false);
      assert.equal(h.draftContext().saveState, "clean");
      if (action === "单个开关") {
        assert.equal(h.toggles()[2]!.getAttribute("aria-checked"), "true");
        assert.equal(h.toggles()[3]!.getAttribute("aria-checked"), "false", "忙碌期间未接纳的操作不能延迟执行");
        await h.toggleAt(2);
        await h.toggleAt(3);
        assert.equal(h.writes().length, 3, "每次保存完成后可继续逐项切换");
        assert.equal(h.toggles()[2]!.getAttribute("aria-checked"), "false");
        assert.equal(h.toggles()[3]!.getAttribute("aria-checked"), "true");
        assert.equal(h.toggles()[0]!.getAttribute("aria-checked"), "true", "其他模型的既有选择不受影响");
      }
    } finally {
      release?.();
      await act(async () => { await h.draftContext().flushModelEdits(); });
      await h.close();
    }
  });
}

for (const firstFailure of ["rejected", "rolled_back"] as const) {
  test(`${firstFailure} 后保留已保存选择、释放忙态并允许重试`, async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await harness({ gate, firstFailure });
    try {
      await h.toggleAt(2);
      assert.equal(h.toggles()[2]!.disabled, true, "保存期间单行开关禁用");
      assert.equal(h.selectAll()?.disabled, true, "保存期间批量开关禁用");
      release?.();
      await act(async () => { await h.draftContext().flushModelEdits(); });
      assert.equal(h.toggles()[2]!.getAttribute("aria-checked"), "false", "失败不展示未保存的选择");
      assert.equal(h.toggles()[2]!.disabled, false);
      assert.equal(h.selectAll()?.disabled, false);
      assert.equal(h.draftContext().saveState, "clean");
      const expectedError = firstFailure === "rejected" ? "保存连接失败" : "配置已被修改，请重试";
      assert.ok(h.feedback().some(message => message.includes(expectedError)), "错误反馈仍可见");
      await h.toggleAt(2);
      assert.equal(h.writes().length, 2);
      assert.equal(h.toggles()[2]!.getAttribute("aria-checked"), "true", "重试成功后才更新选择");
    } finally {
      release?.();
      await act(async () => { await h.draftContext().flushModelEdits(); });
      await h.close();
    }
  });
}
