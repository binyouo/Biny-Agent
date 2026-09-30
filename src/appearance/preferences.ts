import { z } from "zod";
import { BUILTIN_PALETTES, BUILTIN_THEME_INFO } from "./catalog.js";
import { BASE16_KEYS, BASE30_KEYS, type AppearancePreference, type CustomAppearanceTheme } from "./types.js";

const hexColor = z.string().regex(/^#[\da-f]{6}$/iu);
const colors30 = z.object(Object.fromEntries(BASE30_KEYS.map(key => [key, hexColor])) as Record<typeof BASE30_KEYS[number], typeof hexColor>).catchall(hexColor);
const colors16 = z.object(Object.fromEntries(BASE16_KEYS.map(key => [key, hexColor.optional()])) as Record<typeof BASE16_KEYS[number], z.ZodOptional<typeof hexColor>>).strict();
export const customAppearanceThemeSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/iu).max(80),
  displayName: z.string().trim().min(1).max(80),
  type: z.enum(["light", "dark"]),
  base_30: colors30,
  base_16: colors16
}).strict();

export const appearancePreferenceSchema = z.object({
  darkTheme: z.string().min(1).max(100).nullable(),
  lightTheme: z.string().min(1).max(100).nullable(),
  density: z.enum(["compact", "comfortable", "spacious"]),
  win98Trail: z.boolean(),
  customThemes: z.array(customAppearanceThemeSchema).max(100)
}).strict().superRefine((value, context) => {
  const names = new Set<string>();
  for (const theme of value.customThemes) {
    if (names.has(theme.name)) context.addIssue({ code: "custom", path: ["customThemes"], message: "自定义主题名称重复。" });
    names.add(theme.name);
  }
  for (const [field, mode] of [["darkTheme", "dark"], ["lightTheme", "light"]] as const) {
    const id = value[field];
    if (id === null) continue;
    const palette = id.startsWith("custom:") ? value.customThemes.find(theme => theme.name === id.slice(7)) : Object.hasOwn(BUILTIN_PALETTES, id) ? BUILTIN_PALETTES[id] : undefined;
    if (!palette || palette.type !== mode) context.addIssue({ code: "custom", path: [field], message: `请选择有效的${mode === "dark" ? "深色" : "浅色"}主题。` });
  }
});

export const DEFAULT_APPEARANCE: AppearancePreference = {
  darkTheme: null,
  lightTheme: null,
  density: "compact",
  win98Trail: true,
  customThemes: []
};

export function normalizeAppearancePreference(value: unknown): AppearancePreference {
  const parsed = appearancePreferenceSchema.safeParse(value);
  if (parsed.success) return parsed.data as AppearancePreference;
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_APPEARANCE);
  const candidate = value as Partial<AppearancePreference>;
  const customThemes = (Array.isArray(candidate.customThemes) ? candidate.customThemes : []).flatMap(theme => {
    const parsedTheme = customAppearanceThemeSchema.safeParse(theme);
    return parsedTheme.success ? [parsedTheme.data as CustomAppearanceTheme] : [];
  }).filter((theme, index, themes) => themes.findIndex(other => other.name === theme.name) === index).slice(0, 100);
  const pickTheme = (id: unknown, mode: "light" | "dark"): string | null => {
    if (typeof id !== "string") return null;
    const palette = id.startsWith("custom:") ? customThemes.find(theme => theme.name === id.slice(7)) : Object.hasOwn(BUILTIN_PALETTES, id) ? BUILTIN_PALETTES[id] : undefined;
    return palette?.type === mode ? id : null;
  };
  return {
    darkTheme: pickTheme(candidate.darkTheme, "dark"),
    lightTheme: pickTheme(candidate.lightTheme, "light"),
    density: candidate.density === "comfortable" || candidate.density === "spacious" ? candidate.density : "compact",
    win98Trail: candidate.win98Trail !== false,
    customThemes
  };
}

export function listAppearanceThemes(preference: AppearancePreference = DEFAULT_APPEARANCE) {
  return [...BUILTIN_THEME_INFO, ...preference.customThemes.map(theme => ({ id: `custom:${theme.name}`, displayName: theme.displayName, type: theme.type, skin: "default" as const }))];
}
