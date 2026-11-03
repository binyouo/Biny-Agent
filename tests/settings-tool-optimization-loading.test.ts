import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopToolOptimizationStats } from "../src/desktop/protocol.js";

registerHooks({ load(url, context, next) {
  if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
} });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function panel() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://desktop.local" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, React, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const requests: ReturnType<typeof deferred<DesktopToolOptimizationStats>>[] = [];
  const argumentsList: unknown[][] = [];
  Object.assign(window, { biny: { toolOptimizationStats: (...args: unknown[]) => {
    argumentsList.push(args);
    const request = deferred<DesktopToolOptimizationStats>(); requests.push(request); return request.promise;
  } } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsToolOptimization } = await import("../src/desktop/renderer/src/components/settings/SettingsToolOptimization.js");
  const root = createRoot(document.getElementById("root")!);
  return {
    requests,
    argumentsList,
    render: async (show = true) => { await React.act(async () => root.render(show
      ? React.createElement(React.StrictMode, {}, React.createElement(SettingsToolOptimization)) : null)); },
    settle: async (action: () => void) => { await React.act(action); },
    refresh: async () => { await React.act(async () => {
      const button = [...document.querySelectorAll("button")].find(item => /重试/u.test(item.textContent ?? ""));
      assert.ok(button); button.click();
    }); },
    invalidate: async () => { await React.act(async () => {
      const { invalidateToolOptimizationStats } = await import("../src/desktop/renderer/src/components/settings/toolOptimizationState.js");
      invalidateToolOptimizationStats(window.biny);
    }); },
    async close() {
      await React.act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

// Fixtures describe the IPC boundary; values are independently checked against the visible metrics.
function statistics(savedTokens = 700): DesktopToolOptimizationStats {
  const empty = { runs: 0, beforeTokens: 0, afterTokens: 0, savedTokens: 0, ptcTokens: 0, rtkTokens: 0 };
  return { ptc: { runs: 1, beforeTokens: 800, afterTokens: 800 - savedTokens, savedTokens, ptcTokens: savedTokens, rtkTokens: 0 },
    rtk: empty, toolCalls: 2, average: 0, durationCount: 0, totalDurationMs: 0,
    daily: [], commands: [], recent: [], incompleteSessions: 0 };
}

test("statistics survive page remounts, deduplicate reads and keep the snapshot during background refresh", async context => {
  let now = 1_000;
  context.mock.method(Date, "now", () => now);
  const h = await panel();
  try {
    await h.render();
    assert.equal(h.requests.length, 1, "StrictMode shares the in-flight read");
    assert.deepEqual(h.argumentsList[0], ["all"]);
    assert.match(document.body.textContent ?? "", /编程式工具调用/u);
    assert.equal(document.querySelector(".savings-loading"), null);
    assert.deepEqual([...document.querySelectorAll('.savings-metric strong')].map(node => node.textContent), ["—", "—", "—", "—"]);
    assert.doesNotMatch(document.body.textContent ?? "", /暂无节省数据/u);
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 1, "returning during a read must reuse that request");
    await h.settle(() => h.requests[0]!.resolve(statistics()));
    assert.match(document.body.textContent ?? "", /700/u);
    assert.ok(![...document.querySelectorAll("button")].some(button => button.textContent === "刷新"), "statistics update automatically without a manual refresh action");
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 1, "recently read cumulative statistics need no second query");
    window.dispatchEvent(new window.Event("focus"));
    assert.equal(h.requests.length, 1);
    now += 10_001;
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 1, "reentering the page alone does not require a fresh scan");
    await h.invalidate();
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.argumentsList[1], ["all", undefined, undefined, true]);
    assert.match(document.body.textContent ?? "", /700/u);
    assert.equal(document.querySelector(".savings-loading"), null);
    await h.settle(() => h.requests[1]!.reject(new Error("statistics offline")));
    assert.match(document.body.textContent ?? "", /700/u);
    assert.match(document.body.textContent ?? "", /更新失败.*statistics offline/u);
    await h.refresh();
    assert.equal(h.requests.length, 3, "a failed background update remains retryable");
    await h.settle(() => h.requests[2]!.resolve(statistics(750)));
    assert.match(document.body.textContent ?? "", /750/u);
    assert.doesNotMatch(document.body.textContent ?? "", /statistics offline/u);
  } finally { await h.close(); }
});

test("a fresh window does not reuse another window's snapshot and initial read failures remain retryable", async () => {
  const h = await panel();
  try {
    await h.render();
    assert.match(document.body.textContent ?? "", /编程式工具调用/u);
    assert.equal(document.querySelector(".savings-loading"), null);
    await h.settle(() => h.requests[0]!.reject(new Error("first read failed")));
    assert.match(document.body.textContent ?? "", /统计读取失败.*first read failed/u);
    await h.refresh();
    assert.equal(h.requests.length, 2);
    await h.settle(() => h.requests[1]!.resolve(statistics()));
    assert.match(document.body.textContent ?? "", /700/u);
  } finally { await h.close(); }
});

test("persisted statistics are visible before background reconciliation completes", async () => {
  const h = await panel();
  try {
    await h.render();
    await h.settle(() => h.requests[0]!.resolve({ ...statistics(600), stale: true }));
    assert.match(document.body.textContent ?? "", /600/u);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.argumentsList[1], ["all", undefined, undefined, true]);
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 2, "reentry shares the background refresh");
    await h.settle(() => h.requests[1]!.reject(new Error("reconcile failed")));
    assert.match(document.body.textContent ?? "", /600/u);
    assert.match(document.body.textContent ?? "", /更新失败.*reconcile failed/u);
    await h.refresh();
    await h.settle(() => h.requests[2]!.resolve(statistics(900)));
    assert.match(document.body.textContent ?? "", /900/u);
  } finally { await h.close(); }
});

test("hidden statistics defer invalidation and changes during a read receive one follow-up update", async () => {
  const h = await panel();
  try {
    await h.render();
    await h.settle(() => h.requests[0]!.resolve(statistics()));
    await h.render(false);
    await h.invalidate(); await h.invalidate();
    assert.equal(h.requests.length, 1, "hidden pages do not start history scans");
    await h.render();
    assert.equal(h.requests.length, 2);
    assert.match(document.body.textContent ?? "", /700/u);
    await h.invalidate(); await h.invalidate();
    assert.equal(h.requests.length, 2, "an existing scan is not duplicated");
    await h.settle(() => h.requests[1]!.resolve(statistics(800)));
    assert.equal(h.requests.length, 3, "changes arriving during the read cannot be lost");
    await h.settle(() => h.requests[2]!.resolve(statistics(900)));
    assert.match(document.body.textContent ?? "", /900/u);
    assert.equal(document.querySelectorAll('button').length, 0);
  } finally { await h.close(); }
});

test("external-history reconciliation is infrequent and never clears the visible snapshot", async context => {
  let now = 1_000;
  context.mock.method(Date, "now", () => now);
  const h = await panel();
  try {
    await h.render();
    await h.settle(() => h.requests[0]!.resolve(statistics()));
    for (const elapsed of [10_001, 60_000, 120_000]) {
      now += elapsed;
      await h.render(false); await h.render();
      assert.equal(h.requests.length, 1);
    }
    now += 300_001;
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 2);
    assert.match(document.body.textContent ?? "", /700/u);
    await h.settle(() => h.requests[1]!.resolve(statistics(800)));
    assert.match(document.body.textContent ?? "", /800/u);
  } finally { await h.close(); }
});
