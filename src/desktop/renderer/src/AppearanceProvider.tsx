import type { DesktopAppearanceSnapshot } from "../../protocol.js";
import { useLayoutEffect, useState } from "react";
import { applyAppearance } from "./appearance.js";
import { ThemeModeContext } from "./appearanceContext.js";

export function AppearanceProvider({ snapshot, children }: { snapshot: DesktopAppearanceSnapshot; children: React.ReactNode }): React.JSX.Element {
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const mode = snapshot.themePreference === "dark" || (snapshot.themePreference === "system" && systemDark) ? "dark" : "light";
  useLayoutEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = (): void => setSystemDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useLayoutEffect(() => {
    applyAppearance(document.documentElement, snapshot);
  }, [mode, snapshot]);
  return <ThemeModeContext value={mode}>{children}</ThemeModeContext>;
}
