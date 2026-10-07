import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TaskInspector } from "../src/desktop/renderer/src/components/chat/TaskInspector.js";
import type { TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { TaskInspection, TaskInspectionOptions } from "../src/runtime/TaskCommunication.js";

function panelFixture(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const values = { React, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.method(dom.window.HTMLCanvasElement.prototype, "getContext", () => null);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: { project: string; session: string; task: string; options: TaskInspectionOptions; resolve(value: TaskInspection): void }[] = [];
  Object.assign(dom.window, { biny: { taskInspection: (project: string, session: string, task: string, options: TaskInspectionOptions) => new Promise<TaskInspection>(resolve => calls.push({ project, session, task, options, resolve })) } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const panel = (task: string, tool?: TimelineTool) => React.createElement(TaskInspector, { key: task, selection: { projectId: "project", sessionId: "parent", taskRunId: task, name: task, tool }, onPreviewFile() {}, onOpenExternal() {} });
  const inspection = (task: string): TaskInspection => ({ taskRunId: task, sessionId: "parent", name: task, title: "observe", status: "running", revision: 1, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", attempts: [], inputOpen: true, resumable: false, messages: [], activity: [], cursor: 0, hasMore: false });
  let mounted = true;
  const unmount = async () => { await act(async () => root.unmount()); mounted = false; };
  t.after(async () => {
    if (mounted) await unmount();
    t.mock.timers.reset(); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return { calls, inspection, unmount, document: dom.window.document, render: async (task: string, tool?: TimelineTool) => { await act(async () => root.render(panel(task, tool))); } };
}

// SSR cannot expose a closed panel re-arming its polling timer after a late IPC response.
test("switching or closing the child observer discards late IPC responses and releases polling", async (t) => {
  const f = panelFixture(t);
  await f.render("old"); await f.render("current");
  assert.deepEqual(f.calls.map(({ project, session, task }) => [project, session, task]), [["project", "parent", "old"], ["project", "parent", "current"]]);
  await act(async () => { f.calls[0]!.resolve(f.inspection("old")); });
  assert.doesNotMatch(f.document.body.textContent!, /old/);
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(f.calls.length, 2, "an obsolete request must not schedule another read");
  await act(async () => { f.calls[1]!.resolve(f.inspection("current")); });
  assert.equal(f.document.querySelector("textarea, input"), null);
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(f.calls.length, 3, "the visible running child refreshes its own progress");
  await f.unmount();
  await act(async () => { f.calls[2]!.resolve(f.inspection("current")); });
  await act(async () => { t.mock.timers.tick(10_000); });
  assert.equal(f.calls.length, 3, "closing releases polling even when IPC finishes afterwards");
});

// A terminal task may have many historical pages; it must not stop at the first page or require a button.
test("the observer automatically drains terminal history one page at a time and stops at the final cursor", async (t) => {
  const f = panelFixture(t); await f.render("history");
  const first = { ...f.inspection("history"), status: "completed" as const, cursor: 100, hasMore: true, activity: [{ id: "model-request", sequence: 90, createdAt: "2026-10-07T00:00:00Z", kind: "model" as const, model: { id: "worker-model", provider: "test-provider" } }] };
  await act(async () => { f.calls[0]!.resolve(first); });
  assert.doesNotMatch(f.document.body.textContent!, /加载更多/);
  assert.match(f.document.querySelector(".subagent-card-header")!.textContent!, /worker-model/);
  await act(async () => { t.mock.timers.tick(16); });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.options.afterSequence, 100);
  assert.notEqual(f.calls[1]!.options.summary, true);
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(f.calls.length, 2, "no overlapping page requests");
  await act(async () => { f.calls[1]!.resolve({ ...first, cursor: 101, hasMore: false, activity: [{ id: "answer", sequence: 101, createdAt: first.createdAt, kind: "assistant", content: "Last page report" }] }); });
  assert.match(f.document.body.textContent!, /Last page report/);
  await act(async () => { t.mock.timers.tick(10_000); });
  assert.equal(f.calls.length, 2, "a fully loaded terminal task stops polling");
  await f.render("different-attempt");
  assert.doesNotMatch(f.document.querySelector(".subagent-card-header")!.textContent!, /worker-model/);
});

test("automatic history loading stops on a non-advancing cursor instead of repeatedly reading the same page", async (t) => {
  const f = panelFixture(t); await f.render("stalled");
  await act(async () => { f.calls[0]!.resolve({ ...f.inspection("stalled"), status: "completed", hasMore: true, cursor: 0 }); });
  assert.match(f.document.querySelector('[role="alert"]')!.textContent!, /游标未前进/);
  await act(async () => { t.mock.timers.tick(10_000); });
  assert.equal(f.calls.length, 1);
});

test("an ended child reports its step limit separately from task completion and keeps the recorded worker model", async (t) => {
  const f = panelFixture(t); await f.render("ended-child");
  await act(async () => { f.calls[0]!.resolve({ ...f.inspection("ended-child"), status: "incomplete", stopReason: "step_limit", reason: "Subagent did not complete (stopReason=step_limit).\n\nPartial work", activity: [{ id: "worker-model", kind: "model", sequence: 1, createdAt: "2026-10-07T00:00:00Z", model: { provider: "local", id: "child-model" } }] }); });
  assert.equal(f.document.querySelector('.subagent-card-header [role="status"]')!.textContent, "已停止 · 步数用尽");
  assert.match(f.document.querySelector('.subagent-card-outcome')!.textContent!, /达到执行步数上限/);
  assert.match(f.document.querySelector('.subagent-card-header')!.textContent!, /child-model/);
  await f.render("successful-child");
  await act(async () => { f.calls[1]!.resolve({ ...f.inspection("successful-child"), status: "completed" }); });
  assert.equal(f.document.querySelector('.subagent-card-header [role="status"]')!.textContent, "已完成");
  assert.equal(f.document.querySelector('.subagent-card-outcome'), null);
});

for (const [stopReason, label, reason] of [
  ["permission_denied", "已停止 · 权限受阻", "权限策略拒绝了子代理操作"],
  ["approval_required", "已停止 · 待父代理处理授权", "子代理操作需要批准"],
  ["inactivity_timeout", "已停止 · 无响应", "长时间没有模型输出或工具进度"]
]) {
  test(`observer explains ${stopReason} as a stopped task requiring parent attention`, async (t) => {
    const f = panelFixture(t); await f.render("blocked-child");
    await act(async () => { f.calls[0]!.resolve({ ...f.inspection("blocked-child"), status: "incomplete", stopReason,
      reason: `Subagent did not complete (stopReason=${stopReason}).\n\nWrite: blocked.txt` }); });
    assert.equal(f.document.querySelector('.subagent-card-header [role="status"]')!.textContent, label);
    assert.ok(f.document.querySelector('.subagent-card-outcome')!.textContent!.includes(reason!));
  });
}

test("collapsed cards only poll summaries and remain collapsed when the worker completes", async (t) => {
  const f = panelFixture(t); await f.render("folded");
  await act(async () => { f.calls[0]!.resolve({ ...f.inspection("folded"), attemptId: "attempt-1", cursor: 1, activity: [
    { id: "model", sequence: 1, createdAt: "now", kind: "model", model: { id: "child-model", provider: "fixture" } }
  ] }); });
  const disclosure = f.document.querySelector<HTMLDetailsElement>(".subagent-card")!;
  await act(async () => { disclosure.open = false; disclosure.dispatchEvent(new f.document.defaultView!.Event("toggle")); });
  assert.equal(f.calls.at(-1)!.options.summary, true);
  assert.equal(f.document.querySelector(".subagent-card-scroll"), null, "hidden bodies must release their render observers");
  await act(async () => { f.calls.at(-1)!.resolve({ ...f.inspection("folded"), attemptId: "attempt-1", status: "completed" }); });
  assert.equal(disclosure.open, false, "new output never overrides the reader's collapse choice");
  assert.match(disclosure.querySelector("summary")!.textContent!, /已完成.*child-model/);
  const count = f.calls.length;
  await act(async () => { t.mock.timers.tick(10_000); });
  assert.equal(f.calls.length, count, "terminal collapsed cards stop polling");
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new f.document.defaultView!.Event("toggle")); });
  assert.equal(f.calls.at(-1)!.options.summary, false);
  assert.equal(f.calls.at(-1)!.options.afterSequence, 1);
  await act(async () => { f.calls.at(-1)!.resolve({ ...f.inspection("folded"), attemptId: "attempt-1", status: "completed", cursor: 2,
    activity: [{ id: "answer", sequence: 2, createdAt: "now", kind: "assistant", content: "Final worker report" }] }); });
  assert.match(disclosure.textContent!, /Final worker report/);
});

test("reading older child output suspends following until the reader returns to the bottom", async (t) => {
  const f = panelFixture(t); await f.render("scrolling");
  await act(async () => { f.calls[0]!.resolve(f.inspection("scrolling")); });
  const viewport = f.document.querySelector<HTMLElement>(".subagent-card-scroll")!;
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  viewport.scrollTop = 100;
  await act(async () => { viewport.dispatchEvent(new f.document.defaultView!.Event("scroll")); });
  await act(async () => { t.mock.timers.tick(1000); });
  await act(async () => { f.calls.at(-1)!.resolve({ ...f.inspection("scrolling"), cursor: 1, activity: [{ id: "note", sequence: 1, createdAt: "now", kind: "assistant", content: "A new finding" }] }); });
  assert.equal(viewport.scrollTop, 100);
  assert.match(f.document.querySelector(".subagent-card-latest")!.textContent!, /回到最新/);
  viewport.scrollTop = 800;
  await act(async () => { viewport.dispatchEvent(new f.document.defaultView!.Event("scroll")); });
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1200 });
  await act(async () => { t.mock.timers.tick(1000); });
  await act(async () => { f.calls.at(-1)!.resolve({ ...f.inspection("scrolling"), cursor: 2, activity: [{ id: "next", sequence: 2, createdAt: "now", kind: "assistant", content: "Another finding" }] }); });
  assert.equal(viewport.scrollTop, 1200);
  assert.equal(f.document.querySelector(".subagent-card-latest"), null);
});

// A tool-call event precedes TaskRun admission; querying immediately can strand a new card on a not-found error.
test("a new child waits for TaskRun admission before reading its execution record", async (t) => {
  const f = panelFixture(t);
  const tool: TimelineTool = { id: "call", tool: "Task", args: { task: "inspect" }, status: "running", updates: [] };
  await f.render("admission", tool);
  assert.equal(f.calls.length, 0, "a running tool call alone is not an admitted worker identity");
  await f.render("admission", { ...tool, updates: [{ kind: "status", customKind: "subagent", customData: { taskId: "admission", status: "running" } }] });
  assert.equal(f.calls.length, 1);
  await act(async () => f.calls[0]!.resolve(f.inspection("admission")));
  assert.equal(f.document.querySelector('[role="alert"]'), null);
});
