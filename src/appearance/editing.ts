import { BUILTIN_PALETTES } from "./catalog.js";
import { appearancePreferenceSchema, customAppearanceThemeSchema } from "./preferences.js";
import type { AppearanceMode, AppearancePreference, CustomAppearanceTheme, ThemePalette } from "./types.js";

export interface SimpleThemeColors {
  background: string;
  foreground: string;
  accent: string;
  secondary: string;
}

function rgb(hex: string): [number, number, number] {
  if (!/^#[\da-f]{6}$/iu.test(hex)) throw new Error("颜色必须使用六位十六进制格式。");
  return [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function hex(channels: number[]): string {
  return `#${channels.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("")}`;
}

function adjust(color: string, lightnessOffset = 0, hueOffset = 0, saturationOffset = 0): string {
  const [red, green, blue] = rgb(color).map(channel => channel / 255) as [number, number, number];
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const initialLightness = (maximum + minimum) / 2;
  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation = initialLightness > 0.5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum);
    hue = maximum === red ? ((green - blue) / delta + (green < blue ? 6 : 0)) / 6
      : maximum === green ? ((blue - red) / delta + 2) / 6 : ((red - green) / delta + 4) / 6;
  }
  hue = (hueOffset === 0 ? hue * 360 : (hue * 360 + hueOffset + 360) % 360) / 360;
  saturation = Math.max(0, Math.min(100, saturation * 100 + saturationOffset)) / 100;
  const lightness = Math.max(0, Math.min(100, initialLightness * 100 + lightnessOffset)) / 100;
  if (saturation === 0) return hex([lightness * 255, lightness * 255, lightness * 255]);
  const upper = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const lower = 2 * lightness - upper;
  const channel = (position: number): number => {
    if (position < 0) position += 1;
    if (position > 1) position -= 1;
    return (position < 1 / 6 ? lower + (upper - lower) * 6 * position : position < 1 / 2 ? upper
      : position < 2 / 3 ? lower + (upper - lower) * (2 / 3 - position) * 6 : lower) * 255;
  };
  return hex([channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)]);
}

function mix(first: string, second: string, weight = 50): string {
  const secondChannels = rgb(second);
  return hex(rgb(first).map((channel, index) => channel * (weight / 100) + secondChannels[index]! * (1 - weight / 100)));
}

const lighten = (color: string, amount: number): string => adjust(color, amount);
const darken = (color: string, amount: number): string => adjust(color, -amount);
const shiftHue = (color: string, amount: number): string => adjust(color, 0, amount);
const saturate = (color: string, amount: number): string => adjust(color, 0, 0, amount);

export function generateThemeColors(colors: SimpleThemeColors, themeType: AppearanceMode): Pick<ThemePalette, "base_30" | "base_16"> {
  const { background, foreground, accent, secondary } = colors;
  const isDark = themeType === "dark";
  const darker_black = isDark ? darken(background, 3) : lighten(background, 3);
  const black = background;
  const black2 = isDark ? lighten(background, 3) : darken(background, 3);
  const one_bg = isDark ? lighten(background, 5) : darken(background, 5);
  const one_bg2 = isDark ? lighten(background, 10) : darken(background, 10);
  const one_bg3 = isDark ? lighten(background, 12) : darken(background, 12);
  const statusline_bg = isDark ? lighten(background, 2) : darken(background, 2);
  const lightbg = isDark ? lighten(background, 8) : darken(background, 8);
  const line = isDark ? lighten(background, 7) : darken(background, 7);
  const grey = mix(background, foreground, 70);
  const grey_fg = mix(background, foreground, 55);
  const grey_fg2 = mix(background, foreground, 45);
  const light_grey = mix(background, foreground, 40);
  const red = shiftHue(accent, -30);
  const pink = saturate(shiftHue(accent, -60), 20);
  const baby_pink = lighten(pink, 15);
  const orange = shiftHue(accent, 30);
  const yellow = shiftHue(secondary, 30);
  const sun = lighten(yellow, 10);
  const green = secondary;
  const vibrant_green = saturate(lighten(secondary, 10), 20);
  const blue = accent;
  const nord_blue = mix(accent, "#81A1C1", 50);
  const cyan = shiftHue(accent, 180);
  const teal = mix(cyan, secondary, 50);
  const purple = shiftHue(accent, -90);
  const dark_purple = darken(purple, 10);
  const base_30 = {
    white: foreground,
    darker_black,
    black,
    black2,
    one_bg,
    one_bg2,
    one_bg3,
    grey,
    grey_fg,
    grey_fg2,
    light_grey,
    red,
    baby_pink,
    pink,
    line,
    green,
    vibrant_green,
    nord_blue,
    blue,
    yellow,
    sun,
    purple,
    dark_purple,
    teal,
    orange,
    cyan,
    statusline_bg,
    lightbg,
    pmenu_bg: accent,
    folder_bg: accent
  };
  const base_16 = {
    base00: background,
    base01: one_bg,
    base02: one_bg2,
    base03: grey,
    base04: grey_fg,
    base05: foreground,
    base06: isDark ? lighten(foreground, 5) : darken(foreground, 5),
    base07: isDark ? lighten(foreground, 10) : darken(foreground, 10),
    base08: red,

    base09: orange,

    base0A: yellow,

    base0B: green,

    base0C: cyan,

    base0D: blue,

    base0E: purple,

    base0F: darken(red, 10)

  };
  return { base_30, base_16 };
}


export function cloneAppearanceTheme(palette: ThemePalette, name: string, displayName: string): CustomAppearanceTheme {
  return customAppearanceThemeSchema.parse({ ...structuredClone(palette), name, displayName }) as CustomAppearanceTheme;
}

export function upsertAppearanceTheme(preference: AppearancePreference, theme: CustomAppearanceTheme, previousName = theme.name): AppearancePreference {
  const next = {
    ...preference,
    customThemes: [...preference.customThemes.filter(candidate => candidate.name !== previousName && candidate.name !== theme.name), theme],
    [theme.type === "dark" ? "darkTheme" : "lightTheme"]: `custom:${theme.name}`
  };
  for (const [field, mode] of [["darkTheme", "dark"], ["lightTheme", "light"]] as const) {
    if ((next[field] === `custom:${previousName}` && previousName !== theme.name)
      || (next[field] === `custom:${theme.name}` && theme.type !== mode)) next[field] = null;
  }
  return appearancePreferenceSchema.parse(next) as AppearancePreference;
}

export function importAppearanceTheme(content: string, name = "imported-theme"): CustomAppearanceTheme {
  if (content.length > 256 * 1024) throw new Error("主题文件不能超过 256 KiB。");
  if (content.trimStart().startsWith("{")) {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") throw new Error("主题文件必须是对象。");
    const record = parsed as Record<string, unknown>;
    return customAppearanceThemeSchema.parse({ ...record, displayName: record.displayName ?? record.name }) as CustomAppearanceTheme;
  }
  const cleaned = content.replace(/--\[\[[\s\S]*?\]\]/gu, "").replace(/--[^\n]*/gu, "");
  const table = (key: string): Record<string, string> => {
    const body = new RegExp(`(?:\\b${key}\\s*=|\\[\\s*["']${key}["']\\s*\\]\\s*=)\\s*\\{([^{}]*)\\}`, "u").exec(cleaned)?.[1];
    if (body === undefined) throw new Error(`主题缺少 ${key} 颜色表。`);
    const colors: Record<string, string> = {};
    for (const entry of body.matchAll(/(?:\b([\w]+)|\[\s*["']([\w]+)["']\s*\])\s*=\s*["'](#[\da-f]{6})["']/giu)) {
      const field = entry[1] ?? entry[2]!;
      if (field in colors) throw new Error(`颜色字段重复：${field}`);
      colors[field] = entry[3]!;
    }
    return colors;
  };
  const type = /\btype\s*=\s*["'](light|dark)["']/u.exec(cleaned)?.[1] ?? "dark";
  return customAppearanceThemeSchema.parse({ name, displayName: name, type, base_30: table("base_30"), base_16: table("base_16") }) as CustomAppearanceTheme;
}

export function exportAppearanceTheme(theme: ThemePalette, displayName = theme.name): string {
  return JSON.stringify({ name: theme.name, displayName, type: theme.type, base_30: theme.base_30, base_16: theme.base_16 }, null, 2);
}

export function getAppearancePalette(id: string, customThemes: CustomAppearanceTheme[] = []): ThemePalette | undefined {
  return id.startsWith("custom:") ? customThemes.find(theme => theme.name === id.slice(7)) : Object.hasOwn(BUILTIN_PALETTES, id) ? BUILTIN_PALETTES[id] : undefined;
}
