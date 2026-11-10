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

function contrast(foreground: string, background: string, surface = "#ffffff"): number {
  const rgba = (value: string): readonly [number, number, number, number] => {
    if (/^#[\da-f]{6}$/iu.test(value)) {
      const channels = value.slice(1).match(/../gu)!.map(channel => Number.parseInt(channel, 16));
      return [channels[0]!, channels[1]!, channels[2]!, 1];
    }
    const match = /^rgb\((\d+) (\d+) (\d+) \/ (\d+(?:\.\d+)?)%\)$/u.exec(value);
    assert.ok(match, `unsupported color: ${value}`);
    const channels = match.slice(1, 4).map(Number);
    const alpha = Number(match[4]) / 100;
    assert.ok(channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1, value);
    return [channels[0]!, channels[1]!, channels[2]!, alpha];
  };
  const over = (front: readonly number[], back: readonly number[]): number[] =>
    [0, 1, 2].map(index => front[index]! * front[3]! + back[index]! * (1 - front[3]!));
  const backing = rgba(surface);
  assert.equal(backing[3], 1, "contrast requires an opaque backing surface");
  const renderedBackground = over(rgba(background), backing);
  const renderedForeground = over(rgba(foreground), renderedBackground);
  const luminance = (rgb: readonly number[]): number => {
    const channels = rgb.map((channel) => {
      const component = channel / 255;
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const first = luminance(renderedForeground);
  const second = luminance(renderedBackground);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("contrast calculation composes transparent colors over an opaque surface", () => {
  assert.equal(contrast("#000000", "rgb(0 188 125 / 0%)", "#ffffff"), 21);
  assert.equal(contrast("#ffffff", "rgb(0 188 125 / 0%)", "#000000"), 21);
  assert.equal(contrast("rgb(0 0 0 / 0%)", "#ffffff"), 1);
  assert.ok(Math.abs(contrast("#000000", "rgb(0 0 0 / 50%)") - 5.280822809644651) < 1e-12);
  for (const value of ["#fff", "transparent", "rgb(256 0 0 / 10%)", "rgb(0 0 0 / 101%)"]) {
    assert.throws(() => contrast("#000000", value), assert.AssertionError, value);
  }
  assert.throws(() => contrast("#000000", "#ffffff", "rgb(0 0 0 / 50%)"), /opaque backing surface/u);
});

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
  for (const file of ["../electron/main/window.ts", "../electron/main/ipc.ts"]) {
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
});

test("quick chat uses the same message surfaces and primary-button foreground", () => {
  assert.equal(declaration(quickchat, ".quickchat-message-user", "background"), "var(--user-bubble)");
  assert.equal(declaration(quickchat, ".quickchat-message-user", "color"), "var(--text)");
  assert.equal(declaration(quickchat, ".quickchat-send", "color"), "var(--accent-foreground)");
  assert.equal(declaration(quickchat, ".quickchat-send:disabled", "background"), "var(--surface-soft)");
  assert.match(read("main.tsx"), /styles\/layers\.css/u);
  assert.match(read("App.tsx"), /QuickChatApp/u);
});

test("field focus rings stay neutral in light mode and use a faint accent in dark mode", () => {
  assert.equal(declaration(theme, ":root", "--field-focus-ring"), "light-dark(color-mix(in srgb, var(--border-strong) 40%, transparent), color-mix(in srgb, var(--accent) 10%, transparent))");
  assert.equal(declaration(desktop, ".desktop-settings-dialog", "--st-field-ring"), "var(--field-focus-ring)");
  for (const selector of [
    ".biny-workspace-context-create > input:focus",
    ".biny-queued-message-row > textarea:focus",
    ".biny-mcp-search:focus-within",
    ".biny-mcp-field input:not(.settings-field):focus",
    ".biny-mcp-field textarea:not(.settings-field):focus",
    ".biny-mcp-install-fields > select:not(.settings-field):focus",
    ".biny-mcp-install-parameters input:not(.settings-field):focus",
    ".settings-extension-search:focus-within",
    ".inspector-file-filter:focus-within",
    ".provider-json-editor:focus",
    ".permission-confirmation input:focus-visible"
  ]) assert.equal(declaration(desktop, selector, "box-shadow"), "inset 0 0 0 1px var(--field-focus-ring)", selector);
});

test("search, preference and dialog fields use inset rings without offset outlines", () => {
  for (const [selector, token, width] of [
    [".settings-search:focus-within", "--st-field-ring", 2],
    [".settings-search-field:focus-within", "--st-field-ring", 2],
    [".settings-field:focus-visible", "--st-field-ring", 1],
    [".provider-manual-row input:focus", "--st-field-ring", 1],
    ['.settings-preferences :is(select, input[type="number"]):focus-visible', "--st-field-ring", 1],
    [".provider-dialog input:focus-visible", "--field-focus-ring", 1],
    [".provider-dialog select:focus-visible", "--field-focus-ring", 1],
    [".inspector-browser-address:focus-within", "--field-focus-ring", 1],
    [".desktop-dialog-content .astryx-text-input:focus-within", "--field-focus-ring", 1]
  ] as const) {
    assert.equal(declaration(desktop, selector, "box-shadow"), `inset 0 0 0 ${width}px var(${token})`, selector);
    const outline = declaration(desktop, selector, "outline");
    assert.ok(outline === undefined || outline === "none" || outline === "0", `${selector}: ${outline}`);
  }
  assert.equal(declaration(quickchat, ".quickchat-input:focus", "box-shadow"), "inset 0 0 0 1px var(--field-focus-ring)");
  assert.equal(declaration(quickchat, ".quickchat-input", "border"), "1px solid var(--quickchat-border)");
  assert.equal(declaration(desktop, ".desktop-dialog-content .astryx-text-input input:focus-visible", "outline"), "none");
});

test("Appshot shortcut select keeps its neutral border with a translucent keyboard focus ring", () => {
  assert.equal(declaration(desktop, ".appshot-settings .appshot-select select", "border"), "1px solid var(--border-subtle)");
  assert.equal(declaration(desktop, ".appshot-settings .appshot-select select:focus-visible", "border-color"), undefined);
  assert.equal(declaration(desktop, ".appshot-settings .appshot-select select:focus-visible", "box-shadow"), "inset 0 0 0 1px var(--field-focus-ring)");
  assert.equal(declaration(desktop, ".appshot-settings .appshot-select select:focus-visible", "outline"), "none");
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

test("field focus retains editor elevation and keeps picker rings attached", () => {
  assert.equal(declaration(desktop, ".user-message-editor", "box-shadow"), "var(--biny-shadow)");
  assert.equal(declaration(desktop, ".user-message-editor:focus-within", "box-shadow"), "inset 0 0 0 1px var(--field-focus-ring), var(--biny-shadow)");
  const picker = ".desktop-settings-dialog .settings-modal .settings-model-picker-trigger:focus-visible";
  assert.equal(declaration(desktop, picker, "box-shadow"), "inset 0 0 0 1px var(--st-field-ring)");
  assert.equal(declaration(desktop, picker, "outline"), "none");
});

test("action controls retain explicit keyboard focus indicators", () => {
  for (const [selector, expected] of [
    [".biny-composer-action:focus-visible", "1px solid var(--biny-focus)"],
    [".settings-search button:focus-visible", "1px solid var(--st-field-ring)"],
    [".provider-dialog summary:focus-visible", "1px solid var(--accent)"],
    [".settings-action:focus-visible", "1px solid var(--accent)"],
    [".settings-switch:focus-visible", "1px solid var(--accent)"]
  ] as const) {
    assert.equal(declaration(desktop, selector, "outline"), expected, selector);
    assert.ok(Number.parseFloat(declaration(desktop, selector, "outline-offset") ?? "0") <= 0, selector);
  }
  for (const selector of [".settings-page-footer button:focus-visible", ".settings-confirm-actions button:focus-visible"]) {
    assert.equal(declaration(desktop, selector, "box-shadow"), "none", selector);
  }
});

test("all product styles use the shared palette rather than local literals or missing aliases", () => {
  const productStyles = readdirSync(new URL("styles/", renderer)).filter((name) => name.endsWith(".css") && name !== "theme.css")
    .map((name) => ({ name, source: read(`styles/${name}`) }));
  for (const entry of [...productStyles, { name: "legacy", source: read("styles.css") }, { name: "quickchat", source: quickchat }]) {
    assert.doesNotMatch(entry.source, /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/iu, entry.name);
    assert.doesNotMatch(entry.source, /var\(--(?:foreground|muted-foreground|text-primary|yellow|biny-backdrop)\b/u, entry.name);
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
    ]) assert.ok(contrast(color(foreground!, mode), color(background!, mode), color("--surface-raised", mode)) >= 4.5, `${mode}: ${foreground} on ${background}`);
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

test("project creation uses the shared field ring and primary foreground", () => {
  assert.equal(declaration(desktop, ".biny-project-create-dialog input", "border"), "1px solid var(--biny-border)");
  assert.equal(declaration(desktop, ".biny-project-create-dialog input:focus-visible", "box-shadow"), "inset 0 0 0 1px var(--field-focus-ring)");
  assert.equal(declaration(desktop, ".biny-project-create-dialog footer button.is-primary", "color"), "var(--accent-foreground)");
  assert.doesNotMatch(read("styles/biny.css"), /--biny-on-accent/u);
});

test("savings colors and shadow tokens preserve the existing visual palette", () => {
  for (const [name, expected] of Object.entries({ emerald: "#10b981", cyan: "#06b6d4", blue: "#3b82f6", violet: "#8b5cf6",
    fuchsia: "#d946ef", amber: "#f59e0b", rose: "#f43f5e", teal: "#14b8a6" })) {
    assert.equal(declaration(desktop, `.savings-${name}`, "color"), `var(--savings-${name})`);
    for (const mode of ["light", "dark"] as const) assert.equal(color(`--savings-${name}`, mode), expected);
  }
  for (const mode of ["light", "dark"] as const) {
    assert.equal(color("--savings-card-shadow", mode), "rgb(0 0 0 / 5%)");
    assert.equal(color("--savings-tooltip-shadow", mode), "rgb(0 0 0 / 10%)");
  }
});

test("seasonal snow colors retain exact alpha through the shared palette", () => {
  const background = declaration(desktop, '.message-timeline[data-christmas="true"]::before', "background-image");
  for (const [name, alpha] of [["near", 78], ["middle", 65], ["far", 55]] as const) {
    assert.ok(background?.includes(`var(--christmas-snow-${name})`));
    for (const mode of ["light", "dark"] as const) assert.equal(color(`--christmas-snow-${name}`, mode), `rgb(255 255 255 / ${alpha}%)`);
  }
});
