import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { ContextBudgetStatus, ContextStatus } from "../src/agent/context/types.js";
import type { DesktopAgentEventEnvelope, DesktopSessionDocument, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import { syntheticSession } from "../src/desktop/renderer/src/app/desktopState.js";
import { useDesktopEventBridge } from "../src/desktop/renderer/src/app/useDesktopEventBridge.js";
import { useSessionTimeline } from "../src/desktop/renderer/src/app/useSessionTimeline.js";

async function fixture(context: TestContext, deferSession = false) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let subscriber: ((event: DesktopAgentEventEnvelope) => void) | undefined;
  let subscriptions = 0;
  let disposals = 0;
  const opened: string[] = [];
  const failures: Array<{ error: string; cancelled: boolean }> = [];
  const conflicts: unknown[] = [];
  const errors: unknown[] = [];
  const reads: Array<(document: DesktopSessionDocument) => void> = [];
  const selected = { current: "session" as string | undefined };
  const activeProjectIdRef = { current: "project" };
  const initial: DesktopSessionDocument = {
    session: syntheticSession("project", "session", "Earlier request."),
    events: [{ type: "user_message", content: "Earlier request." }, { type: "assistant_message", content: "Earlier answer." }],
    liveEvents: []
  };
  const documentRef = { current: initial as DesktopSessionDocument | undefined };
  const checkpoint = {
    type: "context_checkpoint" as const, reason: "manual" as const, summary: "Checkpoint.",
    firstKeptMessageIndex: 2, compactedMessages: 2, coveredMessageCount: 2,
    tokensBefore: 200, tokensAfter: 100, createdAt: "2026-10-02T00:00:00.000Z"
  };
  const refreshed: DesktopSessionDocument = { ...initial, events: [...initial.events, checkpoint], liveEvents: [] };
  Object.assign(dom.window, { biny: {
    onAgentEvent(listener: typeof subscriber) {
      subscriptions += 1;
      subscriber = listener;
      return () => { disposals += 1; subscriber = undefined; };
    },
    async refreshProject(): Promise<DesktopWorkspaceSnapshot> { return {} as DesktopWorkspaceSnapshot; },
    async openSession(_projectId: string, sessionId: string) {
      opened.push(sessionId);
      return deferSession ? await new Promise<DesktopSessionDocument>((resolve) => { reads.push(resolve); }) : refreshed;
    }
  } });
  const noop = (): void => undefined;
  const onError = (error: unknown): void => { errors.push(error); };
  const onCompactionFailed = (error: string, cancelled: boolean): void => { failures.push({ error, cancelled }); };
  const setWriterConflict = (conflict: unknown): void => { conflicts.push(conflict); };
  let replaceDocument!: Dispatch<SetStateAction<DesktopSessionDocument | undefined>>;
  function Bridge() {
    const [document, setDocument] = useState<DesktopSessionDocument | undefined>(initial);
    const [budget, setContextBudget] = useState<ContextBudgetStatus>();
    replaceDocument = setDocument;
    // Match App: stable subscription inputs and a ref updated after React commits the document.
    // Recreating an input here would dispose the owner of the hook's pending refresh.
    useEffect(() => { documentRef.current = document; }, [document]);
    useDesktopEventBridge({
      activeProjectIdRef, selectedSessionIdRef: selected, documentRef,
      setDocument, mergeProjectSnapshot: noop, onError, setContextBudget,
      setRecipeNotices: noop, setSkillExtraction: noop, setWriterConflict, setSidebarSessions: noop,
      setWorkspace: noop, onGenerationStarted: noop, onGenerationError: noop, onCompactionFailed
    });
    const turns = useSessionTimeline(document);
    return createElement("pre", null, JSON.stringify({ turns, usedTokens: budget?.usedTokens }));
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(() => root.unmount()); mounted = false; } };
  context.after(async () => {
    await unmount();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(() => root.render(createElement(Bridge)));
  const base = { sessionId: "session", runId: "compact", timestamp: "2026-10-02T00:00:00.000Z" };
  const completed: AgentHostEvent = { ...base, type: "compact.completed", summary: "Compacted.", context: { budget: { usedTokens: 100 } } as ContextStatus };
  const send = (event: AgentHostEvent): void => subscriber?.({ projectId: "project", event, snapshot: {
    revision: 1, permissionMode: "ask", state: { kind: "idle" },
    info: { workspaceRoot: "/workspace", sessionId: event.sessionId, sessionFile: "/session.jsonl", provider: "test", modelLabel: "test", reasoningLabel: "off", modelAlias: "test", thinking: "off" }
  } });
  const tick = async (milliseconds: number) => { await act(async () => { context.mock.timers.tick(milliseconds); }); };
  return {
    base, completed, initial, refreshed, checkpoint, documentRef, opened, failures, conflicts, errors, reads, send, tick, unmount,
    subscriptions: () => subscriptions, disposals: () => disposals,
    rendered: () => dom.window.document.getElementById("root")!.textContent!,
    selectDocument: async (document: DesktopSessionDocument) => {
      selected.current = document.session.id;
      await act(() => replaceDocument(document));
    }
  };
}

test("compact completion refreshes its checkpoint and failure is visible only in the owning session", async (context) => {
  const view = await fixture(context);
  view.send(view.completed);
  view.send({ ...view.base, sessionId: "other-session", runId: "other-compact", type: "compact.completed", summary: "Compacted elsewhere.", context: { budget: { usedTokens: 200 } } as ContextStatus });
  await view.tick(16);
  assert.deepEqual(view.documentRef.current!.liveEvents, [view.completed]);
  assert.match(view.rendered(), /"usedTokens":100/u);
  assert.doesNotMatch(view.rendered(), /Checkpoint\./u, "the live completion is not the persisted checkpoint");
  await view.tick(260);
  assert.deepEqual(view.opened, ["session"]);
  assert.equal(view.documentRef.current, view.refreshed);
  assert.deepEqual(view.documentRef.current.events, [...view.initial.events, view.checkpoint]);
  assert.deepEqual(view.documentRef.current.liveEvents, []);
  assert.match(view.rendered(), /Earlier request\./u);
  assert.match(view.rendered(), /Earlier answer\./u);
  assert.match(view.rendered(), /"content":"Checkpoint\."/u);
  assert.match(view.rendered(), /"notice":"compaction","compaction":\{"count":2,"savedTokens":100\}/u);
  assert.deepEqual(view.conflicts, [undefined]);

  view.send({ ...view.base, type: "compact.failed", error: "invalid_evidence", cancelled: false });
  await view.tick(16);
  await view.tick(260);
  assert.deepEqual(view.failures, [{ error: "invalid_evidence", cancelled: false }]);
  await view.selectDocument({ ...view.initial, session: { ...view.initial.session, id: "other-session" } });
  view.send({ ...view.base, type: "compact.failed", error: "Aborted.", cancelled: true });
  await view.tick(16);
  await view.tick(260);
  assert.equal(view.failures.length, 1);
  assert.deepEqual(view.opened, ["session", "session"]);
  assert.equal(view.documentRef.current!.session.id, "other-session");
  assert.deepEqual(view.errors, []);
  assert.equal(view.subscriptions(), 1, "pending-refresh renders must keep the same subscription owner");
  assert.equal(view.disposals(), 0);
  await view.unmount();
  assert.equal(view.disposals(), 1);
});

for (const sessionId of ["session", "other-session"]) {
  test(`a compact refresh cannot overwrite a newer ${sessionId === "session" ? "same-session" : "selected-session"} document`, async (context) => {
    const view = await fixture(context, true);
    view.send(view.completed);
    await view.tick(16);
    await view.tick(260);
    assert.equal(view.reads.length, 1);
    const branch: DesktopSessionDocument = { ...view.initial, session: { ...view.initial.session, id: sessionId }, events: [{ type: "user_message", content: "Selected branch." }] };
    await view.selectDocument(branch);
    await act(async () => { view.reads[0]!(view.refreshed); });
    assert.equal(view.documentRef.current, branch);
    assert.match(view.rendered(), /Selected branch\./u);
    assert.doesNotMatch(view.rendered(), /Checkpoint\./u);
    assert.deepEqual(view.conflicts, []);
    assert.deepEqual(view.errors, []);
  });
}

test("a disposed compact refresh cannot publish its checkpoint or writer conflict", async (context) => {
  const view = await fixture(context, true);
  view.send(view.completed);
  await view.tick(16);
  await view.tick(260);
  assert.equal(view.reads.length, 1);
  const beforeUnmount = view.documentRef.current;
  await view.unmount();
  await act(async () => { view.reads[0]!({ ...view.refreshed, writerConflict: { sessionId: "session", ownerSurface: "tui" } }); });
  assert.equal(view.documentRef.current, beforeUnmount);
  assert.deepEqual(view.conflicts, []);
  assert.deepEqual(view.errors, []);
  assert.equal(view.disposals(), 1);
});
