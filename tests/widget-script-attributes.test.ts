import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createWidgetDocument } from "../src/widgets/document.js";

const require = createRequire(import.meta.url);
const morphdomSource = readFileSync(path.join(path.dirname(require.resolve("morphdom")), "morphdom-umd.min.js"), "utf8");
const token = "script-attributes-test";

for (const historical of [false, true]) test(`${historical ? "historical" : "streamed"} widgets preserve script data blocks and execution metadata`, () => {
  const html = '<output id="total">pending</output><script type="application/json" id="chart-data">{"total":42}</script><script id="draw-chart" data-unit="items">window.runs=(window.runs||0)+1;const data=document.getElementById("chart-data");document.getElementById("total").textContent=data ? JSON.parse(data.textContent).total : "missing-data";window.metadata={id:document.currentScript.id,unit:document.currentScript.dataset.unit};</script>';
  const dom = new JSDOM(createWidgetDocument({ token, morphdomSource, ...(historical ? { widget: { title: "Chart", html } } : {}) }), { runScripts: "dangerously" });
  const win = dom.window;
  const send = (revision: number, complete: boolean) => win.dispatchEvent(new win.MessageEvent("message", { source: win.parent, data: { type: "set-content", token, revision, html, complete } }));
  try {
    if (!historical) {
      send(1, false);
      assert.equal(win.runs, undefined);
      assert.equal(win.document.getElementById("total")?.textContent, "pending");
      assert.equal(win.document.getElementById("chart-data")?.getAttribute("type"), "text/widget-inert");
      send(2, true);
    }
    assert.equal(win.document.getElementById("total")?.textContent, "42");
    assert.equal(win.document.getElementById("chart-data")?.getAttribute("type"), "application/json");
    assert.equal(win.metadata.id, "draw-chart");
    assert.equal(win.metadata.unit, "items");
    assert.equal(win.document.querySelector("script[data-widget-type]"), null);
    assert.equal(win.runs, 1);
    send(3, true);
    assert.equal(win.runs, 1);
  } finally { win.close(); }
});

test("script activation keeps remote sources inert and preserves existing attribute filtering", async () => {
  const html = '<script src="https://example.invalid/not-loaded.js" id="remote">window.remoteRan=true</script><script id="local" data-unsafe="javascript:alert(1)" data-label="safe">window.localRan=(window.localRan||0)+1</script>';
  const dom = new JSDOM(createWidgetDocument({ token, morphdomSource }), { runScripts: "dangerously" });
  const win = dom.window;
  const errorMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = win.setTimeout(() => reject(new Error("Expected remote script rejection message")), 1_000);
    win.addEventListener("message", event => {
      if (event.data?.type === "widget-error") { win.clearTimeout(timer); resolve(event.data); }
    });
  });
  try {
    win.dispatchEvent(new win.MessageEvent("message", { source: win.parent, data: { type: "set-content", token, revision: 1, html, complete: true } }));
    const error = await errorMessage;
    assert.equal(win.remoteRan, undefined);
    assert.equal(win.document.getElementById("remote")?.getAttribute("type"), "text/widget-inert");
    assert.equal(win.localRan, 1);
    assert.equal(win.document.getElementById("local")?.getAttribute("data-label"), "safe");
    assert.equal(win.document.getElementById("local")?.hasAttribute("data-unsafe"), false);
    assert.equal(error.message, "不支持远程脚本，请使用内联脚本。");
  } finally { win.close(); }
});
