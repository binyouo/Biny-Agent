import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";

const assets = registerHooks({ load(url, context, next) {
  return url.endsWith(".png") ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
} });
const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
assets.deregister();

const content = "# 检查结果\n\n**保留原文** [链接](https://example.com)\n末行\n";
const plain = "检查结果\n\n保留原文 链接\n末行";
const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(writeText: (value: string) => Promise<void>, fallback: () => boolean) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://biny.test", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText } });
  dom.window.document.execCommand = fallback;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const turn: TimelineTurn = { id: "turn", user: "", assistant: content, assistantMessageId: "answer", reasoning: "", skills: [], status: "completed", tools: [], steps: [] };
  const render = async (overrides: Partial<React.ComponentProps<typeof MessageTimeline>> = {}) => {
    await act(() => root.render(React.createElement(MessageTimeline, {
      projectId: "project", sessionId: "session", turns: [turn], thinking: false,
      onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
      onAddQuoteToConversation: asyncNoop, onResolvePermission: asyncNoop, onRetry: asyncNoop,
      onSwitchVersion: asyncNoop, onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop,
      ...overrides
    })));
  };
  const button = (text: string) => {
    const found = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === text || element.getAttribute("aria-label") === text);
    assert.ok(found, `button ${text} must be rendered`);
    return found;
  };
  const click = async (text: string) => { await act(() => button(text).click()); };
  await render();
  return { dom, turn, render, button, click, async close() {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

test("异步剪贴板与系统回退均失败时不显示复制成功，保留菜单供用户重试", async () => {
  const writes: string[] = [];
  let fallbacks = 0;
  const h = await harness(async value => { writes.push(value); throw new Error("clipboard denied"); }, () => { fallbacks++; return false; });
  try {
    await h.click("更多回复操作");
    await h.click("复制为 Markdown");
    assert.equal(h.button("复制为 Markdown").classList.contains("is-success"), false, "拒绝写入不能报告成功");
    assert.match(h.dom.window.document.querySelector('[role="alert"]')?.textContent ?? "", /复制失败.*重试/u);
    assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "true");
    assert.deepEqual(writes, [content]);
    assert.equal(fallbacks, 1);
  } finally { await h.close(); }
});

test("复制等待期间禁用两个格式入口并合并重复点击，成功后才展示对勾和关闭菜单", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = deferred<void>();
  const writes: string[] = [];
  const h = await harness(value => { writes.push(value); return operation.promise; }, () => { throw new Error("unexpected fallback"); });
  try {
    await h.click("更多回复操作");
    await act(() => { h.button("复制为 Markdown").click(); h.button("复制为 Markdown").click(); h.button("复制为纯文本").click(); });
    assert.deepEqual(writes, [content], "等待中的同一复制不能重复写入或被另一格式覆盖");
    assert.equal(h.button("复制为 Markdown").disabled, true);
    assert.equal(h.button("复制为 Markdown").textContent, "正在复制…");
    assert.equal(h.button("复制为纯文本").disabled, true);
    assert.equal(h.button("复制为 Markdown").getAttribute("aria-busy"), "true");
    assert.equal(Boolean(h.dom.window.document.querySelector(".is-success")), false);
    await act(() => context.mock.timers.tick(2_000));
    assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "true", "等待时不运行成功关闭计时器");
    await act(() => operation.resolve());
    assert.equal(h.button("复制为 Markdown").classList.contains("is-success"), true);
    assert.equal(h.button("复制为 Markdown").disabled, false);
    await act(() => context.mock.timers.tick(799));
    assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "true");
    await act(() => context.mock.timers.tick(1));
    assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "false");
  } finally { await act(() => operation.resolve()); await h.close(); }
});

test("失败保留当前格式供显式重试，Markdown 和纯文本字节不被反馈逻辑改变", async () => {
  for (const [label, expected] of [["复制为 Markdown", content], ["复制为纯文本", plain]]) {
    const writes: string[] = [];
    const fallbackValues: string[] = [];
    const h = await harness(async value => { writes.push(value); if (writes.length === 1) throw new Error("denied"); }, () => {
      fallbackValues.push((document.activeElement as HTMLTextAreaElement).value);
      return false;
    });
    try {
      await h.click("更多回复操作");
      await h.click(label!);
      assert.ok(h.dom.window.document.querySelector('[role="alert"]'));
      assert.deepEqual(writes, [expected]);
      assert.deepEqual(fallbackValues, [expected]);
      await h.click(label!);
      assert.deepEqual(writes, [expected, expected]);
      assert.equal(Boolean(h.dom.window.document.querySelector('[role="alert"]')), false);
      assert.equal(h.button(label!).classList.contains("is-success"), true);
      assert.equal(Boolean(h.dom.window.document.querySelector("textarea")), false);
    } finally { await h.close(); }
  }
});

test("异步 API 拒绝但系统回退成功时，真实回退写入后才报告所选格式成功", async () => {
  const operation = deferred<void>();
  const fallbackValues: string[] = [];
  const h = await harness(() => operation.promise, () => {
    fallbackValues.push((document.activeElement as HTMLTextAreaElement).value);
    return true;
  });
  try {
    await h.click("更多回复操作");
    await h.click("复制为纯文本");
    assert.equal(Boolean(h.dom.window.document.querySelector(".is-success")), false);
    await act(() => operation.reject(new Error("denied")));
    assert.deepEqual(fallbackValues, [plain]);
    assert.equal(h.button("复制为纯文本").classList.contains("is-success"), true);
    assert.equal(h.button("复制为 Markdown").classList.contains("is-success"), false);
    assert.equal(Boolean(h.dom.window.document.querySelector('[role="alert"]')), false);
    assert.equal(Boolean(h.dom.window.document.querySelector("textarea")), false);
  } finally { await act(() => operation.resolve()); await h.close(); }
});

for (const outcome of ["success", "failure"] as const) {
  test(`菜单关闭重开后旧请求${outcome}不能覆盖新请求或关闭新菜单`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const old = deferred<void>();
    const current = deferred<void>();
    const writes: string[] = [];
    const h = await harness(value => { writes.push(value); return writes.length === 1 ? old.promise : current.promise; }, () => false);
    try {
      await h.click("更多回复操作");
      await h.click("复制为 Markdown");
      await act(() => { h.dom.window.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      await h.click("更多回复操作");
      assert.equal(h.button("复制为纯文本").disabled, false, "新菜单不继承旧请求的等待状态");
      await h.click("复制为纯文本");
      await act(() => { if (outcome === "success") old.resolve(); else old.reject(new Error("old denied")); });
      assert.equal(h.button("复制为纯文本").getAttribute("aria-busy"), "true");
      assert.equal(Boolean(h.dom.window.document.querySelector(".is-success")), false);
      assert.equal(Boolean(h.dom.window.document.querySelector('[role="alert"]')), false);
      await act(() => context.mock.timers.tick(1_000));
      assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "true");
      await act(() => current.resolve());
      assert.equal(h.button("复制为纯文本").classList.contains("is-success"), true);
      assert.deepEqual(writes, [content, plain]);
    } finally { await act(() => { old.resolve(); current.resolve(); }); await h.close(); }
  });
}

test("上次成功的关闭计时器不能结束后一次复制或重新打开的菜单", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const next = deferred<void>();
  let calls = 0;
  const h = await harness(async () => { if (++calls === 2) await next.promise; }, () => false);
  try {
    await h.click("更多回复操作");
    await h.click("复制为 Markdown");
    await act(() => context.mock.timers.tick(400));
    await h.click("复制为纯文本");
    await act(() => context.mock.timers.tick(400));
    assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "true", "新请求应取消旧成功计时器");
    assert.equal(h.button("复制为纯文本").getAttribute("aria-busy"), "true");
    await act(() => next.resolve());
    await h.click("更多回复操作");
    await h.click("更多回复操作");
    await act(() => context.mock.timers.tick(800));
    assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "true", "关闭重开后的菜单不再属于旧成功计时器");
    assert.equal(Boolean(h.dom.window.document.querySelector(".is-success")), false);
  } finally { await act(() => next.resolve()); await h.close(); }
});

for (const changed of ["content", "message", "session", "project", "unmount"] as const) {
  test(`${changed} 改变后旧复制结果不泄露到新的回复操作`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const operation = deferred<void>();
    const h = await harness(() => operation.promise, () => false);
    try {
      await h.click("更多回复操作");
      await h.click("复制为 Markdown");
      await h.render(changed === "content" ? { turns: [{ ...h.turn, assistant: "更新后的回复" }] }
        : changed === "message" ? { turns: [{ ...h.turn, assistantMessageId: "second-answer" }] }
          : changed === "session" ? { sessionId: "second-session" }
            : changed === "project" ? { projectId: "second-project" }
              : { turns: [] });
      await act(() => operation.resolve());
      assert.equal(Boolean(h.dom.window.document.querySelector(".is-success")), false);
      assert.equal(Boolean(h.dom.window.document.querySelector('[aria-busy="true"]')), false);
      await act(() => context.mock.timers.tick(1_000));
      if (changed !== "unmount") assert.equal(h.button("更多回复操作").getAttribute("aria-expanded"), "true");
    } finally { await act(() => operation.resolve()); await h.close(); }
  });
}
