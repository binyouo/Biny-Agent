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
  withModel?: boolean;
  readKey?: (providerAlias: string) => Promise<string | undefined>;
  save?: (input: DesktopSettingsSaveInput, current: DesktopSettingsSnapshot) => Promise<DesktopSettingsSaveResult>;
} = {}) {
  const writes: DesktopSettingsSaveInput[] = [];
  const staged: Array<{ secret: string; scope: DesktopSettingsCredentialScope }> = [];
  const reads: string[] = [];
  const released: string[][] = [];
  let current = snapshot(options.withModel ?? true);
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
      onTest: async () => { throw new Error("Unexpected provider request"); },
      onStartLogin: async () => { throw new Error("Unexpected login"); },
      onCompleteLogin: async () => { throw new Error("Unexpected login"); },
      onCancelLogin: async () => {}, onNotify: () => {}, onOpenExternal: async () => { throw new Error("Unexpected external URL"); }
    });
    return React.createElement(React.Fragment, null, provider, React.createElement(SettingsPageFooter, {
      dirtyCount: context.dirtyCount, disabled: context.invalid, state: context.saveState,
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
        assert.equal(withModel ? saved?.upserts[0]?.apiKeyHandle : saved?.customProviders?.[0]?.apiKeyHandle, "synthetic:1");
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

test("a failed model-key autosave retains the staged draft for manual Save", async () => {
  let attempts = 0;
  const h = await harness({ save: async (_input, current) => {
    if (++attempts === 1) throw new Error("Synthetic save failure");
    return { status: "committed", snapshot: current, journalId: "synthetic", appliedFields: [] };
  } });
  try {
    await h.editKey("SYNTHETIC_MANUAL_RETRY_KEY");
    await h.blurKey();
    assert.equal(h.context().dirtyCount, 1);
    assert.equal(h.context().draft?.models.upserts[0]?.apiKeyHandle, "synthetic:1");
    await h.click('.settings-save-button');
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[1]?.models?.upserts[0]?.apiKeyHandle, "synthetic:1");
    assert.equal(h.staged.length, 1, "manual Save reuses the pending handle");
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

test("provider switching cancels pending key edits and stale reveal results", async t => {
  const pending = deferred<string>();
  let delayRead = false;
  const h = await harness({ readKey: async alias => alias === "example" && delayRead ? pending.promise : syntheticKey });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await h.editKey("SYNTHETIC_CANCELLED_KEY");
    await h.selectProvider("Second");
    await act(async () => { t.mock.timers.tick(900); });
    assert.equal(h.keyInput().value, "");
    await h.click('[aria-label="显示密钥"]');
    await h.blurKey();
    assert.deepEqual(h.staged, []);
    await h.selectProvider("Example");
    delayRead = true;
    await h.click('[aria-label="显示密钥"]');
    assert.equal(h.keyInput().disabled, true);
    await h.selectProvider("Second");
    await act(async () => { pending.resolve("SYNTHETIC_STALE_READ"); });
    assert.equal(h.keyInput().value, "");
    assert.equal(h.keyInput().disabled, false);
    await h.blurKey();
    assert.deepEqual(h.staged, []);
    assert.deepEqual(h.writes, []);
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
