import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopSlashResult } from "../src/desktop/protocol.js";
import { ComposerDraftState } from "../src/desktop/renderer/src/components/composer/composerDraft.js";
import { desktopGoalCommandAllowsNoModel } from "../src/desktop/renderer/src/components/composer/desktopSlashCommands.js";
import { sessionGoalSlashFeedback } from "../src/desktop/renderer/src/components/workspace/sessionGoalControl.js";

const output = (sessionGoal: DesktopSlashResult["sessionGoal"]): DesktopSlashResult => ({
  command: "/goal", title: "当前目标", content: "raw result", sessionId: "session-a", sessionGoal
});
test("Goal 控制按实际状态提示，查询保留报告，过期响应无反馈", () => {
  const active = output({ action: "set", status: "active" });
  const activeFeedback = sessionGoalSlashFeedback(active, true);
  assert.equal(activeFeedback.result, undefined, "successful goal controls must not open the raw JSON report");
  assert.match(activeFeedback.notice ?? "", /已进入 Goal 模式/u);
  assert.deepEqual(sessionGoalSlashFeedback(active, false), {}, "a response for an old session must emit no feedback");
  assert.match(sessionGoalSlashFeedback(output({ action: "set", status: "paused" }), true).notice ?? "", /仍暂停/u);
  for (const status of ["paused", "blocked", "budget_limited", "completed"] as const) {
    assert.doesNotMatch(sessionGoalSlashFeedback(output({ action: "set", status }), true).notice ?? "", /已进入 Goal 模式/u);
  }
  assert.match(sessionGoalSlashFeedback(output({ action: "resume", status: "active" }), true).notice ?? "", /已进入 Goal 模式/u);
  assert.match(sessionGoalSlashFeedback(output({ action: "pause", status: "paused" }), true).notice ?? "", /已暂停/u);
  assert.match(sessionGoalSlashFeedback(output({ action: "clear" }), true).notice ?? "", /退出 Goal 模式/u);
  const query = output({ action: "get", status: "active" });
  assert.deepEqual(sessionGoalSlashFeedback(query, true), { result: query });
  const workspace = { command: "/goal", title: "Workspace Goal", content: "workspace result" };
  assert.deepEqual(sessionGoalSlashFeedback(workspace, true), { result: workspace });
});

test("Goal 查询、暂停和清除可在未配置模型时调用", () => {
  for (const input of ["/goal", "/goal show", " /goal\tSHOW\n", "/goal pause", "/goal clear"]) {
    assert.equal(desktopGoalCommandAllowsNoModel(input), true, input);
  }
  for (const input of ["/goal finish the task", "/goal set finish", "/goal resume", "/goal show extra", "/goal pause workspace-id", "/GOAL", "ordinary message"]) {
    assert.equal(desktopGoalCommandAllowsNoModel(input), false, input);
  }
});

// 静态渲染只检查公开按钮状态，不运行界面或触发键盘、点击。
test("Composer 在无模型时只允许安全 Goal 控制提交", async () => {
  const imports = registerHooks({ load(url, context, next) {
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const reactGlobal = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
  const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
  function composerMarkup(input: string): string {
    const draft = new ComposerDraftState();
    draft.update({ draft: { value: input, tokens: [] } });
    const noop = async (): Promise<void> => undefined;
    return renderToStaticMarkup(createElement(Composer, {
      project: { id: "project-a", name: "project-a", path: "/tmp/project-a", dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" },
      drafts: new Map([["project-a:session-a", draft]]), draftKey: "project-a:session-a",
      models: [], memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
      running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: true,
      focusToken: 0, capabilityDefaults: { tools: "auto", skills: "auto" }, skills: [], toolCatalog: [],
      onSend: noop, onMutateQueuedMessage: noop, onResume: noop, onSubmitEdit: noop, onCancelEdit: () => undefined,
      onSlashCommand: noop, onStop: noop, onToggleMemory: noop, onSwitchModel: noop,
      onSaveAttachment: async () => { throw new Error("unused"); }, onWarning: () => undefined, onSubmitError: () => undefined
    }));
  }
  for (const input of ["/goal", "/goal show", "/goal pause", "/goal clear"]) {
    const markup = composerMarkup(input);
    const send = markup.match(/<button[^>]*aria-label="发送消息"[^>]*>/u)?.[0];
    assert.ok(send, "the composer must expose the send action");
    assert.doesNotMatch(send, /disabled/u, input);
  }
  for (const input of ["ordinary message", "/goal finish the task", "/goal resume"]) {
    const send = composerMarkup(input).match(/<button[^>]*aria-label="发送消息"[^>]*>/u)?.[0];
    assert.ok(send);
    assert.match(send, /disabled/u, input);
  }
  } finally {
    imports.deregister();
    if (reactGlobal) Object.defineProperty(globalThis, "React", reactGlobal);
    else Reflect.deleteProperty(globalThis, "React");
  }
});
