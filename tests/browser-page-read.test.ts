import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { WebContents } from "electron";
import { loadUntilDomReady } from "../src/desktop/electron/main/browserPageRead.js";

test("parsed-document readiness belongs to the committed navigation and does not wait for deferred scripts", async () => {
  const page = new EventEmitter() as WebContents;
  let finish!: () => void;
  page.loadURL = () => new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  const navigation = loadUntilDomReady(page, "https://example.org", AbortSignal.timeout(1000), async () => {
    reads++;
    return "interactive";
  });
  let settled = false;
  void navigation.then(() => { settled = true; });
  page.emit("dom-ready"); // A previous about:blank document cannot finish this navigation.
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(reads, 0);
  assert.equal(page.listenerCount("did-navigate"), 1);
  page.emit("did-navigate", {}, "https://example.org", 200);
  await navigation;
  assert.equal(reads, 1);
  assert.equal(page.listenerCount("did-navigate"), 0);
  assert.equal(page.listenerCount("dom-ready"), 0);
  finish();
});

test("cancelling parsed-document readiness removes listeners and ignores a late read", async () => {
  const page = new EventEmitter() as WebContents;
  let failLoad!: (error: Error) => void;
  page.loadURL = () => new Promise<void>((_resolve, reject) => { failLoad = reject; });
  let completeRead!: (state: string) => void;
  const controller = new AbortController();
  const navigation = loadUntilDomReady(page, "https://example.org", controller.signal,
    () => new Promise(resolve => { completeRead = resolve; }));
  page.emit("did-navigate", {}, "https://example.org", 200);
  controller.abort(new Error("cancelled navigation"));
  await assert.rejects(navigation, /cancelled navigation/u);
  assert.equal(page.listenerCount("did-navigate"), 0);
  assert.equal(page.listenerCount("dom-ready"), 0);
  completeRead("interactive");
  failLoad(new Error("page closed after cancellation"));
});
