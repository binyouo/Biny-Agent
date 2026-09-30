import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsComputerUse } from "../src/desktop/renderer/src/components/settings/SettingsComputerUse.js";
import type { ComputerDesktopApi, ComputerStatus } from "../src/computer/protocol.js";

test("desktop settings handle missing bridge and expose enable, pause/takeover/stop and PiP controls", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  let state: ComputerStatus = { state: "disabled", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  const controls: string[] = [];
  const api: ComputerDesktopApi = {
    status: async () => ({ ...state }),
    enable: async () => { controls.push("enable"); state = { ...state, state: "ready" }; return state; },
    control: async control => { controls.push(control); state = { ...state, state: control === "resume" ? "ready" : control === "pause" ? "paused" : control === "takeover" ? "taken-over" : "disabled" }; return state; },
    preview: async preview => { controls.push(`preview:${preview}`); state = { ...state, preview }; return state; },
    foreground: async foregroundAllowed => { state = { ...state, foregroundAllowed }; return state; },
    logging: async actionLogging => { state = { ...state, actionLogging }; return state; },
    diagnostics: async () => ({ workerPath: "/synthetic/worker.js", hostPath: "/synthetic/Biny", expectedVersion: "0.30.4", sdkLoaded: false, runtimeReady: false, permissions: { accessibility: "unknown", screenRecording: "unknown" }, approvals: [], audit: [] }),
    requestAccessibility: async () => api.diagnostics(),
    testSetup: async () => api.diagnostics()
  };
  try {
    await act(async () => { root.render(createElement(SettingsComputerUse, { key: "missing" })); });
    assert.match(dom.window.document.body.textContent ?? "", /完全退出并重新启动 Biny/);
    assert.equal([...dom.window.document.querySelectorAll("button,input")].every(element => "disabled" in element && element.disabled), true);
    Object.assign(dom.window, { binyComputer: api });
    await act(async () => { root.render(createElement(SettingsComputerUse, { key: "ready" })); });
    const click = async (label: string): Promise<void> => {
      const button = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === label)!;
      assert.equal(button.disabled, false); await act(async () => { button.click(); });
    };
    await click("启用桌面控制"); await click("暂停"); await click("继续（需重新观察）"); await click("人工接管"); await click("继续（需重新观察）");
    const checkbox = dom.window.document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="画中画"]')!;
    await act(async () => { checkbox.click(); }); await act(async () => { checkbox.click(); });
    await click("停止");
    assert.deepEqual(controls, ["enable", "pause", "resume", "takeover", "resume", "preview:true", "preview:false", "stop"]);
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("Computer Use cards show independent unknown permissions and dispatch real diagnostic controls", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const calls: string[] = [];
  let state: ComputerStatus = { state: "disabled", preview: false, foregroundAllowed: false, actionLogging: false, lastOutcome: "not-dispatched" };
  const diagnostic = { workerPath: "/synthetic/app.asar.unpacked/out/main/cuaWorker.js", hostPath: "/synthetic/Biny", expectedVersion: "0.30.4", sdkLoaded: false, runtimeReady: false, permissions: { accessibility: "unknown", screenRecording: "denied" }, approvals: [], audit: [], actionLimits: [{ action: "scroll", code: "scroll_direction_unverified", message: "当前 macOS 滚动暂不可用；请人工滚动后重新观察。" }], error: "driver_sdk_missing_or_crashed: synthetic" };
  Object.assign(dom.window, { binyComputer: {
    status: async () => state,
    enable: async () => state, control: async () => state, preview: async () => state, foreground: async () => state,
    diagnostics: async () => { calls.push("diagnostics"); return diagnostic; },
    requestAccessibility: async () => { calls.push("grant"); return diagnostic; },
    testSetup: async () => { calls.push("test"); return diagnostic; },
    logging: async (value: boolean) => { calls.push(`logging:${value}`); state = { ...state, actionLogging: value }; return state; }
  } });
  try {
    await act(async () => { root.render(createElement(SettingsComputerUse)); });
    assert.equal(dom.window.document.querySelectorAll(".cu-card").length, 2);
    assert.match(dom.window.document.querySelector('[data-permission="accessibility"]')?.textContent ?? "", /未知/);
    assert.match(dom.window.document.querySelector('[data-permission="screenRecording"]')?.textContent ?? "", /未授权/);
    assert.doesNotMatch(dom.window.document.querySelector(".cu-helper")?.textContent ?? "", /已就绪|运行中/);
    assert.match(dom.window.document.querySelector('[data-action-limit="scroll"]')?.textContent ?? "", /滚动暂不可用/);
    const strict = dom.window.document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="按应用严格审批"]')!;
    assert.equal(strict.disabled, true); assert.equal(strict.getAttribute("aria-checked"), "true");
    for (const label of ["触发 AX 授权弹窗", "刷新", "测试我的配置", "记录操作日志"]) {
      const button = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent?.trim() === label || button.getAttribute("aria-label") === label)!;
      assert.ok(button, label); await act(async () => { button.click(); });
    }
    assert.ok(calls.includes("grant")); assert.ok(calls.includes("test")); assert.ok(calls.includes("logging:true"));
    assert.match(dom.window.document.querySelector("pre")?.textContent ?? "", /driver_sdk_missing_or_crashed/);
    assert.match(dom.window.document.querySelector(".cu-approvals")?.textContent ?? "", /已批准的应用.*0/);
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
