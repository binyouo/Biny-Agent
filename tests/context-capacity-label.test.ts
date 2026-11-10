import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const imports = registerHooks({ load(url, context, next) {
  if (/\.(svg|png|css)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return next(url, context);
} });

test("未知模型容量只展示输入量，已声明容量仍展示真实比例", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, requestAnimationFrame: (): number => 0, cancelAnimationFrame: () => {},
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { requestAnimationFrame: (): number => 0, cancelAnimationFrame: () => {} });
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
  const { createRoot } = await import("react-dom/client");
  const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
  const root = createRoot(document.getElementById("root")!);
  const noop = async (): Promise<void> => {};
  const props: React.ComponentProps<typeof Composer> = {
    drafts: new Map(), draftKey: "draft", models: [], memoryState: "disabled", memoryToggleBusy: false,
    memoryToggleDisabled: false, running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false,
    modelSetupRequired: false, focusToken: 0, capabilityDefaults: { tools: "none", skills: "none" }, skills: [], toolCatalog: [],
    onChangeFastMode: () => {}, onSend: noop, onMutateQueuedMessage: noop, onResume: noop, onSubmitEdit: noop,
    onCancelEdit: () => {}, onSlashCommand: noop, onStop: noop, onToggleMemory: noop, onSwitchModel: noop,
    onSaveAttachment: async () => { throw new Error("unused"); }, onWarning: () => {}, onSubmitError: () => {}
  };
  try {
    for (const [fallback, usedTokens, expectedTokens] of [[true, 12_050, "12.1K"], [true, 48_538, "48.5K"], [true, 0, "0"], [false, 12_050, "12.1K"]] as const) {
      await React.act(() => root.render(React.createElement(Composer, { ...props, contextUsage: {
        usedTokens, contextWindow: fallback ? 32_768 : 1_048_576,
        contextWindowIsFallback: fallback, source: "provider"
      } })));
      const status = document.querySelector<HTMLElement>('[role="status"].context-usage')!;
      await React.act(() => status.dispatchEvent(new dom.window.Event("mouseenter")));
      const tooltip = document.querySelector<HTMLElement>(".context-usage-tip")!;
      assert.ok(tooltip, "真实 Composer 渲染上下文说明");
      if (fallback) {
        assert.equal(status.textContent, `${expectedTokens} tokens`);
        assert.equal(status.getAttribute("aria-label"), `模型容量未知，最近请求输入 ${usedTokens.toLocaleString("zh-CN")} tokens`);
        assert.equal(tooltip.querySelector("strong")?.textContent, "上下文容量未知");
        assert.doesNotMatch(tooltip.textContent ?? "", /32.8K|保守预算|148.1%|36.8%/u);
        assert.equal(status.querySelector(".context-usage-ring"), null);
      } else {
        assert.equal(status.textContent, "1.1%");
        assert.equal(status.getAttribute("aria-label"), "上下文已使用 1.1%");
        assert.equal(tooltip.querySelector("strong")?.textContent, "上下文容量");
        assert.doesNotMatch(tooltip.textContent ?? "", /容量未知|保守预算/u);
      }
    }
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    imports.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
