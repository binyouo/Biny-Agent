/** Full shared page program in a synthetic DOM; not native accessibility-tree acceptance. */
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

for (const [description, markup, expected] of [
  ["referenced text beats aria-label", '<span id="label">Save changes</span><button id="target" aria-labelledby="label" aria-label="Old label">Save</button>', "Save changes"],
  ["ordered references skip missing IDs", '<span id="first">Changes</span><span id="second">Save</span><button id="target" aria-labelledby="second missing first" aria-label="Old label">Save</button>', "Save Changes"],
  ["empty reference is still a valid name source", '<span id="label"></span><button id="target" aria-labelledby="label" aria-label="Old label">Save</button>', ""],
  ["whitespace-only reference remains empty", '<span id="label"> \n </span><button id="target" aria-labelledby="label" aria-label="Old label">Save</button>', ""],
  ["missing references fall back to aria-label", '<button id="target" aria-labelledby="missing" aria-label="Fallback">Save</button>', "Fallback"],
  ["empty ID list falls back to aria-label", '<button id="target" aria-labelledby="  " aria-label="Fallback">Save</button>', "Fallback"],
  ["aria-label alone is retained", '<button id="target" aria-label="Fallback">Save</button>', "Fallback"],
  ["native labels remain the fallback", '<label for="target">Native name</label><input id="target" aria-labelledby="missing">', "Native name"],
  ["self-reference preserves own aria-label", '<button id="target" aria-labelledby="target" aria-label="Delete"></button>', "Delete"],
  ["self-reference composes with other text", '<span id="file">Document.txt</span><button id="target" aria-labelledby="target file" aria-label="Delete"></button>', "Delete Document.txt"],
  ["directly referenced aria-label wins over its text", '<span id="label" aria-label="Replacement">Old</span><button id="target" aria-labelledby="label" aria-label="Root label"></button>', "Replacement"],
  ["blank referenced aria-label falls back to text", '<span id="label" aria-label="  ">Visible name</span><button id="target" aria-labelledby="label" aria-label="Root label"></button>', "Visible name"],
] as const) {
  test(description, async () => {
    const f = fixture(markup);
    try {
      const snapshot = await f.run("dom_snapshot", {});
      const target = snapshot.elements.find((node: { selector: string }) => node.selector === "#target");
      assert.equal(target?.name, expected);
      assert.equal((await f.run("read", {})).interactive.find((node: { selector: string }) => node.selector === "#target")?.name, expected);
      const steps = [{ m: "getByRole", role: markup.includes("<input") ? "textbox" : "button", name: expected, exact: true }];
      assert.equal(await f.run("locator_read", { steps, action: { m: "count" } }), 1);
      assert.equal((await f.run("locator_target", { steps })).selector, "#target");
      assert.equal(await f.run("wait", { selector: `role=${steps[0]!.role}|${expected}`, state: "attached", timeoutMs: 0 }), true);
      assert.equal(await f.run("locator_read", { steps: [{ m: "getByLabel", label: expected }], action: { m: "count" } }), 1);
      assert.equal((await f.run("dom_target", { selector: "#target", expected: target })).selector, "#target");
    } finally { f.close(); }
  });
}

test("name changes invalidate captured DOM identities", async () => {
  const f = fixture('<span id="label">Before</span><button id="target" aria-labelledby="label" aria-label="Unchanged"></button>');
  try {
    const expected = (await f.run("dom_snapshot", {})).elements[0];
    f.window.document.getElementById("label")!.textContent = "After";
    await assert.rejects(f.run("dom_target", { selector: "#target", expected }), /失效/u);
  } finally { f.close(); }
});

test("open Shadow DOM resolves local label before document label", async () => {
  const f = fixture('<span id="label">Outside</span><div id="host"></div>');
  try {
    const root = f.window.document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = '<span id="label">Inside</span><button id="target" aria-labelledby="label" aria-label="Old"></button>';
    const steps = [{ m: "getByRole", role: "button", name: "Inside", exact: true }];
    assert.equal((await f.run("locator_target", { steps })).selector, "#host >>> #target");
  } finally { f.close(); }
});


test("correct names do not bypass disabled guards or duplicate matching", async () => {
  const f = fixture('<span id="label">Save</span><button id="target" disabled aria-labelledby="label" aria-label="Wrong"></button>');
  try {
    const steps = [{ m: "getByRole", role: "button", name: "Save", exact: true }];
    assert.equal(await f.run("locator_read", { steps, action: { m: "isEnabled" } }), false);
    await assert.rejects(f.run("locator_target", { steps }), /不可操作/u);
    f.window.document.getElementById("target")!.removeAttribute("disabled");
    f.window.document.body.insertAdjacentHTML("beforeend", '<button aria-labelledby="label" aria-label="Other"></button>');
    assert.equal(await f.run("locator_read", { steps, action: { m: "count" } }), 2);
    await assert.rejects(f.run("locator_target", { steps }), /唯一匹配/u);
  } finally { f.close(); }
});
