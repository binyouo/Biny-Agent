/** 验证最终样式契约；动画观感由 Desktop 人工验收。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const styles = ["biny", "inspector"].map((name) => readFileSync(
  new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), "utf8"
));

test("面板自身宽度与显隐共用过渡，功能面板交叠淡入淡出且隐藏内容不可交互", () => {
  const dom = new JSDOM(`<style>${styles.join("\n")}</style><div class="desktop-root biny-root"><div class="biny-app-shell"><div class="desktop-inspector-wrap is-open"><div class="desktop-inspector-body"><div class="biny-inspector-view-content" data-active="true"></div><div class="biny-inspector-view-content" data-active="false" inert aria-hidden="true"></div></div></div></div></div>`);
  try {
    const get = (selector: string): CSSStyleDeclaration => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    assert.doesNotMatch(get(".biny-root").transition, /inspector/);
    assert.equal(get(".biny-app-shell").gridTemplateColumns, "var(--biny-sidebar-animated-flow-width, 0px) minmax(0, 1fr) auto");
    assert.equal(get(".desktop-inspector-wrap").width, "var(--biny-inspector-flow-width, 0px)");
    assert.equal(get(".desktop-inspector-wrap").transition, "width 300ms ease-out, opacity 300ms ease-out");
    assert.equal(get(".desktop-inspector-wrap").animation, "none");
    assert.equal(get('[data-active="true"]').opacity, "1");
    assert.equal(get('[data-active="false"]').opacity, "0");
    assert.equal(get('[data-active="false"]').visibility, "hidden");
    assert.equal(get('[data-active="false"]').pointerEvents, "none");
    assert.equal(get(".biny-inspector-view-content").position, "absolute");
    assert.match(get('[data-active="true"]').transition, /opacity/);
  } finally { dom.window.close(); }
});

test("减少动态效果关闭布局和内容过渡", () => {
  const css = styles.join("\n");
  assert.ok(/@media\s*\(prefers-reduced-motion: reduce\)\s*\{[^}]*\.biny-inspector-view-content[^}]*transition: none !important;/s.test(styles[1]!));
  assert.ok(/@media\s*\(prefers-reduced-motion: reduce\)\s*\{[^}]*\.desktop-root\.biny-root[^}]*transition: none !important;/s.test(css));
});

test("工具按钮保留轻量反馈，rail 不使用模糊滤镜过渡", () => {
  const dom = new JSDOM(`<style>${styles.join("\n")}</style><div class="biny-root"><div class="biny-inspector-rail is-visible"><button class="biny-inspector-rail-btn"></button></div><button class="biny-inspector-tab"></button></div>`);
  try {
    const get = (selector: string): CSSStyleDeclaration => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    assert.equal(get(".biny-inspector-rail").filter, "none");
    assert.doesNotMatch(get(".biny-inspector-rail").transition, /filter/u);
    assert.match(get(".biny-inspector-tab").transition, /transform/u);
  } finally { dom.window.close(); }
});

for (const attributes of ['data-inspector-resizing="true"', 'data-sidebar-resizing="true"', 'data-inspector-focused="true"']) {
  test(`即时调整不叠加右栏宽度动画：${attributes}`, () => {
    const dom = new JSDOM(`<style>${styles.join("\n")}</style><div class="desktop-root biny-root" ${attributes}><div class="biny-app-shell"><div class="desktop-inspector-wrap is-open"></div></div></div>`);
    try {
      assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector(".desktop-inspector-wrap")!).transition, "none");
    } finally { dom.window.close(); }
  });
}


test("首次挂载右栏从零宽淡入，关闭态能完全释放布局占位", () => {
  assert.match(styles[1]!, /@starting-style\s*\{[^}]*\.desktop-inspector-wrap\.is-open\s*\{\s*width: 0px;\s*opacity: 0;/s);
  const dom = new JSDOM(`<style>${styles.join("\n")}</style><div class="biny-root"><div class="biny-app-shell"><div class="desktop-inspector-wrap is-closed"></div></div></div>`);
  try {
    const style = dom.window.getComputedStyle(dom.window.document.querySelector(".desktop-inspector-wrap")!);
    assert.equal(style.borderLeftWidth, "0px");
    assert.equal(style.opacity, "0");
    assert.equal(style.pointerEvents, "none");
  } finally { dom.window.close(); }
});


test("正文的工具条留白与右栏宽度同节奏收放，避免先扩宽再收窄", () => {
  const dom = new JSDOM(`<style>${styles.join("\n")}</style><div class="biny-root"><div class="biny-app-shell"><div class="biny-workspace-main"><div class="biny-inspector-rail is-visible"></div><div class="biny-chat-scroll"></div></div><div class="desktop-inspector-wrap"></div></div></div>`);
  try {
    const scroll = dom.window.document.querySelector(".biny-chat-scroll")!;
    const get = (): CSSStyleDeclaration => dom.window.getComputedStyle(scroll);
    assert.equal(get().paddingRight, "48px");
    assert.equal(get().transition, "padding-right 300ms ease-out");
    dom.window.document.querySelector(".biny-inspector-rail")!.classList.remove("is-visible");
    assert.equal(get().paddingRight, "0px");
    assert.equal(get().transition, "padding-right 300ms ease-out");
    dom.window.document.querySelector(".biny-root")!.setAttribute("data-inspector-resizing", "true");
    assert.equal(get().transition, "none");
  } finally { dom.window.close(); }
});
