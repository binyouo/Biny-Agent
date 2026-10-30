/** Complete page program in JSDOM; geometry is controlled, not native browser input. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageOperation } from "../src/browser-extension/page.js";

type Step = { m: string; [key: string]: unknown };
function fixture(html: string) {
  const dom = new JSDOM(html, { url: "https://example.test/", runScripts: "outside-only" });
  const { window } = dom;
  Object.assign(window, { CSS: { escape: (value: string) => value } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    value() { return this.id === "hidden" ? { x: 0, y: 0, width: 0, height: 0 } : { x: 10, y: 20, width: 100, height: 30 }; }
  });
  const run = window.eval(`(${pageOperation.toString()})`) as (operation: string, args: Record<string, unknown>) => Promise<unknown>;
  return {
    window, close: () => window.close(),
    read: (steps: Step[], action: Record<string, unknown>) => run("locator_read", { steps, action }),
    target: async (steps: Step[]) => (await run("locator_target", { steps }) as { selector: string }).selector,
    run
  };
}
const text = (value: string, exact = false): Step => ({ m: "getByText", text: value, exact });

for (const exact of [false, true]) test(`one text target is not duplicated by html/body/container ancestors (exact=${exact})`, async () => {
  const f = fixture('<main><section><button id="save">Save</button></section></main>');
  try {
    assert.equal(await f.read([text("Save", exact)], { m: "count" }), 1);
    assert.equal(await f.target([text("Save", exact)]), "#save");
    assert.equal(await f.read([text("Save", exact), { m: "first" }], { m: "getAttribute", name: "id" }), "save");
    assert.equal(await f.read([text("Save", exact)], { m: "waitFor", state: "attached", timeoutMs: 0 }), true);
  } finally { f.close(); }
});

test("the documented Saved textContent query reads its single status element", async () => {
  const f = fixture('<div id="status">Saved</div>');
  try {
    assert.equal(await f.read([text("Saved")], { m: "textContent" }), "Saved");
    assert.equal(await f.read([text("Saved")], { m: "getAttribute", name: "id" }), "status");
  } finally { f.close(); }
});

test("a parent whose combined text matches remains when neither child matches", async () => {
  const f = fixture('<div><button id="save"><span>Save</span> <span>now</span></button></div>');
  try {
    assert.equal(await f.target([text("Save now", true)]), "#save");
    assert.equal(await f.read([text("Save now")], { m: "count" }), 1);
  } finally { f.close(); }
});

test("nested matching descendants are selected instead of their containing wrappers", async () => {
  const f = fixture('<button><span><em id="label">Save</em></span></button>');
  try {
    assert.equal(await f.read([text("Save")], { m: "count" }), 1);
    assert.equal(await f.target([text("Save")]), "#label");
  } finally { f.close(); }
});

test("genuine duplicate targets remain ambiguous and explicit refiners retain DOM order", async () => {
  const f = fixture('<section><button id="first">Save</button></section><section><button id="second">Save</button></section>');
  try {
    assert.equal(await f.read([text("Save")], { m: "count" }), 2);
    await assert.rejects(f.target([text("Save")]), /唯一匹配/u);
    assert.equal(await f.target([text("Save"), { m: "first" }]), "#first");
    assert.equal(await f.target([text("Save"), { m: "nth", index: 1 }]), "#second");
    assert.equal(await f.target([text("Save"), { m: "last" }]), "#second");
  } finally { f.close(); }
});

test("scoped text lookup does not escape the selected container", async () => {
  const f = fixture('<div id="left"><section><button id="one">Save</button></section></div><div id="right"><section><button id="two">Save</button></section></div>');
  try {
    assert.equal(await f.target([{ m: "locator", selector: "#right" }, text("Save")]), "#two");
    assert.equal(await f.read([{ m: "locator", selector: "#left" }, text("Save")], { m: "count" }), 1);
  } finally { f.close(); }
});

test("filter hasText continues to retain containers and role chains remain unchanged", async () => {
  const f = fixture('<section class="card"><p>Alpha</p><button id="one">Save</button></section><section class="card"><p>Beta</p><button id="two">Save</button></section>');
  try {
    assert.equal(await f.target([{ m: "locator", selector: ".card" }, { m: "filter", hasText: "Beta" }, { m: "getByRole", role: "button" }]), "#two");
    assert.equal(await f.read([{ m: "getByRole", role: "button", name: "Save" }], { m: "count" }), 2);
  } finally { f.close(); }
});

test("open shadow roots retain their unique text target and shadow selector path", async () => {
  const f = fixture('<div id="host"></div>');
  try {
    f.window.document.getElementById("host")!.attachShadow({ mode: "open" }).innerHTML = '<section><button id="save">Save</button></section>';
    assert.equal(await f.read([text("Save")], { m: "count" }), 1);
    assert.equal(await f.target([text("Save")]), "#host >>> #save");
  } finally { f.close(); }
});

test("exact and substring queries keep whitespace normalization and Unicode text", async () => {
  const f = fixture('<div><p id="status">  已保存\n  🙂 完成 </p></div>');
  try {
    assert.equal(await f.target([text("已保存 🙂 完成", true)]), "#status");
    assert.equal(await f.target([text("🙂")]), "#status");
    assert.equal(await f.read([text("已保存", true)], { m: "count" }), 0);
  } finally { f.close(); }
});

test("no match retains count, visibility and detached-wait behavior", async () => {
  const f = fixture('<p>Other</p>');
  try {
    assert.equal(await f.read([text("Missing")], { m: "count" }), 0);
    assert.equal(await f.read([text("Missing")], { m: "isVisible" }), false);
    assert.equal(await f.read([text("Missing")], { m: "waitFor", state: "detached", timeoutMs: 0 }), true);
    await assert.rejects(f.target([text("Missing")]), /唯一匹配/u);
  } finally { f.close(); }
});

test("disabled and zero-geometry matching elements remain non-actionable", async () => {
  const f = fixture('<button disabled id="disabled">Disabled</button><p id="hidden">Hidden</p>');
  try {
    assert.equal(await f.read([text("Disabled")], { m: "isEnabled" }), false);
    assert.equal(await f.read([text("Hidden")], { m: "isVisible" }), false);
    await assert.rejects(f.target([text("Disabled")]), /不可操作/u);
    await assert.rejects(f.target([text("Hidden")]), /不可操作/u);
  } finally { f.close(); }
});

test("fresh queries observe replacement DOM and newly introduced real duplicates", async () => {
  const f = fixture('<div id="container"><p id="old">Saved</p></div>');
  try {
    assert.equal(await f.target([text("Saved")]), "#old");
    f.window.document.getElementById("container")!.innerHTML = '<p id="new">Saved</p>';
    assert.equal(await f.target([text("Saved")]), "#new");
    f.window.document.getElementById("container")!.insertAdjacentHTML("beforeend", '<p>Saved</p>');
    assert.equal(await f.read([text("Saved")], { m: "count" }), 2);
    await assert.rejects(f.target([text("Saved")]), /唯一匹配/u);
  } finally { f.close(); }
});

test("the independent exact text selector retains its existing leaf matching", async () => {
  const f = fixture('<div><p id="saved">Saved</p></div>');
  try {
    assert.equal(await f.read([{ m: "locator", selector: "text=Saved" }], { m: "count" }), 1);
    assert.equal(await f.target([{ m: "locator", selector: "text=Saved" }]), "#saved");
  } finally { f.close(); }
});
