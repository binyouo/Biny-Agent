/** 在提交阶段读取面板，确保不用等 effect 或下一帧才与布局同步。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

test("展开首帧就挂载面板并隐藏 rail；关闭与快速重开不遗留宽度或延迟状态", async () => {
  const cssHook = registerHooks({ load(url, context, next) {
    if (url.includes("/@xterm/xterm/")) return { format: "module", source: "export class Terminal {}", shortCircuit: true };
    if (url.includes("/@xterm/addon-fit/")) return { format: "module", source: "export class FitAddon {}", shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://localhost/" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  dom.window.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  dom.window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const { createRoot } = await import("react-dom/client");
  const { useWorkspaceInspector } = await import("../src/desktop/renderer/src/components/workspace/useWorkspaceInspector.js");
  let inspector: ReturnType<typeof useWorkspaceInspector>;
  const commits: Array<{ open: boolean; visible: boolean; railVisible: boolean }> = [];
  let measuredWidth = 1200;
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.classList.contains("inspector-tab-measure") ? measuredWidth : 0; } });
  const options = { changes: Array.from({ length: 120 }, (_, i) => ({ path: `file-${i}.ts`, operation: "update" as const, changeCount: 1, diff: "", add: 1, del: 0, status: "completed" as const })), tools: [], filePanelResizing: false, filePanelWidth: 420, projectId: "p", source: "p:s",
    onFilePanelResizeEnd() {}, onFilePanelResizeStart() {}, onFilePanelWidthChange() {},
    onListDirectory: async () => ({ path: ".", entries: [] }), onOpenFile() {}, onOpenBrowser: async () => {}, onSwitchBranch: async () => {},
    onReadFile: async () => { throw new Error("unused"); }, onWarning() {} };
  function Harness(): React.ReactNode {
    inspector = useWorkspaceInspector(options);
    React.useLayoutEffect(() => {
      const panel = document.querySelector<HTMLElement>(".desktop-inspector-wrap");
      commits.push({ open: inspector.layout.open, visible: !!panel && panel.style.display !== "none" && panel.getAttribute("aria-hidden") !== "true",
        railVisible: !!document.querySelector(".biny-inspector-rail.is-visible") });
    });
    return React.createElement("div", null, inspector.rail, inspector.dock);
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(() => root.render(React.createElement(Harness)));
    await React.act(() => { for (const fn of [...frames.values()]) fn(0); frames.clear(); });
    commits.length = 0;
    await React.act(async () => { inspector.openFiles(); });
    assert.deepEqual(commits[0], { open: true, visible: true, railVisible: false });
    assert.match(document.querySelector(".file-browser-content")?.textContent ?? "", /选择要预览的文件/);
    const changesTab = document.querySelector<HTMLButtonElement>('#inspector-tab-changes')!;
    assert.equal(changesTab.title, "变更，120 个文件", "紧凑模式仍能取得完整数量，不能只留下被挤扁的徽标");
    assert.equal(changesTab.getAttribute("aria-label"), "变更，120 个文件");
    assert.equal(changesTab.querySelector('.biny-inspector-badge')?.textContent, "");
    measuredWidth = 100;
    options.filePanelWidth = 421;
    await React.act(() => root.render(React.createElement(Harness)));
    assert.equal(changesTab.querySelector('.biny-inspector-badge')?.textContent, "99+", "宽模式恢复数字徽标");
    const panel = document.querySelector(".desktop-inspector-wrap");
    await React.act(() => (document.querySelector('[aria-label="收起工作区工具"]') as HTMLButtonElement).click());
    assert.equal(inspector!.layout.open, false);
    await React.act(async () => { inspector.openFiles(); });
    assert.equal(document.querySelector(".desktop-inspector-wrap"), panel, "重新展开保留面板实例");
    assert.ok(document.querySelector('[role="tab"][aria-label="引用"]'), "右侧包含引用入口");
    await React.act(async () => { (document.querySelector('[role="tab"][aria-label="引用"]') as HTMLButtonElement).click(); });
    assert.ok(document.querySelector('[aria-label="查找引用"]'));
    assert.equal(document.querySelector('#inspector-panel-files')?.getAttribute("aria-hidden"), "true");
    assert.equal(document.querySelector('#inspector-panel-references')?.getAttribute("aria-hidden"), "false");
    assert.equal(commits.some((entry) => entry.open && (!entry.visible || entry.railVisible)), false);
    const pin = document.querySelector<HTMLButtonElement>('[aria-label="切换会话时保持工具栏展开"]');
    assert.ok(pin);
    await React.act(async () => { pin.click(); });
    options.source = "p:s2";
    await React.act(async () => root.render(React.createElement(Harness)));
    assert.equal(inspector!.layout.open, true, "固定面板在同项目切换会话时保留展开");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close(); cssHook.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("提交数字徽标不继承标签文字的收缩和省略规则，单个数字保留正方形底面", async () => {
  const { readFile } = await import("node:fs/promises");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><html><head></head><body><button class="biny-inspector-tab"><span>提交</span><span class="biny-inspector-badge">1</span></button></body></html>');
  try {
    for (const name of ["biny", "inspector"]) {
      const style = dom.window.document.createElement('style');
      style.textContent = await readFile(new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), 'utf8');
      dom.window.document.head.append(style);
    }
    const badge = dom.window.document.querySelector('.biny-inspector-badge')!;
    for (const count of ["1", "12", "99+"]) {
      badge.textContent = count;
      const style = dom.window.getComputedStyle(badge);
      assert.equal(style.minWidth, "16px");
      assert.equal(style.height, "16px");
      assert.equal(style.flexShrink, "0");
      assert.notEqual(style.textOverflow, "ellipsis");
    }
  } finally { dom.window.close(); }
});
