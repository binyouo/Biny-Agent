/** 保护收起提示、连续悬停、延迟收起和键盘入口。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";

const cssFiles = ["biny", "inspector"].map((name) => readFileSync(
  new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), "utf8"
));

test("自动隐藏样式：rail 收缩为右缘窄条且不再占交互，感应条承接 hover 区域", () => {
  const dom = new JSDOM(`<style>${cssFiles.join("\n").replaceAll("var(--biny-text-secondary)", "#b8b8b8")}</style>
    <div class="biny-root">
      <div class="biny-inspector-rail-zone" data-collapsed="true">
        <div class="biny-inspector-rail is-visible is-autohide is-collapsed"></div>
        <button class="biny-inspector-rail-sensor"><span class="biny-inspector-rail-handle"></span></button>
      </div>
      <div class="biny-inspector-rail is-visible is-autohide"></div>
    </div>`);
  try {
    const get = (selector: string): CSSStyleDeclaration => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    const collapsed = get(".biny-inspector-rail.is-autohide.is-collapsed");
    assert.equal(collapsed.pointerEvents, "none", "收缩后不可点击，避免窄条挡在感应条上");
    assert.notEqual(collapsed.opacity, "1", "收缩后淡出");
    assert.match(collapsed.transition, /transform|opacity/, "收缩/展开走过渡而非瞬切");
    const peek = get(".biny-inspector-rail.is-autohide:not(.is-collapsed)");
    assert.equal(peek.pointerEvents, "auto", "展开时可交互");
    assert.equal(get(".biny-inspector-rail-zone").top, "56px");
    assert.equal(collapsed.marginRight, "12px");
    assert.equal(get(".biny-inspector-rail-sensor").height, "48px", "感应区局限于提示条附近，不能覆盖整个聊天区右缘");
    const handle = get(".biny-inspector-rail-handle");
    assert.equal(handle.width, "3px");
    assert.equal(handle.height, "28px");
    assert.equal(handle.opacity, "1", "工具栏淡出后提示条保持可见");
    assert.notEqual(handle.backgroundColor, "rgba(0, 0, 0, 0)");
  } finally { dom.window.close(); }
});

test("减少动态效果下自动隐藏只做透明度切换", () => {
  const css = cssFiles.join("\n");
  assert.ok(
    /@media\s*\(prefers-reduced-motion: reduce\)[\s\S]*?\.biny-inspector-rail\.is-collapsed[\s\S]*?transition:[^;]*opacity[^;]*;/m.test(css)
      || /@media\s*\(prefers-reduced-motion: reduce\)[\s\S]*?\.biny-inspector-rail[\s\S]*?transition:[^;]*opacity[^;]*;/m.test(css),
    "reduced-motion 下 rail 的自动隐藏不得以位移动画呈现"
  );
});

test("自动隐藏开启后鼠标移出自动收起、感应条 hover 展开、手动关闭后保持展开", async (t) => {
  const cssHook = registerHooks({ load(url, context, next) {
    if (url.includes("/@xterm/xterm/")) return { format: "module", source: "export class Terminal {}", shortCircuit: true };
    if (url.includes("/@xterm/addon-fit/")) return { format: "module", source: "export class FitAddon {}", shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
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
  const options = { changes: [], tools: [], filePanelResizing: false, filePanelWidth: 420, projectId: "p", source: "p:s",
    onFilePanelResizeEnd() {}, onFilePanelResizeStart() {}, onFilePanelWidthChange() {},
    onListDirectory: async () => ({ path: ".", entries: [] }), onOpenFile() {}, onOpenBrowser: async () => {}, onSwitchBranch: async () => {},
    onFixPreview() {}, onReadFile: async () => { throw new Error("unused"); }, onWarning() {} };
  function Harness(): React.ReactNode {
    inspector = useWorkspaceInspector(options);
    return React.createElement("div", null, inspector.rail);
  }
  const root = createRoot(document.getElementById("root")!);
  const flush = async (): Promise<void> => { await React.act(() => { for (const fn of [...frames.values()]) fn(0); frames.clear(); }); };
  const rail = (): HTMLElement => document.querySelector<HTMLElement>(".biny-inspector-rail")!;
  try {
    await React.act(() => root.render(React.createElement(Harness)));
    await flush();
    t.mock.timers.enable({ apis: ["setTimeout"] });

    await t.test("默认常显，不自动隐藏", () => {
      assert.ok(!rail().classList.contains("is-autohide"));
      assert.ok(!rail().classList.contains("is-collapsed"));
    });

    await t.test("开启自动隐藏：rail 收缩、出现感应条", async () => {
      const toggle = document.querySelector<HTMLButtonElement>('[aria-label="自动隐藏工具栏"]');
      assert.ok(toggle, "rail 上提供自动隐藏开关");
      await React.act(async () => { toggle.click(); });
      assert.ok(rail().classList.contains("is-autohide"));
      assert.ok(rail().classList.contains("is-collapsed"), "鼠标不在容器上时立即收起");
      const handle = document.querySelector<HTMLButtonElement>('button[aria-label="显示工具栏"]');
      assert.ok(handle, "收起后仍有可聚焦的显示入口，旧测试只检查不可见 div 的存在");
      assert.equal(handle.getAttribute("aria-expanded"), "false");
      assert.ok(handle.querySelector(".biny-inspector-rail-handle"), "独立提示条不能随工具栏一起淡出");
    });

    await t.test("hover 感应条展开、移出整条容器后收起", async () => {
      const sensor = document.querySelector<HTMLElement>(".biny-inspector-rail-sensor")!;
      await React.act(async () => { sensor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); });
      assert.ok(!rail().classList.contains("is-collapsed"), "感应条 hover 展开 rail");
      await React.act(async () => { sensor.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })); });
      assert.ok(!rail().classList.contains("is-collapsed"), "移出感应条但仍在 rail 上空时保持展开");
      const zone = document.querySelector<HTMLElement>(".biny-inspector-rail-zone")!;
      await React.act(async () => { zone.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })); });
      assert.ok(!rail().classList.contains("is-collapsed"), "离开后保留短暂缓冲，旧实现立即收起");
      await React.act(() => t.mock.timers.tick(349));
      assert.ok(!rail().classList.contains("is-collapsed"));
      await React.act(() => t.mock.timers.tick(1));
      assert.ok(rail().classList.contains("is-collapsed"), "离开 350ms 后收起");
      await React.act(() => sensor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
      await React.act(() => zone.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })));
      await React.act(() => t.mock.timers.tick(200));
      await React.act(() => rail().dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
      await React.act(() => t.mock.timers.tick(350));
      assert.ok(!rail().classList.contains("is-collapsed"), "重新进入取消旧收起计时器");
      await React.act(() => zone.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })));
      await React.act(() => t.mock.timers.tick(350));
    });

    await t.test("键盘聚焦显示入口后保持展开，焦点离开才允许收起", async () => {
      const handle = document.querySelector<HTMLButtonElement>('button[aria-label="显示工具栏"]')!;
      await React.act(() => handle.focus());
      assert.ok(!rail().classList.contains("is-collapsed"));
      const first = rail().querySelector<HTMLButtonElement>("button")!;
      await React.act(() => first.focus());
      await React.act(() => document.querySelector(".biny-inspector-rail-zone")!.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })));
      await React.act(() => t.mock.timers.tick(350));
      assert.ok(!rail().classList.contains("is-collapsed"), "鼠标移出不能隐藏仍有键盘焦点的按钮，旧覆盖只包含鼠标");
      await React.act(() => first.blur());
      await React.act(() => t.mock.timers.tick(350));
      assert.ok(rail().classList.contains("is-collapsed"));
    });

    await t.test("鼠标点击产生的焦点不会锁住自动隐藏", async () => {
      const handle = document.querySelector<HTMLButtonElement>('button[aria-label="显示工具栏"]')!;
      await React.act(() => handle.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
      await React.act(() => handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
      await React.act(() => handle.focus());
      await React.act(() => handle.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true })));
      await React.act(() => handle.click());
      assert.ok(!rail().classList.contains("is-collapsed"));
      await React.act(() => document.querySelector(".biny-inspector-rail-zone")!.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })));
      await React.act(() => t.mock.timers.tick(350));
      assert.ok(rail().classList.contains("is-collapsed"), "指针焦点不能被当作键盘导航而阻止收起");
      await React.act(() => handle.blur());
    });

    await t.test("打开面板再关闭不保留旧悬停或键盘焦点", async () => {
      await React.act(() => document.querySelector<HTMLButtonElement>('button[aria-label="显示工具栏"]')!.focus());
      await React.act(() => inspector.toggleTerminal());
      assert.equal(document.querySelector(".biny-inspector-rail-sensor"), null);
      assert.equal(rail().getAttribute("aria-hidden"), "true");
      await React.act(() => inspector.toggleTerminal());
      assert.ok(rail().classList.contains("is-collapsed"), "面板关闭后恢复提示条，不能残留已移除入口的聚焦状态");
    });

    await t.test("关闭开关后恢复常显、不再自动收起", async () => {
      const toggle = document.querySelector<HTMLButtonElement>('[aria-label="保持工具栏展开"]')!;
      await React.act(async () => { toggle.click(); });
      assert.ok(!rail().classList.contains("is-autohide"));
      assert.ok(!rail().classList.contains("is-collapsed"));
      await React.act(async () => { rail().dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })); });
      assert.ok(!rail().classList.contains("is-collapsed"), "关闭后鼠标移出不再收起");
    });
  } finally {
    await React.act(() => root.unmount());
    dom.window.close(); cssHook.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
