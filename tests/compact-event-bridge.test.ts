import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, type SetStateAction } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { ContextStatus } from "../src/agent/context/types.js";
import type { DesktopAgentEventEnvelope, DesktopSessionDocument, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import { useDesktopEventBridge } from "../src/desktop/renderer/src/app/useDesktopEventBridge.js";

test("compact completion refreshes its checkpoint and failure is visible only in the owning session", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let subscriber: ((event: DesktopAgentEventEnvelope) => void) | undefined;
  const opened: string[] = [];
  const failures: Array<{ error: string; cancelled: boolean }> = [];
  const selected = { current: "session" as string | undefined };
  const documentRef = { current: { session: { id: "session" }, events: [], liveEvents: [] } as unknown as DesktopSessionDocument };
  const refreshed = { session: { id: "session" }, events: [{ type: "context_checkpoint", summary: "Checkpoint." }], liveEvents: [] } as unknown as DesktopSessionDocument;
  Object.assign(dom.window, { biny: {
    onAgentEvent(listener: typeof subscriber) { subscriber = listener; return () => {}; },
    async refreshProject(): Promise<DesktopWorkspaceSnapshot> { return {} as DesktopWorkspaceSnapshot; },
    async openSession(_projectId: string, sessionId: string) { opened.push(sessionId); return refreshed; }
  } });
  const noop = (): void => undefined;
  const setDocument = (update: SetStateAction<DesktopSessionDocument | undefined>): void => {
    const next = typeof update === "function" ? update(documentRef.current) : update;
    if (next) documentRef.current = next;
  };
  function Bridge(): null {
    useDesktopEventBridge({
      activeProjectIdRef: { current: "project" }, selectedSessionIdRef: selected, documentRef,
      setDocument, mergeProjectSnapshot: noop, onError(error) { throw error; }, setContextBudget: noop,
      setRecipeNotices: noop, setSkillExtraction: noop, setWriterConflict: noop, setSidebarSessions: noop,
      setWorkspace: noop, onGenerationStarted: noop, onGenerationError: noop,
      onCompactionFailed(error, cancelled) { failures.push({ error, cancelled }); }
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const base = { sessionId: "session", runId: "compact", timestamp: "2026-10-02T00:00:00.000Z" };
  const send = (event: AgentHostEvent): void => subscriber?.({ projectId: "project", event, snapshot: {
    revision: 1, permissionMode: "ask", state: { kind: "idle" },
    info: { workspaceRoot: "/workspace", sessionId: event.sessionId, sessionFile: "/session.jsonl", provider: "test", modelLabel: "test", reasoningLabel: "off", modelAlias: "test", thinking: "off" }
  } });
  try {
    await act(() => root.render(createElement(Bridge)));
    await act(async () => {
      send({ ...base, type: "compact.completed", summary: "Compacted.", context: { budget: { usedTokens: 100 } } as ContextStatus });
      send({ ...base, sessionId: "other-session", runId: "other-compact", type: "compact.completed", summary: "Compacted elsewhere.", context: { budget: { usedTokens: 200 } } as ContextStatus });
      context.mock.timers.tick(16);
      context.mock.timers.tick(260);
    });
    assert.deepEqual(opened, ["session"]);
    assert.equal(documentRef.current, refreshed);
    await act(async () => {
      send({ ...base, type: "compact.failed", error: "invalid_evidence", cancelled: false });
      context.mock.timers.tick(16);
      context.mock.timers.tick(260);
    });
    assert.deepEqual(failures, [{ error: "invalid_evidence", cancelled: false }]);
    selected.current = "other-session";
    await act(async () => {
      send({ ...base, type: "compact.failed", error: "Aborted.", cancelled: true });
      context.mock.timers.tick(16);
      context.mock.timers.tick(260);
    });
    assert.equal(failures.length, 1);
    assert.deepEqual(opened, ["session", "session"]);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
