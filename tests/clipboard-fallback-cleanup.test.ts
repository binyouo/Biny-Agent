import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { copyToClipboard } from "../src/desktop/renderer/src/copyToClipboard.js";

function installDom(dom: JSDOM): () => void {
  const descriptors = new Map(["document", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

for (const failingStep of ["focus", "select", "setSelectionRange", "execCommand"] as const) {
  test(`fallback removes its temporary textarea when ${failingStep} throws`, async () => {
    const dom = new JSDOM("<button id='copy'>Copy</button><textarea id='draft'>keep draft</textarea>");
    const restore = installDom(dom);
    try {
      const { document } = dom.window;
      const button = document.getElementById("copy") as HTMLButtonElement;
      button.focus();
      if (failingStep === "execCommand") {
        Object.defineProperty(document, "execCommand", { value: () => { throw new Error("clipboard unavailable"); } });
      } else {
        Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, failingStep, { value: () => { throw new Error("selection unavailable"); } });
      }
            for (let attempt = 0; attempt < 3; attempt++) {
        assert.equal(await copyToClipboard("private copied text"), false);
        assert.equal(document.querySelectorAll("textarea").length, 1, "failed copies must not accumulate hidden textareas");
        assert.equal((document.getElementById("draft") as HTMLTextAreaElement).value, "keep draft");
        assert.equal(document.activeElement, button);
      }
    } finally { restore(); dom.window.close(); }
  });
}

for (const outcome of [true, false, "throw"] as const) {
  test(`fallback preserves newer focus and removes only its node (${outcome})`, async () => {
    const dom = new JSDOM("<button id='copy'>Copy</button><input id='other'>");
    const restore = installDom(dom);
    try {
      const { document } = dom.window;
      document.getElementById("copy")!.focus();
      const other = document.getElementById("other")!;
      Object.defineProperty(document, "execCommand", { value: () => { other.focus(); if (outcome === "throw") throw new Error("copy failed"); return outcome; } });
            assert.equal(await copyToClipboard("text"), outcome === true);
      assert.equal(document.querySelectorAll("textarea").length, 0);
      assert.equal(document.activeElement, other);
    } finally { restore(); dom.window.close(); }
  });
}
