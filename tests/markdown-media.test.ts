import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";

type MediaUrl = { url: string; mimeType: string };
const props = { projectId: "p", onPreviewFile() {}, onOpenExternal() {} };

async function mount(content: string, resolve: (projectId: string, path: string) => Promise<MediaUrl>) {
  const dom = new JSDOM("<div id='container'><div id='root'></div></div>", { url: "https://localhost/", pretendToBeVisual: true });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver });
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const pauses: HTMLMediaElement[] = [];
  const loads: HTMLMediaElement[] = [];
  dom.window.HTMLMediaElement.prototype.pause = function () { pauses.push(this); };
  dom.window.HTMLMediaElement.prototype.load = function () { loads.push(this); };
  Object.assign(window, { biny: { getWorkspaceMediaUrl: resolve, readInlineImage: async () => undefined } });
  const root = createRoot(document.getElementById("root")!);
  const render = async (next: string) => React.act(async () => root.render(React.createElement(MarkdownContent, { ...props, content: next })));
  await render(content);
  return { dom, pauses, loads, render,
    async close() { await React.act(async () => root.unmount()); dom.window.close(); environment.IS_REACT_ACT_ENVIRONMENT = previousAct; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("正文 HTML 本地 src 和 source 使用项目媒体 URL，强制原生控件和 metadata，无 file URL", async () => {
  const calls: string[] = [];
  const mounted = await mount('<video autoplay src="file:///workspace/clip%20one.mp4"></video>\n\n<audio><source src="./sounds/tone.mp3" type="audio/mpeg"></audio>', async (projectId, path) => {
    calls.push(`${projectId}:${path}`);
    return { url: `http://127.0.0.1:3210/media/${calls.length}`, mimeType: path.endsWith("mp3") ? "audio/mpeg" : "video/mp4" };
  });
  try {
    assert.deepEqual(calls, ["p:/workspace/clip one.mp4", "p:./sounds/tone.mp3"]);
    const video = document.querySelector("video")!;
    const audio = document.querySelector("audio")!;
    assert.match(video.src, /^http:\/\/127\.0\.0\.1:3210\/media\//);
    assert.equal(video.controls, true);
    assert.equal(video.preload, "metadata");
    assert.equal(audio.controls, true);
    assert.equal(audio.preload, "metadata");
    assert.match(audio.querySelector("source")!.src, /^http:\/\/127\.0\.0\.1:3210\/media\//);
    assert.doesNotMatch(document.getElementById("root")!.innerHTML, /autoplay|file:\/\//);
  } finally { await mounted.close(); }
});

test("本地媒体读取和解码失败可见且可重试；切换后过时读取结果不能成为当前 source", async () => {
  const first = deferred<MediaUrl>();
  const old = deferred<MediaUrl>();
  let retries = 0;
  const mounted = await mount('<video src="retry.mp4"></video>', async (_projectId, path) => {
    if (path === "retry.mp4") return ++retries === 1 ? first.promise : { url: "http://127.0.0.1:3210/retry", mimeType: "video/mp4" };
    if (path === "old.mp4") return old.promise;
    return { url: "http://127.0.0.1:3210/new", mimeType: "video/mp4" };
  });
  try {
    assert.ok(document.querySelector('[role="status"]'));
    await React.act(async () => first.reject(new Error("找不到媒体文件")));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /找不到媒体文件/);
    await React.act(async () => (document.querySelector("button") as HTMLButtonElement).click());
    assert.equal((document.querySelector("video") as HTMLVideoElement).src, "http://127.0.0.1:3210/retry");
    await React.act(async () => document.querySelector("video")!.dispatchEvent(new mounted.dom.window.Event("error")));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /媒体.*失败/);
    await mounted.render('<video src="old.mp4"></video>');
    await mounted.render('<video src="new.mp4"></video>');
    await React.act(async () => old.resolve({ url: "http://127.0.0.1:3210/stale", mimeType: "video/mp4" }));
    assert.equal((document.querySelector("video") as HTMLVideoElement).src, "http://127.0.0.1:3210/new");
    assert.doesNotMatch(document.getElementById("root")!.innerHTML, /stale/);
  } finally { await mounted.close(); }
});

test("祖先 hidden 或 inert、页面隐藏和卸载释放媒体；重新显示不自动播放", async () => {
  const mounted = await mount('<audio src="https://example.com/music.mp3"></audio>', async () => { throw new Error("外链不走 IPC"); });
  try {
    let audio = document.querySelector("audio")!;
    const container = document.getElementById("container")!;
    await React.act(async () => { container.hidden = true; });
    assert.ok(mounted.pauses.includes(audio));
    assert.equal(audio.getAttribute("src"), null);
    assert.ok(mounted.loads.includes(audio));
    assert.equal(document.querySelector("audio"), null);
    await React.act(async () => { container.hidden = false; });
    audio = document.querySelector("audio")!;
    assert.ok(audio);
    assert.equal(audio.autoplay, false);
    await React.act(async () => { container.setAttribute("inert", ""); });
    assert.equal(document.querySelector("audio"), null);
    await React.act(async () => { container.removeAttribute("inert"); });
    audio = document.querySelector("audio")!;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await React.act(async () => document.dispatchEvent(new mounted.dom.window.Event("visibilitychange")));
    assert.ok(mounted.pauses.includes(audio));
    assert.equal(document.querySelector("audio"), null);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await React.act(async () => document.dispatchEvent(new mounted.dom.window.Event("visibilitychange")));
    audio = document.querySelector("audio")!;
    await mounted.render("正文已切换");
    assert.ok(mounted.pauses.includes(audio));
    assert.equal(audio.getAttribute("src"), null);
  } finally { await mounted.close(); }
});

test("仅安全远程或本地媒体进入 HTML 控件；图片语法、普通链接保持原来的渲染", async () => {
  const calls: string[] = [];
  const mounted = await mount('<video src="https://example.com/clip.mp4" onerror="alert(1)" autoplay></video>\n\n<audio src="javascript:alert(2)"></audio>\n\n<audio src="data:audio/mp3;base64,aGVsbG8="></audio>\n\n<iframe src="https://example.com"></iframe>\n\n![媒体文件](https://example.com/clip.mp4)\n\n[媒体链接](https://example.com/clip.mp4)', async (_projectId, path) => { calls.push(path); throw new Error("不应请求"); });
  try {
    assert.equal((document.querySelector("video") as HTMLVideoElement).controls, true);
    assert.equal(document.querySelectorAll("video").length, 1);
    assert.ok(document.querySelector('img[src="https://example.com/clip.mp4"]'));
    assert.ok(document.querySelector('a[href="https://example.com/clip.mp4"]'));
    assert.doesNotMatch(document.getElementById("root")!.innerHTML, /javascript:|data:audio|onerror|autoplay|<iframe/);
    assert.deepEqual(calls, []);
  } finally { await mounted.close(); }
});
