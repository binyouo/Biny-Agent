/** React 状态契约使用 IPC fake；不点击真实界面，视觉与交互仍待人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("Chrome 设置进入即读状态，未连接、未启动和桥接故障各自明确呈现", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>");
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { SettingsBrowser } = await import("../src/desktop/renderer/src/components/settings/SettingsBrowser.js");
  const root = createRoot(document.getElementById("root")!);
  const { act, createElement } = React;
  const actions = { browserRelaySetup: async () => ({ extensionPath: "/test" }), browserRelayDisconnect: async () => undefined,
    browserRelayInstall: async () => ({ extensionPath: "/test" }), browserRelayOpenChrome: async () => undefined };
  const render = async (key: string, api: unknown): Promise<string> => {
    Object.assign(dom.window, { biny: api });
    await act(async () => { root.render(createElement(SettingsBrowser, { key })); });
    return document.body.textContent ?? "";
  };
  try {
    let content = await render("disconnected", { ...actions, browserRelayStatus: async () => ({ running: true, connected: false, browsers: [] }) });
    assert.match(content, /Chrome 扩展未连接/);
    assert.doesNotMatch(content, /正在读取连接状态/);
    assert.ok(document.querySelector('button.settings-secondary-button'), "配对按钮复用设置页的可见控件样式");
    content = await render("stopped", { ...actions, browserRelayStatus: async () => ({ running: false, connected: false, browsers: [] }) });
    assert.match(content, /连接服务未启动/);
    content = await render("connected", { ...actions, browserRelayStatus: async () => ({ running: true, connected: true, browsers: [{ browserId: "00000000-0000-4000-8000-000000000000", browserName: "工作 Chrome" }] }) });
    assert.match(content, /工作 Chrome.*已连接/);
    content = await render("missing", {});
    assert.match(content, /完全退出.*重新启动 Biny/);
    assert.doesNotMatch(content, /正在读取连接状态/);
    content = await render("failed", { ...actions, browserRelayStatus: async () => { throw new Error("bridge failed"); } });
    assert.match(content, /无法读取连接状态/);
    assert.doesNotMatch(content, /正在读取连接状态/);
    assert.ok(document.querySelector('[role="alert"]'));
    assert.ok([...document.querySelectorAll('button')].some((button) => button.textContent === "重试"));
    content = await render("old-main", { ...actions, browserRelayStatus: async () => { throw new Error("No handler registered for desktop:browser:relay-status"); } });
    assert.match(content, /完全退出.*重新启动 Biny/);
    assert.ok([...document.querySelectorAll('button')].find((button) => button.textContent?.includes("复制配对地址"))?.disabled);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    content = await render("timeout", { ...actions, browserRelayStatus: () => new Promise(() => {}) });
    assert.match(content, /正在读取连接状态/);
    await act(async () => { t.mock.timers.tick(5000); });
    assert.match(document.body.textContent ?? "", /无法读取连接状态/);
    assert.doesNotMatch(document.body.textContent ?? "", /正在读取连接状态/);
  } finally {
    await act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function guideHarness(api: Record<string, unknown> = {}) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>");
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const state = { running: true, connected: false, browsers: [] as Array<{ browserId: string; browserName: string }> };
  Object.assign(dom.window, { biny: {
    browserRelayStatus: async () => ({ ...state }), browserRelaySetup: async () => ({ extensionPath: "/test/extension" }),
    browserRelayDisconnect: async () => undefined, browserRelayInstall: async () => ({ extensionPath: "/test/extension" }),
    browserRelayOpenChrome: async () => undefined, ...api
  } });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { SettingsBrowser } = await import("../src/desktop/renderer/src/components/settings/SettingsBrowser.js");
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(SettingsBrowser)));
  const button = (label: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
    assert.ok(result, `缺少操作：${label}`); return result;
  };
  return { dom, React, state, button,
    async invoke(label: string) { await React.act(async () => button(label).click()); },
    async close() {
      await React.act(() => root.unmount()); dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

test("未配对时安装、配对与检查连接直接可用，不显示静态功能介绍卡", async () => {
  const h = await guideHarness();
  try {
    for (const label of ["打开扩展目录", "打开 Chrome 扩展管理", "复制配对地址", "刷新状态"]) {
      assert.equal(h.button(label).disabled, false);
      assert.equal(h.button(label).closest("details"), null, "首次安装操作直接展示");
    }
    assert.match(document.body.textContent ?? "", /开发者模式.*加载已解压的扩展程序/s);
    assert.match(document.body.textContent ?? "", /保存并连接/);
    assert.doesNotMatch(document.body.textContent ?? "", /内置浏览器|已附加标签页|暂无标签/);
  } finally { await h.close(); }
});

test("安装与打开 Chrome 不复制凭据，失败保留指南且可重试，不误报已连接", async () => {
  let installs = 0, opens = 0, pairs = 0;
  const h = await guideHarness({
    browserRelayInstall: async () => { if (++installs === 1) throw new Error("扩展目录无法打开"); return { extensionPath: "/test/extension" }; },
    browserRelayOpenChrome: async () => { opens++; }, browserRelaySetup: async () => { pairs++; return { extensionPath: "/test/extension" }; }
  });
  try {
    await h.invoke("打开扩展目录");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /扩展目录无法打开/);
    assert.match(document.body.textContent ?? "", /开发者模式/);
    await h.invoke("打开扩展目录");
    assert.match(document.body.textContent ?? "", /\/test\/extension/);
    assert.equal(document.querySelector('[role="alert"]'), null);
    await h.invoke("打开 Chrome 扩展管理");
    assert.equal(opens, 1); assert.equal(installs, 2); assert.equal(pairs, 0);
    assert.match(document.body.textContent ?? "", /Chrome 扩展未连接/);
    assert.doesNotMatch(document.body.textContent ?? "", /已连接/);
  } finally { await h.close(); }
});

test("配对不撤销现有连接，重新生成和撤销需确认，重复操作不重复派发", async () => {
  const resets: boolean[] = [];
  let disconnects = 0;
  let finish: (() => void) | undefined;
  const h = await guideHarness({
    browserRelaySetup: async (reset = false) => {
      resets.push(reset); if (!reset) await new Promise<void>(resolve => { finish = resolve; });
      return { extensionPath: "/test/extension" };
    }, browserRelayDisconnect: async () => { disconnects++; }
  });
  try {
    await h.invoke("复制配对地址");
    assert.equal(h.button("打开扩展目录").disabled, true);
    assert.equal(h.button("重新生成配对地址").disabled, true);
    await h.invoke("复制中…");
    assert.deepEqual(resets, [false]);
    await h.React.act(async () => finish?.());
    assert.match(document.body.textContent ?? "", /配对地址已复制/);
    assert.equal(disconnects, 0);
    await h.invoke("重新生成配对地址");
    assert.match(document.body.textContent ?? "", /旧配对地址.*失效/);
    await h.invoke("取消");
    assert.deepEqual(resets, [false]);
    await h.invoke("重新生成配对地址");
    await h.invoke("确认并复制新地址");
    assert.deepEqual(resets, [false, true]);
    await h.invoke("撤销全部连接");
    assert.equal(disconnects, 0);
    await h.invoke("确认撤销");
    assert.equal(disconnects, 1);
  } finally { finish?.(); await h.close(); }
});

test("操作中的旧状态响应被丢弃，刷新仅按真实连接结果完成引导", async () => {
  let finishOldRead: ((value: unknown) => void) | undefined;
  let reads = 0;
  const h = await guideHarness({ browserRelayStatus: async () => {
    if (++reads === 1) return new Promise(resolve => { finishOldRead = resolve; });
    return { running: true, connected: true, browsers: [{ browserId: "work", browserName: "工作 Chrome" }] };
  } });
  try {
    await h.invoke("打开扩展目录");
    assert.match(document.body.textContent ?? "", /工作 Chrome.*已连接/);
    await h.React.act(async () => finishOldRead?.({ running: true, connected: false, browsers: [] }));
    assert.doesNotMatch(document.body.textContent ?? "", /Chrome 扩展未连接/);
    assert.ok(h.button("打开扩展目录").closest("details"), "已连接后安装操作按需展开");
    await h.invoke("刷新状态");
    assert.ok(reads >= 3);
    assert.match(document.body.textContent ?? "", /工作 Chrome.*已连接/);
  } finally { await h.close(); }
});
