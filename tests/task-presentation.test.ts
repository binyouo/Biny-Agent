import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { TodoProgressPanel } from "../src/desktop/renderer/src/components/workspace/TodoProgressPanel.js";
import { SubagentActivity } from "../src/desktop/renderer/src/components/chat/SubagentActivity.js";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { activityToolRow } from "../src/desktop/renderer/src/chatModel.js";
import { buildSessionTimeline, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import { createSubagentTool } from "../src/extensions/subagent.js";
import { SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";
import { defaultConfig } from "../src/config/schema.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolUpdate } from "../src/tools/types.js";

test("进度使用原生可折叠控件，完成后默认收起，保留数量和完整清单", () => {
  for (const status of ["in_progress", "completed"] as const) {
    const html = renderToStaticMarkup(React.createElement(TodoProgressPanel, {
      sessionId: "s", projection: { sessionId: "s", plans: [], todos: [{ content: "检查入口", status }] }
    }));
    const dom = new JSDOM(html);
    try {
      const disclosure = dom.window.document.querySelector("details");
      assert.ok(disclosure, "清单必须可以用鼠标和键盘自由展开、收起");
      assert.equal(disclosure.open, status !== "completed");
      assert.match(disclosure.querySelector("summary")!.textContent!, status === "completed" ? /1\/1/ : /检查入口/);
      assert.match(disclosure.querySelector("ol")!.textContent!, /检查入口/);
    } finally { dom.window.close(); }
  }
  assert.equal(renderToStaticMarkup(React.createElement(TodoProgressPanel, {
    sessionId: "other", projection: { sessionId: "s", plans: [], todos: [{ content: "旧任务", status: "pending" }] }
  })), "");
});

const task: TimelineTool = { id: "child", tool: "Task", args: { task: "检查缓存的失效边界", agent: "reviewer" }, status: "running", updates: [] };
test("委派执行从工具进度发出排队、执行和终态，结果保持原始返回值", async () => {
  const manager = new SubagentTaskManager({ maxConcurrentSubagents: 1, timeoutMs: 1000, execute: async () => "检查完成" });
  const updates: ToolUpdate[] = [];
  try {
    const tool = createSubagentTool({ workspaceRoot: "/tmp", config: defaultConfig, toolRegistry: new ToolRegistry(),
      getModelSettings() { throw new Error("Model must stay behind the injected worker boundary"); },
      async runTask(input, context) {
        const unsubscribe = manager.subscribe((snapshot) => context.onUpdate?.({ kind: "status", customKind: "subagent", customData: { status: snapshot.status } }));
        try { return await manager.run(input.task); } finally { unsubscribe(); }
      }
    });
    const execution = await tool.resolveExecution(tool.schema.parse({ task: "检查缓存" }));
    assert.ok("execute" in execution);
    assert.equal(await execution.execute({ toolCallId: "parent", operationId: "operation", onUpdate: (update) => updates.push(update) }), "检查完成");
    assert.deepEqual(updates.filter((update) => update.customKind === "subagent").map((update) => (update.customData as { status: string }).status), ["queued", "running", "completed"]);
  } finally { await manager.close(); }
});
test("子代理摘要读取实际 task 参数", () => {
  assert.equal(activityToolRow(task).object, "检查缓存的失效边界");
});

test("后台启动的工具结果表示已委派，不把启动时的快照当作实时任务状态", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentActivity, {
    tool: { ...task, args: { task: "检查缓存", background: true }, status: "success", result: { status: "running", taskRunId: "child" } },
    projectId: "p", onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}
  }));
  const dom = new JSDOM(html);
  try { assert.equal(dom.window.document.querySelector('[role="status"]')!.textContent, "已委派"); }
  finally { dom.window.close(); }
});

test("无效子代理参数和未知状态仍可查看错误详情，不中断时间线", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentActivity, {
    tool: { ...task, args: { task: { unexpected: true }, agent: [1] }, status: "success", result: { status: "__proto__" } },
    projectId: "p", onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}
  }));
  const dom = new JSDOM(html);
  try {
    const summary = dom.window.document.querySelector("summary")!.textContent!;
    assert.match(summary, /子代理/);
    assert.match(summary, /委派任务/);
    assert.match(summary, /状态待确认/);
  } finally { dom.window.close(); }
});

test("子代理调用独立显示在时间线，历史完成结果仍可展开", () => {
  const turns = buildSessionTimeline([
    { type: "user_message", content: "检查缓存", time: "2026-09-30T00:00:00Z" },
    { type: "tool_call", tool: "Task", toolCallId: "child", args: task.args, time: "2026-09-30T00:00:01Z" },
    { type: "tool_result", tool: "Task", toolCallId: "child", result: "缓存过期处理正确", time: "2026-09-30T00:00:02Z" },
    { type: "assistant_message", content: "检查结束", time: "2026-09-30T00:00:03Z" }
  ], []);
  const noop = () => {};
  const asyncNoop = async () => {};
  const html = renderToStaticMarkup(React.createElement(MessageTimeline, {
    projectId: "p", turns, thinking: false, onPreviewFile: noop, onOpenExternal: noop,
    onResolvePermission: asyncNoop, onRetry: asyncNoop, onSwitchVersion: asyncNoop,
    onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop,
    onReferenceMessage: noop, onShowMessageReferences: noop, onAddQuoteToConversation: asyncNoop
  }));
  const dom = new JSDOM(html);
  try {
    const card = dom.window.document.querySelector(".chat-subagent");
    assert.ok(card, "子代理不得只藏在已收起的通用工具活动里");
    assert.match(card.querySelector("summary")!.textContent!, /reviewer/);
    assert.match(card.textContent!, /检查缓存的失效边界/);
    assert.match(card.textContent!, /缓存过期处理正确/);
  } finally { dom.window.close(); }
});
