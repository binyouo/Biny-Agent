/** Native events are queued after play() changes paused; audio control state is synchronous. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { FilePreviewPanel } from "../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js";

type AudioState = "running" | "suspended" | "closed";
function fixture(t: TestContext, initialState: AudioState = "running", reducedMotion = false) {
  const dom = new JSDOM('<div id="inspector"><div id="root"></div></div>', { url: "https://desktop.test", pretendToBeVisual: true });
  const undo: Array<() => void> = [];
  const replace = (target: object, key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    undo.push(() => previous ? Object.defineProperty(target, key, previous) : Reflect.deleteProperty(target, key));
  };
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  replace(dom.window, "requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  replace(dom.window, "cancelAnimationFrame", (id: number) => frames.delete(id));
  replace(dom.window, "matchMedia", () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }));
  replace(dom.window.HTMLCanvasElement.prototype, "getContext", () => null);
  const contexts: AudioContextFake[] = [];
  class AudioContextFake {
    state: AudioState = initialState;
    destination = {};
    resumed = 0;
    suspended = 0;
    closed = 0;
    disconnected = 0;
    constructor() { contexts.push(this); }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, connect() {}, disconnect: () => { this.disconnected++; }, getByteFrequencyData() {} }; }
    createMediaElementSource() { return { connect() {}, disconnect: () => { this.disconnected++; } }; }
    async resume() { this.resumed++; assert.notEqual(this.state, "closed"); this.state = "running"; }
    async suspend() { this.suspended++; assert.notEqual(this.state, "closed"); this.state = "suspended"; }
    async close() { this.closed++; this.state = "closed"; }
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} },
    AudioContext: AudioContextFake, IS_REACT_ACT_ENVIRONMENT: true })) replace(globalThis, key, value);
  const unexpected: string[] = [];
  replace(globalThis, "fetch", () => { unexpected.push("fetch"); throw new Error("Unexpected network"); });
  const urls: string[] = [];
  replace(dom.window, "biny", new Proxy({ getWorkspaceMediaUrl: async (project: string, path: string) => {
    urls.push(`${project}:${path}`); return { url: `http://127.0.0.1:4567/media/${encodeURIComponent(project + path)}`, mimeType: path.endsWith("mp4") ? "video/mp4" : "audio/mpeg" };
  } }, { get(target, key) { if (key in target) return target[key as keyof typeof target]; unexpected.push(String(key)); throw new Error(`Unexpected IPC: ${String(key)}`); } }));
  const pauses: HTMLMediaElement[] = [];
  const loads: HTMLMediaElement[] = [];
  const plays: HTMLMediaElement[] = [];
  const setPaused = (element: HTMLMediaElement, value: boolean) => Object.defineProperty(element, "paused", { configurable: true, value });
  let nativePlay = async (element: HTMLMediaElement) => { element.dispatchEvent(new dom.window.Event("play")); };
  replace(dom.window.HTMLMediaElement.prototype, "play", function(this: HTMLMediaElement) { plays.push(this); setPaused(this, false); return nativePlay(this); });
  replace(dom.window.HTMLMediaElement.prototype, "pause", function(this: HTMLMediaElement) { pauses.push(this); setPaused(this, true); this.dispatchEvent(new dom.window.Event("pause")); });
  replace(dom.window.HTMLMediaElement.prototype, "load", function(this: HTMLMediaElement) { loads.push(this); });
  const root = createRoot(document.getElementById("root")!);
  const act = async (action: () => unknown) => { await React.act(async () => { await action(); }); };
  const pending: Array<() => void> = [];
  const opened: string[] = [];
  const render = async (path: string | undefined = "song.mp3", projectId = "p") => act(() => root.render(React.createElement(FilePreviewPanel, {
    projectId, width: 800, preview: path === undefined ? undefined : { source: `${projectId}:s`, path, status: "ready", file: { path, bytes: 10, binary: true, truncated: false } },
    directoryStates: new Map(), expandedDirectories: new Set<string>(), onOpenFile: (path: string) => opened.push(path),
    onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
  })));
  const click = async (label: string, disabled = false) => act(() => {
    const button = document.querySelector<HTMLButtonElement>(`.file-media-preview [aria-label="${label}"]`);
    assert.ok(button, `Missing ${label}`); assert.equal(button.disabled, disabled);
    assert.equal(button.closest('[inert], [hidden], [aria-hidden="true"]'), null, "Never click a hidden media control"); button.click();
  });
  const metadata = async () => {
    const element = document.querySelector<HTMLMediaElement>("audio, video"); assert.ok(element);
    Object.defineProperty(element, "duration", { configurable: true, value: 90 });
    await act(() => element.dispatchEvent(new dom.window.Event("loadedmetadata"))); return element;
  };
  const holdPlay = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let element!: HTMLMediaElement;
    let finished = false;
    nativePlay = current => { element = current; return new Promise<void>((yes, no) => { resolve = yes; reject = no; }); };
    const settle = (error?: Error, emit = true) => {
      if (finished || !element) return; finished = true;
      if (error) reject(error); else { if (emit) element.dispatchEvent(new dom.window.Event("play")); resolve(); }
    };
    pending.push(() => settle(new Error("fixture cleanup")));
    return { finish: () => settle(), fail: () => settle(new Error("native playback failed")), playEvent: () => element.dispatchEvent(new dom.window.Event("play")) };
  };
  t.after(async () => {
    try { await act(() => root.unmount()); await act(() => pending.forEach(settle => settle())); }
    finally { dom.window.close(); undo.reverse().forEach(restore => restore()); }
    assert.deepEqual(unexpected, []); assert.equal(frames.size, 0);
    for (const context of contexts) { assert.equal(context.closed, 1); assert.equal(context.disconnected, 2); }
  });
  return { act, render, click, metadata, holdPlay, contexts, frames, plays, pauses, loads, urls, opened, dom,
    hide: () => act(() => document.getElementById("inspector")!.setAttribute("inert", "")),
    show: () => act(() => document.getElementById("inspector")!.removeAttribute("inert")),
    closeFile: () => act(() => root.render(React.createElement("div"))),
    media: () => document.querySelector<HTMLMediaElement>("audio, video") };
}

for (const initial of ["running", "suspended"] as const) test(`first play keeps its ${initial} audio graph alive until native playback starts`, async t => {
  const h = fixture(t, initial); await h.render(); const audio = await h.metadata(); const play = h.holdPlay();
  await h.click("播放音频"); assert.equal(audio.paused, false); assert.equal(h.plays.length, 1); assert.equal(h.contexts.length, 1);
  assert.equal(h.frames.size, 0, "pending playback does not animate the spectrum");
  await h.act(play.finish);
  assert.ok(document.querySelector('[aria-label="暂停音频"]')); assert.equal(audio.paused, false);
  assert.equal(h.contexts[0]!.state, "running", "the playing element must not feed a suspended audio graph");
});

test("pending playback ignores repeated clicks and owns idle suspension", async t => {
  const h = fixture(t); await h.render(); await h.metadata(); const play = h.holdPlay();
  await h.click("播放音频"); await h.click("播放音频", true); assert.equal(h.plays.length, 1);
  assert.equal(h.contexts[0]!.suspended, 0, "pending play is not idle"); await h.act(play.finish);
});

test("native play rejection releases pending ownership and suspends the retained graph", async t => {
  const h = fixture(t); await h.render(); const audio = await h.metadata(); const play = h.holdPlay();
  await h.click("播放音频"); await h.act(play.fail);
  assert.equal(audio.paused, true); assert.equal(h.contexts[0]!.state, "suspended"); assert.equal(h.frames.size, 0);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /播放失败/u);
  await h.click("重试媒体预览"); assert.equal(h.contexts[0]!.state, "closed"); assert.equal(h.contexts.length, 1);
  assert.equal(h.plays.length, 1, "retry prepares a new player without autoplay");
});

test("play event may precede promise completion without suspending active audio", async t => {
  const h = fixture(t); await h.render(); await h.metadata(); const play = h.holdPlay();
  await h.click("播放音频"); await h.act(play.playEvent); await h.act(play.finish);
  assert.equal(h.contexts[0]!.state, "running"); assert.equal(h.plays.length, 1);
});

for (const transition of ["file", "project", "close", "hidden"] as const) test(`late native play completion cannot revive audio after ${transition} change`, async t => {
  const h = fixture(t); await h.render(); const old = await h.metadata(); const play = h.holdPlay(); await h.click("播放音频");
  if (transition === "file") await h.render("new.mp3");
  if (transition === "project") await h.render("song.mp3", "other");
  if (transition === "close") await h.closeFile();
  if (transition === "hidden") await h.hide();
  assert.equal(h.contexts[0]!.state, "closed"); assert.equal(old.paused, true);
  assert.equal(old.querySelector("source")?.getAttribute("src"), null); assert.ok(h.loads.includes(old));
  await h.act(play.finish); assert.equal(old.paused, true); assert.equal(h.contexts[0]!.state, "closed");
  if (transition === "hidden") { await h.show(); assert.ok(h.media()); }
  assert.equal(h.plays.length, 1); assert.equal(h.contexts.length, 1); assert.equal(document.querySelector('[role="alert"]'), null);
});

test("ordinary and immediate pause/replay retain one graph with synchronous control state", async t => {
  const h = fixture(t); await h.render(); const audio = await h.metadata(); await h.click("播放音频");
  for (let index = 0; index < 3; index++) {
    await h.click("暂停音频"); assert.equal(h.contexts[0]!.state, "suspended"); await h.click("播放音频");
    assert.equal(h.contexts[0]!.state, "running"); assert.equal(audio.paused, false);
  }
  assert.equal(h.contexts.length, 1);
});

test("reduced-motion audio startup remains audible without scheduling animation frames", async t => {
  const h = fixture(t, "running", true); await h.render(); await h.metadata(); const play = h.holdPlay();
  await h.click("播放音频"); await h.act(play.finish);
  assert.equal(h.contexts[0]!.state, "running"); assert.equal(h.frames.size, 0);
});

test("video playback never creates an audio graph", async t => {
  const h = fixture(t); await h.render("movie.mp4"); const video = await h.metadata(); const play = h.holdPlay();
  await h.click("播放视频"); await h.act(play.finish); assert.equal(video.paused, false); assert.equal(h.contexts.length, 0);
});

test("PDF preserves its system-open fallback without media URL or playback resources", async t => {
  const h = fixture(t); await h.render("notes.pdf");
  assert.equal(h.media(), null); assert.equal(h.urls.length, 0); assert.equal(h.contexts.length, 0);
  assert.match(document.body.textContent ?? "", /二进制文件.*系统应用/u);
});

test("muting a pending play preserves its audio lifetime and mute selection", async t => {
  const h = fixture(t); await h.render(); const audio = await h.metadata(); const play = h.holdPlay();
  await h.click("播放音频"); await h.click("静音"); assert.equal(audio.muted, true); await h.act(play.finish);
  assert.equal(audio.muted, true); assert.ok(document.querySelector('[aria-label="取消静音"]'));
  assert.equal(h.contexts[0]!.state, "running");
});

test("native rejection after hiding does not publish an error into a restored player", async t => {
  const h = fixture(t); await h.render(); const old = await h.metadata(); const play = h.holdPlay();
  await h.click("播放音频"); await h.hide(); await h.show(); const current = h.media(); assert.ok(current); assert.notEqual(current, old);
  await h.act(play.fail); assert.equal(old.paused, true); assert.equal(current.paused, true);
  assert.equal(h.contexts[0]!.state, "closed"); assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(h.plays.length, 1);
});
