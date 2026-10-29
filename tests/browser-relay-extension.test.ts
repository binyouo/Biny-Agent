/** Chrome API 是外部边界：验证发出的协议命令，不控制真实浏览器或替代界面验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { performBrowserCommand } from "../src/browser-extension/commands.js";

function fixture() {
  const calls: string[] = [];
  let currentUrl = "https://example.com/";
  const historyEntries = [
    { id: 1, url: "https://previous.example/" },
    { id: 2, url: currentUrl },
    { id: 3, url: "https://next.example/" }
  ];
  let historyIndex = 1;
  let pendingHistoryIndex: number | undefined;
  let historyReadsBeforeCommit = 0;
  let openedUrl = "";
  let pendingOpenUrl = "";
  const updatedListeners = new Set<(tabId: number, changeInfo: Record<string, string>, tab: unknown) => void>();
  const removedListeners = new Set<(tabId: number) => void>();
  const state = { attached: new Set<number>(), dialogs: new Set<number>(), connected: () => true };
  const api = {
    tabs: {
      query: async () => [{ id: 1, windowId: 2, url: currentUrl, title: "Page", active: true }, { id: 2, url: "chrome://settings" }],
      get: async (id: number) => ({ id, url: id === 3 ? openedUrl : currentUrl, pendingUrl: id === 3 ? pendingOpenUrl : undefined, status: id === 3 && !openedUrl ? "loading" : "complete" }),
      update: async (_id: number, { url }: { url: string }) => { calls.push("navigate"); currentUrl = url; },
      create: async ({ url }: { url: string; active: boolean }) => { calls.push("create"); pendingOpenUrl = url; return { id: 3, windowId: 2, url: "", pendingUrl: url, title: "New page", active: true }; },
      onUpdated: {
        addListener: (listener: (tabId: number, changeInfo: Record<string, string>, tab: unknown) => void) => {
          updatedListeners.add(listener);
          queueMicrotask(() => {
            if (!pendingOpenUrl) return;
            openedUrl = pendingOpenUrl;
            pendingOpenUrl = "";
            for (const update of updatedListeners) update(3, { url: openedUrl, status: "loading" }, { id: 3, url: openedUrl });
          });
        },
        removeListener: (listener: (tabId: number, changeInfo: Record<string, string>, tab: unknown) => void) => updatedListeners.delete(listener)
      },
      onRemoved: { addListener: (listener: (tabId: number) => void) => removedListeners.add(listener), removeListener: (listener: (tabId: number) => void) => removedListeners.delete(listener) }
    },
    debugger: {
      attach: async () => { calls.push("attach"); },
      sendCommand: async (_target: unknown, method: string, params: unknown) => {
        calls.push(method);
        if (method === "Page.getNavigationHistory") {
          if (pendingHistoryIndex !== undefined && --historyReadsBeforeCommit === 0) {
            historyIndex = pendingHistoryIndex;
            currentUrl = historyEntries[historyIndex]!.url;
            pendingHistoryIndex = undefined;
          }
          return { currentIndex: historyIndex, entries: historyEntries };
        }
        if (method === "Page.navigateToHistoryEntry") {
          pendingHistoryIndex = historyEntries.findIndex((entry) => entry.id === (params as { entryId: number }).entryId);
          historyReadsBeforeCommit = 2;
        }
        return method === "Runtime.evaluate" ? { exceptionDetails: { text: "bad selector" } } : {};
      }
    }
  };
  return { api, state, calls, updatedListeners, removedListeners, setUrl: (url: string) => { currentUrl = url; }, setHistoryIndex: (index: number) => { historyIndex = index; currentUrl = historyEntries[index]!.url; } };
}

test("extension only lists ordinary web tabs and refuses privileged targets", async () => {
  const { api, state, calls, setUrl } = fixture();
  const tabs = await performBrowserCommand(api, { method: "tabs" }, state);
  assert.equal(tabs.length, 1);
  setUrl("chrome://settings");
  await assert.rejects(performBrowserCommand(api, { method: "click", args: { tabId: 1, selector: "#send" } }, state), /内部页面/);
  assert.deepEqual(calls, []);
});

test("failed selector never dispatches physical input; dialogs are not accepted", async () => {
  const { api, state, calls } = fixture();
  await assert.rejects(performBrowserCommand(api, { method: "click", args: { tabId: 1, selector: "#send" } }, state), /不可操作/);
  assert.deepEqual(calls, ["attach", "Page.enable", "Runtime.enable", "Target.setAutoAttach", "Page.getFrameTree", "Runtime.evaluate"]);
  calls.length = 0;
  state.dialogs.add(1);
  await assert.rejects(performBrowserCommand(api, { method: "press", args: { tabId: 1, key: "Enter" } }, state), /确认框/);
  assert.deepEqual(calls, []);
});

test("navigation validates destination and disconnected work stops", async () => {
  const { api, state, calls } = fixture();
  await assert.rejects(performBrowserCommand(api, { method: "navigate", args: { tabId: 1, url: "file:///tmp/test" } }, state), /HTTP/);
  assert.deepEqual(await performBrowserCommand(api, { method: "navigate", args: { tabId: 1, url: "https://example.org/" } }, state), { success: true, url: "https://example.org/" });
  state.connected = () => false;
  await assert.rejects(performBrowserCommand(api, { method: "press", args: { tabId: 1, key: "Enter" } }, state), /中断/);
  assert.deepEqual(calls, ["navigate"]);
});

test("open creates a new HTTP(S) tab and refuses privileged or disconnected requests", async () => {
  const { api, state, calls, updatedListeners, removedListeners } = fixture();
  assert.deepEqual(await performBrowserCommand(api, { method: "open", args: { url: "https://example.org/" } }, state), {
    success: true, tabId: 3, windowId: 2, url: "https://example.org/"
  });
  assert.equal(updatedListeners.size, 0);
  assert.equal(removedListeners.size, 0);
  await assert.rejects(performBrowserCommand(api, { method: "open", args: { url: "chrome://settings" } }, state), /HTTP/);
  state.connected = () => false;
  await assert.rejects(performBrowserCommand(api, { method: "open", args: { url: "https://example.net/" } }, state), /中断/);
  assert.deepEqual(calls, ["create"]);
});

test("back and forward navigate only within ordinary web history", async () => {
  const { api, state, calls, setHistoryIndex } = fixture();
  assert.deepEqual(await performBrowserCommand(api, { method: "back", args: { tabId: 1 } }, state), { success: true, url: "https://previous.example/" });
  assert.equal((await api.tabs.get(1)).url, "https://previous.example/");
  assert.deepEqual(await performBrowserCommand(api, { method: "forward", args: { tabId: 1 } }, state), { success: true, url: "https://example.com/" });
  assert.equal((await api.tabs.get(1)).url, "https://example.com/");
  setHistoryIndex(0);
  const before = calls.filter((method) => method === "Page.navigateToHistoryEntry").length;
  assert.deepEqual(await performBrowserCommand(api, { method: "back", args: { tabId: 1 } }, state), { success: true, url: "https://previous.example/" });
  assert.equal(calls.filter((method) => method === "Page.navigateToHistoryEntry").length, before);
});

test("page evaluation is bounded, stays in the selected document, and hides page exceptions", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { api, state } = fixture();
  Object.assign(state, { contexts: new Map([[1, new Map([["child", { frameId: "child", contextId: 9, documentId: "document-a", sessionId: "session-child", url: "https://example.org/" }]])]]) });
  const commands: Array<{ target: unknown; method: string; params: Record<string, unknown> }> = [];
  api.debugger.sendCommand = async (target, method, params) => {
    commands.push({ target, method, params: params as Record<string, unknown> });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Runtime.evaluate") return { result: { value: { title: "Private page title" } } };
    return {};
  };
  const value = await performBrowserCommand(api, { method: "evaluate", args: {
    tabId: 1, frameId: "child", documentId: "document-a", code: "document.title", timeoutMs: 4000
  } }, state) as { title: string };
  assert.deepEqual(value, { title: "Private page title" });
  const evaluation = commands.find(command => command.method === "Runtime.evaluate")!;
  assert.deepEqual(evaluation.target, { tabId: 1, sessionId: "session-child" });
  assert.deepEqual(evaluation.params, { expression: "document.title", returnByValue: true, awaitPromise: true, timeout: 4000, contextId: 9 });

  await assert.rejects(performBrowserCommand(api, { method: "evaluate", args: {
    tabId: 1, frameId: "child", documentId: "stale", code: "document.title"
  } }, state), /文档已变化/u);
  assert.equal(commands.filter(command => command.method === "Runtime.evaluate").length, 1);

  api.debugger.sendCommand = async (_target, method) => method === "Runtime.evaluate"
    ? { exceptionDetails: { text: "Private page exception detail" } } : { frameTree: { frame: { id: "main" } } };
  await assert.rejects(performBrowserCommand(api, { method: "evaluate", args: { tabId: 1, code: "throw new Error('secret')" } }, state), error => {
    assert.match(error.message, /页面脚本执行失败/u);
    assert.doesNotMatch(error.message, /Private page exception detail/u);
    return true;
  });
  api.debugger.sendCommand = async (_target, method) => method === "Runtime.evaluate"
    ? { result: { value: "x".repeat(100001) } } : { frameTree: { frame: { id: "main" } } };
  await assert.rejects(performBrowserCommand(api, { method: "evaluate", args: { tabId: 1, code: "document.body.textContent" } }, state), /超过 100000 个字符/u);
  await assert.rejects(performBrowserCommand(api, { method: "evaluate", args: { tabId: 1, code: "document.body", timeoutMs: 8001 } }, state));
});

test("disconnect during tab lookup does not attach a debugger", async () => {
  const { api, state, calls } = fixture();
  let lookups = 0;
  const get = api.tabs.get;
  api.tabs.get = async (id) => {
    if (++lookups === 2) state.connected = () => false;
    return get(id);
  };
  await assert.rejects(performBrowserCommand(api, { method: "read", args: { tabId: 1 } }, state), /中断/);
  assert.deepEqual(calls, []);
});

test("late debugger attachment after disconnect is released without enabling Page", async () => {
  const { api, state, calls } = fixture();
  api.debugger.attach = async () => { calls.push("attach"); state.connected = () => false; };
  Object.assign(api.debugger, { detach: async () => { calls.push("detach"); } });
  await assert.rejects(performBrowserCommand(api, { method: "read", args: { tabId: 1 } }, state), /中断/);
  assert.deepEqual(calls, ["attach", "detach"]);
  assert.equal(state.attached.size, 0);
});

test("Page initialization failure releases debugger so next read initializes afresh", async () => {
  const { api, state, calls } = fixture();
  Object.assign(api.debugger, { detach: async () => { calls.push("detach"); } });
  api.debugger.sendCommand = async (_target, method) => { calls.push(method); throw new Error("Page unavailable"); };
  await assert.rejects(performBrowserCommand(api, { method: "read", args: { tabId: 1 } }, state), /Page unavailable/);
  assert.equal(state.attached.size, 0);
  assert.deepEqual(calls, ["attach", "Page.enable", "detach"]);
});

test("screenshot returns bounded PNG data without dispatching input", async () => {
  const { api, state, calls } = fixture();
  api.debugger.sendCommand = async (_target, method) => {
    calls.push(method);
    return method === "Page.captureScreenshot" ? { data: "iVBORw0KGgo=" } : {};
  };
  const result = await performBrowserCommand(api, { method: "screenshot", args: { tabId: 1 } }, state);
  assert.deepEqual(result, { mimeType: "image/png", data: "iVBORw0KGgo=" });
  assert.ok(calls.includes("Page.captureScreenshot"));
  assert.ok(!calls.some((method) => method.startsWith("Input.")));
});

test("scroll uses bounded wheel input and refuses excessive distances", async () => {
  const { api, state } = fixture();
  const inputs: unknown[] = [];
  api.debugger.sendCommand = async (_target, method, params) => {
    if (method === "Input.dispatchMouseEvent") inputs.push(params);
    return method === "Runtime.evaluate" ? { result: { value: { x: 100, y: 100 } } } : {};
  };
  await performBrowserCommand(api, { method: "scroll", args: { tabId: 1, deltaY: 600 } }, state);
  assert.deepEqual(inputs, [{ type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 600 }]);
  await assert.rejects(performBrowserCommand(api, { method: "scroll", args: { tabId: 1, deltaY: 100001 } }, state));
  assert.equal(inputs.length, 1);
});

test("frame routing uses the selected execution context and refuses stale documents", async () => {
  const { api, state } = fixture();
  Object.assign(state, { contexts: new Map([[1, new Map([["child", { frameId: "child", contextId: 9, documentId: "document-a", sessionId: "session-child", url: "https://example.org/" }]])]]) });
  const seen: Array<{ target: unknown; params: unknown }> = [];
  api.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate") seen.push({ target, params });
    return method === "Runtime.evaluate" ? { result: { value: { url: "https://example.org/", title: "Child", text: "inside", interactive: [] } } } : {};
  };
  const result = await performBrowserCommand(api, { method: "read", args: { tabId: 1, frameId: "child", documentId: "document-a" } }, state);
  assert.equal(result.text, "inside");
  assert.deepEqual(seen[0].target, { tabId: 1, sessionId: "session-child" });
  assert.equal((seen[0].params as { contextId: number }).contextId, 9);
  await assert.rejects(performBrowserCommand(api, { method: "click", args: { tabId: 1, frameId: "child", documentId: "old", selector: "button" } }, state), /文档已变化/);
});

test("same-process iframe coordinates are translated before physical input", async () => {
  const { api, state } = fixture();
  Object.assign(state, { contexts: new Map([[1, new Map([["child", { frameId: "child", contextId: 9, documentId: "doc", url: "https://example.com/" }]])]]) });
  const inputs: unknown[] = [];
  api.debugger.sendCommand = async (_target, method, params) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "DOM.getFrameOwner") return { backendNodeId: 12 };
    if (method === "DOM.getBoxModel") return { model: { content: [50, 70, 250, 70, 250, 170, 50, 170] } };
    if (method === "Runtime.evaluate") return { result: { value: { x: 10, y: 20 } } };
    if (method === "Input.dispatchMouseEvent") inputs.push(params);
    return {};
  };
  await performBrowserCommand(api, { method: "click", args: { tabId: 1, frameId: "child", documentId: "doc", selector: "button" } }, state);
  assert.equal((inputs[0] as { x: number }).x, 60);
  assert.equal((inputs[0] as { y: number }).y, 90);
});

test("closed shadow elements are exposed as document-bound backend references", async () => {
  const { api, state } = fixture();
  Object.assign(state, { contexts: new Map([[1, new Map([["main", { frameId: "main", contextId: 1, documentId: "doc", url: "https://example.com/" }]])]]) });
  api.debugger.sendCommand = async (_target, method) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Runtime.evaluate") return { result: { value: { url: "https://example.com/", title: "Page", text: "", interactive: [] } } };
    if (method === "DOM.getDocument") return { root: { children: [{ nodeName: "CUSTOM-ELEMENT", shadowRoots: [{ shadowRootType: "closed", children: [{ nodeName: "BUTTON", backendNodeId: 42, attributes: ["aria-label", "Save"], children: [] }] }] }] } };
    return {};
  };
  const result = await performBrowserCommand(api, { method: "read", args: { tabId: 1 } }, state);
  assert.equal(result.documentId, "doc");
  assert.ok(result.interactive.some((item: { selector: string }) => item.selector === "backend=42"));
  await assert.rejects(performBrowserCommand(api, { method: "click", args: { tabId: 1, selector: "backend=42" } }, state), /文档/);
});
