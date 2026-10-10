/**
 * 思考 chip 的点击展开需要真实的 DOM 事件，静态渲染覆盖不到。
 * 这里用 jsdom 验证落定后的展开路径：未展开时全文不进入 DOM，展开后渲染代码块，再次点击收起。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { TimelineReasoningStep } from "../src/desktop/renderer/src/sessionTimeline.js";

test("落定的长思考 chip 点击后在原位展开全文（含代码块），再次点击收起", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ActivitySegment } = await import("../src/desktop/renderer/src/components/chat/ActivitySegment.js");
  const reasoning: TimelineReasoningStep = {
    kind: "reasoning",
    id: "r1",
    content: "先检查入口。\n\n```ts\nconst answer = 42;\n```\n确认配置来源。",
    completed: true,
    durationMs: 2000,
  };
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  const render = (): void => {
    root.render(createElement(ActivitySegment, {
      steps: [reasoning],
      running: false,
      projectId: "p1",
      onPreviewFile: () => undefined,
      onOpenExternal: () => undefined,
    }));
  };
  const clickBy = async (selector: string): Promise<void> => {
    const element = container.querySelector<HTMLElement>(selector);
    assert.ok(element, `missing ${selector}`);
    await act(async () => { element.click(); });
  };
  try {
    await act(async () => render());
    // 落定后活动段默认收起，先打开时间线视图，再点击思考 chip。
    await clickBy(".chat-activity-summary");
    const chip = container.querySelector<HTMLButtonElement>("button.chat-think-chip");
    assert.ok(chip, "落定的长思考应提供可点击的 chip");
    assert.equal(chip.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector(".markdown-code-block"), null, "未展开时代码块不进入 DOM");

    await clickBy("button.chat-think-chip");
    assert.equal(container.querySelector("button.chat-think-chip")?.getAttribute("aria-expanded"), "true");
    assert.ok(container.querySelector(".markdown-code-block"), "展开后代码块按 Markdown 渲染");
    assert.match(container.textContent ?? "", /确认配置来源。/u);

    await clickBy("button.chat-think-chip");
    assert.equal(container.querySelector("button.chat-think-chip")?.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector(".markdown-code-block"), null, "收起后正文移出 DOM");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
