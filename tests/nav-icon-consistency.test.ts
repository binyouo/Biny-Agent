import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { SettingsNavIcon } from "../src/desktop/renderer/src/components/settings/SettingsNavIcon.js";
import type { SettingsTab } from "../src/desktop/renderer/src/components/settings/SettingsOverlay.js";

test("every settings navigation item has a distinct, accessible icon", async () => {
  const tabs: SettingsTab[] = ["通用", "模型", "聊天", "Token 节省", "用户界面", "配色", "记忆", "技能", "MCP 服务器", "插件", "网络搜索", "浏览器", "Appshots", "Computer Use", "隐私脱敏", "Computer History", "导入", "关于"];
  const overlay = await readFile(new URL("../src/desktop/renderer/src/components/settings/SettingsOverlay.tsx", import.meta.url), "utf8");
  const nav = [...overlay.matchAll(/\{ tab: "([^"]+)" \}/gu)].map(match => match[1]);
  assert.deepEqual(nav, tabs, "all settings pages must have a navigation icon");
  const icons = tabs.map(page => {
    const html = renderToStaticMarkup(React.createElement(SettingsNavIcon, { page }));
    const dom = new JSDOM(html);
    try {
      const svg = dom.window.document.querySelector("svg");
      assert.ok(svg, `${page} must render an icon`);
      assert.equal(svg.getAttribute("aria-hidden"), "true");
      assert.ok(svg.querySelector("path, rect, circle"), `${page} must render a visible shape`);
      return svg.innerHTML;
    } finally { dom.window.close(); }
  });
  assert.equal(new Set(icons).size, tabs.length, "navigation icons must be distinct");
});
