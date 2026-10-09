import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsComputerUse } from "../src/desktop/renderer/src/components/settings/SettingsComputerUse.js";
import type { ComputerDesktopApi, ComputerStatus, ComputerDiagnostics } from "../src/computer/protocol.js";

test("compact settings keep controls and stop status polling while closed without losing their cached state", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const dom = new JSDOM("<div id='root'></div>");
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  let state: ComputerStatus = { state: "disabled", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  const controls: string[] = [];
  let statusReads = 0;
  const api: ComputerDesktopApi = {
    strict: async () => await api.diagnostics(), approve: async () => await api.diagnostics(), revoke: async () => await api.diagnostics(),
    status: async () => { statusReads++; return { ...state }; },
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
    assert.equal([...dom.window.document.querySelectorAll("button")].some(button => button.textContent === "停止"), false, "关闭主开关是唯一设置页停止入口，不重复提供停止按钮");
    assert.equal([...dom.window.document.querySelectorAll("button")].some(button => button.textContent === "刷新应用授权"), false, "全页刷新同时读取应用授权，不保留重复刷新入口");
    const advanced = dom.window.document.querySelector<HTMLDetailsElement>(".cu-controls")!;
    assert.equal(advanced.open, false);
    assert.equal(advanced.querySelector("details"), null, "高级设置不再嵌套第二层展开");
    await act(async () => { desktopControl.click(); });
    await click("暂停"); await click("继续（需重新观察）"); await click("人工接管"); await click("继续（需重新观察）");
    const checkbox = dom.window.document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="画中画"]')!;
    await act(async () => { checkbox.click(); }); await act(async () => { checkbox.click(); });
    await act(async () => { desktopControl.click(); });
    assert.deepEqual(controls, ["enable", "pause", "resume", "takeover", "resume", "preview:true", "preview:false", "stop"]);
    const beforeClose = statusReads;
    await act(async () => { root.render(createElement(SettingsComputerUse, { key: "ready", active: false })); });
    await act(async () => { context.mock.timers.tick(4500); });
    assert.equal(statusReads, beforeClose, "cached settings must not poll desktop control while closed");
    assert.equal(desktopControl.getAttribute("aria-checked"), "false");
    await act(async () => { root.render(createElement(SettingsComputerUse, { key: "ready", active: true })); });
    assert.equal(statusReads, beforeClose + 1);
    assert.ok(desktopControl === dom.window.document.querySelector('[role="switch"][aria-label="桌面控制"]'));
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    context.mock.timers.reset();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("Computer Use cards show independent unknown permissions and dispatch real diagnostic controls", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
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
    assert.equal(dom.window.document.querySelectorAll(".cu-card").length, 3, "权限与运行状态、控制偏好和应用授权各自成组，主开关独立置顶");
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
    const revoke = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "撤销授权")!;
    await act(async () => { revoke.click(); });
    assert.equal(calls.includes("revoke:test.notes"), false, "未确认前不得撤销");
    const confirmRevoke = [...dom.window.document.querySelectorAll("[data-confirm-revoke] button")].find(button => button.textContent === "确认撤销")!;
    await act(async () => { confirmRevoke.click(); });
    assert.ok(calls.includes("revoke:test.notes"));
    diagnostic.approvals.push({ bundleId: "test.new", appName: "New App", useCount: 0 });
    state = { ...state, state: "paused" };
    const refresh = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent?.trim() === "刷新")!;
    await act(async () => { refresh.click(); });
    assert.match(dom.window.document.querySelector('[data-app="test.new"]')?.textContent ?? "", /待批准/);
    assert.match(dom.window.document.querySelector(".cu-controls")?.textContent ?? "", /已暂停/, "统一刷新同时更新控制状态和新发现的应用授权");
    for (const label of ["授权辅助功能", "刷新", "测试我的配置", "记录操作日志"]) {
      const control = [...dom.window.document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[role="switch"]')].find(element => element.textContent?.trim() === label || element.getAttribute("aria-label") === label)!;
      assert.ok(control, label); await act(async () => { control.click(); });
    }
    assert.ok(calls.includes("grant")); assert.ok(calls.includes("test")); assert.ok(calls.includes("logging:true"));
    assert.match(dom.window.document.querySelector("pre")?.textContent ?? "", /driver_sdk_missing_or_crashed/);
    assert.ok(dom.window.document.querySelector(".cu-approvals"));
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("focus guard failure surfaces a warning, and staying armed does not", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
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

test("revoking still requires confirmation after private component paths move into collapsed diagnostics", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
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

    const path = dom.window.document.querySelector(".cu-path");
    assert.equal(path?.textContent, diagnostic.workerPath, "诊断区保留真实组件路径");
    assert.equal(Boolean(path?.closest(".cu-technical-details")), true, "组件路径不占用主要设置说明");
    assert.doesNotMatch(dom.window.document.querySelector(".cu-card > .cu-description")?.textContent ?? "", /\/opt\/|Contents|daemon/);

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
test("an installed idle helper stays installed instead of reporting unavailable; only a missing binary requires rebuilding", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
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
    assert.match(dom.window.document.querySelector(".cu-helper")?.textContent ?? "", /已安装/);
    assert.doesNotMatch(dom.window.document.querySelector(".cu-helper")?.textContent ?? "", /组件不可用/);
    const path = dom.window.document.querySelector(".cu-path")?.textContent ?? "";
    assert.equal(path, diagnostic.workerPath, "组件已在磁盘上就该显示路径，而不是叫人去重建");
    assert.doesNotMatch(path, /build:activity-sidecar/);

    diagnostic = { ...diagnostic, helperPresent: false };
    await act(async () => { root.render(createElement(SettingsComputerUse, { key: "missing" })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(dom.window.document.querySelector(".cu-helper")?.textContent ?? "", /未找到/);
    assert.match(dom.window.document.querySelector(".cu-technical-details")?.textContent ?? "", /pnpm build:activity-sidecar/, "组件确实缺失才在诊断区引导重建");
    assert.doesNotMatch(dom.window.document.querySelector(".cu-card > .cu-description")?.textContent ?? "", /pnpm build/);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});

// daemon 的 doctor 返回扁平字段（accessibility / screenRecording），
// 而不是嵌套的 permissions 对象。曾经按嵌套形状解析 → 每次 parse 都抛，
// helper 明明在跑也一律报「组件不可用」。这条钉住两边形状一致。
test("a live daemon reads as installed, not as an unavailable component", { skip: process.platform !== "darwin" || process.env.BINY_TEST_COMPUTER_UI !== "1" }, async () => {
  const { NativeProcessDriver } = await import("../src/computer/nativeDriver.js");
  const driver = new NativeProcessDriver(() => undefined, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const reply = await driver.diagnostics();
    const data = reply.data as Record<string, unknown>;
    // 服务端解析的就是这些键；少了任何一个都会让 parse 失败。
    assert.equal(typeof data.version, "string", "doctor 必须给出 version");
    assert.equal(typeof data.uptime, "number", "doctor 必须给出 uptime");
    assert.ok(["granted", "denied"].includes(data.accessibility as string), "doctor 必须给出扁平的 accessibility");
    assert.ok(["granted", "denied"].includes(data.screenRecording as string), "doctor 必须给出扁平的 screenRecording");
    assert.equal(typeof data.focusGuard, "string", "doctor 必须给出 focusGuard");
  } finally {
    await driver.dispose();
  }
});

// 「测试我的配置」的价值就在于指出**哪一项**没过。一句笼统的
// 「请完成组件安装与权限授权」把三项混在一起，等于把这个按钮废掉了。
test("the setup test names the check that failed, not just that one did", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  // daemon 活着、辅助功能给了、屏幕录制没给 —— 报告必须指名道姓。
  const diagnostic: ComputerDiagnostics = {
    workerPath: "/opt/biny/computer-use.app/Contents/MacOS/computer-use", helperPresent: true,
    hostPath: "/synthetic/Biny", expectedVersion: "native", sdkLoaded: true, runtimeReady: true,
    driverVersion: "native-1", uptimeSeconds: 42, focusGuard: "armed",
    strictApproval: false,
    permissions: { accessibility: "granted", screenRecording: "denied" },
    approvals: [], audit: []
  };
  const status: ComputerStatus = { state: "ready", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
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
    const test = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "测试我的配置")!;
    await act(async () => { test.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    const checks = [...dom.window.document.querySelectorAll(".cu-checkup li")];
    assert.equal(checks.length, 3, "三项检查都要报出来");
    const byName = new Map(checks.map(item => [item.getAttribute("data-check"), item]));
    assert.equal(byName.get("helper")?.getAttribute("data-ok"), "true");
    assert.match(byName.get("helper")?.textContent ?? "", /native-1/, "helper 一项要报出真实版本");
    assert.match(byName.get("helper")?.textContent ?? "", /42/, "helper 一项要报出运行时长");
    assert.equal(byName.get("accessibility")?.getAttribute("data-ok"), "true");
    // 唯一没过的那项必须被点名
    assert.equal(byName.get("screenRecording")?.getAttribute("data-ok"), "false");
    assert.match(byName.get("screenRecording")?.textContent ?? "", /✗/, "没过的项要有明确标记");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});

test("the advanced section wires the foreground switch and renders the audit trail", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const foregroundCalls: boolean[] = [];
  let status: ComputerStatus = { state: "ready", preview: false, foregroundAllowed: false, lastOutcome: "completed" };
  const diagnostic: ComputerDiagnostics = {
    workerPath: "/opt/biny/computer-use.app/Contents/MacOS/computer-use", helperPresent: true,
    hostPath: "/synthetic/Biny", expectedVersion: "native", sdkLoaded: true, runtimeReady: true,
    driverVersion: "native-1", uptimeSeconds: 7, focusGuard: "armed", strictApproval: false,
    permissions: { accessibility: "granted", screenRecording: "granted" }, approvals: [],
    audit: [
      { at: 1_700_000_000_000, action: "click", target: { pid: 671, windowId: "10104" }, outcome: "completed", durationMs: 42 },
      { at: 1_700_000_060_000, action: "type_text", target: { pid: 671, windowId: "10104" }, outcome: "unverified", durationMs: 130 }
    ]
  };
  const api = {
    status: async () => status, enable: async () => status,
    control: async () => status, preview: async () => status,
    foreground: async (value: boolean) => { foregroundCalls.push(value); status = { ...status, foregroundAllowed: value }; return status; },
    logging: async () => status, diagnostics: async () => diagnostic,
    requestAccessibility: async () => diagnostic, testSetup: async () => diagnostic,
    strict: async () => diagnostic, approve: async () => diagnostic, revoke: async () => diagnostic
  } as unknown as ComputerDesktopApi;
  try {
    Object.assign(dom.window, { binyComputer: api });
    await act(async () => { root.render(createElement(SettingsComputerUse)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    // 审计日志：每条要能看出时间、动作、目标与结果
    const trail = dom.window.document.querySelector(".cu-diagnostics")?.textContent ?? "";
    assert.match(trail, /click/, "审计要记下动作名");
    assert.match(trail, /671/, "审计要记下目标 pid");
    assert.match(trail, /42ms/, "审计要记下耗时");
    assert.match(trail, /type_text/, "第二条也要在");
    assert.match(dom.window.document.body.textContent ?? "", /日志共 2 条/, "条数要如实报出");

    // 前台动作开关：这是唯一允许动作改变用户焦点的开关，必须真的送达
    const toggle = dom.window.document.querySelector<HTMLInputElement>(".cu-foreground input")!;
    assert.ok(toggle, "前台动作开关要在");
    assert.equal(toggle.checked, false, "默认不放开前台动作");
    await act(async () => { toggle.click(); });
    assert.deepEqual(foregroundCalls, [true], "点一下要真的把开关送出去");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});
