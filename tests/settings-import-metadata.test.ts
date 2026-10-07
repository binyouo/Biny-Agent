import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { SettingsImportContent } from "../src/desktop/renderer/src/components/settings/SettingsImport.js";
import type { ApplicationImportSnapshot } from "../src/imports/types.js";

const callbacks = { onRetry() {}, onChoose() {}, onCustomize() {}, onSyncChange() {}, onSync() {} };
function render(snapshot: ApplicationImportSnapshot | undefined, options: { loading?: boolean; error?: string; busy?: boolean } = {}) {
  return new JSDOM(renderToStaticMarkup(createElement(SettingsImportContent, { ...callbacks, snapshot, loading: options.loading ?? false, error: options.error, busy: options.busy ?? false }))).window.document;
}
const empty: ApplicationImportSnapshot = { sources: [
  { source: "claude", label: "Claude Code", detected: false, description: "未发现本机配置。" },
  { source: "chatgpt", label: "ChatGPT", detected: false, description: "选择导出的 JSON 文件。" }
], history: [], sync: { enabled: false, hasSelection: false } };
test("import page exposes real empty, loading, failure and unavailable-source states", () => {
  assert.match(render(undefined, { loading: true }).querySelector('[role="status"]')!.textContent!, /检测导入来源/u);
  assert.match(render(undefined, { error: "无法读取导入状态" }).querySelector('[role="alert"]')!.textContent!, /无法读取导入状态/u);
  const document = render(empty);
  assert.match(document.body.textContent!, /尚未导入内容/u);
  assert.ok(document.querySelector('[role="switch"]')!.hasAttribute("disabled"));
  assert.ok(document.querySelector('[aria-label="从 Claude Code 导入"]')!.hasAttribute("disabled"));
  assert.equal(document.querySelector('[aria-label="从 ChatGPT 导入"]')!.hasAttribute("disabled"), false);
});
test("history preserves imported, skipped, failed and uncertain results by category", () => {
  const snapshot: ApplicationImportSnapshot = { ...empty, history: [{ id: "history", source: "claude", label: "Claude Code", time: "2026-10-07T01:00:00Z", workspaceRoot: "/fixture", results: [
    { id: "model", category: "settings", label: "模型", status: "imported" },
    { id: "mcp", category: "mcp", label: "服务器", status: "skipped", detail: "已有同名项" },
    { id: "chat", category: "sessions", label: "损坏会话", status: "failed", detail: "来源已变化" },
    { id: "uncertain", category: "sessions", label: "中断导入", status: "unknown", detail: "禁止自动重试" }
  ] }], sync: { enabled: true, hasSelection: true } };
  const document = render(snapshot, { busy: true });
  assert.equal(document.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
  assert.match(document.querySelector('.import-history > summary')!.textContent!, /已导入 1 项/u);
  assert.deepEqual([...document.querySelectorAll('.import-result')].map(element => element.textContent), ["已导入", "已跳过", "失败", "结果待确认"]);
  assert.ok([...document.querySelectorAll('button')].every(button => button.disabled));
  assert.match(document.body.textContent!, /禁止自动重试/u);
});
