/** Full page program in DOM; geometry is controlled, not native-browser acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageOperation } from "../src/browser-extension/page.js";

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

for (const [type, role, label] of [["number", "spinbutton", "Quantity"], ["range", "slider", "Volume"]] as const) {
  test(`${type} is addressable by its implicit role through locator and semantic selector`, async () => {
    const f = fixture(`<label for="control">${label}</label><input id="control" type="${type}" value="4">`);
    try {
      const steps = [{ m: "getByRole", role, name: label, exact: true }];
      assert.equal(await f.run("locator_read", { steps, action: { m: "count" } }), 1);
      assert.equal(await f.run("locator_read", { steps, action: { m: "getAttribute", name: "id" } }), "control");
      assert.equal((await f.run("locator_target", { steps })).selector, "#control");
      assert.equal(await f.run("wait", { selector: `role=${role}|${label}`, state: "attached", timeoutMs: 0 }), true);
    } finally { f.close(); }
  });
  test(`${type} appears with the correct role in read and DOM snapshot identities`, async () => {
    const f = fixture(`<input id="control" type="${type}" aria-label="${label}">`);
    try {
      const read = await f.run("read", {});
      assert.equal(read.interactive[0].role, role);
      const snapshot = await f.run("dom_snapshot", {});
      assert.equal(snapshot.elements[0].role, role);
      assert.equal((await f.run("dom_target", { selector: "#control", expected: snapshot.elements[0] })).selector, "#control");
      f.window.document.getElementById("control")!.setAttribute("type", "text");
      await assert.rejects(f.run("dom_target", { selector: "#control", expected: snapshot.elements[0] }), /失效/u);
    } finally { f.close(); }
  });
  test(`${type} genuine duplicates remain strict and can be scoped or refined`, async () => {
    const f = fixture(`<section id="one"><input id="a" type="${type}" aria-label="${label}"></section><input id="b" type="${type}" aria-label="${label}">`);
    try {
      const steps = [{ m: "getByRole", role, name: label }];
      assert.equal(await f.run("locator_read", { steps, action: { m: "count" } }), 2);
      await assert.rejects(f.run("locator_target", { steps }), /唯一匹配/u);
      assert.equal((await f.run("locator_target", { steps: [...steps, { m: "nth", index: 1 }] })).selector, "#b");
      assert.equal((await f.run("locator_target", { steps: [{ m: "locator", selector: "#one" }, ...steps] })).selector, "#a");
    } finally { f.close(); }
  });
  test(`${type} respects explicit role overrides and disabled action guards`, async () => {
    const f = fixture(`<input id="override" type="${type}" role="textbox"><input id="disabled" type="${type}" disabled>`);
    try {
      assert.equal((await f.run("locator_target", { steps: [{ m: "getByRole", role: "textbox" }] })).selector, "#override");
      const steps = [{ m: "getByRole", role }];
      assert.equal(await f.run("locator_read", { steps, action: { m: "isEnabled" } }), false);
      await assert.rejects(f.run("locator_target", { steps }), /不可操作/u);
    } finally { f.close(); }
  });
}

test("numeric controls no longer make a genuine textbox ambiguous", async () => {
  const f = fixture('<input id="name"><input type="number"><input type="range">');
  try {
    const steps = [{ m: "getByRole", role: "textbox" }];
    assert.equal(await f.run("locator_read", { steps, action: { m: "count" } }), 1);
    assert.equal((await f.run("locator_target", { steps })).selector, "#name");
  } finally { f.close(); }
});

test("numeric role lookup traverses open Shadow DOM and re-reads changed input types", async () => {
  const f = fixture('<div id="host"></div>');
  try {
    const shadow = f.window.document.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input id="control" type="number" aria-label="Amount">';
    const steps = [{ m: "getByRole", role: "spinbutton", name: "Amount" }];
    assert.equal((await f.run("locator_target", { steps })).selector, "#host >>> #control");
    shadow.querySelector("input")!.type = "range";
    assert.equal(await f.run("locator_read", { steps, action: { m: "count" } }), 0);
    assert.equal((await f.run("locator_target", { steps: [{ m: "getByRole", role: "slider", name: "Amount" }] })).selector, "#host >>> #control");
  } finally { f.close(); }
});

test("existing explicit roles and other supported implicit input mappings stay unchanged", async () => {
  const f = fixture('<input type="checkbox"><input type="radio"><input type="button"><input type="submit"><input type="reset"><input type="search"><textarea></textarea>');
  try {
    for (const [role, count] of [["checkbox", 1], ["radio", 1], ["button", 3], ["searchbox", 1], ["textbox", 1], ["spinbutton", 0], ["slider", 0]] as const) {
      assert.equal(await f.run("locator_read", { steps: [{ m: "getByRole", role }], action: { m: "count" } }), count);
    }
  } finally { f.close(); }
});
