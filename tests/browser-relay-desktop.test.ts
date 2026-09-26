/** 主进程装配回归；Electron 剪贴板为外部边界 fake，不执行界面自动化。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requestBrowserRelay } from "../src/browser/relayClient.js";

test("Desktop serializes startup, copies pairing only to clipboard and revokes it", async () => {
  let clipboard = "";
  Object.assign(globalThis, { __relayElectron: { clipboard: { writeText(value: string) { clipboard = value; } } } });
  const hooks = registerHooks({ load(url, context, next) { return /\/electron\/index\.js$/.test(url) ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__relayElectron;", shortCircuit: true } : next(url, context); } });
  let browser: { dispose(): Promise<void> } | undefined;
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const service = new DesktopBrowserService(async () => "/unused"); browser = service;
    await Promise.all([service.startRelay(), service.startRelay()]);
    assert.equal(service.relayStatus().running, true);
    const setup = await service.setupRelay();
    assert.match(clipboard, /^ws:\/\/127\.0\.0\.1:\d+\/relay\?token=[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(setup), ["extensionPath"]);
    assert.equal(JSON.parse(await readFile(path.join(setup.extensionPath, "manifest.json"), "utf8")).manifest_version, 3);
    const oldAddress = clipboard;
    await service.disconnectRelay();
    await service.setupRelay();
    assert.notEqual(clipboard, oldAddress);
    assert.deepEqual(await requestBrowserRelay("status"), { running: true, connected: false, browsers: [] });
  } finally { await browser?.dispose(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__relayElectron"); }
});
