/** Full serialized page program; geometry and hit testing are controlled, not native-browser acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageOperation } from "../src/browser-extension/page.js";
import { browserLocatorReadSchema } from "../src/browser/locatorSchema.js";

function fixture() {
  const dom = new JSDOM('<main id="scope"><div id="host"></div></main><button id="outside">Save</button>', { url: "https://example.test/", runScripts: "outside-only" });
  const { window } = dom;
  Object.assign(window, { CSS: { escape: (value: string) => value } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value() {
    return { x: 10, y: 20, width: 100, height: 24, left: 10, right: 110, top: 20, bottom: 44 };
  } });
  const host = window.document.getElementById("host")!;
  const shadow = host.attachShadow({ mode: "open" });
  const run = window.eval(`(${pageOperation.toString()})`) as typeof pageOperation;
  const count = (steps: unknown[]) => run("locator_read", browserLocatorReadSchema.parse({ steps, action: { m: "count" } }));
  return { window, host, shadow, run, count, close: () => window.close() };
}
const hostStep = { m: "locator", selector: "#host" };
const buttonStep = { m: "getByRole", role: "button", name: "Save", exact: true };

for (const step of [buttonStep, { m: "getByText", text: "Save", exact: true }, { m: "getByTestId", testId: "save" }, { m: "locator", selector: "role=button|Save" }, { m: "locator", selector: "text=Save" }, { m: "locator", selector: "testid=save" }]) {
  test(`host scope traverses its own open shadow for ${JSON.stringify(step)}`, async () => {
    const f = fixture(); f.shadow.innerHTML = '<button id="inside" data-testid="save">Save</button>';
    try {
      assert.equal(await f.count([hostStep, step]), 1);
      assert.equal((await f.run("locator_target", { steps: [hostStep, step] })).selector, "#host >>> #inside");
      assert.equal(await f.count([{ m: "locator", selector: "#scope" }, step]), 1);
    } finally { f.close(); }
  });
}

for (const step of [{ m: "getByLabel", label: "Email" }, { m: "getByPlaceholder", placeholder: "Your email", exact: true }, { m: "locator", selector: "label=Email" }, { m: "locator", selector: "placeholder=Your email" }]) {
  test(`host-scoped form lookup supports ${JSON.stringify(step)}`, async () => {
    const f = fixture(); f.shadow.innerHTML = '<label for="email">Email</label><input id="email" placeholder="Your email">';
    try { assert.equal(await f.count([hostStep, step]), 1); } finally { f.close(); }
  });
}

test("nested host scopes yield a real target used for checked input with composed-root hit tests", async () => {
  const f = fixture(); f.shadow.innerHTML = '<div id="inner"></div>';
  try {
    const inner = f.shadow.getElementById("inner")!;
    const nested = inner.attachShadow({ mode: "open" });
    nested.innerHTML = '<input id="check" type="checkbox" aria-label="Subscribe">';
    const checkbox = nested.getElementById("check") as HTMLInputElement;
    const steps = [hostStep, { m: "getByRole", role: "checkbox", name: "Subscribe" }];
    const target = await f.run("locator_target", { steps });
    assert.equal(target.selector, "#host >>> #inner >>> #check");
    Object.defineProperty(nested, "elementFromPoint", { value: () => checkbox });
    Object.defineProperty(f.shadow, "elementFromPoint", { value: () => inner });
    Object.defineProperty(f.window.document, "elementFromPoint", { value: () => f.host });
    const events: string[] = [];
    checkbox.addEventListener("input", () => events.push("input")); checkbox.addEventListener("change", () => events.push("change"));
    assert.equal((await f.run("set_checked", { selector: target.selector, checked: true })).checked, true);
    assert.deepEqual(events, ["input", "change"]);
    assert.equal(await f.count([{ m: "locator", selector: "#host >>> #inner" }, { m: "getByRole", role: "checkbox" }]), 1);
    checkbox.disabled = true;
    await assert.rejects(f.run("locator_target", { steps }), /不可操作/u);
  } finally { f.close(); }
});

test("light DOM and shadow duplicates remain distinct and explicit refiners work", async () => {
  const f = fixture(); f.host.innerHTML = '<button id="light">Save</button>'; f.shadow.innerHTML = '<button id="dark">Save</button>';
  try {
    assert.equal(await f.count([hostStep, buttonStep]), 2);
    await assert.rejects(f.run("locator_target", { steps: [hostStep, buttonStep] }), /唯一匹配/u);
    assert.equal((await f.run("locator_target", { steps: [hostStep, buttonStep, { m: "first" }] })).selector, "#light");
    assert.equal((await f.run("locator_target", { steps: [hostStep, buttonStep, { m: "last" }] })).selector, "#host >>> #dark");
    assert.equal(await f.count([{ m: "locator", selector: "#scope, #host" }, buttonStep]), 2);
  } finally { f.close(); }
});

test("host itself and sibling scopes are never included as host descendants", async () => {
  const f = fixture(); f.host.setAttribute("role", "button"); f.host.setAttribute("aria-label", "Save");
  f.shadow.innerHTML = '<button id="inside">Other</button>';
  try {
    assert.equal(await f.count([hostStep, buttonStep]), 0);
    assert.equal(await f.count([buttonStep]), 2);
    assert.equal(await f.count([hostStep, { m: "getByRole", role: "button", name: "Other" }]), 1);
  } finally { f.close(); }
});

test("closed shadow roots stay excluded while their light DOM remains queryable", async () => {
  const f = fixture();
  try {
    const closedHost = f.window.document.createElement("div"); closedHost.id = "closed"; f.host.append(closedHost);
    closedHost.innerHTML = '<button id="light">Light</button>';
    closedHost.attachShadow({ mode: "closed" }).innerHTML = '<button>Secret</button>';
    assert.equal(await f.count([{ m: "locator", selector: "#closed" }, { m: "getByRole", role: "button", name: "Secret" }]), 0);
    assert.equal(await f.count([hostStep, { m: "getByRole", role: "button", name: "Secret" }]), 0);
    assert.equal(await f.count([{ m: "locator", selector: "#closed" }, { m: "getByRole", role: "button", name: "Light" }]), 1);
  } finally { f.close(); }
});

test("plain CSS stays light-DOM-only while explicit shadow paths retain their meaning and errors", async () => {
  const f = fixture(); f.host.innerHTML = '<button id="light">Light</button>'; f.shadow.innerHTML = '<button id="inside">Save</button>';
  try {
    assert.equal(await f.count([hostStep, { m: "locator", selector: "button" }]), 1);
    assert.equal(await f.count([{ m: "locator", selector: "#host >>> #inside" }]), 1);
    assert.equal(await f.count([{ m: "locator", selector: "#host >>> #missing" }]), 0);
    await assert.rejects(f.count([hostStep, { m: "locator", selector: "[" }]));
  } finally { f.close(); }
});

test("replacement shadow descendants are resolved fresh and detached old controls are excluded", async () => {
  const f = fixture(); f.shadow.innerHTML = '<button id="old">Save</button>';
  try {
    assert.equal((await f.run("locator_target", { steps: [hostStep, buttonStep] })).selector, "#host >>> #old");
    f.shadow.innerHTML = '<button id="new">Save</button>';
    assert.equal((await f.run("locator_target", { steps: [hostStep, buttonStep] })).selector, "#host >>> #new");
    assert.equal(await f.count([hostStep, buttonStep]), 1);
  } finally { f.close(); }
});

test("Document-root traversal and 200 element read/snapshot limits stay unchanged", async () => {
  const f = fixture(); f.shadow.innerHTML = Array.from({ length: 205 }, (_, i) => `<button id="b${i}">Inside ${i}</button>`).join("");
  try {
    assert.equal(await f.count([{ m: "getByRole", role: "button" }]), 206);
    const read = await f.run("read", {}); const snapshot = await f.run("dom_snapshot", {});
    assert.equal(read.interactive.length, 200); assert.equal(snapshot.elements.length, 200);
    assert.equal(read.interactive[0].selector, "#outside");
    assert.equal(snapshot.elements[199].selector, "#host >>> #b198");
  } finally { f.close(); }
});

test("deep open-shadow chains retain the existing traversal guard", async () => {
  const f = fixture();
  try {
    let root = f.shadow;
    for (let i = 0; i < 205; i++) {
      root.innerHTML = `<button>Level ${i}</button><div id="next${i}"></div>`;
      root = root.querySelector("div")!.attachShadow({ mode: "open" });
    }
    assert.equal(await f.count([hostStep, { m: "getByRole", role: "button" }]), 199);
    assert.equal(await f.count([{ m: "getByRole", role: "button" }]), 200);
  } finally { f.close(); }
});
