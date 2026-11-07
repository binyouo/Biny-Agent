import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ToolActivityDetail } from "../src/desktop/renderer/src/components/ToolActivity.js";
import { ActivitySegment } from "../src/desktop/renderer/src/components/chat/ActivitySegment.js";
import { ToolCallCard } from "../src/desktop/renderer/src/components/chat/ToolCallCard.js";
import { createSessionTimelineProjector, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { commandOutputPreview, commandOutputText } from "../src/desktop/renderer/src/commandOutput.js";

const callbacks = { projectId: "p", onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {} };
const tool: TimelineTool = {
  id: "command-1", tool: "Bash", status: "success", args: { command: "pwd" }, updates: [],
  command: { command: "pwd", stdout: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), stderr: "", exitCode: 0 }
};

test("工具摘要默认收起，命令详情分区展示参数和结果并保留完整输出", () => {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(ToolCallCard, { ...callbacks, tool })));
  try { assert.equal(dom.window.document.querySelector(".chat-tool-row")?.getAttribute("aria-expanded"), "false"); }
  finally { dom.window.close(); }
  const html = renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool }));
  assert.match(html, /aria-label="参数 command"/);
  assert.match(html, /command-result-summary/);
  assert.match(html, /line 29/);
  assert.doesNotMatch(html, /markdown-code-block|command-log-expand|chat-command-input/);
});

test("收起工具或整个活动段时不生成隐藏的详情和日志", () => {
  for (const element of [
    React.createElement(ToolCallCard, { ...callbacks, tool }),
    React.createElement(ActivitySegment, { ...callbacks, running: false, steps: [{ kind: "tool", id: tool.id, tool }] })
  ]) {
    const dom = new JSDOM(renderToStaticMarkup(element));
    try {
      assert.equal(dom.window.document.querySelector(".tool-details"), null);
      assert.equal(dom.window.document.querySelector(".chat-command-result"), null);
    } finally { dom.window.close(); }
  }
  const open = renderToStaticMarkup(React.createElement(ToolCallCard, { ...callbacks, tool, open: true }));
  assert.match(open, /line 29/);
});

test("展开长命令日志仅展示两个输出流的有界末尾并提供复制全文", () => {
  const stdout = `stdout beginning\n${"output line\n".repeat(60_000)}stdout ending`;
  const stderr = `stderr beginning\n${"error line\n".repeat(60_000)}stderr ending`;
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(ToolCallCard, {
    ...callbacks, open: true, tool: { ...tool, command: { command: "task", stdout, stderr, exitCode: 0 } }
  })));
  try {
    const output = dom.window.document.querySelector('.chat-command-result pre')?.textContent ?? "";
    assert.ok(output.length <= 33_000, `日志预览必须有界，实际长度为 ${String(output.length)}`);
    assert.match(output, /stdout ending/);
    assert.match(output, /stderr ending/);
    assert.doesNotMatch(output, /stdout beginning|stderr beginning/);
    assert.match(dom.window.document.body.textContent ?? "", /仅显示末尾输出/);
    assert.ok(dom.window.document.querySelector('button[aria-label="复制完整输出"]'));
  } finally { dom.window.close(); }
  assert.equal(commandOutputText({ stdout, stderr }), `${stdout}\n${stderr}`);
});

test("命令预览不截断阈值内的输出，跨字符边界截断后复制仍保留全文", () => {
  const atLimit = `${"a".repeat(16_382)}😀`;
  assert.deepEqual(commandOutputPreview({ stdout: atLimit, stderr: "" }), { text: atLimit, truncated: false });
  const stdout = `前😀${"中".repeat(16_383)}`;
  const preview = commandOutputPreview({ stdout, stderr: "failure" });
  assert.equal(preview.truncated, true);
  assert.equal(preview.text, `…\n${"中".repeat(16_383)}\nfailure`);
  assert.equal(Buffer.from(preview.text).toString("utf8"), preview.text);
  assert.equal(commandOutputText({ stdout, stderr: "failure" }), `${stdout}\nfailure`);
  assert.equal(commandOutputText({ stdout: "stdout\n", stderr: "stderr\n" }), "stdout\nstderr\n");
});

test("实时命令日志随会话投影的连续输出刷新", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const projector = createSessionTimelineProjector();
  const base = { sessionId: "logs", runId: "run", timestamp: "2026-10-13T00:00:00Z" };
  const events: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "message", content: "运行任务" },
    { ...base, type: "tool.started", toolCallId: "command", tool: "Bash", args: { command: "task" }, display: { kind: "command", command: "task" } },
    { ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stdout", text: "first" } }
  ];
  const render = async () => {
    const projected = projector.update({ sessionId: base.sessionId, events, liveEvents });
    await React.act(() => root.render(React.createElement(ToolActivityDetail, { ...callbacks, tool: projected[0]!.tools[0]! })));
    return document.querySelector('.chat-command-result pre')?.textContent;
  };
  try {
    assert.equal(await render(), "first");
    liveEvents.push({ ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stdout", text: "\nsecond" } });
    assert.equal(await render(), "first\nsecond");
    liveEvents.push({ ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stderr", text: "last error" } });
    assert.equal(await render(), "first\nsecond\nlast error");
    const repeated = "x".repeat(16_384);
    liveEvents.splice(2, liveEvents.length - 2, { ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stdout", text: repeated } });
    assert.equal(await render(), repeated);
    liveEvents.push({ ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stdout", text: "x" } });
    assert.equal(await render(), `…\n${repeated}`, "unchanged tail text still updates the first truncation marker");
    assert.ok(document.querySelector('button[aria-label="复制完整输出"]'));
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("实时长日志仅在点击复制时读取完整片段，失败后仍可复制，历史结果保留完整复制", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const writes: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const projector = createSessionTimelineProjector();
  const base = { sessionId: "copy", runId: "run", timestamp: "2026-11-03T00:00:00Z" };
  const events: SessionEvent[] = [];
  let reads = 0;
  const stdout = "stdout start😀" + "o".repeat(20_000) + "\n";
  const stderr = "stderr start" + "e".repeat(20_000) + " stderr end";
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "message", content: "运行任务" },
    { ...base, type: "tool.started", toolCallId: "command", tool: "Bash", args: { command: "task" }, display: { kind: "command", command: "task" } },
    { ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stdout", get text() { reads++; return stdout; } } },
    { ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stderr", get text() { reads++; return stderr; } } }
  ];
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents })[0]!.tools[0]!;
  const render = async (current: TimelineTool) => {
    reads = 0;
    await React.act(() => root.render(React.createElement(ToolActivityDetail, { ...callbacks, tool: current })));
    assert.equal(reads, 0, "rendering the preview must not reread complete output chunks");
    assert.ok((document.querySelector('.chat-command-result pre')?.textContent?.length ?? 0) <= 33_000);
  };
  const copy = async () => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="复制完整输出"]');
    assert.ok(button);
    await React.act(() => button.click());
  };
  try {
    const running = project();
    assert.ok(running.command!.stdout.length <= 16_384, "full live output belongs to the existing chunks, not display state");
    await render(running);
    await copy();
    assert.ok(reads > 0, "the click lazily reads retained chunks");
    assert.deepEqual(writes, [stdout + stderr], "stdout ending in a newline joins stderr without another newline");

    liveEvents.push(
      { ...base, type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stdout", text: "last" } },
      { ...base, type: "tool.failed", toolCallId: "command", tool: "Bash", error: "failed without a result" }
    );
    await render(project());
    await copy();
    assert.deepEqual(writes, [stdout + stderr, stdout + "last\n" + stderr]);
    assert.match(document.body.textContent ?? "", /failed without a result/u);

    // 历史工具没有实时片段，完整结果仍是复制来源。
    const history = projector.update({ sessionId: "history", liveEvents: [], events: [
      { type: "user_message", content: "历史命令" },
      { type: "tool_call", toolCallId: "historical", tool: "Bash", args: { command: "task" } },
      { type: "tool_result", toolCallId: "historical", tool: "Bash", result: { stdout: "history " + stdout, stderr, exitCode: 0 } }
    ] });
    await render(history[0]!.tools[0]!);
    await copy();
    assert.equal(writes[2], "history " + stdout + stderr);
    assert.equal(reads, 0, "historical copies must not consult the prior live tool");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
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
    await React.act(() => root.render(React.createElement(ToolCallCard, { ...callbacks, tool })));
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

for (const [status, expected] of [["waiting", "等待中"], ["cancelled", "已取消"], ["unknown", "结果未知"], ["denied", "已拒绝"]] as const) {
  test(`命令 ${status} 不误报已完成`, () => {
    const html = renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool: {
      ...tool, status, command: { command: "task", stdout: "", stderr: "" }
    } }));
    assert.match(html, new RegExp(expected));
    assert.doesNotMatch(html, /已完成/);
  });
}
