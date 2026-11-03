/** Whole page program in DOM; geometry is controlled, not native input or full accessibility acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageOperation } from "../src/browser-extension/page.js";
import { browserLocatorReadSchema, browserLocatorActionSchema } from "../src/browser/locatorSchema.js";

function fixture(html: string) {
  const dom = new JSDOM(html, { url: "https://example.test/", runScripts: "outside-only" });
  const { window } = dom;
  Object.assign(window, { CSS: { escape: (value: string) => value } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value() {
    return { x: 10, y: 20, width: 100, height: 24, left: 10, right: 110, top: 20, bottom: 44 };
  } });
  const run = window.eval(`(${pageOperation.toString()})`) as typeof pageOperation;
  const count = (label: string) => run("locator_read", browserLocatorReadSchema.parse({ steps: [{ m: "getByLabel", label }], action: { m: "count" } }));
  return { window, run, count, close: () => window.close() };
}

for (const markup of [
  '<input placeholder="Email">', '<input title="Email">', '<button>Email</button>',
  '<input type="submit" value="Email">', '<textarea>Email</textarea>',
  '<div role="textbox">Email</div>', '<div contenteditable="true">Email</div>',
  '<input placeholder="Email" aria-labelledby="missing">',
  '<input title="Email" aria-labelledby="missing also-missing" aria-label="">'
]) {
  test(`fallback-only content is not a label: ${markup}`, async () => {
    const f = fixture(markup);
    try { assert.equal(await f.count("Email"), 0); } finally { f.close(); }
  });
}

test("a real labeled input remains uniquely actionable beside placeholder/title/text lookalikes", async () => {
  const f = fixture('<label for="real">Email</label><input id="real"><input id="placeholder" placeholder="Email"><input id="title" title="Email"><button id="button">Email</button>');
  try {
    const args = browserLocatorActionSchema.parse({ steps: [{ m: "getByLabel", label: "Email" }], action: { m: "fill", value: "a@example.test" } });
    assert.equal(await f.count("Email"), 1);
    const target = await f.run("locator_target", { steps: args.steps });
    assert.equal(target.selector, "#real");
    const input = f.window.document.getElementById("real") as HTMLInputElement;
    Object.defineProperty(f.window.document, "elementFromPoint", { value: () => input });
    await f.run("fill", { selector: target.selector });
    assert.equal(f.window.document.activeElement, input);
    // fill prepares focus/selection; native typing belongs to the outer dispatcher and is not simulated here.
    assert.equal((f.window.document.getElementById("placeholder") as HTMLInputElement).value, "");
  } finally { f.close(); }
});

for (const markup of [
  '<label for="real">Email</label><input id="real">',
  '<label>Email<input id="real"></label>',
  '<input id="real" aria-label=" Email ">',
  '<span id="label">Email</span><input id="real" aria-labelledby="label">',
  '<span id="label">Email</span><input id="real" aria-labelledby="missing label">',
  '<label for="real">Email</label><input id="real" aria-labelledby="missing">'
]) {
  test(`real label sources stay supported: ${markup}`, async () => {
    const f = fixture(markup);
    try {
      assert.equal(await f.count("Email"), 1);
      assert.equal((await f.run("locator_target", { steps: [{ m: "getByLabel", label: "Email" }] })).selector, "#real");
    } finally { f.close(); }
  });
}

test("multiple native labels retain individual exact matching and whitespace normalization", async () => {
  const f = fixture('<label for="real">Work  Email</label><label for="real">Contact</label><input id="real">');
  try {
    assert.equal(await f.count("Work Email"), 1); assert.equal(await f.count("Contact"), 1);
    assert.equal(await f.count("Work"), 0);
    assert.equal(await f.count("Work Email Contact"), 1);
  } finally { f.close(); }
});

test("placeholder, role name and read/snapshot name behavior are untouched", async () => {
  const f = fixture('<input id="placeholder" placeholder="Email"><button id="button">Send</button>');
  try {
    assert.equal(await f.run("locator_read", { steps: [{ m: "getByPlaceholder", placeholder: "Email", exact: true }], action: { m: "count" } }), 1);
    assert.equal(await f.run("locator_read", { steps: [{ m: "getByRole", role: "button", name: "Send", exact: true }], action: { m: "count" } }), 1);
    const read = await f.run("read", {}); const snapshot = await f.run("dom_snapshot", {});
    assert.deepEqual(Array.from(read.interactive, (item: { name: string }) => item.name), ["Email", "Send"]);
    assert.deepEqual(Array.from(snapshot.elements, (item: { name: string }) => item.name), ["Email", "Send"]);
  } finally { f.close(); }
});

test("reference insertion and removal are checked fresh instead of caching eligibility", async () => {
  const f = fixture('<input id="real" placeholder="Email" aria-labelledby="label">');
  try {
    assert.equal(await f.count("Email"), 0);
    const label = f.window.document.createElement("span"); label.id = "label"; label.textContent = "Email"; f.window.document.body.append(label);
    assert.equal(await f.count("Email"), 1);
    label.remove(); assert.equal(await f.count("Email"), 0);
  } finally { f.close(); }
});

test("open shadow root ID references are resolved in their own tree", async () => {
  const f = fixture('<span id="label">Outside</span><div id="host"></div>');
  try {
    const shadow = f.window.document.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<span id="label">Email</span><input id="real" aria-labelledby="label"><input placeholder="Email">';
    assert.equal(await f.count("Email"), 1);
    assert.equal((await f.run("locator_target", { steps: [{ m: "getByLabel", label: "Email" }] })).selector, "#host >>> #real");
  } finally { f.close(); }
});

test("genuine duplicate labels still require refinement and disabled controls remain ineligible for actions", async () => {
  const f = fixture('<input id="one" aria-label="Email"><input id="two" aria-label="Email" disabled>');
  try {
    assert.equal(await f.count("Email"), 2);
    await assert.rejects(f.run("locator_target", { steps: [{ m: "getByLabel", label: "Email" }] }), /唯一匹配/u);
    assert.equal((await f.run("locator_target", { steps: [{ m: "getByLabel", label: "Email" }, { m: "first" }] })).selector, "#one");
    await assert.rejects(f.run("locator_target", { steps: [{ m: "getByLabel", label: "Email" }, { m: "last" }] }), /不可操作/u);
  } finally { f.close(); }
});

test("empty or whitespace-only aria-label alone is not a label source", async () => {
  const f = fixture('<input aria-label=""><input aria-label="   "><button aria-label=" ">Email</button>');
  try {
    assert.equal(await f.count("Email"), 0);
    assert.equal(await f.count(" "), 0);
  } finally { f.close(); }
});

test("valid empty labelledby references remain valid sources without placeholder fallback", async () => {
  const f = fixture('<span id="empty"></span><input id="real" placeholder="Email" aria-labelledby="missing empty">');
  try {
    assert.equal(await f.count("Email"), 0);
    assert.equal(await f.count(" "), 1);
  } finally { f.close(); }
});

test("multiple valid IDREFs retain combined-name matching and ignore missing IDs", async () => {
  const f = fixture('<span id="first">Work</span><span id="second">Email</span><input id="real" aria-labelledby="first missing second">');
  try {
    assert.equal(await f.count("Work Email"), 1);
    // Existing API semantics remain exact combined IDREF text, not new substring behavior.
    assert.equal(await f.count("Work"), 0);
  } finally { f.close(); }
});

test("removing direct aria and native label sources removes action eligibility", async () => {
  const f = fixture('<label id="native" for="real">Email</label><input id="real" placeholder="Email" aria-label="Email">');
  try {
    const input = f.window.document.getElementById("real")!;
    input.removeAttribute("aria-label");
    assert.equal(await f.count("Email"), 1);
    f.window.document.getElementById("native")!.remove();
    assert.equal(await f.count("Email"), 0);
    await assert.rejects(f.run("locator_target", { steps: [{ m: "getByLabel", label: "Email" }] }), /唯一匹配/u);
  } finally { f.close(); }
});

test("legacy label= selector behavior stays unchanged", async () => {
  const f = fixture('<label for="native">Email</label><input id="native"><input id="aria" aria-label="Email"><input placeholder="Email"><button>Email</button><span id="ref">Email</span><input aria-labelledby="ref">');
  try {
    assert.equal(await f.run("locator_read", { steps: [{ m: "locator", selector: "label=Email" }], action: { m: "count" } }), 2);
    assert.equal(await f.count("Email"), 3);
  } finally { f.close(); }
});
