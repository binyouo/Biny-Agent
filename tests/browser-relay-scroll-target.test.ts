/** Real extension commands and serialized page program; Chrome/CDP and DOM geometry are explicit boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { performBrowserCommand } from "../src/browser-extension/commands.js";
import { pageOperation } from "../src/browser-extension/page.js";

function fixture(childFrame = false) {
  const dom = new JSDOM('<div id="panel">Panel</div><div id="cover">Cover</div>', { url: "https://fixture.invalid/", runScripts: "outside-only" });
  const window = dom.window;
  const panel = window.document.querySelector<HTMLElement>("#panel")!;
  Object.assign(window, { innerWidth: 800, innerHeight: 600, scrollX: 1200, scrollY: 1500 });
  let rect = { x: 200, y: 900, width: 300, height: 200 };
  let revealedRect = { x: 200, y: 100, width: 300, height: 200 };
  let covered = false;
  let connected = true;
  let stale = false;
  const order: string[] = [];
  const scrolls: number[][] = [];
  const wheels: Array<Record<string, unknown>> = [];
  window.scrollBy = ((x: number, y: number) => { scrolls.push([x, y]); Object.assign(window, { scrollX: window.scrollX + x, scrollY: window.scrollY + y }); }) as typeof window.scrollBy;
  panel.getBoundingClientRect = () => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON() {} });
  panel.scrollIntoView = () => { order.push("reveal"); rect = { ...revealedRect }; Object.assign(window, { scrollY: 2300 }); };
  window.document.elementFromPoint = () => covered ? window.document.querySelector("#cover")! : panel;
  let clock = 0;
  window.Date.now = () => clock;
  window.setTimeout = ((callback: () => void) => { clock += 80; queueMicrotask(callback); return 1; }) as unknown as typeof window.setTimeout;
  const state = { connected: () => connected, attached: new Set([1]), dialogs: new Set<number>(), contexts: new Map([[1, new Map([[childFrame ? "child" : "main", { frameId: childFrame ? "child" : "main", documentId: "a", contextId: 1, url: window.location.href }]])]]) };
  const api = {
    tabs: { get: async () => ({ id: 1, url: window.location.href }) },
    debugger: { sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "DOM.getFrameOwner") return { backendNodeId: 10 };
      if (method === "DOM.getBoxModel") return { model: { content: [50, 60, 450, 60, 450, 360, 50, 360] } };
      if (method === "Runtime.evaluate") {
        order.push("evaluate");
        try {
          const value: unknown = await window.eval(String(params.expression));
          if (stale) state.contexts.get(1)!.get(childFrame ? "child" : "main")!.documentId = "b";
          return { result: { value } };
        } catch (error) { return { exceptionDetails: { text: String(error) } }; }
      }
      if (method === "Input.dispatchMouseEvent") { wheels.push(params); return {}; }
      throw new Error(`Unexpected CDP method: ${method}`);
    } }
  };
  return { window, panel, wheels, scrolls, order, close: () => window.close(),
    setRevealedRect: (value: typeof rect) => { revealedRect = value; },
    cover: () => { covered = true; }, disconnect: () => { connected = false; }, stale: () => { stale = true; },
    run: (args: Record<string, unknown>) => performBrowserCommand(api, { method: "scroll", args: { tabId: 1, ...args } }, state) };
}

for (const [x, y] of [[0, 0], [1200, 1500], [0, 5000]]) {
  test(`wheel target stays in viewport at document offset ${x},${y}`, async () => {
    const f = fixture();
    try {
      Object.assign(f.window, { scrollX: x, scrollY: y });
      await f.run({ deltaY: 300, deltaX: -50 });
      assert.deepEqual(f.wheels, [{ type: "mouseWheel", x: 400, y: 300, deltaX: -50, deltaY: 300 }]);
      assert.deepEqual(f.scrolls, [], "target lookup must not scroll the page");
    } finally { f.close(); }
  });
}

test("selector wheel uses revealed element geometry, not changed document offsets", async () => {
  const f = fixture();
  try {
    await f.run({ selector: "#panel", deltaY: -300 });
    assert.ok(f.order.includes("reveal"));
    assert.equal(f.window.scrollY, 2300);
    assert.deepEqual(f.wheels, [{ type: "mouseWheel", x: 350, y: 200, deltaX: 0, deltaY: -300 }]);
    assert.deepEqual(f.scrolls, []);
  } finally { f.close(); }
});

test("occluded selector refuses wheel dispatch", async () => {
  const f = fixture();
  try { f.cover(); await assert.rejects(f.run({ selector: "#panel", deltaY: 300 }), /遮挡/u); assert.deepEqual(f.wheels, []); }
  finally { f.close(); }
});

test("missing or ambiguous selectors do not dispatch", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run({ selector: "#missing", deltaY: 300, timeoutMs: 0 }), /超时/u);
    await assert.rejects(f.run({ selector: "div", deltaY: 300 }), /多个/u);
    assert.deepEqual(f.wheels, []);
  } finally { f.close(); }
});

test("invalid distance, disconnected and stale document fail before wheel input", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run({ deltaY: 10001 }), /距离/u);
    f.stale(); await assert.rejects(f.run({ deltaY: 300 }), /文档/u);
    f.disconnect(); await assert.rejects(f.run({ deltaY: 300 }), /中断/u);
    assert.deepEqual(f.wheels, []);
  } finally { f.close(); }
});

test("shared IAB scroll keeps pixel delta mutation and resulting document offsets", async () => {
  const f = fixture();
  try {
    const run = f.window.eval(`(${pageOperation.toString()})`);
    assert.equal(typeof run, "function");
    if (typeof run !== "function") throw new Error("Expected page function");
    const result: { x: number; y: number } = await run("scroll", { x: -100, y: 200 });
    assert.deepEqual({ ...result }, { x: 1100, y: 1700 });
    assert.deepEqual(f.scrolls, [[-100, 200]]);
  } finally { f.close(); }
});

for (const selector of [undefined, "#panel"]) {
  test(`same-process child frame wheel maps viewport coordinates: ${selector ?? "default"}`, async () => {
    const f = fixture(true);
    try {
      await f.run({ frameId: "child", documentId: "a", selector, deltaY: 300 });
      assert.deepEqual(f.wheels, [{ type: "mouseWheel", x: selector ? 225 : 250, y: selector ? 160 : 210, deltaX: 0, deltaY: 300 }]);
      assert.deepEqual(f.scrolls, []);
    } finally { f.close(); }
  });
}

test("selector crossing right and bottom edges uses its visible viewport portion", async () => {
  const f = fixture();
  try {
    f.setRevealedRect({ x: 700, y: 550, width: 300, height: 200 });
    await f.run({ selector: "#panel", deltaY: 300 });
    assert.deepEqual(f.wheels, [{ type: "mouseWheel", x: 750, y: 575, deltaX: 0, deltaY: 300 }]);
    assert.deepEqual(f.scrolls, []);
  } finally { f.close(); }
});
