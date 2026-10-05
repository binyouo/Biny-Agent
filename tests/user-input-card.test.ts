/** Real clarification state with local React/IPC fakes; no Runtime Host or model listener. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { UserInputCard } from "../src/desktop/renderer/src/components/chat/UserInputCard.js";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { buildSessionTimeline, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { UserInputRequests, userInputQuestionsSchema, type UserInputResponse } from "../src/runtime/userInput.js";

const owner = { sessionId: "session", runId: "run" };
const questionIds = ["place", "constructor", "__proto__", "toString"];

function questionTool(ids = questionIds, toolCallId = "question"): TimelineTool {
  return { id: toolCallId, runId: owner.runId, tool: "AskUserQuestion", status: "running", updates: [],
    args: userInputQuestionsSchema.parse({ questions: ids.map((id) => ({ id, question: `Choose ${id}`, options: [{ label: "Desktop" }, { label: "Project" }], multiSelect: id === "__proto__" })) }) };
}

function waitForQuestion(requests: UserInputRequests, tool: TimelineTool, signal?: AbortSignal) {
  return requests.request(userInputQuestionsSchema.parse(tool.args), { ...owner, runId: tool.runId!, toolCallId: tool.id, signal });
}

function card(tool: TimelineTool, running = true) {
  return createElement(UserInputCard, { tool, projectId: "project", sessionId: owner.sessionId, running });
}

test("schema-valid inherited question IDs render while the real request remains pending", async () => {
  for (const id of questionIds) {
    const requests = new UserInputRequests();
    requests.setRun(owner);
    const tool = questionTool([id]);
    const completion = waitForQuestion(requests, tool);
    try {
      const markup = renderToStaticMarkup(card(tool));
      assert.match(markup, /等待你的回答/u, id);
      assert.match(markup, new RegExp(`Choose ${id}`, "u"), id);
      assert.equal(requests.list().length, 1, "rendering cannot settle the request");
      requests.answer(owner.sessionId, owner.runId, tool.id, { status: "skipped" });
      assert.deepEqual((await completion).response, { status: "skipped" });
      assert.match(renderToStaticMarkup(card({ ...tool, status: "success", result: { response: { status: "skipped" } } }, false)), /已跳过/u);
    } finally {
      void completion.catch(() => undefined);
      requests.setRun();
    }
  }
});

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const requests = new UserInputRequests();
  requests.setRun(owner);
  const calls: Array<{ projectId: string; sessionId: string; runId: string; toolCallId: string; response: UserInputResponse }> = [];
  Object.assign(dom.window, { biny: {
    async answerUserInput(projectId: string, sessionId: string, runId: string, toolCallId: string, response: UserInputResponse) {
      calls.push({ projectId, sessionId, runId, toolCallId, response });
      requests.answer(sessionId, runId, toolCallId, response);
    }
  } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (tool: TimelineTool, running = true) => {
    const base = { ...owner, runId: tool.runId!, timestamp: "2026-10-05T00:00:00.000Z" };
    const events: AgentHostEvent[] = [
      { ...base, type: "message.user", messageId: `user-${tool.runId}`, content: "Clarify the target" },
      { ...base, type: "tool.started", tool: tool.tool, toolCallId: tool.id, args: tool.args }
    ];
    if (tool.status === "success") events.push({ ...base, type: "tool.completed", tool: tool.tool, toolCallId: tool.id, result: tool.result });
    if (tool.status === "failed") events.push({ ...base, type: "tool.failed", tool: tool.tool, toolCallId: tool.id, error: tool.error ?? "Cancelled" });
    if (!running) events.push({ ...base, type: "run.cancelled", reason: "Ended", durationMs: 1 });
    const noop = () => {};
    const noopAsync = async () => {};
    await act(() => root.render(createElement(MessageTimeline, { turns: buildSessionTimeline([], events),
      projectId: "project", sessionId: owner.sessionId, thinking: running, runtimeActiveRunId: running ? tool.runId : undefined,
      onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
      onAddQuoteToConversation: noopAsync, onResolvePermission: noopAsync, onRetry: noopAsync,
      onSwitchVersion: noopAsync, onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop })));
  };
  const click = async (selector: string) => {
    const target = dom.window.document.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
    assert.ok(target, selector);
    await act(async () => target.click());
  };
  const input = async (questionIndex: number, value: string) => {
    const target = dom.window.document.querySelectorAll("textarea")[questionIndex];
    assert.ok(target);
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    const form = dom.window.document.querySelector("form");
    assert.ok(form);
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
  };
  return { dom, requests, calls, render, click, input, submit, async close() {
    requests.setRun();
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

test("multiple inherited and ordinary IDs retain independent choices and custom answers through submission", async () => {
  const view = await fixture();
  const tool = questionTool();
  const completion = waitForQuestion(view.requests, tool);
  void completion.catch(() => undefined);
  try {
    await view.render(tool);
    const document = view.dom.window.document;
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, true);
    await view.click('fieldset:nth-of-type(1) input[value="Desktop"]');
    await view.input(1, "Custom constructor target");
    await view.click('fieldset:nth-of-type(3) input[value="Project"]');
    await view.input(2, "Extra prototype note");
    await view.click('fieldset:nth-of-type(4) input[value="Desktop"]');
    // Updating ordinary and inherited keys must preserve every other answer.
    await view.input(0, "Custom ordinary target");
    await view.click('fieldset:nth-of-type(1) input[value="Project"]');
    await view.input(3, "Custom toString target");
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, false);
    await view.submit();
    assert.equal(view.calls.length, 1, "a repeated submit cannot answer twice");
    assert.deepEqual(view.calls[0], { projectId: "project", ...owner, toolCallId: tool.id,
      response: { status: "answered", answers: [
        { id: "place", selected: ["Project"], text: undefined },
        { id: "constructor", selected: [], text: "Custom constructor target" },
        { id: "__proto__", selected: ["Project"], text: "Extra prototype note" },
        { id: "toString", selected: [], text: "Custom toString target" }
      ] } });
    const result = await completion;
    assert.deepEqual(result.response, view.calls[0]!.response);
    assert.deepEqual(view.requests.list(), []);
    assert.match(document.body.textContent!, /已回答/u);
    assert.match(document.body.textContent!, /Custom constructor target/u);
    assert.match(document.body.textContent!, /Extra prototype note/u);
    assert.throws(() => view.requests.answer(owner.sessionId, owner.runId, tool.id, { status: "skipped" }), /no longer pending/);
    await view.render({ ...tool, status: "success", result }, false);
    assert.match(document.body.textContent!, /已回答/u);
    assert.equal(document.querySelectorAll("textarea").length, 0);
  } finally { await view.close(); }
});

test("custom answers replace single choices, multi-select preserves text and skip remains explicit", async () => {
  const view = await fixture();
  const tool = questionTool(["constructor", "__proto__", "toString"]);
  const completion = waitForQuestion(view.requests, tool);
  void completion.catch(() => undefined);
  try {
    await view.render(tool);
    await view.click('fieldset:nth-of-type(1) input[value="Desktop"]');
    await view.input(0, "Different target");
    assert.equal(view.dom.window.document.querySelector<HTMLInputElement>('fieldset:nth-of-type(1) input[value="Desktop"]')?.checked, false);
    await view.input(1, "Keep this note");
    await view.click('fieldset:nth-of-type(2) input[value="Desktop"]');
    await view.click('fieldset:nth-of-type(2) input[value="Project"]');
    assert.equal(view.dom.window.document.querySelectorAll("textarea")[1]?.value, "Keep this note");
    await view.click('.user-input-actions button[type="button"]');
    assert.deepEqual((await completion).response, { status: "skipped" });
    assert.equal(view.calls.length, 1);
    assert.deepEqual(view.calls[0]!.response, { status: "skipped" });
    assert.deepEqual(view.requests.list(), []);
    assert.match(view.dom.window.document.body.textContent!, /已跳过/u);
    assert.equal(view.dom.window.document.querySelectorAll("textarea").length, 0);
  } finally { await view.close(); }
});

test("cancellation and a newer run cannot submit or inherit an old question draft", async () => {
  const view = await fixture();
  const tool = questionTool(["constructor"]);
  const abort = new AbortController();
  const completion = waitForQuestion(view.requests, tool, abort.signal);
  const rejection = assert.rejects(completion, /cancelled/);
  try {
    await view.render(tool);
    await view.input(0, "Old draft");
    abort.abort();
    await rejection;
    await view.render({ ...tool, status: "failed", error: "User input request cancelled." }, false);
    assert.equal(view.dom.window.document.querySelectorAll("textarea").length, 0);
    assert.equal(view.calls.length, 0);
    assert.deepEqual(view.requests.list(), []);
    assert.throws(() => view.requests.answer(owner.sessionId, owner.runId, tool.id, { status: "skipped" }), /no longer pending/);

    const nextTool = { ...tool, runId: "next-run" };
    view.requests.setRun({ ...owner, runId: nextTool.runId });
    const nextCompletion = waitForQuestion(view.requests, nextTool);
    void nextCompletion.catch(() => undefined);
    await view.render(nextTool);
    assert.equal(view.dom.window.document.querySelector("textarea")?.value, "");
    assert.equal(view.dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, true);
    assert.throws(() => view.requests.answer(owner.sessionId, owner.runId, tool.id, { status: "skipped" }), /no longer pending/);
    assert.throws(() => view.requests.answer("other-session", nextTool.runId, tool.id, { status: "skipped" }), /no longer pending/);
    await view.input(0, "New draft");
    await view.submit();
    assert.deepEqual((await nextCompletion).response, { status: "answered", answers: [{ id: "constructor", selected: [], text: "New draft" }] });
    assert.equal(view.calls.length, 1);
    assert.equal(view.calls[0]!.runId, nextTool.runId);
  } finally { await view.close(); }
});
