/** Provider polling keeps current permissions separate from cached history statistics. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityRuntimeSnapshot } from "../src/activity/types.js";

test("periodic runtime reads reuse statistics; explicit refresh and permission reads stay fresh", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let tick: (() => void) | undefined;
  let unsubscribed = false;
  let timerCleared = false;
  dom.window.setInterval = ((callback: () => void, ms: number) => {
    assert.equal(ms, 5_000); tick = callback; return 1;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = () => { timerCleared = true; };
  const reads: Array<boolean | undefined> = [];
  let permissionReads = 0;
  let granted = false;
  const runtime: ActivityRuntimeSnapshot = {
    state: "paused", collectorAvailable: true, screenRecordingGranted: false, accessibilityGranted: false,
    fallbackAvailable: false, screenLocked: false, sessions: 7, events: 4, fallbackCaptures: 2, storageBytes: 10, recentSessions: []
  };
  Object.defineProperty(dom.window, "biny", { value: {
    activitySnapshot: async (forceRefresh?: boolean) => { reads.push(forceRefresh); return runtime; },
    activityPermissions: async () => {
      permissionReads++;
      return { platform: "darwin", screenRecording: granted ? "granted" : "denied", accessibility: granted, openSettingsCapable: true };
    },
    onActivityEvent: () => () => { unsubscribed = true; }
  } });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createServer } = await import("vite");
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true, entries: [] } });
  const { ActivityRuntimeProvider, useActivityRuntime } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/ActivityRuntimeContext.tsx") as typeof import("../src/desktop/renderer/src/components/settings/ActivityRuntimeContext.js");
  function Consumer() {
    const value = useActivityRuntime();
    return createElement("button", { onClick: () => { void value.refresh(); } }, `${value.runtime?.sessions}:${value.permissions?.screenRecording}`);
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async (active: boolean) => await act(async () => {
    root.render(createElement(ActivityRuntimeProvider, { active }, createElement(Consumer)));
  });
  try {
    await render(true);
    assert.deepEqual(reads, [false], "initial read may reuse statistics already held by the service");
    assert.equal(permissionReads, 1);
    assert.equal(document.querySelector("button")?.textContent, "7:denied");
    granted = true;
    await act(async () => { assert.ok(tick); tick(); });
    await act(async () => { tick!(); });
    assert.deepEqual(reads, [false, false, false]);
    assert.equal(permissionReads, 3, "statistical TTL never caches system permission reads");
    assert.equal(document.querySelector("button")?.textContent, "7:granted");
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
    assert.deepEqual(reads, [false, false, false, true]);
    await render(false);
    assert.equal(unsubscribed, true);
    assert.equal(timerCleared, true);
    await render(true);
    assert.deepEqual(reads, [false, false, false, true], "reopening preserves the provider's available runtime");
    assert.equal(permissionReads, 4, "reopening still reads current system permissions");
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
