import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

test("privacy toggles the same capture, preserves manual masks and crop, and exports the composed result", async () => {
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  } });
  const dom = new JSDOM('<div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class CapturedImage {
    naturalWidth = 800; naturalHeight = 600;
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  for (const [key, value] of Object.entries({ window:dom.window, document:dom.window.document, navigator:dom.window.navigator, HTMLElement:dom.window.HTMLElement, React, Image:CapturedImage, IS_REACT_ACT_ENVIRONMENT:true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable:true, value });
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  type Draw = { kind:string; color?:string; args:unknown[] };
  const draws = new WeakMap<HTMLCanvasElement, Draw[]>();
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    const operations: Draw[] = []; draws.set(this, operations);
    return { fillStyle:'', strokeStyle:'', lineWidth:1, save() {}, restore() {}, beginPath() {}, clip() {}, setLineDash() {}, strokeRect() {},
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
    capture: async () => { captures++; return { dataUrl:'data:image/png;base64,test', width:800, height:600, privacyRegions:[{ x:20,y:30,width:120,height:20,background:'#181818' }] }; },
    copy: async (data:string) => { copied = data; }, save: async (data:string) => { stored = data; return '/capture.png'; }
  } });
  const root = createRoot(document.getElementById('root')!);
  const button = (text:string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;
  const drag = async (x:number,y:number,x2:number,y2:number) => {
    const canvas = document.querySelector('canvas')!;
    canvas.getBoundingClientRect = () => ({ left:0,top:0,width:canvas.width,height:canvas.height }) as DOMRect;
    await act(async () => {
      canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles:true, button:0, clientX:x,clientY:y }));
      canvas.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles:true, button:0, clientX:x2,clientY:y2 }));
    });
  };
  try {
    const { WindowCapture } = await import('../src/desktop/renderer/src/components/capture/WindowCapture.js');
    await act(async () => root.render(React.createElement(WindowCapture)));
    await act(async () => menu('capture-window'));
    assert.equal(document.querySelector('dialog')!.open, true);
    await drag(264,264,364,324);
    await act(async () => button('复制').click());
    let exported = JSON.parse(copied) as { width:number; height:number; draws:Draw[] };
    assert.ok(exported.draws.some(item => item.kind === 'rect' && item.color === '#181818'), 'privacy covers the original title pixels');
    assert.deepEqual(exported.draws.at(-1), { kind:'rect', color:'#252525', args:[264,264,100,60] }, 'manual masking is applied last');
    await act(async () => document.querySelector<HTMLInputElement>('[aria-label="隐私"]')!.click());
    await act(async () => button('复制').click());
    exported = JSON.parse(copied);
    assert.equal(captures, 1, 'privacy changes never recapture or discard edits');
    assert.equal(exported.draws.some(item => item.color === '#181818'), false);
    assert.deepEqual(exported.draws.at(-1), { kind:'rect', color:'#252525', args:[264,264,100,60] });
    await act(async () => button('裁剪').click());
    await drag(164,164,464,464);
    await act(async () => button('复制').click());
    exported = JSON.parse(copied);
    assert.equal(exported.width, 428); assert.equal(exported.height, 428);
    assert.deepEqual(exported.draws.at(-1), { kind:'rect', color:'#252525', args:[164,164,100,60] });
    await act(async () => button('保存…').click());
    assert.equal(stored, copied, 'copy and save receive identical edited output');
    await act(async () => button('撤销打码').click());
    await act(async () => button('复制').click());
    assert.equal(JSON.parse(copied).draws.some((item:Draw) => item.color === '#252525'), false);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); hooks.deregister();
    for (const [key,value] of saved) { if (value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key); }
  }
});
