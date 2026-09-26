/** 用虚拟帧时钟验证正文提交频率、空闲停机和收尾，不测量或代替真实窗口 FPS。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("流式文本提交间隔至少 24ms，追平后停止调度，新内容可唤醒且卸载释放", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>");
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
    await render(text, false);
    for (let i = 0; i < 1500 && frames.size; i++) await frame();
    assert.equal(document.getElementById("root")!.textContent, text);
    assert.ok(commits.length > 2);
    assert.ok(commits.slice(2).every((time, index) => time - commits[index + 1]! >= 24), "不能每个显示帧都提交正文");
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
