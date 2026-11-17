import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { createSessionTimelineProjector, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import { WorkspaceToolsPanel } from "../src/desktop/renderer/src/components/workspace/WorkspaceToolsPanel.js";

test("inspector streaming reuses display snapshots without caching mutable tool inputs", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const originalTime = Date.prototype.toLocaleTimeString;
  let formats = 0;
  Date.prototype.toLocaleTimeString = function (...args) { formats++; return originalTime.apply(this, args); };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const render = async (tools: TimelineTool[]) => await React.act(() => root.render(React.createElement(WorkspaceToolsPanel, { tools })));
  const base = { sessionId: "inspector", runId: "run", timestamp: "2026-11-14T00:00:00Z" };
  const events: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "user", content: "Inspect" }];
  for (let index = 0; index < 40; index++) liveEvents.push(
    { ...base, type: "tool.started", toolCallId: `exec-${index}`, tool: "exec", args: { code: "return 1" } },
    { ...base, type: "tool.completed", toolCallId: `exec-${index}`, tool: "exec", result: undefined, durationMs: 50 }
  );
  const projector = createSessionTimelineProjector();
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents }).flatMap(turn => turn.tools);
  try {
    const completed = project();
    await render(completed);
    const before = document.getElementById("root")!.innerHTML;
    formats = 0;
    for (let frame = 0; frame < 15; frame++) {
      liveEvents.push({ ...base, type: "reasoning.delta", content: "thinking" });
      await render(project());
    }
    assert.equal(formats, 0, "unchanged inspector display must not format each completed call on every reasoning delta");
    assert.equal(document.getElementById("root")!.innerHTML, before);

    // The tree deliberately clones exec roots. Do not replace this with an identity cache:
    // historical reconstruction and callers may mutate a root or its nested args in place.
    const call = completed[0]!;
    call.status = "running";
    (call.args as { code: string }).code = "return 2";
    call.error = "new error";
    call.durationMs = 1500;
    call.timestamp = "2026-11-14T01:02:03Z";
    call.children = [{ id: "child", tool: "Read", status: "success", args: { path: "first" }, updates: [] }];
    await render([...completed]);
    let card = document.querySelector('[data-tool-call-id="exec-0"]')!;
    assert.equal(card.querySelector('.tool-run-input')!.textContent, '{"code":"return 2"}');
    assert.equal(card.querySelector('[role="alert"]')!.textContent, "new error");
    assert.match(card.querySelector('.tool-run-meta')!.textContent!, /1.5s/u);
    assert.equal(card.querySelector('time')!.getAttribute("datetime"), call.timestamp);
    assert.notEqual(card.querySelector('.tool-execution-status')!.textContent, "Success");
    assert.equal(document.querySelector('.tool-run-list > li')!.getAttribute("data-tool-call-id"), "exec-0");
    call.status = "success";
    call.args = "plain input";
    delete call.error;
    delete call.durationMs;
    call.timestamp = "invalid";
    call.children = [{ ...call.children[0]!, args: { path: "replacement" } }];
    await render([...completed]);
    card = document.querySelector('[data-tool-call-id="exec-0"]')!;
    assert.equal(card.querySelector('.tool-execution-status')!.textContent, "Success");
    assert.equal(card.querySelector('.tool-run-input')!.textContent, "plain input");
    assert.equal(card.querySelector('[role="alert"]'), null);
    assert.equal(card.querySelector('.tool-run-meta'), null);
    assert.match(card.querySelector('.tool-run-children')!.textContent!, /replacement/u);
    call.children = [{ ...call.children[0]!, args: { path: "child-only replacement" } }];
    await render([...completed]);
    assert.match(card.querySelector('.tool-run-children')!.textContent!, /child-only replacement/u);
    call.children = [];
    await render([...completed]);
    assert.equal(card.querySelector('.tool-run-children'), null);
    await render([{ ...call, args: null, status: "failed" }]);
    assert.equal(document.querySelector('.tool-run-input')!.textContent, "null");
    assert.equal(document.querySelectorAll('.tool-run-list > li').length, 1);
  } finally {
    await React.act(() => root.unmount());
    Date.prototype.toLocaleTimeString = originalTime;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
