/**
 * Actual Desktop memory APIs and SQLite ordering, mounted with the real SettingsMemory.
 * Holding a completed API reply models delivery latency; no product method is replaced.
 * This is DOM/SQLite coverage, not an Electron window or keyboard-focus test.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DesktopMemoryEntryPatch, DesktopMemoryStats } from "../src/desktop/protocol.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const submitted = "First saved correction";
const continued = "A later correction typed while the first save is pending";
const editorSelector = 'textarea[aria-label="编辑记忆"]';
const saveSelector = "#memory-list .settings-primary-button";
const cancelSelector = "#memory-list .activity-memory-entry-editor .text-button";
const nextSelector = "#memory-list .activity-memory-pagination button:last-child";
const previousSelector = "#memory-list .activity-memory-pagination button:first-child";

interface SavedUpdate { id: string; patch: DesktopMemoryEntryPatch }
interface Fixture {
  document: Document;
  updates: SavedUpdate[];
  notifications: string[];
  click(selector: string): Promise<void>;
  type(value: string): Promise<void>;
  beginEdit(page: 0 | 1): Promise<string>;
  saveHeld(): Promise<void>;
  release(): Promise<void>;
  page(): string;
  waitFor(predicate: () => boolean, label: string): Promise<void>;
  firstPageIds(): Promise<string[]>;
  secondPageIds(): Promise<string[]>;
  persisted(id: string): Promise<{ content?: string; total: number; revision: number }>;
  remove(id: string, archive: boolean): Promise<void>;
}

function editorCount(fixture: Fixture): number {
  return fixture.document.querySelectorAll(editorSelector).length;
}

function editorValue(fixture: Fixture): string | undefined {
  return fixture.document.querySelector<HTMLTextAreaElement>(editorSelector)?.value;
}

async function withFixture(check: (fixture: Fixture) => Promise<void>): Promise<void> {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "biny-memory-editor-order-"));
  const workspace = path.join(rootDirectory, "workspace");
  await mkdir(workspace);
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(rootDirectory, "agent");
  const originalFetch = globalThis.fetch;
  const networkRequests: string[] = [];
  const failClosedFetch: typeof globalThis.fetch = async (input) => {
    networkRequests.push(String(input));
    throw new Error("Unexpected network request in the memory editor fixture.");
  };
  globalThis.fetch = failClosedFetch;
  const restoreGlobals = new Map<string, PropertyDescriptor | undefined>();
  let agents: import("../src/desktop/electron/main/DesktopAgentManager.js").DesktopAgentManager | undefined;
  let dom: import("jsdom").JSDOM | undefined;
  let vite: import("vite").ViteDevServer | undefined;
  let reactRoot: import("react-dom/client").Root | undefined;
  let act: typeof import("react").act | undefined;
  const heldReply = Promise.withResolvers<void>();
  const firstCommitted = Promise.withResolvers<void>();
  // Observe rejection immediately even in a control that never starts an update.
  void firstCommitted.promise.catch(() => undefined);
  const pendingUpdates = new Set<Promise<DesktopMemoryStats>>();
  const updates: SavedUpdate[] = [];
  const notifications: string[] = [];
  let holdFirstUpdate = true;
  try {
    // Product modules are loaded only after every state path and network boundary is isolated.
    const { LocalMemory } = await import("../src/agent/context/LocalMemory.js");
    const { MemoryStorage } = await import("../src/agent/context/memoryStorage.js");
    const { defaultConfig } = await import("../src/config/schema.js");
    const { createFileConfigStore } = await import("../src/config/store.js");
    const { DesktopAgentManager } = await import("../src/desktop/electron/main/DesktopAgentManager.js");
    const { DesktopProjectService } = await import("../src/desktop/electron/main/DesktopProjectService.js");
    const { DesktopStateStore } = await import("../src/desktop/electron/main/DesktopStateStore.js");
    const { DesktopUserDataStore } = await import("../src/desktop/electron/main/DesktopUserDataStore.js");
    const { FileModelsStore } = await import("../src/llm/ModelsStore.js");
    const seed = new LocalMemory(workspace, () => { throw new Error("Seeding must not call a model."); });
    try {
      assert.equal((await seed.listMemoryEntries()).total, 0);
      assert.equal((await seed.listArchivedEntries()).total, 0);
      for (let index = 0; index < 41; index += 1) {
        const result = await seed.writeEntry({ content: `Historical fact ${index}`, source: "manual" },
          { now: new Date(Date.UTC(2001, 0, 1, 0, 0, index)) });
        assert.equal(result.written, true);
      }
    } finally { seed.close(); }

    const userData = new DesktopUserDataStore(path.join(rootDirectory, "desktop"));
    await userData.initialize();
    const state = new DesktopStateStore(path.join(rootDirectory, "desktop-state.json"));
    await state.load();
    const configStore = createFileConfigStore(workspace, {
      globalDir: path.join(rootDirectory, "agent"),
      credentialStore: { persistent: true, get: async () => "test-key", set: async () => undefined, delete: async () => undefined }
    });
    const policy = { ...defaultConfig.context.memory, enabled: true, sleepEnabled: false, generateMemories: false, useMemories: false };
    await configStore.save({
      ...defaultConfig,
      defaultModel: "test-model",
      providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://memory-fixture.invalid/v1" } },
      models: { "test-model": { provider: "active", model: "test-model", contextWindow: 128_000 } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      context: { ...defaultConfig.context, memory: policy }
    });
    const projects = new DesktopProjectService(state, userData, configStore);
    const project = await projects.createProject(workspace);
    // Omitting runtimeHostAppPath selects the normal in-process Host path, with no detached spawn.
    const manager = new DesktopAgentManager(state, projects, configStore, () => undefined,
      undefined, new FileModelsStore(path.join(rootDirectory, "agent", "models-store.json")), failClosedFetch);
    agents = manager;

    const { JSDOM } = await import("jsdom");
    dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
    const window = dom.window;
    for (const [key, value] of Object.entries({
      window, document: window.document, navigator: window.navigator,
      HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
      MutationObserver: window.MutationObserver,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      IS_REACT_ACT_ENVIRONMENT: true
    })) {
      restoreGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    window.fetch = failClosedFetch;
    // This suite owns explicit saves/reads. Sleep polling has its own lifecycle regressions.
    window.setInterval = (() => 1) as typeof window.setInterval;
    window.clearInterval = () => undefined;
    const React = await import("react");
    act = React.act;
    const { createRoot } = await import("react-dom/client");
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom",
      optimizeDeps: { noDiscovery: true, entries: [] } });
    const { SettingsMemory } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsMemory.tsx") as typeof import("../src/desktop/renderer/src/components/settings/SettingsMemory.js");
    const { SettingsDraftContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDraftContext.ts") as typeof import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
    const container = window.document.getElementById("root");
    assert.equal(container !== null, true);
    reactRoot = createRoot(container!);
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected unrelated memory action."); };
    const onUpdate = (id: string, patch: DesktopMemoryEntryPatch): Promise<DesktopMemoryStats> => {
      const hold = holdFirstUpdate;
      holdFirstUpdate = false;
      updates.push({ id, patch: { ...patch } });
      const operation = (async () => {
        try {
          const result = await manager.updateMemoryEntry(project.id, id, patch);
          if (hold) {
            firstCommitted.resolve();
            await heldReply.promise;
          }
          return result;
        } catch (error) {
          if (hold) firstCommitted.reject(error);
          throw error;
        }
      })();
      pendingUpdates.add(operation);
      void operation.then(() => pendingUpdates.delete(operation), () => pendingUpdates.delete(operation));
      return operation;
    };
    const props: Parameters<typeof SettingsMemory>[0] = {
      models: [], embeddingModels: [], workspaceAvailable: true, sessionRunning: false,
      onLoadStats: () => manager.memoryStats(project.id),
      onLoadEntries: (offset, limit, includeArchived) => manager.memoryEntries(project.id, offset, limit, includeArchived),
      onUpdate,
      onLoadArchived: (offset, limit, chains) => manager.archivedMemoryEntries(project.id, offset, limit, chains),
      onSleepStatus: () => manager.memorySleepStatus(project.id),
      onSleepRuns: () => manager.memorySleepRuns(project.id),
      onSearch: unexpected, onAdd: unexpected, onDeleteEntry: unexpected, onArchiveEntry: unexpected,
      onRunSleep: unexpected, onPreviewSleep: unexpected, onCancelSleep: unexpected, onClearMemory: unexpected,
      onTestModelConfiguration: unexpected, onLoadEmbeddingStatus: () => manager.memoryEmbeddingStatus(project.id),
      onDownloadEmbeddingModel: unexpected, onCancelEmbeddingDownload: unexpected,
      onRebuildEmbeddingIndex: unexpected, onCancelEmbeddingRebuild: unexpected,
      onNotify: message => { notifications.push(message); }
    };
    const context = { draft: { memory: policy }, snapshot: { memory: policy, models: { connections: [] } }, dirtyCount: 0,
      setMemory: () => undefined } as unknown as SettingsDraftContextValue;
    const perform = act;
    await perform(async () => {
      reactRoot!.render(React.createElement(SettingsDraftContext.Provider, { value: context },
        React.createElement(SettingsMemory, props)));
    });
    const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await perform(async () => { await new Promise<void>(resolve => setTimeout(resolve, 10)); });
      }
    };
    const click = async (selector: string): Promise<void> => {
      const button = window.document.querySelector<HTMLButtonElement>(selector);
      assert.equal(button !== null, true, `Missing button: ${selector}`);
      assert.equal(button!.disabled, false, `Disabled button: ${selector}`);
      await perform(async () => { button!.click(); });
    };
    const page = (): string => window.document.querySelector("#memory-list .activity-memory-pagination > div > span")?.textContent ?? "";
    await waitFor(() => page() === "1 / 3", "initial real page");
    await check({
      document: window.document, updates, notifications, click, page, waitFor,
      type: async value => {
        const textarea = window.document.querySelector<HTMLTextAreaElement>(editorSelector);
        assert.equal(textarea !== null, true, "The draft editor must remain accessible.");
        await perform(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
          textarea!.dispatchEvent(new window.Event("input", { bubbles: true }));
        });
      },
      beginEdit: async wantedPage => {
        if (wantedPage === 1) {
          await click(nextSelector);
          await waitFor(() => page() === "2 / 3", "second real page");
        }
        const entries = await manager.memoryEntries(project.id, wantedPage * 20, 20);
        const target = entries.entries[0];
        assert.equal(target !== undefined, true);
        const firstVisible = window.document.querySelector("#memory-list .activity-memory-entry-content p")?.textContent;
        assert.equal(firstVisible, target!.content, "The edit target must be the actual current page's first fact.");
        await click('#memory-list [aria-label="编辑记忆"]');
        return target!.id;
      },
      saveHeld: async () => {
        await click(saveSelector);
        await deadline(firstCommitted.promise, "the real update to commit");
        assert.equal(updates.length, 1);
        assert.equal(window.document.querySelector<HTMLButtonElement>(saveSelector)?.disabled, true);
      },
      release: async () => {
        await perform(async () => { heldReply.resolve(); });
        await waitFor(() => notifications.includes("记忆已更新"), "save delivery and page reload");
      },
      firstPageIds: async () => (await manager.memoryEntries(project.id, 0, 20)).entries.map(entry => entry.id),
      secondPageIds: async () => (await manager.memoryEntries(project.id, 20, 20)).entries.map(entry => entry.id),
      persisted: async id => {
        const reader = new MemoryStorage(workspace);
        try {
          const entry = await reader.getEntry(id, { activeOnly: true });
          const overview = await reader.getOverview();
          return { content: entry?.content, total: overview.entryCount, revision: overview.storeRevision };
        } finally { reader.close(); }
      },
      remove: async (id, archive) => {
        if (archive) await manager.archiveMemoryEntry(project.id, id, true);
        else await manager.deleteMemoryEntry(project.id, id);
      }
    });
    assert.deepEqual(networkRequests, [], "No model, provider or external network requests are needed.");
  } finally {
    heldReply.resolve();
    await Promise.allSettled([...pendingUpdates]);
    try {
      if (reactRoot && act) await act(() => reactRoot!.unmount());
    } finally {
      try { await vite?.close(); }
      finally {
        dom?.window.close();
        for (const [key, descriptor] of restoreGlobals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
        try { await agents?.closeAll(); }
        finally {
          globalThis.fetch = originalFetch;
          if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
          else process.env.BINY_AGENT_DIR = previousAgentDir;
          await rm(rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    }
  }
}

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function continuedOffPage(f: Fixture): Promise<string> {
  const id = await f.beginEdit(1);
  await f.type(submitted);
  await f.saveHeld();
  assert.deepEqual(await f.persisted(id), { content: submitted, total: 41, revision: 42 });
  assert.equal((await f.firstPageIds()).includes(id), true, "The actual committed update must move this fact to page 1.");
  assert.equal((await f.secondPageIds()).includes(id), false, "The current page must genuinely lose this fact.");
  await f.type(continued);
  await f.release();
  assert.equal(f.page(), "2 / 3", "Do not solve the draft issue by changing the user's page.");
  return id;
}

test("continued off-page draft can save again to the same persisted fact", { concurrency: false }, async () => {
  await withFixture(async f => {
    const id = await continuedOffPage(f);
    assert.equal(editorCount(f), 1, "The retained draft needs a visible editor after SQLite reorders its fact.");
    assert.equal(editorValue(f), continued);
    await f.click(saveSelector);
    await f.waitFor(() => f.notifications.filter(message => message === "记忆已更新").length === 2, "the second save and reload to finish");
    assert.equal(editorCount(f), 0);
    assert.deepEqual(f.updates.map(update => update.id), [id, id]);
    assert.equal(f.page(), "2 / 3");
    assert.deepEqual(await f.persisted(id), { content: continued, total: 41, revision: 43 });
  });
});

test("continued off-page draft can be cancelled without another write", { concurrency: false }, async () => {
  await withFixture(async f => {
    const id = await continuedOffPage(f);
    assert.equal(editorCount(f), 1, "Cancel must remain reachable after reordering.");
    await f.click(cancelSelector);
    assert.equal(editorCount(f), 0);
    assert.equal(f.document.querySelector<HTMLTextAreaElement>("#memory-add textarea")?.disabled, false);
    assert.equal(f.page(), "2 / 3");
    assert.equal(f.updates.length, 1);
    assert.deepEqual(await f.persisted(id), { content: submitted, total: 41, revision: 42 });
  });
});

for (const archived of [false, true]) test(`off-page retry preserves the draft when its fact is ${archived ? "archived" : "deleted"}`, { concurrency: false }, async () => {
  await withFixture(async f => {
    const id = await continuedOffPage(f);
    assert.equal(editorCount(f), 1, "The pending correction must remain available.");
    await f.remove(id, archived);
    await f.click(saveSelector);
    await f.waitFor(() => f.notifications.some(message => message.includes("未找到该记忆条目")), "the actual missing-fact rejection");
    assert.equal(editorCount(f), 1);
    assert.equal(editorValue(f), continued);
    assert.equal(f.notifications.filter(message => message === "记忆已更新").length, 1, "A rejected retry cannot claim another saved correction.");
    assert.deepEqual(await f.persisted(id), { content: undefined, total: 40, revision: 43 });
    await f.click(cancelSelector);
    assert.equal(f.document.querySelector<HTMLTextAreaElement>("#memory-add textarea")?.disabled, false);
  });
});

test("returning to the reordered fact shows exactly one retained editor", { concurrency: false }, async () => {
  await withFixture(async f => {
    const id = await continuedOffPage(f);
    await f.click(previousSelector);
    await f.waitFor(() => f.page() === "1 / 3", "returning to the actual first page");
    assert.equal(editorCount(f), 1, "The fallback must not duplicate an editor in the normal fact row.");
    assert.equal(editorValue(f), continued);
    assert.equal((await f.firstPageIds()).includes(id), true);
    assert.equal(f.updates.length, 1);
    await f.click(cancelSelector);
    assert.equal(editorCount(f), 0);
  });
});

test("ordinary off-page save closes editing and preserves the page", { concurrency: false }, async () => {
  await withFixture(async f => {
    const id = await f.beginEdit(1);
    await f.type(submitted);
    await f.saveHeld();
    assert.equal((await f.firstPageIds()).includes(id), true);
    assert.equal((await f.secondPageIds()).includes(id), false);
    await f.release();
    assert.equal(f.page(), "2 / 3");
    assert.equal(editorCount(f), 0);
    assert.equal(f.document.querySelector<HTMLTextAreaElement>("#memory-add textarea")?.disabled, false);
    assert.deepEqual(await f.persisted(id), { content: submitted, total: 41, revision: 42 });
  });
});

test("first-page continued editing keeps one editor and saves the same ID", { concurrency: false }, async () => {
  await withFixture(async f => {
    const id = await f.beginEdit(0);
    await f.type(submitted);
    await f.saveHeld();
    await f.type(continued);
    await f.release();
    assert.equal(f.page(), "1 / 3");
    assert.equal(editorCount(f), 1);
    assert.equal(editorValue(f), continued);
    await f.click(saveSelector);
    await f.waitFor(() => f.notifications.filter(message => message === "记忆已更新").length === 2, "the ordinary follow-up save and reload");
    assert.equal(editorCount(f), 0);
    assert.deepEqual(f.updates.map(update => update.id), [id, id]);
    assert.deepEqual(await f.persisted(id), { content: continued, total: 41, revision: 43 });
  });
});
