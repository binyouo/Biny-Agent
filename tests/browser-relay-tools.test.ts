/** 真实浏览器必须有独立的发现入口，不能用内置页面冒充用户的标签。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";
import { createBrowserTools } from "../src/tools/browser.js";

test("工具目录提供已有浏览器的状态、标签与读取能力，明确区分内置浏览器", () => {
  const registry = createToolRegistry({ workspaceRoot: process.cwd(), ignore: [] });
  for (const name of ["ChromeRelayStatus", "ChromeRelayListTabs", "ChromeRelayRead", "ChromeRelayNavigate", "ChromeRelayClick", "ChromeRelayType", "ChromeRelayPress", "ChromeRelayScreenshot", "ChromeRelayScroll", "ChromeRelayWait", "ChromeRelayUpload", "ChromeRelayDownload"]) {
    assert.equal(registry.listEntries().find(({ tool }) => tool.name === name)?.source, "builtin", `${name} must be built in`);
  }
  const read = createBrowserTools({ endpoint: "/unused", token: "test" }).find((tool) => tool.name === "BrowserReadDom")!;
  assert.match(read.description, /Biny.*built-in|built-in.*Biny/i);
  assert.match(read.promptGuidelines!.join(" "), /ChromeRelayListTabs/);
});
