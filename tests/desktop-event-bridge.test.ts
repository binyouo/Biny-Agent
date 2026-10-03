import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, type SetStateAction } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { DesktopAgentEventEnvelope, DesktopSessionDocument } from "../src/desktop/protocol.js";
import { useDesktopEventBridge } from "../src/desktop/renderer/src/app/useDesktopEventBridge.js";
import { createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";

test("the event bridge delivers background text and structural events without animation frames", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let subscriber: ((event: DesktopAgentEventEnvelope) => void) | undefined;
  let unsubscribed = false;
  Object.assign(dom.window, { biny: { onAgentEvent(listener: typeof subscriber) { subscriber = listener; return () => { unsubscribed = true; }; } } });
  dom.window.requestAnimationFrame = () => { throw new Error("background animation frames are unavailable"); };
  const documentRef = { current: { session: { id: "session" }, events: [], liveEvents: [] } as unknown as DesktopSessionDocument };
  const noop = () => {};
  const setDocument = (update: SetStateAction<DesktopSessionDocument | undefined>): void => {
    const next = typeof update === "function" ? update(documentRef.current) : update;
    if (next) documentRef.current = next;
  };
  function Bridge(): null {
    useDesktopEventBridge({
      activeProjectIdRef: { current: "project" }, selectedSessionIdRef: { current: "session" }, documentRef,
      setDocument, mergeProjectSnapshot: noop, onError(error) { throw error; }, setContextBudget: noop,
      setRecipeNotices: noop, setSkillExtraction: noop, setWriterConflict: noop, setSidebarSessions: noop,
      setWorkspace: noop, onGenerationStarted: noop, onGenerationError: noop
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const base = { sessionId: "session", runId: "run", timestamp: "2026-10-02T00:00:00.000Z" };
  const send = (event: AgentHostEvent): void => subscriber?.({ projectId: "project", event, snapshot: {
    revision: 1, permissionMode: "ask", state: { kind: "idle" },
    info: { workspaceRoot: "/workspace", sessionId: "session", sessionFile: "/session.jsonl", provider: "test", modelLabel: "test", reasoningLabel: "off", modelAlias: "test", thinking: "off" }
  } });
  try {
    await act(() => root.render(createElement(Bridge)));
    assert.equal(typeof subscriber, "function");
    send({ ...base, type: "message.user", messageId: "user", content: "inspect" });
    send({ ...base, type: "reasoning.delta", content: "first " });
    context.mock.timers.tick(16);
    send({ ...base, type: "reasoning.delta", content: "second" });
    context.mock.timers.tick(16);
    for (let index = 0; index < 260; index++) send({ ...base, type: "tool.started", toolCallId: `tool-${String(index)}`, tool: "Read", args: {} });
    const beforeTimer = createSessionTimelineProjector().update({ sessionId: "session", events: [], liveEvents: documentRef.current.liveEvents });
    assert.equal(beforeTimer[0]?.reasoning, "first second");
    assert.ok((beforeTimer[0]?.tools.length ?? 0) >= 128, "queue capacity delivers work while timers are suspended");
    context.mock.timers.tick(16);
    const turns = createSessionTimelineProjector().update({ sessionId: "session", events: [], liveEvents: documentRef.current.liveEvents });
    assert.equal(turns[0]?.tools.length, 260);
    assert.equal(documentRef.current.liveEvents.filter((event) => event.type === "reasoning.delta").length, 1);
    send({ ...base, type: "assistant.delta", content: "pending after unmount" });
    const count = documentRef.current.liveEvents.length;
    await act(() => root.unmount());
    context.mock.timers.tick(16);
    assert.equal(documentRef.current.liveEvents.length, count);
    assert.equal(unsubscribed, true);
  } finally {
    if (!unsubscribed) await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
