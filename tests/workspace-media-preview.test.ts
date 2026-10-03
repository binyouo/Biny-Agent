/** 工作区媒体通过本地流地址预览；系统媒体接口使用可注入替身。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { FilePreviewPanel } from "../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js";

function fixture(reducedMotion = false) {
  const dom = new JSDOM("<!doctype html><html><body><div id='inspector'><div id='root'></div></div></body></html>", { url: "https://desktop.local/", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const pauseCalls: HTMLMediaElement[] = [];
  const loadCalls: HTMLMediaElement[] = [];
  let playCalls = 0;
  let fullscreenCalls = 0;
  let play: (media: HTMLMediaElement) => Promise<void> = async media => {
    Object.defineProperty(media, "paused", { configurable: true, value: false });
    media.dispatchEvent(new dom.window.Event("play"));
  };
  Object.defineProperties(dom.window.HTMLMediaElement.prototype, {
    play: { configurable: true, value: function(this: HTMLMediaElement) { playCalls++; return play(this); } },
    pause: { configurable: true, value: function(this: HTMLMediaElement) {
      pauseCalls.push(this);
      Object.defineProperty(this, "paused", { configurable: true, value: true });
      this.dispatchEvent(new dom.window.Event("pause"));
    } },
    load: { configurable: true, value: function(this: HTMLMediaElement) { loadCalls.push(this); } }
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "requestFullscreen", { configurable: true, value: async () => { fullscreenCalls++; } });
  dom.window.matchMedia = query => ({ matches: reducedMotion && query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  dom.window.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  const bars: Array<{ x: number; y: number; width: number; height: number }> = [];
  const drawing = { clearRect() { bars.length = 0; }, beginPath() {}, fill() {}, roundRect(x: number, y: number, width: number, height: number) { bars.push({ x, y, width, height }); }, createLinearGradient() { return { addColorStop() {} }; }, fillStyle: "", globalAlpha: 1 };
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => drawing });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ width: 640, height: 240, x: 0, y: 0, top: 0, right: 640, bottom: 240, left: 0, toJSON() {} }) });
  const nativeComputed = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = (element, pseudo) => {
    const native = nativeComputed(element, pseudo);
    return new Proxy(native, { get(target, key) {
      if (key === "color" && element instanceof dom.window.HTMLElement && element.style.color.includes("var(")) return "rgb(24, 154, 88)";
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  let created = 0;
  let closed = 0;
  let resumed = 0;
  let disconnected = 0;
  let sampled = 0;
  class AudioContextFake {
    state = "suspended";
    destination = {};
    constructor() { created++; }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, connect() {}, disconnect() { disconnected++; }, getByteFrequencyData(data: Uint8Array) { sampled++; data.fill(192); } }; }
    createMediaElementSource() { return { connect() {}, disconnect() { disconnected++; } }; }
    async resume() { resumed++; this.state = "running"; }
    async suspend() { this.state = "suspended"; }
    async close() { closed++; this.state = "closed"; }
  }
  const globals = { window: dom.window, document: dom.window.document, React, Node: dom.window.Node, Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement, HTMLMediaElement: dom.window.HTMLMediaElement, HTMLVideoElement: dom.window.HTMLVideoElement,
    MutationObserver: dom.window.MutationObserver, AudioContext: AudioContextFake, ResizeObserver: class { observe() {} disconnect() {} },
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { AudioContext: AudioContextFake });
  const urls: Array<{ projectId: string; path: string }> = [];
  let resolveUrl: (projectId: string, path: string) => Promise<{ url: string; mimeType: string }> = async (_projectId, path) => ({ url: `http://127.0.0.1:4567/media/${encodeURIComponent(path)}`, mimeType: path.endsWith(".mp3") ? "audio/mpeg" : "video/mp4" });
  Object.assign(dom.window, { biny: { getWorkspaceMediaUrl: async (projectId: string, path: string) => { urls.push({ projectId, path }); return resolveUrl(projectId, path); } } });
  const opened: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const render = async (path: string, projectId = "media-project") => {
    const file = { path, bytes: 40_000_000, binary: true, truncated: false };
    await React.act(async () => root.render(React.createElement(FilePreviewPanel, { projectId, width: 600,
      preview: { source: `${projectId}:s`, path, status: "ready", file }, directoryStates: new Map(), expandedDirectories: new Set<string>(),
      onOpenFile: path => opened.push(path), onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {} })));
  };
  const click = async (label: string) => {
    const button = document.querySelector(`.file-media-preview [aria-label="${label}"]`) as HTMLButtonElement | null;
    assert.ok(button, `缺少 ${label} 控件`);
    await React.act(async () => button.click());
  };
  const metadata = async (media: HTMLMediaElement, duration = 125) => {
    Object.defineProperty(media, "duration", { configurable: true, value: duration });
    await React.act(async () => media.dispatchEvent(new dom.window.Event("loadedmetadata")));
  };
  const cleanup = async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { dom, render, click, metadata, cleanup, urls, opened, pauseCalls, loadCalls, frames, bars,
    setResolveUrl(value: typeof resolveUrl) { resolveUrl = value; }, setPlay(value: typeof play) { play = value; },
    audio: () => ({ created, closed, resumed, disconnected, sampled }),
    plays: () => playCalls, fullscreens: () => fullscreenCalls };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "媒体可观察结果应在三秒内出现");
    await React.act(async () => new Promise<void>(resolve => setImmediate(resolve)));
  }
}

test("工作区视频读取本地流，提供真实播放、时间、进度、静音与全屏且不自动播放", async () => {
  const view = fixture();
  try {
    await view.render("assets/movie.mp4");
    const video = document.querySelector(".file-media-preview video") as HTMLVideoElement | null;
    assert.ok(video, "视频不再仅提供系统打开");
    assert.deepEqual(view.urls, [{ projectId: "media-project", path: "assets/movie.mp4" }]);
    assert.equal(video.autoplay, false);
    assert.equal(video.controls, false);
    assert.match(video.querySelector("source")?.src ?? video.src, /^http:\/\/127\.0\.0\.1:4567\//u);
    assert.equal(view.plays(), 0);
    assert.equal(view.audio().created, 0);
    await view.metadata(video);
    assert.match(document.querySelector(".file-media-controls")?.textContent ?? "", /0:00.*2:05/u);
    await view.click("播放视频");
    assert.equal(view.plays(), 1);
    assert.ok(document.querySelector('[aria-label="暂停视频"]'));
    await React.act(async () => { video.currentTime = 65.4; video.dispatchEvent(new view.dom.window.Event("timeupdate")); });
    assert.match(document.querySelector(".file-media-controls")?.textContent ?? "", /1:05/u);
    const slider = document.querySelector('[aria-label="播放进度"]') as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, "value")!.set!;
    await React.act(async () => { valueSetter.call(slider, "31.5"); slider.dispatchEvent(new view.dom.window.Event("input", { bubbles: true })); slider.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
    assert.equal(video.currentTime, 31.5);
    await view.click("静音");
    assert.equal(video.muted, true);
    await view.click("全屏播放视频");
    assert.equal(view.fullscreens(), 1);
    await view.click("暂停视频");
    assert.equal(video.paused, true);
  } finally { await view.cleanup(); }
});

test("媒体读取或播放失败显式可重试，拒绝后不显示播放成功，保留系统打开", async () => {
  const view = fixture();
  try {
    view.setResolveUrl(async () => { throw new Error("denied"); });
    await view.render("assets/denied.mp4");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /无法|失败/u);
    await view.click("使用系统应用打开媒体");
    assert.deepEqual(view.opened, ["assets/denied.mp4"]);
    view.setResolveUrl(async () => ({ url: "http://127.0.0.1:4567/media/new", mimeType: "video/mp4" }));
    await view.click("重试媒体预览");
    const video = document.querySelector(".file-media-preview video") as HTMLVideoElement;
    assert.ok(video);
    await view.metadata(video);
    view.setPlay(async () => { throw new Error("playback rejected"); });
    await view.click("播放视频");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /播放.*失败/u);
    assert.equal(document.querySelector('[aria-label="暂停视频"]'), null);
    assert.equal(video.paused, true);
    const attempts = view.urls.length;
    view.setPlay(async media => { Object.defineProperty(media, "paused", { configurable: true, value: false }); media.dispatchEvent(new view.dom.window.Event("play")); });
    await view.click("重试媒体预览");
    assert.equal(view.urls.length, attempts + 1);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally { await view.cleanup(); }
});

test("项目与文件切换拒绝旧流地址；隐藏 Inspector 和卸载终止播放，旧播放完成不能复播", async () => {
  const view = fixture();
  let resolveOld!: (value: { url: string; mimeType: string }) => void;
  try {
    view.setResolveUrl(async (_project, path) => path === "old.mp4" ? new Promise(resolve => { resolveOld = resolve; }) : { url: "http://127.0.0.1:4567/media/new", mimeType: "video/mp4" });
    await view.render("old.mp4");
    assert.match(document.body.textContent ?? "", /正在读取媒体/u);
    await view.render("new.mp4", "other-project");
    await React.act(async () => resolveOld({ url: "http://127.0.0.1:4567/media/old", mimeType: "video/mp4" }));
    const video = document.querySelector(".file-media-preview video") as HTMLVideoElement;
    assert.ok(video);
    assert.match(video.querySelector("source")?.src ?? video.src, /\/new$/u);
    await view.metadata(video);
    let releasePlay!: () => void;
    view.setPlay(media => new Promise(resolve => { releasePlay = () => { Object.defineProperty(media, "paused", { configurable: true, value: false }); resolve(); }; }));
    await view.click("播放视频");
    await React.act(async () => document.getElementById("inspector")!.setAttribute("inert", ""));
    await until(() => video.paused && !document.querySelector(".file-media-preview video"));
    assert.ok(view.pauseCalls.includes(video));
    assert.equal(video.querySelector("source")?.getAttribute("src") ?? video.getAttribute("src"), null, "隐藏后释放媒体加载地址");
    await React.act(async () => releasePlay());
    assert.equal(video.paused, true, "旧 play promise 完成再次暂停旧媒体");
    await React.act(async () => document.getElementById("inspector")!.removeAttribute("inert"));
    await until(() => !!document.querySelector(".file-media-preview video"));
    assert.equal(view.plays(), 1, "重新显示不自动恢复播放");
    const current = document.querySelector(".file-media-preview video") as HTMLVideoElement;
    await view.render("third.mp4", "other-project");
    assert.ok(view.pauseCalls.includes(current));
    assert.equal(current.querySelector("source")?.getAttribute("src") ?? current.getAttribute("src"), null);
  } finally { await view.cleanup(); }
});

test("音频点击才创建真实频谱连接，绘制 64 柱，暂停与隐藏释放帧和音频上下文", async () => {
  const view = fixture();
  try {
    await view.render("music.mp3");
    const audio = document.querySelector(".file-media-preview audio") as HTMLAudioElement;
    assert.ok(audio, "音频不再只提供系统打开");
    assert.equal(audio.crossOrigin, "anonymous");
    assert.equal(view.audio().created, 0);
    assert.equal(view.bars.length, 64, "未播放仅画固定占位波形");
    assert.equal(view.frames.size, 0);
    assert.equal(document.querySelector('[aria-label="全屏播放视频"]'), null);
    await view.metadata(audio, 90);
    await view.click("播放音频");
    assert.equal(view.audio().created, 1);
    assert.equal(view.audio().resumed, 1);
    assert.ok(view.audio().sampled > 0, "柱高来自 AnalyserNode 的实时数据");
    assert.equal(view.bars.length, 64);
    assert.ok(view.bars.every(bar => bar.height > 100));
    assert.equal(view.frames.size, 1);
    await view.click("暂停音频");
    assert.equal(view.frames.size, 0);
    await view.click("播放音频");
    assert.equal(view.audio().created, 1, "同一播放元素不重复建立媒体节点");
    await React.act(async () => document.getElementById("inspector")!.setAttribute("hidden", ""));
    await until(() => view.audio().closed === 1);
    assert.equal(view.frames.size, 0);
    assert.equal(view.audio().disconnected, 2);
    assert.equal(audio.paused, true);
  } finally { await view.cleanup(); }
});

test("减少动态效果时仍可播放音频，频谱不持续申请动画帧", async () => {
  const view = fixture(true);
  try {
    await view.render("music.mp3");
    const audio = document.querySelector(".file-media-preview audio") as HTMLAudioElement;
    assert.ok(audio);
    await view.metadata(audio);
    await view.click("播放音频");
    assert.equal(audio.paused, false);
    assert.equal(view.frames.size, 0);
    assert.equal(view.bars.length, 64);
  } finally { await view.cleanup(); }
});

test("主进程支持的音视频扩展均使用同类播放器，MIME不匹配或外部地址不会加载", async () => {
  const view = fixture();
  try {
    for (const [path, kind] of [["clip.mpeg", "video"], ["clip.mpg", "video"], ["song.oga", "audio"], ["song.aif", "audio"]] as const) {
      view.setResolveUrl(async () => ({ url: "http://127.0.0.1:4567/media/test", mimeType: `${kind}/test` }));
      await view.render(path);
      assert.ok(document.querySelector(`.file-media-preview ${kind}`), `${path} 应内联使用${kind}播放器`);
    }
    view.setResolveUrl(async () => ({ url: "http://127.0.0.1:4567/media/test", mimeType: "video/mp4" }));
    await view.render("mismatch.mp3");
    assert.equal(document.querySelector(".file-media-preview audio"), null);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /无法预览/u);
    view.setResolveUrl(async () => ({ url: "https://outside.example/media.mp4", mimeType: "video/mp4" }));
    await view.render("outside.mp4");
    assert.equal(document.querySelector(".file-media-preview video"), null);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /无法预览/u);
  } finally { await view.cleanup(); }
});

test("视频全屏请求拒绝只报告该操作失败，保留播放、进度和暂停", async () => {
  const view = fixture();
  try {
    Object.defineProperty(view.dom.window.HTMLElement.prototype, "requestFullscreen", { configurable: true, value: async () => { throw new Error("Fullscreen denied"); } });
    await view.render("movie.mp4");
    const video = document.querySelector(".file-media-preview video") as HTMLVideoElement;
    await view.metadata(video);
    await view.click("播放视频");
    await view.click("全屏播放视频");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /全屏/u);
    assert.equal(video.paused, false);
    assert.equal((document.querySelector('[aria-label="暂停视频"]') as HTMLButtonElement).disabled, false);
    assert.equal((document.querySelector('[aria-label="播放进度"]') as HTMLInputElement).disabled, false);
    await view.click("暂停视频");
    assert.equal(video.paused, true);
    await view.click("播放视频");
    assert.equal(video.paused, false);
  } finally { await view.cleanup(); }
});
