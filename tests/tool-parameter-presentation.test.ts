import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { WorkspaceToolsPanel } from "../src/desktop/renderer/src/components/workspace/WorkspaceToolsPanel.js";
import { ToolActivityDetail } from "../src/desktop/renderer/src/components/ToolActivity.js";
import type { TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";

const callbacks = { projectId: "parameters", onPreviewFile() {}, onOpenExternal() {} };
const code = 'const result = await tools.Read({path: "package.json"});\nconsole.log(result.content);\n';
const script: TimelineTool = {
  id: "script", tool: "run_script", status: "success", updates: [], durationMs: 1234,
  args: { description: "读取项目名称", code, language: "javascript", timeout_ms: 5000 },
  result: { ok: true, stdout: "项目：biny\n文件读取完成", value: { count: 1 }, childCalls: [{ tool: "Read", toolCallId: "read" }] },
  children: [{ id: "read", tool: "Read", status: "success", args: { path: "package.json" }, result: { content: "private source" }, updates: [], durationMs: 2 }]
};
function render(tool: TimelineTool): JSDOM {
  return new JSDOM(renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool })));
}

test("脚本展开后同时呈现逐项参数、内部调用摘要和最终输出", () => {
  const dom = render(script);
  try {
    const doc = dom.window.document;
    assert.deepEqual([...doc.querySelectorAll(".tool-parameter-name")].map(node => node.textContent), ["description", "language", "timeout_ms", "code"]);
    assert.equal(doc.querySelector('[aria-label="参数 code"]')?.textContent, code);
    assert.equal(doc.querySelector('[aria-label="参数 description"]')?.textContent, "读取项目名称");
    assert.equal(doc.querySelector('[aria-label="复制参数 code"]')?.tagName, "BUTTON");
    assert.equal(doc.querySelector(".tool-optimization-tabs"), null);
    assert.match(doc.querySelector(".script-result-summary")?.textContent ?? "", /Success.*1 tool call/);
    assert.equal(doc.querySelector(".script-child-call"), null);
    assert.equal(doc.querySelector(".script-calls-toggle")?.getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(doc.body.textContent ?? "", /private source/);
    const outputs = [...doc.querySelectorAll('[aria-label="工具结果"]')].map(node => node.textContent);
    assert.deepEqual(outputs, ["项目：biny\n文件读取完成", '{\n  "count": 1\n}']);
  } finally { dom.window.close(); }
});

test("普通工具按实际字段展示参数，不把 content 字段当成整个输入", () => {
  const args = { content: "报告正文", replace_all: false, offset: 0, optional: null, filters: { tags: ["a", "b"] }, empty: "" };
  const dom = render({ id: "generic", tool: "mcp__reports__query", args, result: "done", status: "success", updates: [] });
  try {
    const doc = dom.window.document;
    assert.deepEqual([...doc.querySelectorAll(".tool-parameter-name")].map(node => node.textContent), ["replace_all", "offset", "optional", "empty", "content", "filters"]);
    for (const [name, expected] of Object.entries({ replace_all: "false", offset: "0", optional: "null", empty: '""' })) {
      assert.equal(doc.querySelector(`[aria-label="参数 ${name}"]`)?.textContent, expected);
    }
    assert.equal(doc.querySelector('[aria-label="参数 filters"]')?.textContent, JSON.stringify(args.filters, null, 2));
  } finally { dom.window.close(); }
});

for (const [status, expected] of [["running", "运行中"], ["waiting", "等待中"], ["failed", "失败"], ["cancelled", "已取消"], ["unknown", "结果未知"]] as const) {
  test(`脚本 ${status} 不因已有局部输出而显示成功`, () => {
    const dom = render({ ...script, status, result: undefined, children: [], updates: [{ text: "partial output" }] });
    try {
      assert.match(dom.window.document.querySelector(".script-result-summary")?.textContent ?? "", new RegExp(expected));
      assert.equal(dom.window.document.querySelector('[aria-label="工具结果"]')?.textContent, "partial output");
    } finally { dom.window.close(); }
  });
}

test("脚本子调用按需展开，复制代码保留实际文本", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { async writeText(text: string) { copied.push(text); } } });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(() => root.render(React.createElement(ToolActivityDetail, { ...callbacks, tool: script })));
    await React.act(() => (document.querySelector('[aria-label="复制参数 code"]') as HTMLButtonElement).click());
    assert.deepEqual(copied, [code]);
    await React.act(() => (document.querySelector(".script-calls-toggle") as HTMLButtonElement).click());
    const child = document.querySelector(".script-child-call") as HTMLElement;
    await React.act(() => (child.querySelector("button") as HTMLButtonElement).click());
    assert.match(child.textContent ?? "", /private source/);
    assert.equal(child.querySelector('[aria-label="调用参数"]')?.textContent, '{\n  "path": "package.json"\n}');
    assert.match(child.textContent ?? "", /2ms/);
    assert.match(child.textContent ?? "", /ARGS.*RESULT/s);
    assert.equal(child.querySelector(".tool-details"), null);
    await React.act(() => (child.querySelector("button") as HTMLButtonElement).click());
    assert.doesNotMatch(child.textContent ?? "", /private source/);
    await React.act(() => root.render(React.createElement(WorkspaceToolsPanel, { tools: [script] })));
    assert.equal(document.querySelector('[aria-label="参数 code"]'), null);
    assert.equal(document.querySelector(".chat-tool-row"), null);
    assert.equal(document.querySelector(".tool-run-name")?.textContent, "run_script");
    assert.equal(document.querySelector(".tool-run-id")?.textContent, "script");
    assert.equal(document.querySelector(".tool-run-input")?.textContent, JSON.stringify(script.args));
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("脚本空结果、显式 null 和错误分别保留，子调用失败不覆盖父调用成功", () => {
  for (const [result, expected] of [
    [{ ok: true, childCalls: [] }, "已完成，无输出"],
    [{ ok: true, value: null, childCalls: [] }, "null"],
    [{ ok: false, error: "execution proof", childCalls: [] }, "execution proof"]
  ] as const) {
    const dom = render({ ...script, result, children: [{ ...script.children![0]!, status: "failed" }] });
    try {
      assert.match(dom.window.document.querySelector(".script-result")?.textContent ?? "", new RegExp(expected));
      assert.match(dom.window.document.querySelector(".script-result-summary .tool-execution-status")?.textContent ?? "", /Success/);
      assert.equal(dom.window.document.querySelector(".script-child-call"), null);
    } finally { dom.window.close(); }
  }
});

test("文件变更保留专用结果，同时完整展示输入参数", () => {
  const tool: TimelineTool = {
    id: "edit", tool: "Edit", status: "success", updates: [],
    args: { path: "a.ts", old_string: "old", new_string: "new" },
    fileChange: { operation: "update", path: "a.ts", committed: true, diff: "@@\n-old\n+new" }
  };
  const dom = render(tool);
  try {
    const doc = dom.window.document;
    assert.deepEqual([...doc.querySelectorAll(".tool-parameter-name")].map(node => node.textContent), ["path", "old_string", "new_string"]);
    assert.equal(doc.querySelectorAll(".tool-parameters").length, 1);
    assert.match(doc.body.textContent ?? "", /已提交变更/);
  } finally { dom.window.close(); }
});

test("通用结果保留完整业务对象与显式 null，不用摘要字段覆盖证据", () => {
  for (const result of [{ content: "摘要", approved: false, evidence: { code: 0 } }, null]) {
    const dom = render({ id: "evidence", tool: "mcp__approval__query", args: {}, result, status: "success", updates: [] });
    try { assert.equal(dom.window.document.querySelector('[aria-label="工具结果"]')?.textContent, JSON.stringify(result, null, 2)); }
    finally { dom.window.close(); }
  }
});
