import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createWidgetDocument, readWidgetMessage } from "../src/widgets/document.js";
import { parseWidgetPreview } from "../src/widgets/widget.js";

const require = createRequire(import.meta.url);
const morphdomSource = await readFile(path.join(path.dirname(require.resolve("morphdom")), "morphdom-umd.min.js"), "utf8");
const token = "widget-test";
test("流式 HTML 增量保留已有节点，完成后脚本只运行一次", () => {
  const html = '<input id="value" type="range"><output id="result">4</output><button onclick="window.leaked=true">run</button><script>window.runs=(window.runs||0)+1;window.square=n=>{document.getElementById("result").textContent=n*n};</script>';
  const dom = new JSDOM(createWidgetDocument({ token, morphdomSource }), { runScripts: "dangerously" });
  const win = dom.window;
  const send = (source: unknown, data: unknown) => win.dispatchEvent(new win.MessageEvent("message", { source: source as Window, data }));
  try {
    send(win.parent, { type: "set-content", token: "wrong", revision: 1, html, complete: true });
    assert.equal(win.document.getElementById("value"), null);
    send(win.parent, { type: "set-content", token, revision: 1, html, complete: false });
    const input = win.document.getElementById("value");
    assert.ok(input);
    assert.equal(win.document.querySelector("button")?.hasAttribute("onclick"), false);
    assert.equal(win.runs, undefined);
    send(win.parent, { type: "set-content", token, revision: 2, html: html.replace(">4<", ">5<"), complete: false });
    assert.equal(win.document.getElementById("value"), input);
    send(win.parent, { type: "set-content", token, revision: 1, html: "stale", complete: false });
    assert.equal(win.document.querySelector("output")?.textContent, "5");
    send(win.parent, { type: "set-content", token, revision: 3, html, complete: true });
    assert.equal(win.runs, 1);
    win.square(7);
    assert.equal(win.document.querySelector("output")?.textContent, "49");
    send(win.parent, { type: "set-content", token, revision: 4, html, complete: true });
    assert.equal(win.runs, 1);
    assert.equal(win.document.querySelector("output")?.textContent, "49");
    assert.match(win.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "", /connect-src 'none'/);
    assert.equal(win.biny, undefined);
  } finally { win.close(); }
});
test("历史产物初始化脚本、主题更新保持交互状态，消息只接受有界协议", () => {
  const dom = new JSDOM(createWidgetDocument({ token, morphdomSource, widget: { title: "history", html: '<output id="result">1</output><script>window.runs=(window.runs||0)+1</script>' } }), { runScripts: "dangerously" });
  try {
    assert.equal(dom.window.runs, 1);
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window.parent, data: { type: "set-theme", token, css: ":root{--primary:#123456}", dark: true } }));
    assert.equal(dom.window.document.documentElement.dataset.theme, "dark");
    assert.equal(dom.window.runs, 1);
  } finally { dom.window.close(); }
  assert.equal(readWidgetMessage({ type: "widget-resize", token, height: Infinity }, token), undefined);
  assert.deepEqual(readWidgetMessage({ type: "widget-resize", token, height: 99_999 }, token), { type: "widget-resize", height: 4_000 });
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.com"]) assert.equal(readWidgetMessage({ type: "open-link", token, url }, token), undefined);
  assert.equal(readWidgetMessage({ type: "send-prompt", token, text: "x".repeat(8_001) }, token), undefined);
  assert.deepEqual(parseWidgetPreview('{"title":"平方","html":"<output>\\u4e2d'), { title: "平方", html: "<output>中", description: undefined });
});
