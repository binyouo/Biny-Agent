/**
 * 「全选」的写入契约：整份服务商目录在一次设置事务里启用，且只提交会被持久化的字段。
 * 目录声明的上下文/输出额度只用于运行时解析与展示，不进入写入事务，
 * 否则一个上游声明（例如 943,718 输出）就会让整批启用被入参校验拒绝。
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import type {
  DesktopModelConnection,
  DesktopSettingsSaveInput,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot
} from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const catalogModelCount = 240;

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

/** 聚合目录里真实出现过的额度形状：窗口 1,048,576、输出 943,718（超过旧的 384,000 上限）。 */
function catalogEntries(): ModelCatalogEntry[] {
  return Array.from({ length: catalogModelCount }, (_unused, index) => ({
    id: `vendor/model-${String(index)}`,
    displayName: `Model ${String(index)}`,
    provider: "openrouter",
    contextWindow: 1_048_576,
    maxInputTokens: 991_000,
    maxOutputTokens: 943_718,
    capabilities: { tools: true, reasoning: true, streaming: true },
    reasoningEfforts: ["high"],
    reasoningEffortsSource: "declared" as const
  }));
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
    activity: { ...config.activity, outputDirectory: "/tmp/provider-select-all" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat,
    toolExecutionMode: config.agent.toolExecutionMode,
    subagent: { enabled: false, runtime: "builtin" }, externalSubagentBlockers: [],
    permission: config.permission, webSearch: config.web.search,
    models: {
      configured: [{
        alias: "openrouter-openrouter-auto", displayName: "OpenRouter Auto", model: "openrouter/auto",
        modelKey: "openrouter/openrouter/auto", provider: "openrouter", providerType: "openrouter",
        available: true, source: "configured", efforts: [], defaultThinking: "off", thinkingLevelMap: {},
        contextWindow: 2_000_000, maxOutputTokens: 2_000_000
      }],
      connections: [connection], embeddingModels: [], defaultModel: "openrouter-openrouter-auto",
      thinking: "off", modelProfiles: {}
    },
    skills: { projectId: "project", projectKey: "project", globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}

async function harness() {
  const writes: DesktopSettingsSaveInput[] = [];
  const rejections: string[] = [];
  let current = snapshot();
  let catalogFetches = 0;
  let connectionTests = 0;
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: async () => current,
      stageSettingsCredential: async () => { throw new Error("Unexpected credential staging"); },
      releaseSettingsCredentials: async () => {},
      saveSettings: async (_projectId: string, input: DesktopSettingsSaveInput): Promise<DesktopSettingsSaveResult> => {
        // 与主进程一致：写入前先过设置入参校验，被拒绝就按失败返回。
        const parsed = settingsSaveInputSchema.safeParse(input);
        if (!parsed.success) {
          rejections.push(parsed.error.issues.slice(0, 6)
            .map(issue => {
              const bound = "maximum" in issue ? issue.maximum : "minimum" in issue ? issue.minimum : undefined;
              return `${issue.code} ${issue.path.join(".")} bound=${String(bound)}`;
            })
            .join("; "));
          throw new Error("settings save input rejected");
        }
        writes.push(parsed.data);
        current = { ...current, configRevision: `config:${String(writes.length + 1)}` };
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
      onFetchCatalog: async (providerAlias: string) => {
        catalogFetches += 1;
        return { providerAlias, source: "fetched" as const, fetchedAt: "", models: catalogEntries() };
      },
      onTest: async () => {
        connectionTests += 1;
        return { ok: true, message: "synthetic" };
      },
      onStartLogin: async () => { throw new Error("Unexpected login"); },
      onCompleteLogin: async () => { throw new Error("Unexpected login"); },
      onCancelLogin: async () => {}, onNotify: () => {}, onOpenExternal: async () => { throw new Error("Unexpected external URL"); }
    });
  }
  await act(async () => root.render(React.createElement(SettingsDraftProvider, {
    active: true, projectId: "project", sessionRunning: false, onCommitted: () => {},
    onFontPreview: () => {}, onThemePreview: () => {}, onNotify: () => {}, children: React.createElement(Content)
  })));
  const document = dom.window.document;
  const providerRow = [...document.querySelectorAll<HTMLButtonElement>(".provider-row")].find(row => row.textContent?.includes("OpenRouter"));
  assert.ok(providerRow, "OpenRouter 服务商行存在");
  await act(async () => { providerRow.click(); });
  const selectAll = [...document.querySelectorAll<HTMLButtonElement>(".settings-link")].find(button => button.textContent?.startsWith("全选"));
  assert.ok(selectAll, "全选入口存在");
  return {
    writes: () => writes,
    rejections: () => rejections,
    catalogFetches: () => catalogFetches,
    connectionTests: () => connectionTests,
    clickSelectAll: async () => { await act(async () => { selectAll.click(); }); },
    close: async () => {
      await act(async () => { root.unmount(); });
      Reflect.deleteProperty(dom.window, "biny");
    },
    draftContext: () => { assert.ok(draftContext); return draftContext; }
  };
}

test("全选整份聚合目录只发一次设置事务，并按目录规模全部启用", async () => {
  const h = await harness();
  try {
    await h.clickSelectAll();
    assert.equal(h.writes().length, 1, `批量启用保持一次事务；入参拒绝=${h.rejections().join(" | ") || "无"}`);
    assert.deepEqual(h.rejections(), [], "整份目录规模必须通过设置入参校验");
    const models = h.writes()[0]?.models;
    assert.equal(models?.upserts.length, catalogModelCount, "整份目录的未启用模型一次提交");
    assert.deepEqual(models?.removeAliases, []);
    const profiles = models?.modelProfiles?.openrouter ?? {};
    assert.equal(Object.keys(profiles).length, catalogModelCount + 1, "可见模型都写入显示偏好");
    assert.equal(Object.values(profiles).every(profile => profile.showInPicker === true), true);
    assert.equal(h.draftContext().saveState, "clean", "批量开关直接落盘，不留在手写草稿状态");
  } finally {
    await h.close();
  }
});

test("启用模型不提交目录声明的额度，测试连接不会被批量触发", async () => {
  const h = await harness();
  try {
    await h.clickSelectAll();
    assert.ok(h.writes().length === 1, `入参拒绝=${h.rejections().join(" | ") || "无"}`);
    const upserts = h.writes()[0]?.models?.upserts ?? [];
    assert.ok(upserts.length > 0);
    for (const upsert of upserts) {
      assert.equal(upsert.contextWindow, undefined, "目录窗口额度不进入写入事务");
      assert.equal(upsert.maxInputTokens, undefined, "目录输入额度不进入写入事务");
      assert.equal(upsert.maxOutputTokens, undefined, "目录输出额度不进入写入事务");
      assert.equal(upsert.limits, undefined, "目录 reserve 不进入写入事务");
      assert.equal(upsert.apiKey, undefined);
      assert.equal(upsert.makeDefault, undefined, "批量启用不改默认模型");
    }
    assert.equal(h.catalogFetches(), 0, "全选不重新拉取目录");
    assert.equal(h.connectionTests(), 0, "全选不发连接测试");
  } finally {
    await h.close();
  }
});
