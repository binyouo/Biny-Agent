/** Complete page program in JSDOM; controlled geometry/hit tests are not native browser acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageOperation } from "../src/browser-extension/page.js";
import { browserLocatorActionSchema, browserLocatorReadSchema } from "../src/browser/locatorSchema.js";

function fixture(html: string) {
  const dom = new JSDOM(html, { url: "https://example.test/", runScripts: "outside-only" });
  const { window } = dom;
  Object.assign(window, { CSS: { escape: (value: string) => value } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value() {
    return { x: 10, y: 20, width: 100, height: 24, left: 10, right: 110, top: 20, bottom: 44 };
  } });
  const run = window.eval(`(${pageOperation.toString()})`) as typeof pageOperation;
  return { window, run, close: () => window.close() };
}
const readArgs = (role: string, name = "Country") => browserLocatorReadSchema.parse({
  steps: [{ m: "getByRole", role, name, exact: true }], action: { m: "count" }
});

for (const [attributes, expected] of [
  ["", "combobox"], ['size="0"', "combobox"], ['size="1"', "combobox"],
  ['size="2"', "listbox"], ['size="5"', "listbox"],
  ["multiple", "listbox"], ['multiple size="1"', "listbox"],
  ['size="5" role="combobox"', "combobox"], ['size="1" role="listbox"', "listbox"]
] as const) {
  test(`select ${attributes || "with omitted size"} exposes ${expected} in locators and snapshots`, async () => {
    const f = fixture(`<label for="control">Country</label><select id="control" ${attributes}><option value="fr">France</option></select>`);
    try {
      assert.equal(await f.run("locator_read", readArgs(expected)), 1);
      assert.equal(await f.run("locator_read", readArgs(expected === "listbox" ? "combobox" : "listbox")), 0);
      assert.equal(await f.run("wait", { selector: `role=${expected}|Country`, state: "attached", timeoutMs: 0 }), true);
      assert.equal((await f.run("read", {})).interactive[0].role, expected);
      assert.equal((await f.run("dom_snapshot", {})).elements[0].role, expected);
    } finally { f.close(); }
  });
}

test("role-based listbox target actually selects an option without touching the adjacent combobox", async () => {
  const f = fixture('<select id="dropdown" aria-label="Country"><option value="fr">France</option><option value="jp">Japan</option></select><select id="list" aria-label="Country" size="5"><option value="fr">France</option><option value="jp">Japan</option></select>');
  try {
    const args = browserLocatorActionSchema.parse({ steps: [{ m: "getByRole", role: "listbox", name: "Country", exact: true }], action: { m: "selectOption", values: ["jp"] } });
    const target = await f.run("locator_target", { steps: args.steps });
    assert.equal(target.selector, "#list");
    const list = f.window.document.getElementById("list") as HTMLSelectElement;
    Object.defineProperty(f.window.document, "elementFromPoint", { value: () => list });
    const events: string[] = [];
    for (const type of ["input", "change"]) list.addEventListener(type, () => events.push(type));
    const result = await f.run("select_option", { selector: target.selector, values: args.action.m === "selectOption" ? args.action.values : [] });
    assert.deepEqual(Array.from(result.values), ["jp"]);
    assert.equal(list.value, "jp");
    assert.equal((f.window.document.getElementById("dropdown") as HTMLSelectElement).value, "fr");
    assert.deepEqual(events, ["input", "change"]);
    assert.equal((await f.run("locator_target", { steps: readArgs("combobox").steps })).selector, "#dropdown");
  } finally { f.close(); }
});

test("dynamic size changes invalidate old DOM identity and update role lookups", async () => {
  const f = fixture('<select id="control" aria-label="Country" size="1"><option>France</option></select>');
  try {
    const select = f.window.document.getElementById("control") as HTMLSelectElement;
    const before = (await f.run("dom_snapshot", {})).elements[0];
    select.size = 4;
    await assert.rejects(f.run("dom_target", { selector: "#control", expected: before }), /失效/u);
    assert.equal(await f.run("locator_read", readArgs("listbox")), 1);
    const after = (await f.run("dom_snapshot", {})).elements[0];
    assert.equal((await f.run("dom_target", { selector: "#control", expected: after })).selector, "#control");
    select.removeAttribute("size");
    await assert.rejects(f.run("dom_target", { selector: "#control", expected: after }), /失效/u);
    assert.equal(await f.run("locator_read", readArgs("combobox")), 1);
  } finally { f.close(); }
});

test("disabled sized selects remain readable but cannot become action targets", async () => {
  const f = fixture('<select id="control" aria-label="Country" size="3" disabled><option>France</option></select>');
  try {
    const args = readArgs("listbox");
    assert.equal(await f.run("locator_read", args), 1);
    assert.equal(await f.run("locator_read", { steps: args.steps, action: { m: "isEnabled" } }), false);
    await assert.rejects(f.run("locator_target", { steps: args.steps }), /不可操作/u);
  } finally { f.close(); }
});

test("open shadow listbox supports role targeting and scoped semantic selector", async () => {
  const f = fixture('<main id="scope"><div id="host"></div></main>');
  try {
    const host = f.window.document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<label for="control">Country</label><select id="control" size="2"><option value="fr">France</option><option value="jp">Japan</option></select>';
    const select = shadow.getElementById("control") as HTMLSelectElement;
    const target = await f.run("locator_target", { steps: readArgs("listbox").steps });
    assert.equal(target.selector, "#host >>> #control");
    Object.defineProperty(shadow, "elementFromPoint", { value: () => select });
    Object.defineProperty(f.window.document, "elementFromPoint", { value: () => host });
    await f.run("select_option", { selector: target.selector, values: ["jp"] });
    assert.equal(select.value, "jp");
    assert.equal(await f.run("locator_read", { steps: [{ m: "locator", selector: "#scope" }, { m: "locator", selector: "role=listbox|Country" }], action: { m: "count" } }), 1);
  } finally { f.close(); }
});

test("genuine listbox duplicates still require an explicit refiner", async () => {
  const f = fixture('<select id="one" aria-label="Country" size="2"><option>France</option></select><select id="two" aria-label="Country" size="4"><option>Japan</option></select>');
  try {
    const args = readArgs("listbox");
    assert.equal(await f.run("locator_read", args), 2);
    await assert.rejects(f.run("locator_target", { steps: args.steps }), /唯一匹配/u);
    assert.equal((await f.run("locator_target", { steps: [...args.steps, { m: "nth", index: 1 }] })).selector, "#two");
  } finally { f.close(); }
});
