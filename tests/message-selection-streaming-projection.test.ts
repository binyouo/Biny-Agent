/** Real streaming projection and Markdown reconciliation must not take ownership of a delivered user's quote. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type React from "react";
import type { Root } from "react-dom/client";
import type { JSDOM } from "jsdom";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/recorder.js";
import type { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";

type Props = React.ComponentProps<typeof MessageTimeline>;
const base = { sessionId: "stream-session", runId: "stream-run", timestamp: "2026-10-18T02:00:00.000Z" };
const sourceId = "delivered:U";
const quote = "Keep this canonical source.";
const firstPublic = `## First inspection\n\n${"Public evidence stays in its original position. ".repeat(24)}\n\n**Complete tail marker**\n\napi_key=[redacted]`;
const firstRaw = firstPublic.replace("[redacted]", "synthetic-first-secret")
  + "\n<biny_notification>synthetic private notification</biny_notification>";
const secondPublic = "Stable Hello **bold** and `code`\n\napi_key=[redacted]";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(context: TestContext) {
  const resources: {
    directory?: string; dom?: JSDOM; root?: Root; React?: typeof import("react");
    assets?: ReturnType<typeof registerHooks>;
  } = {};
  const restore: Array<() => void> = [];
  const calls: Array<{ messageId: string; quote: string; result: ReturnType<typeof deferred> }> = [];
  const selectedText = new WeakMap<Range, Text>();
  let timersEnabled = false;
  let unexpectedRequests = 0;
  let unexpectedSockets = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let frameTime = 1;
  // Setup failures and unresolved captures still restore every global and temporary resource.
  context.after(async () => {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(async () => {
      if (!resources.React) return;
      await resources.React.act(async () => {
        for (const call of calls) call.result.resolve();
        await Promise.all(calls.map(call => call.result.promise));
      });
    });
    await attempt(async () => {
      if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount());
    });
    await attempt(() => resources.assets?.deregister());
    await attempt(() => resources.dom?.window.close());
    await attempt(() => { if (timersEnabled) context.mock.timers.reset(); });
    frames.clear();
    for (const undo of restore.reverse()) await attempt(undo);
    await attempt(async () => { if (resources.directory) await rm(resources.directory, { recursive: true, force: true }); });
    await attempt(() => assert.equal(unexpectedRequests, 0, "The UI fixture must not make external requests"));
    await attempt(() => assert.equal(unexpectedSockets, 0, "The UI fixture must not open network sockets"));
    if (errors.length) throw new AggregateError(errors, "Failed to restore streaming quote fixture");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, value });
  };
  const blockedSocket = context.mock.method(Socket.prototype, "connect", () => {
    unexpectedSockets += 1;
    throw new Error("Unexpected streaming quote network socket");
  });
  restore.push(() => blockedSocket.mock.restore());
  replace(globalThis, "fetch", async () => {
    unexpectedRequests += 1;
    throw new Error("Unexpected streaming quote external request");
  });
  resources.directory = await mkdtemp(path.join(os.tmpdir(), "biny-streaming-quote-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  restore.push(() => {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
  });
  process.env.BINY_AGENT_DIR = path.join(resources.directory, "agent");

  const { JSDOM } = await import("jsdom");
  const React = resources.React = await import("react");
  const dom = resources.dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>', {
    url: "https://biny.test", pretendToBeVisual: true
  });
  class LayoutObserver {
    observe(): void { return undefined; }
    unobserve(): void { return undefined; }
    disconnect(): void { return undefined; }
  }
  const requestFrame = (callback: FrameRequestCallback): number => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number): void => { frames.delete(id); };
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    ResizeObserver: LayoutObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame
  })) replace(globalThis, key, value);
  replace(dom.window, "requestAnimationFrame", requestFrame);
  replace(dom.window, "cancelAnimationFrame", cancelFrame);
  replace(globalThis.performance, "now", () => frameTime);
  replace(dom.window.HTMLCanvasElement.prototype, "getContext", () => null);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  resources.assets = registerHooks({ load(url, hookContext, next) {
    return url.endsWith(".png") ? { format: "module", source: 'export default "asset";', shortCircuit: true } : next(url, hookContext);
  } });
  // No business module is evaluated before the isolated environment and network guards above.
  const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
  const { createSessionTimelineProjector } = await import("../src/desktop/renderer/src/sessionTimeline.js");
  const { createRoot } = await import("react-dom/client");
  resources.assets.deregister();
  resources.assets = undefined;
  const root = resources.root = createRoot(dom.window.document.getElementById("root")!);
  const projector = createSessionTimelineProjector();
  const history: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "initial", content: "Inspect two files." },
    { ...base, type: "run.started", messageId: "reserved:assistant", input: "Inspect two files.", skills: [],
      model: { alias: "primary", provider: "fixture", label: "fixture", reasoning: "default" } }
  ];
  const noop = (): void => undefined;
  const asyncNoop = async (): Promise<void> => undefined;
  const props: Omit<Props, "turns"> = {
    projectId: "project", sessionId: base.sessionId, thinking: false,
    onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
    onAddQuoteToConversation: async (messageId, selectedQuote) => {
      const result = deferred();
      calls.push({ messageId, quote: selectedQuote, result });
      await result.promise;
    },
    onResolvePermission: asyncNoop, onRetry: asyncNoop, onSwitchVersion: asyncNoop,
    onEditRequest: noop, onRollbackFiles: noop
  };
  const project = async (...events: AgentHostEvent[]) => {
    liveEvents.push(...events);
    const turns = projector.update({ sessionId: base.sessionId, events: history, liveEvents });
    assert.equal(turns.length, 1);
    await React.act(() => root.render(React.createElement(MessageTimeline, { ...props, turns })));
    return turns[0]!;
  };
  const assistantBody = (index: number): HTMLElement => {
    const body = dom.window.document.querySelectorAll<HTMLElement>(".execution-assistant-step .markdown-body")[index];
    assert.ok(body, `Missing assistant step ${index}`);
    return body;
  };
  const userBody = (): HTMLElement => {
    const body = dom.window.document.querySelector<HTMLElement>(`[data-quote-message-id="${sourceId}"] .markdown-body`);
    assert.ok(body);
    assert.equal(body.closest(".execution-user-step")?.getAttribute("data-quote-source"), "user");
    return body;
  };
  const pointer = async (target: Element): Promise<void> => {
    await React.act(() => target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  };
  const select = async (): Promise<Range> => {
    const body = userBody();
    await pointer(body);
    const text = body.querySelector("p")?.firstChild;
    assert.ok(text instanceof dom.window.Text);
    const range = dom.window.document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, quote.length);
    selectedText.set(range, text);
    range.getBoundingClientRect = () => ({
      x: 100, y: 120, left: 100, top: 120, right: 300, bottom: 140, width: 200, height: 20,
      toJSON() { return {}; }
    });
    await React.act(() => {
      const selection = dom.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      body.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    });
    return range;
  };
  const assertNativeRange = (range: Range): void => {
    const originalText = selectedText.get(range);
    assert.ok(originalText);
    const selection = dom.window.getSelection()!;
    assert.equal(selection.toString(), quote);
    assert.equal(selection.rangeCount, 1);
    assert.equal(selection.isCollapsed, false);
    const current = selection.getRangeAt(0);
    // Range endpoints are live; compare with the original Text rather than a potentially mutated Range.
    assert.equal(current.startContainer, originalText);
    assert.equal(current.startOffset, 0);
    assert.equal(current.endContainer, originalText);
    assert.equal(current.endOffset, quote.length);
    assert.ok(userBody().contains(current.startContainer));
  };
  const toolbar = (): HTMLButtonElement | null => dom.window.document.querySelector(".message-selection-reference");
  const button = (): HTMLButtonElement => { const result = toolbar(); assert.ok(result); return result; };
  const click = async (): Promise<void> => { await React.act(() => button().click()); };
  const settle = async (index: number): Promise<void> => {
    const call = calls[index];
    assert.ok(call);
    await React.act(async () => { call.result.resolve(); await call.result.promise; });
  };
  const selectionChange = async (): Promise<void> => {
    await React.act(() => dom.window.document.dispatchEvent(new dom.window.Event("selectionchange")));
  };
  const escape = async (): Promise<void> => {
    await React.act(() => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })));
  };
  const geometry = async (): Promise<void> => {
    await React.act(() => {
      dom.window.document.querySelector(".message-timeline")!.dispatchEvent(new dom.window.Event("scroll"));
      dom.window.dispatchEvent(new dom.window.Event("resize"));
    });
  };
  const debounce = async (): Promise<void> => { await React.act(() => context.mock.timers.tick(120)); };
  const revealUntil = async (ready: () => boolean): Promise<void> => {
    // Advance actual typewriter frames until the requested DOM state exists, never wall-clock sleep.
    for (let frame = 0; !ready() && frame < 160; frame += 1) {
      assert.ok(frames.size > 0, "The pending Markdown delta must have an animation frame");
      const pending = [...frames.values()];
      frames.clear();
      frameTime += 100;
      await React.act(() => { for (const callback of pending) callback(frameTime); });
    }
    assert.ok(ready(), "The bounded inline delta must be revealed by the controlled frame budget");
  };

  await project({ ...base, type: "assistant.delta", content: firstRaw });
  const firstBody = assistantBody(0);
  const firstParagraph = firstBody.querySelector("p");
  assert.ok(firstParagraph);
  assert.ok(firstPublic.length > 1_000, "The fixture must exceed compact-summary truncation");
  assert.equal(firstBody.querySelector("strong")?.textContent, "Complete tail marker");
  const boundary = await project({ ...base, type: "tool.input", toolCallId: "read-first", tool: "Read", args: { path: "first.txt" } });
  const summary = boundary.steps.find(step => step.kind === "assistant");
  assert.equal(summary?.content, firstPublic, "Tool input preserves complete public Markdown and redacts its secret");
  assert.equal(summary?.summary, true);
  assert.equal(summary?.completed, true);
  assert.equal(boundary.assistant, "", "A pre-tool summary is not the final assistant answer");
  assert.equal(assistantBody(0), firstBody, "The tool boundary keeps the streaming Markdown component mounted");
  assert.equal(firstBody.querySelector("p"), firstParagraph);
  assert.equal(firstBody.querySelector("strong")?.textContent, "Complete tail marker");
  assert.doesNotMatch(firstBody.textContent ?? "", /synthetic-first-secret|synthetic private notification|biny_notification/u);
  const delivered = await project(
    { ...base, type: "tool.started", toolCallId: "read-first", tool: "Read", args: { path: "first.txt" } },
    { ...base, type: "tool.completed", toolCallId: "read-first", tool: "Read", result: { content: "first evidence" } },
    { ...base, type: "message.user", messageId: sourceId, content: quote, delivery: "steer" }
  );
  assert.deepEqual(delivered.steps.map(step => step.kind), ["assistant", "tool", "user"]);
  assert.equal(delivered.steps.find(step => step.kind === "user")?.messageId, sourceId);
  return { dom, calls, project, assistantBody, userBody, pointer, select, assertNativeRange, toolbar, button,
    click, settle, selectionChange, escape, geometry, debounce, revealUntil };
}

async function streamAcrossSecondBoundary(h: Awaited<ReturnType<typeof harness>>, range: Range): Promise<void> {
  await h.project({ ...base, type: "assistant.delta", content: "Stable Hello " });
  const body = h.assistantBody(1);
  const paragraph = body.querySelector("p");
  const prefixWords = [...body.querySelectorAll(".markdown-stream-word")];
  assert.ok(paragraph);
  assert.ok(prefixWords.length >= 2, "The real streaming renderer must reveal the initial words");
  const stages = [
    { delta: "**bo", text: "Stable Hello **bo" },
    { delta: "ld**", text: "Stable Hello bold" },
    { delta: " and `co", text: "Stable Hello bold and `co" },
    { delta: "de`", text: "Stable Hello bold and code" }
  ];
  for (const stage of stages) {
    await h.project({ ...base, type: "assistant.delta", content: stage.delta });
    await h.revealUntil(() => paragraph.textContent === stage.text);
    assert.equal(h.assistantBody(1), body);
    assert.equal(body.querySelector("p"), paragraph);
    const words = body.querySelectorAll(".markdown-stream-word");
    assert.ok(prefixWords.every((word, index) => words[index] === word), "Inline closure must retain previously revealed prefix nodes");
    h.assertNativeRange(range);
  }
  assert.equal(body.querySelector("strong")?.textContent, "bold");
  assert.equal(body.querySelector("code")?.textContent, "code");
  assert.equal(body.querySelector("code .markdown-stream-word"), null);
  const boundary = await h.project(
    { ...base, type: "assistant.delta", content: "\n\napi_key=synthetic-second-secret\n<biny_notification>second private notice</biny_notification>" },
    { ...base, type: "tool.input", toolCallId: "read-second", tool: "Read", args: { path: "second.txt" } }
  );
  assert.deepEqual(boundary.steps.map(step => step.kind), ["assistant", "tool", "user", "assistant", "tool"]);
  assert.deepEqual(boundary.steps.filter(step => step.kind === "assistant").map(step => ({ content: step.content, summary: step.summary })),
    [{ content: firstPublic, summary: true }, { content: secondPublic, summary: true }]);
  assert.equal(boundary.assistant, "");
  assert.equal(h.assistantBody(1), body);
  assert.equal(body.querySelector("p"), paragraph);
  assert.equal(body.getAttribute("data-streaming"), null);
  assert.doesNotMatch(h.dom.window.document.body.textContent ?? "", /synthetic-(?:first|second)-secret|private notification|private notice|biny_notification/u);
  h.assertNativeRange(range);
  assert.deepEqual(h.calls.map(({ messageId, quote: selectedQuote }) => ({ messageId, quote: selectedQuote })), [{ messageId: sourceId, quote }]);
}

test("streaming inline closure and full tool summaries cannot resurrect an Escape-dismissed canonical U capture", { timeout: 20_000 }, async context => {
  const h = await harness(context);
  const range = await h.select();
  await h.click();
  assert.equal(h.button().disabled, true);
  await h.selectionChange();
  await h.escape();
  assert.equal(h.toolbar(), null);
  await streamAcrossSecondBoundary(h, range);
  await h.geometry();
  await h.debounce();
  assert.equal(h.toolbar(), null, "Stream reconciliation and queued geometry respect explicit dismissal");
  await h.settle(0);
  await h.geometry();
  assert.equal(h.toolbar(), null, "Settling A must not recreate the dismissed toolbar");
  h.assertNativeRange(range);
});

test("same-range owner B keeps canonical U through streaming projection and old capture A settlement", { timeout: 20_000 }, async context => {
  const h = await harness(context);
  const range = await h.select();
  await h.click();
  await h.pointer(h.dom.window.document.getElementById("outside")!);
  assert.equal(h.toolbar(), null);
  // A new explicit gesture owns B even though its native Range and canonical message are unchanged.
  await h.pointer(h.userBody());
  await h.geometry();
  assert.equal(h.button().disabled, true, "B retains the single pending-request gate");
  await streamAcrossSecondBoundary(h, range);
  await h.selectionChange();
  await h.settle(0);
  assert.equal(h.button().disabled, false, "A may unlock the button but cannot clear the new same-range owner B");
  await h.debounce();
  await h.geometry();
  h.assertNativeRange(range);
  await h.click();
  assert.deepEqual(h.calls.map(({ messageId, quote: selectedQuote }) => ({ messageId, quote: selectedQuote })),
    [{ messageId: sourceId, quote }, { messageId: sourceId, quote }]);
  await h.settle(1);
  assert.equal(h.toolbar(), null, "B's own settlement closes only its own toolbar");
  h.assertNativeRange(range);
});
