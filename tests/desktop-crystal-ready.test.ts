/** Real desktop storage and CrystalDock DOM: notification suppression is not confirmation eligibility. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { CrystalNotReadyError, CrystalService, validateCrystal } from "../src/agent/context/crystalService.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { crystalTypeFields, type Crystal, type CrystalType } from "../src/agent/context/crystalTypes.js";
import { defaultConfig } from "../src/config/schema.js";
import type { DesktopCrystalRequest, DesktopCrystalSnapshot } from "../src/desktop/crystalProtocol.js";
import { DesktopCrystalService } from "../src/desktop/electron/main/DesktopCrystalService.js";

type Cleanup = () => void | Promise<void>;

async function cleanupAll(steps: Cleanup[]): Promise<void> {
  const errors: unknown[] = [];
  const run = async (index: number): Promise<void> => {
    if (index === steps.length) return;
    try { await steps[index]!(); }
    catch (error) { errors.push(error); }
    finally { await run(index + 1); }
  };
  await run(0);
  if (errors.length) throw new AggregateError(errors, "Crystal test cleanup failed");
}

async function fixture(t: TestContext) {
  let directory: string | undefined;
  let closing: Promise<void> | undefined;
  const beforeClose: Cleanup[] = [];
  const storages = new Set<CrystalStorage>();
  const close = () => closing ??= cleanupAll([
    () => cleanupAll([...beforeClose].reverse()),
    () => cleanupAll([...storages].map(storage => () => storage.close())),
    async () => { if (directory) await rm(directory, { recursive: true, force: true }); }
  ]);
  // Register before acquisition: ready()/mount()/initialize() may fail before normal cleanup.
  t.after(close);
  directory = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-ready-"));
  const agentDir = directory;
  const service = new DesktopCrystalService(
    { load: async () => defaultConfig, save: async () => undefined },
    async () => [agentDir],
    () => {
      const storage = new CrystalStorage({ agentDir });
      storages.add(storage);
      return storage;
    }
  );
  return {
    directory: agentDir, service, close,
    beforeClose(cleanup: Cleanup) { beforeClose.push(cleanup); },
    async ready(name: string) {
      const created = await service.request({ action: "seed", name });
      const id = created.detail!.crystal.id;
      const typed = await service.request({ action: "type", id, type: "project" });
      const fields = Object.fromEntries(typed.detail!.checklistSpec!.map(field => [field, { value: `Verified ${field}`, conflict: false }]));
      const saved = await service.request({ action: "checklist", id, fields });
      assert.equal(saved.detail!.validation.ready, true);
      assert.equal(saved.detail!.crystal.notified, true);
      return { id, name, fields };
    }
  };
}

async function mount(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  let closing: Promise<void> | undefined;
  let timersEnabled = false;
  const resources: {
    css?: ReturnType<typeof registerHooks>;
    dom?: import("jsdom").JSDOM;
    React?: typeof import("react");
    root?: import("react-dom/client").Root;
  } = {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const pending = new Set<Promise<DesktopCrystalSnapshot>>();
  const close = () => closing ??= cleanupAll([
    // A rejected request must neither skip unmount nor leave another request using a removed directory.
    async () => { while (pending.size) await Promise.allSettled([...pending]); },
    async () => { if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount()); },
    () => { if (timersEnabled) t.mock.timers.reset(); },
    () => resources.dom?.window.close(),
    () => resources.css?.deregister(),
    () => cleanupAll([...saved].map(([key, descriptor]) => () => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }))
  ]);
  // Both owners share this idempotent cleanup before any hook/global/timer/root is installed.
  t.after(close);
  f.beforeClose(close);
  resources.css = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const React = resources.React = await import("react");
  const dom = resources.dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  await new Promise<void>(resolve => dom.window.addEventListener("load", () => resolve(), { once: true }));
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, char => `\\${char}`), supports: () => false },
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const calls: Array<{ request: DesktopCrystalRequest; snapshot: DesktopCrystalSnapshot }> = [];
  Object.assign(dom.window, { biny: { crystalRequest(input: DesktopCrystalRequest) {
    const request = structuredClone(input);
    const promise = f.service.request(request).then(result => {
      const snapshot = structuredClone(result);
      calls.push({ request, snapshot });
      return snapshot;
    });
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  } } });
  timersEnabled = true;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { createRoot } = await import("react-dom/client");
  const { CrystalDock } = await import("../src/desktop/renderer/src/components/CrystalDock.js");
  const root = resources.root = createRoot(document.getElementById("root")!);
  const inserted: string[] = [];
  const drain = async (action: () => void): Promise<void> => {
    await React.act(async () => { action(); });
    // Open effects and event handlers may begin filesystem-backed IPC after the first commit.
    await React.act(async () => { while (pending.size) await Promise.all([...pending]); });
  };
  const button = (label: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
    assert.equal(Boolean(result), true, `Missing button: ${label}`);
    return result!;
  };
  const row = (name: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll<HTMLButtonElement>(".crystal-list-row")]
      .find(element => element.querySelector("span")?.textContent === name);
    assert.equal(Boolean(result), true, `Missing crystal row: ${name}`);
    return result!;
  };
  const click = async (element: HTMLElement): Promise<void> => { await drain(() => element.click()); };
  await drain(() => root.render(React.createElement(CrystalDock, { onInsert: (reference: string) => inserted.push(reference) })));
  return {
    calls, inserted, row, button, click,
    badge(name: string) { return row(name).querySelector("small")?.textContent ?? ""; },
    async open() {
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="结晶"]');
      assert.equal(Boolean(trigger), true);
      await click(trigger!);
      assert.equal(Boolean(document.querySelector("dialog[open]")), true, "The actual CrystalDock dialog opened");
    },
    async select(name: string) { await click(row(name)); },
    async fill(selector: string, value: string) {
      const input = document.querySelector<HTMLTextAreaElement>(selector);
      assert.equal(Boolean(input), true, `Missing textarea: ${selector}`);
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
      await drain(() => {
        setter.call(input, value);
        input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async conflict(field: string) {
      const checkbox = document.getElementById(`crystal-${field}`)?.closest(".crystal-field")?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert.equal(Boolean(checkbox), true, `Missing conflict checkbox: ${field}`);
      await click(checkbox!);
    },
    async reopen() {
      await click(button("引用到聊天"));
      await React.act(async () => { t.mock.timers.tick(1_000); });
      assert.equal(Boolean(document.querySelector("dialog[open]")), false, "Reference action closes the dialog");
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="结晶"]');
      assert.equal(Boolean(trigger), true);
      await click(trigger!);
      assert.equal(Boolean(document.querySelector("dialog[open]")), true);
      assert.equal(calls.at(-1)?.request.action, "overview");
      assert.equal(calls.at(-1)?.snapshot.detail, undefined, "Reopening uses overview without selected detail");
    },
    close
  };
}

test("crystal row removes ready badge after a real conflicting checklist edit", async t => {
  const f = await fixture(t);
  const item = await f.ready("Conflict candidate");
  const h = await mount(t, f);
  await h.open(); await h.select(item.name);
  assert.equal(h.badge(item.name), "可确认");
  assert.equal(h.button("确认结晶").disabled, false);
  await h.conflict("goal"); await h.click(h.button("保存清单"));
  const result = h.calls.at(-1)!;
  assert.equal(result.request.action, "checklist");
  assert.equal(result.snapshot.detail!.validation.ready, false);
  assert.equal(result.snapshot.detail!.crystal.notified, true);
  assert.equal(h.button("确认结晶").disabled, true);
  await assert.rejects(f.service.request({ action: "confirm", id: item.id }), CrystalNotReadyError);
  assert.equal((await f.service.request({ action: "detail", id: item.id })).detail!.crystal.stage, "candidate");
  assert.equal(h.badge(item.name), "", "Conflicted candidate must not advertise confirmation eligibility");
  await f.close();
});

test("crystal row removes ready badge after a real required-field clearing", async t => {
  const f = await fixture(t);
  const item = await f.ready("Missing-field candidate");
  const h = await mount(t, f);
  await h.open(); await h.select(item.name);
  await h.fill("#crystal-goal", ""); await h.click(h.button("保存清单"));
  const detail = h.calls.at(-1)!.snapshot.detail!;
  assert.equal(detail.crystal.checklist.goal!.value, "");
  assert.equal(detail.validation.ready, false);
  assert.equal(detail.crystal.notified, true);
  assert.equal(h.button("确认结晶").disabled, true);
  await assert.rejects(f.service.request({ action: "confirm", id: item.id }), CrystalNotReadyError);
  assert.equal(h.badge(item.name), "", "Missing required value must hide the ready badge");
  await f.close();
});

test("adding a real note keeps eligible candidate visible despite notification reset", async t => {
  const f = await fixture(t);
  const item = await f.ready("More-evidence candidate");
  const before = (await f.service.request({ action: "detail", id: item.id })).detail!;
  const h = await mount(t, f);
  await h.open(); await h.select(item.name);
  await h.fill("#crystal-note", "An additional unique source note.");
  await h.click(h.button("添加材料"));
  const result = h.calls.at(-1)!;
  assert.equal(result.request.action, "note");
  const detail = result.snapshot.detail!;
  assert.equal(detail.materials.length, before.materials.length + 1);
  assert.deepEqual(detail.crystal.checklist, before.crystal.checklist);
  assert.equal(detail.validation.ready, true);
  assert.equal(detail.crystal.notified, false);
  assert.equal(h.button("确认结晶").disabled, false);
  assert.equal(h.badge(item.name), "可确认", "Notification reset must not remove eligibility badge");
  await f.close();
});

test("overview rows use their own eligibility across selection, refresh and dialog reopen", async t => {
  const f = await fixture(t);
  const invalid = await f.ready("Independent invalid");
  await f.service.request({ action: "checklist", id: invalid.id, fields: { goal: { value: invalid.fields.goal!.value, conflict: true } } });
  const valid = await f.ready("Independent valid");
  await f.service.request({ action: "note", id: valid.id, text: "New evidence resets only the notification latch." });
  const h = await mount(t, f);
  const checkRows = () => {
    assert.equal(h.badge(invalid.name), "", "Invalid row cannot borrow the selected row's readiness");
    assert.equal(h.badge(valid.name), "可确认", "Valid row cannot borrow the other row's notification latch");
  };
  await h.open();
  assert.equal(h.calls.at(-1)!.snapshot.detail, undefined);
  checkRows();
  await h.select(invalid.name); assert.equal(h.button("确认结晶").disabled, true); checkRows();
  await h.select(valid.name); assert.equal(h.button("确认结晶").disabled, false); checkRows();
  const refresh = document.querySelector<HTMLButtonElement>('button[aria-label="刷新结晶"]');
  assert.equal(Boolean(refresh), true); await h.click(refresh!);
  assert.equal(h.calls.at(-1)!.snapshot.detail, undefined); checkRows();
  await h.select(valid.name); await h.reopen(); checkRows();
  assert.equal(h.inserted.length, 1);
  await f.close();
});

test("dormant precedence and formal-stage filtering remain unchanged", async t => {
  const f = await fixture(t); const item = await f.ready("Lifecycle control");
  const h = await mount(t, f);
  await h.open(); await h.select(item.name);
  assert.equal(h.badge(item.name), "可确认");
  await h.click(h.button("收起观察"));
  assert.equal(h.calls.at(-1)!.snapshot.detail!.validation.ready, true);
  assert.equal(h.badge(item.name), "休眠");
  await h.click(h.button("恢复观察")); assert.equal(h.badge(item.name), "可确认");
  await h.click(h.button("确认结晶"));
  assert.equal(h.calls.at(-1)!.snapshot.detail!.crystal.stage, "formal");
  assert.equal(h.badge(item.name), "");
  await f.close();
});

test("ready notification suppression, resets and cancel semantics remain unchanged", async t => {
  const f = await fixture(t); const events: string[] = [];
  const core = new CrystalService({ storage: new CrystalStorage({ agentDir: f.directory }), onEvent: event => events.push(event.type) });
  f.beforeClose(() => core.close());
  await core.initialize();
  const seed = core.createSeed("Notification control"); core.setType(seed.id, "project");
  for (const field of crystalTypeFields.project) core.updateChecklist(seed.id, field, { value: field, sources: ["user:manual"] });
  const count = () => events.filter(event => event === "crystal_ready").length;
  assert.equal(count(), 1);
  core.updateChecklist(seed.id, "goal", { value: "goal" });
  core.updateChecklist(seed.id, "goal", { conflict: true });
  core.updateChecklist(seed.id, "goal", { value: "" });
  core.updateChecklist(seed.id, "goal", { value: "goal", conflict: false });
  assert.equal(count(), 1);
  assert.equal(core.detail(seed.id)!.crystal.notified, true);
  assert.equal(core.addMaterial(seed.id, "note", { text: "Unique material" }), true);
  assert.equal(core.detail(seed.id)!.crystal.notified, false);
  assert.equal(core.detail(seed.id)!.validation.ready, true);
  assert.equal(count(), 1);
  core.updateChecklist(seed.id, "goal", { value: "goal" }); assert.equal(count(), 2);
  core.updateChecklist(seed.id, "goal", { value: "goal" }); assert.equal(count(), 2);
  const cancelled = core.createSeed("Cancelled incomplete");
  core.cancel(cancelled.id, true);
  assert.equal(core.detail(cancelled.id)!.crystal.notified, true);
  assert.equal(core.detail(cancelled.id)!.validation.ready, false);
  assert.equal(count(), 2, "cancel suppresses readiness notification without establishing eligibility");
  await f.close();
});

for (const type of Object.keys(crystalTypeFields) as CrystalType[]) {
  test(`existing validator facade preserves ${type} eligibility and missing/conflict classification`, () => {
    const fields = crystalTypeFields[type];
    const crystal: Crystal = {
      id: `validation-${type}`, name: type, origin: "seed", stage: "candidate", type, dormant: false, notified: true,
      checklist: Object.fromEntries(fields.map(field => [field, { value: field, sources: ["user:manual"] }])),
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const before = structuredClone(crystal);
    for (const item of Object.values(crystal.checklist)) { Object.freeze(item.sources); Object.freeze(item); }
    Object.freeze(crystal.checklist); Object.freeze(crystal);
    assert.deepEqual(validateCrystal(crystal), { ready: true, missing: [], conflicted: [] });
    assert.deepEqual(crystal, before);
    const first = fields[0];
    for (const replacement of [undefined, { value: "   ", sources: ["user:manual"], conflict: true }, { value: first, sources: [] }]) {
      const invalid = structuredClone(before);
      if (replacement) invalid.checklist[first] = replacement; else delete invalid.checklist[first];
      assert.deepEqual(validateCrystal(invalid), { ready: false, missing: [first], conflicted: [] });
    }
    const conflict = structuredClone(before); conflict.checklist[first]!.conflict = true;
    assert.deepEqual(validateCrystal(conflict), { ready: false, missing: [], conflicted: [first] });
    assert.deepEqual(validateCrystal({ ...before, type: undefined }), { ready: false, missing: ["type"], conflicted: [] });
    assert.equal(validateCrystal({ ...before, stage: "formal", dormant: true, notified: false }).ready, true,
      "Lifecycle display filters are not part of confirmation field validation");
  });
}
