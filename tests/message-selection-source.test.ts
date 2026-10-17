/**
 * Real timeline projection and mounted Selection/Range attribution.
 * IPC is an external callback seam; no reference service, model, or local DB runs.
 * The edit overlay is cleared through MessageTimeline's public prop contract.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import type React from "react";
import type { Root } from "react-dom/client";
import type { JSDOM } from "jsdom";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildSessionTimeline, createSessionTimelineProjector, type TimelineStep, type TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";

const SESSION = "quote-source-session";
const RUN = "edit:run:user:opaque";
const EDIT_USER = "edit:user:canonical";
const ASSISTANT = "reserved:assistant:canonical";
const USER = "delivered:user:with:separators";
const EDIT_TEXT = "Edited request.";
const QUOTE = "Only change the title.";
const base = { sessionId: SESSION, runId: RUN, timestamp: "2026-10-17T20:00:00.000Z" };
const model = { alias: "primary", provider: "test", label: "test", reasoning: "default" };

function completedPair(userId: string, assistantId: string, parent?: string): SessionEvent[] {
  return [
    { type: "user_message", messageId: userId, slotId: userId, parentMessageId: parent, content: `Question ${userId}.` },
    { type: "agent_message", messageId: assistantId, slotId: assistantId, parentMessageId: userId,
      message: { role: "assistant", content: [{ type: "text", text: `Answer ${assistantId}.` }] } },
    { type: "assistant_message", messageId: assistantId, slotId: assistantId, parentMessageId: userId,
      replyToMessageId: userId, content: `Answer ${assistantId}.` }
  ];
}

function editedFixture(delivery: "steer" | "queue" = "steer") {
  const prefix = completedPair("earlier-user", "earlier-answer");
  const beforeEdit = [...prefix, ...completedPair("old-user", "old-answer", "earlier-answer")];
  const oldTurn = buildSessionTimeline(beforeEdit, []).find(turn => turn.userMessageId === "old-user");
  assert.ok(oldTurn, "the edited historical turn exists");
  const events: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: EDIT_USER, content: EDIT_TEXT },
    { ...base, type: "run.started", messageId: ASSISTANT, retryOfMessageId: "old-user", input: EDIT_TEXT, skills: [], model },
    { ...base, type: "assistant.completed", content: "I will update it." },
    { ...base, type: "message.user", messageId: USER, content: QUOTE, delivery }
  ];
  return { prefix, beforeEdit, events,
    editInFlight: { turnId: oldTurn.id, userMessageIndex: oldTurn.userMessageIndex, user: EDIT_TEXT } };
}

function ordinaryEvents(delivery: "steer" | "queue"): AgentHostEvent[] {
  return [
    { ...base, type: "message.user", messageId: "initial-user", content: "Initial request." },
    { ...base, type: "run.started", messageId: "ordinary-run-id", input: "Initial request.", skills: [], model },
    { ...base, type: "assistant.completed", content: "I will inspect it." },
    { ...base, type: "message.user", messageId: USER, content: QUOTE, delivery }
  ];
}

// Read the optional new field without making the tests-only baseline fail to typecheck.
function stepMessageId(step: TimelineStep | undefined): unknown {
  return step === undefined ? undefined : Reflect.get(step, "messageId");
}

function projection(events: SessionEvent[], live: AgentHostEvent[]) {
  const projector = createSessionTimelineProjector();
  let turns = projector.update({ sessionId: SESSION, events, liveEvents: [] });
  for (let index = 1; index <= live.length; index++) {
    turns = projector.update({ sessionId: SESSION, events, liveEvents: live.slice(0, index) });
    assert.deepEqual(turns, buildSessionTimeline(events, live.slice(0, index)));
  }
  return { projector, turns };
}

interface Resources {
  dom?: JSDOM;
  root?: Root;
  React?: typeof import("react");
  assets?: ReturnType<typeof registerHooks>;
}

type Props = React.ComponentProps<typeof MessageTimeline>;
type Fixture = Awaited<ReturnType<typeof setup>>;

async function withFixture(t: TestContext, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const resources: Resources = {};
  const restore: Array<() => void> = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(async () => {
      if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount());
      resources.root = undefined;
    });
    await attempt(() => resources.assets?.deregister());
    await attempt(() => resources.dom?.window.close());
    for (const undo of restore.reverse()) await attempt(undo);
    if (errors.length) throw new AggregateError(errors, "Failed to restore quote-source fixture");
  };
  // Cleanup is registered before imports, DOM/global changes, asset hooks, or createRoot.
  t.after(close);
  let failed = false;
  let failure: unknown;
  try { await run(await setup(resources, restore)); }
  catch (error) { failed = true; failure = error; }
  try { await close(); }
  catch (error) {
    if (!failed) throw error;
    try { t.diagnostic(`Cleanup also failed: ${String(error).slice(0, 500)}`); } catch { /* Preserve the original failure. */ }
  }
  if (failed) throw failure;
}

async function setup(resources: Resources, restore: Array<() => void>) {
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, value });
  };
  const { JSDOM } = await import("jsdom");
  const dom = resources.dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://biny.test", pretendToBeVisual: true });
  const React = resources.React = await import("react");
  // ResizeObserver, canvas drawing, and layout rectangles are unavailable in JSDOM.
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
  // Keep real RunStatus/ThinkingOrb mounted; a browser without a 2D context is supported.
  replace(dom.window.HTMLCanvasElement.prototype, "getContext", () => null);
  resources.assets = registerHooks({ load(url, context, next) {
    return url.endsWith(".png") ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
  } });
  // On import failure, registered cleanup removes the hook without masking that failure.
  const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
  resources.assets.deregister();
  resources.assets = undefined;
  const { createRoot } = await import("react-dom/client");
  const root = resources.root = createRoot(dom.window.document.getElementById("root")!);
  const calls: Array<{ messageId: string; quote: string }> = [];
  const noop = (): void => undefined;
  const asyncNoop = async (): Promise<void> => undefined;
  const render = async (turns: TimelineTurn[], overrides: Partial<Props> = {}): Promise<void> => {
    await React.act(() => root.render(React.createElement(MessageTimeline, {
      projectId: "project", sessionId: SESSION, turns, thinking: false,
      onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
      onAddQuoteToConversation: async (messageId, quote) => { calls.push({ messageId, quote }); },
      onResolvePermission: asyncNoop, onRetry: asyncNoop, onSwitchVersion: asyncNoop,
      onEditRequest: noop, onRollbackFiles: noop, ...overrides
    })));
  };
  const body = (selector: string, index = 0): HTMLElement => {
    const found = dom.window.document.querySelectorAll<HTMLElement>(selector)[index];
    assert.equal(found !== undefined, true, `body exists: ${selector} [${index}]`);
    return found!;
  };
  const paragraphText = (markdown: HTMLElement): Text => {
    const text = markdown.querySelector("p")?.firstChild;
    assert.equal(text instanceof dom.window.Text, true, "selected paragraph has a native Text node");
    return text as Text;
  };
  const select = async (first: HTMLElement, last = first): Promise<string> => {
    const start = paragraphText(first);
    const end = paragraphText(last);
    const range = dom.window.document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.data.length);
    range.getBoundingClientRect = () => ({
      x: 100, y: 120, left: 100, top: 120, right: 300, bottom: 140, width: 200, height: 20,
      toJSON() { return {}; }
    });
    await React.act(() => {
      const selection = dom.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      last.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    });
    return dom.window.getSelection()!.toString().trim();
  };
  const toolbar = (): HTMLButtonElement | null => dom.window.document.querySelector(".message-selection-reference");
  const add = async (): Promise<void> => {
    const button = toolbar();
    assert.equal(button !== null, true, "selected canonical source has an add action");
    await React.act(async () => { button!.click(); });
  };
  return { dom, calls, render, body, select, toolbar, add };
}

test("replacement retry projection retains the delivered canonical ID through incremental and full folds", () => {
  const { prefix, events, editInFlight } = editedFixture();
  const before = JSON.stringify([prefix, events]);
  const { turns } = projection(prefix, events);
  const turn = turns.find(item => item.userMessageId === EDIT_USER);
  assert.ok(turn);
  assert.equal(turn.id, RUN);
  assert.notEqual(turn.id, editInFlight.turnId);
  assert.equal(turn.userMessageIndex, editInFlight.userMessageIndex);
  assert.equal(turn.user, editInFlight.user);
  assert.equal(turn.assistantMessageId, ASSISTANT);
  const step = turn.steps.find(item => item.kind === "user");
  assert.equal(stepMessageId(step), USER);
  assert.equal(step?.kind === "user" ? step.content : undefined, QUOTE);
  assert.notEqual(stepMessageId(step), step?.id, "canonical identity is not a rendering key");
  assert.equal(JSON.stringify([prefix, events]), before);
});

test("edited prefix and cleared edit overlay expose a real user step whose quote emits U, never reserved A", async t => {
  await withFixture(t, async h => {
    const { prefix, events, editInFlight } = editedFixture();
    const { turns } = projection(prefix, events);
    const replacement = turns.find(turn => turn.userMessageId === EDIT_USER);
    assert.ok(replacement);
    // These are the current App effect's public replacement conditions, not a copied fold.
    assert.notEqual(replacement.id, editInFlight.turnId);
    assert.equal(replacement.userMessageIndex, editInFlight.userMessageIndex);
    assert.equal(replacement.user, editInFlight.user);
    assert.equal(replacement.assistantMessageId, ASSISTANT);
    assert.equal(turns.some(turn => turn.userMessageId === "old-user"), false);
    await h.render(turns, { editInFlight });
    assert.equal(h.dom.window.document.querySelector(".execution-user-step") !== null, false, "uncleared overlay hides execution content");
    await h.render(turns, { editInFlight: undefined });
    const selected = await h.select(h.body(".execution-user-step .markdown-body"));
    assert.equal(selected, QUOTE);
    await h.add();
    assert.deepEqual(h.calls, [{ messageId: USER, quote: QUOTE }]);
  });
});

for (const delivery of ["steer", "queue"] as const) {
  test(`ordinary delivered ${delivery} user quotes U without any assistant source ID`, async t => {
    await withFixture(t, async h => {
      const events = ordinaryEvents(delivery);
      const before = JSON.stringify(events);
      const { turns } = projection([], events);
      assert.equal(turns[0]?.assistantMessageId, undefined);
      await h.render(turns);
      assert.equal(h.body('article[data-sender="assistant"]').dataset.messageId, undefined);
      const selected = await h.select(h.body(".execution-user-step .markdown-body"));
      assert.equal(selected, QUOTE);
      await h.add();
      assert.deepEqual(h.calls, [{ messageId: USER, quote: QUOTE }]);
      assert.equal(turns[0]?.assistantMessageId, undefined, "rendering cannot manufacture an assistant source");
      assert.equal(JSON.stringify(events), before);
    });
  });
}

for (const identity of [undefined, ""] as const) {
  test(`anonymous execution-user boundary (${identity === undefined ? "missing" : "empty"} ID) cannot fall through to A`, async t => {
    await withFixture(t, async h => {
      const { prefix, events } = editedFixture();
      const { turns } = projection(prefix, events);
      // Compatibility fixture: remove only the identity from a genuinely projected user step.
      const anonymous = turns.map(turn => ({ ...turn, steps: turn.steps.map(step =>
        step.kind === "user" ? { ...step, messageId: identity } : step) }));
      assert.equal(anonymous.at(-1)?.assistantMessageId, ASSISTANT);
      await h.render(anonymous);
      await h.select(h.body(".execution-user-step .markdown-body"));
      assert.equal(h.toolbar() !== null, false, "a missing user identity is a hard boundary");
      assert.deepEqual(h.calls, []);
    });
  });
}

for (const sender of ["user", "assistant"] as const) {
  test(`ordinary historical ${sender} selection retains its canonical article source`, async t => {
    await withFixture(t, async h => {
      const turns = buildSessionTimeline(completedPair("history-user", "history-answer"), []);
      await h.render(turns);
      const selected = await h.select(h.body(`article[data-sender="${sender}"] .markdown-body`));
      await h.add();
      assert.deepEqual(h.calls, [{
        messageId: sender === "user" ? "history-user" : "history-answer",
        quote: selected
      }]);
      assert.equal(selected, sender === "user" ? "Question history-user." : "Answer history-answer.");
    });
  });
}

test("selection crossing two independently delivered user sources is rejected", async t => {
  await withFixture(t, async h => {
    const { prefix, events } = editedFixture();
    events.push({ ...base, type: "message.user", messageId: "second:delivered:user", content: "Keep the body unchanged.", delivery: "steer" });
    const { turns } = projection(prefix, events);
    await h.render(turns);
    const first = h.body(".execution-user-step .markdown-body", 0);
    const second = h.body(".execution-user-step .markdown-body", 1);
    await h.select(first);
    assert.equal(h.toolbar() !== null, true, "control: one source is selectable");
    await h.select(first, second);
    assert.equal(h.toolbar() !== null, false);
    assert.deepEqual(h.calls, []);
  });
});

test("read-only mode excludes delivered canonical user sources", async t => {
  await withFixture(t, async h => {
    const { prefix, events } = editedFixture();
    const { turns } = projection(prefix, events);
    await h.render(turns, { readOnly: true });
    await h.select(h.body(".execution-user-step .markdown-body"));
    assert.equal(h.toolbar() !== null, false);
    assert.deepEqual(h.calls, []);
  });
});

test("real subagent transcript remains excluded under an otherwise valid assistant source", async t => {
  await withFixture(t, async h => {
    const history: SessionEvent[] = [
      { type: "user_message", messageId: "parent-user", content: "Delegate inspection." },
      { type: "tool_call", toolCallId: "worker-tool", tool: "Task", args: { description: "Inspect the title." } },
      { type: "tool_result", toolCallId: "worker-tool", tool: "Task", result: { status: "completed", output: "Worker-only text." } },
      { type: "agent_message", messageId: "parent-answer", parentMessageId: "parent-user",
        message: { role: "assistant", content: [{ type: "text", text: "Parent reply." }] } },
      { type: "assistant_message", messageId: "parent-answer", parentMessageId: "parent-user", content: "Parent reply." }
    ];
    const turns = buildSessionTimeline(history, []);
    assert.equal(turns[0]?.assistantMessageId, "parent-answer");
    // A historical record with no session inspection identity uses TaskInspector's real recorded output.
    await h.render(turns, { sessionId: undefined });
    const selected = await h.select(h.body(".subagent-card .markdown-body"));
    assert.equal(selected, "Worker-only text.");
    assert.equal(h.toolbar() !== null, false);
    assert.deepEqual(h.calls, []);
  });
});

test("full-history retry merge preserves the delivered identity without relying on that shape for the App regression", () => {
  const { beforeEdit, events } = editedFixture();
  const before = JSON.stringify([beforeEdit, events]);
  const { turns } = projection(beforeEdit, events);
  const replacement = turns.find(turn => turn.userMessageId === EDIT_USER);
  assert.ok(replacement);
  assert.equal(replacement.id, "history-2");
  assert.equal(replacement.assistantMessageId, ASSISTANT);
  assert.equal(stepMessageId(replacement.steps.find(step => step.kind === "user")), USER);
  assert.equal(JSON.stringify([beforeEdit, events]), before);
});

test("terminal clearing of an unpersisted retry assistant ID leaves delivered user identity independent", () => {
  const { prefix, events } = editedFixture();
  const { projector } = projection(prefix, events);
  const terminal: AgentHostEvent[] = [...events, { ...base, type: "run.completed", durationMs: 1 }];
  const turns = projector.update({ sessionId: SESSION, events: prefix, liveEvents: terminal });
  assert.deepEqual(turns, buildSessionTimeline(prefix, terminal));
  const turn = turns.find(item => item.userMessageId === EDIT_USER);
  assert.ok(turn);
  assert.equal(turn.assistantMessageId, undefined);
  assert.equal(stepMessageId(turn.steps.find(step => step.kind === "user")), USER);
});
