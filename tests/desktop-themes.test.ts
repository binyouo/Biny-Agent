import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import { BUILTIN_PALETTES, BUILTIN_THEME_INFO } from "../src/appearance/catalog.js";
import { BASE16_KEYS, BASE30_KEYS, type AppearanceSnapshot } from "../src/appearance/types.js";
import { DEFAULT_APPEARANCE, appearancePreferenceSchema, normalizeAppearancePreference } from "../src/appearance/preferences.js";
import { cloneAppearanceTheme, exportAppearanceTheme, generateThemeColors, getAppearancePalette, importAppearanceTheme, upsertAppearanceTheme } from "../src/appearance/editing.js";
import { SIMPLE_THEME_PRESETS } from "../src/appearance/presets.js";
import { mapPaletteVariables, palettePreviewColors } from "../src/appearance/palette.js";
import { resolveAppearance } from "../src/appearance/resolve.js";
import { AppearancePreviewCoordinator } from "../src/desktop/appearanceCoordinator.js";
import { sampleWindowTrail } from "../src/desktop/windowTrail.js";
import { highlightFencedCode } from "../src/desktop/renderer/src/syntaxHighlight.js";
import { applyAppearance, appearanceVariables, readAppearanceCache, APPEARANCE_CACHE_KEY } from "../src/desktop/renderer/src/appearance.js";

const appearancePreference = {
  darkTheme: "tokyonight",
  lightTheme: "win98",
  density: "compact" as const,
  win98Trail: false,
  customThemes: []
};

test("dark structural skin resolves neutral chrome and blue selection without violet painter literals", async () => {
  const appearance = resolveAppearance({ ...DEFAULT_APPEARANCE, darkTheme: "longhorn-dark" }, "dark", false);
  const variables = appearanceVariables(appearance);
  assert.equal(appearance.skin, "longhorn-dark");
  assert.equal(variables["--bg"], "#232323");
  assert.equal(variables["--accent"], "#74b6fb");
  assert.equal(variables["--accent-foreground"], "#171717");
  for (const token of ["--bg", "--surface", "--surface-raised", "--surface-soft", "--surface-hover", "--surface-selected", "--sidebar", "--text", "--border-strong"]) {
    const channels = variables[token]!.slice(1).match(/../gu)!.map(channel => Number.parseInt(channel, 16));
    assert.equal(channels[0], channels[1], token);
    assert.equal(channels[1], channels[2], token);
  }
  const painter = await readFile(new URL("../src/desktop/renderer/src/styles/retro.css", import.meta.url), "utf8");
  const start = painter.indexOf(":root[data-appearance-skin='longhorn-dark'] {");
  assert.ok(start >= 0);
  const section = painter.slice(start);
  for (const hex of section.match(/#[\da-f]{6}\b/giu) ?? []) {
    const channels = hex.slice(1).match(/../gu)!.map(channel => Number.parseInt(channel, 16));
    assert.ok(channels[0] !== channels[1] || channels[1] === channels[2], `neutral chrome: ${hex}`);
    assert.ok(!(channels[0]! > channels[1]! && channels[2]! > channels[0]!), `no violet accent: ${hex}`);
  }
  assert.doesNotMatch(section, /rgba?\(133,\s*120,\s*199/u);
  assert.match(section, /::selection\s*\{\s*background-color:\s*#74b6fb;\s*color:\s*#171717;/u);
});

test("first paint discards stale color projections but keeps saved preferences and accepts fresh projections", async () => {
  const snapshot: AppearanceSnapshot = { themePreference: "dark", appearancePreference: { ...structuredClone(DEFAULT_APPEARANCE), darkTheme: "longhorn-dark" }, fontPreference: { family: "system", size: 17 } };
  const cache = new Map<string, string>([[APPEARANCE_CACHE_KEY, JSON.stringify({ snapshot, variants: { dark: { skin: "longhorn-dark", themeId: "longhorn-dark", variables: { "--bg": "#17171a", "--accent": "#8578c7" } } } })]]);
  const html = await readFile(new URL("../src/desktop/renderer/index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(script);
  const storage = { getItem: (key: string) => cache.get(key), setItem: (key: string, value: string) => cache.set(key, value) };
  const boot = (mode: "light" | "dark" = "dark") => {
    const values = new Map<string, string>();
    const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) }, classList: { toggle: () => {} } };
    runInNewContext(script, { window: { location: { search: `?theme=${mode}` }, matchMedia: () => ({ matches: true }) }, localStorage: storage, document: { documentElement: root }, URLSearchParams });
    return { root, values };
  };
  const stale = boot();
  assert.equal(stale.values.has("--accent"), false);
  assert.equal(stale.values.has("--bg"), false);
  assert.equal(stale.values.get("--app-font-size"), "17");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, matchMedia: () => ({ matches: true }) } });
  try {
    assert.deepEqual(readAppearanceCache(), snapshot);
    applyAppearance(stale.root as unknown as HTMLElement, snapshot);
    assert.deepEqual(readAppearanceCache(), snapshot);
    const fresh = boot();
    assert.equal(fresh.values.get("--bg"), "#232323");
    assert.equal(fresh.values.get("--accent"), "#74b6fb");
    assert.equal(fresh.root.dataset.appearanceSkin, "longhorn-dark");
    applyAppearance(fresh.root as unknown as HTMLElement, { ...snapshot, themePreference: "light" });
    assert.equal(fresh.values.has("--accent"), false);
    assert.equal(fresh.values.has("--bg"), false);
    assert.equal(fresh.root.dataset.theme, "light");
    assert.equal(fresh.root.dataset.appearanceSkin, "default");
    const light = boot("light");
    assert.equal(light.values.has("--accent"), false);
    assert.equal(light.root.dataset.appearanceSkin, "default");
    assert.equal(light.values.get("--app-font-size"), "17");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("structural skins address the actual sidebar, composer and message roles", async () => {
  const styles = await readFile(new URL("../src/desktop/renderer/src/styles/retro.css", import.meta.url), "utf8");
  for (const selector of [".biny-send-button", ".biny-jump-bottom", ".user-bubble", ".biny-sidebar-card", ".biny-sidebar-session-entry.is-selected", ".biny-prompt-toolbar"]) {
    assert.ok(styles.includes(selector), selector);
  }
  assert.doesNotMatch(styles, /\.biny-sendbutton|\.biny-send-button-button|\.scroll-to-bottom-buttonbutton|\.is-user\s+\[class\*/u);
  for (const type of ["checkbox", "radio"]) {
    assert.match(styles, new RegExp(`input\\[type="${type}"\\]\\s*\\{[^}]*appearance:\\s*none`, "u"));
  }
  const layout = await readFile(new URL("../src/desktop/renderer/src/styles/retro-layout.css", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /\[role=['"]menu['"]\][^{}]*\{[^}]*(?:background|box-shadow):/u);
});

test("retro settings navigation stays horizontal and releases space for the active page", async () => {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
  const layers = await readFile(new URL("styles/layers.css", renderer), "utf8");
  const sources = await Promise.all([
    ...[...layers.matchAll(/@import "(\.\.?\/[^"]+\.css)"/gu)].map(entry => new URL(entry[1]!, new URL("styles/layers.css", renderer))),
    new URL("styles/retro.css", renderer), new URL("styles/retro-layout.css", renderer)
  ].map(file => readFile(file, "utf8")));
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => { errors.push(error.message); });
  const dom = new JSDOM('<!doctype html><html><head></head><body><dialog open class="desktop-settings-dialog"><section class="settings-modal"><aside class="settings-tabs"><div class="settings-search"><input aria-label="搜索设置" /></div><nav class="settings-nav-list"><button>通用</button><button>聊天</button><button class="is-selected">模型</button><button>扩展</button><button>网络</button><button>记忆与数据</button><button>权限</button><button>关于</button></nav></aside><main class="settings-content"><header class="settings-titlebar">模型</header><div class="settings-scroll">模型配置</div><footer class="settings-page-footer">保存</footer></main></section></dialog></body></html>', { virtualConsole });
  try {
    for (const source of sources) {
      const style = dom.window.document.createElement("style");
      style.textContent = source;
      dom.window.document.head.append(style);
    }
    assert.deepEqual(errors, []);
    const settings = dom.window.document.querySelector<HTMLElement>(".settings-modal")!;
    const computed = (selector: string): CSSStyleDeclaration => dom.window.getComputedStyle(settings.querySelector(selector)!);
    for (const skin of ["win98", "winxp", "longhorn", "longhorn-dark"]) {
      dom.window.document.documentElement.dataset.appearanceSkin = skin;
      settings.classList.add("is-retro-settings");
      const tabs = computed(".settings-tabs");
      assert.equal(tabs.flexDirection, "row", skin);
      assert.equal(tabs.height, "auto", skin);
      assert.equal(tabs.marginTop, "0px", skin);
      assert.equal(tabs.minWidth, "0px", skin);
      assert.equal(tabs.maxWidth, "none", skin);
      assert.equal(tabs.flexGrow, "0", skin);
      const navigation = computed(".settings-nav-list");
      assert.equal(navigation.flexDirection, "row", skin);
      assert.equal(navigation.flexWrap, "wrap", skin);
      assert.equal(navigation.minWidth, "0px", skin);
      const content = computed(".settings-content");
      assert.equal(content.flexGrow, "1", skin);
      assert.equal(content.flexBasis, "0%", skin);
      assert.equal(content.minHeight, "0px", skin);
      const tab = computed(".settings-nav-list button");
      assert.equal(tab.width, "auto", skin);
      assert.equal(tab.height, "auto", skin);
      dom.window.document.documentElement.dataset.appearanceSkin = "default";
      settings.classList.remove("is-retro-settings");
      assert.equal(computed(".settings-tabs").flexDirection, "column", skin);
      assert.equal(computed(".settings-tabs").height, "calc(100% - 16px)", skin);
      assert.equal(computed(".settings-tabs").marginTop, "8px", skin);
      assert.equal(computed(".settings-tabs").borderRadius, "16px", skin);
      assert.equal(computed(".settings-tabs").minWidth, "208px", skin);
      assert.equal(computed(".settings-nav-list").flexDirection, "column", skin);
    }
  } finally { dom.window.close(); }
});

test("appearance preferences persist with mode and font without replacing unrelated desktop state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-appearance-"));
  try {
    const filePath = path.join(root, "desktop-state.json");
    const state = new DesktopStateStore(filePath);
    await state.load();
    await state.setSelectedSession("project", "draft-session");
    const patch = { themePreference: "light" as const, appearancePreference };
    await state.applySettingsPreferences(patch, 0);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.appearancePreference, appearancePreference);
    assert.equal(persisted.preferenceRevision, 1);
    const restored = new DesktopStateStore(filePath);
    await restored.load();
    assert.deepEqual((restored.settingsPreferences() as unknown as Record<string, unknown>).appearancePreference, appearancePreference);
    assert.equal(restored.selectedSessionId("project"), "draft-session");
    const before = restored.settingsPreferences();
    const changed = { appearancePreference: { ...appearancePreference, lightTheme: "winxp" } };
    await restored.applySettingsPreferences(changed, before.revision);
    await restored.restoreSettingsPreferences(before, before.revision + 1);
    assert.deepEqual((restored.settingsPreferences() as unknown as Record<string, unknown>).appearancePreference, appearancePreference);
    await assert.rejects(restored.applySettingsPreferences(changed, before.revision), /revision|版本/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings accepts a complete appearance preference and rejects unknown themes before writing", () => {
  const input = {
    expectedPreferenceRevision: 0,
    expectedConfigRevision: "missing",
    appearancePreference
  };
  assert.equal(settingsSaveInputSchema.safeParse(input).success, true);
  assert.equal(settingsSaveInputSchema.safeParse({ ...input, appearancePreference: { ...appearancePreference, lightTheme: "unknown-theme" } }).success, false);
  assert.equal(settingsSaveInputSchema.safeParse({ ...input, appearancePreference: { ...appearancePreference, lightTheme: "tokyonight" } }).success, false);
});

test("catalog includes all 74 validated palettes and exactly four structural skins", () => {
  assert.equal(getAppearancePalette("constructor"), undefined);
  assert.equal(getAppearancePalette("__proto__"), undefined);
  assert.equal(BUILTIN_THEME_INFO.length, 74);
  assert.equal(BUILTIN_THEME_INFO.filter(theme => theme.type === "dark").length, 56);
  assert.equal(BUILTIN_THEME_INFO.filter(theme => theme.type === "light").length, 18);
  assert.deepEqual(BUILTIN_THEME_INFO.filter(theme => theme.skin !== "default").map(theme => theme.id).sort(), ["longhorn", "longhorn-dark", "win98", "winxp"]);
  for (const info of BUILTIN_THEME_INFO) {
    const palette = BUILTIN_PALETTES[info.id]!;
    assert.equal(palette.type, info.type);
    assert.equal(cloneAppearanceTheme(palette, "example", "Example").type, info.type);
    for (const key of BASE30_KEYS) assert.match(palette.base_30[key], /^#[\da-f]{6}$/iu);
    const variables = mapPaletteVariables(palette);
    for (const value of Object.values(variables)) assert.match(value, /^#[\da-f]{6,8}$/iu);
    assert.deepEqual(palettePreviewColors(palette), [palette.type === "light" ? palette.base_30.black : palette.base_30.one_bg, palette.base_30.blue, palette.base_30.green, palette.base_30.red, palette.base_30.purple, palette.base_30.white]);
  }
});

test("mode, density, skin and custom palette resolve independently", () => {
  const preference = { ...DEFAULT_APPEARANCE, darkTheme: "longhorn-dark", lightTheme: "winxp", density: "spacious" as const };
  assert.equal(resolveAppearance(preference, "system", false).skin, "winxp");
  assert.equal(resolveAppearance(preference, "system", true).skin, "longhorn-dark");
  assert.equal(resolveAppearance(preference, "light", true).skin, "winxp");
  const custom = cloneAppearanceTheme(BUILTIN_PALETTES.win98!, "win98", "Custom");
  const resolved = resolveAppearance({ ...preference, lightTheme: "custom:win98", customThemes: [custom] }, "light", true);
  assert.equal(resolved.skin, "default");
  assert.equal(resolved.win98Trail, false);
  assert.equal(resolved.variables["--ui-density-line-height"], "1.65");
  assert.equal(resolveAppearance({ ...preference, lightTheme: "win98" }, "light", false).win98Trail, true);
  assert.equal(resolveAppearance({ ...preference, lightTheme: "win98", win98Trail: false }, "light", false).win98Trail, false);
});

test("custom theme JSON and literal Lua roundtrip without evaluating external code", () => {
  for (const palette of Object.values(BUILTIN_PALETTES)) {
    const imported = importAppearanceTheme(exportAppearanceTheme(palette));
    assert.equal(imported.name, palette.name);
    assert.equal(imported.type, palette.type);
    assert.deepEqual(imported.base_30, palette.base_30);
    assert.deepEqual(imported.base_16, palette.base_16);
  }
  const theme = cloneAppearanceTheme(BUILTIN_PALETTES.win98!, "custom-light", "Example");
  assert.deepEqual(importAppearanceTheme(exportAppearanceTheme(theme, theme.displayName)), theme);
  const table = (colors: Record<string, string>): string => `{${Object.entries(colors).map(([key, value]) => `${key} = "${value}"`).join(",")}}`;
  const lua = `local M = {}; M.type = "light"; M.base_30 = ${table(theme.base_30)}; M.base_16 = ${table(theme.base_16)}; return M`;
  const imported = importAppearanceTheme(lua, "literal");
  assert.deepEqual(imported.base_30, theme.base_30);
  assert.equal(imported.type, "light");
  assert.throws(() => importAppearanceTheme('{"name":"unsafe"}'));
  assert.throws(() => importAppearanceTheme(exportAppearanceTheme({ ...theme, base_30: { ...theme.base_30, black: "url(https://example.invalid)" } })));
  assert.throws(() => importAppearanceTheme("x".repeat(256 * 1024 + 1)), /256/);
  assert.equal(appearancePreferenceSchema.safeParse({ ...DEFAULT_APPEARANCE, customThemes: [theme, theme] }).success, false);
  assert.equal(normalizeAppearancePreference({ lightTheme: "missing", customThemes: [theme] }).lightTheme, null);
});

test("simple presets generate the complete interface and syntax contract", () => {
  assert.equal(generateThemeColors(SIMPLE_THEME_PRESETS.ocean!.dark, "dark").base_30.baby_pink, "#beffea");
  for (const preset of Object.values(SIMPLE_THEME_PRESETS)) for (const type of ["light", "dark"] as const) {
    const colors = generateThemeColors(preset[type], type);
    assert.equal(Object.keys(colors.base_30).length, BASE30_KEYS.length);
    assert.equal(Object.keys(colors.base_16).length, BASE16_KEYS.length);
    assert.equal(colors.base_30.black, preset[type].background);
    assert.equal(colors.base_16.base05, preset[type].foreground);
    assert.equal(colors.base_30.blue, preset[type].accent);
    assert.equal(colors.base_30.green, preset[type].secondary);
  }
});

test("editing or importing a custom theme repairs mode references without mutating saved preferences", () => {
  const original = cloneAppearanceTheme(BUILTIN_PALETTES.tokyonight!, "editable", "Original");
  const saved = { ...structuredClone(DEFAULT_APPEARANCE), darkTheme: "custom:editable", customThemes: [original] };
  const replacement = cloneAppearanceTheme(BUILTIN_PALETTES.win98!, "editable", "Replacement");
  const updated = upsertAppearanceTheme(saved, replacement);
  assert.equal(updated.darkTheme, null);
  assert.equal(updated.lightTheme, "custom:editable");
  assert.deepEqual(updated.customThemes, [replacement]);
  assert.equal(saved.darkTheme, "custom:editable");
  assert.deepEqual(saved.customThemes, [original]);
  replacement.base_30.black = "#111111";
  assert.notEqual(updated.customThemes[0]!.base_30.black, replacement.base_30.black);
  const renamed = cloneAppearanceTheme(BUILTIN_PALETTES.win98!, "renamed", "Renamed");
  assert.equal(upsertAppearanceTheme(updated, renamed, "editable").lightTheme, "custom:renamed");
  const full = { ...structuredClone(DEFAULT_APPEARANCE), customThemes: Array.from({ length: 100 }, (_, index) => cloneAppearanceTheme(original, `theme-${index}`, `Theme ${index}`)) };
  assert.throws(() => upsertAppearanceTheme(full, renamed));
  assert.equal(full.customThemes.length, 100);
});

test("preview is transient, clone-safe and released only by its current owner", () => {
  const saved: AppearanceSnapshot = { themePreference: "system", appearancePreference: DEFAULT_APPEARANCE, fontPreference: { family: "system", size: 14 } };
  const published: AppearanceSnapshot[] = [];
  const coordinator = new AppearancePreviewCoordinator({ read: () => saved, publish: snapshot => published.push(snapshot) });
  const first = { ...saved, themePreference: "light" as const, appearancePreference: structuredClone(appearancePreference) };
  coordinator.preview(1, first);
  first.appearancePreference.lightTheme = "winxp";
  assert.equal(coordinator.snapshot().appearancePreference.lightTheme, "win98");
  coordinator.preview(2, { ...saved, themePreference: "dark" });
  coordinator.release(1);
  assert.equal(coordinator.snapshot().themePreference, "dark");
  coordinator.release(2);
  assert.deepEqual(coordinator.snapshot(), saved);
  assert.equal(saved.appearancePreference.lightTheme, null);
  coordinator.preview(3, first);
  coordinator.committed();
  assert.deepEqual(published.at(-1), saved);
});

test("palette changes recolor real highlighted tokens including edits under the same custom ID", async () => {
  const original = cloneAppearanceTheme(BUILTIN_PALETTES.tokyonight!, "test-highlight", "Example");
  const first = await highlightFencedCode('const value = "text";', "ts", original);
  const updated = { ...original, base_16: { ...original.base_16, base0E: "#123456" } };
  const second = await highlightFencedCode('const value = "text";', "ts", updated);
  assert.match(second.html, /#123456/iu);
  assert.notEqual(first.html, second.html);
});

test("default Markdown quote highlighting uses readable foregrounds instead of comment colors", async () => {
  const highlighted = await highlightFencedCode("> quoted text", "markdown");
  assert.match(highlighted.html, /--shiki-light:#383a42/iu);
  assert.match(highlighted.html, /--shiki-dark:#abb2bf/iu);
  assert.doesNotMatch(highlighted.html, /--shiki-light-font-style:italic/iu);
});

test("window drag samples frozen-frame positions at six-pixel intervals and bounds memory", () => {
  const previous = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(sampleWindowTrail(previous, { ...previous, x: 18 }), [[0, 0], [6, 0], [12, 0]]);
  assert.deepEqual(sampleWindowTrail(previous, { ...previous, x: 5 }), []);
  assert.deepEqual(sampleWindowTrail(previous, { ...previous, x: 18, width: 900 }), []);
  assert.equal(sampleWindowTrail(previous, { ...previous, x: 20_000 }).length, 128);
});

test("returning to default clears first-paint variables and skin without touching other root state", () => {
  const values = new Map<string, string>([["--background", "#c0c0c0"], ["--sidebar", "#000080"], ["--unrelated", "keep"]]);
  const cache = new Map<string, string>([[APPEARANCE_CACHE_KEY, JSON.stringify({ variables: {}, variants: { light: { variables: { "--background": "#c0c0c0", "--sidebar": "#000080" } } } })]]);
  const root = { dataset: { theme: "light", base46Theme: "win98", appearanceSkin: "win98" }, style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) }, classList: { toggle: () => {} } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => cache.get(key), setItem: (key: string, value: string) => cache.set(key, value) }, matchMedia: () => ({ matches: false }) } });
  try {
    applyAppearance(root as unknown as HTMLElement, { themePreference: "light", appearancePreference: DEFAULT_APPEARANCE, fontPreference: { family: "system", size: 14 } });
    assert.equal(values.has("--background"), false);
    assert.equal(values.has("--sidebar"), false);
    assert.equal(values.get("--unrelated"), "keep");
    assert.equal(root.dataset.appearanceSkin, "default");
    assert.equal(root.dataset.base46Theme, undefined);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("semantic status colors remain fixed across themes", async () => {
  const STATUS = ["--green", "--green-text", "--green-bg", "--red", "--red-text", "--red-bg", "--amber", "--amber-text", "--amber-bg", "--info"] as const;
  const projections = new Map<string, string>();
  for (const [id, palette] of Object.entries(BUILTIN_PALETTES)) {
    const preference = normalizeAppearancePreference({
      darkTheme: palette.type === "dark" ? id : null,
      lightTheme: palette.type === "light" ? id : null,
      density: "comfortable",
      win98Trail: true,
      customThemes: []
    });
    const variables = appearanceVariables(resolveAppearance(preference, palette.type, palette.type === "dark"));
    projections.set(STATUS.map(token => variables[token] ?? "").join("|"), `${id}/${palette.type}`);
  }
  assert.equal(
    projections.size,
    1,
    `状态色必须与主题无关，实际有 ${projections.size} 种取值：${[...projections.values()].join(", ")}`
  );
  assert.equal(
    [...projections.keys()][0],
    STATUS.map(() => "").join("|"),
    "调色板不应派生语义状态色，应由 theme.css 的固定值提供"
  );

  const contract = await readFile(new URL("../src/desktop/renderer/src/styles/theme.css", import.meta.url), "utf8");
  assert.match(contract, /--green-text:\s*light-dark\(#007a55, #00d492\);/u, "readable light text / unchanged dark text");
  assert.match(contract, /--red-text:\s*light-dark\(#c10007, #ff6467\);/u, "readable light text / unchanged dark text");
  assert.match(contract, /--amber-text:\s*light-dark\(#a65f00, #ffb900\);/u, "readable light text / unchanged dark text");
  assert.match(contract, /--green-bg:\s*rgb\(0 188 125 \/ 10%\);/u, "emerald-500 / 10");
  assert.match(contract, /--red-bg:\s*rgb\(251 44 54 \/ 10%\);/u, "red-500 / 10");
  assert.match(contract, /--amber-bg:\s*rgb\(254 154 0 \/ 10%\);/u, "amber-500 / 10");
  assert.match(contract, /--info:\s*#2b7fff;/u, "blue-500");
});
