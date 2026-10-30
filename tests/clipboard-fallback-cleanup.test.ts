import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../src/desktop/renderer/src/copyToClipboard.ts", import.meta.url), "utf8");
const code = stripTypeScriptTypes(source.replace("export async function", "async function"));

for (const failingStep of ["focus", "select", "setSelectionRange", "execCommand"] as const) {
  test(`fallback removes its temporary textarea when ${failingStep} throws`, async () => {
    const dom = new JSDOM("<button id='copy'>Copy</button><textarea id='draft'>keep draft</textarea>");
    try {
      const { document } = dom.window;
      const button = document.getElementById("copy") as HTMLButtonElement;
      button.focus();
      if (failingStep === "execCommand") {
        Object.defineProperty(document, "execCommand", { value: () => { throw new Error("clipboard unavailable"); } });
      } else {
        Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, failingStep, { value: () => { throw new Error("selection unavailable"); } });
      }
      const context = vm.createContext({ document, navigator: {} });
      vm.runInContext(code, context);
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.equal(await vm.runInContext('copyToClipboard("private copied text")', context), false);
        assert.equal(document.querySelectorAll("textarea").length, 1, "failed copies must not accumulate hidden textareas");
        assert.equal((document.getElementById("draft") as HTMLTextAreaElement).value, "keep draft");
        assert.equal(document.activeElement, button);
      }
    } finally { dom.window.close(); }
  });
}

for (const outcome of [true, false, "throw"] as const) {
  test(`fallback preserves newer focus and removes only its node (${outcome})`, async () => {
    const dom = new JSDOM("<button id='copy'>Copy</button><input id='other'>");
    try {
      const { document } = dom.window;
      document.getElementById("copy")!.focus();
      const other = document.getElementById("other")!;
      Object.defineProperty(document, "execCommand", { value: () => { other.focus(); if (outcome === "throw") throw new Error("copy failed"); return outcome; } });
      const context = vm.createContext({ document, navigator: {} });
      vm.runInContext(code, context);
      assert.equal(await vm.runInContext('copyToClipboard("text")', context), outcome === true);
      assert.equal(document.querySelectorAll("textarea").length, 0);
      assert.equal(document.activeElement, other);
    } finally { dom.window.close(); }
  });
}
