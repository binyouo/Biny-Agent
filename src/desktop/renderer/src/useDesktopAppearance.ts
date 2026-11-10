import type { DesktopAppearanceSnapshot } from "../../protocol.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_FONT_PREFERENCE } from "../../fontPreference.js";
import type { DesktopBootstrap, DesktopFontPreference, DesktopThemePreference } from "../../protocol.js";
import { readAppearanceCache } from "./appearance.js";

export function useDesktopAppearance(onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<DesktopAppearanceSnapshot>(() => readAppearanceCache() ?? {
    themePreference: (document.documentElement.dataset.themePreference ?? "system") as DesktopThemePreference,
    fontPreference: DEFAULT_FONT_PREFERENCE
  });
  const current = useRef(snapshot);
  const adopt = useCallback((value: DesktopAppearanceSnapshot): void => { current.current = value; setSnapshot(value); }, []);
  useEffect(() => window.biny.onAppearanceChanged(adopt), [adopt]);
  const bootstrap = useCallback((value: DesktopBootstrap): void => adopt({
    themePreference: value.themePreference ?? "system", fontPreference: value.fontPreference ?? DEFAULT_FONT_PREFERENCE
  }), [adopt]);
  const preview = useCallback((patch: Partial<DesktopAppearanceSnapshot>): void => {
    const next = { ...current.current, ...patch };
    adopt(next);
    void window.biny.previewAppearance(next).catch((error: unknown) => onError(`外观预览失败：${error instanceof Error ? error.message : String(error)}`));
  }, [adopt, onError]);
  const changeThemePreference = useCallback((themePreference: DesktopThemePreference): void => preview({ themePreference }), [preview]);
  const changeFontPreference = useCallback((fontPreference: DesktopFontPreference): void => preview({ fontPreference }), [preview]);
  return { snapshot, adopt, bootstrap, changeThemePreference, changeFontPreference };
}
