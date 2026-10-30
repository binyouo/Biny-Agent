import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueuedRunMessageSnapshot } from "../src/runtime/agentEvents.js";

type Deferred = ReturnType<typeof Promise.withResolvers<void>>;
async function fixture(check: (f: {
  act(action: () => void): Promise<void>;
  click(id: string): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  render(ids?: string[], scope?: string): Promise<void>;
  edits: Array<{ id: string; text: string; gate: Deferred }>;
  removals: Array<{ id: string; gate: Deferred }>;
  errors: string[];
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div><button id='outside'>outside</button>", { url: "https://localhost/", pretendToBeVisual: true });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { QueuedMessages } = await import("../src/desktop/renderer/src/components/composer/QueuedMessages.js");
  const root = createRoot(document.getElementById("root")!);
  const edits: Array<{ id: string; text: string; gate: Deferred }> = [];
  const removals: Array<{ id: string; gate: Deferred }> = [];
  const errors: string[] = [];
  const act = async (action: () => void): Promise<void> => { await React.act(async () => { action(); }); };
  const render = async (ids = ["a", "b", "c"], scope = "session-a"): Promise<void> => {
    const messages: QueuedRunMessageSnapshot[] = ids.map(id => ({ messageId: id, content: `message ${id}`, attachmentCount: 0 }));
    await act(() => root.render(React.createElement(QueuedMessages, {
      key: scope, messages, running: true, onError: (error: string) => errors.push(error),
      onMove: async () => {}, onSteer: async () => {}, onSendNow: async () => {},
      onRemove: async (id: string) => { const gate = Promise.withResolvers<void>(); removals.push({ id, gate }); await gate.promise; },
      onUpdate: async (id: string, text: string) => { const gate = Promise.withResolvers<void>(); edits.push({ id, text, gate }); await gate.promise; }
    })));
  };
  const click = async (id: string): Promise<void> => await act(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".biny-queued-message-content")].find(item => item.textContent === `message ${id}`);
    assert.ok(button); button.click();
  });
  const type = async (text: string): Promise<void> => await act(() => {
    const input = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const key = async (value: string): Promise<void> => await act(() => {
    document.querySelector("textarea")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  });
  try {
    await render();
    await check({ act, click, type, key, render, edits, removals, errors });
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("pending queue edit locks editing and destructive controls instead of accepting a draft it cannot save", async () => {
  await fixture(async ({ act, click, type, key, edits }) => {
    await click("a"); await type("edited a"); await key("Enter");
    assert.equal(edits.length, 1);
    assert.equal(document.querySelector("textarea")!.readOnly, true);
    assert.match(document.body.textContent ?? "", /正在保存/u);
    assert.ok([...document.querySelectorAll<HTMLButtonElement>(".biny-queued-message-content,.biny-queued-message-delete,.biny-queued-send-now")].every(button => button.disabled));
    await click("b"); await key("Enter");
    assert.equal(document.querySelector("textarea")!.value, "edited a");
    assert.equal(edits.length, 1);
    await act(() => edits[0]!.gate.resolve());
    await click("b"); await type("edited b"); await key("Enter");
    assert.deepEqual(edits.map(({ id, text }) => [id, text]), [["a", "edited a"], ["b", "edited b"]]);
    await act(() => edits[1]!.gate.resolve());
  });
});

test("real focus blur starts one save and keeps the failed draft available for retry", async () => {
  await fixture(async ({ act, click, type, key, edits, errors }) => {
    await click("a"); await type("unsaved a");
    await act(() => {
      const other = [...document.querySelectorAll<HTMLButtonElement>(".biny-queued-message-content")].find(button => button.textContent === "message b")!;
      other.focus(); other.click();
    });
    assert.equal(edits.length, 1);
    await act(() => edits[0]!.gate.reject(new Error("save rejected")));
    assert.deepEqual(errors, ["save rejected"]);
    assert.equal(document.querySelector("textarea")!.value, "unsaved a");
    assert.equal(document.querySelector("textarea")!.readOnly, false);
    await key("Enter");
    assert.equal(edits[1]!.text, "unsaved a");
    await act(() => edits[1]!.gate.resolve());
    assert.equal(document.querySelector("textarea"), null);
  });
});

test("Escape retires the edit before blur and reopening uses the authoritative text", async () => {
  await fixture(async ({ act, click, type, key, edits }) => {
    await click("a"); await type("cancelled text");
    const previous = document.querySelector("textarea")!;
    await key("Escape");
    await act(() => { previous.blur(); document.getElementById("outside")!.focus(); });
    assert.equal(edits.length, 0);
    await click("a");
    assert.equal(document.querySelector("textarea")!.value, "message a");
  });
});

for (const failure of [false, true]) test(`retired message save ${failure ? "failure" : "success"} cannot clear or unlock a newer message save`, async () => {
  await fixture(async ({ act, click, type, key, render, edits, errors }) => {
    await click("a"); await type("same edited text"); await key("Enter");
    await render(["b", "c"]);
    await click("b"); await type("same edited text"); await key("Enter");
    assert.equal(edits.length, 2);
    await act(() => { if (failure) edits[0]!.gate.reject(new Error("old failure")); else edits[0]!.gate.resolve(); });
    assert.equal(document.querySelector("textarea")!.value, "same edited text");
    assert.equal(document.querySelector("textarea")!.readOnly, true);
    assert.deepEqual(errors, []);
    await act(() => edits[1]!.gate.resolve());
    assert.equal(document.querySelector("textarea"), null);
  });
});

test("empty queue retires old ownership even if the same ID later reappears", async () => {
  await fixture(async ({ act, click, type, key, render, edits, errors }) => {
    await click("a"); await type("old draft"); await key("Enter");
    await render([]); await render(["a"]);
    await click("a"); await type("new draft");
    await act(() => edits[0]!.gate.reject(new Error("old failure")));
    assert.equal(document.querySelector("textarea")!.value, "new draft");
    assert.deepEqual(errors, []);
  });
});

for (const failure of [false, true]) test(`keyed session switch isolates old save ${failure ? "failure" : "success"}`, async () => {
  await fixture(async ({ act, click, type, key, render, edits, errors }) => {
    await click("a"); await type("session a draft"); await key("Enter");
    await render(["a", "b"], "session-b");
    await click("a"); await type("session b draft");
    await act(() => { if (failure) edits[0]!.gate.reject(new Error("session a error")); else edits[0]!.gate.resolve(); });
    assert.equal(document.querySelector("textarea")!.value, "session b draft");
    assert.deepEqual(errors, []);
  });
});

test("reordering authoritative rows retains the editor draft", async () => {
  await fixture(async ({ click, type, render }) => {
    await click("a"); await type("keep draft"); await render(["c", "a", "b"]);
    assert.equal(document.querySelector("textarea")!.value, "keep draft");
  });
});

test("delete while edit is saving is blocked; completed save allows a single pending delete", async () => {
  await fixture(async ({ act, click, type, key, edits, removals }) => {
    await click("a"); await type("edited a"); await key("Enter");
    await act(() => document.querySelector<HTMLButtonElement>(".biny-queued-message-delete")!.click());
    assert.equal(removals.length, 0);
    await act(() => edits[0]!.gate.resolve());
    await act(() => { const button = document.querySelector<HTMLButtonElement>(".biny-queued-message-delete")!; button.click(); button.click(); });
    assert.equal(removals.length, 1);
    await act(() => removals[0]!.gate.resolve());
  });
});

test("unmounted queue controls do not report late delete failures into the next session", async () => {
  await fixture(async ({ act, render, removals, errors }) => {
    await act(() => document.querySelector<HTMLButtonElement>(".biny-queued-message-delete")!.click());
    await render(["a"], "session-b");
    await act(() => removals[0]!.gate.reject(new Error("old delete failure")));
    assert.deepEqual(errors, []);
  });
});

test("retiring an IME editor does not leave the next queued message stuck in composition", async () => {
  await fixture(async ({ act, click, type, key, render, edits }) => {
    await click("a");
    await act(() => document.querySelector("textarea")!.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })));
    await render(["b"]);
    await click("b"); await type("next message"); await key("Enter");
    assert.equal(edits.length, 1);
    assert.equal(edits[0]!.id, "b");
    await act(() => edits[0]!.gate.resolve());
  });
});

test("live IME composition keeps Enter and blur from saving until composition ends", async () => {
  await fixture(async ({ act, click, type, key, edits }) => {
    await click("a");
    await act(() => document.querySelector("textarea")!.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })));
    await type("中文输入"); await key("Enter");
    await click("b");
    await act(() => document.getElementById("outside")!.focus());
    assert.equal(edits.length, 0);
    await act(() => document.querySelector("textarea")!.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true })));
    await key("Enter");
    assert.equal(edits.length, 1);
    assert.equal(edits[0]!.text, "中文输入");
    await act(() => edits[0]!.gate.resolve());
  });
});
