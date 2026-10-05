import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { DesktopAgentEventEnvelope, DesktopSessionDocument, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import { syntheticSession } from "../src/desktop/renderer/src/app/desktopState.js";
import { useDesktopEventBridge } from "../src/desktop/renderer/src/app/useDesktopEventBridge.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(context: TestContext, deferProject = false) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const initial: DesktopSessionDocument = { session: syntheticSession("project", "session", "first"), events: [], liveEvents: [] };
  const documentRef = { current: initial as DesktopSessionDocument | undefined };
  const activeProjectIdRef = { current: "project" as string | undefined };
  const selectedSessionIdRef = { current: "session" as string | undefined };
  const reads: ReturnType<typeof deferred<DesktopSessionDocument>>[] = [];
  const projectReads: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>>[] = [];
  const errors: unknown[] = [];
  const merges: DesktopWorkspaceSnapshot[] = [];
  const conflicts: unknown[] = [];
  const noop = () => {};
  const onError = (error: unknown) => { errors.push(error); };
  const mergeProjectSnapshot = (snapshot: DesktopWorkspaceSnapshot) => { merges.push(snapshot); };
  const setWriterConflict = (conflict: unknown) => { conflicts.push(conflict); };
  let subscriber: ((envelope: DesktopAgentEventEnvelope) => void) | undefined;
  const snapshot = { project: { id: "project" }, sessions: [initial.session] } as DesktopWorkspaceSnapshot;
  Object.assign(dom.window, { biny: {
    onAgentEvent(listener: typeof subscriber) { subscriber = listener; return () => { subscriber = undefined; }; },
    refreshProject: async () => {
      if (!deferProject) return snapshot;
      const pending = deferred<DesktopWorkspaceSnapshot>();
      projectReads.push(pending);
      return await pending.promise;
    },
    openSession() { const pending = deferred<DesktopSessionDocument>(); reads.push(pending); return pending.promise; }
  } });
  let replaceDocument!: Dispatch<SetStateAction<DesktopSessionDocument | undefined>>;
  function Bridge() {
    const [document, setDocument] = useState<DesktopSessionDocument | undefined>(initial);
    replaceDocument = setDocument;
    useEffect(() => { documentRef.current = document; }, [document]);
    useDesktopEventBridge({
      activeProjectIdRef, selectedSessionIdRef, documentRef, setDocument, mergeProjectSnapshot, onError,
      setContextBudget: noop, setRecipeNotices: noop, setSkillExtraction: noop, setWriterConflict,
      setSidebarSessions: noop, setWorkspace: noop, onGenerationStarted: noop, onGenerationError: noop
    });
    return createElement("pre", null, JSON.stringify(document));
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
  const base = { sessionId: "session", runId: "run", timestamp: "2026-10-04T00:00:00.000Z" };
  const send = (event: AgentHostEvent) => subscriber?.({ projectId: "project", event } as DesktopAgentEventEnvelope);
  const tick = async (milliseconds: number) => { await act(async () => { context.mock.timers.tick(milliseconds); }); };
  const startRefresh = async () => {
    send({ ...base, type: "run.completed", durationMs: 1 });
    await tick(16);
    await tick(260);
  };
  return { base, initial, documentRef, selectedSessionIdRef, reads, projectReads, snapshot, errors, merges, conflicts, send, tick, startRefresh, unmount,
    queueDocument: (document: DesktopSessionDocument) => replaceDocument(document),
    replaceDocument: async (document: DesktopSessionDocument) => { await act(() => replaceDocument(document)); },
    text: () => dom.window.document.getElementById("root")!.textContent };
}

test("a terminal refresh cannot erase newer streamed output in the same session", async (context) => {
  const view = await fixture(context);
  await view.startRefresh();
  assert.equal(view.reads.length, 1);
  const stale = structuredClone(view.documentRef.current!);
  view.send({ ...view.base, runId: "next-run", type: "assistant.delta", content: "new output" });
  await view.tick(16);
  assert.match(view.text()!, /new output/);
  await act(async () => { view.reads[0]!.resolve(stale); });
  assert.match(view.text()!, /new output/, "an older IPC response must not remove already rendered text");
});

test("a terminal refresh cannot undo a message-version document replacement", async (context) => {
  const view = await fixture(context);
  await view.startRefresh();
  const stale = structuredClone(view.documentRef.current!);
  const switched: DesktopSessionDocument = { ...view.initial, events: [{ type: "user_message", content: "selected branch", timestamp: view.base.timestamp }] };
  await view.replaceDocument(switched);
  await act(async () => { view.reads[0]!.resolve(stale); });
  assert.equal(view.documentRef.current, switched);
  assert.equal(view.conflicts.length, 0);
  assert.match(view.text()!, /selected branch/);
});

test("an unchanged selected document still receives the terminal refresh", async (context) => {
  const view = await fixture(context);
  await view.startRefresh();
  const refreshed: DesktopSessionDocument = { ...view.initial, events: [{ type: "user_message", content: "persisted history", timestamp: view.base.timestamp }] };
  await act(async () => { view.reads[0]!.resolve(refreshed); });
  assert.equal(view.documentRef.current, refreshed);
  assert.equal(view.conflicts.length, 1);
  assert.equal(view.merges.length, 1);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`a disposed event bridge ignores an in-flight session refresh ${outcome}`, async (context) => {
    const view = await fixture(context);
    await view.startRefresh();
    await view.unmount();
    await act(async () => {
      if (outcome === "resolve") view.reads[0]!.resolve(view.initial);
      else view.reads[0]!.reject(new Error("obsolete read failed"));
    });
    assert.equal(view.conflicts.length, 0, "disposed subscriptions cannot publish stale writer conflicts");
    assert.deepEqual(view.errors, [], "disposed subscriptions cannot publish stale warnings");
  });
}

test("a later terminal refresh still reconciles history after streaming invalidated an earlier read", async (context) => {
  const view = await fixture(context);
  await view.startRefresh();
  const stale = structuredClone(view.documentRef.current!);
  view.send({ ...view.base, runId: "next-run", type: "assistant.delta", content: "new output" });
  await view.tick(16);
  await act(async () => { view.reads[0]!.resolve(stale); });
  await view.startRefresh();
  assert.equal(view.reads.length, 2);
  const final: DesktopSessionDocument = { ...view.initial, events: [{ type: "assistant_message", content: "new output", timestamp: view.base.timestamp }] };
  await act(async () => { view.reads[1]!.resolve(final); });
  assert.equal(view.documentRef.current, final);
});

test("an older overlapping refresh cannot undo a newer refresh", async (context) => {
  const view = await fixture(context);
  await view.startRefresh();
  const stale = structuredClone(view.documentRef.current!);
  await view.startRefresh();
  const fresh = { ...view.initial, session: { ...view.initial.session, title: "new title" } };
  await act(async () => { view.reads[1]!.resolve(fresh); });
  await act(async () => { view.reads[0]!.resolve(stale); });
  assert.equal(view.documentRef.current, fresh);
});

test("a refresh for a session left during the read cannot change the selected document", async (context) => {
  const view = await fixture(context);
  await view.startRefresh();
  view.selectedSessionIdRef.current = "another-session";
  const selected = { ...view.initial, session: { ...view.initial.session, id: "another-session" } };
  await view.replaceDocument(selected);
  await act(async () => { view.reads[0]!.resolve(view.initial); });
  assert.equal(view.documentRef.current, selected);
  assert.equal(view.conflicts.length, 0);
});

test("disposing during the project refresh prevents both publication and the session read", async (context) => {
  const view = await fixture(context, true);
  await view.startRefresh();
  assert.equal(view.projectReads.length, 1);
  assert.equal(view.reads.length, 0);
  await view.unmount();
  await act(async () => { view.projectReads[0]!.resolve(view.snapshot); });
  assert.equal(view.merges.length, 0);
  assert.equal(view.reads.length, 0);
});

test("a queued document change cannot publish stale writer conflicts before the document ref updates", async (context) => {
  const view = await fixture(context);
  await view.startRefresh();
  const changed = { ...view.initial, events: [{ type: "user_message" as const, content: "queued branch", timestamp: view.base.timestamp }] };
  const stale = structuredClone(view.documentRef.current!);
  await act(async () => {
    view.queueDocument(changed);
    view.reads[0]!.resolve(stale);
  });
  assert.equal(view.documentRef.current, changed);
  assert.equal(view.conflicts.length, 0, "discarded document reads must not publish a stale conflict update");
});

test("the newest read wins when overlapping refreshes capture the same document", async (context) => {
  const view = await fixture(context, true);
  await view.startRefresh();
  await view.startRefresh();
  await act(async () => {
    for (const pending of view.projectReads) pending.resolve(view.snapshot);
  });
  assert.equal(view.reads.length, 2);
  const fresh = { ...view.initial, session: { ...view.initial.session, title: "new title" } };
  await act(async () => {
    view.reads[1]!.resolve(fresh);
    view.reads[0]!.resolve(view.initial);
  });
  assert.equal(view.documentRef.current, fresh);
});
