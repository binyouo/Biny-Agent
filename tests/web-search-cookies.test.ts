/** Electron 边界替身验证剪贴板操作与域名隔离，不运行界面自动化。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("导入、导出和清除仅影响小红书 Cookie，拒绝其他域名", async () => {
  let text = JSON.stringify([{ domain: ".xiaohongshu.com", name: "session", value: "test-cookie", path: "/", secure: true }]);
  const partitions = new Map<string, Array<Record<string, unknown>>>();
  const fake = { BrowserWindow: class {}, WebContentsView: class {}, clipboard: { readText: () => text, writeText: (value: string) => { text = value; } }, session: { fromPartition: (id: string) => {
    const cookies = partitions.get(id) ?? []; partitions.set(id, cookies);
    return { cookies: { get: async () => [...cookies], set: async (value: Record<string, unknown>) => { cookies.push(value); }, remove: async (_url: string, name: string) => { const index = cookies.findIndex((item) => item.name === name); if (index >= 0) cookies.splice(index, 1); } } };
  } } };
  Object.assign(globalThis, { __webCookieElectron: fake });
  const hooks = registerHooks({ load(url, context, next) { return /\/electron\/index\.js$/.test(url) ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session,dialog}=globalThis.__webCookieElectron;", shortCircuit: true } : next(url, context); } });
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const browser = new DesktopBrowserService(async () => "/unused");
    const imported = await browser.importXiaohongshuCookies();
    assert.equal(imported.total, 1);
    await browser.exportXiaohongshuCookies();
    assert.equal(JSON.parse(text)[0].name, "session");
    text = JSON.stringify([{ domain: ".example.com", name: "other", value: "secret", path: "/" }]);
    await assert.rejects(browser.importXiaohongshuCookies(), /小红书/);
    assert.equal((await browser.xiaohongshuCookieStatus()).total, 1);
    assert.equal((await browser.clearXiaohongshuCookies()).total, 0);
    assert.equal(partitions.has("persist:biny-browser"), false);
  } finally { hooks.deregister(); }
});
