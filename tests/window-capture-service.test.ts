import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import { windowCaptureIpc } from "../src/desktop/windowCapture.js";

test("window capture scopes pixels, hides private titles, restores the surface, and rejects untrusted senders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-capture-test-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  Object.assign(globalThis, { __captureElectron: {
    BrowserWindow: class {}, clipboard: {}, dialog: {}, nativeImage: { createFromDataURL: (data: string) => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 1000 }), toPNG: () => Buffer.from(data.split(",")[1]!, "base64") }) },
    ipcMain: { handle: (name: string, action: (...args: any[]) => any) => handlers.set(name, action), removeHandler: (name: string) => handlers.delete(name) }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    if (/\/electron\/index\.js$/.test(url)) return { format: "module", shortCircuit: true, source: "export const {BrowserWindow,clipboard,dialog,ipcMain,nativeImage}=globalThis.__captureElectron;" };
    return next(url, context);
  } });
  const dom = new JSDOM('<div class="biny-sidebar-session-title">private title</div><div class="biny-project-row-label">Sample project</div><div id="history">737 · 485.37 MB · Google Chrome</div><div class="biny-inspector-rail-zone"><button style="visibility:visible">tools</button></div><div class="biny-chat-scroll"></div><dialog class="desktop-settings-dialog" open><main class="settings-content"></main></dialog>', { runScripts: "outside-only", pretendToBeVisual: true });
  const browser = dom.window;
  browser.document.querySelector('.settings-content')!.append(browser.document.querySelector('.biny-sidebar-session-title')!);
  const bounds = { x: 220, y: 60, width: 640, height: 500 };
  browser.document.querySelector('.settings-content')!.getBoundingClientRect = () => bounds as DOMRect;
  browser.document.querySelector('.biny-sidebar-session-title')!.getBoundingClientRect = () => ({ x:240, y:100, width:100, height:20 }) as DOMRect;
  class CapturedImage { naturalWidth = 1280; naturalHeight = 1000; src = ''; async decode() {} }
  Object.assign(browser, { Image: CapturedImage });
  let opaqueMask = false;
  browser.HTMLCanvasElement.prototype.getContext = function () {
    opaqueMask = false;
    return { fillStyle: '', drawImage() {}, beginPath() {}, roundRect() {}, fill() {},
      fillRect(x: number, y: number, width: number, height: number) {
        assert.equal(String(this.fillStyle), '#202329');
        assert.deepEqual([x, y, width, height], [40, 80, 201, 41]);
        opaqueMask = true;
      }
    } as unknown as CanvasRenderingContext2D;
  } as typeof browser.HTMLCanvasElement.prototype.getContext;
  browser.HTMLCanvasElement.prototype.toDataURL = () => {
    assert.equal(opaqueMask, true, 'even an unredacted compositor frame must be covered before encoding');
    return 'data:image/png;base64,TUFTS0VE';
  };
  let fail = false;
  let throttling = true;
  let captures = 0;
  let frame: (() => void) | undefined;
  const contents = {
    beginFrameSubscription: (_onlyDirty: boolean, listener: () => void) => { frame = listener; },
    endFrameSubscription: () => { frame = undefined; },
    invalidate: () => { queueMicrotask(() => frame?.()); },
    mainFrame: {}, isDestroyed: () => false, getBackgroundThrottling: () => throttling,
    setBackgroundThrottling: (value: boolean) => { throttling = value; },
    executeJavaScript: async (script: string) => structuredClone(await browser.eval(script)),
    capturePage: async (rect: unknown) => {
      assert.equal(frame, undefined, 'the frame subscription must be released before export');
      captures++;
      assert.deepEqual(rect, bounds);
      assert.equal(throttling, false);
      assert.equal(browser.getComputedStyle(browser.document.querySelector('.biny-sidebar-session-title')!).visibility, 'visible');
      assert.equal(browser.getComputedStyle(browser.document.querySelector('.biny-project-row-label')!).visibility, 'visible');
      assert.equal(browser.document.getElementById('history')!.textContent, '737 · 485.37 MB · Google Chrome');
      assert.equal(browser.getComputedStyle(browser.document.querySelector('.biny-inspector-rail-zone')!).visibility, 'hidden');
      if (fail) throw new Error("capture failed");
      return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,UE5H', getSize: () => ({ width: 1280, height: 1000 }) };
    }
  };
  let service: { close(): void } | undefined;
  try {
    const { createWindowCaptureService } = await import('../src/desktop/electron/main/windowCapture.js');
    service = createWindowCaptureService(() => ({ isDestroyed: () => false, webContents: contents }) as never);
    const invoke = handlers.get(windowCaptureIpc.capture)!;
    await assert.rejects(invoke({ sender: {}, senderFrame: contents.mainFrame }, { scope: 'content' }), /Untrusted/);
    assert.equal(captures, 0);
    const event = { sender: contents, senderFrame: contents.mainFrame };
    assert.deepEqual(await invoke(event, { scope: 'content' }), { dataUrl: 'data:image/png;base64,TUFTS0VE', width: 1280, height: 1000, privacyRegions: [{ x:40, y:80, width:200, height:40, kind:'title' }] });
    assert.equal(throttling, true);
    assert.equal(browser.document.getElementById('biny-capture-style'), null);
    fail = true;
    await assert.rejects(invoke(event, { scope: 'content' }), /capture failed/);
    assert.equal(throttling, true);
    assert.equal(browser.document.getElementById('biny-capture-style'), null);
    fail = false;
    await invoke(event, { scope: 'content' });
    assert.equal(captures, 3);
    const raw = await invoke(event, { scope: 'content', privacy: false });
    assert.deepEqual(raw.privacyRegions, [{ x:40, y:80, width:200, height:40, kind:'title' }]);
    const title = browser.document.querySelector<HTMLElement>('.biny-sidebar-session-title')!;
    browser.document.elementFromPoint = () => browser.document.querySelector('.biny-project-row-label');
    const occluded = await invoke(event, { scope: 'content' });
    assert.deepEqual(occluded.privacyRegions, [], 'hidden session rows must not cover visible project labels at the same coordinates');
    assert.equal(occluded.dataUrl, 'data:image/png;base64,UE5H');
    browser.document.elementFromPoint = () => title;
    const outputPath = path.join(root, "capture.png");
    const exporting = service as ReturnType<typeof createWindowCaptureService>;
    assert.deepEqual(await exporting.exportFile({ options: { scope: 'content' }, outputPath }), { path: outputPath, width: 1280, height: 1000 });
    assert.equal((await readFile(outputPath)).toString(), 'MASKED');
    await assert.rejects(exporting.exportFile({ options: { scope: 'content' }, outputPath }), /EEXIST/);
    assert.equal((await readFile(outputPath)).toString(), 'MASKED');
    const singleAccount = browser.document.createElement('div');
    singleAccount.textContent = 'owner@example.test';
    const multipleAccounts = browser.document.createElement('div');
    multipleAccounts.textContent = 'first@example.test second@example.test';
    browser.document.querySelector('.settings-content')!.append(singleAccount, multipleAccounts);
    browser.document.elementFromPoint = () => null;
    const accountBounds = new Map([
      ['owner@example.test', { x:280, y:180, width:120, height:20 }],
      ['first@example.test', { x:280, y:210, width:120, height:20 }],
      ['second@example.test', { x:420, y:210, width:140, height:20 }]
    ]);
    browser.Range.prototype.getClientRects = function () {
      const rect = accountBounds.get(this.toString());
      assert.ok(rect, 'only the matched email address is measured');
      return [rect] as unknown as DOMRectList;
    };
    const accounts = await invoke(event, { scope: 'content', privacy: false });
    assert.deepEqual(accounts.privacyRegions.filter((region: { kind: string }) => region.kind === 'account'), [
      { x:120, y:240, width:240, height:40, kind:'account' },
      { x:120, y:300, width:240, height:40, kind:'account' },
      { x:400, y:300, width:280, height:40, kind:'account' }
    ], 'single emails and the first of multiple addresses all receive privacy regions');
  } finally { service?.close(); hooks.deregister(); dom.window.close(); delete (globalThis as any).__captureElectron; await rm(root, { recursive: true, force: true }); }
  assert.equal(handlers.size, 0);
});
