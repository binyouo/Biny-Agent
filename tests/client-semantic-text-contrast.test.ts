import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { DEFAULT_APPEARANCE } from "../src/appearance/preferences.js";
import { resolveAppearance } from "../src/appearance/resolve.js";
import { appearanceVariables } from "../src/desktop/renderer/src/appearance.js";

const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, renderer), "utf8");
const theme = read("styles/theme.css");
const styles = read("styles/biny.css");
const tokens = new Map([...theme.matchAll(/(?:^|;)\s*(--[\w-]+):\s*([^;]+);?/gmu)]
  .map(entry => [entry[1]!, entry[2]!.trim()]));
type Mode = "light" | "dark";
type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

function declaration(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of styles.matchAll(/([^{}]+)\{([^{}]+)\}/gu)) {
    const selectors = rule[1]!.replace(/\/\*[\s\S]*?\*\//gu, "").trim().split(/,\s*/u);
    if (!selectors.includes(selector)) continue;
    const declarations = new Map([...rule[2]!.matchAll(/(?:^|;)\s*([\w-]+):\s*([^;]+)/gu)]
      .map(entry => [entry[1]!, entry[2]!.trim()]));
    value = declarations.get(property) ?? value;
  }
  return value;
}

function resolve(value: string, mode: Mode, seen = new Set<string>()): string {
  const alias = /^var\((--[\w-]+)\)$/u.exec(value);
  if (alias) {
    const token = alias[1]!;
    assert.ok(!seen.has(token), `cyclic token: ${token}`);
    const next = tokens.get(token);
    assert.ok(next, `missing token: ${token}`);
    return resolve(next, mode, new Set([...seen, token]));
  }
  const pair = /^light-dark\((#[\da-f]{6}),\s*(#[\da-f]{6})\)$/iu.exec(value);
  return pair ? pair[mode === "light" ? 1 : 2]! : value;
}

function rgba(value: string): Rgba {
  if (/^#[\da-f]{6}$/iu.test(value)) {
    const rgb = value.slice(1).match(/../gu)!.map(channel => Number.parseInt(channel, 16));
    return [rgb[0]!, rgb[1]!, rgb[2]!, 1];
  }
  const match = /^rgb\((\d+) (\d+) (\d+) \/ (\d+(?:\.\d+)?)%\)$/u.exec(value);
  assert.ok(match, `unsupported color: ${value}`);
  const channels = match.slice(1, 4).map(Number);
  const alpha = Number(match[4]) / 100;
  assert.ok(channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1, value);
  return [channels[0]!, channels[1]!, channels[2]!, alpha];
}

function over(foreground: Rgba, background: Rgb): Rgb {
  return [0, 1, 2].map(index => foreground[index]! * foreground[3] + background[index]! * (1 - foreground[3])) as unknown as Rgb;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const luminance = (rgb: Rgb): number => {
    const channels = rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("semantic text contrast composes alpha over the actual opaque surface", () => {
  assert.deepEqual(over(rgba("rgb(0 188 125 / 10%)"), [255, 255, 255]), [229.5, 248.3, 242]);
  assert.deepEqual(over(rgba("rgb(251 44 54 / 0%)"), [36, 36, 36]), [36, 36, 36]);
  assert.deepEqual(over(rgba("rgb(251 44 54 / 100%)"), [36, 36, 36]), [251, 44, 54]);
  assert.equal(contrast([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrast([42, 42, 42], [42, 42, 42]), 1);
  for (const value of ["transparent", "rgb(0 0 0 / 101%)", "rgb(256 0 0 / 10%)", "#fff"]) {
    assert.throws(() => rgba(value), assert.AssertionError, `rejects ${value}`);
  }
});

test("MCP contrast fixture follows the actual title and opaque dialog background", () => {
  const component = read("components/McpServersView.tsx");
  assert.match(component, /className="biny-mcp-dialog"/u);
  assert.match(component, /<div className="biny-mcp-dialog-scroll">/u);
  assert.match(component, /className=\{`biny-mcp-test-result is-\$\{testResult\.success \? "success" : "error"\}`\}[\s\S]*?<div><strong>\{testResult\.success \? "连接测试成功" : "连接测试失败"\}<\/strong><span>/u);
  assert.equal(declaration(".biny-mcp-dialog", "background"), "var(--biny-surface-elevated)");
  assert.equal(declaration(".biny-mcp-dialog-scroll", "background"), undefined);
  assert.equal(declaration(".biny-mcp-test-result", "font-size"), "11px");
  for (const selector of [".biny-mcp-test-result span", ".biny-mcp-test-result small"]) {
    assert.equal(declaration(selector, "color"), "var(--biny-text-secondary)");
  }
});

for (const mode of ["light", "dark"] as const) {
  for (const variant of ["success", "error"] as const) {
    test(`${mode} MCP ${variant} 11px title has at least 4.5 contrast on its composited result background`, () => {
      const selector = `.biny-mcp-test-result.is-${variant}`;
      // The strong title inherits the result color until it gets a dedicated small-text token.
      const foreground = declaration(`${selector} strong`, "color") ?? declaration(selector, "color");
      const background = declaration(selector, "background");
      const surface = declaration(".biny-mcp-dialog", "background");
      assert.ok(foreground && background && surface);
      const underlay = rgba(resolve(surface, mode));
      assert.equal(underlay[3], 1, "opaque dialog isolates the title from the backdrop");
      const underlayRgb: Rgb = [underlay[0], underlay[1], underlay[2]];
      const composed = over(rgba(resolve(background, mode)), underlayRgb);
      const ratio = contrast(over(rgba(resolve(foreground, mode)), composed), composed);
      assert.ok(ratio >= 4.5, `${mode} ${variant}: ${ratio.toFixed(4)} (${resolve(foreground, mode)} on ${composed.join(", ")})`);
    });
  }
}

test("dedicated title tokens preserve existing semantic dots, icons, backgrounds and aliases", () => {
  for (const [token, expected] of Object.entries({
    "--green": "#00bc7d", "--green-text": "light-dark(#009966, #00d492)", "--green-bg": "rgb(0 188 125 / 10%)",
    "--red": "#fb2c36", "--red-text": "light-dark(#e7000b, #ff6467)", "--red-bg": "rgb(251 44 54 / 10%)",
    "--amber": "#fe9a00", "--amber-text": "light-dark(#e17100, #ffb900)", "--amber-bg": "rgb(254 154 0 / 10%)",
    "--biny-success": "var(--green-text)", "--biny-success-bg": "var(--green-bg)",
    "--biny-danger": "var(--red-text)", "--biny-danger-bg": "var(--red-bg)"
  })) assert.equal(tokens.get(token), expected, token);
  for (const [variant, family, alias] of [["success", "green", "success"], ["error", "red", "danger"]] as const) {
    const selector = `.biny-mcp-test-result.is-${variant}`;
    assert.equal(declaration(selector, "color"), `var(--biny-${alias})`, "icon keeps its inherited color");
    assert.equal(declaration(selector, "background"), `var(--biny-${alias}-bg)`);
    assert.equal(declaration(`${selector} strong`, "color"), `var(--${family}-text-small)`);
    assert.equal(resolve(`var(--${family}-text-small)`, "dark"), resolve(`var(--${family}-text)`, "dark"));
  }
});

test("small semantic title tokens retain CSS fallbacks across built-in theme projections", () => {
  for (const [id, palette] of Object.entries(BUILTIN_PALETTES)) {
    const preference = { ...DEFAULT_APPEARANCE, [`${palette.type}Theme`]: id };
    const variables = appearanceVariables(resolveAppearance(preference, palette.type, palette.type === "dark"));
    for (const token of ["--green-text-small", "--red-text-small"]) {
      assert.equal(variables[token], undefined, `${id}: theme must not override ${token}`);
      assert.ok(tokens.has(token), `CSS fallback for ${token}`);
    }
  }
});
