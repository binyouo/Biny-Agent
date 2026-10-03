/** 用虚拟帧时钟验证正文提交频率、空闲停机和收尾，不测量或代替真实窗口 FPS。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("流式文本提交间隔至少 24ms，追平后停止调度，新内容可唤醒且卸载释放", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let now = 1;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const globals = { window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true,
    performance: { now: () => now },
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++nextId, fn); return nextId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); } };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { useTypewriter } = await import("../src/desktop/renderer/src/components/useTypewriter.js");
  const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
  const { buildSessionTimeline } = await import("../src/desktop/renderer/src/sessionTimeline.js");
  const root = createRoot(document.getElementById("root")!);
  const commits: number[] = [];
  function Probe({ text, streaming }: { text: string; streaming: boolean }): React.ReactNode {
    const displayed = useTypewriter(text, streaming);
    React.useEffect(() => { commits.push(now); }, [displayed]);
    return displayed;
  }
  const render = async (text: string, streaming = true): Promise<void> => {
    await React.act(() => root.render(React.createElement(Probe, { text, streaming })));
  };
  const frame = async (dt = 8): Promise<void> => {
    now += dt;
    const pending = [...frames.values()];
    frames.clear();
    await React.act(() => { for (const callback of pending) callback(now); });
  };
  try {
    await render("");
    // 多次快速到达建立较高速率，模拟高刷新率屏幕的 8ms 帧。
    let text = "";
    for (let i = 0; i < 15; i++) {
      text += "文字🙂";
      await render(text);
      await frame();
    }
    const streamingCommits = [...commits];
    await render(text, false);
    for (let i = 0; i < 1500 && frames.size; i++) await frame();
    assert.equal(document.getElementById("root")!.textContent, text);
    assert.ok(commits.length > 2);
    assert.ok(streamingCommits.slice(2).every((time, index) => time - streamingCommits[index + 1]! >= 24), "不能每个显示帧都提交正文");
    assert.equal(frames.size, 0);
    await render(`${text}新内容`);
    for (let i = 0; i < 1500 && document.getElementById("root")!.textContent !== `${text}新内容`; i++) await frame();
    await frame();
    assert.equal(document.getElementById("root")!.textContent, `${text}新内容`);
    assert.equal(frames.size, 0, "仍在等待服务端时，追平内容也应停止空转");
    await render("替换");
    assert.equal(document.getElementById("root")!.textContent, "替换");
    await render("大".repeat(600));
    assert.equal(document.getElementById("root")!.textContent, "大".repeat(600));
    await render(`${"大".repeat(600)}追加`);

    // Given 正文尚在动画缓冲中，窗口暂停动画帧；When 模型完成；Then 正文立即可读。
    await render("", true);
    await render("已生成的完整回答", true);
    assert.equal(document.getElementById("root")!.textContent, "");
    await render("已生成的完整回答", false);
    assert.equal(document.getElementById("root")!.textContent, "已生成的完整回答", "完成回复不能依赖下一次动画帧");
    assert.equal(frames.size, 0, "完成后取消待执行的展示动画");

    // 非流式显示从空内容更新成短正文，同样不等待动画帧。
    await render("", false);
    await render("第二条回答", false);
    assert.equal(document.getElementById("root")!.textContent, "第二条回答");

    const base = { sessionId: "session", runId: "run", timestamp: "2026-10-04T00:00:00.000Z" };
    const events: import("../src/runtime/agentEvents.js").AgentHostEvent[] = [
      { ...base, type: "message.user", messageId: "user", content: "hi" },
      { ...base, type: "reasoning.delta", content: "分析问候内容" },
      { ...base, type: "assistant.delta", content: "嘿" }
    ];
    const noop = (): void => {};
    const noopAsync = async (): Promise<void> => {};
    const renderTimeline = async (): Promise<void> => {
      await React.act(() => root.render(React.createElement(MessageTimeline, {
        sessionId: "session", projectId: "project", turns: buildSessionTimeline([], events),
        thinking: !events.some((event) => event.type === "run.completed"),
        onPreviewFile: noop, onOpenExternal: noop, onResolvePermission: noopAsync,
        onRetry: noopAsync, onSwitchVersion: noopAsync, onEditRequest: noop,
        onCreateBranch: noop, onRollbackFiles: noop
      })));
    };
    await renderTimeline();
    events.push({ ...base, type: "assistant.delta", content: "，已经完成。" });
    await renderTimeline();
    assert.equal(document.querySelector(".execution-assistant-step")?.textContent, "嘿");
    events.push({ ...base, type: "assistant.completed", content: "嘿，已经完成。" },
      { ...base, type: "run.completed", durationMs: 1000 });
    await renderTimeline();
    assert.equal(document.querySelector(".execution-assistant-step")?.textContent, "嘿，已经完成。", "从运行事件到消息正文的完整链路不依赖动画帧收尾");
    assert.equal(frames.size, 0);
  } finally {
    await React.act(() => root.unmount());
    assert.equal(frames.size, 0);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
