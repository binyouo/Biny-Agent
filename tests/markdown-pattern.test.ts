/** 音乐代码通过不具宿主权限的播放器显式播放；外部音频边界使用真实 API 协议替身。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createPatternPlayerDocument } from "../src/desktop/renderer/src/patternPlayer.js";
import { PatternBlock } from "../src/desktop/renderer/src/components/PatternBlock.js";

Object.assign(globalThis, { React });

async function flushEffects(): Promise<void> {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try { await React.act(async () => {}); }
  finally { environment.IS_REACT_ACT_ENVIRONMENT = previous; }
}

test("音乐块仅将源码发给 opaque iframe，校验消息来源、令牌、状态；切换源码和卸载立即停止", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier.endsWith("?raw") ? { url: `test:${specifier}`, shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url.startsWith("test:") ? { format: "module", shortCircuit: true, source: 'export default "/* player asset */"' } : next(url, context); }
  });
  const root = createRoot(document.getElementById("root")!);
  const code = 'note("c3 e3 g3").s("sine")\n// </script><script>window.parent.biny.read()</script>';
  try {
    flushSync(() => root.render(React.createElement(PatternBlock, { code })));
    await flushEffects();
    const frame = document.querySelector("iframe")!;
    assert.ok(frame, "音乐代码必须有独立播放器");
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    assert.equal(frame.getAttribute("allow"), "autoplay");
    assert.doesNotMatch(frame.srcdoc, /window\.parent\.biny|note\("c3/);
    assert.match(frame.srcdoc, /connect-src 'none'/);
    const sent: Record<string, unknown>[] = [];
    frame.contentWindow!.postMessage = data => { sent.push(data); };
    flushSync(() => frame.dispatchEvent(new dom.window.Event("load")));
    const control = sent.find(data => data.action === "set-code")!;
    assert.ok(control);
    assert.equal(control.code, code);
    assert.equal(sent.some(data => data.action === "play"), false);
    assert.equal(typeof control.token, "string");
    const status = (source: Window | null, token: unknown, state: unknown, extras = {}) => flushSync(() => window.dispatchEvent(new dom.window.MessageEvent("message", { source, data: { kind: "pattern-state", token, state, ...extras } })));
    status(dom.window as unknown as Window, control.token, "playing");
    status(frame.contentWindow, "wrong", "playing");
    status(frame.contentWindow, control.token, "launch-host");
    status(frame.contentWindow, control.token, "playing", { command: "read-file" });
    assert.notEqual(document.querySelector(".markdown-pattern")!.getAttribute("data-state"), "playing");
    status(frame.contentWindow, control.token, "playing");
    assert.equal(document.querySelector(".markdown-pattern")!.getAttribute("data-state"), "playing");
    flushSync(() => root.render(React.createElement(PatternBlock, { code: 'note("d3").s("triangle")' })));
    assert.ok(sent.some(data => data.action === "stop"));
    assert.equal(sent.at(-1)?.code, 'note("d3").s("triangle")');
    flushSync(() => root.render(React.createElement(React.Fragment, null,
      React.createElement(PatternBlock, { key: "first", code: 'note("c3").s("sine")' }),
      React.createElement(PatternBlock, { key: "second", code: 'note("d3").s("sine")' }))));
    await flushEffects();
    const frames = [...document.querySelectorAll("iframe")];
    const controls = frames.map(() => [] as Record<string, unknown>[]);
    frames.forEach((element, i) => {
      element.contentWindow!.postMessage = data => { controls[i]!.push(data); };
      flushSync(() => element.dispatchEvent(new dom.window.Event("load")));
    });
    controls.forEach(values => values.splice(0, values.length - 1));
    status(frames[0]!.contentWindow, controls[0]![0]!.token, "loading");
    assert.equal(controls[1]!.at(-1)?.action, "stop", "新播放请求应停止其他播放器");
    status(frames[1]!.contentWindow, controls[1]![0]!.token, "loading");
    assert.equal(controls[0]!.at(-1)?.action, "stop");
    sent.length = 0;
    flushSync(() => root.unmount());
    assert.ok(controls.every(values => values.at(-1)?.action === "stop"));
    assert.equal(document.querySelector("iframe"), null);
  } finally { flushSync(() => root.unmount()); hooks.deregister(); dom.window.close(); }
});

test("停止未完成的求值不重放；更新源码后不能并发求值，旧请求完成后才重新开放播放", async () => {
  const playerSource = readFileSync(new URL("../src/desktop/renderer/src/pattern-player.js", import.meta.url), "utf8");
  const engineSource = `window.evaluated=[];window.strudel={
    getAudioContext(){return {resume:async()=>{},suspend:async()=>{}}},
    async initStrudel(){return {start(){}}},async initAudio(){},
    evaluate(code){evaluated.push(code);return new Promise(resolve=>window.complete=()=>resolve({}))},
    getAnalyserById(){return {frequencyBinCount:512,getFloatFrequencyData(data){data.fill(-70)}}},hush(){}
  };`;
  const dom = new JSDOM(createPatternPlayerDocument({ engineSource, playerSource, css: "", token: "cancel-token" }), { runScripts: "dangerously", pretendToBeVisual: true, beforeParse(window) {
    window.postMessage = () => {};
    Object.assign(window, { ResizeObserver: class { observe() {} }, });
    window.HTMLCanvasElement.prototype.getContext = (() => null) as never;
  } });
  const player = dom.window as unknown as { evaluated: string[]; complete(): void };
  const control = (action: string, code?: string) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window as unknown as Window, data: { kind: "pattern-control", token: "cancel-token", action, code } }));
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  try {
    const button = dom.window.document.querySelector<HTMLButtonElement>("button")!;
    control("set-code", "FIRST"); button.click(); await settle();
    assert.equal(player.evaluated.length, 1);
    control("set-code", "SECOND");
    assert.equal(button.disabled, true, "未完成的求值必须先取消或结束，不能并发重放");
    button.click(); await settle();
    assert.equal(player.evaluated.length, 1);
    player.complete(); await settle();
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute("aria-label"), "播放音乐");
    button.click(); await settle();
    assert.equal(player.evaluated.at(-1), "SECOND");
    player.complete(); await settle();
    assert.equal(button.getAttribute("aria-label"), "停止音乐");
  } finally { dom.window.close(); }
});

test("播放器不自动初始化或求值；用户点击才使用真实播放 API、音频分析器，停止与错误有可观察结果", async () => {
  let playerSource = "";
  try { playerSource = readFileSync(new URL("../src/desktop/renderer/src/pattern-player.js", import.meta.url), "utf8"); } catch { /* 初始播放器尚未实现。 */ }
  const fakeEngine = `window.calls=[];window.strudel={
    getAudioContext(){return {resume:async()=>{calls.push('resume')},suspend:async()=>{calls.push('suspend')}}},
    async initStrudel(options){calls.push('init');window.options=options;return {start(){calls.push('start')}}},
    async initAudio(){calls.push('audio')},
    async evaluate(code,autoplay){calls.push(['eval',code,autoplay]);if(code==='BAD'){options.onEvalError(new Error('invalid music'));return}const pattern={queryArc(){return [{value:{s:code==='SAMPLE'?'bd':code==='MAPPED'?'mapped':'sine'}}]},analyze(){return pattern}};return options.editPattern(pattern)},
    getSound(name){return name==='sine'?{data:{type:'synth'}}:name==='mapped'?{data:{type:'sample'}}:undefined},
    setLogger(callback){window.audioLog=callback},
    getAnalyserById(){calls.push('analyser');return {frequencyBinCount:512,getFloatFrequencyData(data){data.fill(-35)}}},
    hush(){calls.push('hush')}
  };`;
  const source = createPatternPlayerDocument({ engineSource: fakeEngine, playerSource, css: "", token: "music-token" });
  const messages: Record<string, unknown>[] = [];
  const draws: number[] = [];
  const dom = new JSDOM(source, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://player.invalid/", beforeParse(window) {
    window.postMessage = data => { messages.push(data); };
    Object.assign(window, { ResizeObserver: class { observe() {} disconnect() {} } });
    window.HTMLCanvasElement.prototype.getContext = (() => ({ setTransform() {}, clearRect() {}, fillRect(_x: number, _y: number, _w: number, h: number) { draws.push(h); }, beginPath() {}, roundRect(_x: number, _y: number, _w: number, h: number) { draws.push(h); }, fill() {} })) as never;
  } });
  const calls = (): unknown[] => (dom.window as unknown as { calls: unknown[] }).calls;
  const control = (code: string, token = "music-token", source: Window | null = dom.window as unknown as Window) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source, data: { kind: "pattern-control", token, action: "set-code", code } }));
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  try {
    const button = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="播放音乐"]');
    assert.ok(button, "播放器必须有真实播放入口");
    assert.equal(calls().length, 0);
    control("note('c3').s('sine')", "wrong");
    control("note('c3').s('sine')");
    assert.equal(calls().length, 0);
    button.click();
    await settle();
    assert.equal(calls().filter(call => call === "init").length, 1);
    assert.ok(calls().some(call => Array.isArray(call) && call[0] === "eval" && call[1] === "note('c3').s('sine')" && call[2] === false));
    assert.ok(calls().includes("resume"));
    assert.ok(calls().includes("audio"));
    assert.ok(calls().includes("start"));
    assert.ok(calls().includes("analyser"));
    assert.ok(messages.some(message => message.state === "playing"));
    assert.ok(draws.some(height => height > 2), "频谱必须来自分析器的实际数据");
    button.click();
    await settle();
    assert.ok(calls().includes("hush"));
    assert.equal(messages.at(-1)?.state, "stopped");
    control("BAD"); button.click(); await settle();
    assert.equal(messages.at(-1)?.state, "error");
    assert.match(String(messages.at(-1)?.message), /invalid music/);
    control("SAMPLE"); button.click(); await settle();
    assert.equal(messages.at(-1)?.state, "error");
    assert.match(String(messages.at(-1)?.message), /样本|bd/);
    control("MAPPED"); button.click(); await settle();
    assert.equal(messages.at(-1)?.state, "error", "已注册的外部样本也不能绕过播放器边界");
    assert.match(String(messages.at(-1)?.message), /样本|mapped/);
    control("NORMAL"); button.click(); await settle();
    const audioLog = (dom.window as unknown as { audioLog?: (message: string) => void }).audioLog;
    assert.equal(typeof audioLog, "function", "调度中异步发生的真实音频错误也必须可见");
    audioLog!("[webaudio] error: sound bd not found");
    assert.equal(messages.at(-1)?.state, "error");
    assert.match(String(messages.at(-1)?.message), /bd/);
    assert.match(source, /default-src 'none'/);
    assert.match(source, /form-action 'none'/);
    assert.match(source, /base-uri 'none'/);
    assert.match(source, /object-src 'none'/);
  } finally { dom.window.close(); }
});
