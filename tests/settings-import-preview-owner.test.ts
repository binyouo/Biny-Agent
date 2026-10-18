/** Real settings DOM and isolated import-selection persistence; no import or sync is executed. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentConfigStore } from "../src/config/store.js";
import type { DesktopProject } from "../src/desktop/protocol.js";
import type { ApplicationImportPreview, ApplicationImportSource } from "../src/imports/types.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

interface PreviewGate {
  ready: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
  settled: ReturnType<typeof deferred<void>>;
  failure?: Error;
}

async function harness() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-import-preview-owner-")));
  const homeDir = path.join(directory, "home");
  const stateRoot = path.join(directory, "imports");
  const workspaceA = path.join(directory, "workspace-a");
  const workspaceB = path.join(directory, "workspace-b");
  const originalAgentDir = process.env.BINY_AGENT_DIR;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const gates: PreviewGate[] = [];
  const requests = new Set<Promise<unknown>>();
  const resources: {
    dom?: import("jsdom").JSDOM;
    vite?: import("vite").ViteDevServer;
    root?: import("react-dom/client").Root;
    act?: typeof import("react").act;
  } = {};
  let runCalls = 0;
  let syncCalls = 0;
  let configCalls = 0;
  let networkCalls = 0;
  const defineGlobal = (key: string, value: unknown): void => {
    if (!globals.has(key)) globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const close = async (): Promise<void> => {
    try {
      for (const gate of gates) gate.release.resolve();
      if (resources.act) await resources.act(async () => { while (requests.size) await Promise.allSettled([...requests]); });
      else while (requests.size) await Promise.allSettled([...requests]);
      if (resources.root && resources.act) await resources.act(() => resources.root!.unmount());
    } finally {
      try { await resources.vite?.close(); }
      finally {
        resources.dom?.window.close();
        for (const [key, descriptor] of globals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
        if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
        else process.env.BINY_AGENT_DIR = originalAgentDir;
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    await Promise.all([homeDir, workspaceA, workspaceB].map(folder => mkdir(folder, { recursive: true })));
    process.env.BINY_AGENT_DIR = path.join(directory, "agent");
    await mkdir(process.env.BINY_AGENT_DIR);
    defineGlobal("fetch", async () => { networkCalls += 1; throw new Error("Unexpected network request in import-selection fixture"); });
    const { ApplicationImportService } = await import("../src/imports/service.js");
    // Use a distinct post-import guard so a module cannot retain the live fetch implementation.
    defineGlobal("fetch", async () => { networkCalls += 1; throw new Error("Unexpected network request after import-selection setup"); });
    const configStore: AgentConfigStore = {
      load: async () => { configCalls += 1; throw new Error("Unexpected configuration read"); },
      save: async () => { configCalls += 1; throw new Error("Unexpected configuration write"); }
    };
    const options = { configStore, homeDir, stateRoot };
    const service = new ApplicationImportService(options);
    const sourceDirectory = path.join(homeDir, ".claude", "projects", "fixture");
    await mkdir(sourceDirectory, { recursive: true });
    for (const name of ["item-a", "item-b"]) {
      await writeFile(path.join(sourceDirectory, `${name}.jsonl`), `${JSON.stringify({
        uuid: `${name}-user`, type: "user", message: { role: "user", content: `${name} fixture text` }
      })}\n`);
    }
    const initial = await service.preview("claude");
    const itemA = initial.items.find(item => item.label === "item-a");
    const itemB = initial.items.find(item => item.label === "item-b");
    assert.ok(itemA && itemB);
    assert.notEqual(itemA.id, itemB.id);
    await service.configureSyncSelection({ previewId: initial.id, itemIds: [itemA.id], workspaceRoot: workspaceA });
    await service.configureSyncSelection({ previewId: initial.id, itemIds: [itemB.id], workspaceRoot: workspaceB });
    const projects: DesktopProject[] = [
      { id: "project-a", path: workspaceA, name: "Project A", dirty: false, missing: false, pinned: false,
        addedAt: "2026-10-18T00:00:00.000Z", lastOpenedAt: "2026-10-18T00:00:00.000Z" },
      { id: "project-b", path: workspaceB, name: "Project B", dirty: false, missing: false, pinned: false,
        addedAt: "2026-10-18T00:00:00.000Z", lastOpenedAt: "2026-10-18T00:00:00.000Z" }
    ];
    const workspaces = new Map(projects.map(project => [project.id, project.path]));
    let nextPreviewGate: PreviewGate | undefined;
    let previewCalls = 0;
    let selectionCalls = 0;
    let importedCalls = 0;
    const track = <T,>(operation: () => Promise<T>): Promise<T> => {
      const pending = operation();
      requests.add(pending);
      void pending.then(() => requests.delete(pending), () => requests.delete(pending));
      return pending;
    };
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><div id='root'></div><div id='details'></div>", {
      url: "https://desktop.local/", pretendToBeVisual: true
    });
    resources.dom = dom;
    for (const [key, value] of Object.entries({
      window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true
    })) defineGlobal(key, value);
    Object.defineProperty(dom.window, "biny", { configurable: true, value: {
      applicationImports: () => track(() => service.snapshot()),
      onApplicationImportsChanged: () => () => undefined,
      previewApplicationImport: (source: ApplicationImportSource) => {
        previewCalls += 1;
        const gate = nextPreviewGate;
        nextPreviewGate = undefined;
        return track(async (): Promise<ApplicationImportPreview> => {
          try {
            const preview = await service.preview(source);
            if (gate) {
              gate.ready.resolve();
              await gate.release.promise;
              if (gate.failure) throw gate.failure;
            }
            return preview;
          } catch (error) {
            gate?.ready.reject(error);
            throw error;
          } finally { gate?.settled.resolve(); }
        });
      },
      configureApplicationImportSync: (input: { previewId: string; itemIds: string[]; projectId: string }) => track(async () => {
        selectionCalls += 1;
        const workspaceRoot = workspaces.get(input.projectId);
        assert.ok(workspaceRoot, "only isolated projects can be selected");
        return await service.configureSyncSelection({ previewId: input.previewId, itemIds: input.itemIds, workspaceRoot });
      }),
      runApplicationImport: async () => { runCalls += 1; throw new Error("Actual import is forbidden in this fixture"); },
      syncApplicationImports: async () => { syncCalls += 1; throw new Error("Actual sync is forbidden in this fixture"); },
      setApplicationImportSync: async () => { syncCalls += 1; throw new Error("Changing sync activation is forbidden in this fixture"); }
    } });
    const { act, createElement } = await import("react");
    resources.act = act;
    const { createRoot } = await import("react-dom/client");
    const { createServer } = await import("vite");
    const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom",
      optimizeDeps: { noDiscovery: true, entries: [] } });
    resources.vite = vite;
    const { SettingsImport } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsImport.tsx") as typeof import("../src/desktop/renderer/src/components/settings/SettingsImport.js");
    const { SettingsDetailHostContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDetailHostContext.ts") as typeof import("../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js");
    const root = createRoot(dom.window.document.getElementById("root")!);
    resources.root = root;
    const render = async (disabled = false): Promise<void> => {
      await act(async () => {
        root.render(createElement(SettingsDetailHostContext.Provider, { value: document.getElementById("details") },
          createElement(SettingsImport, { projectId: "project-a", projects, disabled,
            onImported: async () => { importedCalls += 1; } })));
      });
      await act(async () => { while (requests.size) await Promise.allSettled([...requests]); });
    };
    const button = (text: string, within: ParentNode = document): HTMLButtonElement => {
      const element = [...within.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent?.trim() === text);
      assert.ok(element, `button ${text} is present`);
      return element;
    };
    const click = async (element: HTMLButtonElement): Promise<void> => { await act(async () => { element.click(); }); };
    const range = (): HTMLElement => {
      const element = document.querySelector<HTMLElement>('[aria-labelledby="import-sync-title"]');
      assert.ok(element, "sync-selection dialog is open");
      return element;
    };
    const adjustment = (workspace: string): HTMLButtonElement => {
      const row = [...range().querySelectorAll<HTMLElement>(".import-card-row")].find(candidate => candidate.textContent?.includes(workspace));
      assert.ok(row, `selection for ${workspace} is shown`);
      return button("调整", row);
    };
    const preview = (): HTMLElement => {
      const element = document.querySelector<HTMLElement>('[aria-labelledby="import-preview-title"]');
      assert.ok(element, "import preview is open");
      return element;
    };
    const target = (): HTMLSelectElement => {
      const element = preview().querySelector<HTMLSelectElement>("select");
      assert.ok(element);
      return element;
    };
    const waitForRequests = async (): Promise<void> => {
      await act(async () => { while (requests.size) await Promise.allSettled([...requests]); });
    };
    const selectedItems = (): string => JSON.stringify([...preview().querySelectorAll<HTMLLabelElement>(".import-preview-item")]
      .filter(row => row.querySelector<HTMLInputElement>("input")?.checked)
      .map(row => row.querySelector("strong")?.textContent));
    const selectItem = async (label: string, checked: boolean): Promise<void> => {
      const row = [...preview().querySelectorAll<HTMLLabelElement>(".import-preview-item")].find(candidate => candidate.querySelector("strong")?.textContent === label);
      const input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert.ok(input);
      if (input.checked !== checked) await act(async () => { input.click(); });
      assert.equal(input.checked, checked);
    };
    const selection = async (workspace: string): Promise<string> => {
      const current = await new ApplicationImportService(options).snapshot();
      assert.equal(current.history.length, 0, "selection edits do not create import history");
      assert.equal(current.sync.enabled, false, "the fixture never activates synchronization");
      return JSON.stringify(current.sync.selections?.find(entry => entry.workspaceRoot === workspace)?.itemIds ?? []);
    };
    await render();
    return {
      act, render, button, click, range, adjustment, preview, target, selectItem, selectedItems, waitForRequests, selection,
      workspaceA, workspaceB, idA: itemA.id, idB: itemB.id,
      previewCalls: () => previewCalls, selectionCalls: () => selectionCalls,
      openRange: async () => { await click(button("自定义")); },
      holdPreview: (failure?: Error): PreviewGate => {
        assert.equal(nextPreviewGate, undefined);
        const gate = { ready: deferred<void>(), release: deferred<void>(), settled: deferred<void>(), failure };
        gates.push(gate);
        nextPreviewGate = gate;
        return gate;
      },
      beginAdjustment: async (workspace: string, gate: PreviewGate): Promise<void> => {
        await act(async () => { adjustment(workspace).click(); await gate.ready.promise; });
        assert.equal(document.querySelector(".settings-import")?.getAttribute("aria-busy"), "true");
        assert.equal(document.querySelector('[aria-labelledby="import-preview-title"]'), null);
      },
      releasePreview: async (gate: PreviewGate): Promise<void> => {
        await act(async () => { gate.release.resolve(); await gate.settled.promise; });
        await waitForRequests();
      },
      save: async () => { await click(button("保存同步选择", preview())); await waitForRequests(); },
      close: async () => {
        await close();
        assert.equal(runCalls, 0);
        assert.equal(syncCalls, 0);
        assert.equal(configCalls, 0);
        assert.equal(networkCalls, 0);
        assert.equal(importedCalls, 0);
      }
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("pending sync preview keeps its original target when another adjustment is clicked", async () => {
  const h = await harness();
  try {
    await h.openRange();
    const gate = h.holdPreview();
    await h.beginAdjustment(h.workspaceA, gate);
    await h.click(h.adjustment(h.workspaceB));
    assert.equal(h.previewCalls(), 1, "busy rejects the second preview request");
    await h.releasePreview(gate);
    assert.equal(h.target().value, "project-a", "the ignored adjustment must not retarget the first preview");
    assert.equal(h.selectedItems(), JSON.stringify(["item-a"]));
    assert.equal(await h.selection(h.workspaceB), JSON.stringify([h.idB]));
  } finally { await h.close(); }
});

test("saving the pending preview cannot replace the other project's saved sync selection", async () => {
  const h = await harness();
  try {
    await h.openRange();
    const gate = h.holdPreview();
    await h.beginAdjustment(h.workspaceA, gate);
    await h.click(h.adjustment(h.workspaceB));
    await h.releasePreview(gate);
    assert.equal(h.selectedItems(), JSON.stringify(["item-a"]), "the response still carries A's original selected item");
    // Do not stop at the DOM target assertion: independently observe the real persisted consequence.
    await h.save();
    assert.equal(h.selectionCalls(), 1);
    assert.equal(await h.selection(h.workspaceB), JSON.stringify([h.idB]), "an ignored adjustment must leave B's selection unchanged");
    assert.equal(await h.selection(h.workspaceA), JSON.stringify([h.idA]));
  } finally { await h.close(); }
});

test("ordinary B adjustment edits only B and remains available after the previous request settles", async () => {
  const h = await harness();
  try {
    await h.openRange();
    await h.click(h.adjustment(h.workspaceB));
    await h.waitForRequests();
    assert.equal(h.target().value, "project-b");
    await h.selectItem("item-a", true);
    await h.selectItem("item-b", false);
    await h.save();
    assert.equal(await h.selection(h.workspaceB), JSON.stringify([h.idA]));
    assert.equal(await h.selection(h.workspaceA), JSON.stringify([h.idA]));
    await h.openRange();
    await h.click(h.adjustment(h.workspaceA));
    await h.waitForRequests();
    assert.equal(h.target().value, "project-a");
    assert.equal(h.previewCalls(), 2);
  } finally { await h.close(); }
});

test("an empty selection still clears only the selected project's sync scope", async () => {
  const h = await harness();
  try {
    await h.openRange();
    await h.click(h.adjustment(h.workspaceB));
    await h.waitForRequests();
    await h.selectItem("item-b", false);
    assert.equal(h.button("保存同步选择", h.preview()).disabled, false);
    await h.save();
    assert.equal(await h.selection(h.workspaceB), "[]");
    assert.equal(await h.selection(h.workspaceA), JSON.stringify([h.idA]));
  } finally { await h.close(); }
});

test("a completed preview still permits an explicit target change before saving", async () => {
  const h = await harness();
  try {
    await h.openRange();
    await h.click(h.adjustment(h.workspaceA));
    await h.waitForRequests();
    const select = h.target();
    assert.equal(select.disabled, false);
    await h.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
      assert.ok(setter);
      setter.call(select, "project-b");
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(h.target().value, "project-b");
    await h.save();
    assert.equal(await h.selection(h.workspaceB), JSON.stringify([h.idA]));
    assert.equal(await h.selection(h.workspaceA), JSON.stringify([h.idA]));
  } finally { await h.close(); }
});

test("a failed preview delivery releases busy and permits a normal B retry", async () => {
  const h = await harness();
  try {
    await h.openRange();
    const gate = h.holdPreview(new Error("fixture preview delivery failed"));
    await h.beginAdjustment(h.workspaceA, gate);
    await h.click(h.adjustment(h.workspaceB));
    await h.releasePreview(gate);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /fixture preview delivery failed/u);
    assert.equal(h.adjustment(h.workspaceB).disabled, false);
    await h.click(h.adjustment(h.workspaceB));
    await h.waitForRequests();
    assert.equal(h.previewCalls(), 2);
    assert.equal(h.target().value, "project-b");
    await h.save();
    assert.equal(await h.selection(h.workspaceB), JSON.stringify([h.idB]));
    assert.equal(await h.selection(h.workspaceA), JSON.stringify([h.idA]));
  } finally { await h.close(); }
});

test("an already-open sync-range dialog respects the outer disabled state", async () => {
  const h = await harness();
  try {
    await h.openRange();
    await h.render(true);
    await h.click(h.adjustment(h.workspaceB));
    await h.waitForRequests();
    assert.equal(h.previewCalls(), 0, "disabled adjustment cannot begin a preview or retarget the dialog");
    assert.equal(document.querySelector('[aria-labelledby="import-preview-title"]'), null);
    await h.render(false);
    await h.click(h.adjustment(h.workspaceA));
    await h.waitForRequests();
    assert.equal(h.target().value, "project-a");
    await h.save();
    assert.equal(await h.selection(h.workspaceB), JSON.stringify([h.idB]));
  } finally { await h.close(); }
});

test("closing a completed preview leaves both persisted selections untouched", async () => {
  const h = await harness();
  try {
    await h.openRange();
    await h.click(h.adjustment(h.workspaceA));
    await h.waitForRequests();
    const close = h.preview().querySelector<HTMLButtonElement>('[aria-label="关闭导入选择"]');
    assert.ok(close);
    await h.click(close);
    assert.equal(document.querySelector('[aria-labelledby="import-preview-title"]'), null);
    assert.equal(h.selectionCalls(), 0);
    assert.equal(await h.selection(h.workspaceA), JSON.stringify([h.idA]));
    assert.equal(await h.selection(h.workspaceB), JSON.stringify([h.idB]));
  } finally { await h.close(); }
});
