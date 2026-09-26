/** 页面程序的 DOM 合约测试；替换几何与时钟，不启动浏览器或进行界面验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageOperation } from "../src/browser-extension/page.js";
import { trackFrameEvent } from "../src/browser-extension/frames.js";

test("Shadow DOM paths, exact semantic locators, stable waits and duplicate rejection", async () => {
  const dom = new JSDOM('<div id="host"></div><button aria-label="Duplicate"></button><button aria-label="Duplicate"></button>', { url: "https://example.com/", runScripts: "outside-only" });
  const { window } = dom;
  const shadow = window.document.getElementById("host")!.attachShadow({ mode: "open" });
  shadow.innerHTML = '<button id="save" aria-label="Save">Save</button>';
  Object.assign(window, { CSS: { escape: (value: string) => value } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, width: 100, height: 20 }) });
  const run = window.eval(`(${pageOperation.toString()})`);
  let clock = 0;
  window.Date.now = () => clock;
  window.setTimeout = ((callback: () => void) => { clock += 80; queueMicrotask(callback); return 1; }) as unknown as typeof window.setTimeout;
  try {
    const snapshot = await run("read", { maxCharacters: 1000 });
    assert.ok(snapshot.interactive.some((item: { selector: string }) => item.selector === "#host >>> #save"));
    assert.equal(await run("wait", { selector: "role=button|Save", state: "visible", timeoutMs: 200 }), true);
    assert.equal(await run("wait", { selector: "#host >>> #save", state: "attached" }), true);
    await assert.rejects(run("wait", { selector: "role=button|Duplicate", state: "visible" }), /多个元素/);
    await assert.rejects(run("wait", { selector: "#missing", state: "visible", timeoutMs: 100 }), /超时/);
    assert.equal(await run("wait", { selector: "#missing", state: "hidden", timeoutMs: 0 }), true);
    shadow.querySelector("button")!.setAttribute("disabled", "");
    await assert.rejects(run("wait", { selector: "#host >>> #save", state: "visible", timeoutMs: 100 }), /超时/);
  } finally { window.close(); }
});

test("frame context destruction invalidates document IDs and interrupted child initialization stops", async () => {
  let connected = true;
  const state = { attached: new Set([1]), contexts: new Map(), connected: () => connected };
  const calls: string[] = [];
  const api = { debugger: { sendCommand: async (_target: unknown, method: string) => { calls.push(method); connected = false; } } };
  await trackFrameEvent(api, state, { tabId: 1, sessionId: "child" }, "Runtime.executionContextCreated", { context: { id: 9, uniqueId: "doc", origin: "https://example.com", auxData: { isDefault: true, frameId: "frame" } } });
  assert.equal(state.contexts.get(1).get("frame").documentId, "doc");
  await trackFrameEvent(api, state, { tabId: 1, sessionId: "child" }, "Runtime.executionContextsCleared", {});
  assert.equal(state.contexts.get(1).size, 0);
  await assert.rejects(trackFrameEvent(api, state, { tabId: 1 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" } }), /中断/);
  assert.deepEqual(calls, ["Page.enable"]);
});

test("page file transfer emits upload changes and downloads bounded bytes with page credentials", async () => {
  const dom = new JSDOM('<input id="file" type="file">', { url: "https://example.com/", runScripts: "outside-only" });
  const { window } = dom;
  const run = window.eval(`(${pageOperation.toString()})`);
  let uploaded: File[] = [];
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => this.files.push(file) };
  }
  Object.assign(window, { DataTransfer: Transfer, AbortSignal });
  Object.defineProperty(window.HTMLInputElement.prototype, "files", { set(value: File[]) { uploaded = value; } });
  let changes = 0;
  window.document.querySelector("input")!.addEventListener("change", () => changes++);
  try {
    assert.equal((await run("upload", { selector: "#file", files: [{ name: "report.txt", mimeType: "text/plain", data: "aGVsbG8=" }] })).count, 1);
    assert.equal(uploaded[0]!.name, "report.txt"); assert.equal(uploaded[0]!.size, 5); assert.equal(changes, 1);
    await assert.rejects(run("upload", { selector: "#file", files: [{ name: "a", data: "YQ==" }, { name: "b", data: "Yg==" }] }), /上传控件/);
    assert.equal(changes, 1);
    Object.assign(window, { fetch: async (_url: URL, options: RequestInit) => { assert.equal(options.credentials, "include"); return new Response("hello", { headers: { "content-type": "text/plain" } }); } });
    assert.deepEqual(JSON.parse(JSON.stringify(await run("download", { url: "https://example.com/file" }))), { mimeType: "text/plain", data: "aGVsbG8=" });
    Object.assign(window, { fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) });
    await assert.rejects(run("download", { url: "https://example.com/large" }), /8 MiB/);
  } finally { window.close(); }
});
