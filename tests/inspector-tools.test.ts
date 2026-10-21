import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { WorkspaceToolsPanel } from "../src/desktop/renderer/src/components/workspace/WorkspaceToolsPanel.js";
import type { TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";

const script: TimelineTool = { id: "call_script_001", tool: "run_script", args: { description: "检查审批", code: 'const x = await tools.Read({path: "a.ts"});\nconsole.log(x.content);\n' }, status: "success", updates: [] };
function render(tools: TimelineTool[]): JSDOM {
  return new JSDOM(renderToStaticMarkup(React.createElement(WorkspaceToolsPanel, { tools })));
}

test("工具运行卡直接显示真实工具名、调用 ID、状态与紧凑参数 JSON", () => {
  const dom = render([script]);
  try {
    const doc = dom.window.document;
    const card = doc.querySelector('[data-tool-call-id="call_script_001"]');
    assert.ok(card);
    assert.equal(card.querySelector('.tool-run-name')?.textContent, "run_script");
    assert.equal(card.querySelector('.tool-run-id')?.textContent, "call_script_001");
    assert.equal(card.querySelector('.tool-execution-status')?.textContent, "Success");
    assert.equal(card.querySelector('.tool-run-input')?.textContent, JSON.stringify(script.args));
    assert.equal(doc.querySelector('h2')?.textContent, "工具运行");
    assert.equal(card.querySelector('button, details, .chat-tool-row'), null);
    assert.equal(card.querySelector('.tool-run-meta'), null, "未采集的时间不能补造");
  } finally { dom.window.close(); }
});

test("运行中调用置顶，其余最近优先，脚本内部调用在父卡内显示一次", () => {
  const dom = render([
    script,
    { ...script, id: "running", status: "running" },
    { ...script, id: "waiting", status: "waiting" },
    { ...script, id: "child", tool: "Skill", args: { skill: "review" }, parentToolCallId: script.id },
    { ...script, id: "newest", tool: "Skill" }
  ]);
  try {
    assert.deepEqual([...dom.window.document.querySelectorAll('.tool-run-list > [data-tool-call-id]')].map(card => card.getAttribute('data-tool-call-id')), ["waiting", "running", "newest", "call_script_001"]);
    assert.equal(dom.window.document.querySelectorAll('[data-tool-call-id="child"]').length, 1);
    assert.equal(dom.window.document.querySelector('[data-tool-call-id="call_script_001"] [data-tool-call-id="child"] .tool-run-name')?.textContent, "Skill");
  } finally { dom.window.close(); }
});

test("状态由调用记录决定，未知与取消不由业务结果改成成功，错误与耗时直接可见", () => {
  const dom = render([
    { ...script, id: "unknown", status: "unknown", result: { approved: true }, durationMs: 2, error: "结果无法确认" },
    { ...script, id: "cancelled", status: "cancelled", timestamp: "2026-10-21T01:02:03.000Z" },
    { ...script, id: "success", result: { approved: false } },
    { ...script, id: "failed", status: "failed", durationMs: 1200, error: "Execution proof" }
  ]);
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelector('[data-tool-call-id="unknown"] .tool-execution-status')?.textContent, "结果未知");
    assert.equal(doc.querySelector('[data-tool-call-id="cancelled"] .tool-execution-status')?.textContent, "已取消");
    assert.equal(doc.querySelector('[data-tool-call-id="success"] .tool-execution-status')?.textContent, "Success");
    assert.equal(doc.querySelector('[data-tool-call-id="failed"] .tool-execution-status')?.textContent, "失败");
    assert.match(doc.querySelector('[data-tool-call-id="unknown"] .tool-run-meta')?.textContent ?? "", /2ms/);
    assert.match(doc.querySelector('[data-tool-call-id="failed"] .tool-run-meta')?.textContent ?? "", /1.2s/);
    assert.equal(doc.querySelector('[data-tool-call-id="failed"] [role="alert"]')?.textContent, "Execution proof");
    assert.equal(doc.querySelector('[data-tool-call-id="cancelled"] time')?.getAttribute('datetime'), "2026-10-21T01:02:03.000Z");
  } finally { dom.window.close(); }
});

test("参数预览保留零值、空对象和显式 null，未提供参数时不伪造内容", () => {
  for (const [args, expected] of [[0, "0"], [false, "false"], [null, "null"], [{}, "{}"], [undefined, undefined], ["raw input", "raw input"]] as const) {
    const dom = render([{ ...script, args }]);
    try { assert.equal(dom.window.document.querySelector('.tool-run-input')?.textContent, expected); }
    finally { dom.window.close(); }
  }
});

test("实时状态和参数变化更新同一调用卡，完成后恢复最近优先排序", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById('root')!);
  const newer = { ...script, id: "newer" };
  try {
    await React.act(() => root.render(React.createElement(WorkspaceToolsPanel, { tools: [{ ...script, status: "running", args: { code: "partial" } }, newer] })));
    const card = document.querySelector('[data-tool-call-id="call_script_001"]');
    assert.equal(document.querySelector('.tool-run-id')?.textContent, "call_script_001");
    assert.equal(card?.querySelector('.tool-execution-status')?.textContent, "运行中");
    await React.act(() => root.render(React.createElement(WorkspaceToolsPanel, { tools: [{ ...script, durationMs: 12 }, newer] })));
    assert.equal(document.querySelector('.tool-run-id')?.textContent, "newer");
    assert.equal(document.querySelector('[data-tool-call-id="call_script_001"]'), card);
    assert.equal(card?.querySelector('.tool-execution-status')?.textContent, "Success");
    assert.equal(card?.querySelector('.tool-run-input')?.textContent, JSON.stringify(script.args));
    assert.match(card?.querySelector('.tool-run-meta')?.textContent ?? "", /12ms/);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
