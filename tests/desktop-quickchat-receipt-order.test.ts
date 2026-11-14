import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopAgentEventEnvelope, DesktopRunReceipt } from "../src/desktop/protocol.js";
import type { AgentHostEvent, TerminalRunEvent } from "../src/runtime/agentEvents.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const terminalTypes: TerminalRunEvent["type"][] = [
  "run.completed", "run.failed", "run.cancelled", "run.blocked", "run.incomplete", "run.aborted"
];

interface ReceiptOrder {
  firstLate: boolean;
  secondLate: boolean;
  reset: boolean;
  overtaken?: boolean;
  reject?: boolean;
}

const receiptOrders: ReceiptOrder[] = [
  { firstLate: false, secondLate: false, reset: false },
  { firstLate: false, secondLate: true, reset: false },
  { firstLate: true, secondLate: false, reset: false },
  { firstLate: true, secondLate: true, reset: false },
  { firstLate: true, secondLate: true, reset: true },
  { firstLate: true, secondLate: true, reset: false, overtaken: true },
  { firstLate: true, secondLate: true, reset: true, overtaken: true },
  { firstLate: true, secondLate: true, reset: false, overtaken: true, reject: true },
  { firstLate: true, secondLate: true, reset: true, overtaken: true, reject: true }
];

for (const terminalType of terminalTypes) {
  for (const { firstLate, secondLate, reset, overtaken = false, reject = false } of receiptOrders) {
    const scenario = `firstLate=${firstLate} secondLate=${secondLate} reset=${reset} overtaken=${overtaken} reject=${reject}`;
    test(`QuickChat ${terminalType} receipt order ${scenario}`, async (t) => {
      // Mount the production component; adapt only IPC, DOM facilities and assets.
      const unexpected: string[] = [];
      const saved = new Map<string, PropertyDescriptor | undefined>();
      const resources: {
        root?: Root;
        dom?: JSDOM;
        React?: typeof import("react");
        hooks?: ReturnType<typeof registerHooks>;
      } = {};
      t.after(async () => {
        try {
          if (resources.root && resources.React) {
            await resources.React.act(() => resources.root!.unmount());
          }
        } finally {
          resources.dom?.window.close();
          resources.hooks?.deregister();
          for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
        }
        assert.deepEqual(unexpected, [], "No unexpected IPC or network effects");
      });

      resources.hooks = registerHooks({
        load(url, context, next) {
          if (/\.(css|svg|png)$/.test(url)) {
            return { format: "module", source: 'export default "asset";', shortCircuit: true };
          }
          return next(url, context);
        }
      });
      const { JSDOM } = await import("jsdom");
      const dom = resources.dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: "https://test.invalid",
        pretendToBeVisual: true
      });
      const w = dom.window;
      const replaceGlobal = (key: string, value: unknown): void => {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
      };
      for (const [key, value] of Object.entries({
        window: w,
        document: w.document,
        navigator: w.navigator,
        self: w,
        Node: w.Node,
        Element: w.Element,
        HTMLElement: w.HTMLElement,
        HTMLInputElement: w.HTMLInputElement,
        HTMLTextAreaElement: w.HTMLTextAreaElement,
        Event: w.Event,
        MouseEvent: w.MouseEvent,
        KeyboardEvent: w.KeyboardEvent,
        MutationObserver: w.MutationObserver,
        getComputedStyle: w.getComputedStyle.bind(w),
        ResizeObserver: class {
          observe() {}
          disconnect() {}
          unobserve() {}
        },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        IS_REACT_ACT_ENVIRONMENT: true
      })) replaceGlobal(key, value);
      w.matchMedia = (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => true
      });
      Object.defineProperty(w.document, "fonts", {
        value: { addEventListener() {}, removeEventListener() {} }
      });
      const React = resources.React = await import("react");
      const act = React.act;
      replaceGlobal("React", React);
      const { createRoot } = await import("react-dom/client");
      const gates: Array<ReturnType<typeof deferred<DesktopRunReceipt>>> = [];
      let onEvent: (event: DesktopAgentEventEnvelope) => void = () => {};
      const calls: unknown[][] = [];
      const model = {
        alias: "inert",
        displayName: "inert",
        provider: "inert",
        providerType: "openai-compatible",
        model: "inert",
        modelKey: "inert/inert",
        available: true,
        source: "configured",
        supportsTools: true,
        efforts: [],
        defaultThinking: "off",
        thinkingLevelMap: { off: "none" }
      };
      const api = {
        quickChatSettings: async () => ({
          injectScreenContext: false, autoHideOnBlur: false, clickThrough: false
        }),
        bootstrap: async () => ({
          activeProjectId: "p", projects: [{ id: "p" }],
          workspace: { pickerModels: [model] }, themePreference: "light"
        }),
        quickChatScreenContext: async () => ({}),
        getQuickChatClickThrough: async () => false,
        onAgentEvent: (listener: typeof onEvent) => {
          onEvent = listener;
          return () => {};
        },
        sendPrompt: (...args: unknown[]) => {
          calls.push(args);
          const gate = deferred<DesktopRunReceipt>();
          gates.push(gate);
          return gate.promise;
        },
        onAppearanceChanged: () => () => {},
        onQuickChatContext: () => () => {},
        onQuickChatFocusInput: () => () => {},
        onQuickChatClickThroughChanged: () => () => {}
      };
      Object.assign(w, {
        biny: new Proxy(api, {
          get(target, key) {
            if (key in target) return Reflect.get(target, key);
            unexpected.push("IPC " + String(key));
            throw new Error("Unexpected IPC " + String(key));
          }
        })
      });
      t.mock.method(globalThis, "fetch", async () => {
        unexpected.push("fetch");
        throw new Error("unexpected network");
      });
      t.mock.method(Socket.prototype, "connect", () => {
        unexpected.push("socket");
        throw new Error("unexpected socket");
      });
      const { QuickChatApp } = await import("../src/desktop/renderer/src/quickchat/QuickChatApp.js");
      const root = resources.root = createRoot(w.document.getElementById("root")!);
      await act(async () => root.render(React.createElement(QuickChatApp)));

      async function send(text: string): Promise<void> {
        await act(async () => {
          const input = w.document.querySelector("textarea")!;
          Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
          input.dispatchEvent(new w.Event("input", { bubbles: true }));
        });
        await act(async () => w.document.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
      }
      async function emit(
        runId: string,
        type: AgentHostEvent["type"],
        extra: Record<string, string> = {}
      ): Promise<void> {
        await act(async () => onEvent({
          projectId: "p",
          event: {
            type, sessionId: "s", runId, timestamp: "2026-01-01T00:00:00Z", ...extra
          } as AgentHostEvent
        }));
      }
      const firstReceipt = { sessionId: "s", runId: "r1", messageId: "m1" };
      const secondReceipt = { sessionId: "s", runId: "r2", messageId: "m2" };

      await send("one");
      assert.equal(calls.length, 1);
      if (!firstLate) await act(async () => gates[0]!.resolve(firstReceipt));
      await emit("r1", "run.started", { input: "one" });
      await emit("r1", "assistant.completed", { content: "FIRST ANSWER" });
      await emit("r1", terminalType, { error: "failed", reason: "stopped", summary: "blocked" });
      if (reset) {
        await act(async () => w.document.querySelector<HTMLButtonElement>('button[aria-label="新建快速对话"]')!.click());
      }
      if (firstLate && !overtaken) await act(async () => gates[0]!.resolve(firstReceipt));

      await send("two");
      assert.equal(calls.length, 2);
      assert.equal(calls[1]![1], reset ? undefined : "s", "new chat must not resume previous session");
      if (overtaken) {
        await act(async () => {
          if (reject) gates[0]!.reject(new Error("OLD SEND FAILED"));
          else gates[0]!.resolve(firstReceipt);
        });
        assert.ok(
          w.document.querySelector('button[aria-label="停止生成"]'),
          "old receipt/error must not clear a newer pending send"
        );
        assert.doesNotMatch(w.document.body.textContent ?? "", /OLD SEND FAILED/);
      }
      if (!secondLate) await act(async () => gates[1]!.resolve(secondReceipt));
      await emit("r2", "run.started", { input: "two" });
      await emit("r2", "assistant.completed", { content: "SECOND ANSWER" });
      await emit("r2", "run.completed");
      if (secondLate) await act(async () => gates[1]!.resolve(secondReceipt));
      assert.match(w.document.body.textContent ?? "", /SECOND ANSWER/);
      assert.ok(w.document.querySelector('button[aria-label="发送"]'));

      await send("three");
      await act(async () => gates[2]!.reject(new Error("CURRENT SEND FAILED")));
      assert.match(w.document.body.textContent ?? "", /CURRENT SEND FAILED/);
      assert.ok(w.document.querySelector('button[aria-label="发送"]'));
    });
  }
}
