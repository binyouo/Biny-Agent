/** 文件区已有可见名称，避免重复的鼠标悬停提示。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("文件树和工具栏不挂载悬停提示，图标仍有可访问名称", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { FilePreviewPanel } = await import("../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const html = renderToStaticMarkup(React.createElement(FilePreviewPanel, {
      width: 600, projectId: "p",
      directoryStates: new Map([[".", { status: "ready" as const, entries: [{ kind: "file" as const, name: "README.md", path: "README.md" }] }]]),
      expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }));
    assert.match(html, /aria-label="筛选文件"/u);
    assert.match(html, /README\.md/u);
    assert.doesNotMatch(html, /title=|role="tooltip"/u);
    const previewHtml = renderToStaticMarkup(React.createElement(FilePreviewPanel, {
      width: 600, projectId: "p", preview: { source: "p", path: "README.md", status: "loading" },
      directoryStates: new Map(), expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }));
    assert.match(previewHtml, /aria-label="关闭当前文件"/u);
    assert.doesNotMatch(previewHtml, /title=|role="tooltip"/u);
    const errorHtml = renderToStaticMarkup(React.createElement(FilePreviewPanel, {
      width: 600, projectId: "p", preview: { source: "p", path: "broken.html", status: "error", error: "读取失败" },
      directoryStates: new Map(), expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }));
    assert.match(errorHtml, /读取失败/u);
    assert.match(errorHtml, /重试读取/u);
    const documentHtml = renderToStaticMarkup(React.createElement(FilePreviewPanel, {
      width: 600, projectId: "p", preview: { source: "p", path: "index.html", status: "ready",
        file: { path: "index.html", content: "<p>Hi</p>", bytes: 9, binary: false, truncated: false } },
      directoryStates: new Map(), expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }));
    assert.match(documentHtml, /class="file-preview-code"/u);
    const { JSDOM } = await import("jsdom");
    const rendered = new JSDOM(documentHtml);
    try {
      assert.ok(rendered.window.document.querySelector(".file-browser-content > .file-browser-path"), "路径栏属于预览列，文件树应从顶端开始");
      assert.ok(rendered.window.document.querySelector(".file-browser-content > .file-browser-preview-scroll"));
    } finally { rendered.window.close(); }
    assert.match(documentHtml, /运行页面/u);
    assert.doesNotMatch(documentHtml, /<iframe/u);
    assert.doesNotMatch(documentHtml, /title=|role="tooltip"/u);
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
  }
});
