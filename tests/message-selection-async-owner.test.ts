/** Async quote settlement only closes the selection that started it; no IPC or local storage. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";

const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(context: TestContext) {
  const resources: {
    dom?: JSDOM;
    root?: ReturnType<typeof createRoot>;
    assets?: ReturnType<typeof registerHooks>;
  } = {};
  let timersEnabled = false;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const calls: Array<{ messageId: string; quote: string; result: ReturnType<typeof deferred> }> = [];
  // Register before installing globals or imports so partial fixture setup is also restored.
  context.after(async () => {
    const errors: unknown[] = [];
    try {
      try {
        await act(async () => {
          for (const call of calls) call.result.resolve();
          await Promise.all(calls.map(call => call.result.promise));
        });
      } catch (error) { errors.push(error); }
      finally {
        try { if (resources.root) await act(() => resources.root!.unmount()); }
        catch (error) { errors.push(error); }
      }
    } finally {
      try { resources.assets?.deregister(); }
      catch (error) { errors.push(error); }
      finally {
        try { resources.dom?.window.close(); }
        catch (error) { errors.push(error); }
        finally {
          try { if (timersEnabled) context.mock.timers.reset(); }
          catch (error) { errors.push(error); }
          finally {
            for (const [key, descriptor] of saved) {
              try {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
              } catch (error) { errors.push(error); }
            }
          }
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Failed to restore quote owner fixture");
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  const dom = resources.dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://biny.test", pretendToBeVisual: true
  });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  resources.assets = registerHooks({ load(url, hookContext, next) {
    return url.endsWith(".png")
      ? { format: "module", source: "export default \"asset\";", shortCircuit: true }
      : next(url, hookContext);
  } });
  const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js")
    .finally(() => { resources.assets?.deregister(); resources.assets = undefined; });
  const root = resources.root = createRoot(document.getElementById("root")!);
  const turns: TimelineTurn[] = [{
    id: "turn", userMessageId: "message", user: "Repeat Repeat\n\nBeta next.", assistant: "",
    reasoning: "", skills: [], status: "completed", tools: [], steps: []
  }];
  await act(() => root.render(React.createElement(MessageTimeline, {
    projectId: "project", sessionId: "session", turns, thinking: false,
    onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
    onAddQuoteToConversation: async (messageId, quote) => {
      const result = deferred();
      calls.push({ messageId, quote, result });
      await result.promise;
    },
    onResolvePermission: asyncNoop, onRetry: asyncNoop, onSwitchVersion: asyncNoop,
    onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop
  })));
  const bounds = { left: 100, top: 120, width: 100, height: 20 };
  const paragraph = (index: number) => {
    const node = document.querySelectorAll('article[data-message-id="message"] .markdown-body p')[index]?.firstChild;
    assert.equal(node instanceof dom.window.Text, true);
    return node!;
  };
  const select = async (start = 0, end = 6, index = 0) => {
    const range = document.createRange();
    const node = paragraph(index);
    range.setStart(node, start);
    range.setEnd(node, end);
    // Only layout is supplied; Selection and Range retain their real DOM implementation.
    range.getBoundingClientRect = () => ({
      ...bounds, x: bounds.left, y: bounds.top, right: bounds.left + bounds.width,
      bottom: bounds.top + bounds.height, toJSON() { return {}; }
    });
    await act(() => {
      const selection = dom.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      node.parentElement!.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    });
    return range;
  };
  const toolbar = () => document.querySelector<HTMLButtonElement>(".message-selection-reference");
  const button = () => {
    const value = toolbar();
    assert.equal(Boolean(value), true, "the quote toolbar is visible");
    return value!;
  };
  const click = async () => { await act(() => button().click()); };
  const settle = async (index = 0) => {
    assert.equal(Boolean(calls[index]), true);
    await act(async () => {
      calls[index]!.result.resolve();
      await calls[index]!.result.promise;
    });
  };
  const tick = async (milliseconds: number) => { await act(() => context.mock.timers.tick(milliseconds)); };
  return { dom, calls, bounds, select, toolbar, button, click, settle, tick };
}

for (const event of ["scroll", "resize"] as const) {
  test("a geometry-only " + event + " refresh retains the pending quote owner", async context => {
    const h = await harness(context);
    await h.select();
    await h.click();
    assert.equal(h.calls.length, 1);
    const before = h.button().style.top;
    h.bounds.top += 25;
    await act(() => event === "scroll"
      ? document.querySelector(".message-timeline")!.dispatchEvent(new h.dom.window.Event("scroll"))
      : h.dom.window.dispatchEvent(new h.dom.window.Event("resize")));
    assert.notEqual(h.button().style.top, before);
    assert.equal(h.button().disabled, true);
    await h.settle();
    assert.equal(Boolean(h.toolbar()), false, "the original selection still closes after its own settlement");
    assert.equal(h.dom.window.getSelection()!.toString(), "Repeat");
  });
}

test("same message and text at different range offsets remains a newer selection", async context => {
  const h = await harness(context);
  await h.select();
  await h.click();
  const newer = await h.select(7, 13);
  assert.equal(h.button().disabled, true, "the existing global single-flight behavior is preserved");
  assert.equal(h.dom.window.getSelection()!.toString(), "Repeat");
  await h.settle();
  assert.equal(Boolean(h.toolbar()), true, "the old request cannot close the other occurrence");
  assert.equal(h.button().disabled, false);
  const selection = h.dom.window.getSelection()!.getRangeAt(0);
  assert.equal(selection.startContainer === newer.startContainer, true);
  assert.equal(selection.startOffset, 7);
  assert.equal(selection.endOffset, 13);
  assert.deepEqual(h.calls.map(({ messageId, quote }) => ({ messageId, quote })), [
    { messageId: "message", quote: "Repeat" }
  ]);
});

test("an observed collapse followed by the same range gets a new owner before the display debounce", async context => {
  const h = await harness(context);
  const range = await h.select();
  await h.tick(0);
  await h.click();
  const before = h.button().style.top;
  h.bounds.top += 25;
  await act(() => {
    const selection = h.dom.window.getSelection()!;
    selection.removeAllRanges();
    document.dispatchEvent(new h.dom.window.Event("selectionchange"));
    selection.addRange(range);
    document.dispatchEvent(new h.dom.window.Event("selectionchange"));
  });
  // Drain only JSDOM's queued native selectionchange events, not the 120 ms display timer.
  await h.tick(0);
  await h.tick(119);
  assert.equal(h.button().style.top, before, "display updates remain debounced");
  await h.tick(1);
  assert.notEqual(h.button().style.top, before, "the 120 ms timer must actually update the selected range");
  await h.settle();
  assert.equal(Boolean(h.toolbar()), true, "the settled request belongs to the selection before the observed collapse");
  assert.equal(h.button().disabled, false);
  assert.equal(h.dom.window.getSelection()!.toString(), "Repeat");
  const current = h.dom.window.getSelection()!.getRangeAt(0);
  assert.equal(current.startContainer === range.startContainer, true);
  assert.equal(current.startOffset, 0);
  assert.equal(current.endOffset, 6);
});

test("same-batch repeat clicks stay single-flight and the newer quote is enabled only after settlement", async context => {
  const h = await harness(context);
  await h.select();
  await act(() => { h.button().click(); h.button().click(); });
  assert.equal(h.calls.length, 1, "a React commit is not required to guard duplicate requests");
  await h.select(0, 4, 1);
  assert.equal(h.button().disabled, true);
  await h.click();
  assert.equal(h.calls.length, 1, "the newer selection does not start concurrent capture");
  await h.settle();
  assert.equal(Boolean(h.toolbar()), true);
  assert.equal(h.button().disabled, false);
  await h.click();
  assert.deepEqual(h.calls.map(call => call.quote), ["Repeat", "Beta"]);
  assert.equal(h.button().disabled, true);
  await h.settle(1);
  assert.equal(Boolean(h.toolbar()), false);
});
