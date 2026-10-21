import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Socket } from "node:net";
import { SubagentActivity } from "../src/desktop/renderer/src/components/chat/SubagentActivity.js";
import type { TaskInspection, TaskInspectionOptions } from "../src/runtime/TaskCommunication.js";

const time = "2026-10-21T00:00:00Z";
function inspection(attemptId = "new", overrides: Partial<TaskInspection> = {}): TaskInspection {
  return { taskRunId: "task", sessionId: "parent", attemptId, attempts: [{ attemptId: "old", status: "failed" }, { attemptId: "new", status: "completed" }],
    title: "Inspect files", status: "completed", revision: 2, createdAt: time, updatedAt: time, inputOpen: false, resumable: false,
    messages: [], activity: [], cursor: 0, hasMore: false, ...overrides };
}
function fixture(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://desktop.test" });
  const values = { React, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.method(dom.window.HTMLCanvasElement.prototype, "getContext", () => null);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external fetch"); });
  t.mock.method(Socket.prototype, "connect", () => { throw new Error("Unexpected socket"); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: { options: TaskInspectionOptions; resolve(value: TaskInspection): void }[] = [];
  Object.assign(dom.window, { biny: { taskInspection: (project: string, session: string, task: string, options: TaskInspectionOptions) => {
    assert.deepEqual([project, session, task], ["project", "parent", "task"]);
    return new Promise<TaskInspection>(resolve => calls.push({ options, resolve }));
  } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount()); t.mock.timers.reset(); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return {
    calls,
    page: () => dom.window.document.body.textContent!,
    body: () => dom.window.document.querySelector(".subagent-transcript")!.textContent!,
    render: async (attemptId: string | null = "new", output = "Recorded new output", raw = false) => {
      await act(async () => root.render(React.createElement(SubagentActivity, {
        projectId: "project", sessionId: "parent", readOnly: true,
        tool: { id: "call", tool: "Task", args: { task: "Inspect files" }, status: "success", updates: [{ kind: "status", customKind: "subagent", customData: { taskId: "task" } }],
          result: raw ? output : { taskRunId: "task", attemptId: attemptId ?? undefined, attempts: 2, status: attemptId === "old" ? "needs_approval" : "completed", output } },
        onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}
      })));
    },
    resolve: async (value: TaskInspection) => { await act(async () => calls.at(-1)!.resolve(value)); },
    select: async (value: string) => {
      const select = dom.window.document.querySelector("select")!;
      await act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.equal(calls.at(-1)!.options.attemptId, value === "current" ? undefined : value);
    }
  };
}

test("historical empty attempt must not display a newer recorded result", async t => {
  const f = fixture(t); await f.render(); await f.resolve(inspection("new", { output: "Recorded new output" }));
  assert.match(f.body(), /Recorded new output/);
  await f.select("old"); await f.resolve(inspection("old"));
  assert.doesNotMatch(f.body(), /Recorded new output/);
});

test("current empty attempt must not display an older recorded result", async t => {
  const f = fixture(t); await f.render("old", "Recorded old output"); await f.resolve(inspection("new", { status: "failed", reason: "Repair worker failed before output", attempts: [{ attemptId: "old", status: "failed" }, { attemptId: "new", status: "failed" }] }));
  assert.match(f.page(), /Repair worker failed before output/);
  assert.doesNotMatch(f.body(), /Recorded old output/);
});

test("matching historical result remains a valid fallback", async t => {
  const f = fixture(t); await f.render("old", "Recorded old output"); await f.resolve(inspection());
  await f.select("old"); await f.resolve(inspection("old"));
  assert.match(f.body(), /Recorded old output/);
});

test("explicit empty historical output suppresses the recorded fallback", async t => {
  const f = fixture(t); await f.render(); await f.resolve(inspection());
  await f.select("old"); await f.resolve(inspection("old", { output: "" }));
  assert.doesNotMatch(f.body(), /Recorded new output/);
});

test("historical own output takes precedence", async t => {
  const f = fixture(t); await f.render(); await f.resolve(inspection());
  await f.select("old"); await f.resolve(inspection("old", { output: "Own historical output" }));
  assert.match(f.body(), /Own historical output/); assert.doesNotMatch(f.body(), /Recorded new output/);
});

test("historical own assistant activity takes precedence", async t => {
  const f = fixture(t); await f.render(); await f.resolve(inspection());
  await f.select("old"); await f.resolve(inspection("old", { cursor: 1, activity: [{ id: "answer", sequence: 1, createdAt: time, kind: "assistant", content: "Own historical activity" }] }));
  assert.match(f.body(), /Own historical activity/); assert.doesNotMatch(f.body(), /Recorded new output/);
});

test("unidentified legacy output is not attributed across multiple attempts", async t => {
  const f = fixture(t); await f.render(null, "Unidentified legacy output"); await f.resolve(inspection());
  await f.select("old"); await f.resolve(inspection("old"));
  assert.doesNotMatch(f.body(), /Unidentified legacy output/);
});

test("single-attempt legacy output remains available", async t => {
  const f = fixture(t); await f.render(null, "Legacy output");
  await f.resolve(inspection("new", { attempts: [{ attemptId: "new", status: "completed" }] }));
  assert.match(f.body(), /Legacy output/);
});

test("switching back restores matched fallback and same-attempt recorded updates", async t => {
  const f = fixture(t); await f.render(); await f.resolve(inspection());
  await f.select("old"); await f.resolve(inspection("old", { output: "Own historical output" }));
  await f.render("new", "Changed recorded output");
  assert.match(f.body(), /Own historical output/); assert.doesNotMatch(f.body(), /Changed recorded output/);
  await f.select("current"); await f.resolve(inspection());
  assert.match(f.body(), /Changed recorded output/); assert.doesNotMatch(f.body(), /Own historical output/);
  await f.render("new", "Second recorded update"); assert.match(f.body(), /Second recorded update/);
});


test("zero-attempt legacy fallback remains a compatibility concession", async t => {
  const f = fixture(t); await f.render(null, "Legacy zero attempt");
  await f.resolve(inspection("new", { attemptId: undefined, attempts: [] }));
  assert.match(f.body(), /Legacy zero attempt/);
});

for (const count of [0, 1]) test(`known mismatched identity cannot use the ${count}-attempt legacy concession`, async t => {
  const f = fixture(t); await f.render("old", "Wrong known identity");
  await f.resolve(inspection("new", { attempts: count ? [{ attemptId: "new", status: "completed" }] : [] }));
  assert.doesNotMatch(f.body(), /Wrong known identity/);
});

test("raw-string legacy result remains available with one attempt", async t => {
  const f = fixture(t); await f.render(null, "Raw legacy output", true);
  await f.resolve(inspection("new", { attempts: [{ attemptId: "new", status: "completed" }] }));
  assert.match(f.body(), /Raw legacy output/);
});

test("raw-string legacy result cannot populate a multi-attempt transcript", async t => {
  const f = fixture(t); await f.render(null, "Raw ambiguous output", true); await f.resolve(inspection());
  assert.doesNotMatch(f.body(), /Raw ambiguous output/);
});

test("empty identity uses the same single-attempt legacy policy", async t => {
  const f = fixture(t); await f.render("", "Empty identity output");
  await f.resolve(inspection("new", { attempts: [{ attemptId: "new", status: "completed" }] }));
  assert.match(f.body(), /Empty identity output/);
});

test("identity-only result changes retire and restore the fallback without another inspection", async t => {
  const f = fixture(t); await f.render("new", "Same output"); await f.resolve(inspection());
  assert.match(f.body(), /Same output/);
  await f.render("old", "Same output");
  assert.equal(f.calls.length, 1); assert.doesNotMatch(f.body(), /Same output/);
  await f.render("new", "Same output"); assert.match(f.body(), /Same output/);
});

test("changed recorded output stays absent from an already selected empty historical attempt", async t => {
  const f = fixture(t); await f.render(); await f.resolve(inspection());
  await f.select("old"); await f.resolve(inspection("old"));
  await f.render("new", "Changed unrelated output");
  assert.equal(f.calls.length, 2); assert.doesNotMatch(f.body(), /Changed unrelated output/);
});
