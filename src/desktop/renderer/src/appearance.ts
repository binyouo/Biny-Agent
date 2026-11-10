import type { DesktopAppearanceSnapshot } from "../../protocol.js";
import { normalizeFontPreference, SYSTEM_FONT_FAMILY } from "../../fontPreference.js";

export const APPEARANCE_CACHE_KEY = "biny:appearance-cache";

export function readAppearanceCache(): DesktopAppearanceSnapshot | undefined {
  try {
    const raw = JSON.parse(window.localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null") as { snapshot?: DesktopAppearanceSnapshot } | null;
    const snapshot = raw?.snapshot;
    if (!snapshot || !["light", "dark", "system"].includes(snapshot.themePreference)
      || typeof snapshot.fontPreference?.family !== "string" || !Number.isFinite(snapshot.fontPreference.size)) return undefined;
    return { themePreference: snapshot.themePreference, fontPreference: normalizeFontPreference(snapshot.fontPreference) };
  } catch {
    return undefined;
  }
}

export function applyAppearance(root: HTMLElement, snapshot: DesktopAppearanceSnapshot): void {
  const mode = snapshot.themePreference === "dark" || (snapshot.themePreference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  root.dataset.theme = mode;
  root.dataset.themePreference = snapshot.themePreference;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
  root.style.setProperty("--app-font-size", String(snapshot.fontPreference.size));
  if (snapshot.fontPreference.family === SYSTEM_FONT_FAMILY) {
    root.style.removeProperty("--font-sans");
  } else root.style.setProperty("--font-sans", `"${snapshot.fontPreference.family.replaceAll('"', "")}", var(--font-sans-stack)`);
  try {
    window.localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ snapshot }));
  } catch {
    root.dataset.appearanceCache = "unavailable";
  }
}
