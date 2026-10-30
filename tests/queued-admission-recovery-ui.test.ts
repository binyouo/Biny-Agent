/** 排队消息键盘重排的 DOM 回归；视觉验收由用户完成。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("unconfirmed queue recovery is reachable while idle and never offers resend or edits", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { QueuedMessages } = await import("../src/desktop/renderer/src/components/composer/QueuedMessages.js");
  const { act, createElement } = React;
  const actions: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const recovery = { messageId: "queued-report", content: "Analyse report\nThen summarise risks", attachmentCount: 1,
    recovery: { runId: "handoff-run", messageId: "canonical-batch", attachments: [{ name: "report.txt", path: "@attachments/report.txt", mimeType: "text/plain", size: 6 }], unavailableAttachmentNames: [] } };
  Object.defineProperty(dom.window, "biny", { configurable: true, value: {
    openWorkspaceFile: async (projectId: string, file: string) => { actions.push("open:" + projectId + ":" + file); }
  } });
  const props = { projectId: "queue-owner-project", messages: [recovery], running: false, onError(message: string) { actions.push("error:" + message); },
    onRemove: async (id: string) => { actions.push("remove:" + id); },
    onSendNow: async () => { actions.push("send"); }, onSteer: async () => { actions.push("steer"); },
    onUpdate: async () => { actions.push("edit"); }, onMove: async () => { actions.push("move"); } };
  try {
    for (const running of [false, true]) {
      await act(async () => { root.render(createElement(QueuedMessages, { ...props, running })); });
      const copy = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="只读恢复副本"]');
      assert.ok(copy, "recovery remains visible even after the failed task is idle");
      assert.equal(copy.readOnly, true);
      assert.equal(copy.value, recovery.content);
      assert.match(document.body.textContent ?? "", /report.txt/u);
      assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /可能已有输入记录/u);
      assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /重启后不保留/u);
      assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="停止当前任务并发送队列"]')?.disabled, true);
      assert.equal(document.querySelector(".biny-queued-message-steer"), null);
      assert.equal(document.querySelector<HTMLElement>(".biny-queued-message-row")?.draggable, false);
      await act(async () => {
        copy.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
        copy.click();
      });
      assert.deepEqual(actions, []);
    }
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="打开 report.txt"]')!.click(); });
    assert.deepEqual(actions, ["open:queue-owner-project:@attachments/report.txt"]);
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="移除恢复副本"]')!.click(); });
    assert.deepEqual(actions, ["open:queue-owner-project:@attachments/report.txt", "remove:queued-report"]);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
