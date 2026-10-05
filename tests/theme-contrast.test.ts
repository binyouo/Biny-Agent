import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { cloneAppearanceTheme, generateThemeColors } from "../src/appearance/editing.js";
import { completeSyntaxColors, createSyntaxTheme } from "../src/appearance/palette.js";
import { appearancePreferenceSchema, customAppearanceThemeSchema, DEFAULT_APPEARANCE } from "../src/appearance/preferences.js";
import { resolveAppearance } from "../src/appearance/resolve.js";
import type { AppearanceMode } from "../src/appearance/types.js";

function contrast(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const [red, green, blue] = hex.slice(1).match(/../gu)!.map(channel => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((left, right) => left - right);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

for (const [type, background, foreground] of [["dark", "#bbbbbb", "#222222"], ["light", "#333333", "#eeeeee"]] as const) {
  test(`${type} custom comments reach the existing contrast target against the actual syntax background`, () => {
    const palette = cloneAppearanceTheme({
      name: "custom-contrast",
      type,
      ...generateThemeColors({ background, foreground, accent: "#123456", secondary: "#654321" }, type)
    }, "custom-contrast", "Custom contrast");
    const preference = appearancePreferenceSchema.parse({ ...DEFAULT_APPEARANCE, [`${type}Theme`]: `custom:${palette.name}`, customThemes: [palette] });
    const saved = structuredClone(preference);
    const appearance = resolveAppearance(preference, type, false);
    const syntax = completeSyntaxColors(appearance.palette!);
    assert.ok(contrast(syntax.base03, syntax.base00) >= 3.5, `${syntax.base03} on ${syntax.base00}`);
    assert.equal(syntax.base00, background);
    assert.equal(appearance.mode, type);
    assert.equal(appearance.variables["--syntax-comment"], syntax.base03);
    const registration = createSyntaxTheme(palette);
    assert.equal(registration.type, type);
    assert.equal(registration.colors!["editor.background"], background);
    assert.equal(registration.tokenColors![0]!.settings.foreground, syntax.base03);
    for (const [key, value] of Object.entries(palette.base_16)) {
      if (key !== "base03") assert.equal(syntax[key as keyof typeof syntax], value);
    }
    assert.deepEqual(preference, saved);
  });
}

function customPalette(type: AppearanceMode, background: string, comment: string) {
  return customAppearanceThemeSchema.parse({
    ...BUILTIN_PALETTES.tokyonight!, name: "comment-test", displayName: "Comment test", type,
    base_16: { base00: background, base03: comment }
  });
}

test("readable custom comments remain exact, regardless of the declared theme direction", () => {
  for (const type of ["dark", "light"] as const) {
    for (const [background, comment] of [["#FFFFFF", "#123AbC"], ["#000000", "#bBcCdD"]]) {
      const palette = customPalette(type, background!, comment!);
      assert.ok(contrast(comment!, background!) >= 3.5);
      assert.equal(completeSyntaxColors(palette).base03, comment);
    }
  }
});

test("comment adjustment keeps the theme direction when either direction is readable", () => {
  assert.equal(completeSyntaxColors(customPalette("dark", "#777777", "#777777")).base03, "#e5e5e5");
  assert.equal(completeSyntaxColors(customPalette("light", "#777777", "#777777")).base03, "#202020");
});

test("comment contrast reaches the target near endpoint and rounding limits", () => {
  for (const type of ["dark", "light"] as const) {
    for (let channel = 0; channel <= 255; channel += 1) {
      const background = `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
      for (const comment of ["#000000", "#777777", "#ffffff", "#ff0000", "#00ff00", "#0000ff"]) {
        const syntax = completeSyntaxColors(customPalette(type, background, comment));
        assert.match(syntax.base03, /^#[\da-f]{6}$/iu);
        assert.ok(contrast(syntax.base03, background) >= 3.5, `${type}: ${comment} became ${syntax.base03} on ${background}`);
        if (contrast(comment, background) >= 3.5) assert.equal(syntax.base03, comment);
      }
    }
  }
});

test("built-in palettes retain readable comments and invalid colors remain rejected", () => {
  for (const palette of Object.values(BUILTIN_PALETTES)) {
    const syntax = completeSyntaxColors(palette);
    assert.ok(contrast(syntax.base03, syntax.base00) >= 3.5, palette.name);
  }
  for (const color of ["#fff", "#gggggg", "#12345678", "rgb(0, 0, 0)"]) {
    assert.throws(() => customPalette("dark", color, "#777777"));
    assert.throws(() => customPalette("light", "#ffffff", color));
  }
});
