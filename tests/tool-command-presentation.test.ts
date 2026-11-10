import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ToolActivityDetail } from "../src/desktop/renderer/src/components/ToolActivity.js";
import { buildSessionTimeline, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";

const callbacks = { projectId: "command-results", onPreviewFile() {}, onOpenExternal() {} };
const command = "ls /Applications | rg -i music";

function render(tool: TimelineTool): JSDOM {
  return new JSDOM(renderToStaticMarkup(React.createElement(ToolActivityDetail, { ...callbacks, tool })));
}

test("命令详情展示完整参数、独立结果与成功状态，不补造内部调用和节省量", () => {
  const dom = render({
    id: "shell", tool: "Bash", status: "success", updates: [],
    args: { description: "查找音乐应用", command, timeout_ms: 5000 },
    result: { stdout: "NeteaseMusic.app\n", stderr: "", exitCode: 0 }
  });
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelector('[aria-label="参数 description"]')?.textContent, "查找音乐应用");
    assert.equal(doc.querySelector('[aria-label="参数 command"]')?.textContent, command);
    assert.equal(doc.querySelector('[aria-label="参数 timeout_ms"]')?.textContent, "5000");
    assert.equal(doc.querySelector('.tool-code-block[data-language="bash"] pre')?.textContent, command);
    assert.equal(doc.querySelector('[aria-label="复制参数 command"]')?.tagName, "BUTTON");
    assert.equal(doc.querySelector('.command-result-summary .tool-section-label')?.textContent, "结果");
    assert.equal(doc.querySelector('.command-result-summary .tool-execution-status')?.getAttribute("data-status"), "success");
    assert.match(doc.querySelector('.command-result-summary')?.textContent ?? "", /Success/);
    assert.equal(doc.querySelector('[aria-label="命令输出"]')?.textContent, "NeteaseMusic.app\n");
    assert.equal(doc.querySelector('.chat-command-input'), null);
    assert.equal(doc.querySelector('.script-calls-toggle'), null);
    assert.doesNotMatch(doc.body.textContent ?? "", /tokens saved|tool calls?/);
  } finally { dom.window.close(); }
});

test("历史失败命令保留正常输出、失败胶囊和一次退出码", () => {
  const turn = buildSessionTimeline([
    { type: "user_message", content: "查找应用" },
    { type: "tool_call", toolCallId: "shell", tool: "Bash", args: { description: "查找音乐应用", command } },
    { type: "tool_result", toolCallId: "shell", tool: "Bash", result: { stdout: "NeteaseMusic.app", stderr: "", exitCode: 1 }, error: "Command exited with code 1.", executionStatus: "failed" }
  ], [])[0]!;
  const dom = render(turn.tools[0]!);
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelector('.command-result-summary .tool-execution-status')?.getAttribute("data-status"), "failed");
    assert.equal(doc.querySelector('[aria-label="命令输出"]')?.textContent, "NeteaseMusic.app");
    assert.equal((doc.body.textContent?.match(/退出码 1/g) ?? []).length, 1);
    assert.doesNotMatch(doc.body.textContent ?? "", /Command exited|Success/);
  } finally { dom.window.close(); }
});

test("缺少原参数的命令记录仍展示已保存的命令，不输出不存在的 cwd", () => {
  const dom = render({ id: "legacy", tool: "Bash", status: "success", updates: [], command: { command, stdout: "", stderr: "", exitCode: 0 } });
  try {
    assert.equal(dom.window.document.querySelector('[aria-label="参数 command"]')?.textContent, command);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /undefined|cwd/);
    assert.match(dom.window.document.body.textContent ?? "", /Success.*已完成，无输出/);
  } finally { dom.window.close(); }
});

test("非零退出码与具体执行错误不能被成功标签掩盖", () => {
  const dom = render({
    id: "nonzero", tool: "Bash", status: "success", updates: [], args: { command }, error: "spawn permission denied",
    command: { command, stdout: "", stderr: "", exitCode: 126 }
  });
  try {
    assert.equal(dom.window.document.querySelector('.command-result-summary .tool-execution-status')?.getAttribute("data-status"), "failed");
    assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, "spawn permission denied");
    assert.equal((dom.window.document.body.textContent?.match(/退出码 126/g) ?? []).length, 1);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Success|已完成/);
  } finally { dom.window.close(); }
});

for (const status of ["running", "waiting", "cancelled", "aborted", "skipped", "unknown", "denied"] as const) {
  test(`命令 ${status} 保留真实状态与局部输出`, () => {
    const dom = render({
      id: "shell", tool: "Bash", status, updates: [], args: { command },
      command: { command, stdout: "partial", stderr: "" }
    });
    try {
      assert.equal(dom.window.document.querySelector('.command-result-summary .tool-execution-status')?.getAttribute("data-status"), status);
      assert.equal(dom.window.document.querySelector('[aria-label="命令输出"]')?.textContent, "partial");
      assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Success|已完成/);
    } finally { dom.window.close(); }
  });
}
