import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);

test("当前项目不显示常驻选中底色，切换项目不留下灰色高亮块", async () => {
  const dom = new JSDOM('<div class="biny-project-row-wrap"></div><div class="biny-project-row-wrap is-active"></div>');
  try {
    await loadStyles(dom);
    const rows = dom.window.document.querySelectorAll(".biny-project-row-wrap");
    assert.equal(dom.window.getComputedStyle(rows[1]!).background, dom.window.getComputedStyle(rows[0]!).background);
  } finally {
    dom.window.close();
  }
});

async function loadStyles(dom: JSDOM): Promise<void> {
  const entry = new URL("styles/layers.css", renderer);
  const source = await readFile(entry, "utf8");
  // jsdom 不计算 cascade layer；按生产入口顺序装入本地样式，验证几何声明而非视觉效果。
  for (const match of source.matchAll(/@import "(\.\.?\/[^"]+\.css)"/gu)) {
    const style = dom.window.document.createElement("style");
    style.textContent = await readFile(new URL(match[1]!, entry), "utf8");
    dom.window.document.head.append(style);
  }
}

test("切换皮肤不会恢复当前项目的选中底色、阴影或描边", async () => {
  const dom = new JSDOM('<div class="biny-sidebar-card"><button class="biny-project-row">项目</button><button class="biny-project-row is-active">当前项目</button></div>');
  try {
    await loadStyles(dom);
    for (const file of ["retro.css", "retro-layout.css"]) {
      const style = dom.window.document.createElement("style");
      style.textContent = await readFile(new URL(`styles/${file}`, renderer), "utf8");
      dom.window.document.head.append(style);
    }
    for (const skin of ["win98", "winxp", "longhorn", "longhorn-dark"]) {
      dom.window.document.documentElement.setAttribute("data-appearance-skin", skin);
      const rows = dom.window.document.querySelectorAll("button");
      const plain = dom.window.getComputedStyle(rows[0]!);
      const selected = dom.window.getComputedStyle(rows[1]!);
      for (const property of ["background", "background-image", "box-shadow", "outline"]) {
        assert.equal(selected.getPropertyValue(property), plain.getPropertyValue(property), `${skin}: ${property}`);
      }
    }
  } finally {
    dom.window.close();
  }
});

test("消息操作的普通、菜单展开和复制成功状态保持等宽高圆形，防止局部圆角覆盖", async () => {
  const dom = new JSDOM('<main class="biny-root"><div class="biny-chat-scroll"><button class="user-message-action">复制</button><button class="user-message-action" aria-expanded="true">更多</button><button class="assistant-action is-copied">已复制</button></div></main>');
  try {
    await loadStyles(dom);
    for (const button of dom.window.document.querySelectorAll("button")) {
      const style = dom.window.getComputedStyle(button);
      assert.equal(style.borderRadius, "50%", button.outerHTML);
      assert.equal(style.width, style.height, button.outerHTML);
      assert.equal(style.padding, "0px", button.outerHTML);
    }
  } finally {
    dom.window.close();
  }
});

test("圆形反馈覆盖工具栏、设置和资源预览的图标入口，文字操作与开关不被误判", async () => {
  const dom = new JSDOM(`<main class="biny-root">
    <div class="biny-chat-scroll">
      <button data-round class="copy-button"><svg></svg></button>
      <button data-text class="copy-button"><svg></svg><span class="copy-button-text">复制代码</span></button>
      <button data-round class="chat-activity-chevron"><svg></svg></button>
      <button data-round class="chat-activity-mode is-active"><svg></svg></button>
      <div class="markdown-infographic-actions"><button data-round><svg></svg></button></div>
      <div class="markdown-diagram-actions"><button data-round><svg></svg></button></div>
      <details class="markdown-action-menu"><summary data-round><svg></svg></summary><div><button data-text>下载 SVG</button></div></details>
      <button data-round class="markdown-table-trigger"><svg></svg></button>
      <button data-round class="markdown-download"><svg></svg></button><button data-text class="markdown-download">下载原图</button>
      <div class="markdown-image-lightbox-controls"><button data-round><svg></svg></button></div>
    </div>
    <div class="biny-sidebar is-compact"><button data-round class="biny-sidebar-section-trigger"><svg></svg></button><footer class="biny-sidebar-footer"><button data-round class="biny-sidebar-settings-item"><svg></svg></button></footer></div>
    <button data-round class="biny-sidebar-session-toggle" aria-expanded="true"><svg></svg></button>
    <button data-round class="biny-inspector-tab is-compact is-active"><svg></svg></button>
    <button data-round class="biny-inspector-rail-btn"><svg></svg></button>
    <button data-round class="biny-composer-add"><span><svg></svg></span></button>
    <button data-round class="biny-capabilities-pill"><span><svg></svg></span></button>
    <button data-text class="biny-capabilities-pill"><span><svg></svg><span class="biny-capabilities-count">12</span></span></button>
    <button data-round class="biny-send-button is-stop"><span><svg></svg></span></button>
    <button data-round class="biny-queued-message-delete"><svg></svg></button>
    <div class="desktop-settings-dialog"><div class="settings-modal">
      <button data-round class="icon-button settings-close-button"><svg></svg></button>
      <button data-round class="activity-icon-button" disabled><svg></svg></button>
      <div class="biny-mcp-row-actions"><button data-round><svg></svg></button></div>
      <button data-round class="provider-delete-button"><svg></svg></button>
      <button data-round class="provider-test-button is-testing"><svg></svg></button>
      <button data-round class="provider-test-button" aria-expanded="true"><svg></svg><svg class="provider-test-caret"></svg></button>
      <div class="provider-icon-grid"><button data-grid-round class="provider-icon-cell is-selected"><svg></svg></button></div>
      <div class="settings-search"><button data-round><svg></svg></button></div>
      <div class="activity-application-picker-heading"><button data-round class="ghost-button"><svg></svg></button></div>
      <div class="import-preview-dialog"><header><button data-round><svg></svg></button></header></div>
      <button data-text class="settings-secondary-button">保存设置</button><button data-text class="model-toggle" role="switch"><span></span></button>
    </div></div>
    <div class="biny-skill-dialog-heading"><button data-round><svg></svg></button></div>
    <div class="biny-skill-repository-row"><button data-round><svg></svg></button></div>
    <div class="inspector-subtoolbar"><button data-round aria-label="刷新"><svg></svg></button><button data-text>展开</button><button data-text><svg></svg>源码</button></div>
    <div class="inspector-browser-history"><button data-round><svg></svg></button><div class="inspector-profile-anchor"><button data-round><svg></svg></button><div class="inspector-profile-picker"><button data-text><svg></svg><span>Chrome</span></button></div></div></div>
    <div class="inspector-subtoolbar"><button data-text class="inspector-browser-preview-action"><svg></svg>运行预览</button></div>
    <div class="inspector-browser-tab"><button data-text><svg></svg><span>网页标题</span></button><button data-round><svg></svg></button></div>
    <div class="inspector-terminal-tab"><button data-text><svg></svg>终端 1</button><button data-round><svg></svg></button></div>
    <div class="file-media-controls"><button data-round><svg></svg></button></div>
    <div class="file-browser-current-path"><button data-round><svg></svg></button></div>
    <div class="file-browser-path-actions"><button data-round><span><svg></svg></span></button></div>
    <div class="file-preview-meta-actions"><button data-text class="file-preview-run"><svg></svg>运行页面</button><button data-round class="copy-button"><svg></svg></button></div>
    <div class="biny-project-suggestion-banner"><button data-text>看看草稿</button><button data-round aria-label="先不处理"><svg></svg></button></div>
    <button data-round class="quickchat-icon-button"><svg></svg></button><button data-round class="quickchat-context-toggle"><svg></svg></button><button data-round class="quickchat-send"><svg></svg></button>
  </main>`);
  try {
    await loadStyles(dom);
    for (const button of dom.window.document.querySelectorAll("[data-round]")) {
      const style = dom.window.getComputedStyle(button);
      assert.equal(style.borderRadius, "50%", button.outerHTML);
      assert.equal(style.width, style.height, button.outerHTML);
      assert.equal(style.padding, "0px", button.outerHTML);
      assert.equal(style.flexShrink, "0", button.outerHTML);
    }
    for (const button of dom.window.document.querySelectorAll("[data-text]")) {
      assert.notEqual(dom.window.getComputedStyle(button).borderRadius, "50%", button.outerHTML);
    }
    for (const button of dom.window.document.querySelectorAll("[data-grid-round]")) {
      const style = dom.window.getComputedStyle(button);
      assert.equal(style.borderRadius, "50%", button.outerHTML);
      assert.equal(style.aspectRatio, "1 / 1", "图标网格随列宽缩放，保持正方形而非固定像素尺寸");
    }
  } finally {
    dom.window.close();
  }
});
