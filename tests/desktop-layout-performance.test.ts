/** 使用可控 ResizeObserver 复现开合逐帧回传 React；不测量真实浏览器 FPS。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

test("侧栏开合与宽度变化不重复遍历文件内容，窗口缩放仍约束右栏", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const imports = registerHooks({ load(url, context, next) {
    if (url.includes("/@xterm/xterm/")) return { format: "module", source: "export class Terminal {}", shortCircuit: true };
    if (url.includes("/@xterm/addon-fit/")) return { format: "module", source: "export class FitAddon {}", shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://localhost" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const observers = new Set<ResizeObserver>();
  class ResizeObserver {
    targets = new Set<Element>();
    constructor(readonly callback: () => void) { observers.add(this); }
    observe(target: Element): void { this.targets.add(target); }
    disconnect(): void { observers.delete(this); }
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { useWorkspaceInspector } = await import("../src/desktop/renderer/src/components/workspace/useWorkspaceInspector.js");
  let inspector!: ReturnType<typeof useWorkspaceInspector>;
  let commits = 0;
  let fileCommits = 0;
  let fileNameReads = 0;
  let previewMetadataReads = 0;
  let directoryRevision = 0;
  let fileRevision = 0;
  const snapshot = () => ({ fileNameReads, previewMetadataReads });
  const options = { changes: [], tools: [], filePanelResizing: false, filePanelWidth: 600, sidebarFlowWidth: 260,
    projectId: "p", source: "p:s", onFilePanelResizeEnd() {}, onFilePanelResizeStart() {}, onFilePanelWidthChange() {},
    onListDirectory: async () => ({ path: ".", entries: Array.from({ length: 400 }, (_, index) => {
      const name = `file-${index}${directoryRevision ? "-updated" : ""}.ts`;
      return { kind: "file" as const, get name() { fileNameReads++; return name; }, path: `file-${index}.ts` };
    }) }), onOpenFile() {}, onOpenBrowser: async () => {}, onFixPreview() {},
    onSwitchBranch: async () => {}, onReadFile: async (path: string) => ({ path, content: `const revision = ${fileRevision};`, binary: false, truncated: false,
      get bytes() { previewMetadataReads++; return 20; } }), onWarning() {} };
  function Harness(): React.ReactNode {
    inspector = useWorkspaceInspector(options);
    React.useLayoutEffect(() => { commits++; });
    return React.createElement("div", { className: "biny-app-shell" },
      React.createElement("div", { className: "biny-sidebar-block" }),
      React.createElement(React.Profiler, { id: "files", onRender: () => { fileCommits++; } }, inspector.dock));
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async (): Promise<void> => { await React.act(() => root.render(React.createElement(Harness))); };
  const resize = async (target: Element): Promise<void> => {
    await React.act(() => { for (const observer of observers) if (observer.targets.has(target)) observer.callback(); });
  };
  try {
    await render();
    const shell = document.querySelector<HTMLElement>(".biny-app-shell")!;
    const sidebar = document.querySelector<HTMLElement>(".biny-sidebar-block")!;
    let width = 1200;
    let animatedSidebar = 260;
    Object.defineProperty(shell, "clientWidth", { get: () => width });
    sidebar.getBoundingClientRect = () => ({ width: animatedSidebar }) as DOMRect;
    await React.act(async () => inspector.openFiles());
    const baseline = commits;
    for (let index = 0; index < 30; index++) { animatedSidebar = 250 - index * 8; await resize(sidebar); }
    console.log(JSON.stringify({ workload: "30 sidebar animation resize notifications", commits: commits - baseline }));
    assert.equal(commits - baseline, 0, "CSS 插值不能触发整棵 App 的 React 提交");
    assert.equal(inspector.layout.width, 423);
    options.sidebarFlowWidth = 0;
    await render();
    assert.equal(inspector.layout.width, 540);
    width = 900;
    await resize(shell);
    assert.equal(inspector.layout.width, 405);
    options.sidebarFlowWidth = 260;
    await render();
    assert.equal(inspector.layout.width, 280, "仍需为聊天保留 360px");
    // 文件面板已经访问后，开合插值不能重排文件树或改写用户选择的树宽。
    width = 1800;
    options.sidebarFlowWidth = 0;
    await render();
    await resize(shell);
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 400);
    const body = document.querySelector<HTMLElement>(".file-browser-body")!;
    let animatedPanel = 600;
    Object.defineProperty(body, "clientWidth", { get: () => animatedPanel });
    await resize(body);
    const fileBaseline = fileCommits;
    for (let index = 0; index < 30; index++) {
      animatedPanel = 600 - index * 20;
      await resize(body);
    }
    animatedPanel = 600;
    await resize(body);
    console.log(JSON.stringify({ workload: "30 file panel animation resize notifications", commits: fileCommits - fileBaseline }));
    assert.equal(fileCommits - fileBaseline, 0, "文件区不应订阅动画中间宽度");
    assert.equal(document.querySelector<HTMLElement>(".file-browser-tree")!.style.width, "200px", "收放不得缩小已保存的文件树宽度");
    assert.equal(body.classList.contains("is-tree-hidden"), false);
    options.filePanelWidth = 400;
    await render();
    assert.equal(body.classList.contains("is-browser-only"), true, "真实目标宽度变窄仍切换文件列表布局");
    options.filePanelWidth = 600;
    await render();
    assert.equal(document.querySelector<HTMLElement>(".file-browser-tree")!.style.width, "200px");
    // 已读取的文件在左右栏开合时保持内容与滚动位置；只重新计算外层布局。
    width = 1400;
    await resize(shell);
    await React.act(async () => inspector.previewFile("file-1.ts"));
    const tree = document.querySelector<HTMLElement>(".file-browser-tree")!;
    tree.scrollTop = 560;
    const readsBeforeToggle = snapshot();
    for (let index = 0; index < 5; index++) {
      await React.act(() => document.querySelector<HTMLButtonElement>('[aria-label="收起工作区工具"]')!.click());
      await React.act(() => inspector.openFiles());
      options.sidebarFlowWidth = 260;
      await render();
      options.sidebarFlowWidth = 0;
      await render();
    }
    const readsAfterToggle = snapshot();
    console.log(JSON.stringify({ workload: "5 left/right sidebar open-close cycles with 400 files and a preview",
      fileNameReads: readsAfterToggle.fileNameReads - readsBeforeToggle.fileNameReads,
      previewMetadataReads: readsAfterToggle.previewMetadataReads - readsBeforeToggle.previewMetadataReads }));
    assert.deepEqual(readsAfterToggle, readsBeforeToggle, "开合不能重新遍历未变化的文件树或重建预览");
    assert.equal(tree.scrollTop, 560);
    assert.equal(document.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent?.includes("file-1.ts"), true);
    assert.match(document.querySelector(".file-preview-code")!.textContent!, /revision = 0/u);
    directoryRevision++;
    fileRevision++;
    await React.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click());
    assert.ok(fileNameReads > readsAfterToggle.fileNameReads, "真实文件变化仍需更新树");
    assert.ok(previewMetadataReads > readsAfterToggle.previewMetadataReads, "刷新仍需显示新的文件内容");
    assert.equal(document.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent?.includes("file-1-updated.ts"), true);
    assert.match(document.querySelector(".file-preview-code")!.textContent!, /revision = 1/u);
  } finally {
    await React.act(() => root.unmount());
    assert.equal(observers.size, 0);
    dom.window.close(); imports.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
