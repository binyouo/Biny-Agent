/** 授权阶段只显示一份操作内容，执行结果与批准状态分别展示。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ToolActivityDetail, ToolPermission } from "../src/desktop/renderer/src/components/ToolActivity.js";
import type { TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";

const command = "rm -rf recipe-state && ls -la";
const tool: TimelineTool = {
  id: "t", tool: "Bash", args: { command }, status: "waiting", updates: [],
  command: { command, stdout: "", stderr: "" },
  permission: { requestId: "p", resolved: false, request: {
    toolCallId: "t", tool: "Bash", title: "Command execution request", command,
    details: `${command}\nSensitive command warning: recursively force deletes files`,
    reason: `Run ${command}`, actionType: "shell", riskLevel: "critical", requireFullYes: true
  } }
};
function render(value: TimelineTool): string {
  return renderToStaticMarkup(createElement(ToolPermission, {
    tool: value, onResolvePermission: async () => undefined
  }));
}
test("等待批准时去除英文复述、风险徽章与重复输出卡，保留强确认", () => {
  const html = render(tool);
  assert.match(html, /允许运行此命令/u);
  assert.match(html, /递归强制删除文件/u);
  assert.doesNotMatch(html, /Command execution request|Sensitive command warning|等待输出|tool-output-surface|risk-badge/u);
  assert.equal((html.match(/recipe-state/gu) ?? []).length, 1);
  assert.match(html, /placeholder="yes"/u);
  assert.match(html, /class="is-primary" disabled/u);
});
test("批准后显示简短结果和真实输出，不保留待批准卡", () => {
  const html = render({ ...tool, status: "success", command: { command, stdout: "done", stderr: "", exitCode: 0 }, permission: { ...tool.permission!, resolved: true, approved: true, action: "allow_once" } });
  assert.match(html, /已允许一次/u);
  const output = renderToStaticMarkup(createElement(ToolActivityDetail, { projectId: "project", tool: { ...tool, status: "success", command: { command, stdout: "done", stderr: "" } }, onPreviewFile: () => undefined, onOpenExternal: () => undefined }));
  assert.match(output, /done/u);
  assert.doesNotMatch(html, /允许运行此命令|placeholder="yes"/u);
});

test("逐次确认的请求不展示会话授权，普通请求保留会话授权", () => {
  const permission = tool.permission!;
  const html = render({ ...tool, permission: { ...permission, request: { ...permission.request, canRemember: false } } });
  assert.match(html, /按设置需要逐次确认/u);
  assert.doesNotMatch(html, /本会话允许/u);
  assert.match(render(tool), /本会话允许/u);
});

test("工具详情收起时授权卡片位于折叠容器之外", async () => {
  const { ActivitySegment, ActivityToolRow } = await import("../src/desktop/renderer/src/components/chat/ActivitySegment.js");
  const pendingTool: TimelineTool = { ...tool, tool: "skill_install", args: { name: "demo" }, command: undefined };
  const callbacks = {
    projectId: "project",
    onPreviewFile: () => undefined, onOpenExternal: () => undefined, onResolvePermission: async () => undefined
  };
  for (const element of [
    createElement(ActivityToolRow, { ...callbacks, tool: pendingTool }),
    createElement(ActivitySegment, { ...callbacks, running: false, steps: [{ kind: "tool", id: tool.id, tool: pendingTool }] })
  ]) {
    const dom = new JSDOM(renderToStaticMarkup(element));
    try {
      const document = dom.window.document;
      assert.equal(document.querySelector(".chat-tool-row")?.getAttribute("aria-expanded"), "false");
      const permission = document.querySelector(".permission-card");
      assert.ok(permission);
      assert.equal(permission.closest('[inert], [aria-hidden="true"]'), null);
      assert.equal(document.querySelector(".tool-details"), null);
    } finally { dom.window.close(); }
  }
});
