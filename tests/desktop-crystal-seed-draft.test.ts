/** Actual CrystalDock input and DesktopCrystalService storage; only IPC delivery is delayed. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { DesktopCrystalRequest, DesktopCrystalSnapshot } from "../src/desktop/crystalProtocol.js";

type Cleanup = () => void | Promise<void>;
type Outcome = { ok: true; snapshot: DesktopCrystalSnapshot } | { ok: false; error: unknown };

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function cleanupAll(steps: Cleanup[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Crystal seed fixture cleanup failed");
}

async function fixture(t: TestContext) {
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const resources: {
    directory?: string;
    css?: ReturnType<typeof registerHooks>;
    dom?: import("jsdom").JSDOM;
    React?: typeof import("react");
    root?: import("react-dom/client").Root;
  } = {};
  const storages = new Set<import("../src/agent/context/crystalStorage.js").CrystalStorage>();
  type Gate = {
    ready: ReturnType<typeof signal<Outcome>>;
    delivery: ReturnType<typeof signal<void>>;
    released: boolean;
  };
  type Call = { request: DesktopCrystalRequest; promise: Promise<DesktopCrystalSnapshot>; gate?: Gate };
  const calls: Call[] = [];
  const pending = new Set<Call>();
  const gates: Gate[] = [];
  let nextGate: Gate | undefined;
  let timersEnabled = false;
  let closing: Promise<void> | undefined;
  const release = (gate: Gate): void => {
    gate.released = true;
    gate.delivery.resolve();
  };
  const close = () => closing ??= cleanupAll([
    async () => {
      const drain = async () => {
        for (const gate of gates) release(gate);
        while (pending.size) await Promise.allSettled([...pending].map(call => call.promise));
      };
      if (resources.React) await resources.React.act(drain); else await drain();
    },
    async () => { if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount()); },
    () => { if (timersEnabled) t.mock.timers.reset(); },
    () => resources.dom?.window.close(),
    () => resources.css?.deregister(),
    () => cleanupAll([...storages].map(storage => () => storage.close())),
    () => cleanupAll([...savedGlobals].map(([key, descriptor]) => () => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    })),
    () => {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
    },
    async () => { if (resources.directory) await rm(resources.directory, { recursive: true, force: true }); }
  ]);
  t.after(close);
  const directory = resources.directory = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-seed-draft-"));
  process.env.BINY_AGENT_DIR = directory;
  const setGlobal = (key: string, value: unknown): void => {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  setGlobal("fetch", async () => { throw new Error("Crystal seed fixture must not access the network"); });
  const { DesktopCrystalService } = await import("../src/desktop/electron/main/DesktopCrystalService.js");
  const { CrystalStorage } = await import("../src/agent/context/crystalStorage.js");
  const { CrystalSlotsFullError } = await import("../src/agent/context/crystalService.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  setGlobal("fetch", async () => { throw new Error("Crystal seed fixture must not access providers"); });
  const service = new DesktopCrystalService(
    { load: async () => defaultConfig, save: async () => undefined },
    async () => [directory],
    () => {
      const storage = new CrystalStorage({ agentDir: directory });
      storages.add(storage);
      return storage;
    }
  );
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
    IS_REACT_ACT_ENVIRONMENT: true })) setGlobal(key, value);
  Object.assign(dom.window, { biny: { crystalRequest(input: DesktopCrystalRequest) {
    const request = structuredClone(input);
    const gate = request.action === "seed" ? nextGate : undefined;
    if (gate) nextGate = undefined;
    const promise = (async () => {
      let outcome: Outcome;
      try { outcome = { ok: true, snapshot: structuredClone(await service.request(request)) }; }
      catch (error) { outcome = { ok: false, error }; }
      if (gate) {
        gate.ready.resolve(outcome);
        await gate.delivery.promise;
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.snapshot;
    })();
    const call: Call = { request, promise, gate };
    calls.push(call);
    pending.add(call);
    void promise.then(() => pending.delete(call), () => pending.delete(call));
    return promise;
  } } });
  timersEnabled = true;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { createRoot } = await import("react-dom/client");
  const { CrystalDock } = await import("../src/desktop/renderer/src/components/CrystalDock.js");
  const root = resources.root = createRoot(document.getElementById("root")!);
  const settleAvailable = async (): Promise<void> => {
    await React.act(async () => {
      for (;;) {
        const available = [...pending].filter(call => !call.gate || call.gate.released);
        if (!available.length) return;
        await Promise.allSettled(available.map(call => call.promise));
      }
    });
  };
  const step = async (action: () => void): Promise<void> => { await React.act(action); };
  const button = (label: string): HTMLButtonElement => {
    const value = [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")]
      .find(element => element.textContent?.trim() === label);
    assert.equal(Boolean(value), true, `Missing button ${label}`);
    return value!;
  };
  const input = (): HTMLInputElement => {
    const value = document.querySelector<HTMLInputElement>("dialog[open] #crystal-seed-name");
    assert.equal(Boolean(value), true, "The actual seed input is in the open dialog");
    return value!;
  };
  await step(() => root.render(React.createElement(CrystalDock, { onInsert: () => {} })));
  return {
    service, calls, input, button, close,
    async open() {
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="结晶"]');
      assert.equal(Boolean(trigger), true);
      await step(() => trigger!.click());
      await settleAvailable();
      assert.equal(Boolean(document.querySelector("dialog[open]")), true);
    },
    async fill(value: string) {
      const target = input();
      assert.equal(target.disabled, false);
      assert.equal(target.readOnly, false);
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      await step(() => {
        setter.call(target, value);
        target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.equal(input().value, value, "A real input event updates the controlled draft");
    },
    holdSeed() {
      assert.equal(Boolean(nextGate), false, "Only one next seed delivery is held");
      const gate: Gate = { ready: signal<Outcome>(), delivery: signal<void>(), released: false };
      nextGate = gate;
      gates.push(gate);
      return gate;
    },
    async submit() { await step(() => button("开始观察").click()); await settleAvailable(); },
    async release(gate: Gate) { await step(() => release(gate)); await settleAvailable(); },
    async closeDialog(method: "button" | "cancel") {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      assert.equal(Boolean(dialog), true);
      await step(() => {
        if (method === "cancel") dialog!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
        else {
          const closeButton = dialog!.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
          assert.equal(Boolean(closeButton), true, "Use the real DialogHeader close control");
          closeButton!.click();
        }
      });
      await step(() => t.mock.timers.tick(1_000));
      assert.equal(Boolean(document.querySelector("dialog[open]")), false);
    },
    async refresh() {
      const refresh = document.querySelector<HTMLButtonElement>('dialog[open] button[aria-label="刷新结晶"]');
      assert.equal(Boolean(refresh), true);
      await step(() => refresh!.click());
      await settleAvailable();
    },
    async rows() { return (await service.request({ action: "overview" })).overview.slots; },
    seedCount() { return calls.filter(call => call.request.action === "seed").length; },
    isSlotsFull(outcome: Outcome) { return !outcome.ok && outcome.error instanceof CrystalSlotsFullError; },
    alert() { return document.querySelector('dialog[open] [role="alert"]')?.textContent ?? ""; },
    hasDetail() { return Boolean(document.querySelector('dialog[open] [aria-label="结晶详情"]')); }
  };
}

test("successful seed reply preserves a later draft and that draft can be submitted", async t => {
  const h = await fixture(t);
  await h.open(); await h.fill("First topic");
  const gate = h.holdSeed(); await h.submit();
  assert.equal((await gate.ready.promise).ok, true);
  const stored = await h.rows();
  assert.equal(stored.length, 1); assert.equal(stored[0]!.name, "First topic");
  assert.equal(h.button("开始观察").disabled, true);
  await h.fill("Second topic");
  await h.submit();
  assert.equal(h.seedCount(), 1, "A busy submit cannot create a second seed");
  await h.release(gate);
  assert.equal(h.input().value, "Second topic", "The old success must not clear a later draft");
  assert.equal(h.button("开始观察").disabled, false);
  await h.submit();
  assert.equal(h.input().value, "", "An unchanged successful draft still clears");
  assert.equal(h.seedCount(), 2);
  const after = await h.rows();
  assert.equal(after.length, 2);
  assert.equal(after.filter(row => row.name === "First topic").length, 1);
  assert.equal(after.filter(row => row.name === "Second topic").length, 1);
});

test("editing back to the submitted text is still a new seed draft", async t => {
  const h = await fixture(t);
  await h.open(); await h.fill("Repeated text");
  const gate = h.holdSeed(); await h.submit();
  assert.equal((await gate.ready.promise).ok, true);
  await h.fill("Temporary replacement"); await h.fill("Repeated text");
  await h.release(gate);
  assert.equal(h.input().value, "Repeated text", "Draft ownership must not be inferred from equal strings");
  assert.equal(h.seedCount(), 1);
  assert.equal((await h.rows()).length, 1);
});

for (const method of ["button", "cancel"] as const) {
  test(`late seed success after ${method} close and reopen preserves the new draft and fresh overview`, async t => {
    const h = await fixture(t);
    await h.open(); await h.fill("Old opening");
    const gate = h.holdSeed(); await h.submit();
    assert.equal((await gate.ready.promise).ok, true);
    await h.closeDialog(method); await h.open();
    assert.equal(h.calls.at(-1)!.request.action, "overview");
    assert.equal(h.hasDetail(), false);
    await h.fill("New opening");
    await h.release(gate);
    assert.equal(h.input().value, "New opening", "A closed dialog's request cannot clear the reopened draft");
    assert.equal(h.hasDetail(), false, "The existing generation guard still rejects the stale detail");
    assert.equal(h.alert(), "");
    assert.equal(h.button("开始观察").disabled, false);
    const rows = await h.rows();
    assert.equal(rows.length, 1); assert.equal(rows[0]!.name, "Old opening");
  });
}

test("an unchanged successful seed clears only after actual persistence and reply", async t => {
  const h = await fixture(t);
  await h.open(); await h.fill("  Unchanged topic  ");
  const gate = h.holdSeed(); await h.submit();
  assert.equal((await gate.ready.promise).ok, true);
  assert.equal(h.input().value, "  Unchanged topic  ");
  assert.equal((await h.rows())[0]!.name, "Unchanged topic");
  await h.release(gate);
  assert.equal(h.input().value, "");
  assert.equal(h.hasDetail(), true);
  assert.equal(h.button("开始观察").disabled, true);
  assert.equal(h.seedCount(), 1);
});

test("real slot-full rejection preserves the continued draft and permits a later retry", async t => {
  const h = await fixture(t);
  await h.open(); await h.fill("Rejected topic");
  for (const name of ["Occupied one", "Occupied two", "Occupied three"]) await h.service.request({ action: "seed", name });
  const gate = h.holdSeed(); await h.submit();
  assert.equal(h.isSlotsFull(await gate.ready.promise), true, "The real service rejects the stale capacity view");
  await h.fill("Retry topic"); await h.release(gate);
  assert.equal(h.input().value, "Retry topic");
  assert.equal(h.alert().length > 0, true);
  const full = await h.rows(); assert.equal(full.length, 3);
  assert.equal(full.some(row => row.name === "Rejected topic" || row.name === "Retry topic"), false);
  await h.service.request({ action: "slot", id: full[0]!.id, slot: null });
  await h.refresh();
  assert.equal(h.input().value, "Retry topic");
  assert.equal(h.alert(), "");
  await h.submit();
  assert.equal(h.input().value, "");
  assert.equal((await h.rows()).filter(row => row.name === "Retry topic").length, 1);
  assert.equal(h.seedCount(), 2);
});

test("a stale real rejection cannot clear the reopened draft or replace its error state", async t => {
  const h = await fixture(t);
  await h.open(); await h.fill("Rejected old opening");
  for (const name of ["Full one", "Full two", "Full three"]) await h.service.request({ action: "seed", name });
  const gate = h.holdSeed(); await h.submit();
  assert.equal(h.isSlotsFull(await gate.ready.promise), true);
  await h.closeDialog("button"); await h.open();
  await h.fill("New draft after rejection");
  await h.release(gate);
  assert.equal(h.input().value, "New draft after rejection");
  assert.equal(h.alert(), "");
  assert.equal(h.hasDetail(), false);
  assert.equal((await h.rows()).length, 3);
  assert.equal(h.seedCount(), 1);
});
