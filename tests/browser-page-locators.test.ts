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

test("label and placeholder selectors resolve exact fields and reject an occluded click", async () => {
  const dom = new JSDOM('<label for="email">Email address</label><input id="email" placeholder="name@example.com"><div id="blocker"></div>', { url: "https://example.com/", runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ x: 10, y: 20, width: 120, height: 24 }) });
  const input = window.document.getElementById("email")!;
  Object.defineProperty(window.document, "elementFromPoint", { value: () => input, configurable: true });
  const run = window.eval(`(${pageOperation.toString()})`);
  try {
    const labelled = await run("fill", { selector: "label=Email address" });
    assert.equal(labelled.x, 70);
    assert.equal(window.document.activeElement, input);
    const placeholder = await run("fill", { selector: "placeholder=name@example.com" });
    assert.equal(placeholder.x, 70);
    Object.defineProperty(window.document, "elementFromPoint", { value: () => window.document.getElementById("blocker") });
    await assert.rejects(run("click", { selector: "label=Email address" }), /被遮挡/);
  } finally { window.close(); }
});

test("select and checked actions reject occlusion before changing page controls", async () => {
  const dom = new JSDOM('<select id="country"><option value="us" selected>US</option><option value="ca">Canada</option></select><input id="accept" type="checkbox"><div id="blocker"></div>', { url: "https://example.com/", runScripts: "outside-only" });
  const { window } = dom;
  const select = window.document.getElementById("country") as HTMLSelectElement;
  const checkbox = window.document.getElementById("accept") as HTMLInputElement;
  let occluded = true;
  let target: HTMLElement = select;
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ x: 10, y: 20, width: 120, height: 24 }) });
  Object.defineProperty(window.document, "elementFromPoint", { value: () => occluded ? window.document.getElementById("blocker") : target, configurable: true });
  const run = window.eval(`(${pageOperation.toString()})`);
  let changes = 0;
  let clicks = 0;
  select.addEventListener("change", () => changes++);
  checkbox.addEventListener("click", () => clicks++);
  try {
    await assert.rejects(run("select_option", { selector: "#country", values: ["ca"] }), /被遮挡/);
    assert.equal(select.value, "us");
    assert.equal(changes, 0);
    await assert.rejects(run("set_checked", { selector: "#accept", checked: true }), /被遮挡/);
    assert.equal(checkbox.checked, false);
    assert.equal(clicks, 0);

    occluded = false;
    target = select;
    assert.deepEqual(JSON.parse(JSON.stringify(await run("select_option", { selector: "#country", values: ["ca"] }))), { values: ["ca"] });
    assert.equal(changes, 1);
    target = checkbox;
    assert.deepEqual(JSON.parse(JSON.stringify(await run("set_checked", { selector: "#accept", checked: true }))), { checked: true });
    assert.equal(checkbox.checked, true);
    assert.equal(clicks, 1);
  } finally { window.close(); }
});

test("locator chains query semantic elements, refine duplicates, and return a unique action selector", async () => {
  const dom = new JSDOM('<section class="item"><button>Save Alpha</button></section><section class="item"><button>Save Beta</button></section><label for="email">Email</label><input id="email" placeholder="name@example.com">', { url: "https://example.com/", runScripts: "outside-only" });
  const { window } = dom;
  Object.assign(window, { CSS: { escape: (value: string) => value } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ x: 10, y: 20, width: 120, height: 24 }) });
  const run = window.eval(`(${pageOperation.toString()})`);
  try {
    assert.equal(await run("locator_read", { steps: [{ m: "getByRole", role: "button", name: "Save" }], action: { m: "count" } }), 2);
    assert.equal(await run("locator_read", {
      steps: [{ m: "locator", selector: ".item" }, { m: "filter", hasText: "Beta" }, { m: "getByRole", role: "button" }, { m: "visible" }],
      action: { m: "textContent" }
    }), "Save Beta");
    await assert.rejects(run("locator_target", { steps: [{ m: "getByRole", role: "button", name: "Save" }] }), /first、last 或 nth/u);
    const selected = await run("locator_target", {
      steps: [{ m: "getByRole", role: "button", name: "Save" }, { m: "nth", index: 1 }]
    });
    assert.equal(window.document.querySelector(selected.selector)?.textContent, "Save Beta");
    assert.equal(await run("locator_read", { steps: [{ m: "getByLabel", label: "Email" }], action: { m: "getAttribute", name: "placeholder" } }), "name@example.com");
    assert.equal(await run("locator_read", { steps: [{ m: "getByPlaceholder", placeholder: "name@example.com" }], action: { m: "isEnabled" } }), true);
    await assert.rejects(run("locator_read", { steps: [{ m: "getByRole", role: "button", name: "Save" }], action: { m: "waitFor", state: "attached", timeoutMs: 0 } }), /唯一匹配/u);
    await assert.rejects(run("locator_read", { steps: [{ m: "getByRole", role: "button", name: "Save" }], action: { m: "waitFor", state: "hidden", timeoutMs: 0 } }), /唯一匹配/u);
    assert.equal(await run("locator_read", { steps: [{ m: "getByTestId", testId: "missing" }], action: { m: "waitFor", state: "detached", timeoutMs: 0 } }), true);
  } finally { window.close(); }
});

test("DOM snapshots expose visible targets and reject references whose target changes", async () => {
  const dom = new JSDOM('<button id="save">Save</button><button id="offscreen">Hidden</button>', { url: "https://example.com/", runScripts: "outside-only" });
  const { window } = dom;
  Object.assign(window, { CSS: { escape: (value: string) => value } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value() {
    return this.id === "offscreen"
      ? { x: 10, y: 900, width: 100, height: 30, left: 10, right: 110, top: 900, bottom: 930 }
      : { x: 10, y: 20, width: 100, height: 30, left: 10, right: 110, top: 20, bottom: 50 };
  } });
  const run = window.eval(`(${pageOperation.toString()})`);
  try {
    const snapshot = await run("dom_snapshot", {});
    assert.equal(snapshot.elements.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.elements[0])), {
      tag: "button", role: "button", name: "Save", selector: "#save",
      box: { x: 10, y: 20, width: 100, height: 30 }
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await run("dom_target", {
      selector: snapshot.elements[0].selector,
      expected: { tag: "button", role: "button", name: "Save", box: snapshot.elements[0].box }
    }))), { selector: "#save" });
    window.document.getElementById("save")!.textContent = "Different target";
    await assert.rejects(run("dom_target", {
      selector: snapshot.elements[0].selector,
      expected: { tag: "button", role: "button", name: "Save", box: snapshot.elements[0].box }
    }), /DOM 引用已失效/u);
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

test("media downloads resolve one supported element and bound same-page blob reads", async () => {
  const dom = new JSDOM('<img id="cover" src="/cover.png"><video id="clip"></video><div id="lazy" data-src="/lazy.webp"></div><div id="gallery"><img src="/one.png"><img src="/two.png"></div><div id="empty"></div><a id="duplicate-one" href="https://example.com/one">one</a><a id="duplicate-two" href="https://example.com/two">two</a>', { url: "https://example.com/watch", runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window.HTMLMediaElement.prototype, "currentSrc", { configurable: true, get: () => "blob:https://example.com/media-id" });
  Object.assign(window, { AbortSignal, btoa });
  const run = window.eval(`(${pageOperation.toString()})`);
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(await run("media_source", { selector: "#cover" }))), { url: "https://example.com/cover.png" });
    assert.deepEqual(JSON.parse(JSON.stringify(await run("media_source", { selector: "#lazy" }))), { url: "https://example.com/lazy.webp" });
    await assert.rejects(run("media_source", { selector: "#gallery" }), /多个媒体元素/u);
    Object.assign(window, { fetch: async (url: string, options: RequestInit) => {
      assert.equal(url, "blob:https://example.com/media-id");
      assert.equal(options.credentials, "include");
      return new Response("media bytes", { headers: { "content-type": "video/mp4" } });
    } });
    assert.deepEqual(JSON.parse(JSON.stringify(await run("media_source", { selector: "#clip" }))), {
      data: Buffer.from("media bytes").toString("base64"), mimeType: "video/mp4"
    });
    await assert.rejects(run("media_source", { selector: "a" }), /唯一媒体元素/u);
    await assert.rejects(run("media_source", { selector: "#empty" }), /不是图片/u);
  } finally { window.close(); }
});
