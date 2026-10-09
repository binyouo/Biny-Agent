/** 顶栏避让和共享动画的样式契约；真实几何与观感由 Desktop 人工验收。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { MIN_SIDEBAR_WIDTH, SIDEBAR_TRANSITION_MS } from "../src/desktop/sidebarSizing.js";

const css = ["biny", "inspector"].map((name) => readFileSync(
  new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), "utf8"
)).join("\n");

function withStyles(attributes: string, check: (get: (selector: string) => CSSStyleDeclaration) => void): void {
  const dom = new JSDOM(`<style>${css}</style><div class="desktop-root biny-root" ${attributes}>
    <div class="biny-app-shell"><div class="biny-workspace-main"><header class="biny-chat-toolbar"></header>
      <div class="biny-chat-body"><div class="biny-chat-scroll"></div></div></div>
    <main class="biny-content-shell"></main><div class="biny-sidebar-block"></div>
    <div class="biny-sidebar-pin-spacer"></div>
    <aside class="biny-sidebar"><div class="biny-sidebar-card"><div class="biny-sidebar-topbar-spacer"></div></div></aside>
    <aside class="biny-sidebar is-hidden"><div class="biny-sidebar-card"></div></aside>
    <aside class="biny-sidebar is-peek-overlay"></aside>
    <aside class="biny-sidebar is-peek-overlay is-peek-peeking"></aside>
    <aside class="biny-sidebar is-peek-overlay is-peek-pinning"></aside>
    <div class="biny-sidebar-topbar biny-sidebar-topbar-floating"><div class="biny-sidebar-topbar-hit-layer">
      <button class="biny-chrome-button"></button><button class="biny-chrome-button"></button><button class="biny-chrome-button"></button>
    </div></div></div>
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

test("顶栏为 32px 按钮保留卡片内的上下留白，最窄侧栏仍容得下三个操作", () => {
  withStyles('', (get) => {
    const root = get(".biny-root");
    const topbar = get(".biny-sidebar-topbar-floating");
    const actions = get(".biny-sidebar-topbar-hit-layer");
    const button = get(".biny-chrome-button");
    const controlSize = Number.parseFloat(get(":root").getPropertyValue("--biny-control-height"));
    const titlebarHeight = topbar.height.startsWith("var(")
      ? Number.parseFloat(root.getPropertyValue("--biny-titlebar-height"))
      : Number.parseFloat(topbar.height);
    const paddingTop = Number.parseFloat(actions.paddingTop);
    const paddingBottom = Number.parseFloat(actions.paddingBottom);
    const buttonTop = paddingTop + (titlebarHeight - paddingTop - paddingBottom - controlSize) / 2;
    const cardTop = Number.parseFloat(get(".biny-sidebar").paddingTop);
    assert.equal(controlSize, 32, "不能通过缩小点击目标遮掩越界");
    assert.equal(button.height, "var(--biny-control-height)");
    assert.equal(button.width, "var(--biny-control-height)");
    assert.ok(buttonTop >= cardTop + 4, "按钮背景上缘必须留在卡片顶线内侧");
    assert.ok(titlebarHeight - buttonTop - controlSize >= 4, "按下偏移后仍需保留下缘留白");
    assert.equal(actions.height, "100%", "按钮层跟随顶栏，而不是另设较矮的固定高度");
    assert.equal(get(".biny-chat-toolbar").height, topbar.height);
    assert.equal(get(".biny-chat-toolbar").paddingTop, actions.paddingTop);
    assert.equal(get(".biny-chat-toolbar").paddingBottom, actions.paddingBottom);
    const minimumWidth = Number.parseFloat(actions.paddingLeft) + Number.parseFloat(actions.paddingRight)
      + 3 * controlSize + 2 * Number.parseFloat(actions.gap);
    assert.ok(minimumWidth <= MIN_SIDEBAR_WIDTH, "按钮不得撑出最窄侧栏");
    assert.ok(Number.parseFloat(actions.paddingLeft) >= 78, "保留原生窗口按钮的空间");
    assert.ok(Number.parseFloat(actions.paddingRight) >= Number.parseFloat(get(".biny-sidebar-card").marginInline) + 8);
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
  test(`侧栏外侧不叠加深色轨道或主区留白：${mode}`, () => {
    withStyles(`data-sidebar-mode="${mode}"`, (get) => {
      assert.equal(get(".biny-root").background, "var(--biny-backplate)");
      assert.equal(get(".biny-app-shell").background, "var(--biny-backplate)");
      assert.equal(get(".biny-sidebar-card").background, "var(--biny-sidebar-surface)");
      for (const selector of [".biny-sidebar-block", ".biny-sidebar", ".is-peek-overlay", ".biny-sidebar-pin-spacer", ".biny-sidebar-topbar-floating"]) {
        assert.doesNotMatch(get(selector).background, /var\(/u, `${selector} 不绘制主题底色`);
        assert.equal(get(selector).backgroundColor, "rgba(0, 0, 0, 0)", `${selector} 只负责布局与交互`);
      }
      const content = get(".biny-content-shell");
      assert.equal(content.margin, "0px", "主区不在侧栏的 10px 缝隙外重复留白");
      assert.equal(content.borderRadius, "0px", "主画布不再露出另一层圆角底板");
      const card = get(".biny-sidebar-card");
      assert.equal(card.borderRadius, "16px");
      assert.equal(card.marginInline, "10px");
      assert.equal(card.overflow, "hidden");
      assert.equal(card.boxSizing, "border-box");
      assert.equal(card.width, "max(0px, calc(var(--biny-sidebar-content-width) - 20px))");
      assert.equal(get(".biny-sidebar.is-hidden .biny-sidebar-card").opacity, "0");
    });
  });

  test(`顶栏在正文之外占位，滚动内容不能穿过顶部控制区：${mode}`, () => {
    withStyles(`data-sidebar-mode="${mode}"`, (get) => {
      assert.equal(get(".biny-workspace-main").flexDirection, "column");
      assert.equal(get(".biny-chat-toolbar").position, "relative");
      assert.equal(get(".biny-chat-toolbar").flexShrink, "0");
      assert.equal(get(".biny-chat-toolbar").height, "var(--biny-titlebar-height)");
      assert.ok(Number(get(".biny-sidebar-topbar-floating").zIndex) > Number(get(".biny-chat-toolbar").zIndex), "顶部按钮应在整行背景上方接受点击");
      assert.equal(get(".biny-chat-body").overflow, "hidden");
      assert.equal(get(".biny-chat-scroll").paddingTop, "8px");
    });
  });
}

test("结构皮肤切回普通皮肤后恢复卡片边界，主区不增加额外底板", () => {
  const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
  const layers = readFileSync(new URL("styles/layers.css", renderer), "utf8");
  const sources = [...layers.matchAll(/@import "(\.\.?\/[^"]+\.css)"/gu)]
    .map(entry => readFileSync(new URL(entry[1]!, new URL("styles/layers.css", renderer)), "utf8"));
  sources.push(...["retro", "retro-layout"].map(name => readFileSync(new URL(`styles/${name}.css`, renderer), "utf8")));
  const dom = new JSDOM('<div class="desktop-root biny-root"><div class="biny-app-shell"><main class="biny-content-shell"><header class="biny-chat-toolbar"></header></main><aside class="biny-sidebar"><div class="biny-sidebar-card"></div></aside><div class="biny-sidebar-topbar biny-sidebar-topbar-floating"><div class="biny-sidebar-topbar-hit-layer"><button class="biny-chrome-button"></button></div></div></div></div>');
  try {
    for (const source of sources) {
      const style = dom.window.document.createElement("style");
      style.textContent = source;
      dom.window.document.head.append(style);
    }
    const root = dom.window.document.documentElement;
    const computed = (selector: string): CSSStyleDeclaration => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    for (const skin of ["win98", "winxp", "longhorn", "longhorn-dark"]) {
      root.dataset.appearanceSkin = skin;
      assert.equal(computed(".biny-sidebar-card").borderRadius, "0px", skin);
      assert.equal(computed(".biny-sidebar").padding, "0px", skin);
      const topbar = computed(".biny-sidebar-topbar-floating");
      const actions = computed(".biny-sidebar-topbar-hit-layer");
      const availableHeight = Number.parseFloat(topbar.height) - Number.parseFloat(topbar.paddingTop)
        - Number.parseFloat(topbar.paddingBottom) - Number.parseFloat(actions.paddingTop) - Number.parseFloat(actions.paddingBottom);
      assert.ok(availableHeight >= 32, `${skin} 的紧凑顶栏也必须容纳完整按钮`);
      assert.equal(topbar.minHeight, topbar.height, skin);
      assert.equal(computed(".biny-chat-toolbar").height, topbar.height, skin);
      root.dataset.appearanceSkin = "default";
      assert.equal(computed(".biny-sidebar-card").borderRadius, "16px", skin);
      assert.equal(computed(".biny-sidebar-card").marginInline, "10px", skin);
      assert.equal(computed(".biny-sidebar").padding, "10px 0px", skin);
      assert.equal(computed(".biny-content-shell").margin, "0px", skin);
      assert.equal(computed(".biny-content-shell").borderRadius, "0px", skin);
      assert.equal(computed(".biny-root").getPropertyValue("--biny-backplate"), "var(--surface)", skin);
    }
  } finally { dom.window.close(); }
});

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
