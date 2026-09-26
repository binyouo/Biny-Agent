/** 使用可控 ResizeObserver 复现开合逐帧回传 React；不测量真实浏览器 FPS。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

test("侧栏 30 帧宽度变化不提交 React，窗口缩放和最终侧栏宽度仍约束右栏", async () => {
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
  const options = { changes: [], tools: [], filePanelResizing: false, filePanelWidth: 600, sidebarFlowWidth: 260,
    projectId: "p", source: "p:s", onFilePanelResizeEnd() {}, onFilePanelResizeStart() {}, onFilePanelWidthChange() {},
    onListDirectory: async () => ({ path: ".", entries: [] }), onOpenFile() {}, onOpenBrowser: async () => {}, onFixPreview() {},
    onSwitchBranch: async () => {}, onReadFile: async () => { throw new Error("unused"); }, onWarning() {} };
  function Harness(): React.ReactNode {
    inspector = useWorkspaceInspector(options);
    React.useLayoutEffect(() => { commits++; });
    return React.createElement("div", { className: "biny-app-shell" },
      React.createElement("div", { className: "biny-sidebar-block" }), inspector.dock);
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
