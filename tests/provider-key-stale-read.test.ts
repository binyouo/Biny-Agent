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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
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
      assert.equal(input.disabled, false, "the visible UI must allow editing");
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
  const branch = withModel ? "model" : "empty connection";
  for (const trigger of ["blur", "enter", "debounce"] as const) {
    test(`a reveal from before switching away cannot replace or save over a newer edit on ${trigger} (${branch})`, async t => {
      const pending = deferred<string>();
      const h = await harness({ withModel, readKey: async () => pending.promise });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await h.selectProvider("Example");
        await h.click('[aria-label="显示密钥"]');
        assert.equal(h.keyInput().disabled, true);
        await h.selectProvider("Second");
        await h.selectProvider("Example");
        await h.editKey("  SYNTHETIC_NEWER_EDIT  ");
        await act(async () => { pending.resolve(syntheticKey); });
        assert.equal(h.keyInput().value, "  SYNTHETIC_NEWER_EDIT  ", "the old read must not overwrite explicit input");
        assert.equal(h.keyInput().disabled, false);
        assert.deepEqual(h.staged, []);
        if (trigger === "blur") await h.blurKey();
        else if (trigger === "enter") await h.enterKey();
        else await act(async () => { t.mock.timers.tick(900); });
        assert.deepEqual(h.staged, [{
          secret: "SYNTHETIC_NEWER_EDIT", scope: { projectId: "project", purpose: "model", providerAlias: "example" }
        }]);
        assert.equal(h.writes.length, 1);
        const saved = h.writes[0]?.models;
        assert.equal(saved?.customProviders?.[0]?.apiKeyHandle, "synthetic:1");
        assert.equal(saved?.customProviders?.[0]?.alias, "example");
        assert.ok(!JSON.stringify(h.writes).includes("SYNTHETIC_NEWER_EDIT"), "settings writes must carry handles only");
        assert.equal(h.keyInput().value, "SYNTHETIC_NEWER_EDIT");
        assert.match(h.dom.window.document.querySelector('.provider-key-state')?.textContent ?? "", /已保存/u);
      } finally { await h.close(); }
    });
  }

  test(`clearing the input after switching back survives an old reveal (${branch})`, async t => {
    const pending = deferred<string>();
    const h = await harness({ withModel, readKey: async () => pending.promise });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await h.selectProvider("Example");
      await h.click('[aria-label="显示密钥"]');
      await h.selectProvider("Second");
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_TEMPORARY_EDIT");
      await h.editKey("");
      await act(async () => { pending.resolve(syntheticKey); });
      assert.equal(h.keyInput().value, "");
      await h.blurKey();
      await h.enterKey();
      await act(async () => { t.mock.timers.tick(900); });
      assert.deepEqual(h.staged, []);
      assert.deepEqual(h.writes, []);
    } finally { await h.close(); }
  });

  for (const outcome of ["resolve", "reject"] as const) {
    test(`an old reveal ${outcome} preserves a newer failed edit and its retry (${branch})`, async () => {
      const pending = deferred<string>();
      let attempts = 0;
      const h = await harness({ withModel, readKey: async () => pending.promise,
        save: async (_input, current) => ++attempts === 1
          ? { status: "rolled_back", snapshot: current, draftRetained: true }
          : { status: "committed", snapshot: current, journalId: "synthetic", appliedFields: [] }
      });
      try {
        await h.selectProvider("Example");
        await h.click('[aria-label="显示密钥"]');
        await h.selectProvider("Second");
        await h.selectProvider("Example");
        await h.editKey("SYNTHETIC_RETRY_EDIT");
        await h.enterKey();
        assert.match(h.dom.window.document.querySelector('.provider-key-state')?.textContent ?? "", /失败/u);
        await act(async () => {
          if (outcome === "resolve") pending.resolve(syntheticKey);
          else pending.reject(new Error("Synthetic stale read failure"));
        });
        assert.equal(h.keyInput().value, "SYNTHETIC_RETRY_EDIT");
        assert.equal(h.keyInput().disabled, false);
        assert.match(h.dom.window.document.querySelector('.provider-key-state')?.textContent ?? "", /失败/u);
        await h.enterKey();
        assert.equal(h.writes.length, 2);
        assert.deepEqual(h.staged.map(item => item.secret), ["SYNTHETIC_RETRY_EDIT", "SYNTHETIC_RETRY_EDIT"]);
        assert.match(h.dom.window.document.querySelector('.provider-key-state')?.textContent ?? "", /已保存/u);
      } finally { await h.close(); }
    });
  }
}

for (const switchBack of [false, true]) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`an old reveal ${outcome} cannot release a newer read after ${switchBack ? "A→B→A" : "A→B"}`, async () => {
      const oldRead = deferred<string>();
      const currentRead = deferred<string>();
      let requests = 0;
      const h = await harness({ readKey: async () => ++requests === 1 ? oldRead.promise : currentRead.promise });
      try {
        await h.selectProvider("Example");
        await h.click('[aria-label="显示密钥"]');
        await h.selectProvider("Second");
        if (switchBack) await h.selectProvider("Example");
        await h.click('[aria-label="显示密钥"]');
        assert.equal(h.keyInput().disabled, true);
        await act(async () => {
          if (outcome === "resolve") oldRead.resolve(syntheticKey);
          else oldRead.reject(new Error("Synthetic stale read failure"));
        });
        assert.equal(h.keyInput().disabled, true, "only the current request may release loading");
        assert.equal(h.keyInput().placeholder, "正在读取…");
        assert.equal(h.keyInput().value, "");
        await act(async () => { currentRead.resolve("SYNTHETIC_CURRENT_KEY"); });
        assert.equal(h.keyInput().disabled, false);
        assert.equal(h.keyInput().value, "SYNTHETIC_CURRENT_KEY");
        assert.deepEqual(h.reads, ["example", switchBack ? "example" : "second"]);
        assert.deepEqual(h.staged, []);
        assert.deepEqual(h.writes, []);
      } finally { await h.close(); }
    });
  }
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`an old reveal ${outcome} cannot replace a newer completed reveal after A→B→A`, async () => {
    const oldRead = deferred<string>();
    const currentRead = deferred<string>();
    let requests = 0;
    const h = await harness({ readKey: async () => ++requests === 1 ? oldRead.promise : currentRead.promise });
    try {
      await h.selectProvider("Example");
      await h.click('[aria-label="显示密钥"]');
      await h.selectProvider("Second");
      await h.selectProvider("Example");
      await h.click('[aria-label="显示密钥"]');
      await act(async () => { currentRead.resolve("SYNTHETIC_CURRENT_KEY"); });
      assert.equal(h.keyInput().value, "SYNTHETIC_CURRENT_KEY");
      assert.equal(h.keyInput().disabled, false);
      await act(async () => {
        if (outcome === "resolve") oldRead.resolve(syntheticKey);
        else oldRead.reject(new Error("Synthetic stale read failure"));
      });
      assert.equal(h.keyInput().value, "SYNTHETIC_CURRENT_KEY");
      assert.equal(h.keyInput().disabled, false);
      assert.deepEqual(h.staged, []);
      assert.deepEqual(h.writes, []);
    } finally { await h.close(); }
  });
}

test("a current reveal rejection releases loading and permits a successful retry", async () => {
  const pending = deferred<string>();
  let requests = 0;
  const h = await harness({ readKey: async () => ++requests === 1 ? pending.promise : syntheticKey });
  try {
    await h.selectProvider("Example");
    await h.click('[aria-label="显示密钥"]');
    assert.equal(h.keyInput().disabled, true);
    await act(async () => { pending.reject(new Error("Synthetic current read failure")); });
    assert.equal(h.keyInput().disabled, false);
    assert.equal(h.keyInput().value, "");
    assert.equal(h.keyInput().placeholder, "••••••••");
    assert.equal(h.dom.window.document.querySelector('.provider-key-state'), null, "a read failure is not a save failure");
    await h.click('[aria-label="显示密钥"]');
    assert.equal(h.keyInput().value, syntheticKey);
    assert.equal(h.keyInput().disabled, false);
    assert.equal(h.keyInput().type, "text");
    assert.deepEqual(h.reads, ["example", "example"]);
    assert.deepEqual(h.staged, []);
    assert.deepEqual(h.writes, []);
  } finally { await h.close(); }
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`a reveal ${outcome} after unmount cannot affect a replacement panel`, async () => {
    const pending = deferred<string>();
    const old = await harness({ readKey: async () => pending.promise });
    try {
      await old.selectProvider("Example");
      await old.click('[aria-label="显示密钥"]');
      assert.equal(old.keyInput().disabled, true);
    } finally { await old.close(); }
    const current = await harness();
    try {
      await current.selectProvider("Example");
      await current.editKey("SYNTHETIC_REPLACEMENT_EDIT");
      await act(async () => {
        if (outcome === "resolve") pending.resolve(syntheticKey);
        else pending.reject(new Error("Synthetic unmounted read failure"));
      });
      assert.equal(current.keyInput().value, "SYNTHETIC_REPLACEMENT_EDIT");
      assert.equal(current.keyInput().disabled, false);
      assert.deepEqual(old.staged, []);
      assert.deepEqual(old.writes, []);
      assert.equal(current.staged.length, 0);
      await current.enterKey();
      assert.deepEqual(current.staged.map(item => item.secret), ["SYNTHETIC_REPLACEMENT_EDIT"]);
      assert.equal(current.writes.length, 1);
    } finally { await current.close(); }
  });
}
