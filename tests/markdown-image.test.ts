/** 图片公开 DOM 契约；视觉及真实剪贴板权限由人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MarkdownImage } from "../src/desktop/renderer/src/components/MarkdownImage.js";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";

Object.assign(globalThis, { React });

function mountImage(src: string, local = false) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test" } });
  const root = createRoot(document.getElementById("root")!);
  flushSync(() => root.render(React.createElement(MarkdownImage, { src, alt: "图例", local })));
  return { dom, root, close() { flushSync(() => root.unmount()); dom.window.close(); } };
}

function loadImage(dom: JSDOM, width: number, height: number): HTMLImageElement {
  const image = document.querySelector("img.markdown-image") as HTMLImageElement;
  Object.defineProperties(image, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
  flushSync(() => image.dispatchEvent(new dom.window.Event("load")));
  return image;
}

test("远程图片达到 100×100 才可打开原图；键盘打开、缩放与 Escape 恢复焦点", () => {
  const mounted = mountImage("https://example.com/threshold.gif");
  try {
    let image = loadImage(mounted.dom, 99, 100);
    assert.notEqual(image.getAttribute("role"), "button");
    flushSync(() => image.click());
    assert.equal(document.querySelector('[role="dialog"]'), null);
    flushSync(() => image.dispatchEvent(new mounted.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    const openSmall = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(button => button.textContent === "打开图片");
    assert.ok(openSmall, "自然尺寸阈值不限制右键菜单打开原图");
    flushSync(() => openSmall.click());
    assert.ok(document.querySelector('[role="dialog"]'));
    flushSync(() => document.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    image = loadImage(mounted.dom, 100, 100);
    assert.equal(image.getAttribute("role"), "button");
    assert.equal(image.tabIndex, 0);
    image.focus();
    flushSync(() => image.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(dialog.querySelector("img")!.getAttribute("src"), image.src);
    const zoomIn = dialog.querySelector('button[aria-label="放大图片"]') as HTMLButtonElement;
    flushSync(() => zoomIn.click());
    assert.match(dialog.querySelector("img")!.style.transform, /scale\(1\.1\)/);
    const reset = dialog.querySelector('button[aria-label="适应窗口"]') as HTMLButtonElement;
    flushSync(() => reset.click());
    assert.match(dialog.querySelector("img")!.style.transform, /scale\(1\)/);
    flushSync(() => document.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, image);
  } finally { mounted.close(); }
});

test("本地小图也可预览，加载预留比例且失败可重试，不残留先前图片的尺寸", () => {
  let mounted = mountImage("data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==", true);
  try {
    const skeleton = document.querySelector('[role="status"]') as HTMLElement;
    assert.equal(skeleton.style.width, "200px");
    assert.equal(skeleton.style.height, "150px");
    const image = loadImage(mounted.dom, 32, 64);
    assert.equal(image.getAttribute("role"), "button");
    assert.ok(image.classList.contains("is-local"));
  } finally { mounted.close(); }
  mounted = mountImage("data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==", true);
  try {
    const skeleton = document.querySelector('[role="status"]') as HTMLElement;
    assert.equal(skeleton.style.aspectRatio, "32 / 64");
    const image = document.querySelector("img.markdown-image")!;
    flushSync(() => image.dispatchEvent(new mounted.dom.window.Event("error")));
    assert.match(document.body.textContent!, /加载失败/);
    const retry = [...document.querySelectorAll("button")].find(button => button.textContent === "重试")!;
    flushSync(() => retry.click());
    assert.equal(document.querySelector("img.markdown-image")!.getAttribute("src"), "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==");
    flushSync(() => mounted.root.render(React.createElement(MarkdownImage, { src: "https://example.com/new.gif", alt: "新图" })));
    assert.equal((document.querySelector('[role="status"]') as HTMLElement).style.aspectRatio, "");
  } finally { mounted.close(); }
});

test("图片右键仅呈现可用操作；点击预览、菜单下载保留原始 GIF，外部点击关闭", async () => {
  const mounted = mountImage("https://example.com/original.gif");
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let fetched = "";
  let blob: Blob | undefined;
  let downloaded = "";
  globalThis.fetch = async (input) => { fetched = String(input); return new Response("GIF89a", { headers: { "content-type": "image/gif" } }); };
  URL.createObjectURL = value => { blob = value as Blob; return "blob:original-image"; };
  URL.revokeObjectURL = () => {};
  document.addEventListener("click", event => {
    if (event.target instanceof mounted.dom.window.HTMLAnchorElement) { event.preventDefault(); downloaded = event.target.download; }
  });
  try {
    const image = loadImage(mounted.dom, 400, 300);
    flushSync(() => image.dispatchEvent(new mounted.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10000, clientY: 10000 })));
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    assert.ok(menu);
    assert.ok(parseFloat(menu.style.left) < window.innerWidth);
    assert.ok(parseFloat(menu.style.top) < window.innerHeight);
    assert.match(menu.textContent!, /打开图片/);
    assert.doesNotMatch(menu.textContent!, /标注|参考|复制图片/);
    const download = menu.querySelector('button[aria-label="下载图片"]') as HTMLButtonElement;
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    try { await React.act(async () => download.click()); }
    finally { environment.IS_REACT_ACT_ENVIRONMENT = previousAct; }
    assert.equal(fetched, "https://example.com/original.gif");
    assert.equal(blob?.type, "image/gif");
    assert.equal(await blob?.text(), "GIF89a");
    assert.equal(downloaded, "original.gif");
    flushSync(() => document.body.dispatchEvent(new mounted.dom.window.MouseEvent("pointerdown", { bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally { mounted.close(); globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});

test("链接里的可预览图片点击与 Enter 只打开原图，不同时打开链接", () => {
  const mounted = mountImage("https://example.com/linked.gif");
  let opened = 0;
  Object.assign(window, { biny: { openBrowser: async () => { opened++; } } });
  try {
    flushSync(() => mounted.root.render(React.createElement(MarkdownContent, {
      content: "[![图例](https://example.com/linked.gif)](https://example.com/page)",
      projectId: "p", onPreviewFile() {}, onOpenExternal() { opened++; }
    })));
    const image = loadImage(mounted.dom, 400, 300);
    flushSync(() => image.click());
    assert.equal(opened, 0);
    assert.ok(document.querySelector('[role="dialog"]'));
    flushSync(() => document.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    flushSync(() => image.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(opened, 0);
    assert.ok(document.querySelector('[role="dialog"]'));
  } finally { mounted.close(); }
});
