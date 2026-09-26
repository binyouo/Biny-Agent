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
  const actions = { browserRelaySetup: async () => ({ extensionPath: "/test" }), browserRelayDisconnect: async () => undefined };
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
