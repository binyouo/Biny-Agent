/** Chrome API 是外部边界：验证发出的协议命令，不控制真实浏览器或替代界面验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { performBrowserCommand } from "../src/browser-extension/commands.js";

function fixture() {
  const calls: string[] = [];
  let currentUrl = "https://example.com/";
  const state = { attached: new Set<number>(), dialogs: new Set<number>(), connected: () => true };
  const api = {
    tabs: {
      query: async () => [{ id: 1, windowId: 2, url: currentUrl, title: "Page", active: true }, { id: 2, url: "chrome://settings" }],
      get: async (id: number) => ({ id, url: currentUrl }),
      update: async (_id: number, { url }: { url: string }) => { calls.push("navigate"); currentUrl = url; }
    },
    debugger: {
      attach: async () => { calls.push("attach"); },
      sendCommand: async (_target: unknown, method: string, _params: unknown) => { calls.push(method); return method === "Runtime.evaluate" ? { exceptionDetails: { text: "bad selector" } } : {}; }
    }
  };
  return { api, state, calls, setUrl: (url: string) => { currentUrl = url; } };
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
