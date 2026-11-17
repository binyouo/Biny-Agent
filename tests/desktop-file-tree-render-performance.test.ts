import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopWorkspaceDirectoryEntry } from "../src/desktop/protocol.js";

test("file tree selection reuses rows without freezing mutable entries or callbacks", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewPanel } = await import("../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://desktop.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  // Count production marker derivation for fixture names, not React internals or timing.
  let markerCalls = 0;
  const lowerCase = String.prototype.toLocaleLowerCase;
  String.prototype.toLocaleLowerCase = function (...args) {
    if (/^file\d+\.txt$/u.test(String(this))) markerCalls++;
    return lowerCase.apply(this, args);
  };
  const root = createRoot(document.getElementById("root")!);
  try {
    const entries: DesktopWorkspaceDirectoryEntry[] = Array.from({ length: 100 }, (_, i) => ({ name: `file${i}.txt`, path: `file${i}.txt`, kind: "file" }));
    const props = { width: 600, projectId: "p", directoryStates: new Map([[".", { status: "ready" as const, entries }]]), expandedDirectories: new Set<string>(),
      onOpenFile() {}, onPreviewFile(_path: string) {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory(_path: string) {}, onRefresh() {}, onCollapse() {} };
    const render = async (selected: string): Promise<void> => {
      await React.act(() => root.render(React.createElement(FilePreviewPanel, { ...props, preview: { source: "p:s", path: selected, status: "loading" } })));
    };
    const selectedRow = (): HTMLButtonElement => document.querySelector('[aria-selected="true"]')!;
    const key = async (row: HTMLButtonElement, value: string): Promise<void> => {
      await React.act(() => row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true })));
    };
    await render("file0.txt");
    markerCalls = 0;
    for (let i = 1; i <= 10; i++) {
      await render(`file${i}.txt`);
      assert.equal(selectedRow().lastElementChild?.textContent, `file${i}.txt`);
    }
    assert.equal(markerCalls, 20, "only old/new selected file markers should rerender across ten selections");
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 100);

    entries[0]!.name = "renamed.md";
    let clicked = "";
    props.onPreviewFile = (path) => { clicked = `old:${path}`; };
    await render("file0.txt");
    assert.equal(selectedRow().lastElementChild?.textContent, "renamed.md");
    assert.equal(selectedRow().querySelector(".file-type-marker")?.textContent, "MD");
    await React.act(() => selectedRow().click());
    assert.equal(clicked, "old:file0.txt");
    props.onPreviewFile = (path) => { clicked = `new:${path}`; };
    await render("file0.txt");
    await React.act(() => selectedRow().click());
    assert.equal(clicked, "new:file0.txt");
    selectedRow().focus();
    await key(selectedRow(), "ArrowDown");
    assert.equal(document.activeElement?.lastElementChild?.textContent, "file1.txt");
    await key(document.activeElement as HTMLButtonElement, "ArrowUp");
    assert.equal(document.activeElement, selectedRow());

    entries[0]!.path = "folder";
    entries[0]!.kind = "directory";
    entries[0]!.name = "folder";
    props.directoryStates.set("folder", { status: "ready", entries: [{ path: "folder/child.txt", name: "child.txt", kind: "file" }] });
    let toggled = "";
    props.onToggleDirectory = (path) => { toggled = path; };
    await render("folder");
    assert.equal(selectedRow().getAttribute("aria-expanded"), "false");
    assert.equal(selectedRow().querySelector(".file-type-marker"), null);
    await key(selectedRow(), "ArrowRight");
    assert.equal(toggled, "folder");
    props.expandedDirectories = new Set(["folder"]);
    await render("folder");
    assert.equal(selectedRow().getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 101);
    toggled = "";
    await key(selectedRow(), "ArrowLeft");
    assert.equal(toggled, "folder");
    props.expandedDirectories = new Set();
    await render("folder");
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 100);
    entries.push({ name: ".hidden", path: ".hidden", kind: "file" });
    await render("file2.txt");
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 100);
    await React.act(() => (document.querySelector('[aria-label="显示隐藏文件"]') as HTMLButtonElement).click());
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 101);
    await React.act(() => (document.querySelector('[aria-label="隐藏点文件"]') as HTMLButtonElement).click());
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 100);
    entries.splice(0, 1);
    await render("file1.txt");
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 99);
    assert.equal(selectedRow().lastElementChild?.textContent, "file1.txt");
  } finally {
    String.prototype.toLocaleLowerCase = lowerCase;
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
