import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/events.js";
import { activityToolRow } from "../src/desktop/renderer/src/chatModel.js";
import { collectSessionChanges } from "../src/desktop/renderer/src/sessionChanges.js";
import { createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { BinyTui } from "../src/tui/app.js";
import { TranscriptView } from "../src/tui/components/transcriptView.js";
import { ToolExecutionComponent } from "../src/tui/components/messages.js";
import { getTheme, setTheme } from "../src/tui/theme/index.js";
import type { ToolTranscriptItem } from "../src/tui/types.js";

const base = { sessionId: "session", runId: "run", timestamp: "2026-10-22T00:00:00.000Z" };
const diff = `--- a/example.ts\n+++ b/example.ts\n@@\n${"-old value\n+new value\n".repeat(250)}`;
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "");

// 仅计数真实解析器的输入扫描，仍执行原始 split 与完整解析。
function countDiffScans(context: TestContext): () => number {
  const split = String.prototype.split;
  let scans = 0;
  context.mock.method(String.prototype, "split", function (this: string, separator: string | RegExp, limit?: number) {
    if (this === diff && separator === "\n") scans++;
    return split.call(this, separator, limit);
  });
  return () => scans;
}

function editEvents(index: number): AgentHostEvent[] {
  const toolCallId = `edit-${index}`;
  const path = `src/file-${index}.ts`;
  return [
    { ...base, type: "tool.started", toolCallId, tool: "Edit", args: { path }, display: { kind: "file_io", operation: "update", path } },
    { ...base, type: "tool.change_committed", toolCallId, tool: "Edit", operationId: `operation-${index}`,
      change: { operation: "update", path, committed: true, diff } },
    { ...base, type: "tool.completed", toolCallId, tool: "Edit", durationMs: 20,
      result: { change: { operation: "update", path, committed: true, diff } } }
  ];
}

test("Desktop streaming reuses unchanged edit statistics in both chat rows and the changes panel", (context) => {
  const scans = countDiffScans(context);
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "Update the project" },
    ...Array.from({ length: 80 }, (_, index) => editEvents(index)).flat()
  ];
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents });
  const expected = Array.from({ length: 80 }, (_, index) => ({
    path: `src/file-${79 - index}.ts`, sourcePath: undefined, operation: "update",
    changeCount: 1, diff, add: 250, del: 250, status: "completed"
  }));
  const initial = collectSessionChanges(project());
  assert.deepEqual(initial, expected);
  const before = scans();
  const start = performance.now();
  for (let frame = 0; frame < 200; frame++) {
    liveEvents.push({ ...base, type: "assistant.delta", content: "x" });
    const turns = project();
    assert.deepEqual(collectSessionChanges(turns), expected);
    const row = activityToolRow(turns[0]!.tools[0]!);
    assert.deepEqual([row.plus, row.minus], [250, 250]);
  }
  console.log(JSON.stringify({ workload: "Desktop: 80 completed 500-line edits / 200 streamed updates", diffScans: scans() - before, elapsedMs: performance.now() - start }));
  assert.equal(scans() - before, 0, "streaming text must not reparse completed edits");
  assert.equal(project()[0]!.assistant, "x".repeat(200));

  liveEvents.push(...editEvents(80));
  assert.equal(collectSessionChanges(project()).length, 81, "a newly committed change must appear");
  const latestTool = project()[0]!.tools.at(-1)!;
  const replacement = { ...latestTool, diff: "@@\n-old\n+one\n+two" };
  const replaced = { ...project()[0]!, tools: [replacement] };
  assert.deepEqual(collectSessionChanges([replaced]).map(change => [change.add, change.del]), [[2, 1]]);
  assert.deepEqual([activityToolRow(replacement).plus, activityToolRow(replacement).minus], [2, 1]);
  replacement.diff = "@@\n+changed";
  assert.deepEqual(collectSessionChanges([replaced]).map(change => [change.add, change.del]), [[1, 0]], "changed input invalidates its statistics");
  assert.deepEqual(collectSessionChanges([]), [], "empty sessions must not retain previous changes");
});

function completedTool(index: number): ToolTranscriptItem {
  return {
    id: `tool-${index}`, kind: "tool", tool: "Edit", title: `Edited src/file-${index}.ts`, argsSummary: "",
    status: "success", durationMs: 1200, details: "First detail\nSecond detail",
    fileChange: { operation: "update", path: `src/file-${index}.ts`, committed: true, diff }
  };
}

test("TUI clock and input redraws reuse completed tool rows without rescanning diffs", (context) => {
  const scans = countDiffScans(context);
  const view = new TranscriptView();
  view.sync({ committed: Array.from({ length: 80 }, (_, index) => completedTool(index)), active: [] });
  const initial = view.render(100);
  assert.match(plain(initial.join("\n")), /\+250 −250/u);
  const before = scans();
  const start = performance.now();
  for (let frame = 0; frame < 200; frame++) assert.deepEqual(view.render(100), initial);
  console.log(JSON.stringify({ workload: "TUI: 80 completed 500-line edits / 200 redraws", diffScans: scans() - before, elapsedMs: performance.now() - start }));
  assert.equal(scans() - before, 0, "an unchanged completed row must not parse its diff on each clock tick");
});

test("TUI cached rows still follow updates, width, detail toggles, spacing, theme and live duration", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  const originalTheme = getTheme().name;
  const item = completedTool(0);
  const component = new ToolExecutionComponent(item);
  try {
    setTheme("dark");
    const initial = component.render(100);
    assert.doesNotMatch(plain(initial.join("\n")), /First detail/u);
    component.toggleDetails();
    assert.match(plain(component.render(100).join("\n")), /First detail/u);
    component.toggleDetails();
    assert.deepEqual(component.render(100), initial);
    component.setLeadingSpace(false);
    assert.equal(component.render(100).length, initial.length - 1);
    for (const line of component.render(15)) assert.ok(visibleWidth(line) <= 15);
    component.setLeadingSpace(true);
    const dark = component.render(100);
    setTheme("light");
    component.invalidate();
    const light = component.render(100);
    assert.notDeepEqual(light, dark);
    assert.deepEqual(light.map(plain), dark.map(plain));
    component.update({ ...item, status: "failed", output: "Write failed", fileChange: undefined });
    assert.match(plain(component.render(100).join("\n")), /Write failed/u);
    assert.doesNotMatch(plain(component.render(100).join("\n")), /\+250/u);
    component.update({ ...item, status: "running", startedAtMs: 9000, durationMs: undefined });
    assert.match(plain(component.render(100).join("\n")), /1\.0s/u);
    context.mock.timers.tick(1000);
    assert.match(plain(component.render(100).join("\n")), /2\.0s/u);
  } finally { setTheme(originalTheme); }
});

test("TUI hidden reasoning deltas do not schedule redraws while visible state transitions still do", (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 10_000 });
  const terminal: Terminal = {
    start() {}, stop() {}, drainInput: async () => {}, write() {}, columns: 100, rows: 24,
    kittyProtocolActive: false, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}
  };
  const ui = new TUI(terminal);
  const render = context.mock.method(ui, "requestRender", () => {});
  const app = new BinyTui(ui, "/unused");
  try {
    app["dispatch"]({ ...base, type: "reasoning.delta", content: "private thought" });
    assert.equal(app.tuiState.transcript.active[0]?.kind, "reasoning");
    const initial = app.tuiState;
    const before = render.mock.callCount();
    for (let index = 0; index < 1000; index++) app["dispatch"]({ ...base, type: "reasoning.delta", content: "private thought" });
    assert.equal(render.mock.callCount() - before, 0, "invisible reasoning must not request terminal frames");
    assert.equal(app.tuiState, initial);
    context.mock.timers.tick(1000);
    app["dispatch"]({ ...base, type: "assistant.delta", content: "Public answer" });
    assert.ok(render.mock.callCount() > before);
    const text = plain(app["chatContainer"].render(100).join("\n"));
    assert.match(text, /Public answer/u);
    assert.doesNotMatch(text, /private thought/u);
    assert.equal(app.tuiState.transcript.committed[0]?.kind, "reasoning");
  } finally { app["status"].dispose(); }
});
