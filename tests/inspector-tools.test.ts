/** 工具运行视图展示真实状态、调用标识与结果，不用视觉验收代替数据契约。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceToolsPanel } from "../src/desktop/renderer/src/components/workspace/WorkspaceUtilityPanels.js";
Object.assign(globalThis, { React });
test("工具页可核对调用 ID、可读名称、结果和未知执行状态", () => {
  const html = renderToStaticMarkup(React.createElement(WorkspaceToolsPanel, { tools: [
    { id: "call-proof", tool: "mcp_context7_query_docs", args: { query: "api" }, result: "result-proof", status: "unknown", updates: [], durationMs: 1200 }
  ] }));
  assert.match(html, /call-proof/);
  assert.match(html, /context7 \/ query \/ docs/);
  assert.match(html, /result-proof/);
  assert.match(html, /状态未知/);
  assert.match(html, /1.2s/);
});
