import assert from "node:assert/strict";
import { test } from "node:test";

test("图片阅读支持缩放、旋转和恢复适应窗口", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewPanel } = await import("../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://desktop.local" });
  let resolveImage!: (value: string) => void;
  const imagePending = new Promise<string>((resolve) => { resolveImage = resolve; });
  Object.assign(dom.window, { biny: { readInlineImage: async () => await imagePending } });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    const file = { path: "assets/photo.png", content: undefined, bytes: 10, binary: true, truncated: false };
    await React.act(async () => root.render(React.createElement(FilePreviewPanel, { projectId: "image-project", width: 600,
      preview: { source: "image-project:s", path: file.path, status: "ready", file }, directoryStates: new Map(), expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {} })));
    assert.match(document.body.textContent ?? "", /正在读取图片/u);
    await React.act(async () => { resolveImage("data:image/png;base64,AA=="); await imagePending; });
    const click = async (label: string): Promise<void> => { await React.act(async () => (document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click()); };
    const image = document.querySelector(".file-preview-image img") as HTMLImageElement;
    assert.ok(image);
    await click("放大图片");
    assert.match(image.style.transform, /scale\(1\.25\)/u);
    await click("向右旋转图片");
    assert.match(image.style.transform, /rotate\(90deg\)/u);
    await click("适应窗口");
    assert.equal(image.style.transform, "");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
