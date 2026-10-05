import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SettingsComputerUse } from "../src/desktop/renderer/src/components/settings/SettingsComputerUse.js";

test("revoke uses a modal, remains open while pending or failed, and Escape restores focus", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const diagnostic = { approvals: [{ bundleId: "test.notes", appName: "Notes", approvedAt: new Date().toISOString(), useCount: 2 }], audit: [], permissions: { accessibility: "granted", screenRecording: "granted" } };
  let reject!: (error: Error) => void; const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  const status = { state: "ready", preview: true, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  const noop = async () => status;
  Object.assign(dom.window, { binyComputer: { status: noop, enable: noop, control: noop, preview: noop, foreground: noop, logging: noop, diagnostics: async () => diagnostic, requestAccessibility: async () => diagnostic, testSetup: async () => diagnostic, strict: async () => diagnostic, approve: async () => diagnostic, revoke: () => pending } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(SettingsComputerUse)));
    const trigger = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "撤销授权")!;
    trigger.focus(); await act(async () => trigger.click());
    const modal = dom.window.document.querySelector<HTMLDialogElement>('dialog[data-confirm-revoke]'); assert.ok(modal?.open);
    const confirm = [...modal.querySelectorAll("button")].find(button => button.textContent === "确认撤销")!;
    await act(async () => { confirm.click(); }); assert.equal(modal.open, true); assert.equal(confirm.disabled, true);
    const blockedEscape = new dom.window.Event("cancel", { cancelable: true }); await act(async () => modal.dispatchEvent(blockedEscape)); assert.equal(blockedEscape.defaultPrevented, true); assert.equal(modal.open, true);
    await act(async () => reject(new Error("save_failed"))); assert.equal(modal.open, true); assert.match(modal.textContent ?? "", /save_failed/);
    await act(async () => modal.dispatchEvent(new dom.window.Event("cancel", { cancelable: true })));
    assert.equal(dom.window.document.querySelector('dialog[data-confirm-revoke]'), null); assert.equal(dom.window.document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
