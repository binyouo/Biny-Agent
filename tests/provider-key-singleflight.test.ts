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
  DesktopSettingsSnapshot,
  DesktopStagedSettingsCredential
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
  let reject!: (reason: Error) => void;
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
  stage?: (secret: string, scope: DesktopSettingsCredentialScope, index: number) => Promise<DesktopStagedSettingsCredential>;
  readKey?: (providerAlias: string) => Promise<string | undefined>;
  save?: (input: DesktopSettingsSaveInput, current: DesktopSettingsSnapshot) => Promise<DesktopSettingsSaveResult>;
} = {}) {
  const writes: DesktopSettingsSaveInput[] = [];
  const staged: Array<{ secret: string; scope: DesktopSettingsCredentialScope }> = [];
  const reads: string[] = [];
  const released: string[][] = [];
  const notices: string[] = [];
  let current = snapshot(options.withModel ?? true);
  Object.assign(dom.window, {
    biny: {
      previewAppearance: async () => {}, updateSettingsDraftState: async () => {},
      settingsSnapshot: async () => current,
      stageSettingsCredential: async (secret: string, scope: DesktopSettingsCredentialScope) => {
        staged.push({ secret, scope });
        if (options.stage) return options.stage(secret, scope, staged.length);
        return { handle: `synthetic:${staged.length}`, kind: "api-key", expiresAt: "2099-01-01T00:00:00Z" };
      },
      releaseSettingsCredentials: async (handles: string[]) => { released.push(handles); },
      saveSettings: async (_projectId: string, input: DesktopSettingsSaveInput): Promise<DesktopSettingsSaveResult> => {
        writes.push(structuredClone(input));
        if (options.save) {
          const result = await options.save(input, current);
          if (result.snapshot) current = result.snapshot;
          return result;
        }
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
      onCancelLogin: async () => {}, onNotify: (message: string) => { notices.push(message); }, onOpenExternal: async () => { throw new Error("Unexpected external URL"); }
    });
    return React.createElement(React.Fragment, null, provider, React.createElement(SettingsPageFooter, {
      dirtyCount: context.dirtyCount, disabled: context.invalid, state: context.saveState,
      onCancel: () => { void context.discard(); }, onSave: () => { void context.saveAll(); }
    }));
  }
  await act(async () => root.render(React.createElement(SettingsDraftProvider, {
    active: true, projectId: "project", sessionRunning: false, onCommitted: () => {},
    onFontPreview: () => {}, onThemePreview: () => {}, onNotify: (message: string) => { notices.push(message); }, children: React.createElement(Content)
  })));
  const document = dom.window.document;
  const keyInput = (): HTMLInputElement => {
    const input = document.querySelector<HTMLInputElement>('.secret-input-row input');
    assert.ok(input);
    return input;
  };
  return {
    dom, writes, staged, reads, released, notices, keyInput,
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
    blurKey: async () => { await act(async () => {
      const input = keyInput();
      assert.equal(input.disabled, false);
      assert.equal(input.readOnly, false);
      assert.equal(input.closest("[inert], fieldset[disabled]"), null);
      input.focus();
      assert.equal(document.activeElement, input);
      const reveal = document.querySelector<HTMLButtonElement>(".secret-input-row button")!;
      assert.equal(reveal.disabled, false);
      reveal.focus();
      assert.equal(document.activeElement, reveal);
    }); },
    enterKey: async () => { await act(async () => {
      const input = keyInput();
      assert.equal(input.disabled, false);
      input.focus();
      assert.equal(document.activeElement, input);
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }); },
    close: async () => {
      await act(async () => { root.unmount(); });
      Reflect.deleteProperty(dom.window, "biny");
    }
  };
}

function committed(withModel: boolean, revision = 2): DesktopSettingsSaveResult {
  return { status: "committed", journalId: `synthetic:${revision}`, appliedFields: [], snapshot: { ...snapshot(withModel), configRevision: `config:${revision}` } };
}

function stagedCredential(index: number): DesktopStagedSettingsCredential {
  return { handle: `synthetic:${index}`, kind: "api-key", expiresAt: "2099-01-01T00:00:00Z" };
}

for (const withModel of [true, false]) {
  for (const firstTrigger of ["blur", "enter", "debounce"] as const) {
    test(`one unchanged edit submits once during pending save: ${firstTrigger}, model=${withModel}`, async t => {
      const pending = deferred<DesktopSettingsSaveResult>();
      const h = await harness({ withModel, save: async () => h.writes.length === 1 ? pending.promise : committed(withModel, 3) });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await h.selectProvider("Example");
        await h.editKey("SYNTHETIC_UNCHANGED_EDIT");
        if (firstTrigger === "blur") await h.blurKey();
        else if (firstTrigger === "enter") await h.enterKey();
        else await act(async () => { t.mock.timers.tick(900); });
        assert.equal(h.staged.length, 1);
        assert.equal(h.writes.length, 1);
        assert.ok(h.dom.window.document.querySelector(".provider-key-state.is-busy"));
        await h.blurKey();
        await h.enterKey();
        await h.blurKey();
        await act(async () => { t.mock.timers.tick(900); });
        assert.equal(h.staged.length, 1, "unchanged pending edit must retain its single staged handle");
        assert.deepEqual(h.released, [], "repeat must not release the handle used by the pending save");
        assert.equal(h.writes.length, 1);
        await act(async () => pending.resolve(committed(withModel)));
        assert.equal(h.writes.length, 1, "real draft queue must not contain a redundant save");
        assert.equal(h.context().dirtyCount, 0);
        assert.deepEqual(h.notices, []);
      } finally { pending.resolve(committed(withModel)); await h.close(); }
    });
  }

  test(`one unchanged edit submits once while credential staging is pending, model=${withModel}`, async () => {
    const pending = deferred<DesktopStagedSettingsCredential>();
    const h = await harness({ withModel, stage: async (_secret, _scope, index) => index === 1 ? pending.promise : stagedCredential(index) });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_STAGE_PENDING");
      await h.blurKey(); await h.enterKey(); await h.blurKey();
      assert.equal(h.staged.length, 1);
      assert.equal(h.writes.length, 0);
      await act(async () => pending.resolve(stagedCredential(1)));
      assert.equal(h.writes.length, 1);
      assert.equal(h.context().dirtyCount, 0);
    } finally { pending.resolve(stagedCredential(1)); await h.close(); }
  });

  for (const failure of ["rolled_back", "rejected"] as const) {
    test(`same edit can retry after ${failure}, model=${withModel}`, async () => {
      const pending = deferred<DesktopSettingsSaveResult>();
      const h = await harness({ withModel, save: async () => h.writes.length === 1 ? pending.promise : committed(withModel) });
      try {
        await h.selectProvider("Example");
        await h.editKey("SYNTHETIC_RETRY");
        await h.blurKey(); await h.enterKey();
        assert.equal(h.staged.length, 1);
        await act(async () => {
          if (failure === "rejected") pending.reject(new Error("Synthetic save failure"));
          else pending.resolve({ status: "rolled_back", journalId: "synthetic:failed", draftRetained: true, snapshot: snapshot(withModel), message: "Synthetic rollback" });
        });
        assert.equal(h.writes.length, 1);
        assert.ok(h.dom.window.document.querySelector(".provider-key-state.is-error"));
        assert.equal(h.context().dirtyCount, 0, "failed key write stays in its editor and must not stage unrelated model candidates");
        await h.blurKey();
        assert.equal(h.staged.length, 2);
        assert.equal(h.writes.length, 2);
        assert.equal(h.context().dirtyCount, 0);
        assert.ok(h.dom.window.document.querySelector(".provider-key-state.is-ok"));
      } finally { pending.resolve(committed(withModel)); await h.close(); }
    });
  }

  test(`same edit can retry after credential staging rejection, model=${withModel}`, async () => {
    const pending = deferred<DesktopStagedSettingsCredential>();
    const h = await harness({ withModel, stage: async (_secret, _scope, index) => index === 1 ? pending.promise : stagedCredential(index) });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_STAGE_RETRY");
      await h.blurKey(); await h.enterKey();
      assert.equal(h.staged.length, 1);
      await act(async () => pending.reject(new Error("Synthetic staging failure")));
      assert.equal(h.writes.length, 0);
      await h.blurKey();
      assert.equal(h.staged.length, 2);
      assert.equal(h.writes.length, 1);
      assert.equal(h.context().dirtyCount, 0);
    } finally { pending.resolve(stagedCredential(1)); await h.close(); }
  });

  test(`distinct edits A then B then A all submit in order, model=${withModel}`, async () => {
    const pending = deferred<DesktopSettingsSaveResult>();
    const h = await harness({ withModel, save: async () => h.writes.length === 1 ? pending.promise : committed(withModel, h.writes.length + 1) });
    try {
      await h.selectProvider("Example");
      for (const value of ["SYNTHETIC_A", "SYNTHETIC_B", "SYNTHETIC_A"]) {
        await h.editKey(value);
        await h.blurKey(); await h.enterKey();
      }
      assert.deepEqual(h.staged.map(item => item.secret), ["SYNTHETIC_A", "SYNTHETIC_B", "SYNTHETIC_A"]);
      assert.equal(h.writes.length, 1);
      await act(async () => pending.resolve(committed(withModel)));
      assert.equal(h.writes.length, 3);
      assert.deepEqual(h.writes.map(input => input.models?.customProviders?.[0]?.apiKeyHandle), ["synthetic:1", "synthetic:2", "synthetic:3"]);
      assert.deepEqual(h.writes.map(input => input.expectedConfigRevision), ["config:1", "config:2", "config:3"]);
      assert.equal(h.keyInput().value, "SYNTHETIC_A");
      assert.equal(h.context().dirtyCount, 0);
    } finally { pending.resolve(committed(withModel)); await h.close(); }
  });

  test(`older settlement does not unlock a newer pending edit, model=${withModel}`, async () => {
    const first = deferred<DesktopSettingsSaveResult>();
    const second = deferred<DesktopSettingsSaveResult>();
    const h = await harness({ withModel, save: async () => h.writes.length === 1 ? first.promise : h.writes.length === 2 ? second.promise : committed(withModel, 4) });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_OLD"); await h.blurKey();
      await h.editKey("SYNTHETIC_NEW"); await h.blurKey();
      await act(async () => first.resolve({ status: "rolled_back", journalId: "synthetic:failed", draftRetained: true, snapshot: snapshot(withModel), message: "Synthetic rollback" }));
      assert.equal(h.writes.length, 2);
      await h.blurKey(); await h.enterKey();
      assert.equal(h.staged.length, 2, "settling old attempt must not clear new attempt's pending marker");
      await act(async () => second.resolve(committed(withModel)));
      assert.equal(h.writes.length, 2);
      assert.equal(h.keyInput().value, "SYNTHETIC_NEW");
      assert.equal(h.context().dirtyCount, 0);
    } finally { first.resolve(committed(withModel)); second.resolve(committed(withModel, 3)); await h.close(); }
  });

  test(`provider A then B then A receives independent submission identities after pending saves finish, model=${withModel}`, async () => {
    const pending = deferred<DesktopSettingsSaveResult>();
    const h = await harness({ withModel, save: async () => h.writes.length === 1 ? pending.promise : committed(withModel, h.writes.length + 1) });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_SAME_TEXT");
      await h.blurKey(); await h.enterKey();
      await h.selectProvider("Second");
      assert.equal(h.staged.length, 1, "switch waits for the pending connection write");
      await act(async () => pending.resolve(committed(withModel)));
      for (const provider of ["Second", "Example"]) {
        await h.selectProvider(provider);
        await h.editKey("SYNTHETIC_SAME_TEXT");
        await h.blurKey(); await h.enterKey();
      }
      assert.deepEqual(h.staged.map(item => item.scope.providerAlias), ["example", "second", "example"]);
      assert.equal(h.writes.length, 3);
      assert.equal(h.context().dirtyCount, 0);
    } finally { pending.resolve(committed(withModel)); await h.close(); }
  });

  test(`clear then retype is a new edit while the previous save is pending, model=${withModel}`, async () => {
    const pending = deferred<DesktopSettingsSaveResult>();
    const h = await harness({ withModel, save: async () => h.writes.length === 1 ? pending.promise : committed(withModel, 3) });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_REENTERED"); await h.blurKey();
      await h.editKey(""); await h.blurKey();
      assert.equal(h.staged.length, 1);
      await h.editKey("SYNTHETIC_REENTERED"); await h.blurKey(); await h.enterKey();
      assert.equal(h.staged.length, 2);
      await act(async () => pending.resolve(committed(withModel)));
      assert.equal(h.writes.length, 2);
      assert.equal(h.context().dirtyCount, 0);
    } finally { pending.resolve(committed(withModel)); await h.close(); }
  });
}

for (const withModel of [true, false]) {
  test(`control: blank unedited field does not stage, model=${withModel}`, async () => {
    const h = await harness({ withModel });
    try {
      await h.selectProvider("Example");
      await h.blurKey(); await h.enterKey();
      assert.deepEqual(h.staged, []);
      assert.deepEqual(h.writes, []);
      assert.equal(h.context().dirtyCount, 0);
    } finally { await h.close(); }
  });

  test(`control: ordinary edit saves successfully, model=${withModel}`, async () => {
    const h = await harness({ withModel });
    try {
      await h.selectProvider("Example");
      await h.editKey("  SYNTHETIC_ORDINARY_EDIT  ");
      await h.blurKey();
      assert.equal(h.staged.length, 1);
      assert.equal(h.staged[0]?.secret, "SYNTHETIC_ORDINARY_EDIT");
      assert.equal(h.writes.length, 1);
      assert.ok(!JSON.stringify(h.writes).includes("SYNTHETIC_ORDINARY_EDIT"));
      assert.equal(h.context().dirtyCount, 0);
      assert.ok(h.dom.window.document.querySelector(".provider-key-state.is-ok"));
    } finally { await h.close(); }
  });

  test(`control: distinct A then B then A without repeat gestures all submit, model=${withModel}`, async () => {
    const pending = deferred<DesktopSettingsSaveResult>();
    const h = await harness({ withModel, save: async () => h.writes.length === 1 ? pending.promise : committed(withModel, h.writes.length + 1) });
    try {
      await h.selectProvider("Example");
      for (const value of ["SYNTHETIC_A", "SYNTHETIC_B", "SYNTHETIC_A"]) {
        await h.editKey(value); await h.blurKey();
      }
      assert.deepEqual(h.staged.map(item => item.secret), ["SYNTHETIC_A", "SYNTHETIC_B", "SYNTHETIC_A"]);
      await act(async () => pending.resolve(committed(withModel)));
      assert.equal(h.writes.length, 3);
      assert.equal(h.context().dirtyCount, 0);
    } finally { pending.resolve(committed(withModel)); await h.close(); }
  });
}

for (const withModel of [true, false]) {
  test(`unmount cancels the edited key's pending debounce, model=${withModel}`, async t => {
    const h = await harness({ withModel });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let closed = false;
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_NEVER_SUBMITTED");
      await h.close(); closed = true;
      await act(async () => { t.mock.timers.tick(900); });
      assert.deepEqual(h.staged, []);
      assert.deepEqual(h.writes, []);
    } finally { if (!closed) await h.close(); }
  });

  test(`undefined saveModels result does not lock same-edit retries, model=${withModel}`, async () => {
    const h = await harness({ withModel, save: async () => h.writes.length === 1
      ? { status: "recovery_required", journalId: "synthetic:recovery", message: "Synthetic recovery required" }
      : committed(withModel) });
    try {
      await h.selectProvider("Example");
      await h.editKey("SYNTHETIC_RECOVERY_RETRY"); await h.blurKey();
      assert.equal(h.writes.length, 1);
      assert.equal(h.context().saveState, "recovery_required");
      await h.blurKey();
      assert.equal(h.staged.length, 2);
      assert.equal(h.writes.length, 1, "real coordinator returns undefined while recovery blocks saves");
      await h.blurKey();
      assert.equal(h.staged.length, 3, "an undefined result must release the attempt marker");
      assert.equal(h.writes.length, 1);
      await act(async () => { await h.context().discard(); });
      await h.blurKey();
      assert.equal(h.staged.length, 4);
      assert.equal(h.writes.length, 2);
      assert.equal(h.context().dirtyCount, 0);
    } finally { await h.close(); }
  });
}
