import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { darkTheme, lightTheme } from "../src/tui/theme/palettes.js";
import { Theme } from "../src/tui/theme/theme.js";

const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, renderer), "utf8");
const theme = read("styles/theme.css");
const layers = read("styles/layers.css");
const styles = [...layers.matchAll(/@import "(\.\.?\/[^"]+\.css)"/gu)].map((entry) => ({
  name: entry[1]!,
  source: readFileSync(new URL(entry[1]!, new URL("styles/layers.css", renderer)), "utf8")
}));
const desktop = styles.map((entry) => entry.source).join("\n");
const quickchat = read("quickchat/quickchat.css");

function declaration(source: string, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const entry of source.matchAll(/([^{}]+)\{([^{}]+)\}/gu)) {
    const selectors = entry[1]!.replace(/\/\*[\s\S]*?\*\//gu, "").trim().split(/,(?![^()]*\))\s*/u);
    if (!selectors.includes(selector)) continue;
    const declarations = new Map([...entry[2]!.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/gu)]
      .map((item) => [item[1]!, item[2]!.trim()]));
    value = declarations.get(property) ?? value;
  }
  return value;
}

function color(token: string, mode: "light" | "dark"): string {
  const value = [...theme.matchAll(new RegExp(`${token}:\\s*([^;]+);`, "gu"))].at(-1)?.[1]?.trim();
  assert.ok(value, token);
  const alias = /^var\((--[\w-]+)\)$/u.exec(value);
  if (alias) return color(alias[1]!, mode);
  const pair = /^light-dark\((#[\da-f]+),\s*(#[\da-f]+)\)$/iu.exec(value);
  return pair ? pair[mode === "light" ? 1 : 2]! : value;
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    assert.match(hex, /^#[\da-f]{6}$/iu);
    const channels = hex.slice(1).match(/../gu)!.map((channel) => {
      const component = Number.parseInt(channel, 16) / 255;
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("shared light and dark palettes separate emphasis from health indicators", () => {
  for (const [mode, accent, green, selected] of [
    ["light", "#0f5fa8", "#00bc7d", "#e9e9e9"],
    ["dark", "#74b6fb", "#00bc7d", "#343434"]
  ] as const) {
    assert.equal(color("--accent", mode), accent);
    assert.equal(color("--green", mode), green);
    assert.equal(color("--surface-selected", mode), selected);
    assert.notEqual(color("--accent", mode), color("--green", mode));
    assert.equal(color("--color-on-accent", mode), color("--accent-foreground", mode));
    assert.equal(color("--color-text-green", mode), color("--green-text", mode));
  }
  assert.match(layers, /@import "\.\/theme\.css" layer\(desktop\)/u);
});

test("default chrome uses neutral surfaces and ink with blue rather than violet emphasis", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const token of ["--bg", "--sidebar", "--surface", "--surface-raised", "--surface-soft", "--surface-hover", "--surface-selected", "--code", "--user-bubble", "--text", "--text-secondary", "--text-tertiary", "--border", "--border-subtle", "--border-strong", "--accent-foreground"]) {
      const channels = color(token, mode).slice(1).match(/../gu)!.map(channel => Number.parseInt(channel, 16));
      assert.equal(channels[0], channels[1], `${mode}: ${token}`);
      assert.equal(channels[1], channels[2], `${mode}: ${token}`);
    }
    for (const token of ["--accent", "--accent-hover", "--accent-soft", "--text-selection"]) {
      const channels = color(token, mode).slice(1).match(/../gu)!.map(channel => Number.parseInt(channel, 16));
      assert.ok(channels[0]! < channels[1]! && channels[1]! < channels[2]!, `${mode}: ${token} is blue`);
    }
    assert.ok(contrast(color("--surface-raised", mode), "#000000") > contrast(color("--bg", mode), "#000000"), `${mode}: reading surfaces sit above the canvas`);
  }
  for (const file of ["../electron/main/window.ts", "../electron/main/ipc.ts", "../electron/main/index.ts"]) {
    const source = readFileSync(new URL(file, new URL("../", renderer)), "utf8");
    assert.ok(source.includes(color("--bg", "light")), file);
    assert.ok(source.includes(color("--bg", "dark")), file);
    assert.doesNotMatch(source, /#f4f4f6|#1a1a1e/iu, file);
  }
});

test("inset sidebar surface stays inside the card rather than coloring the window gutter", () => {
  for (const mode of ["light", "dark"] as const) {
    assert.equal(color("--biny-backplate", mode), color("--biny-surface", mode), `${mode}: the gutter belongs to the main canvas`);
    assert.equal(color("--biny-sidebar-surface", mode), color("--sidebar", mode));
    assert.notEqual(color("--biny-sidebar-surface", mode), color("--biny-backplate", mode));
  }
});

test("provider, session, extension and execution states keep their semantic colors", () => {
  for (const [selector, property, expected] of [
    [".provider-status-dot.is-ok", "background", "var(--green)"],
    [".provider-status-dot.is-warn", "background", "var(--amber)"],
    [".provider-status-dot.is-error", "background", "var(--red)"],
    [".desktop-session-status-dot.is-running", "background", "var(--color-accent)"],
    [".desktop-session-status-dot.is-completed", "background", "var(--green)"],
    [".desktop-session-status-dot.is-waiting_permission", "background", "var(--amber)"],
    [".desktop-session-status-dot.is-blocked", "background", "var(--amber)"],
    [".desktop-session-status-dot.is-incomplete", "background", "var(--amber)"],
    [".desktop-session-status-dot.is-failed", "background", "var(--red)"],
    [".biny-mcp-status.is-connected", "color", "var(--biny-success)"],
    [".biny-plugin-status.is-ready", "color", "var(--biny-success)"],
    [".biny-mcp-test-result.is-error", "color", "var(--biny-danger)"],
    [".biny-mcp-test-result.is-error", "background", "var(--biny-danger-bg)"],
    [".trace-status.is-completed", "color", "var(--biny-success)"],
    [".trace-status.is-blocked", "color", "var(--biny-warning)"],
    [".trace-status.is-incomplete", "color", "var(--biny-warning)"],
    [".status-pill.is-muted", "color", "var(--text-secondary)"]
  ]) assert.equal(declaration(desktop, selector!, property!), expected, selector);
  const provider = read("components/settings/ProviderSettings.tsx");
  assert.match(provider, /showInPicker !== false\) \? " is-ok" : " is-muted"/u);
});

test("quick chat uses the same message surfaces and primary-button foreground", () => {
  assert.equal(declaration(quickchat, ".quickchat-message-user", "background"), "var(--user-bubble)");
  assert.equal(declaration(quickchat, ".quickchat-message-user", "color"), "var(--text)");
  assert.equal(declaration(quickchat, ".quickchat-send", "color"), "var(--accent-foreground)");
  assert.equal(declaration(quickchat, ".quickchat-send:disabled", "background"), "var(--surface-soft)");
  assert.match(read("main.tsx"), /styles\/layers\.css/u);
  assert.match(read("App.tsx"), /QuickChatApp/u);
});

test("focused text fields and input wrappers do not add edge halos", () => {
  for (const entry of [...styles, { name: "quickchat", source: quickchat }]) {
    for (const rule of entry.source.matchAll(/([^{}]+)\{([^{}]+)\}/gu)) {
      const selector = rule[1]!.replace(/\/\*[\s\S]*?\*\//gu, "").trim();
      if (!selector.includes(":focus")) continue;
      if (/button:focus-visible|settings-switch-row:focus-visible|settings-model-picker-option:focus-visible|input\[type="range"\]/u.test(selector)) continue;
      const shadow = /(?:^|;)\s*box-shadow:\s*([^;]+)/u.exec(rule[2]!);
      if (shadow) assert.doesNotMatch(shadow[1]!, /\b0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+\S+/u, `${entry.name}: ${selector}`);
    }
  }
});

test("search, preference and dialog fields use focus borders without outer outlines", () => {
  for (const selector of [
    ".settings-search:focus-within",
    '.settings-preferences :is(select, input[type="number"]):focus-visible',
    ".provider-dialog input:focus-visible",
    ".provider-dialog select:focus-visible",
    ".inspector-browser-address:focus-within",
    ".user-message-editor:focus-within"
  ]) {
    assert.ok(declaration(desktop, selector, "border-color"), selector);
    const outline = declaration(desktop, selector, "outline");
    assert.ok(outline === undefined || outline === "none" || outline === "0", `${selector}: ${outline}`);
  }
  assert.ok(declaration(quickchat, ".quickchat-input:focus", "border-color"));
  assert.equal(declaration(desktop, ".desktop-dialog-content .astryx-text-input:focus-within", "box-shadow"), "none");
  assert.ok(declaration(desktop, ".desktop-dialog-content .astryx-text-input:focus-within", "border-color"));
});

test("client chat input has no outer shadow on its actual composer surface", () => {
  assert.match(read("components/Composer.tsx"), /<form\s+className=\{`biny-composer/u);
  assert.match(read("components/composer/PromptInput.tsx"), /<textarea[\s\S]*?className=\{`biny-prompt-textarea/u);
  assert.equal(declaration(desktop, ".biny-composer", "box-shadow"), "none");
  assert.equal(declaration(desktop, ".biny-prompt-textarea", "outline"), "0");
});

test("client chat input retains its neutral border when the textarea receives focus", () => {
  const border = declaration(desktop, ".biny-composer", "border");
  assert.equal(border, "1px solid var(--biny-border)");
  for (const selector of [
    ".biny-composer:has(textarea:focus-visible)",
    ".biny-composer:focus-within",
    ".biny-composer:focus-visible",
    ".biny-composer:focus"
  ]) {
    assert.equal(declaration(desktop, selector, "border") ?? border, border, selector);
    assert.equal(declaration(desktop, selector, "border-color") ?? "var(--biny-border)", "var(--biny-border)", selector);
    assert.equal(declaration(desktop, selector, "box-shadow") ?? declaration(desktop, ".biny-composer", "box-shadow"), "none", selector);
    assert.ok([undefined, "none", "0"].includes(declaration(desktop, selector, "outline")), selector);
  }
});

test("other input focus preserves normal elevation rather than replacing it with a glow", () => {
  for (const [base, focused] of [
    [".user-message-editor", ".user-message-editor:focus-within"],
    [".desktop-settings-dialog .settings-modal .settings-model-picker-trigger", ".desktop-settings-dialog .settings-modal .settings-model-picker-trigger:focus-visible"]
  ]) {
    const shadow = declaration(desktop, base!, "box-shadow");
    assert.ok(shadow, base);
    assert.equal(declaration(desktop, focused!, "box-shadow") ?? shadow, shadow, focused);
  }
});

test("removing field halos retains keyboard focus indicators on action controls", () => {
  for (const selector of [
    ".biny-composer-action:focus-visible",
    ".settings-search button:focus-visible",
    ".provider-dialog summary:focus-visible"
  ]) assert.match(declaration(desktop, selector, "outline") ?? "", /^\d+px solid var\(--(?:biny-focus|accent)\)$/u, selector);
});

test("all product styles use the shared palette rather than local literals or missing aliases", () => {
  const productStyles = readdirSync(new URL("styles/", renderer)).filter((name) => name.endsWith(".css") && !["theme.css", "retro.css"].includes(name))
    .map((name) => ({ name, source: read(`styles/${name}`) }));
  for (const entry of [...productStyles, { name: "legacy", source: read("styles.css") }, { name: "quickchat", source: quickchat }]) {
    assert.doesNotMatch(entry.source, /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/iu, entry.name);
    assert.doesNotMatch(entry.source, /var\(--(?:foreground|muted-foreground|text-primary|yellow|biny-backdrop)\b/u, entry.name);
  }
});

test("optional desktop skin palettes remain scoped to their explicit skin selectors", () => {
  for (const file of ["styles/retro.css", "styles/retro-layout.css"]) {
    const rules = [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/gu)];
    assert.ok(rules.length > 0);
    for (const rule of rules) {
      assert.match(rule[1]!, /:root[^{}]*\[data-appearance-skin=['"](?:win98|winxp|longhorn|longhorn-dark)['"]\]/u, file);
    }
  }
});

test("readable text, status labels and primary controls retain sufficient contrast in both modes", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const foreground of ["--text", "--text-secondary", "--text-tertiary"]) {
      for (const background of ["--bg", "--surface", "--surface-raised", "--surface-soft", "--surface-hover", "--surface-selected"]) {
        assert.ok(contrast(color(foreground, mode), color(background, mode)) >= 4.5, `${mode}: ${foreground} on ${background}`);
      }
    }
    for (const [foreground, background] of [
      ["--accent-foreground", "--accent"], ["--accent-foreground", "--accent-hover"],
      ["--green-text", "--green-bg"], ["--red-text", "--red-bg"], ["--amber-text", "--amber-bg"],
      ["--file-typescript-foreground", "--file-typescript"], ["--file-javascript-foreground", "--file-javascript"]
    ]) assert.ok(contrast(color(foreground!, mode), color(background!, mode)) >= 4.5, `${mode}: ${foreground} on ${background}`);
  }
});

test("terminal UI palettes share the neutral surfaces and emphasis family", () => {
  for (const [definition, page, surface, accent, selected] of [
    [lightTheme, "#f5f5f5", "#f0f0f0", "#0f5fa8", "#e9e9e9"],
    [darkTheme, "#1a1a1a", "#242424", "#74b6fb", "#343434"]
  ] as const) {
    const terminal = new Theme(definition, "truecolor");
    assert.equal(definition.export?.pageBg, page);
    assert.equal(terminal.color("userMessageBg"), surface);
    assert.equal(terminal.color("accent"), accent);
    assert.equal(terminal.color("selectedBg"), selected);
  }
});
