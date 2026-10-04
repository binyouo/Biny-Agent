import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsComputerUse } from "../src/desktop/renderer/src/components/settings/SettingsComputerUse.js";
import type { ComputerDesktopApi, ComputerStatus, ComputerDiagnostics } from "../src/computer/protocol.js";

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
    strict: async () => await api.diagnostics(), approve: async () => await api.diagnostics(), revoke: async () => await api.diagnostics(),
    status: async () => ({ ...state }),
    enable: async () => { controls.push("enable"); state = { ...state, state: "ready" }; return state; },
    control: async control => { controls.push(control); state = { ...state, state: control === "resume" ? "ready" : control === "pause" ? "paused" : control === "takeover" ? "taken-over" : "disabled" }; return state; },
    preview: async preview => { controls.push(`preview:${preview}`); state = { ...state, preview }; return state; },
    foreground: async foregroundAllowed => { state = { ...state, foregroundAllowed }; return state; },
    logging: async actionLogging => { state = { ...state, actionLogging }; return state; },
    diagnostics: async () => ({ workerPath: "/synthetic/worker.js", hostPath: "/synthetic/Biny", expectedVersion: "native", sdkLoaded: false, runtimeReady: false, strictApproval: false, permissions: { accessibility: "unknown", screenRecording: "unknown" }, approvals: [], audit: [] }),
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
    let finishTest!: (value: Awaited<ReturnType<ComputerDesktopApi["testSetup"]>>) => void;
    api.testSetup = () => new Promise(resolve => { finishTest = resolve; });
    await click("测试我的配置");
    assert.equal(dom.window.document.querySelector(".cu-feedback") === null, true, "pending configuration test must not report a result");
    await act(async () => { finishTest(await api.diagnostics()); });
    assert.ok(dom.window.document.querySelector(".cu-feedback"));
    const desktopControl = dom.window.document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="桌面控制"]')!;
    assert.ok(desktopControl, "desktop control enablement is directly visible");
    await act(async () => { desktopControl.click(); });
    await click("暂停"); await click("继续（需重新观察）"); await click("人工接管"); await click("继续（需重新观察）");
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
  const diagnostic: ComputerDiagnostics = { workerPath: "/synthetic/native/computer-use/biny-computer-use", hostPath: "/synthetic/Biny", expectedVersion: "native", sdkLoaded: false, runtimeReady: false, strictApproval: false, permissions: { accessibility: "unknown", screenRecording: "denied" }, approvals: [{ bundleId: "test.notes", appName: "Notes", useCount: 0 }], audit: [], actionLimits: [], error: "driver_sdk_missing_or_crashed: synthetic" };
  Object.assign(dom.window, { binyComputer: {
    strict: async (value: boolean) => { calls.push(`strict:${value}`); diagnostic.strictApproval = value; return diagnostic; },
    approve: async (bundleId: string) => { calls.push(`approve:${bundleId}`); diagnostic.approvals[0]!.approvedAt = new Date().toISOString(); return diagnostic; },
    revoke: async (bundleId: string) => { calls.push(`revoke:${bundleId}`); diagnostic.approvals[0]!.revokedAt = new Date().toISOString(); return diagnostic; },
    status: async () => state,
    enable: async () => state, control: async () => state, preview: async () => state, foreground: async () => state,
    diagnostics: async () => { calls.push("diagnostics"); return diagnostic; },
    requestAccessibility: async () => { calls.push("grant"); return diagnostic; },
    testSetup: async () => { calls.push("test"); return diagnostic; },
    logging: async (value: boolean) => { calls.push(`logging:${value}`); state = { ...state, actionLogging: value }; return state; }
  } });
  try {
    await act(async () => { root.render(createElement(SettingsComputerUse)); });
    assert.equal(dom.window.document.querySelectorAll(".cu-card").length, 1);
    assert.match(dom.window.document.querySelector('[data-permission="accessibility"]')?.textContent ?? "", /未知/);
    assert.match(dom.window.document.querySelector('[data-permission="screenRecording"]')?.textContent ?? "", /未授权/);
    assert.doesNotMatch(dom.window.document.querySelector(".cu-helper")?.textContent ?? "", /已就绪|运行中/);
    assert.equal(dom.window.document.querySelector('[data-action-limit="scroll"]'), null, "原生实现不再声明 scroll 限制");
    const details = dom.window.document.querySelector<HTMLDetailsElement>(".cu-technical-details")!;
    assert.ok(details, "technical diagnostics belong in a collapsed disclosure");
    assert.equal(details.open, false);
    assert.ok(details.querySelector("pre"));
    assert.doesNotMatch(dom.window.document.querySelector(".cu-helper")?.textContent ?? "", /synthetic|worker\.js/);
    assert.equal(dom.window.document.querySelector('[role="switch"][aria-label="逐次审批"]'), null);
    const strict = dom.window.document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="严格应用审批"]')!;
    assert.ok(strict); assert.equal(strict.disabled, false);
    await act(async () => { strict.click(); });
    assert.ok(calls.includes("strict:true"));
    assert.match(dom.window.document.querySelector('[data-app="test.notes"]')?.textContent ?? "", /待批准/);
    const approve = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "批准应用")!;
    await act(async () => { approve.click(); });
    assert.ok(calls.includes("approve:test.notes"));
    // 撤销要先过确认：Alma 的语义是不问就不动。
    const revoke = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "撤销授权")!;
    await act(async () => { revoke.click(); });
    assert.equal(calls.includes("revoke:test.notes"), false, "未确认前不得撤销");
    const confirmRevoke = [...dom.window.document.querySelectorAll("[data-confirm-revoke] button")].find(button => button.textContent === "确认撤销")!;
    await act(async () => { confirmRevoke.click(); });
    assert.ok(calls.includes("revoke:test.notes"));
    for (const label of ["授权辅助功能", "刷新", "测试我的配置", "记录操作日志"]) {
      const button = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent?.trim() === label || button.getAttribute("aria-label") === label)!;
      assert.ok(button, label); await act(async () => { button.click(); });
    }
    assert.ok(calls.includes("grant")); assert.ok(calls.includes("test")); assert.ok(calls.includes("logging:true"));
    assert.match(dom.window.document.querySelector("pre")?.textContent ?? "", /driver_sdk_missing_or_crashed/);
    assert.ok(dom.window.document.querySelector(".cu-approvals"));
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// Alma 在守不住「阻止应用抢前台」的守卫时会亮一张告警卡，并指出
// "通常意味着辅助功能权限需要重新授予——macOS 每次新构建都会重置它"。
test("focus guard failure surfaces a warning, and staying armed does not", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const base: ComputerDiagnostics = {
    workerPath: "/synthetic/native/computer-use", hostPath: "/synthetic/Biny", expectedVersion: "native",
    sdkLoaded: true, runtimeReady: true, strictApproval: false,
    permissions: { accessibility: "granted", screenRecording: "granted" }, approvals: [], audit: []
  };
  let diagnostic: ComputerDiagnostics = { ...base, focusGuard: "unavailable" };
  const status: ComputerStatus = { state: "ready", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  const api = {
    status: async () => status, enable: async () => status, control: async () => status,
    preview: async () => status, foreground: async () => status, logging: async () => status,
    diagnostics: async () => diagnostic, requestAccessibility: async () => diagnostic,
    testSetup: async () => diagnostic, strict: async () => diagnostic,
    approve: async () => diagnostic, revoke: async () => diagnostic
  } as unknown as ComputerDesktopApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    Object.assign(dom.window, { binyComputer: api });
    await act(async () => { root.render(createElement(SettingsComputerUse)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const warning = dom.window.document.querySelector('[data-focus-guard="unavailable"]');
    assert.ok(warning, "守卫未武装时必须亮出告警");
    assert.match(warning!.textContent ?? "", /重新授予/, "告警要给出可行的修法，而不是只说坏了");

    diagnostic = { ...base, focusGuard: "armed" };
    await act(async () => { root.render(createElement(SettingsComputerUse, { key: "armed" })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(dom.window.document.querySelector('[data-focus-guard="unavailable"]'), null, "守卫正常时不该有告警");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});

// 撤销授权不可逆：Alma 先弹确认（revokeTitle/revokeDesc1/revokeDesc2），
// 确认前不能真的调 revoke；说明里还要内联助手路径（desc1 + <code> + desc2）。
test("revoking asks first, and the helper path is shown inline", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const revoked: string[] = [];
  const diagnostic: ComputerDiagnostics = {
    workerPath: "/opt/biny/computer-use.app/Contents/MacOS/computer-use",
    helperPresent: true,
    hostPath: "/synthetic/Biny", expectedVersion: "native", sdkLoaded: true, runtimeReady: true,
    strictApproval: true,
    permissions: { accessibility: "granted", screenRecording: "granted" },
    approvals: [{ bundleId: "com.apple.TextEdit", appName: "文本编辑", useCount: 3, approvedAt: 1 }],
    audit: []
  };
  const status: ComputerStatus = { state: "ready", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  const api = {
    status: async () => status, enable: async () => status, control: async () => status,
    preview: async () => status, foreground: async () => status, logging: async () => status,
    diagnostics: async () => diagnostic, requestAccessibility: async () => diagnostic,
    testSetup: async () => diagnostic, strict: async () => diagnostic,
    approve: async () => diagnostic,
    revoke: async (bundleId: string) => { revoked.push(bundleId); return diagnostic; }
  } as unknown as ComputerDesktopApi;
  try {
    Object.assign(dom.window, { binyComputer: api });
    await act(async () => { root.render(createElement(SettingsComputerUse)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    // 说明里内联了助手路径
    const path = dom.window.document.querySelector(".cu-path");
    assert.equal(path?.textContent, diagnostic.workerPath, "说明里要给出真实助手路径，而不是笼统一句");

    const revokeButton = [...dom.window.document.querySelectorAll("button")].find(b => b.textContent === "撤销授权")!;
    await act(async () => { revokeButton.click(); });
    assert.equal(revoked.length, 0, "点撤销不能立刻生效");
    const confirm = dom.window.document.querySelector('[data-confirm-revoke="com.apple.TextEdit"]');
    assert.ok(confirm, "应当先弹出确认");
    assert.match(confirm!.textContent ?? "", /com\.apple\.TextEdit/, "确认里要写清是哪个应用");

    const cancel = [...confirm!.querySelectorAll("button")].find(b => b.textContent === "取消")!;
    await act(async () => { cancel.click(); });
    assert.equal(revoked.length, 0, "取消后不能撤销");
    assert.equal(dom.window.document.querySelector("[data-confirm-revoke]"), null, "取消后确认块要收起");

    await act(async () => { revokeButton.click(); });
    const confirmAgain = dom.window.document.querySelector("[data-confirm-revoke]")!;
    const confirmButton = [...confirmAgain.querySelectorAll("button")].find(b => b.textContent === "确认撤销")!;
    await act(async () => { confirmButton.click(); });
    assert.deepEqual(revoked, ["com.apple.TextEdit"], "只有确认后才真的撤销");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});

// 「文件不在」和「还没启动」要给不同的话，否则会把人指去重装一个已经装好的组件。
test("a present helper shows its path; only a missing one points at the build", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const status: ComputerStatus = { state: "disabled", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  let diagnostic = {
    workerPath: "/opt/biny/computer-use.app/Contents/MacOS/computer-use", helperPresent: true,
    hostPath: "/synthetic/Biny", expectedVersion: "native", sdkLoaded: false, runtimeReady: false,
    strictApproval: false, permissions: { accessibility: "unknown", screenRecording: "unknown" }, approvals: [], audit: []
  } as ComputerDiagnostics;
  const api = {
    status: async () => status, enable: async () => status, control: async () => status,
    preview: async () => status, foreground: async () => status, logging: async () => status,
    diagnostics: async () => diagnostic, requestAccessibility: async () => diagnostic,
    testSetup: async () => diagnostic, strict: async () => diagnostic,
    approve: async () => diagnostic, revoke: async () => diagnostic
  } as unknown as ComputerDesktopApi;
  try {
    Object.assign(dom.window, { binyComputer: api });
    await act(async () => { root.render(createElement(SettingsComputerUse)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    let path = dom.window.document.querySelector(".cu-path")?.textContent ?? "";
    assert.equal(path, diagnostic.workerPath, "组件已在磁盘上就该显示路径，而不是叫人去重建");
    assert.doesNotMatch(path, /build:activity-sidecar/);

    diagnostic = { ...diagnostic, helperPresent: false };
    await act(async () => { root.render(createElement(SettingsComputerUse, { key: "missing" })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    path = dom.window.document.querySelector(".cu-path")?.textContent ?? "";
    assert.match(path, /build:activity-sidecar/, "真的不在才给构建命令");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});
