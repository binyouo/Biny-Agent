/** Complete serialized page operation; geometry/hit testing are controlled, not native-browser acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageOperation } from "../src/browser-extension/page.js";

function fixture(markup: string) {
  const dom = new JSDOM(markup, { url: "https://example.test/", runScripts: "outside-only" });
  const { window } = dom;
  const select = window.document.querySelector("select")!;
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value() {
    return { x: 10, y: 20, width: 100, height: 24, left: 10, right: 110, top: 20, bottom: 44 };
  } });
  Object.defineProperty(window.document, "elementFromPoint", { value: () => select, configurable: true });
  const events: string[] = [];
  for (const kind of ["input", "change"]) select.addEventListener(kind, () => events.push(kind));
  const run = window.eval(`(${pageOperation.toString()})`) as typeof pageOperation;
  const values = () => [...select.selectedOptions].map(option => option.value);
  return { window, select, events, values, run, close: () => window.close() };
}

for (const [label, option] of [
  ["directly disabled", '<option value="blocked" disabled>Blocked</option>'],
  ["disabled group", '<optgroup disabled><option value="blocked">Blocked</option></optgroup>'],
  ["both disabled", '<optgroup disabled><option value="blocked" disabled>Blocked</option></optgroup>']
] as const) {
  for (const multiple of [false, true]) {
    test(`${label} selection is rejected atomically (${multiple ? "multiple" : "single"})`, async () => {
      const f = fixture(`<select id="target" ${multiple ? "multiple" : ""}><option value="before" selected>Before</option><option value="enabled">Enabled</option>${option}</select>`);
      try {
        await assert.rejects(f.run("select_option", { selector: "#target", values: multiple ? ["enabled", "blocked"] : ["blocked"] }), /选项不可操作/u);
        assert.deepEqual(f.values(), ["before"]);
        assert.deepEqual(f.events, []);
      } finally { f.close(); }
    });
  }
}

test("same-value disabled options cannot be silently selected beside an enabled duplicate", async () => {
  const f = fixture('<select id="target" multiple><option value="before" selected>Before</option><option value="x">Enabled X</option><option value="x" disabled>Disabled X</option></select>');
  try {
    await assert.rejects(f.run("select_option", { selector: "#target", values: ["x"] }), /选项不可操作/u);
    assert.deepEqual(f.values(), ["before"]); assert.deepEqual(f.events, []);
  } finally { f.close(); }
});

test("disabled selected option cannot be requested again", async () => {
  const f = fixture('<select id="target"><option value="blocked" selected disabled>Blocked</option><option value="ok">OK</option></select>');
  try {
    await assert.rejects(f.run("select_option", { selector: "#target", values: ["blocked"] }), /选项不可操作/u);
    assert.deepEqual(f.values(), ["blocked"]); assert.deepEqual(f.events, []);
  } finally { f.close(); }
});

test("enabled option selection may deselect an old disabled option", async () => {
  const f = fixture('<select id="target"><option value="blocked" selected disabled>Blocked</option><optgroup><option value="ok">OK</option></optgroup></select>');
  try {
    assert.deepEqual(Array.from((await f.run("select_option", { selector: "#target", values: ["ok"] })).values), ["ok"]);
    assert.deepEqual(f.values(), ["ok"]); assert.deepEqual(f.events, ["input", "change"]);
  } finally { f.close(); }
});

test("enabled multiselect still selects exact requested values and dispatches once", async () => {
  const f = fixture('<select id="target" multiple><option value="before" selected>Before</option><option value="one">One</option><optgroup><option value="two">Two</option><option value="blocked" disabled>Blocked</option></optgroup></select>');
  try {
    await f.run("select_option", { selector: "#target", values: ["two", "one"] });
    assert.deepEqual(f.values(), ["one", "two"]); assert.deepEqual(f.events, ["input", "change"]);
  } finally { f.close(); }
});

test("current disabled state is rechecked on each invocation", async () => {
  const f = fixture('<select id="target"><option value="before" selected>Before</option><optgroup><option value="x">X</option></optgroup></select>');
  try {
    const group = f.window.document.querySelector("optgroup")!;
    group.disabled = true;
    await assert.rejects(f.run("select_option", { selector: "#target", values: ["x"] }), /选项不可操作/u);
    assert.deepEqual(f.values(), ["before"]); assert.deepEqual(f.events, []);
    group.disabled = false;
    await f.run("select_option", { selector: "#target", values: ["x"] });
    assert.deepEqual(f.values(), ["x"]); assert.deepEqual(f.events, ["input", "change"]);
  } finally { f.close(); }
});

test("missing values and disabled select retain their existing rejection paths", async () => {
  const f = fixture('<select id="target"><option value="before" selected>Before</option></select>');
  try {
    await assert.rejects(f.run("select_option", { selector: "#target", values: ["missing"] }), /找不到/u);
    f.select.disabled = true;
    await assert.rejects(f.run("select_option", { selector: "#target", values: ["before"] }), /元素不可操作/u);
    assert.deepEqual(f.values(), ["before"]); assert.deepEqual(f.events, []);
  } finally { f.close(); }
});

test("open Shadow DOM selection rejects disabled options without events and allows enabled ones", async () => {
  const f = fixture('<div id="host"></div><select id="target"><option value="before" selected>Before</option><optgroup disabled><option value="blocked">Blocked</option></optgroup><option value="ok">OK</option></select>');
  try {
    const host = f.window.document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(f.select);
    Object.defineProperty(shadow, "elementFromPoint", { value: () => f.select });
    // Each root's hit result is controlled; actual shadow-tree selectors and ancestry execute.
    Object.defineProperty(f.window.document, "elementFromPoint", { value: () => host, configurable: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.run("select_option", { selector: "#host >>> #target", values: ["blocked"] }), /选项不可操作/u);
      assert.deepEqual(f.values(), ["before"]); assert.deepEqual(f.events, []);
    }
    await f.run("select_option", { selector: "#host >>> #target", values: ["ok"] });
    assert.deepEqual(f.values(), ["ok"]); assert.deepEqual(f.events, ["input", "change"]);
  } finally { f.close(); }
});

test("disabled fieldset continues rejecting its select before any selection mutation", async () => {
  const f = fixture('<fieldset disabled><select id="target"><option value="before" selected>Before</option><option value="ok">OK</option></select></fieldset>');
  try {
    await assert.rejects(f.run("select_option", { selector: "#target", values: ["ok"] }), /元素不可操作/u);
    assert.deepEqual(f.values(), ["before"]); assert.deepEqual(f.events, []);
  } finally { f.close(); }
});

test("select within a disabled fieldset first legend remains enabled", async () => {
  const f = fixture('<fieldset disabled><legend><select id="target"><option value="before" selected>Before</option><option value="ok">OK</option></select></legend></fieldset>');
  try {
    await f.run("select_option", { selector: "#target", values: ["ok"] });
    assert.deepEqual(f.values(), ["ok"]); assert.deepEqual(f.events, ["input", "change"]);
  } finally { f.close(); }
});

test("invalid option argument shapes preserve rejection and selection state", async () => {
  const f = fixture('<select id="target"><option value="before" selected>Before</option><option value="ok">OK</option></select>');
  try {
    for (const values of [null, undefined, "ok", [], ["before", "ok"], [7], ["missing"]]) {
      await assert.rejects(f.run("select_option", { selector: "#target", values }), /选项值无效|找不到/u);
      assert.deepEqual(f.values(), ["before"]); assert.deepEqual(f.events, []);
    }
  } finally { f.close(); }
});
