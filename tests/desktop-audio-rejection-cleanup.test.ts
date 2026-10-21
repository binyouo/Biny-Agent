/** Inert real-component audit. Chromium150 resume state is delayed; suspend state is synchronous.
 * No audio output, real device, network, provider, private media, or application IPC is used. */
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
  let holdResume = false;
  class AudioContextFake extends dom.window.EventTarget {
    state: AudioState = initialState;
    destination = {};
    onstatechange: ((event: Event) => void) | null = null;
    resumed = 0;
    suspended = 0;
    closed = 0;
    disconnected = 0;
    rendering = initialState === "running";
    private resumeResolvers: Array<{ resolve(): void; reject(error: Error): void }> = [];
    constructor() { super(); contexts.push(this); }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, connect() {}, disconnect: () => { this.disconnected++; }, getByteFrequencyData() {} }; }
    createMediaElementSource() { return { connect() {}, disconnect: () => { this.disconnected++; } }; }
    resume() {
      this.resumed++;
      if (this.state === "closed") return Promise.reject(new dom.window.DOMException("Closed", "InvalidStateError"));
      if (this.state === "running") return Promise.resolve();
      // Chromium150 starts rendering but waits for its render-thread callback
      // before updating observable ContextState or resolving resume promises.
      this.rendering = true;
      const promise = new Promise<void>((resolve, reject) => this.resumeResolvers.push({ resolve, reject }));
      if (!holdResume) setImmediate(() => this.finishResume());
      return promise;
    }
    changeState(state: AudioState) {
      if (this.state === state) return;
      this.state = state;
      setImmediate(() => { const event = new dom.window.Event("statechange"); this.onstatechange?.(event); this.dispatchEvent(event); });
    }
    finishResume() {
      if (!this.resumeResolvers.length) return;
      if (this.state === "closed") {
        for (const resolver of this.resumeResolvers.splice(0)) resolver.reject(new dom.window.DOMException("Closed", "InvalidStateError"));
        return;
      }
      this.changeState("running");
      for (const resolver of this.resumeResolvers.splice(0)) resolver.resolve();
    }
    pendingResumes() { return this.resumeResolvers.length; }
    async suspend() { this.suspended++; assert.notEqual(this.state, "closed"); this.rendering = false; this.changeState("suspended"); }
    async close() {
      this.closed++; this.changeState("closed"); this.rendering = false;
      setImmediate(() => this.finishResume());
    }
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
  const playRejections = new Map<HTMLMediaElement, () => void>();
  let nativePlay = (element: HTMLMediaElement): Promise<void> => new Promise(resolve => setImmediate(() => { element.dispatchEvent(new dom.window.Event("play")); resolve(); }));
  replace(dom.window.HTMLMediaElement.prototype, "play", function(this: HTMLMediaElement) { plays.push(this); setPaused(this, false); return nativePlay(this); });
  replace(dom.window.HTMLMediaElement.prototype, "pause", function(this: HTMLMediaElement) {
    pauses.push(this);
    if (!this.paused) {
      setPaused(this, true);
      const rejectPendingPlay = playRejections.get(this);
      setImmediate(() => { this.dispatchEvent(new dom.window.Event("pause")); rejectPendingPlay?.(); });
    }
  });
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
    Object.defineProperty(element, "readyState", { configurable: true, value: 4 });
    await act(() => element.dispatchEvent(new dom.window.Event("loadedmetadata"))); return element;
  };
  const holdPlay = () => {
    const current = document.querySelector<HTMLMediaElement>("audio, video"); assert.ok(current);
    // After metadata a rebuffer/seek may leave only current data. Such a play()
    // queues play/waiting but does not already queue promise success.
    Object.defineProperty(current, "readyState", { configurable: true, value: 2 });
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let element!: HTMLMediaElement;
    let finished = false;
    nativePlay = current => {
      element = current;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      playRejections.set(current, () => settle(new dom.window.DOMException("Interrupted by pause", "AbortError")));
      setImmediate(() => { element.dispatchEvent(new dom.window.Event("play")); element.dispatchEvent(new dom.window.Event("waiting")); });
      return promise;
    };
    const settle = (error?: Error) => {
      if (finished || !element) return; finished = true; playRejections.delete(element);
      if (error) reject(error);
      else {
        Object.defineProperty(element, "readyState", { configurable: true, value: 4 });
        element.dispatchEvent(new dom.window.Event("playing")); resolve();
      }
    };
    pending.push(() => settle(new Error("fixture cleanup")));
    return {
      finish: () => settle(),
      fail: (code = 3) => {
        Object.defineProperty(element, "error", { configurable: true, value: { code, message: "Native media failure" } });
        element.dispatchEvent(new dom.window.Event("error"));
        // The real onError handler calls pause(), which queues pause and then
        // AbortError rejection of this still-pending native play promise.
      }
    };
  };
  t.after(async () => {
    try { await act(() => root.unmount()); await act(() => pending.forEach(settle => settle())); }
    finally { dom.window.close(); undo.reverse().forEach(restore => restore()); }
    assert.deepEqual(unexpected, []); assert.equal(frames.size, 0);
    for (const context of contexts) { assert.equal(context.closed, 1); assert.equal(context.disconnected, 2); assert.equal(context.onstatechange, null); }
  });
  return { act, render, click, metadata, holdPlay, holdResume: () => { holdResume = true; }, releaseResume: () => { holdResume = false; }, contexts, frames, plays, pauses, loads, urls, opened, dom,
    hide: () => act(() => document.getElementById("inspector")!.setAttribute("inert", "")),
    show: () => act(() => document.getElementById("inspector")!.removeAttribute("inert")),
    closeFile: () => act(() => root.render(React.createElement("div"))),
    media: () => document.querySelector<HTMLMediaElement>("audio, video") };
}

async function warmup(h: ReturnType<typeof fixture>) {
  await h.render(); const audio = await h.metadata(); await h.click("播放音频");
  await h.act(() => new Promise(resolve => setImmediate(resolve)));
  assert.equal(audio.paused, false);
  await h.click("暂停音频");
  assert.equal(audio.paused, true); assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0]!.state, "suspended");
  return audio;
}
for (const code of [2, 3]) test(`native media error ${code} before replay resume completion releases the idle graph`, async t => {
  const h = fixture(t); const audio = await warmup(h); h.holdResume(); const play = h.holdPlay();
  await h.click("播放音频"); const context = h.contexts[0]!;
  assert.equal(context.state, "suspended", "Chromium resume() does not synchronously update observable state");
  assert.equal(context.pendingResumes(), 1); assert.equal(h.plays.length, 2);
  assert.equal(audio.readyState, 2); assert.equal(audio.paused, false);
  await h.act(() => play.fail(code));
  await h.act(() => new Promise(resolve => setImmediate(resolve)));
  assert.ok(document.querySelector('[role="alert"]')); assert.equal(audio.paused, true);
  assert.equal(h.frames.size, 0);
  await h.act(() => context.finishResume());
  assert.deepEqual({ state: context.state, rendering: context.rendering }, { state: "suspended", rendering: false }, "late resume must not leave an idle running audio graph");
});
test("replay rejection after resume completion already suspends the idle graph", async t => {
  const h = fixture(t); const audio = await warmup(h); h.holdResume(); const play = h.holdPlay();
  await h.click("播放音频"); const context = h.contexts[0]!;
  await h.act(() => context.finishResume()); assert.equal(context.state, "running");
  await h.act(() => play.fail());
  assert.equal(context.state, "suspended"); assert.equal(context.rendering, false);
  assert.equal(audio.paused, true); assert.equal(h.frames.size, 0);
});
test("successful replay waits for resume and reuses the same graph", async t => {
  const h = fixture(t); const audio = await warmup(h); h.holdResume(); const play = h.holdPlay();
  await h.click("播放音频"); const context = h.contexts[0]!;
  await h.act(play.finish); assert.equal(context.pendingResumes(), 1);
  await h.click("暂停音频", true); assert.equal(audio.paused, false);
  await h.act(() => context.finishResume());
  assert.equal(context.state, "running"); assert.equal(context.rendering, true);
  assert.equal(h.contexts.length, 1); assert.equal(audio.paused, false);
  await h.click("暂停音频"); assert.equal(context.state, "suspended"); assert.equal(h.frames.size, 0);
});
for (const boundary of ["retry", "file", "project", "hide", "close"] as const) test(`rejected replay followed by ${boundary} closes its pending graph before late completion`, async t => {
  const h = fixture(t); const old = await warmup(h); h.holdResume(); const play = h.holdPlay();
  await h.click("播放音频"); const context = h.contexts[0]!; await h.act(() => play.fail());
  if (boundary === "retry") await h.click("重试媒体预览");
  if (boundary === "file") await h.render("new.mp3");
  if (boundary === "project") await h.render("song.mp3", "new-project");
  if (boundary === "hide") await h.hide();
  if (boundary === "close") await h.closeFile();
  assert.equal(context.state, "closed"); assert.equal(context.rendering, false);
  assert.equal(context.closed, 1); assert.equal(context.disconnected, 2); assert.equal(context.pendingResumes(), 0);
  assert.equal(old.paused, true); assert.equal(old.querySelector("source")?.getAttribute("src"), null);
  await h.act(() => context.finishResume()); assert.equal(context.state, "closed");
  assert.equal(h.frames.size, 0);
});
for (const outcome of ["success", "error"] as const) test(`close during replay handles late native ${outcome} without reviving the graph`, async t => {
  const h = fixture(t); const old = await warmup(h); h.holdResume(); const play = h.holdPlay();
  await h.click("播放音频"); const context = h.contexts[0]!;
  await h.closeFile(); await h.act(() => outcome === "success" ? play.finish() : play.fail());
  await h.act(() => context.finishResume());
  assert.equal(context.state, "closed"); assert.equal(context.rendering, false);
  assert.equal(context.pendingResumes(), 0); assert.equal(old.paused, true); assert.equal(h.frames.size, 0);
});
test("a newer playing owner is untouched by the old closed graph and late play failure", async t => {
  const h = fixture(t); const old = await warmup(h); h.holdResume(); const oldPlay = h.holdPlay();
  await h.click("播放音频"); const oldContext = h.contexts[0]!;
  await h.render("new.mp3", "new-project"); const current = await h.metadata(); const newPlay = h.holdPlay();
  await h.click("播放音频"); await h.act(newPlay.finish);
  await h.act(() => { oldContext.finishResume(); oldPlay.fail(); });
  assert.equal(oldContext.state, "closed"); assert.equal(oldContext.rendering, false); assert.equal(old.paused, true);
  assert.equal(h.contexts.length, 2); assert.equal(h.contexts[1]!.state, "running");
  assert.equal(current.paused, false); assert.equal(document.querySelector('[role="alert"]'), null);
});
