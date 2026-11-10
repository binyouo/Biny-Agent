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

async function renderInteractive(tool: TimelineTool, fn: (document: Document) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(() => root.render(React.createElement(ToolActivityDetail, { ...callbacks, tool })));
    await fn(document);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
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
    assert.equal(child.querySelector('[aria-label="调用参数"]')?.textContent, '{"path":"package.json"}');
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

for (const [stdout, language] of [
  ['{"ok":true,"items":[1,2]}', "json"],
  ["[1, 2]", "json"],
  ["{not json}", "text"],
  ["项目：biny", "text"]
] as const) {
  test(`脚本 stdout 按内容选择高亮语言：${language}`, () => {
    const dom = render({ ...script, result: { ok: true, stdout, childCalls: [] } });
    try {
      const block = [...dom.window.document.querySelectorAll(".tool-code-block")]
        .find(node => node.querySelector('[aria-label="工具结果"]')?.textContent === stdout);
      assert.ok(block);
      assert.equal(block.getAttribute("data-language"), language);
    } finally { dom.window.close(); }
  });
}

test("脚本子调用长参数保持缩进展开", async () => {
  const tool: TimelineTool = {
    ...script,
    result: { ok: true, childCalls: [{ tool: "Read" }] },
    children: [{ ...script.children![0]!, args: { path: "package.json", content: "x".repeat(130) } }]
  };
  await renderInteractive(tool, async (document) => {
    await React.act(() => (document.querySelector(".script-calls-toggle") as HTMLButtonElement).click());
    const child = document.querySelector(".script-child-call") as HTMLElement;
    await React.act(() => (child.querySelector("button") as HTMLButtonElement).click());
    assert.equal(child.querySelector('[aria-label="调用参数"]')?.textContent, '{\n  "path": "package.json",\n  "content": "' + "x".repeat(130) + '"\n}');
  });
});

test("多个脚本子调用分别展开与收起，失败不改变其他调用和父脚本状态", async () => {
  const children: TimelineTool[] = [
    { id: "read-1", tool: "Read", status: "success", args: { path: "README.md" }, result: { content: "readme content" }, updates: [], durationMs: 2 },
    { id: "read-2", tool: "Read", status: "failed", args: { path: "missing.txt" }, result: { error: "ENOENT: no such file" }, error: "ENOENT: no such file", updates: [], durationMs: 3 },
    { id: "read-3", tool: "Read", status: "success", args: { path: "menu.csv" }, result: { content: "menu content" }, updates: [], durationMs: 4 }
  ];
  await renderInteractive({ ...script, children, result: { ok: true, value: "done", childCalls: children.map(child => ({ tool: child.tool, toolCallId: child.id })) } }, async document => {
    const toggle = document.querySelector<HTMLButtonElement>(".script-calls-toggle")!;
    assert.equal(toggle.textContent, "3 tool calls");
    assert.equal(document.querySelector(".script-child-call"), null);
    await React.act(() => toggle.click());
    const rows = [...document.querySelectorAll<HTMLElement>(".script-child-call")];
    assert.deepEqual(rows.map(row => row.dataset.toolCallId), ["read-1", "read-2", "read-3"]);
    assert.deepEqual(rows.map(row => row.querySelector(".tool-execution-status")?.getAttribute("data-status")), ["success", "failed", "success"]);
    const error = rows[1]!.querySelector(".script-child-error-preview")!;
    assert.equal(error.getAttribute("title"), "ENOENT: no such file");
    for (const row of rows) assert.equal(row.querySelector(".script-child-name")?.getAttribute("title"), "Read");
    await React.act(() => rows[0]!.querySelector<HTMLButtonElement>("button")!.click());
    await React.act(() => rows[1]!.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(rows[0]!.querySelector('[aria-label="调用结果"]')?.textContent, '{"content":"readme content"}');
    assert.equal(rows[1]!.querySelector('[role="alert"]')?.textContent, "ENOENT: no such file");
    assert.equal(rows[2]!.querySelector(".script-child-detail"), null);
    const secondButton = rows[1]!.querySelector<HTMLButtonElement>("button")!;
    await React.act(() => secondButton.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(secondButton.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, secondButton);
    assert.equal(rows[0]!.querySelector("button")?.getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector(".script-result-summary .tool-execution-status")?.getAttribute("data-status"), "success");
  });
});

test("通用工具结果分区按内容着色、失败标错误", () => {
  for (const [result, status, label, language, failed] of [
    [{ total: 3 }, "success", "结果", "json", false],
    ["done", "success", "结果", "text", false],
    [{ total: 3 }, "failed", "错误", "json", true]
  ] as const) {
    const dom = render({ id: "generic-result", tool: "mcp__github__search_issues", args: {}, result, status, updates: [] });
    try {
      const section = dom.window.document.querySelector(".tool-section");
      assert.equal(section?.querySelector(".tool-section-label")?.textContent, label);
      assert.equal(section?.querySelector(".tool-section-label")?.getAttribute("data-error") !== null, failed);
      const block = section?.querySelector(".tool-code-block");
      assert.equal(block?.getAttribute("data-language"), language);
      assert.equal(block?.classList.contains("is-error"), failed);
    } finally { dom.window.close(); }
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
