import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopRunReceipt } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

for (const failures of [...Array.from({length:8}, (_,i) => i), -1, -2, -3, -4]) {
test(`context opt-out survives write failures ${failures}`, async t => {
      // Mount the production component; adapt only IPC, DOM facilities and assets.
      const unexpected: string[] = [];
      const saved = new Map<string, PropertyDescriptor | undefined>();
      const resources: {
        root?: Root;
        settingsRoot?: Root;
        dom?: JSDOM;
        React?: typeof import("react");
        hooks?: ReturnType<typeof registerHooks>;
      } = {};
      t.after(async () => {
        try {
          if (resources.root && resources.React) {
            await resources.React.act(() => { resources.root!.unmount(); resources.settingsRoot?.unmount(); });
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
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "biny-context-pref-"));
      t.after(async () => { t.mock.restoreAll(); await fs.rm(temp, {recursive:true,force:true}); });
      const statePath = path.join(temp, "state.json");
      const store = new DesktopStateStore(statePath);
      await store.load();
      await store.setQuickChatSettings({injectScreenContext:true, autoHideOnBlur:false,clickThrough:false});
      const settingGates: Array<ReturnType<typeof deferred<void>>> = [];
      const writes: Promise<void>[] = [];
      const rename = fs.rename;
      const intercept = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] === statePath) { const g = deferred<void>(); settingGates.push(g); await g.promise; }
        return await rename(...args);
      });
      let preferenceReads = 0;
      const readGate = deferred<ReturnType<typeof store.quickChatSettings>>();
      const api = {
        setQuickChatSettings: async (settings: Parameters<typeof store.setQuickChatSettings>[0]) => {
          const write = store.setQuickChatSettings(settings);
          writes.push(write);
          await write;
          return store.quickChatSettings();
        },
        quickChatSettings: async () => {
          if (++preferenceReads > 1 && failures === -3) throw new Error("PREFERENCE READ FAILED");
          if (preferenceReads > 1 && failures === -4) return await readGate.promise;
          return store.quickChatSettings();
        },
        bootstrap: async () => ({
          activeProjectId: "p", projects: [{ id: "p" }],
          workspace: { pickerModels: [model] }, themePreference: "light"
        }),
        quickChatScreenContext: async () => ({frontApp: {pid: 42, appName: "Test", bundleId: "test", appPath: "/test"}, promptContext: "PRIVATE_CONTEXT"}),
        getQuickChatClickThrough: async () => false,
        onAgentEvent: () => () => {},
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

      async function toggle() { await act(async () => w.document.querySelector<HTMLButtonElement>(".quickchat-context-toggle")!.click()); }
      if (failures >= 0) {
        await toggle(); await toggle(); await toggle();
        for (let index=0; index<3; index++) {
          for (let spin=0; settingGates.length <= index && spin<1000; spin++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
          assert.ok(settingGates[index], "real serialized write reached rename");
          await act(async () => {
            if (failures & (1 << index)) settingGates[index]!.reject(Object.assign(new Error("WRITE FAILED"), {code:"EIO"}));
            else settingGates[index]!.resolve();
            await writes[index]!.catch(() => undefined);
          });
        }
      } else if (failures === -1) {
        // Main settings window commits opt-out while QuickChat stays mounted.
        intercept.mock.restore();
        const settingsContainer = w.document.createElement("div");
        w.document.body.append(settingsContainer);
        const { SettingsQuickChat } = await import("../src/desktop/renderer/src/components/settings/SettingsQuickChat.js");
        resources.settingsRoot = createRoot(settingsContainer);
        await act(async () => resources.settingsRoot!.render(React.createElement(SettingsQuickChat, {initialSettings:store.quickChatSettings()})));
        await act(async () => settingsContainer.querySelector<HTMLInputElement>('input[aria-label="注入前台应用上下文"]')!.click());
        for (let spin=0; store.quickChatSettings().injectScreenContext && spin<1000; spin++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
        await act(async () => writes[0]);
        assert.equal(store.quickChatSettings().injectScreenContext, false, "main settings component committed opt-out");
      }
      const reloaded = new DesktopStateStore(statePath); await reloaded.load();
      assert.deepEqual(reloaded.quickChatSettings(), store.quickChatSettings());
      let expectedCommitted = true;
      if (failures >= 0) for (let i=0;i<3;i++) { if (!(failures & (1 << i))) expectedCommitted = i === 1; }
      if (failures === -1) expectedCommitted = false;
      assert.equal(reloaded.quickChatSettings().injectScreenContext, expectedCommitted, "last successful real write wins on disk");
      await send("only my input");
      if (failures === -3) {
        assert.equal(calls.length, 0, "unreadable authoritative preference must fail closed");
        assert.match(w.document.body.textContent ?? "", /PREFERENCE READ FAILED/);
        return;
      }
      if (failures === -4) {
        assert.equal(calls.length, 0);
        await toggle(); // local opt-out while authoritative read is pending
        await act(async () => readGate.resolve({...store.quickChatSettings(), injectScreenContext:true}));
        for (let spin=0; !settingGates[0] && spin<1000; spin++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
        await act(async () => { settingGates[0]!.reject(new Error("WRITE FAILED")); await writes[0]!.catch(() => undefined); });
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0]![7], failures === -2 ? "PRIVATE_CONTEXT" : undefined, "only a currently permitted opt-in may attach front app text");
      await act(async () => gates[0]!.resolve({sessionId:"s",runId:"r",messageId:"m"}));
});
}
