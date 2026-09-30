import { useLayoutEffect, useMemo, useState } from "react";
import { resolveAppearance } from "../../../appearance/resolve.js";
import type { AppearanceSnapshot } from "../../../appearance/types.js";
import { applyAppearance } from "./appearance.js";
import { AppearanceContext } from "./appearanceContext.js";
import { loadSkinStyles } from "./appearanceStyles.js";

export function AppearanceProvider({ snapshot, children, onError }: { snapshot: AppearanceSnapshot; children: React.ReactNode; onError?(message: string): void }): React.JSX.Element {
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const resolved = useMemo(() => resolveAppearance(snapshot.appearancePreference, snapshot.themePreference, systemDark), [snapshot.appearancePreference, snapshot.themePreference, systemDark]);
  const [applied, setApplied] = useState(resolved);
  useLayoutEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = (): void => setSystemDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useLayoutEffect(() => {
    let cancelled = false;
    const apply = (): void => {
      if (cancelled) return;
      applyAppearance(document.documentElement, snapshot, resolved);
      setApplied(resolved);
    };
    if (resolved.skin === "default") apply();
    else void loadSkinStyles().then(apply).catch((error: unknown) => {
      if (!cancelled) onError?.(`主题样式加载失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { cancelled = true; };
  }, [onError, resolved, snapshot]);
  return <AppearanceContext value={applied}>{children}</AppearanceContext>;
}
