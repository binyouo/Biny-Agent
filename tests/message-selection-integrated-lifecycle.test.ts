/** The combined owner, dismissal and canonical-source path uses real projection, DOM and timeline. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import type React from "react";
import type { Root } from "react-dom/client";
import type { JSDOM } from "jsdom";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";

type Props = React.ComponentProps<typeof MessageTimeline>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(context: TestContext) {
  const resources: {
    dom?: JSDOM; root?: Root; React?: typeof import("react");
    assets?: ReturnType<typeof registerHooks>;
  } = {};
  const restore: Array<() => void> = [];
  const calls: Array<{ messageId: string; quote: string; result: ReturnType<typeof deferred> }> = [];
  let timersEnabled = false;
  // Register before imports and setup; failed setup and pending captures are both drained.
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
    for (const undo of restore.reverse()) await attempt(undo);
    if (errors.length) throw new AggregateError(errors, "Failed to restore integrated selection fixture");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const prior = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (prior) Object.defineProperty(target, key, prior);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, value });
  };
  context.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  const { JSDOM } = await import("jsdom");
  const dom = resources.dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>', {
    url: "https://biny.test", pretendToBeVisual: true
  });
  const React = resources.React = await import("react");
  class LayoutObserver {
    observe(): void { return undefined; }
    unobserve(): void { return undefined; }
    disconnect(): void { return undefined; }
  }
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    ResizeObserver: LayoutObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
  })) replace(globalThis, key, value);
  replace(dom.window.HTMLCanvasElement.prototype, "getContext", () => null);
  resources.assets = registerHooks({ load(url, hookContext, next) {
    return url.endsWith(".png") ? { format: "module", source: 'export default "asset";', shortCircuit: true } : next(url, hookContext);
  } });
  const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
  const { buildSessionTimeline } = await import("../src/desktop/renderer/src/sessionTimeline.js");
  resources.assets.deregister();
  resources.assets = undefined;
  const { createRoot } = await import("react-dom/client");
  const root = resources.root = createRoot(dom.window.document.getElementById("root")!);
  const base = { sessionId: "session", runId: "run", timestamp: "2026-10-17T20:00:00.000Z" };
  const events: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "initial", content: "Inspect the request." },
    { ...base, type: "run.started", messageId: "run", input: "Inspect the request.", skills: [],
      model: { alias: "primary", provider: "test", label: "test", reasoning: "default" } },
    { ...base, type: "assistant.completed", content: "I will inspect it." },
    { ...base, type: "message.user", messageId: "delivered:A", content: "Repeat source.", delivery: "steer" },
    { ...base, type: "message.user", messageId: "delivered:B", content: "Repeat source.", delivery: "queue" }
  ];
  const turns = buildSessionTimeline([], events);
  assert.deepEqual(turns.flatMap(turn => turn.steps.filter(step => step.kind === "user").map(step => step.messageId)),
    ["delivered:A", "delivered:B"]);
  const noop = (): void => undefined;
  const asyncNoop = async (): Promise<void> => undefined;
  const render = async (overrides: Partial<Props> = {}): Promise<void> => {
    await React.act(() => root.render(React.createElement(MessageTimeline, {
      projectId: "project", sessionId: "session", turns, thinking: false,
      onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
      onAddQuoteToConversation: async (messageId, quote) => {
        const result = deferred();
        calls.push({ messageId, quote, result });
        await result.promise;
      },
      onResolvePermission: asyncNoop, onRetry: asyncNoop, onSwitchVersion: asyncNoop,
      onEditRequest: noop, onRollbackFiles: noop, ...overrides
    })));
  };
  const body = (id: string): HTMLElement => {
    const element = dom.window.document.querySelector<HTMLElement>(`[data-quote-message-id="${id}"] .markdown-body`);
    assert.ok(element);
    return element;
  };
  const pointer = async (target: Element, button = 0): Promise<void> => {
    await React.act(() => target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button })));
  };
  const select = async (id: string): Promise<Range> => {
    const markdown = body(id);
    await pointer(markdown);
    const text = markdown.querySelector("p")?.firstChild;
    assert.ok(text instanceof dom.window.Text);
    const range = dom.window.document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent!.length);
    range.getBoundingClientRect = () => ({
      x: 100, y: 120, left: 100, top: 120, right: 300, bottom: 140, width: 200, height: 20,
      toJSON() { return {}; }
    });
    await React.act(() => {
      const selection = dom.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      markdown.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    });
    return range;
  };
  const toolbar = (): HTMLButtonElement | null => dom.window.document.querySelector(".message-selection-reference");
  const button = (): HTMLButtonElement => { const found = toolbar(); assert.ok(found); return found; };
  const click = async (): Promise<void> => { await React.act(() => button().click()); };
  const settle = async (index = 0): Promise<void> => {
    const call = calls[index];
    assert.ok(call);
    await React.act(async () => { call.result.resolve(); await call.result.promise; });
  };
  const tick = async (milliseconds: number): Promise<void> => { await React.act(() => context.mock.timers.tick(milliseconds)); };
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
  const assertNativeRange = (range: Range): void => {
    const selection = dom.window.getSelection()!;
    assert.equal(selection.toString(), "Repeat source.");
    assert.equal(selection.isCollapsed, false);
    const current = selection.getRangeAt(0);
    assert.equal(current.startContainer, range.startContainer);
    assert.equal(current.startOffset, range.startOffset);
    assert.equal(current.endContainer, range.endContainer);
    assert.equal(current.endOffset, range.endOffset);
  };
  await render();
  return { dom, turns, calls, body, pointer, select, toolbar, button, click, settle, tick, selectionChange, escape, geometry, render, assertNativeRange };
}

for (const dismiss of ["escape", "outside"] as const) {
  test(`a pending canonical A cannot resurrect dismissed B after ${dismiss}, and an explicit B reselection still works`, async context => {
    const h = await harness(context);
    await h.select("delivered:A");
    await h.click();
    const newer = await h.select("delivered:B");
    assert.equal(h.button().disabled, true);
    await h.tick(0);
    await h.selectionChange();
    if (dismiss === "escape") await h.escape();
    else await h.pointer(h.dom.window.document.getElementById("outside")!);
    assert.equal(h.toolbar(), null);
    h.assertNativeRange(newer);
    await h.geometry();
    await h.tick(120);
    await h.settle();
    await h.geometry();
    assert.equal(h.toolbar(), null, "old settlement and queued geometry preserve the explicit dismissal");
    h.assertNativeRange(newer);
    assert.deepEqual(h.calls.map(({ messageId, quote }) => ({ messageId, quote })), [{ messageId: "delivered:A", quote: "Repeat source." }]);
    await h.select("delivered:B");
    assert.equal(h.button().disabled, false);
    await h.click();
    assert.deepEqual(h.calls.map(call => call.messageId), ["delivered:A", "delivered:B"]);
    await h.settle(1);
    assert.equal(h.toolbar(), null);
  });
}

test("dismissal and explicit same-range reselection create a new canonical owner before old A settles", async context => {
  const h = await harness(context);
  const original = await h.select("delivered:A");
  await h.click();
  await h.escape();
  await h.pointer(h.body("delivered:A"), 2);
  await h.geometry();
  assert.equal(h.toolbar(), null, "right-click is not a new selection gesture");
  await h.pointer(h.body("delivered:A"));
  await h.geometry();
  assert.equal(h.button().disabled, true, "reselection retains the global pending-request gate");
  h.assertNativeRange(original);
  await h.settle();
  assert.equal(h.button().disabled, false, "settlement owns the selection before dismissal, not the new same-range selection");
  h.assertNativeRange(original);
  await h.click();
  assert.deepEqual(h.calls.map(call => call.messageId), ["delivered:A", "delivered:A"]);
  await h.settle(1);
  assert.equal(h.toolbar(), null);
});

for (const scope of ["session", "project"] as const) {
  test(`${scope} A-to-B-to-A invalidates a pending quote owner even when the same DOM range survives`, async context => {
    const h = await harness(context);
    await h.select("delivered:A");
    await h.tick(0);
    await h.click();
    await h.selectionChange();
    await h.render(scope === "session" ? { sessionId: "other-session" } : { projectId: "other-project" });
    await h.render();
    await h.tick(120);
    await h.geometry();
    assert.equal(h.toolbar(), null, "scope reset cancels delayed display and suppresses retained native range");
    const newer = await h.select("delivered:A");
    assert.equal(h.button().disabled, true);
    await h.settle();
    assert.equal(h.button().disabled, false, "new scope ownership survives settlement from the original scope");
    h.assertNativeRange(newer);
    await h.click();
    assert.deepEqual(h.calls.map(call => call.messageId), ["delivered:A", "delivered:A"]);
    await h.settle(1);
    assert.equal(h.toolbar(), null);
  });
}

test("an anonymous delivered source cannot borrow its assistant article while an older canonical capture settles", async context => {
  const h = await harness(context);
  await h.select("delivered:A");
  await h.click();
  const newer = await h.select("delivered:B");
  const anonymous = h.turns.map(turn => ({
    ...turn, assistantMessageId: "reserved:assistant",
    steps: turn.steps.map(step => step.kind === "user" && step.messageId === "delivered:B"
      ? { ...step, messageId: undefined } : step)
  }));
  await h.render({ turns: anonymous });
  await h.selectionChange();
  await h.tick(120);
  await h.geometry();
  assert.equal(h.toolbar(), null, "an anonymous user boundary must not fall through to the reserved assistant");
  await h.settle();
  await h.geometry();
  assert.equal(h.toolbar(), null);
  h.assertNativeRange(newer);
  assert.deepEqual(h.calls.map(call => call.messageId), ["delivered:A"]);
});
