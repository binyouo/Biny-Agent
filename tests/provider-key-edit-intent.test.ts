/** Real provider UI and draft coordinator; credentials and IPC are synthetic only. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { defaultConfig } from "../src/config/schema.js";
import type {
  DesktopModelConnection,
  DesktopSettingsCredentialScope,
  DesktopSettingsSaveInput,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot
} from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const syntheticKey = "BINY_TEST_FAKE_PROVIDER_ENV_KEY";

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

// React DOM and components that import it must be evaluated after DOM setup,
// otherwise React's cached DOM feature detection prevents onChange dispatch.
const { createRoot } = await import("react-dom/client");
const { ProviderSettings } = await import("../src/desktop/renderer/src/components/settings/ProviderSettings.js");
const { SettingsDraftProvider } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftProvider.js");
const { SettingsPageFooter } = await import("../src/desktop/renderer/src/components/settings/SettingsPageFooter.js");
const { SettingsDetailHostContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js");
const { useSettingsDraft } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function snapshot(withModel: boolean): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  const connection: DesktopModelConnection = {
    providerAlias: "example", providerType: "openai-compatible", displayName: "Example",
    baseUrl: "https://provider.example.invalid/v1", requiresApiKey: true, hasCredential: true,
    credentialSource: "env", apiKeyEnv: "BINY_TEST_FAKE_PROVIDER_ENV"
  };
  return {
    projectId: "project", hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "system", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/tmp/provider-key-test" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat,
    permission: config.permission, webSearch: config.web.search,
    models: {
      configured: withModel ? [{
        alias: "example-model", displayName: "Example Model", model: "example-model", modelKey: "example/example-model",
        provider: "example", providerType: "openai-compatible", available: true, source: "configured",
        efforts: [], defaultThinking: "off", thinkingLevelMap: {}
      }] : [],
      connections: [connection, { ...connection, providerAlias: "second", displayName: "Second", baseUrl: "https://second.example.invalid/v1" }],
      embeddingModels: [], defaultModel: "example-model", thinking: "off", modelProfiles: {}
    },
    skills: { projectId: "project", projectKey: "project", globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}

async function harness(options: {
  initialSnapshot?: DesktopSettingsSnapshot;
  withModel?: boolean;
  testConnection?: () => Promise<{ ok: boolean; message: string }>;
  readKey?: (providerAlias: string) => Promise<string | undefined>;
  save?: (input: DesktopSettingsSaveInput, current: DesktopSettingsSnapshot) => Promise<DesktopSettingsSaveResult>;
} = {}) {
  const writes: DesktopSettingsSaveInput[] = [];
  const staged: Array<{ secret: string; scope: DesktopSettingsCredentialScope }> = [];
  const reads: string[] = [];
  const released: string[][] = [];
  let current = options.initialSnapshot ?? snapshot(options.withModel ?? true);
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: async () => current,
      stageSettingsCredential: async (secret: string, scope: DesktopSettingsCredentialScope) => {
        staged.push({ secret, scope });
        return { handle: `synthetic:${staged.length}`, kind: "api-key", expiresAt: "2099-01-01T00:00:00Z" };
      },
      releaseSettingsCredentials: async (handles: string[]) => { released.push(handles); },
      saveSettings: async (_projectId: string, input: DesktopSettingsSaveInput): Promise<DesktopSettingsSaveResult> => {
        writes.push(structuredClone(input));
        if (options.save) return options.save(input, current);
        current = { ...current, configRevision: `config:${writes.length + 1}`, chatParams: input.chatParams ?? current.chatParams };
        return { status: "committed", journalId: "synthetic", appliedFields: [], snapshot: current };
      }
    }
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let draftContext: SettingsDraftContextValue | undefined;
  function Content() {
    const context = useSettingsDraft();
    draftContext = context;
    const provider = React.createElement(ProviderSettings, {
      active: true, loading: context.loading, projectId: "project", catalogs: {},
      models: context.snapshot?.models.configured ?? [], connections: context.snapshot?.models.connections ?? [],
      defaultModelAlias: context.snapshot?.models.defaultModel,
      onReadModelApiKey: async alias => { reads.push(alias); return options.readKey ? options.readKey(alias) : syntheticKey; },
      onFetchCatalog: async alias => ({ providerAlias: alias, source: "static", fetchedAt: "", models: [] }),
      onTest: async () => { if (options.testConnection) return await options.testConnection(); throw new Error("Unexpected provider request"); },
      onStartLogin: async () => { throw new Error("Unexpected login"); },
      onCompleteLogin: async () => { throw new Error("Unexpected login"); },
      onCancelLogin: async () => {}, onNotify: () => {}, onOpenExternal: async () => { throw new Error("Unexpected external URL"); }
    });
    return React.createElement(SettingsDetailHostContext.Provider, { value: dom.window.document.getElementById("root") }, provider, React.createElement(SettingsPageFooter, {
      dirtyCount: context.dirtyCount, pendingModelEdits: context.pendingModelEdits, disabled: context.invalid, state: context.saveState,
      onCancel: () => { void context.discard(); }, onSave: () => { void context.saveAll(); }
    }));
  }
  await act(async () => root.render(React.createElement(SettingsDraftProvider, {
    active: true, projectId: "project", sessionRunning: false, onCommitted: () => {},
    onFontPreview: () => {}, onThemePreview: () => {}, onNotify: () => {}, children: React.createElement(Content)
  })));
  const document = dom.window.document;
  const keyInput = (): HTMLInputElement => {
    const input = document.querySelector<HTMLInputElement>('.secret-input-row input');
    assert.ok(input);
    return input;
  };
  return {
    dom, writes, staged, reads, released, keyInput,
    context: () => { assert.ok(draftContext); return draftContext; },
    click: async (selector: string) => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      assert.ok(button, selector);
      await act(async () => { button.click(); });
    },
    selectProvider: async (label: string) => {
      const row = [...document.querySelectorAll<HTMLButtonElement>('.provider-row')].find(item => item.textContent?.includes(label));
      assert.ok(row, label);
      await act(async () => { row.click(); });
    },
    editInput: async (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector);
      assert.ok(input);
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    editKey: async (value: string) => {
      const input = keyInput();
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.equal(input.value, value);
    },
    blurKey: async () => { await act(async () => { keyInput().focus(); keyInput().blur(); }); },
    enterKey: async () => { await act(async () => { keyInput().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }); },
    close: async () => {
      await act(async () => { root.unmount(); });
      Reflect.deleteProperty(dom.window, "biny");
    }
  };
}

for (const withModel of [true, false]) {
  test(`revealing an environment-backed key without editing never stages or saves (${withModel ? "model" : "empty connection"})`, async () => {
    const h = await harness({ withModel });
    try {
      await h.selectProvider("Example");
      await h.blurKey();
      assert.deepEqual(h.reads, []);
      await h.click('[aria-label="显示密钥"]');
      assert.equal(h.keyInput().value, syntheticKey);
      assert.equal(h.keyInput().type, "text");
      await h.blurKey();
      assert.deepEqual(h.staged, [], "read-only blur must not stage the resolved environment value");
      assert.deepEqual(h.writes, [], "read-only blur must not start a settings transaction");
      await h.enterKey();
      await h.click('[aria-label="隐藏密钥"]');
      await h.blurKey();
      assert.deepEqual(h.staged, [], "read-only reveal must not stage the resolved environment value");
      assert.deepEqual(h.writes, [], "read-only reveal must not start a settings transaction");
      assert.equal(h.context().dirtyCount, 0);
    } finally { await h.close(); }
  });
}

for (const withModel of [true, false]) {
  for (const trigger of ["blur", "enter", "debounce"] as const) {
    test(`a real edit saves once on ${trigger} (${withModel ? "model" : "empty connection"})`, async t => {
      const h = await harness({ withModel });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await h.selectProvider("Example");
        await h.click('[aria-label="显示密钥"]');
        await h.editKey("  SYNTHETIC_EDITED_KEY  ");
        assert.deepEqual(h.staged, [], "typing must wait for debounce or an explicit flush");
        if (trigger === "blur") await h.blurKey();
        else if (trigger === "enter") await h.enterKey();
        else await act(async () => { t.mock.timers.tick(900); });
        assert.deepEqual(h.staged, [{
          secret: "SYNTHETIC_EDITED_KEY", scope: { projectId: "project", purpose: "model", providerAlias: "example" }
        }]);
        assert.equal(h.writes.length, 1);
        const saved = h.writes[0]?.models;
        assert.equal(saved?.customProviders?.[0]?.apiKeyHandle, "synthetic:1");
        assert.ok(!JSON.stringify(h.writes).includes("SYNTHETIC_EDITED_KEY"), "IPC settings writes carry handles only");
        assert.equal(h.keyInput().value, "SYNTHETIC_EDITED_KEY");
        assert.equal(h.context().dirtyCount, 0);
        await h.blurKey();
        await h.enterKey();
        await act(async () => { t.mock.timers.tick(900); });
        assert.equal(h.writes.length, 1, "the completed edit must not be restaged on another blur or Enter");
      } finally { await h.close(); }
    });
  }
}

test("saving an unrelated draft after reveal never includes the viewed key", async () => {
  const h = await harness();
  try {
    await h.click('[aria-label="显示密钥"]');
    await h.blurKey();
    await act(async () => { h.context().setChatParams({ ...h.context().draft!.chatParams, temperature: 0.25 }); });
    await h.click('.settings-save-button');
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]?.chatParams?.temperature, 0.25);
    assert.equal(h.writes[0]?.models, undefined);
    assert.deepEqual(h.staged, []);
  } finally { await h.close(); }
});

test("clearing the local key text cancels its pending save without deleting the existing credential", async t => {
  const h = await harness();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await h.click('[aria-label="显示密钥"]');
    await h.editKey("SYNTHETIC_UNSAVED_KEY");
    await h.editKey("");
    await h.blurKey();
    await h.enterKey();
    await act(async () => { t.mock.timers.tick(900); });
    assert.equal(h.keyInput().value, "");
    assert.deepEqual(h.staged, []);
    assert.deepEqual(h.writes, []);
  } finally { await h.close(); }
});

for (const withModel of [true, false]) {
  test(`failed real edit remains retryable (${withModel ? "model" : "empty connection"})`, async () => {
    let attempts = 0;
    const h = await harness({ withModel, save: async (_input, current) => ++attempts === 1
      ? { status: "rolled_back", snapshot: current, draftRetained: true }
      : { status: "committed", snapshot: current, journalId: "synthetic", appliedFields: [] } });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_RETRY_KEY");
      await h.blurKey();
      assert.equal(h.writes.length, 1);
      assert.equal(h.keyInput().value, "SYNTHETIC_RETRY_KEY");
      assert.match(h.dom.window.document.querySelector('.provider-key-state')?.textContent ?? "", /失败/u);
      await h.enterKey();
      assert.equal(h.writes.length, 2);
      assert.equal(h.staged.length, 2);
      await h.blurKey();
      assert.equal(h.writes.length, 2);
    } finally { await h.close(); }
  });
}

test("a failed connection-key autosave retains the text and retries through the same editor", async () => {
  let attempts = 0;
  const h = await harness({ save: async (_input, current) => {
    if (++attempts === 1) throw new Error("Synthetic save failure");
    return { status: "committed", snapshot: current, journalId: "synthetic", appliedFields: [] };
  } });
  try {
    await h.editKey("SYNTHETIC_MANUAL_RETRY_KEY");
    await h.blurKey();
    assert.equal(h.keyInput().value, "SYNTHETIC_MANUAL_RETRY_KEY");
    assert.equal(h.context().draft?.models.upserts.length, 0, "失败候选不显示成已配置模型");
    await h.enterKey();
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[1]?.models?.customProviders?.[0]?.apiKeyHandle, "synthetic:2");
    assert.equal(h.staged.length, 2, "失败句柄释放后重新暂存");
    assert.equal(h.context().dirtyCount, 0);
  } finally { await h.close(); }
});

test("reveal failure remains retryable and does not create edit intent", async () => {
  let reads = 0;
  const h = await harness({ readKey: async () => {
    if (++reads === 1) throw new Error("Synthetic read failure");
    return syntheticKey;
  } });
  try {
    await h.click('[aria-label="显示密钥"]');
    assert.equal(h.keyInput().disabled, false);
    assert.equal(h.keyInput().value, "");
    assert.equal(h.keyInput().type, "password");
    await h.click('[aria-label="显示密钥"]');
    assert.equal(h.keyInput().value, syntheticKey);
    await h.blurKey();
    assert.equal(reads, 2);
    assert.deepEqual(h.staged, []);
    assert.deepEqual(h.writes, []);
  } finally { await h.close(); }
});

test("provider switching saves pending key edits before leaving and rejects stale reveal results", async t => {
  const pending = deferred<string>();
  let delayRead = false;
  const h = await harness({ readKey: async alias => alias === "example" && delayRead ? pending.promise : syntheticKey });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await h.editKey("SYNTHETIC_SWITCHED_KEY");
    await h.selectProvider("Second");
    await act(async () => { t.mock.timers.tick(900); });
    assert.equal(h.keyInput().value, "");
    await h.click('[aria-label="显示密钥"]');
    await h.blurKey();
    assert.equal(h.staged.length, 1);
    assert.equal(h.staged[0]?.scope.providerAlias, "example");
    await h.selectProvider("Example");
    delayRead = true;
    await h.click('[aria-label="显示密钥"]');
    assert.equal(h.keyInput().disabled, true);
    await h.selectProvider("Second");
    await act(async () => { pending.resolve("SYNTHETIC_STALE_READ"); });
    assert.equal(h.keyInput().value, "");
    assert.equal(h.keyInput().disabled, false);
    await h.blurKey();
    assert.equal(h.staged.length, 1);
    assert.equal(h.staged[0]?.scope.providerAlias, "example");
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]?.models?.customProviders?.[0]?.alias, "example");
  } finally { await h.close(); }
});

for (const withModel of [true, false]) {
  test(`finishing an older save preserves the newer key edit (${withModel ? "model" : "empty connection"})`, async () => {
    const pending = deferred<DesktopSettingsSaveResult>();
    let attempts = 0;
    const h = await harness({ withModel, save: async (_input, current) => ++attempts === 1
      ? pending.promise
      : { status: "committed", snapshot: current, journalId: "synthetic", appliedFields: [] } });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_FIRST_EDIT");
      await h.enterKey();
      await h.editKey("SYNTHETIC_NEWER_EDIT");
      await act(async () => { pending.resolve({ status: "committed", snapshot: snapshot(withModel), journalId: "synthetic", appliedFields: [] }); });
      assert.equal(h.keyInput().value, "SYNTHETIC_NEWER_EDIT");
      await h.blurKey();
      assert.deepEqual(h.staged.map(item => item.secret), ["SYNTHETIC_FIRST_EDIT", "SYNTHETIC_NEWER_EDIT"]);
      assert.equal(h.writes.length, 2);
      await h.blurKey();
      assert.equal(h.writes.length, 2);
    } finally { await h.close(); }
  });
}


test("queued immediate saves report saving until persistence completes; dirty drafts alone cannot represent a pending connection write", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const h = await harness({ save: async (_input, current) => {
    entered.resolve();
    await gate.promise;
    return { status: "committed", snapshot: current, journalId: "synthetic", appliedFields: [] };
  } });
  try {
    let operation!: Promise<DesktopSettingsSaveResult | undefined>;
    await act(async () => {
      operation = h.context().saveModels({ upserts: [], removeAliases: [], customProviders: [{ alias: "example", enabled: false }] });
      await entered.promise;
    });
    assert.equal(h.context().saveState, "saving");
    await act(async () => { gate.resolve(); await operation; });
    assert.equal(h.context().saveState, "clean");
  } finally { gate.resolve(); await h.close(); }
});


test("等待密钥防抖保存时显示待保存状态，不能提前显示所有更改已保存", async t => {
  const h = await harness();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await h.editKey("SYNTHETIC_PENDING_KEY");
    assert.equal(h.context().pendingModelEdits, true);
    assert.doesNotMatch(dom.window.document.querySelector(".settings-save-status")!.textContent!, /所有更改已保存/u);
    await act(async () => { t.mock.timers.tick(900); });
    assert.equal(h.context().pendingModelEdits, false);
  } finally { await h.close(); }
});

test("添加失败保留模型 ID 和名称供原位重试，失败候选不能投影为已保存模型", async () => {
  let attempt = 0;
  const h = await harness({ withModel: false, save: async (_input, current) => ++attempt === 1
    ? { status: "rolled_back", journalId: "synthetic", message: "SYNTHETIC_CONFLICT", snapshot: current }
    : { status: "committed", journalId: "synthetic", appliedFields: [], snapshot: { ...current, configRevision: "config:2" } } });
  try {
    await h.editInput('[aria-label="手动添加模型 ID"]', "manual-model");
    await h.editInput('[aria-label="手动添加模型显示名称"]', "My model");
    await h.click('.provider-manual-row button');
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('[aria-label="手动添加模型 ID"]')!.value, "manual-model");
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('[aria-label="手动添加模型显示名称"]')!.value, "My model");
    assert.deepEqual(h.context().draft?.models.upserts, []);
    await h.click('.provider-manual-row button');
    assert.equal(h.writes[1]?.models?.upserts[0]?.displayName, "My model");
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('[aria-label="手动添加模型 ID"]')!.value, "");
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('[aria-label="手动添加模型显示名称"]')!.value, "");
  } finally { await h.close(); }
});

test("关闭设置先提交待保存字段，失败时拒绝关闭并保留编辑", async t => {
  const h = await harness({ save: async (_input, current) => ({ status: "rolled_back", journalId: "synthetic", message: "SYNTHETIC_CONFLICT", snapshot: current }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await h.editKey("SYNTHETIC_RETRY_KEY");
    await act(async () => { assert.equal(await h.context().flushModelEdits!(), false); });
    assert.equal(h.keyInput().value, "SYNTHETIC_RETRY_KEY");
    assert.equal(h.writes.length, 1);
  } finally { await h.close(); }
});


test("较早地址保存完成后仍保留较新的地址编辑，离开页面时提交新值", async t => {
  const pending = deferred<DesktopSettingsSaveResult>();
  const h = await harness({ save: async (_input, current) => h.writes.length === 1 ? pending.promise
    : { status: "committed", journalId: "synthetic", appliedFields: [], snapshot: { ...current, configRevision: "config:3" } } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await h.editInput('#provider-example-base-url', "https://old.example.invalid/v1");
    await act(async () => { t.mock.timers.tick(900); });
    assert.equal(h.writes.length, 1);
    await h.editInput('#provider-example-base-url', "https://new.example.invalid/v1");
    await act(async () => { pending.resolve({ status: "committed", journalId: "synthetic", appliedFields: [], snapshot: { ...snapshot(true), configRevision: "config:2" } }); });
    assert.equal(h.context().pendingModelEdits, true);
    await act(async () => { assert.equal(await h.context().flushModelEdits!(), true); });
    assert.equal(h.writes[1]?.models?.customProviders?.[0]?.baseUrl, "https://new.example.invalid/v1");
  } finally { await h.close(); }
});

test("队列中的模型偏好更新读取前一笔快照，连续开关不会覆盖先前选择", async () => {
  const h = await harness({ save: async (input, current) => ({ status: "committed", journalId: "synthetic", appliedFields: [], snapshot: {
    ...current, configRevision: `config:${Number(input.expectedConfigRevision.split(":")[1]) + 1}`,
    models: { ...current.models, modelProfiles: input.models?.modelProfiles ?? {} }
  } }) });
  try {
    await act(async () => {
      const first = h.context().saveModels(current => ({ upserts: [], removeAliases: [], modelProfiles: {
        example: { ...current.models.modelProfiles?.example, first: { showInPicker: false } }
      } }));
      const second = h.context().saveModels(current => ({ upserts: [], removeAliases: [], modelProfiles: {
        example: { ...current.models.modelProfiles?.example, second: { showInPicker: false } }
      } }));
      await Promise.all([first, second]);
    });
    assert.deepEqual(h.writes[1]?.models?.modelProfiles, { example: { first: { showInPicker: false }, second: { showInPicker: false } } });
    assert.equal(h.writes[1]?.expectedConfigRevision, "config:2");
  } finally { await h.close(); }
});


test("模型选项保存失败保留对话框和填写值，只有提交成功才关闭", async () => {
  let attempt = 0;
  const h = await harness({ save: async (_input, current) => ++attempt === 1
    ? { status: "rolled_back", journalId: "synthetic", snapshot: current, message: "SYNTHETIC_CONFLICT" }
    : { status: "committed", journalId: "synthetic", appliedFields: [], snapshot: current } });
  try {
    await h.click('.provider-model-actions .icon-button');
    await h.click('[aria-label="模型设置"] button[type="submit"]');
    assert.ok(dom.window.document.querySelector('[aria-label="模型设置"]'));
    assert.match(dom.window.document.querySelector('[aria-label="模型设置"] [role="alert"]')!.textContent!, /SYNTHETIC_CONFLICT/u);
    await h.click('[aria-label="模型设置"] button[type="submit"]');
    assert.equal(dom.window.document.querySelector('[aria-label="模型设置"]'), null);
  } finally { await h.close(); }
});


test("创建供应商失败在对话框显示原因并保留填写值供重试", async () => {
  const h = await harness({ save: async (_input, current) => ({ status: "rolled_back", journalId: "synthetic", snapshot: current, message: "SYNTHETIC_CREATE_CONFLICT" }) });
  try {
    await h.click('.provider-settings-toolbar button');
    await h.editInput('#custom-provider-create-name', "My Relay");
    await h.editInput('#custom-provider-create-url', "https://new.example.invalid/v1");
    await h.click('[aria-label="添加自定义服务商"] button[type="submit"]');
    const dialog = dom.window.document.querySelector('[aria-label="添加自定义服务商"]');
    assert.ok(dialog);
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? "", /SYNTHETIC_CREATE_CONFLICT/u);
    assert.equal(dialog.querySelector<HTMLInputElement>('#custom-provider-create-name')!.value, "My Relay");
  } finally { await h.close(); }
});

test("修改连接字段后旧测试结果不能显示为当前连接的成功结果", async () => {
  const pending = deferred<{ ok: boolean; message: string }>();
  const h = await harness({ testConnection: () => pending.promise });
  try {
    await h.click('[aria-label="测试连接"]');
    await h.editKey("SYNTHETIC_NEW_CONNECTION_KEY");
    await act(async () => { pending.resolve({ ok: true, message: "old connection succeeded" }); });
    assert.equal(dom.window.document.querySelector('.connection-test-result'), null);
  } finally { pending.resolve({ ok: true, message: "synthetic" }); await h.close(); }
});


test("相同地址编辑在保存途中离开页面只提交一次，避免失焦与关闭重复提交", async t => {
  const pending = deferred<DesktopSettingsSaveResult>();
  const h = await harness({ save: async (_input, current) => h.writes.length === 1 ? pending.promise : { status: "committed", journalId: "synthetic", appliedFields: [], snapshot: current } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await h.editInput('#provider-example-base-url', "https://once.example.invalid/v1");
    await act(async () => { t.mock.timers.tick(900); });
    let flush: Promise<boolean> | undefined;
    await act(async () => { flush = h.context().flushModelEdits!(); });
    await act(async () => { pending.resolve({ status: "committed", journalId: "synthetic", appliedFields: [], snapshot: snapshot(true) }); await flush; });
    assert.equal(h.writes.length, 1);
  } finally { pending.resolve({ status: "committed", journalId: "synthetic", appliedFields: [], snapshot: snapshot(true) }); await h.close(); }
});


test("已有模型时手动添加按需展开并聚焦，收起再打开保留输入；防止配置区被常驻表单挤占", async () => {
  const h = await harness({ withModel: true });
  try {
    assert.ok(!document.querySelector('[aria-label="手动添加模型 ID"]'), "manual form should be collapsed");
    await h.click('[aria-label="手动添加模型"]');
    const input = document.querySelector<HTMLInputElement>('[aria-label="手动添加模型 ID"]');
    assert.ok(document.activeElement === input, "opened form should focus the model ID");
    await h.editInput('[aria-label="手动添加模型 ID"]', "draft-model");
    await h.click('[aria-label="收起手动添加"]');
    assert.ok(!document.querySelector('[aria-label="手动添加模型 ID"]'), "manual form should be collapsed");
    await h.click('[aria-label="手动添加模型"]');
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="手动添加模型 ID"]')!.value, "draft-model");
    assert.equal(h.writes.length, 0);
  } finally { await h.close(); }
});


test("删除服务商先请求确认，取消无写入且下一次点击重新确认；保护取消后的普通按钮状态", async () => {
  const previousConfirm = dom.window.confirm;
  let confirmed = false;
  let confirmations = 0;
  dom.window.confirm = message => { assert.match(message, /Example/u); confirmations += 1; return confirmed; };
  const h = await harness({ withModel: false });
  try {
    await h.click('[aria-label="删除连接"]');
    assert.equal(confirmations, 1);
    assert.equal(h.writes.length, 0);
    assert.ok(document.querySelector('[aria-label="删除连接"]'));
    assert.ok(!document.querySelector('[aria-label="确认删除连接"]'));
    confirmed = true;
    await h.click('[aria-label="删除连接"]');
    assert.equal(confirmations, 2);
    assert.deepEqual(h.writes[0]?.models?.removeProviderAliases, ["example"]);
  } finally { await h.close(); dom.window.confirm = previousConfirm; }
});


test("修改内置服务商端点后仍选中同一连接，目录名称重映射不能丢失当前编辑", async () => {
  const initial = snapshot(true);
  initial.models.connections[0] = { ...initial.models.connections[0]!, providerType: "deepseek", baseUrl: "https://api.deepseek.com" };
  const h = await harness({ initialSnapshot: initial, save: async (input, current) => ({
    status: "committed", journalId: "synthetic", appliedFields: [], snapshot: { ...current, configRevision: "config:2", models: { ...current.models,
      connections: current.models.connections.map(connection => connection.providerAlias === "example"
        ? { ...connection, baseUrl: input.models?.customProviders?.[0]?.baseUrl ?? connection.baseUrl } : connection)
    } }
  }) });
  try {
    await h.selectProvider("Second");
    await h.selectProvider("DeepSeek");
    await h.editInput('[id="provider-example-base-url"]', "https://relay.example.invalid/v1");
    await act(async () => { assert.equal(await h.context().flushModelEdits(), true); });
    assert.ok(document.querySelector('[id="provider-example-base-url"]'), "same connection editor must remain mounted");
    assert.equal(document.querySelector<HTMLInputElement>('[id="provider-example-base-url"]')!.value, "https://relay.example.invalid/v1");
    assert.match(document.querySelector('.provider-row.is-active')!.textContent!, /Example/u);
  } finally { await h.close(); }
});
