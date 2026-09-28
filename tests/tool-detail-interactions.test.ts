import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ToolActivityDetail } from "../src/desktop/renderer/src/components/ToolActivity.js";
import { ActivitySegment, ActivityToolRow } from "../src/desktop/renderer/src/components/chat/ActivitySegment.js";
import type { TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";

const callbacks = { projectId: "p", onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {} };
const tool: TimelineTool = {
  id: "command-1", tool: "Bash", status: "success", args: { command: "pwd" }, updates: [],
  command: { command: "pwd", stdout: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), stderr: "", exitCode: 0 }
};

test("工具摘要默认收起，命令详情使用紧凑命令行并保留完整输出", () => {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(ActivityToolRow, { ...callbacks, tool })));
  try { assert.equal(dom.window.document.querySelector(".chat-tool-row")?.getAttribute("aria-expanded"), "false"); }
  finally { dom.window.close(); }
  const html = renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool }));
  assert.match(html, /\$ /);
  assert.match(html, /line 29/);
  assert.doesNotMatch(html, /markdown-code-block|command-log-expand|tool-section-label/);
});

test("失败命令只显示一次退出状态，stderr 不把整个日志染红；无输出成功有明确反馈", () => {
  const html = renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool: { ...tool, status: "failed", error: "Command exited with code 1.", command: { command: "pwd", stdout: "", stderr: "permission denied", exitCode: 1 } } }));
  assert.equal((html.match(/退出码 1/g) ?? []).length, 1);
  assert.doesNotMatch(html, /stderr-output|tool-error-output/);
  assert.match(html, /permission denied/);
  const empty = renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool: { ...tool, command: { command: "true", stdout: "", stderr: "", exitCode: 0 } } }));
  assert.match(empty, /已完成，无输出/);
});

test("运行日志尊重向上阅读，工具行 Escape 收起后焦点返回摘要", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    const render = async (stdout: string) => React.act(() => root.render(React.createElement(ToolActivityDetail, {
      ...callbacks, tool: { ...tool, status: "running", command: { command: "watch", stdout, stderr: "" } }
    })));
    await render("first");
    const output = document.querySelector('.chat-command-result pre') as HTMLElement;
    Object.defineProperties(output, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    output.scrollTop = 100;
    output.dispatchEvent(new dom.window.Event("scroll"));
    await render("first\nsecond");
    assert.equal(output.scrollTop, 100, "新增输出不得抢走向上阅读的位置");
    output.scrollTop = 800;
    output.dispatchEvent(new dom.window.Event("scroll"));
    await render("first\nsecond\nthird");
    assert.equal(output.scrollTop, 1000, "回到底部后恢复跟随");
    await React.act(() => root.render(React.createElement(ActivityToolRow, { ...callbacks, tool })));
    const row = document.querySelector('.chat-tool-row') as HTMLButtonElement;
    await React.act(() => row.click());
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    assert.ok(document.getElementById(row.getAttribute('aria-controls')!));
    await React.act(() => row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, row);
    await React.act(() => root.render(React.createElement(ActivitySegment, { ...callbacks, running: false, steps: [
      { kind: "tool", id: "t1", tool },
      { kind: "reasoning", id: "r1", content: "下一步", completed: true }
    ] })));
    const phaseButtons = document.querySelectorAll<HTMLButtonElement>('.chat-phase-avatar');
    await React.act(() => phaseButtons[0]!.click());
    await React.act(() => (document.querySelector('.chat-tool-row') as HTMLButtonElement).click());
    await React.act(() => phaseButtons[1]!.click());
    await React.act(() => phaseButtons[0]!.click());
    assert.equal(document.querySelector('.chat-tool-row')?.getAttribute('aria-expanded'), 'true', '切换阶段保留工具展开选择');
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("通用工具参数与结果可独立复制，长代码提供可访问的展开控件", async () => {
  const { IoCard } = await import("../src/desktop/renderer/src/components/chat/IoCard.js");
  const { CodeView } = await import("../src/desktop/renderer/src/components/chat/CodeView.js");
  const html = renderToStaticMarkup(React.createElement(IoCard, { input: "query", output: "result", outputError: true }));
  assert.match(html, /复制参数/);
  assert.match(html, /复制结果/);
  assert.match(html, /tabindex="0"/);
  const codeHtml = renderToStaticMarkup(React.createElement(CodeView, { code: Array.from({length: 20}, (_, i) => `line ${i}`).join("\n") }));
  assert.match(codeHtml, /aria-expanded="false"/);
});

for (const [status, expected] of [["waiting", "等待确认"], ["cancelled", "已停止"], ["unknown", "执行状态未知"], ["denied", "执行失败"]] as const) {
  test(`命令 ${status} 不误报已完成`, () => {
    const html = renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool: {
      ...tool, status, command: { command: "task", stdout: "", stderr: "" }
    } }));
    assert.match(html, new RegExp(expected));
    assert.doesNotMatch(html, /已完成/);
  });
}
