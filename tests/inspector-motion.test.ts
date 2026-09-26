/** 验证最终样式契约；动画观感由 Desktop 人工验收。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const styles = ["biny", "inspector"].map((name) => readFileSync(
  new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), "utf8"
));

test("面板宽度与显隐共用过渡，功能面板交叠淡入淡出且隐藏内容不可交互", () => {
  const dom = new JSDOM(`<style>${styles.join("\n")}</style><div class="desktop-root biny-root"><div class="biny-app-shell"><div class="desktop-inspector-wrap is-open"><div class="desktop-inspector-body"><div class="biny-inspector-view-content" data-active="true"></div><div class="biny-inspector-view-content" data-active="false" inert aria-hidden="true"></div></div></div></div></div>`);
  try {
    const get = (selector: string): CSSStyleDeclaration => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    assert.match(get(".biny-root").transition, /--biny-inspector-animated-flow-width/);
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
