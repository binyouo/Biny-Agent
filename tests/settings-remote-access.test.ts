import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { RemoteAccessStatus } from "../src/remote/access.js";
import { settingsPageNeedsSnapshot } from "../src/desktop/renderer/src/components/settings/settingsData.js";

test("remote settings load independently and display only current registered pairing with copy and revoke actions", async () => {
  const hooks = registerHooks({ load(url, context, next) { return url.endsWith("/remote-access.css") ? { format: "module", shortCircuit: true, source: "export {};" } : next(url, context); } });
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let status: RemoteAccessStatus = { state: "connecting", relay: "https://relay.example.test", connections: 0 };
  const listeners = new Set<() => void>();
  let copied = "", stopped = 0;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (value: string) => { copied = value; } } });
  Object.assign(dom.window, { biny: {
    remoteAccessStatus: async () => ({ ...status }),
    onRemoteAccessChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    remoteAccessStop: async () => { stopped++; status = { state: "disabled", connections: 0 }; return status; },
    remoteAccessRegenerate: async () => { status = { ...status, state: "connecting", pairingUrl: undefined }; return status; }
  } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsRemoteAccess } = await import("../src/desktop/renderer/src/components/settings/SettingsRemoteAccess.js");
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string) => { const found = [...document.querySelectorAll("button")].find(item => item.textContent === label); assert.ok(found, label); return found; };
  const render = async (active: boolean) => { await React.act(async () => root.render(React.createElement(SettingsRemoteAccess, { active }))); };
  try {
    assert.equal(settingsPageNeedsSnapshot("远程访问"), false);
    await render(true);
    assert.equal(document.querySelector("img"), null);
    assert.match(document.body.textContent!, /正在连接中继/u);
    assert.match(document.body.textContent!, /iOS 客户端尚未发布/u);
    const link = "biny://connect?v=1&e2e=1&u=https%3A%2F%2Frelay.example.test&k=test-code";
    status = { ...status, state: "connected", pairingUrl: link, connections: 1 };
    await React.act(async () => { for (const listener of listeners) listener(); });
    assert.match(document.querySelector("img")?.getAttribute("src") ?? "", /^data:image\/svg\+xml/u);
    assert.match(document.body.textContent!, /1 台设备在线/u);
    await React.act(async () => button("复制配对链接").click());
    assert.equal(copied, link);
    await React.act(async () => button("重新生成").click());
    assert.equal(document.querySelector("img"), null, "old pairing is removed while a new registration is pending");
    await React.act(async () => button("关闭远程访问").click());
    assert.equal(stopped, 1);
    assert.match(document.body.textContent!, /未开启/u);
    assert.equal(document.querySelector("img"), null);
    await render(false);
    assert.equal(listeners.size, 0, "closed settings stop subscribing");
    await render(true);
    assert.equal(listeners.size, 1);
  } finally {
    await React.act(() => root.unmount()); dom.window.close(); hooks.deregister();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
