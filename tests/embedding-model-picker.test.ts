import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import type { DesktopEmbeddingModelDescriptor } from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

test("opening embedding selection fetches capable connections and searches real IDs", { timeout: 15_000 }, async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createServer } = await import("vite");
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, entries: [] } });
  const { SettingsMemory } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsMemory.tsx");
  const { SettingsDraftContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDraftContext.ts");
  const root = createRoot(document.getElementById("root")!);
  const policy = structuredClone(defaultConfig.context.memory);
  const existing: DesktopEmbeddingModelDescriptor = { ref: { kind: "provider", provider: "gateway", model: "old-vectors" },
    fingerprint: "existing", displayName: "Existing vectors", recommendedThreshold: 0.3, source: "provider", available: true };
  const discovered: DesktopEmbeddingModelDescriptor = { ...existing, ref: { kind: "provider", provider: "gateway", model: "vector-001" },
    fingerprint: "discovered", displayName: "Semantic vectors" };
  let statusModels: DesktopEmbeddingModelDescriptor[] = [existing];
  let fetchError: string | undefined;
  const fetches: string[] = [];
  const selections: unknown[] = [];
  const context = { draft: { memory: policy }, dirtyCount: 0,
    setMemory: (next: typeof policy) => { selections.push(next.embeddingModel); },
    snapshot: { memory: policy, models: { connections: [
      { providerAlias: "gateway", displayName: "My gateway", supportsEmbedding: true, hasCredential: true, requiresApiKey: true },
      { providerAlias: "messages", supportsEmbedding: false },
      { providerAlias: "disabled", supportsEmbedding: true, enabled: false }
    ] } } } as unknown as SettingsDraftContextValue;
  const stats = async () => ({ totalEntries: 0, memoryStats: { total: 0 }, maintenance: { state: "idle" } });
  const props = { models: [], embeddingModels: [existing], workspaceAvailable: true, sessionRunning: false,
    onLoadStats: stats, onLoadEntries: async () => ({ entries: [], total: 0 }),
    onLoadArchived: async () => ({ entries: [], total: 0 }), onLoadRuns: async () => ({ state: "idle", sleepRuns: [] }),
    onSleepStatus: async () => ({ state: "idle" }),
    onLoadEmbeddingStatus: async () => ({ models: statusModels, localModels: [], index: { available: false } }),
    onFetchModelCatalog: async (provider: string) => {
      fetches.push(provider);
      if (fetchError) throw new Error(fetchError);
      statusModels = [discovered]; return { models: [] };
    },
    onNotify: () => {} };
  const click = async (selector: string) => { await act(async () => {
    const button = document.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); button.click();
  }); };
  try {
    await act(async () => { root.render(createElement(SettingsDraftContext.Provider, { value: context }, createElement(SettingsMemory, props))); });
    assert.deepEqual(fetches, [], "reading settings must not fetch every connection before selection is opened");
    await click('[aria-label="选择嵌入模型"]');
    assert.deepEqual(fetches, ["gateway"]);
    assert.doesNotMatch(document.querySelector('[role="listbox"]')!.textContent!, /Existing vectors/u,
      "a refreshed catalog must replace stale snapshot candidates");
    assert.match(document.body.textContent!, /My gateway/u);
    const input = document.querySelector<HTMLInputElement>('.settings-model-picker-search input')!;
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "vector-001");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.match(document.querySelector('[role="listbox"]')!.textContent!, /Semantic vectors/u);
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(button => button.textContent?.includes("Semantic vectors"));
    assert.ok(option);
    await act(async () => { option.click(); });
    assert.deepEqual(selections, [{ kind: "provider", provider: "gateway", model: "vector-001" }]);
    await click('[aria-label="选择嵌入模型"]');
    assert.deepEqual(fetches, ["gateway"], "reopening uses the same connection catalog");
    await click('[aria-label="选择嵌入模型"]');
    context.snapshot!.configRevision = "updated-credentials";
    fetchError = "Provider is offline";
    await act(async () => { root.render(createElement(SettingsDraftContext.Provider, { value: context }, createElement(SettingsMemory, props))); });
    await click('[aria-label="选择嵌入模型"]');
    assert.deepEqual(fetches, ["gateway", "gateway"], "changed settings must fetch against the new connection configuration");
    assert.match(document.body.textContent!, /Provider is offline/u);
    assert.match(document.querySelector('[role="listbox"]')!.textContent!, /Semantic vectors/u,
      "a failed catalog read preserves usable candidates");
    await click('[aria-label="选择嵌入模型"]');
    fetchError = undefined;
    await click('[aria-label="选择嵌入模型"]');
    assert.deepEqual(fetches, ["gateway", "gateway", "gateway"], "failed reads can be retried by reopening");
    assert.doesNotMatch(document.body.textContent!, /Provider is offline/u);
  } finally {
    await act(() => root.unmount()); await vite.close(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
