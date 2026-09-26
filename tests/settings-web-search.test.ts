/** 静态渲染验证可见内容和控件契约，视觉与交互仍由用户验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { defaultConfig } from "../src/config/schema.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

test("网络搜索呈现五个设置区和两种引擎，移除 API 服务控件", async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true, entries: [] } });
  try {
    const { SettingsWebSearch } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsWebSearch.tsx");
    const { SettingsDraftContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDraftContext.ts");
    const context = { draft: { webSearch: defaultConfig.web.search }, setWebSearch() {} } as unknown as SettingsDraftContextValue;
    const cookies = async () => ({ total: 0, domains: [] });
    const html = renderToStaticMarkup(React.createElement(SettingsDraftContext.Provider, { value: context }, React.createElement(SettingsWebSearch, {
      onOpenBrowser: async () => undefined, onExportCookies: cookies, onImportCookies: cookies, onClearCookies: cookies, sessionRunning: false
    })));
    for (const title of ["可视化 Agent 浏览", "搜索引擎", "Google 搜索设置", "小红书设置", "WebFetch 浏览器"]) assert.ok(html.includes(title));
    assert.equal((html.match(/<section/g) ?? []).length, 5);
    assert.ok(html.includes('value="google"'));
    assert.ok(html.includes('value="xiaohongshu"'));
    assert.ok(!/AnySearch|Tavily|Brave Search|API Key|返回结果数|请求超时|清除全部/.test(html));
    assert.ok(html.includes('value="https://"'));
  } finally { await vite.close(); }
});
