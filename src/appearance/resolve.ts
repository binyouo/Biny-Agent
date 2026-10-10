import { BUILTIN_PALETTES, BUILTIN_THEME_INFO } from "./catalog.js";
import { mapPaletteVariables, syntaxVariables } from "./palette.js";
import { normalizeAppearancePreference } from "./preferences.js";
import type { AppearancePreference, ResolvedAppearance } from "./types.js";

export function resolveAppearance(preference: AppearancePreference, modePreference: "system" | "light" | "dark", systemDark: boolean): ResolvedAppearance {
  const normalized = normalizeAppearancePreference(preference);
  const mode = modePreference === "dark" || (modePreference === "system" && systemDark) ? "dark" : "light";
  const themeId = mode === "dark" ? normalized.darkTheme : normalized.lightTheme;
  const palette = themeId?.startsWith("custom:") ? normalized.customThemes.find(theme => theme.name === themeId.slice(7)) : themeId && Object.hasOwn(BUILTIN_PALETTES, themeId) ? BUILTIN_PALETTES[themeId] : undefined;
  const skin = BUILTIN_THEME_INFO.find(theme => theme.id === themeId)?.skin ?? "default";
  return {
    mode,
    themeId,
    skin,
    palette,
    variables: palette ? { ...mapPaletteVariables(palette), ...syntaxVariables(palette) } : {},
    win98Trail: skin === "win98" && normalized.win98Trail
  };
}
