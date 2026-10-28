/** 真实浏览器必须有独立的发现入口，不能用内置页面冒充用户的标签。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";
import { createBrowserTools } from "../src/tools/browser.js";

test("工具目录提供已有浏览器的状态、标签与读取能力，明确区分内置浏览器", () => {
  const registry = createToolRegistry({ workspaceRoot: process.cwd(), ignore: [] });
  for (const name of ["ChromeRelayStatus", "ChromeRelayListTabs", "ChromeRelayOpen", "ChromeRelayRead", "ChromeRelayEval", "ChromeRelayNavigate", "ChromeRelayBack", "ChromeRelayForward", "ChromeRelayClick", "ChromeRelayType", "ChromeRelayPress", "ChromeRelayScreenshot", "ChromeRelayScroll", "ChromeRelayWait", "ChromeRelayUpload", "ChromeRelayDownload"]) {
    assert.equal(registry.listEntries().find(({ tool }) => tool.name === name)?.source, "builtin", `${name} must be built in`);
  }
  const read = createBrowserTools({ endpoint: "/unused", token: "test" }).find((tool) => tool.name === "BrowserReadDom")!;
  assert.match(read.description, /Biny.*built-in|built-in.*Biny/i);
  assert.match(read.promptGuidelines!.join(" "), /ChromeRelayListTabs/);
  const evaluate = registry.get("ChromeRelayEval");
  assert.equal(evaluate.risk, "execute");
  assert.equal(evaluate.exposure, "model-only");
  assert.equal(evaluate.schema.safeParse({ browserId: "00000000-0000-4000-8000-000000000000", tabId: 1, code: "document.title" }).success, true);
  assert.equal(evaluate.schema.safeParse({ browserId: "00000000-0000-4000-8000-000000000000", tabId: 1, code: "x".repeat(10001) }).success, false);
  const open = registry.get("ChromeRelayOpen");
  assert.equal(open.risk, "execute");
  assert.equal(open.schema.safeParse({ browserId: "00000000-0000-4000-8000-000000000000", url: "https://example.com/" }).success, true);
  assert.equal(open.schema.safeParse({ browserId: "00000000-0000-4000-8000-000000000000", tabId: 1, url: "file:///tmp/private" }).success, false);
  for (const name of ["ChromeRelayBack", "ChromeRelayForward"]) {
    assert.equal(registry.get(name).schema.safeParse({ browserId: "00000000-0000-4000-8000-000000000000", tabId: 1 }).success, true);
  }
});
