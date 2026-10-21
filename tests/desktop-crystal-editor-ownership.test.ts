/** Real CrystalDock and native Dialog controls, with synthetic, inert Desktop IPC only. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import type { Crystal } from "../src/agent/context/crystalTypes.js";
import type { DesktopCrystalRequest, DesktopCrystalSnapshot } from "../src/desktop/crystalProtocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const checklistFields = ["goal", "scope", "deliverables", "version", "source", "rights_status"] as const;
function crystal(id: string, slot: number): Crystal {
  return {
    id, slot, name: `Topic ${id}`, origin: "seed", stage: "candidate", type: "project",
    dormant: false, notified: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    checklist: Object.fromEntries(checklistFields.map(field => [field, { value: `Saved ${field} ${id}`, sources: ["user:manual"], conflict: false }]))
  };
}

const a = crystal("A", 1);
const b = crystal("B", 2);
const c = crystal("C", 3);
function snapshot(selected?: Crystal, slots: Crystal[] = [a, b]): DesktopCrystalSnapshot {
  return structuredClone({
    overview: { types: ["entity", "concept", "claim", "process", "rule", "project"], contourCount: 0,
      slots: slots.filter(entry => entry.stage === "candidate" && entry.slot !== undefined), slotCapacity: 3,
      backpack: slots.filter(entry => entry.stage === "candidate" && entry.slot === undefined), formal: slots.filter(entry => entry.stage === "formal") },
    detail: selected ? { crystal: selected, checklistSpec: checklistFields, termStats: null, materials: [],
      validation: { ready: true, missing: [], conflicted: [] }, related: [], materialPreviews: {} } : undefined
  });
}

async function fixture(t: TestContext) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown): void => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const hooks = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  await new Promise<void>(resolve => dom.window.addEventListener("load", () => resolve(), { once: true }));
  // JSDOM lacks native display methods; all Dialog dismissal and form logic remains real.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
  const unexpected: string[] = [];
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, char => `\\${char}`), supports: () => false },
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => { unexpected.push("fetch"); throw new Error("No external network in editor fixture"); }
  })) setGlobal(name, value);
  const React = await import("react");
  setGlobal("React", React);
  const { createRoot } = await import("react-dom/client");
  const { CrystalDock } = await import("../src/desktop/renderer/src/components/CrystalDock.js");
  type Call = ReturnType<typeof deferred<DesktopCrystalSnapshot>> & { request: DesktopCrystalRequest; settled: boolean };
  const calls: Call[] = [];
  Object.assign(dom.window, { biny: new Proxy({ crystalRequest(request: DesktopCrystalRequest) {
    const pending = deferred<DesktopCrystalSnapshot>();
    const call: Call = { ...pending, request: structuredClone(request), settled: false };
    calls.push(call);
    void pending.promise.then(() => { call.settled = true; }, () => { call.settled = true; });
    return pending.promise;
  } }, { get(target, name, receiver) {
    if (name in target) return Reflect.get(target, name, receiver);
    unexpected.push(String(name));
    throw new Error(`Unexpected IPC ${String(name)}`);
  } }) });
  const root = createRoot(document.getElementById("root")!);
  t.after(async () => {
    const failures: unknown[] = [];
    const run = async (work: () => unknown | Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
    await run(() => React.act(() => root.unmount()));
    await run(async () => {
      for (const call of calls) if (!call.settled) call.resolve(snapshot());
      await Promise.allSettled(calls.map(call => call.promise));
    });
    await run(() => dom.window.close());
    await run(() => hooks.deregister());
    for (const [name, descriptor] of saved) await run(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    });
    await run(() => assert.deepEqual(unexpected, [], "No unexpected IPC or network calls"));
    if (failures.length) throw new AggregateError(failures, "Editor fixture cleanup failed");
  });
  const step = async (work: () => void): Promise<void> => { await React.act(async () => { work(); }); };
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
  const button = (label: string) => {
    const found = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label || button.getAttribute("aria-label") === label || (button.matches(".crystal-list-row") && button.querySelector("span")?.textContent === label));
    assert.ok(found, `Visible button ${label}`);
    return found;
  };
  const click = async (label: string) => {
    const target = button(label);
    assert.equal(target.disabled, false, `${label} is enabled`);
    await step(() => target.click());
  };
  const field = (selector: string) => dialog()?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector) ?? null;
  const fill = async (selector: string, value: string) => {
    const target = field(selector);
    assert.ok(target, `Visible field ${selector}`);
    assert.equal(target.disabled, false, "Never type into a disabled field");
    const proto = target instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await step(() => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(target, value);
      target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(field(selector)?.value, value, "Real input updates controlled state");
  };
  await step(() => root.render(React.createElement(CrystalDock, { onInsert: () => {} })));
  return {
    calls, button, click, field, fill,
    async open() {
      assert.equal(dialog(), null, "Do not click the background behind an open modal");
      await step(() => document.querySelector<HTMLButtonElement>('button[aria-label="结晶"]')!.click());
      assert.ok(dialog());
      assert.equal(calls.at(-1)?.request.action, "overview");
      return calls.at(-1)!;
    },
    async close(method: "button" | "cancel") {
      assert.ok(dialog());
      await step(() => method === "button" ? button("Close").click() : dialog()!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true })));
      assert.equal(dialog(), null);
    },
    async resolve(call: Call, result: DesktopCrystalSnapshot) { await step(() => call.resolve(structuredClone(result))); },
    async reject(call: Call, reason: string) { await step(() => call.reject(new Error(reason))); },
    rows() { return [...dialog()!.querySelectorAll(".crystal-list-row > span")].map(row => row.textContent); },
    alert() { return dialog()?.querySelector('[role="alert"]')?.textContent ?? ""; },
    title() { return dialog()?.querySelector(".crystal-detail h2")?.textContent ?? ""; }
  };
}

async function selectA(h: Awaited<ReturnType<typeof fixture>>) {
  await h.resolve(await h.open(), snapshot());
  await h.click("Topic A");
  await h.resolve(h.calls.at(-1)!, snapshot(a));
  assert.equal(h.title(), "Topic A");
}

for (const method of ["button", "cancel"] as const) {
  for (const [label, selector] of [["checklist", "#crystal-goal"], ["note", "#crystal-note"], ["confirmation name", ".crystal-detail-footer input"]] as const) {
    test(`reopened ${label} draft cannot be accepted then erased by the pending overview (${method})`, async t => {
      const h = await fixture(t);
      await selectA(h);
      await h.close(method);
      const reopening = await h.open();
      const editable = h.field(selector);
      const accepted = editable !== null && !editable.disabled;
      const value = "Newly entered after reopening";
      if (accepted) await h.fill(selector, value);
      await h.resolve(reopening, snapshot(undefined, [a, c]));
      assert.deepEqual(h.rows(), ["Topic A", "Topic C"], "The fresh overview must update the cached list, not be ignored");
      if (accepted) {
        assert.equal(h.field(selector)?.value, value, "The arriving overview discarded an enabled, newly edited detail draft");
        assert.equal(h.field(selector)?.disabled, false, "A preserved draft must remain usable");
      } else {
        // A loading UI may withhold the stale editor, then allow fresh, correctly addressed selection.
        await h.click("Topic A");
        assert.deepEqual(h.calls.at(-1)?.request, { action: "detail", id: "A" });
        await h.resolve(h.calls.at(-1)!, snapshot(a, [a, c]));
        await h.fill(selector, value);
      }
      assert.equal(h.title(), "Topic A");
      await h.click(label === "checklist" ? "保存清单" : label === "note" ? "添加材料" : "确认结晶");
      const submission = h.calls.at(-1)!;
      assert.deepEqual(submission.request, label === "checklist"
        ? { action: "checklist", id: "A", fields: Object.fromEntries(checklistFields.map(field => [field, { value: field === "goal" ? value : `Saved ${field} A`, conflict: false }])) }
        : label === "note" ? { action: "note", id: "A", text: value }
          : { action: "confirm", id: "A", name: value });
      const updated = { ...a, updatedAt: "2026-01-02T00:00:00.000Z",
        ...(label === "checklist" ? { checklist: { ...a.checklist, goal: { value, sources: ["user:manual"], conflict: false } } } : {}),
        ...(label === "confirmation name" ? { name: value, stage: "formal" as const, slot: undefined, formalAt: "2026-01-02T00:00:00.000Z" } : {}) };
      await h.resolve(submission, snapshot(updated, [updated, c]));
      assert.equal(h.alert(), "");
      assert.equal(h.title(), label === "confirmation name" ? value : "Topic A");
      if (label === "checklist") assert.equal(h.field(selector)?.value, value);
      if (label === "note") assert.equal(h.field(selector)?.value, "");
    });
  }
}

test("pending checklist save blocks record selection and input; a failure preserves the draft for retry", async t => {
  const h = await fixture(t); await selectA(h);
  await h.fill("#crystal-goal", "New goal A"); await h.click("保存清单");
  const save = h.calls.at(-1)!;
  assert.deepEqual(save.request, { action: "checklist", id: "A", fields: Object.fromEntries(checklistFields.map(field => [field, { value: field === "goal" ? "New goal A" : `Saved ${field} A`, conflict: false }])) });
  assert.equal(h.button("Topic B").disabled, true);
  assert.equal(h.field("#crystal-goal")?.disabled, true);
  await h.reject(save, "Synthetic save failure");
  assert.equal(h.field("#crystal-goal")?.value, "New goal A");
  assert.equal(h.alert(), "Synthetic save failure");
  await h.click("保存清单");
  assert.deepEqual(h.calls.at(-1)?.request, save.request);
  const saved = { ...a, updatedAt: "2026-01-02T00:00:00.000Z", checklist: { ...a.checklist, goal: { value: "New goal A", sources: ["user:manual"], conflict: false } } };
  await h.resolve(h.calls.at(-1)!, snapshot(saved));
  assert.equal(h.field("#crystal-goal")?.value, "New goal A");
  assert.equal(h.button("保存清单").disabled, true);
  assert.equal(h.alert(), "");
});

for (const outcome of ["success", "failure"] as const) {
  test(`a newer selected record owns the dialog over a reopened overview ${outcome}`, async t => {
    const h = await fixture(t); await selectA(h); await h.close("button");
    const overview = await h.open();
    await h.click("Topic B");
    await h.resolve(h.calls.at(-1)!, snapshot(b));
    await h.fill("#crystal-goal", "New goal B");
    if (outcome === "success") await h.resolve(overview, snapshot()); else await h.reject(overview, "Old overview failure");
    assert.equal(h.title(), "Topic B");
    assert.equal(h.field("#crystal-goal")?.value, "New goal B");
    assert.equal(h.alert(), "");
  });
}

for (const action of ["checklist", "detail"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`late ${action} ${outcome} after cancel/reopen cannot restore the dismissed owner`, async t => {
      const h = await fixture(t); await selectA(h);
      if (action === "checklist") {
        await h.fill("#crystal-goal", "Submitted goal A"); await h.click("保存清单");
      } else await h.click("Topic A");
      const pending = h.calls.at(-1)!;
      assert.equal(pending.request.action, action);
      assert.equal(h.button("Topic B").disabled, true, "No newer row can be selected through a disabled control");
      await h.close("cancel"); await h.resolve(await h.open(), snapshot());
      assert.equal(h.button("Topic B").disabled, true, "Opening must not release the old operation lock");
      if (outcome === "success") await h.resolve(pending, snapshot(a)); else await h.reject(pending, "Old operation failure");
      assert.equal(h.title(), ""); assert.equal(h.alert(), "");
      await h.click("Topic B");
      assert.deepEqual(h.calls.at(-1)?.request, { action: "detail", id: "B" });
      await h.resolve(h.calls.at(-1)!, snapshot(b));
      assert.equal(h.title(), "Topic B");
    });
  }
}

for (const method of ["button", "cancel"] as const) {
  test(`reopened overview failure keeps the cached list usable for explicit retry (${method})`, async t => {
    const h = await fixture(t); await selectA(h); await h.close(method);
    const overview = await h.open();
    await h.reject(overview, "Synthetic overview failure");
    assert.equal(h.alert(), "Synthetic overview failure");
    assert.deepEqual(h.rows(), ["Topic A", "Topic B"]);
    await h.click("刷新结晶");
    assert.deepEqual(h.calls.at(-1)?.request, { action: "overview" });
    await h.resolve(h.calls.at(-1)!, snapshot(undefined, [a, c]));
    assert.equal(h.alert(), ""); assert.deepEqual(h.rows(), ["Topic A", "Topic C"]);
    await h.click("Topic C");
    assert.deepEqual(h.calls.at(-1)?.request, { action: "detail", id: "C" });
    await h.resolve(h.calls.at(-1)!, snapshot(c, [a, c]));
    await h.fill("#crystal-goal", "C remains editable");
  });
}

test("reopening keeps the separate seed-name draft while replacing the old detail", async t => {
  const h = await fixture(t); await selectA(h);
  await h.fill("#crystal-seed-name", "Separate seed draft");
  await h.close("button");
  const opening = await h.open();
  assert.equal(h.field("#crystal-seed-name")?.value, "Separate seed draft");
  await h.resolve(opening, snapshot(undefined, [a, c]));
  assert.equal(h.field("#crystal-seed-name")?.value, "Separate seed draft");
  assert.equal(h.field("#crystal-seed-name")?.disabled, false);
  assert.deepEqual(h.rows(), ["Topic A", "Topic C"]);
});
