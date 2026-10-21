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
  Object.assign(window, { biny: { toolOptimizationStats: (...args: unknown[]) => {
    assert.deepEqual(args, ["all"]);
    const request = deferred<DesktopToolOptimizationStats>(); requests.push(request); return request.promise;
  } } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsToolOptimization } = await import("../src/desktop/renderer/src/components/settings/SettingsToolOptimization.js");
  const root = createRoot(document.getElementById("root")!);
  return {
    requests,
    render: async (show = true) => { await React.act(async () => root.render(show
      ? React.createElement(React.StrictMode, {}, React.createElement(SettingsToolOptimization)) : null)); },
    settle: async (action: () => void) => { await React.act(action); },
    refresh: async () => { await React.act(async () => {
      const button = [...document.querySelectorAll("button")].find(item => /刷新|重试/u.test(item.textContent ?? ""));
      assert.ok(button); button.click();
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
    assert.match(document.body.textContent ?? "", /加载中/u);
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 1, "returning during a read must reuse that request");
    await h.settle(() => h.requests[0]!.resolve(statistics()));
    assert.match(document.body.textContent ?? "", /700/u);
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 1, "recently read cumulative statistics need no second query");
    window.dispatchEvent(new window.Event("focus"));
    assert.equal(h.requests.length, 1);
    now += 10_001;
    await h.render(false); await h.render();
    assert.equal(h.requests.length, 2);
    assert.match(document.body.textContent ?? "", /700/u);
    assert.equal(document.querySelector(".savings-loading"), null);
    await h.settle(() => h.requests[1]!.reject(new Error("statistics offline")));
    assert.match(document.body.textContent ?? "", /700/u);
    assert.match(document.body.textContent ?? "", /刷新失败.*statistics offline/u);
    await h.refresh(); await h.refresh();
    assert.equal(h.requests.length, 3, "explicit refresh bypasses the interval but still shares pending work");
    await h.settle(() => h.requests[2]!.resolve(statistics(750)));
    assert.match(document.body.textContent ?? "", /750/u);
    assert.doesNotMatch(document.body.textContent ?? "", /statistics offline/u);
  } finally { await h.close(); }
});

test("a fresh window does not reuse another window's snapshot and initial read failures remain retryable", async () => {
  const h = await panel();
  try {
    await h.render();
    assert.match(document.body.textContent ?? "", /加载中/u);
    await h.settle(() => h.requests[0]!.reject(new Error("first read failed")));
    assert.match(document.body.textContent ?? "", /统计读取失败.*first read failed/u);
    await h.refresh();
    assert.equal(h.requests.length, 2);
    await h.settle(() => h.requests[1]!.resolve(statistics()));
    assert.match(document.body.textContent ?? "", /700/u);
  } finally { await h.close(); }
});
