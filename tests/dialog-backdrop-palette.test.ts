import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { applyAppearance } from "../src/desktop/renderer/src/appearance.js";

const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, renderer), "utf8");
const token = "--dialog-overlay-strong";
const backdrop = /\.cu-confirm::backdrop\s*\{\s*background:\s*([^;]+);\s*\}/u;

test("revoke confirmation backdrop consumes the shared strong dialog overlay", () => {
  assert.equal(backdrop.exec(read("styles/biny.css"))?.[1], `var(${token})`);
  assert.match(read("components/settings/SettingsComputerUse.tsx"), /<dialog[^>]*className="cu-confirm"/u);
});

test("strong dialog overlay stays exactly 40% in both default modes", () => {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => { errors.push(error.message); });
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://biny.invalid", virtualConsole });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  try {
    const layers = read("styles/layers.css");
    const sources = [
      ...[...layers.matchAll(/@import "(\.\.?\/[^"]+\.css)"/gu)].map(entry => readFileSync(new URL(entry[1]!, new URL("styles/layers.css", renderer)), "utf8"))
    ];
    for (const source of sources) {
      const style = dom.window.document.createElement("style");
      style.textContent = source;
      dom.window.document.head.append(style);
    }
    assert.deepEqual(errors, []);
    const root = dom.window.document.documentElement;
    const check = (mode: "light" | "dark"): void => {
      dom.window.matchMedia = () => ({ matches: mode === "dark" }) as MediaQueryList;
      applyAppearance(root, { themePreference: "system", fontPreference: { family: "system", size: 14 } });
      assert.equal(root.dataset.theme, mode, mode);
      assert.equal(root.style.getPropertyValue(token), "", `${mode}: default mode keeps the shared fallback`);
      // JSDOM exposes root custom properties, but does not render ::backdrop.
      const computed = dom.window.getComputedStyle(root);
      assert.match(computed.getPropertyValue(token).trim(), /^rgb\(0 0 0\s*\/\s*40%\)$/u, mode);
      assert.match(computed.getPropertyValue("--dialog-overlay").trim(), /^rgb\(0 0 0\s*\/\s*30%\)$/u, `${mode}: ordinary dialogs stay unchanged`);
    };
    for (const mode of ["light", "dark"] as const) check(mode);
  } finally {
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("existing ordinary dialog backdrops retain their separate 30% token", () => {
  assert.match(read("styles/theme.css"), /--dialog-overlay:\s*rgb\(0 0 0 \/ 30%\);/u);
  for (const file of ["styles.css"]) {
    assert.match(read(file), /background:\s*var\(--dialog-overlay\)/u, file);
    assert.doesNotMatch(read(file), /var\(--dialog-overlay-strong\)/u, file);
  }
});
