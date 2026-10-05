import { normalizeAppearancePreference } from "../../../appearance/preferences.js";
import { resolveAppearance } from "../../../appearance/resolve.js";
import type { AppearanceSnapshot, ResolvedAppearance } from "../../../appearance/types.js";
import { normalizeFontPreference, SYSTEM_FONT_FAMILY } from "../../fontPreference.js";

export const APPEARANCE_CACHE_KEY = "biny:appearance-cache";
const APPEARANCE_CACHE_VERSION = 1;
const rootVariables = new WeakMap<HTMLElement, Set<string>>();

export function readAppearanceCache(): AppearanceSnapshot | undefined {
  try {
    const raw = JSON.parse(window.localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null") as { snapshot?: AppearanceSnapshot } | null;
    const snapshot = raw?.snapshot;
    if (!snapshot || !["light", "dark", "system"].includes(snapshot.themePreference)
      || typeof snapshot.fontPreference?.family !== "string" || !Number.isFinite(snapshot.fontPreference.size)) return undefined;
    return { ...snapshot, appearancePreference: normalizeAppearancePreference(snapshot.appearancePreference), fontPreference: normalizeFontPreference(snapshot.fontPreference) };
  } catch {
    return undefined;
  }
}

export function appearanceVariables(appearance: ResolvedAppearance): Record<string, string> {
  const variables = { ...appearance.variables };
  if (!appearance.palette) return variables;
  const colors = appearance.palette.base_30;
  const source = appearance.variables;
  const aliases = {
    "--bg": "--background", "--surface": "--card", "--surface-raised": "--popover", "--surface-soft": "--secondary",
    "--surface-hover": "--muted", "--surface-selected": "--sidebar-accent", "--text": "--foreground",
    "--text-secondary": "--muted-foreground", "--text-tertiary": "--muted-foreground", "--accent": "--primary",
    "--accent-hover": "--primary", "--accent-foreground": "--primary-foreground", "--accent-soft": "--secondary",
    "--user-bubble": "--chat-user-bg", "--composer-surface": "--popover", "--code": "--syntax-bg",
    "--text-selection": "--syntax-selection", "--syntax-number": "--syntax-constant", "--syntax-type": "--syntax-class"
  };
  for (const [target, origin] of Object.entries(aliases)) variables[target] = source[origin]!;
  Object.assign(variables, {
    /* 语义状态色（--green* / --red* / --amber*）故意不在这里派生：
       Alma 的状态色是固定的 Tailwind 标尺，不随主题变（见 theme.css）。 */
    "--border-subtle": `${colors.line}40`, "--border-strong": colors.line,
    "--segment-track": colors.one_bg, "--segment-thumb": colors.one_bg2, "--switch-thumb": colors.white,
    "--shadow": appearance.mode === "dark" ? "#00000040" : "#00000010", "--shadow-soft": "#00000020", "--shadow-heavy": "#00000066",
    "--overlay": "#00000066", "--overlay-hover": `${colors.white}15`, "--overlay-pressed": `${colors.white}25`,
    "--syntax-operator": source["--syntax-keyword"]!
  });
  return variables;
}

export function applyAppearance(root: HTMLElement, snapshot: AppearanceSnapshot, appearance = resolveAppearance(snapshot.appearancePreference, snapshot.themePreference, window.matchMedia("(prefers-color-scheme: dark)").matches)): void {
  const variables = appearanceVariables(appearance);
  let previous = rootVariables.get(root);
  if (!previous) {
    try {
      const cached = JSON.parse(window.localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null") as { variables?: Record<string, string>; variants?: Record<string, { variables: Record<string, string> }> } | null;
      previous = new Set([...Object.keys(cached?.variables ?? {}), ...Object.values(cached?.variants ?? {}).flatMap(variant => Object.keys(variant.variables))]);
    }
    catch { previous = new Set(); }
  }
  for (const name of previous) if (!(name in variables)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  rootVariables.set(root, new Set(Object.keys(variables)));
  root.dataset.theme = appearance.mode;
  root.dataset.themePreference = snapshot.themePreference;
  root.dataset.appearanceSkin = appearance.skin;
  root.dataset.uiDensity = appearance.density;
  if (appearance.themeId) root.dataset.base46Theme = appearance.themeId;
  else delete root.dataset.base46Theme;
  root.classList.toggle("dark", appearance.mode === "dark");
  root.classList.toggle("light", appearance.mode === "light");
  root.style.setProperty("--app-font-size", String(snapshot.fontPreference.size));
  if (snapshot.fontPreference.family === SYSTEM_FONT_FAMILY) {
    if (appearance.skin === "default") root.style.removeProperty("--font-sans");
    else root.style.setProperty("--font-sans", "Tahoma, 'MS Sans Serif', Arial, sans-serif");
  } else root.style.setProperty("--font-sans", `"${snapshot.fontPreference.family.replaceAll('"', "")}", var(--font-sans-stack)`);
  try {
    const variants = Object.fromEntries((["light", "dark"] as const).map(mode => { const variant = resolveAppearance(snapshot.appearancePreference, mode, false); return [mode, { skin: variant.skin, themeId: variant.themeId, variables: appearanceVariables(variant) }]; }));
    window.localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ version: APPEARANCE_CACHE_VERSION, snapshot, mode: appearance.mode, skin: appearance.skin, themeId: appearance.themeId, density: appearance.density, variables, variants }));
  } catch {
    root.dataset.appearanceCache = "unavailable";
  }
}
