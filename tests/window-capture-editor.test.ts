import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

test("window editor preserves private pixels, history and export through view and background changes", async () => {
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  } });
  const dom = new JSDOM('<div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const pendingImages = new Map<string, CapturedImage>();
  const revoked: string[] = [];
  class CapturedImage {
    naturalWidth = 800; naturalHeight = 600;
    onload?: () => void;
    onerror?: () => void;
    set src(value: string) {
      if (!value.startsWith('data:')) { this.naturalWidth = 1200; this.naturalHeight = 600; }
      if (value.endsWith('canyon.jpg') || value.endsWith('mist.jpg')) pendingImages.set(value, this);
      else if (value.endsWith('highland.jpg')) queueMicrotask(() => this.onerror?.());
      else queueMicrotask(() => this.onload?.());
    }
  }
  for (const [key, value] of Object.entries({ window:dom.window, document:dom.window.document, navigator:dom.window.navigator, HTMLElement:dom.window.HTMLElement, React, Image:CapturedImage, URL:class extends URL { static createObjectURL() { return "blob:custom"; } static revokeObjectURL(url:string) { revoked.push(url); } }, IS_REACT_ACT_ENVIRONMENT:true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable:true, value });
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  type Draw = { kind:string; color?:string; args:unknown[] };
  const draws = new WeakMap<HTMLCanvasElement, Draw[]>();
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    const operations: Draw[] = []; draws.set(this, operations);
    return { fillStyle:'', strokeStyle:'', lineWidth:1, save() {}, restore() {}, beginPath() {}, clip() {}, setLineDash() {}, strokeRect() {},
      canvas: { width: this.width, height: this.height },
      getImageData: (_x:number, _y:number, width:number, height:number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(120) }),
      putImageData: (...args:unknown[]) => operations.push({ kind:'putImageData', args }),
      createLinearGradient: () => ({ addColorStop() {} }),
      drawImage: (...args:unknown[]) => operations.push({ kind:'image', args:args.slice(1) }),
      fillRect(x:number,y:number,w:number,h:number) { operations.push({ kind:'rect', color:String(this.fillStyle), args:[x,y,w,h] }); },
      roundRect(x:number,y:number,w:number,h:number) { operations.push({ kind:'round', color:String(this.fillStyle), args:[x,y,w,h] }); },
      fill() {}
    } as unknown as CanvasRenderingContext2D;
  } as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  // 记录真实合成器交给 Canvas 的内容；原生像素编码和对话框绘制另由 Desktop 验收。
  dom.window.HTMLCanvasElement.prototype.toDataURL = function () { return JSON.stringify({ width:this.width, height:this.height, draws:draws.get(this) }); };
  let menu: (action:string) => void = () => {};
  let captures = 0;
  let copied = '';
  let stored = '';
  Object.assign(dom.window, { biny:{ onMenuAction: (listener: typeof menu) => { menu = listener; return () => {}; } }, binyCapture:{
    capture: async () => { captures++; return { dataUrl:'data:image/png;base64,test', width:800, height:600, privacyRegions:[{ x:20,y:30,width:120,height:20,kind:'title' }] }; },
    copy: async (data:string) => { copied = data; }, save: async (data:string) => { stored = data; return '/capture.png'; }
  } });
  const root = createRoot(document.getElementById('root')!);
  const button = (text:string) => [...document.querySelectorAll('button')].find(item => (item.textContent === text || item.getAttribute('aria-label') === text))!;
  const drag = async (x:number,y:number,x2:number,y2:number, scale = 1, left = 0, top = 0) => {
    const canvas = document.querySelector('canvas')!;
    canvas.getBoundingClientRect = () => ({ left,top,width:canvas.width * scale,height:canvas.height * scale }) as DOMRect;
    await act(async () => {
      canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles:true, button:0, clientX:x,clientY:y }));
      canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles:true, button:0, clientX:x2,clientY:y2 }));
      canvas.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles:true, button:0, clientX:x2,clientY:y2 }));
    });
  };
  try {
    const { WindowCapture } = await import('../src/desktop/renderer/src/components/capture/WindowCapture.js');
    await act(async () => root.render(React.createElement(WindowCapture)));
    await act(async () => menu('capture-window'));
    assert.equal(document.querySelector('dialog')!.open, true);
    assert.equal(button('拖动').getAttribute('aria-pressed'), 'true');
    await act(async () => button('打码').click());
    await drag(264,264,364,324);
    await act(async () => button('复制').click());
    let exported = JSON.parse(copied) as { width:number; height:number; draws:Draw[] };
    assert.ok(exported.draws.some(item => item.kind === 'putImageData' && (item.args as number[])[1] === 84 && (item.args as number[])[2] === 94), 'privacy blurs the original title pixels');
    assert.deepEqual(exported.draws.at(-1), { kind:'rect', color:'#252525', args:[264,264,100,60] }, 'manual masking is applied last');
    await act(async () => document.querySelector<HTMLInputElement>('[aria-label="会话标题"]')!.click());
    await act(async () => button('复制').click());
    exported = JSON.parse(copied);
    assert.equal(captures, 1, 'privacy changes never recapture or discard edits');
    assert.equal(exported.draws.some(item => item.kind === 'putImageData'), false);
    assert.deepEqual(exported.draws.at(-1), { kind:'rect', color:'#252525', args:[264,264,100,60] });
    await act(async () => button('裁剪').click());
    await drag(164,164,464,464);
    await act(async () => button('复制').click());
    exported = JSON.parse(copied);
    assert.equal(exported.width, 428); assert.equal(exported.height, 428);
    assert.deepEqual(exported.draws[0], { kind:'image', args:[300,0,600,600,0,0,428,428] }, 'photo backgrounds fill the output with a centered crop');
    assert.deepEqual(exported.draws.at(-1), { kind:'rect', color:'#252525', args:[164,164,100,60] });
    await act(async () => button('保存…').click());
    assert.equal(stored, copied, 'copy and save receive identical edited output');
    await act(async () => button('撤销').click());
    await act(async () => button('复制').click());
    assert.equal(JSON.parse(copied).width, 928, 'undo restores the previous crop');
    await act(async () => button('重做').click());
    await act(async () => button('复制').click());
    assert.equal(JSON.parse(copied).width, 428, 'redo reapplies the crop');
    await act(async () => button('撤销').click());
    await act(async () => button('撤销').click());
    await act(async () => button('复制').click());
    assert.equal(JSON.parse(copied).draws.some((item:Draw) => item.color === '#252525'), false);
    const unzoomed = copied;
    await act(async () => button('放大').click());
    assert.equal(button('重置视图').textContent, '125%');
    await act(async () => button('复制').click());
    assert.equal(copied, unzoomed, 'viewport zoom never changes exported pixels');
    await act(async () => button('适应窗口').click());
    assert.equal(button('重置视图').textContent, '100%');
    await act(async () => button('打码').click());
    await drag(164,164,264,224);
    assert.equal(button('重做').disabled, true, 'editing after undo discards the redo branch');
    await act(async () => button('撤销').click());
    await act(async () => button('放大').click());
    await drag(478,578,678,698, 2, 150, 250);
    await act(async () => button('复制').click());
    assert.deepEqual(JSON.parse(copied).draws.at(-1), { kind:'rect', color:'#252525', args:[164,164,100,60] }, 'selection maps the transformed preview back into image pixels');
    await act(async () => button('拖动').click());
    await drag(100,100,180,150);
    await act(async () => button('复制').click());
    assert.deepEqual(JSON.parse(copied).draws.at(-1).args, [164,164,100,60], 'panning adds no mask');
    assert.match(document.querySelector('canvas')!.style.transform, /translate\(80px, 50px\)/);
    await act(async () => button('适应窗口').click());
    assert.match(document.querySelector('canvas')!.style.transform, /translate\(0px, 0px\)/);
    await act(async () => button('峡谷').click());
    assert.equal(button('复制').disabled, true, 'export waits for background decoding');
    await act(async () => button('薄雾').click());
    await act(async () => pendingImages.get('./capture-backgrounds/canyon.jpg')!.onload?.());
    assert.equal(button('复制').disabled, true, 'an older decode cannot finish the latest background request');
    await act(async () => button('透明背景').click());
    await act(async () => pendingImages.get('./capture-backgrounds/mist.jpg')!.onload?.());
    assert.equal(button('透明背景').getAttribute('aria-pressed'), 'true', 'late background results cannot override a later selection');
    await act(async () => button('复制').click());
    assert.equal(JSON.parse(copied).draws.filter((item:Draw) => item.kind === 'image').length, 1, 'transparent export has no background image');
    await act(async () => button('山野').click());
    assert.equal(document.querySelector('[role="alert"]')!.textContent, '图片读取失败');
    assert.equal(button('透明背景').getAttribute('aria-pressed'), 'true', 'failed background load preserves the last selection');
    assert.equal(button('复制').disabled, false);
    const fileInput = document.querySelector<HTMLInputElement>('[aria-label="背景图片文件"]')!;
    Object.defineProperty(fileInput, 'files', { configurable:true, value:[{ size:100, type:'image/png' }] });
    await act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles:true })));
    assert.equal(button('选择背景图片').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(revoked, ['blob:custom'], 'uploaded background URLs are released after decoding');
    await act(async () => button('复制').click());
    assert.equal(JSON.parse(copied).draws.filter((item:Draw) => item.kind === 'image').length, 2);
    Object.defineProperty(fileInput, 'files', { configurable:true, value:[{ size:21 * 1024 * 1024, type:'image/png' }] });
    await act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles:true })));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /20 MB/);
    assert.equal(button('选择背景图片').getAttribute('aria-pressed'), 'true');
    assert.equal(captures, 1, 'background and view changes use the original capture');
    await act(async () => button('重拍').click());
    assert.equal(captures, 2);
    assert.equal(button('撤销').disabled, true, 'retake clears edit history');
    assert.equal(button('拖动').getAttribute('aria-pressed'), 'true');
    assert.equal(button('重置视图').textContent, '100%');
  } finally {
    await act(async () => root.unmount()); dom.window.close(); hooks.deregister();
    for (const [key,value] of saved) { if (value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key); }
  }
});

test("image decoding rejects unreadable, empty and oversized backgrounds", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  class BackgroundImage {
    naturalWidth = 8000; naturalHeight = 4000;
    onload?: () => void;
    onerror?: () => void;
    set src(value: string) {
      if (value === 'empty') this.naturalWidth = 0;
      if (value === 'oversized') this.naturalHeight = 4001;
      queueMicrotask(() => value === 'invalid' ? this.onerror?.() : this.onload?.());
    }
  }
  Object.defineProperty(globalThis, 'Image', { configurable:true, value:BackgroundImage });
  try {
    const { loadCaptureImage } = await import('../src/desktop/renderer/src/components/capture/captureCanvas.js');
    assert.equal((await loadCaptureImage('valid')).naturalWidth, 8000);
    await assert.rejects(loadCaptureImage('invalid'), /图片读取失败/);
    for (const source of ['empty', 'oversized']) await assert.rejects(loadCaptureImage(source), /图片尺寸无效或超过 3200 万像素/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'Image', saved); else Reflect.deleteProperty(globalThis, 'Image');
  }
});
