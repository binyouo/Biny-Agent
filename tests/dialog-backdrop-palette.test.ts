import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { cloneAppearanceTheme } from "../src/appearance/editing.js";
import { DEFAULT_APPEARANCE } from "../src/appearance/preferences.js";
import { resolveAppearance } from "../src/appearance/resolve.js";
import { applyAppearance } from "../src/desktop/renderer/src/appearance.js";

const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, renderer), "utf8");
const token = "--dialog-overlay-strong";
const backdrop = /\.cu-confirm::backdrop\s*\{\s*background:\s*([^;]+);\s*\}/u;

test("revoke confirmation backdrop consumes the shared strong dialog overlay", () => {
  assert.equal(backdrop.exec(read("styles/biny.css"))?.[1], `var(${token})`);
  assert.match(read("components/settings/SettingsComputerUse.tsx"), /<dialog[^>]*className="cu-confirm"/u);
});

test("strong dialog overlay stays exactly 40% across defaults, built-ins, custom themes and resets", () => {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => { errors.push(error.message); });
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://biny.invalid", virtualConsole });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  try {
    const layers = read("styles/layers.css");
    const sources = [
      ...[...layers.matchAll(/@import "(\.\.?\/[^"]+\.css)"/gu)].map(entry => readFileSync(new URL(entry[1]!, new URL("styles/layers.css", renderer)), "utf8")),
      read("styles/retro.css"), read("styles/retro-layout.css")
    ];
    for (const source of sources) {
      const style = dom.window.document.createElement("style");
      style.textContent = source;
      dom.window.document.head.append(style);
    }
    assert.deepEqual(errors, []);
    const root = dom.window.document.documentElement;
    const check = (preference: typeof DEFAULT_APPEARANCE, mode: "light" | "dark", label: string): void => {
      const appearance = resolveAppearance(preference, "system", mode === "dark");
      applyAppearance(root, { themePreference: "system", appearancePreference: preference, fontPreference: { family: "system", size: 14 } }, appearance);
      assert.equal(root.dataset.theme, mode, label);
      assert.equal(root.dataset.appearanceSkin, appearance.skin, label);
      assert.equal(root.style.getPropertyValue(token), "", `${label}: palette projection keeps the shared fallback`);
      // JSDOM exposes root custom properties, but does not render ::backdrop.
      const computed = dom.window.getComputedStyle(root);
      assert.match(computed.getPropertyValue(token).trim(), /^rgb\(0 0 0\s*\/\s*40%\)$/u, label);
      assert.match(computed.getPropertyValue("--dialog-overlay").trim(), /^rgb\(0 0 0\s*\/\s*30%\)$/u, `${label}: ordinary dialogs stay unchanged`);
    };
    for (const mode of ["light", "dark"] as const) check(DEFAULT_APPEARANCE, mode, `default/${mode}`);
    const skins = new Set<string>();
    for (const [id, palette] of Object.entries(BUILTIN_PALETTES)) {
      const preference = { ...DEFAULT_APPEARANCE, [`${palette.type}Theme`]: id };
      check(preference, palette.type, id);
      skins.add(root.dataset.appearanceSkin!);
      const custom = cloneAppearanceTheme(palette, `copy-${id}`, `Copy ${id}`);
      check({ ...DEFAULT_APPEARANCE, [`${palette.type}Theme`]: `custom:${custom.name}`, customThemes: [custom] }, palette.type, `custom/${id}`);
      assert.equal(root.dataset.appearanceSkin, "default", `custom/${id}`);
    }
    assert.deepEqual([...skins].sort(), ["default", "longhorn", "longhorn-dark", "win98", "winxp"]);
    for (const mode of ["dark", "light"] as const) check(DEFAULT_APPEARANCE, mode, `reset/${mode}`);
  } finally {
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("existing ordinary dialog backdrops retain their separate 30% token", () => {
  assert.match(read("styles/theme.css"), /--dialog-overlay:\s*rgb\(0 0 0 \/ 30%\);/u);
  for (const file of ["styles.css", "styles/appearance.css"]) {
    assert.match(read(file), /background:\s*var\(--dialog-overlay\)/u, file);
    assert.doesNotMatch(read(file), /var\(--dialog-overlay-strong\)/u, file);
  }
});
