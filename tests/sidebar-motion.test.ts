/** 顶栏避让和共享动画的样式契约；真实几何与观感由 Desktop 人工验收。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { SIDEBAR_TRANSITION_MS } from "../src/desktop/sidebarSizing.js";

const css = ["biny", "inspector"].map((name) => readFileSync(
  new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), "utf8"
)).join("\n");

function withStyles(attributes: string, check: (get: (selector: string) => CSSStyleDeclaration) => void): void {
  const dom = new JSDOM(`<style>${css}</style><div class="desktop-root biny-root" ${attributes}>
    <div class="biny-app-shell"><div class="biny-workspace-main"><header class="biny-chat-toolbar"></header>
      <div class="biny-chat-body"><div class="biny-chat-scroll"></div></div></div>
    <div class="biny-sidebar-pin-spacer"></div>
    <aside class="biny-sidebar"><div class="biny-sidebar-card"></div></aside>
    <aside class="biny-sidebar is-hidden"><div class="biny-sidebar-card"></div></aside>
    <aside class="biny-sidebar is-peek-overlay"></aside>
    <aside class="biny-sidebar is-peek-overlay is-peek-peeking"></aside>
    <aside class="biny-sidebar is-peek-overlay is-peek-pinning"></aside>
    <div class="biny-sidebar-topbar-floating"><div class="biny-sidebar-topbar-hit-layer"></div></div></div>
  </div>`);
  try {
    check((selector) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!));
  } finally { dom.window.close(); }
}

test("收起和展开过程中标题与按钮共用带最小安全宽度的边界", () => {
  withStyles('data-sidebar-mode="collapsed"', (get) => {
    const boundary = "max(var(--biny-sidebar-chrome-width), var(--biny-sidebar-animated-visual-width))";
    assert.match(get(".biny-chat-toolbar").paddingLeft, /--biny-sidebar-animated-flow-width/);
    assert.equal(get(".biny-sidebar-topbar-floating").width, boundary);
    assert.equal(get(".biny-sidebar-topbar-hit-layer").width, "100%");
  });
});

const motionConsumers = {
  "--biny-sidebar-animated-visual-width": [".biny-sidebar", ".biny-sidebar-topbar-floating", ".biny-chat-toolbar"],
  "--biny-sidebar-animated-flow-width": [".biny-app-shell", ".biny-sidebar-pin-spacer", ".biny-chat-toolbar"]
};

test("逐帧插值只作用于布局元素，不继承到文件和消息子树", () => {
  withStyles('', (get) => {
    assert.doesNotMatch(get(".biny-root").transition, /--biny-sidebar-animated-/u);
    for (const [property, selectors] of Object.entries(motionConsumers)) {
      const registration = css.match(new RegExp(`@property ${property}\\s*\\{([^}]+)\\}`, "u"))?.[1];
      assert.match(registration ?? "", /inherits:\s*false/u, `${property} 不能逐帧传播到整个窗口`);
      for (const selector of selectors) {
        assert.ok(get(selector).transition.includes(property), `${selector} 必须保持同步插值`);
        assert.ok(get(selector).getPropertyValue(property).includes("var("), `${selector} 必须接收目标宽度`);
      }
    }
  });
});

for (const attributes of ['data-sidebar-resizing="true"', 'data-inspector-resizing="true"', 'data-sidebar-transition="peek-exited"']) {
  test(`即时布局不受后加载的 Inspector 过渡覆盖：${attributes}`, () => {
    withStyles(attributes, (get) => {
      for (const selector of new Set(Object.values(motionConsumers).flat())) assert.equal(get(selector).transition, "none");
    });
  });
}

test("减少动态效果保留即时布局", () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion: reduce\)\s*\{[^}]*\.desktop-root\.biny-root[^}]*transition: none !important;/s);
});

for (const mode of ["collapsed", "expanded", "peek"]) {
  test(`顶栏在正文之外占位，滚动内容不能穿过顶部控制区：${mode}`, () => {
    withStyles(`data-sidebar-mode="${mode}"`, (get) => {
      assert.equal(get(".biny-workspace-main").flexDirection, "column");
      assert.equal(get(".biny-chat-toolbar").position, "relative");
      assert.equal(get(".biny-chat-toolbar").flexShrink, "0");
      assert.equal(get(".biny-chat-toolbar").height, "48px");
      assert.ok(Number(get(".biny-sidebar-topbar-floating").zIndex) > Number(get(".biny-chat-toolbar").zIndex), "顶部按钮应在整行背景上方接受点击");
      assert.equal(get(".biny-chat-body").overflow, "hidden");
      assert.equal(get(".biny-chat-scroll").paddingTop, "8px");
    });
  });
}

test("展开固定前后不叠加外层阴影或占位底色，卡片保持原宽度淡入", () => {
  withStyles('', (get) => {
    assert.equal(get(".is-peek-overlay").boxShadow, "none");
    assert.equal(get(".biny-sidebar-pin-spacer").backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(get(".biny-sidebar").paddingTop, "10px");
    assert.equal(get(".biny-sidebar.is-hidden").paddingTop, "10px", "开合不改变卡片高度和内容纵向位置");
    assert.equal(get(".biny-sidebar").overflow, "clip", "正文推开过程中裁切卡片，不能溢出盖住聊天");
    assert.equal(get(".biny-sidebar-card").transform, "translateZ(0)", "保持原宽度淡入，不横向滑动文字");
    assert.equal(get(".biny-sidebar-card").backfaceVisibility, "hidden");
    assert.equal(get(".biny-sidebar-card").transition, "opacity var(--biny-sidebar-transition)");
  });
});

test("预览滑入途中固定不撤销或重启动画", () => {
  withStyles('', (get) => {
    assert.match(get(".is-peek-peeking").animation, /biny-sidebar-peek-in/);
    assert.equal(get(".is-peek-pinning").animation, get(".is-peek-peeking").animation);
  });
});

test("侧栏几何和卡片显隐采用 500ms 对称缓入缓出，预览保持固定宽度", () => {
  withStyles('', (get) => {
    assert.equal(SIDEBAR_TRANSITION_MS, 500);
    assert.equal(get(".biny-root").getPropertyValue("--biny-sidebar-transition").replaceAll(", ", ","), `${SIDEBAR_TRANSITION_MS}ms cubic-bezier(0.4,0,0.2,1)`);
    assert.equal(get(".biny-sidebar").width, "var(--biny-sidebar-animated-visual-width)");
    assert.equal(get(".is-peek-overlay").width, "var(--biny-sidebar-content-width)");
  });
});


test("文件预览保持目标宽度，内容子树无需再覆盖动画变量", () => {
  const dom = new JSDOM(`<style>${css}</style><div class="biny-root">
    <div class="biny-chat-scroll-content"></div><div class="biny-sidebar-card"></div>
    <div class="desktop-inspector"></div></div>`);
  try {
    for (const selector of [".biny-chat-scroll-content", ".biny-sidebar-card", ".desktop-inspector"]) {
      const style = dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
      for (const property of ["--biny-sidebar-animated-visual-width", "--biny-sidebar-animated-flow-width"]) {
        assert.equal(style.getPropertyValue(property), "", `${selector} 不声明局部动画`);
      }
    }
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector(".desktop-inspector")!).width, "var(--biny-inspector-content-width)");
  } finally { dom.window.close(); }
});
