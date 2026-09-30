export type AppearanceMode = "light" | "dark";
export type AppearanceSkin = "default" | "win98" | "winxp" | "longhorn" | "longhorn-dark";
export type AppearanceDensity = "compact" | "comfortable" | "spacious";

export const BASE30_KEYS = [
  "white", "darker_black", "black", "black2", "one_bg", "one_bg2", "one_bg3", "grey", "grey_fg", "grey_fg2",
  "light_grey", "red", "baby_pink", "pink", "line", "green", "vibrant_green", "blue", "nord_blue", "yellow",
  "sun", "purple", "dark_purple", "teal", "orange", "cyan", "statusline_bg", "lightbg", "pmenu_bg", "folder_bg"
] as const;
export const BASE16_KEYS = ["base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07", "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F"] as const;
export type Base16Colors = Record<typeof BASE16_KEYS[number], string>;
export interface ThemePalette {
  name: string;
  type: AppearanceMode;
  base_30: Record<typeof BASE30_KEYS[number], string> & Record<string, string>;
  base_16: Partial<Base16Colors>;
}
export interface ThemeInfo {
  id: string;
  displayName: string;
  type: AppearanceMode;
  skin: AppearanceSkin;
}
export interface CustomAppearanceTheme extends ThemePalette {
  displayName: string;
}
export interface AppearancePreference {
  darkTheme: string | null;
  lightTheme: string | null;
  density: AppearanceDensity;
  win98Trail: boolean;
  customThemes: CustomAppearanceTheme[];
}
export interface ResolvedAppearance {
  mode: AppearanceMode;
  themeId: string | null;
  skin: AppearanceSkin;
  density: AppearanceDensity;
  palette?: ThemePalette;
  variables: Record<string, string>;
  win98Trail: boolean;
}

export interface AppearanceSnapshot {
  themePreference: "system" | "light" | "dark";
  appearancePreference: AppearancePreference;
  fontPreference: { family: string; size: number };
}
