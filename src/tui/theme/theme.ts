/**
 * 主题解析与当前生效主题。
 *
 * 主题定义里的色值可以是十六进制、`vars` 引用名或 256 色索引，这里统一解析成
 * 可直接写进终端的 ANSI 序列。界面组件接受的是 `(text) => string` 着色函数，
 * 所以取色的主入口是 `theme.fg(token, text)` 而不是十六进制。
 */
import { builtInThemes, darkTheme } from "./palettes.js";
import {
  isThemeBgToken,
  themeBgTokens,
  themeColorTokens,
  type ColorToken,
  type ColorValue,
  type ThemeBg,
  type ThemeColor,
  type ThemeDefinition
} from "./tokens.js";

/** 思考等级，与模型侧的 `ThinkingSelection` 取值一致。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 终端色彩能力：真彩色或 256 色。 */
export type ColorMode = "truecolor" | "256color";

const thinkingTokens: Record<ThinkingLevel, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax"
};

/** 只重置前景/背景，保证嵌套着色不会互相清掉。 */
const resetForeground = "\u001B[39m";
const resetBackground = "\u001B[49m";

/** 解析后的主题：token → ANSI 前缀 + 十六进制。 */
export class Theme {
  readonly name: string;
  readonly mode: ColorMode;
  private readonly hex: Map<ColorToken, string>;
  private readonly ansi: Map<ColorToken, string>;

  constructor(definition: ThemeDefinition, mode: ColorMode = detectColorMode()) {
    this.name = definition.name;
    this.mode = mode;
    this.hex = resolveDefinition(definition);
    this.ansi = new Map();
    for (const [token, value] of this.hex) {
      this.ansi.set(token, isThemeBgToken(token) ? backgroundAnsi(value, mode) : foregroundAnsi(value, mode));
    }
  }

  /** 前景着色。 */
  fg(token: ThemeColor, text: string): string {
    const prefix = this.ansi.get(token) ?? "";
    return `${prefix}${text.replaceAll(resetForeground, prefix).replaceAll("\u001B[0m", `\u001B[0m${prefix}`)}${resetForeground}`;
  }

  /** 背景着色。 */
  bg(token: ThemeBg, text: string): string {
    const prefix = this.ansi.get(token) ?? "";
    return `${prefix}${text.replaceAll(resetBackground, prefix).replaceAll("\u001B[0m", `\u001B[0m${prefix}`)}${resetBackground}`;
  }

  bold(text: string): string {
    return `\u001B[1m${text}\u001B[22m`;
  }

  italic(text: string): string {
    return `\u001B[3m${text}\u001B[23m`;
  }

  underline(text: string): string {
    return `\u001B[4m${text}\u001B[24m`;
  }

  strikethrough(text: string): string {
    return `\u001B[9m${text}\u001B[29m`;
  }

  inverse(text: string): string {
    return `\u001B[7m${text}\u001B[27m`;
  }

  /** 取十六进制色值，供桌面端或需要原始色值的地方使用。 */
  color(token: ColorToken): string {
    return this.hex.get(token) ?? (isThemeBgToken(token) ? "#000000" : "#ffffff");
  }

  /** 输入框边框颜色随思考等级变化，等级越高越亮。 */
  thinkingBorder(level: ThinkingLevel | string | undefined): (text: string) => string {
    const token = thinkingTokens[(level ?? "off") as ThinkingLevel] ?? "thinkingOff";
    return (text: string) => this.fg(token, text);
  }
}

function resolveDefinition(definition: ThemeDefinition): Map<ColorToken, string> {
  const vars = definition.vars ?? {};
  const resolved = new Map<ColorToken, string>();
  for (const token of [...themeColorTokens, ...themeBgTokens]) {
    resolved.set(token, resolveColorValue(definition.colors[token], vars));
  }
  return resolved;
}

function resolveColorValue(value: ColorValue | undefined, vars: Record<string, ColorValue>, depth = 0): string {
  // `vars` 允许一层层引用，但要防止主题文件写出自引用死循环。
  if (value === undefined) return "#ffffff";
  if (typeof value === "number") return ansi256ToHex(value);
  if (value.startsWith("#")) return normalizeHex(value);
  if (depth > 8) return "#ffffff";
  const referenced = vars[value];
  if (referenced === undefined) return "#ffffff";
  return resolveColorValue(referenced, vars, depth + 1);
}

function normalizeHex(value: string): string {
  const hex = value.slice(1);
  if (hex.length === 3) {
    return `#${[...hex].map((char) => `${char}${char}`).join("")}`.toLowerCase();
  }
  if (hex.length !== 6 || !/^[0-9a-f]{6}$/i.test(hex)) return "#ffffff";
  return `#${hex.toLowerCase()}`;
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16)
  };
}

function foregroundAnsi(hex: string, mode: ColorMode): string {
  const { red, green, blue } = hexToRgb(hex);
  return mode === "truecolor"
    ? `\u001B[38;2;${String(red)};${String(green)};${String(blue)}m`
    : `\u001B[38;5;${String(rgbToAnsi256(red, green, blue))}m`;
}

function backgroundAnsi(hex: string, mode: ColorMode): string {
  const { red, green, blue } = hexToRgb(hex);
  return mode === "truecolor"
    ? `\u001B[48;2;${String(red)};${String(green)};${String(blue)}m`
    : `\u001B[48;5;${String(rgbToAnsi256(red, green, blue))}m`;
}

/** 6×6×6 色立方的通道取值。 */
const cubeValues = [0, 95, 135, 175, 215, 255] as const;

const baseAnsiHex = [
  "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"
] as const;

export function ansi256ToHex(index: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(index)));
  const base = baseAnsiHex[clamped];
  if (base) return base;
  if (clamped >= 232) {
    const gray = 8 + (clamped - 232) * 10;
    return rgbToHex(gray, gray, gray);
  }
  const offset = clamped - 16;
  const red = cubeValues[Math.floor(offset / 36)] ?? 0;
  const green = cubeValues[Math.floor(offset / 6) % 6] ?? 0;
  const blue = cubeValues[offset % 6] ?? 0;
  return rgbToHex(red, green, blue);
}

/** 真彩色不可用时把 RGB 折算到 256 色板：先比色立方，再比灰阶。 */
export function rgbToAnsi256(red: number, green: number, blue: number): number {
  const cubeIndex = (channel: number): number => {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < cubeValues.length; index += 1) {
      const distance = Math.abs(channel - (cubeValues[index] ?? 0));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  };
  const cube = 16 + 36 * cubeIndex(red) + 6 * cubeIndex(green) + cubeIndex(blue);
  const cubeHex = ansi256ToHex(cube);
  const cubeRgb = hexToRgb(cubeHex);
  const cubeDistance = squaredDistance(red, green, blue, cubeRgb.red, cubeRgb.green, cubeRgb.blue);

  const average = (red + green + blue) / 3;
  const grayIndex = Math.min(23, Math.max(0, Math.round((average - 8) / 10)));
  const grayValue = 8 + grayIndex * 10;
  const grayDistance = squaredDistance(red, green, blue, grayValue, grayValue, grayValue);

  return grayDistance < cubeDistance ? 232 + grayIndex : cube;
}

function squaredDistance(
  red: number,
  green: number,
  blue: number,
  otherRed: number,
  otherGreen: number,
  otherBlue: number
): number {
  return (red - otherRed) ** 2 + (green - otherGreen) ** 2 + (blue - otherBlue) ** 2;
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** 只有终端明确声明真彩色时才用真彩色，否则退到 256 色。 */
export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("truecolor") || term.includes("direct")) return "truecolor";
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "ghostty") {
    return "truecolor";
  }
  return "256color";
}

let activeTheme = new Theme(darkTheme);
const themeListeners = new Set<() => void>();

/** 当前生效主题。切换主题后同一个引用会失效，取色请通过 `theme` 代理。 */
export function getTheme(): Theme {
  return activeTheme;
}

/** 切换内置主题；未知主题名回落到 dark。 */
export function setTheme(name: string): Theme {
  activeTheme = new Theme(Object.hasOwn(builtInThemes, name) ? builtInThemes[name]! : darkTheme);
  for (const listener of themeListeners) listener();
  return activeTheme;
}

/** 用自定义主题定义覆盖当前主题，供外部主题文件加载使用。 */
export function setThemeDefinition(definition: ThemeDefinition): Theme {
  activeTheme = new Theme(definition);
  for (const listener of themeListeners) listener();
  return activeTheme;
}

/** 订阅主题变化，用于让已挂载的组件重新渲染。 */
export function onThemeChange(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

export function availableThemes(): string[] {
  return Object.keys(builtInThemes);
}

/** 按 token 取十六进制色值，前景和背景 token 都可以传。 */
export function colorToken(token: ColorToken): string {
  return activeTheme.color(token);
}
