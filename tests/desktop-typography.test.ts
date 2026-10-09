import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);

test("字体偏好穿透组件库主题边界，正文、标题和代码不再各用一套字体", async () => {
  const dom = new JSDOM('<html lang="zh-CN"><head></head><body><div data-astryx-theme="neutral"><main class="desktop-root biny-root"><p>正文</p><h2>标题</h2><code>value</code></main></div></body></html>');
  try {
    // jsdom 不计算 cascade layer；这里只按生产入口顺序展开库的 token 层，检查字体绑定。
    const library = dom.window.document.createElement("style");
    library.textContent = await readFile(new URL(import.meta.resolve("@astryxdesign/core/astryx.css")), "utf8");
    dom.window.document.head.append(library);
    const flattenLayers = (rules: CSSRuleList): string => Array.from(rules).map(rule =>
      rule.constructor.name === "CSSLayerBlockRule"
        ? flattenLayers((rule as CSSGroupingRule).cssRules)
        : rule.cssText
    ).join("\n");
    const tokens = flattenLayers(library.sheet!.cssRules);
    library.textContent = tokens;
    for (const file of ["styles.css", "styles/theme.css"]) {
      const style = dom.window.document.createElement("style");
      style.textContent = await readFile(new URL(file, renderer), "utf8");
      dom.window.document.head.append(style);
    }
    dom.window.document.documentElement.style.setProperty("--font-sans", '"Custom Font", sans-serif');
    const style = dom.window.getComputedStyle(dom.window.document.querySelector("[data-astryx-theme]")!);
    assert.equal(style.getPropertyValue("--font-sans"), '"Custom Font", sans-serif');
    assert.equal(style.getPropertyValue("--font-family-body"), "var(--font-sans)");
    assert.equal(style.getPropertyValue("--font-family-heading"), "var(--font-sans)");
    assert.equal(style.getPropertyValue("--font-family-code"), "var(--font-mono)");
  } finally {
    dom.window.close();
  }
});

test("缺少粗体或斜体字形时允许字体合成，Markdown 强调不被全局禁用", async () => {
  const dom = new JSDOM("<html><head></head><body></body></html>");
  try {
    const style = dom.window.document.createElement("style");
    style.textContent = await readFile(new URL("styles.css", renderer), "utf8");
    dom.window.document.head.append(style);
    assert.notEqual(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue("font-synthesis"), "none");
  } finally {
    dom.window.close();
  }
});
