import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { createSessionTimelineProjector, type TimelineStep, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import { toolCallTree } from "../src/desktop/renderer/src/toolCallTree.js";

function tool(id: string, name = "Read"): TimelineTool {
  return { id, tool: name, args: { path: `${id}.ts` }, status: "success", updates: [] };
}

test("streamed activity preserves completed tool rows and earlier activity segments", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true, url: "https://localhost" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["window", "document", "Event", "CustomEvent", "MouseEvent", "Node", "Element", "HTMLElement", "SVGElement", "DocumentFragment", "MutationObserver", "getComputedStyle", "navigator"]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globals, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
  }
  originals.set("IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ExecutionTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
  const { ChatResponseContext } = await import("../src/desktop/renderer/src/chatResponseSettings.js");
  const root = createRoot(document.getElementById("root")!);
  const callbacks = { onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {} };
  const settings = { streaming: false };
  let argumentReads = 0;
  let resultReads = 0;
  const base = { sessionId: "session", runId: "run", timestamp: "2026-10-22T00:00:00.000Z" };
  const events: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "user", content: "Inspect the project" }];
  for (let index = 0; index < 60; index++) liveEvents.push(
    { ...base, type: "tool.started", toolCallId: `read-${index}`, tool: "Read", args: { path: `read-${index}.ts` } },
    { ...base, type: "tool.completed", toolCallId: `read-${index}`, tool: "Read", result: undefined, durationMs: 1 }
  );
  const projector = createSessionTimelineProjector();
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents })[0]!.steps;
  const completed = project();
  for (const step of completed) {
    if (step.kind !== "tool") continue;
    const call = step.tool;
    const args = call.args;
    Object.defineProperty(call, "args", { enumerable: true, get() { argumentReads++; return args; } });
    Object.defineProperty(call, "result", { enumerable: true, get() { resultReads++; return undefined; } });
  }
  const render = async (steps: TimelineStep[]) => await act(async () => root.render(createElement(ChatResponseContext.Provider, { value: settings },
    createElement(ExecutionTimeline, { ...callbacks, steps, readOnly: false, running: true, projectId: "project" }))));
  try {
    liveEvents.push({ ...base, type: "reasoning.delta", content: "Working" });
    await render(project());
    const firstRow = document.querySelector('[data-tool-call-id="read-0"]');
    assert.ok(firstRow);
    argumentReads = 0;
    for (let frame = 1; frame <= 25; frame++) {
      liveEvents.push({ ...base, type: "reasoning.delta", content: `\nWorking ${frame}` });
      await render(project());
    }
    assert.equal(argumentReads, 0, "unchanged completed tool rows must not be re-derived for reasoning deltas");
    assert.equal(document.querySelector('[data-tool-call-id="read-0"]'), firstRow);
    assert.match(document.body.textContent ?? "", /Working 25/u);

    const replaced = { kind: "tool" as const, id: "read-0", tool: { ...tool("read-0"), args: { path: "replacement.ts" }, status: "failed" as const } };
    await render([replaced, ...completed.slice(1), { kind: "reasoning", id: "thinking", content: "Still working", completed: false }]);
    assert.match(firstRow.textContent ?? "", /replacement\.ts/u);
    const toggle = firstRow.querySelector<HTMLButtonElement>("button")!;
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    await render([...completed, { kind: "assistant", id: "answer", content: "Answer 0", completed: true }]);
    resultReads = 0;
    for (let frame = 1; frame <= 25; frame++) await render([...completed, { kind: "assistant", id: "answer", content: `Answer ${frame}`, completed: true }]);
    assert.equal(resultReads, 0, "earlier activity segments must not rebuild while a later answer grows");
    assert.match(document.body.textContent ?? "", /Answer 25/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
});

test("script child grouping retains ordering, explicit links and legacy exec identity", () => {
  const earlier = tool("earlier", "exec");
  const explicit = tool("explicit", "run_script");
  const nested = { ...tool("earlier:nested:1"), parentToolCallId: "explicit" };
  const known = tool("saved");
  explicit.children = [known, { ...tool("replace"), result: "old" }];
  const replacement = { ...tool("replace"), parentToolCallId: "explicit", result: "new" };
  const ordinary = { ...tool("ordinary"), parentToolCallId: "missing" };
  const self = { ...tool("self", "run_script"), parentToolCallId: "self" };
  const sources = [earlier, explicit, nested, replacement, ordinary, self];
  const before = structuredClone(sources);
  const result = toolCallTree(sources);
  assert.deepEqual(result.map(parent => [parent.id, parent.children?.map(child => child.id)]), [
    ["earlier", ["earlier:nested:1"]], ["explicit", ["saved", "replace"]], ["ordinary", undefined], ["self", []]
  ]);
  assert.equal(result[1]!.children![1], replacement);
  assert.equal(result[2], ordinary);
  assert.deepEqual(sources, before);
});

test("script child grouping does not rescan all parents for every parent-child pair", () => {
  let parentReads = 0;
  const calls = Array.from({ length: 120 }, (_, index) => {
    const parent = tool(`script-${index}`, "run_script");
    const child = tool(`read-${index}`);
    Object.defineProperty(child, "parentToolCallId", { get() { parentReads++; return parent.id; } });
    return [parent, child];
  }).flat();
  const grouped = toolCallTree(calls);
  assert.equal(grouped.length, 120);
  assert.ok(grouped.every((parent, index) => parent.children?.[0]?.id === `read-${index}`));
  assert.ok(parentReads <= calls.length * 2, `parent identity read ${parentReads} times for ${calls.length} calls`);
});
