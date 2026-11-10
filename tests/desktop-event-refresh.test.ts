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
  return { base, initial, documentRef, selectedSessionIdRef, reads, projectReads, snapshot, errors, merges, conflicts, projectionRefreshes, fullWorkspaceReads, catalogReads, send, tick, startRefresh, unmount,
    sendSnapshot: (sessionId: string) => subscriber?.({ projectId: "project", snapshot: { info: { sessionId } } } as DesktopAgentEventEnvelope),
    queueDocument: (document: DesktopSessionDocument) => replaceDocument(document),
    replaceDocument: async (document: DesktopSessionDocument) => { await act(() => replaceDocument(document)); },
    text: () => dom.window.document.getElementById("root")!.textContent };
}

test("terminal reconciliation does not load complete workspaces", async context => {
  const view = await fixture(context);
  await view.startRefresh();
  assert.deepEqual(view.fullWorkspaceReads, [], "session completion must not read providers, Git, worktrees or unrelated runtime tables");
  assert.equal(view.reads.length, 1, "the selected conversation still reconciles its durable history");
});

test("one project's completion burst shares a catalog read, and title-only updates do not reread history", async context => {
  const view = await fixture(context);
  view.send({ ...view.base, type: "run.completed", durationMs: 1 });
  view.send({ ...view.base, sessionId: "background", type: "run.completed", durationMs: 1 });
  await view.tick(16);
  view.send({ ...view.base, type: "session.title", title: "new title" });
  await view.tick(16);
  await view.tick(260);
  assert.deepEqual(view.catalogReads, [["session", "background"]]);
  assert.equal(view.reads.length, 1, "a title update must not cancel an already requested history reconciliation");
  view.send({ ...view.base, type: "session.title", title: "newer title" });
  await view.tick(16);
  await view.tick(260);
  assert.equal(view.catalogReads.length, 2);
  assert.equal(view.reads.length, 1, "renaming only changes catalog metadata");
});

test("普通分析和跳过不打扰聊天，实际失败仍有提示", async (context) => {
  const view = await fixture(context);
  view.send({ ...view.base, type: "run.started", messageId: "user", model: { alias: "test", provider: "test", label: "test", reasoning: "" } });
  view.send({ ...view.base, type: "skill_extraction.updated", stage: "analyzing" });
  await view.tick(16);
  assert.doesNotMatch(view.text()!, /技能提取|正在分析可复用工作流/);
  view.send({ ...view.base, type: "skill_extraction.updated", stage: "skipped" });
  await view.tick(16);
  assert.doesNotMatch(view.text()!, /技能提取|已提取新技能/);
  view.send({ ...view.base, type: "skill_extraction.updated", stage: "failed" });
  await view.tick(16);
  assert.match(view.text()!, /技能提取失败/);
});

test("技能保存后区分新建和更新", async (context) => {
  const view = await fixture(context);
  view.send({ ...view.base, type: "skill_extraction.updated", stage: "done", skillName: "workflow", updated: false });
  await view.tick(16);
  assert.match(view.text()!, /已提取新技能workflow/);
  view.send({ ...view.base, type: "skill_extraction.updated", stage: "done", skillName: "workflow", updated: true });
  await view.tick(16);
  assert.match(view.text()!, /已更新技能workflow/);
});

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

test("plan refresh follows the selected session's mutations and terminal reconciliation", async (context) => {
  const view = await fixture(context);
  for (const sessionId of ["session", "background-session"]) {
    view.send({ ...view.base, sessionId, type: "tool.completed", toolCallId: `read-${sessionId}`, tool: "Read", result: "content" });
    view.send({ ...view.base, sessionId, type: "tool.failed", toolCallId: `failed-${sessionId}`, tool: "Read", error: "unavailable" });
    await view.tick(16);
  }
  view.send({ ...view.base, sessionId: "background-session", type: "tool.completed", toolCallId: "other-todo", tool: "TodoWrite", result: {} });
  view.send({ ...view.base, sessionId: "background-session", type: "run.completed", durationMs: 1 });
  view.sendSnapshot("background-session");
  await view.tick(16);
  assert.deepEqual(view.projectionRefreshes, [], "unrelated tools and sessions do not reread the selected plan");
  for (const tool of ["TodoWrite", "PlanDraft", "PlanStart", "PlanUpdate", "GoalUpdate"]) {
    view.send({ ...view.base, type: "tool.completed", toolCallId: tool, tool, result: {} });
    await view.tick(16);
  }
  view.send({ ...view.base, type: "tool.failed", toolCallId: "failed-plan", tool: "PlanUpdate", error: "outcome unknown" });
  await view.tick(16);
  view.sendSnapshot("session");
  await view.tick(16);
  view.send({ ...view.base, type: "run.completed", durationMs: 1 });
  await view.tick(16);
  assert.deepEqual(view.projectionRefreshes, Array(8).fill("session"), "persisted changes and terminal reconciliation remain visible");
});

test("completed runs invalidate an already-open statistics view through the shared event bridge", async context => {
  const view = await fixture(context);
  const { toolOptimizationState } = await import("../src/desktop/renderer/src/components/settings/toolOptimizationState.js");
  const { buildToolOptimizationOverview } = await import("../src/session/toolOptimizationOverview.js");
  let reads = 0;
  window.biny.toolOptimizationStats = async () => { reads++; return { ...buildToolOptimizationOverview([]), incompleteSessions: 0 }; };
  // 普通事件不为未访问的统计页创建状态或启动读取。
  view.send({ ...view.base, type: "run.completed", durationMs: 1 });
  await view.tick(16);
  assert.equal(reads, 0);
  const state = toolOptimizationState(window.biny);
  const release = state.subscribe(() => {});
  try {
    await state.refresh();
    assert.equal(reads, 1);
    view.send({ ...view.base, type: "session.title", title: "renamed" });
    await view.tick(16);
    assert.equal(reads, 1, "unrelated metadata does not reread statistics");
    view.send({ ...view.base, type: "run.completed", durationMs: 1 });
    await view.tick(16);
    assert.equal(reads, 2, "a persisted terminal run updates visible statistics automatically");
  } finally { release(); }
});
