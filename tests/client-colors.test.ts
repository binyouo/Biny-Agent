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
    const selectors = entry[1]!.replace(/\/\*[\s\S]*?\*\//gu, "").trim().split(/,\s*/u);
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
    ["light", "#4f46e5", "#189a58", "#ecebfb"],
    ["dark", "#a5b4fc", "#6fd99b", "#33345a"]
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
    ]) assert.ok(contrast(color(foreground!, mode), color(background!, mode)) >= 4.5, `${mode}: ${foreground} on ${background}`);
  }
});

test("terminal UI palettes share the neutral surfaces and emphasis family", () => {
  for (const [definition, page, surface, accent, selected] of [
    [lightTheme, "#f4f4f6", "#f1f1f4", "#4f46e5", "#ecebfb"],
    [darkTheme, "#1a1a1e", "#232327", "#a5b4fc", "#33345a"]
  ] as const) {
    const terminal = new Theme(definition, "truecolor");
    assert.equal(definition.export?.pageBg, page);
    assert.equal(terminal.color("userMessageBg"), surface);
    assert.equal(terminal.color("accent"), accent);
    assert.equal(terminal.color("selectedBg"), selected);
  }
});
