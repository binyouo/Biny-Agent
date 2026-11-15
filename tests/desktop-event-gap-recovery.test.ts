import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { DesktopAgentEventEnvelope, DesktopSessionDocument, DesktopSessionTreePage } from "../src/desktop/protocol.js";
import { syntheticSession } from "../src/desktop/renderer/src/app/desktopState.js";
import { useDesktopEventBridge } from "../src/desktop/renderer/src/app/useDesktopEventBridge.js";
import { SkillExtractionCard } from "../src/desktop/renderer/src/components/SkillExtractionCard.js";
import type { SkillExtractionCardState } from "../src/desktop/renderer/src/app/useDesktopEventBridge.js";

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
  const projectReads: ReturnType<typeof deferred<DesktopSessionTreePage>>[] = [];
  const errors: unknown[] = [];
  const merges: DesktopSessionTreePage[] = [];
  const conflicts: unknown[] = [];
  const projectionRefreshes: Array<string | undefined> = [];
  const fullWorkspaceReads: string[] = [];
  const noop = () => {};
  const onError = (error: unknown) => { errors.push(error); };
  const mergeSessionCatalog = (snapshot: DesktopSessionTreePage) => { merges.push(snapshot); };
  const setWriterConflict = (conflict: unknown) => { conflicts.push(conflict); };
  const onRuntimeProjectionChanged = async () => { projectionRefreshes.push(selectedSessionIdRef.current); };
  let subscriber: ((envelope: DesktopAgentEventEnvelope) => void) | undefined;
  const snapshot: DesktopSessionTreePage = { projectId: "project", revision: "catalog", sessions: [initial.session] };
  const catalogReads: string[][] = [];
  const readSessionCatalog = async (_projectId: string, sessionIds: string[]): Promise<(allowPublish: boolean) => void> => {
    catalogReads.push(sessionIds);
    if (!deferProject) return allowPublish => { if (allowPublish) mergeSessionCatalog(snapshot); };
    const pending = deferred<DesktopSessionTreePage>();
    projectReads.push(pending);
    const next = await pending.promise;
    return allowPublish => { if (allowPublish) mergeSessionCatalog(next); };
  };
  Object.assign(dom.window, { biny: {
    onAgentEvent(listener: typeof subscriber) { subscriber = listener; return () => { subscriber = undefined; }; },
    refreshProject: async (projectId: string) => { fullWorkspaceReads.push(projectId); throw new Error("Unexpected full workspace read"); },
    openSession() { const pending = deferred<DesktopSessionDocument>(); reads.push(pending); return pending.promise; }
  } });
  let replaceDocument!: Dispatch<SetStateAction<DesktopSessionDocument | undefined>>;
  function Bridge() {
    const [document, setDocument] = useState<DesktopSessionDocument | undefined>(initial);
    const [skillExtraction, setSkillExtraction] = useState<SkillExtractionCardState>();
    replaceDocument = setDocument;
    useEffect(() => { documentRef.current = document; }, [document]);
    useDesktopEventBridge({
      activeProjectIdRef, selectedSessionIdRef, documentRef, setDocument, readSessionCatalog, onError,
      onRuntimeProjectionChanged,
      setContextBudget: noop, setRecipeNotices: noop, setSkillExtraction, setWriterConflict,
      setSidebarSessions: noop, setWorkspace: noop, onGenerationStarted: noop, onGenerationError: noop
    });
    return createElement("div", null, createElement("pre", null, JSON.stringify(document)), skillExtraction ? createElement(SkillExtractionCard, { state: skillExtraction, onDismiss: noop }) : null);
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
  return { base, initial, documentRef, activeProjectIdRef, selectedSessionIdRef, reads, projectReads, snapshot, errors, merges, conflicts, projectionRefreshes, fullWorkspaceReads, catalogReads, send, tick, startRefresh, unmount,
    sendSnapshot: (sessionId: string, idle = true) => subscriber?.({ projectId: "project", snapshot: {
      revision: 1, permissionMode: "ask", state: idle ? { kind: "idle" } : { kind: "runs", activeRun: { sessionId, runId: "run", messageId: "synthetic-message", input: "Synthetic question", status: "running", startedAt: "2026-11-13T00:00:00.000Z" } },
      info: { sessionId, workspaceRoot: "/synthetic", sessionFile: "/synthetic/session.jsonl", provider: "synthetic",
        modelLabel: "Synthetic", reasoningLabel: "Off", modelAlias: "synthetic", thinking: "off" }
    } }),
    queueDocument: (document: DesktopSessionDocument) => replaceDocument(document),
    replaceDocument: async (document: DesktopSessionDocument) => { await act(() => replaceDocument(document)); },
    text: () => dom.window.document.getElementById("root")!.textContent };
}

test("idle snapshot recovers canonical document and catalog", async context => {
  const view = await fixture(context);
  view.send({ ...view.base, type: "assistant.delta", content: "partial-before-disconnect" });
  await view.tick(16);
  view.sendSnapshot("session");
  await view.tick(16);
  await view.tick(260);
  assert.equal(view.reads.length, 1);
  assert.deepEqual(view.catalogReads, [["session"]]);
  const recovered: DesktopSessionDocument = { ...view.initial, events: [
    { type: "assistant_message", content: "Complete persisted answer", time: view.base.timestamp }
  ] };
  await act(async () => { view.reads[0]!.resolve(recovered); });
  assert.equal(view.documentRef.current, recovered);
  assert.doesNotMatch(view.text()!, /partial-before-disconnect/);
});

test("running snapshot keeps live stream without requesting history", async context => {
  const view = await fixture(context);
  view.send({ ...view.base, type: "assistant.delta", content: "live content" });
  await view.tick(16);
  view.sendSnapshot("session", false);
  await view.tick(16);
  await view.tick(260);
  assert.equal(view.reads.length, 0);
  assert.equal(view.catalogReads.length, 0);
  assert.match(view.text()!, /live content/);
});

for (const replacement of ["stream", "project", "session", "unmount"] as const) {
  test(`idle snapshot read cannot overwrite newer ${replacement}`, async context => {
    const view = await fixture(context);
    view.sendSnapshot("session");
    await view.tick(16);
    await view.tick(260);
    assert.equal(view.reads.length, 1);
    const stale: DesktopSessionDocument = { ...view.initial, events: [
      { type: "assistant_message", content: "STALE canonical result", time: view.base.timestamp }
    ] };
    if (replacement === "stream") {
      view.send({ ...view.base, runId: "next-run", type: "assistant.delta", content: "new live stream" });
      await view.tick(16);
    } else if (replacement === "project") view.activeProjectIdRef.current = "other-project";
    else if (replacement === "session") view.selectedSessionIdRef.current = "other-session";
    else await view.unmount();
    await act(async () => { view.reads[0]!.resolve(stale); });
    assert.notEqual(view.documentRef.current, stale);
    assert.equal(view.conflicts.length, 0);
    if (replacement === "stream") assert.match(view.text()!, /new live stream/);
  });
}
