/** 压缩反馈的 DOM 归属和尺寸契约；真实位置与动效由用户人工验收。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Workspace } from "../src/desktop/renderer/src/components/Workspace.js";
import { CompactionDivider } from "../src/desktop/renderer/src/components/chat/CompactionDivider.js";
import { CompactionStatus } from "../src/desktop/renderer/src/components/chat/CompactionStatus.js";

Object.assign(globalThis, { React });
const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;

test("手动压缩进度位于聊天内容列末尾，并取代通用等待动画", () => {
  const props: React.ComponentProps<typeof Workspace> = {
    projectId: "project", sessionId: "session", turns: [], loading: false,
    runtimePanelOpen: false, thinking: true, running: false, compacting: true,
    compactionState: { status: "pending", message: "正在压缩上下文" },
    onOpenProject: noop, onPreviewFile: noop, onRuntimePanelOpenChange: noop,
    onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
    onAddQuoteToConversation: asyncNoop, onResolvePermission: asyncNoop,
    onRetry: asyncNoop, onSwitchVersion: asyncNoop, onEditRequest: noop,
    onCreateBranch: asyncNoop, onRollbackFiles: noop, onRuntimeError: noop,
    onRuntimeMutation: asyncNoop, onRuntimeRefresh: asyncNoop,
    onOpenRuntime: noop, onOpenExtensions: noop,
  };
  for (const status of [undefined, "running", "waiting_permission"] as const) {
    const turns = status ? [{ id: "previous-turn", user: "上一轮请求", assistant: "", reasoning: "", skills: [], status, tools: [], steps: [] }] : [];
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(Workspace, { ...props, turns })));
    try {
      const progress = dom.window.document.querySelector(".chat-compaction-status");
      assert.ok(progress);
      assert.equal(progress.parentElement?.className, "message-timeline", "进度应跟随聊天内容列，而非单独居中");
      assert.equal(progress.parentElement?.lastElementChild, progress);
      assert.equal(dom.window.document.querySelectorAll(".chat-compaction-status").length, 1);
      assert.equal(dom.window.document.querySelectorAll(".chat-run-status").length, 0, `旧回合投影 ${status ?? "empty"} 不应补出第二条进度`);
      const orb = progress.querySelector("canvas")!;
      assert.equal(orb.style.width, "16px");
      assert.equal(orb.style.height, "16px");
    } finally { dom.window.close(); }
  }
});

test("完成压缩使用紧凑的内容宽度分隔条，进度不再自设居中内容列", async () => {
  const sources = await Promise.all(["styles.css", "styles/biny.css", "styles/chat.css"].map(path =>
    readFile(new URL(`../src/desktop/renderer/src/${path}`, import.meta.url), "utf8")));
  const html = renderToStaticMarkup(React.createElement(CompactionDivider, { count: 4, summary: "保留当前目标" }));
  const pending = renderToStaticMarkup(React.createElement(CompactionStatus, { state: { status: "pending", message: "正在压缩上下文" } }));
  const dom = new JSDOM(`<head></head><body><div class="biny-chat-scroll"><div class="message-timeline">${html}${pending}</div></div></body>`);
  try {
    for (const source of sources) {
      const style = dom.window.document.createElement("style");
      style.textContent = source;
      dom.window.document.head.append(style);
    }
    const pill = dom.window.getComputedStyle(dom.window.document.querySelector(".chat-compaction-pill")!);
    assert.equal(pill.fontSize, "calc(12px * var(--font-scale, 1))");
    assert.equal(pill.lineHeight, "calc(16px * var(--font-scale, 1))");
    assert.equal(pill.padding, "4px 10px");
    assert.equal(pill.gap, "8px");
    assert.equal(pill.width, "fit-content");
    assert.equal(pill.maxWidth, "100%");
    const divider = dom.window.getComputedStyle(dom.window.document.querySelector(".chat-compaction")!);
    assert.equal(divider.padding, "8px 16px");
    const progress = dom.window.getComputedStyle(dom.window.document.querySelector(".chat-compaction-status")!);
    assert.notEqual(progress.maxWidth, "42rem");
    assert.notEqual(progress.marginInline, "auto");
    const label = dom.window.getComputedStyle(dom.window.document.querySelector(".chat-compaction-status > span")!);
    assert.equal(label.flexGrow, "0", "文字扫光不能铺满剩余行宽");
  } finally { dom.window.close(); }
});

test("展开摘要保持紧凑排版，普通助手正文使用共享排版", async () => {
  const sources = await Promise.all(["markdown-content.css", "chat.css"].map(path =>
    readFile(new URL(`../src/desktop/renderer/src/styles/${path}`, import.meta.url), "utf8")));
  const dom = new JSDOM('<head></head><body><div class="biny-chat-scroll"><div class="chat-compaction-body"><div class="markdown-body"><h1>当前目标</h1><h2>后续工作</h2><p>继续完成实现。</p><ul><li>验证结果</li></ul></div></div><div class="agent-response"><div class="markdown-body"><h1>正常回复</h1></div></div></div></body>');
  try {
    for (const css of sources) {
      const style = dom.window.document.createElement("style");
      style.textContent = css;
      dom.window.document.head.append(style);
    }
    const computed = (selector: string) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    assert.equal(computed(".chat-compaction-body .markdown-body").fontSize, "calc(12px * var(--font-scale, 1))");
    for (const heading of ["h1", "h2"]) {
      assert.equal(computed(`.chat-compaction-body ${heading}`).fontSize, "calc(14px * var(--font-scale, 1))");
    }
    assert.equal(computed(".chat-compaction-body p").margin, "4px 0px");
    assert.equal(computed(".chat-compaction-body ul").margin, "4px 0px 0px");
    assert.equal(computed(".chat-compaction-body li").margin, "2px 0px");
    assert.equal(computed(".agent-response .markdown-body").fontSize, "var(--markdown-unit)");
    assert.notEqual(computed(".agent-response h1").fontSize, computed(".chat-compaction-body h1").fontSize);
    assert.equal(computed(".agent-response h1").marginBlock, "calc(var(--markdown-unit) * 1.5) calc(var(--markdown-unit) * .5)");
  } finally { dom.window.close(); }
});
