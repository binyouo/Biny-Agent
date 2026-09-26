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
      projectId: "p",
      directoryStates: new Map([[".", { status: "ready" as const, entries: [{ kind: "file" as const, name: "README.md", path: "README.md" }] }]]),
      expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }));
    assert.match(html, /aria-label="筛选文件"/u);
    assert.match(html, /README\.md/u);
    assert.doesNotMatch(html, /title=|role="tooltip"/u);
    const previewHtml = renderToStaticMarkup(React.createElement(FilePreviewPanel, {
      projectId: "p", preview: { source: "p", path: "README.md", status: "loading" },
      directoryStates: new Map(), expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }));
    assert.match(previewHtml, /aria-label="关闭当前文件"/u);
    assert.doesNotMatch(previewHtml, /title=|role="tooltip"/u);
    const documentHtml = renderToStaticMarkup(React.createElement(FilePreviewPanel, {
      projectId: "p", preview: { source: "p", path: "index.html", status: "ready",
        file: { path: "index.html", content: "<p>Hi</p>", bytes: 9, binary: false, truncated: false } },
      directoryStates: new Map(), expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }));
    assert.match(documentHtml, /<iframe[^>]+aria-label="预览 index\.html"/u);
    assert.doesNotMatch(documentHtml, /title=|role="tooltip"/u);
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
  }
});
