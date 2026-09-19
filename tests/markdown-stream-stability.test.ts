/**
 * 流式 Markdown 渲染的 DOM 稳定性。
 *
 * react-markdown 把 `components` 里的函数直接当作 React 元素类型；如果每次渲染都内联重建
 * components，表格/链接/代码块子树会在流式期间每帧卸载重建，配合入场动画表现为持续闪烁。
 * 回归锁定：内容按打字机方式增长时，表格与链接必须是同一批 DOM 节点被原地更新。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** 先装好 DOM 全局再动态加载 react-dom/client（静态 import 会被提升到全局就绪之前）。 */
async function setupDom(): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
    url: "https://localhost/"
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "Node", "Element", "HTMLElement", "SVGElement", "DocumentFragment", "MutationObserver", "getComputedStyle"]) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) globals[key] = value;
  }
  // Node 21+ 的 globalThis.navigator 是只读 getter，只能 defineProperty 覆盖。
  Object.defineProperty(globals, "navigator", { configurable: true, value: dom.window.navigator });
}

test("内容流式增长时表格与链接的 DOM 节点保持同一实例，不整棵重建", async () => {
  await setupDom();
  const { createElement } = await import("react");
  const { flushSync } = await import("react-dom");
  const { createRoot } = await import("react-dom/client");
  const { MarkdownContent } = await import("../src/desktop/renderer/src/components/MarkdownContent.js");

  const container = document.getElementById("root")!;
  const root = createRoot(container);
  const props = {
    projectId: "project",
    onOpenExternal: () => undefined,
    onPreviewFile: () => undefined
  };
  const render = (content: string): void => {
    flushSync(() => root.render(createElement(MarkdownContent, { ...props, content })));
  };

  // Given：一段已流出的表格（表头 + 分隔行 + 首行数据）。
  const base = "结果如下：\n\n| 文件 | 状态 |\n| --- | --- |\n";
  render(`${base}| a.ts | 完成 |`);
  const wrapper = document.querySelector(".markdown-table");
  const table = wrapper?.querySelector("table");
  const firstCell = wrapper?.querySelector("td");
  assert.ok(wrapper && table && firstCell);

  // When：打字机继续追加表格行、结尾段落和链接（每一步都以前一步为前缀）。
  render(`${base}| a.ts | 完成 |\n| b.ts | 完成 |`);
  const withParagraph = `${base}| a.ts | 完成 |\n| b.ts | 完成 |\n\n[链接](https://example.com)`;
  render(withParagraph);
  const anchor = document.querySelector("a");
  assert.ok(anchor);
  render(`${withParagraph}\n\n完毕。`);

  // Then：自始至终是同一批节点被原地更新，没有卸载重建。
  assert.equal(document.querySelector(".markdown-table"), wrapper);
  assert.equal(wrapper.querySelector("table"), table);
  assert.equal(wrapper.querySelector("td"), firstCell);
  assert.equal(document.querySelector("a"), anchor);
  assert.equal(firstCell.textContent, "a.ts");
  assert.equal(anchor.getAttribute("href"), "https://example.com");
  assert.match(wrapper.textContent ?? "", /b\.ts/u);
});
