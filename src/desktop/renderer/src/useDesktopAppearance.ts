import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_APPEARANCE, normalizeAppearancePreference } from "../../../appearance/preferences.js";
import type { AppearancePreference, AppearanceSnapshot } from "../../../appearance/types.js";
import { DEFAULT_FONT_PREFERENCE } from "../../fontPreference.js";
import type { DesktopBootstrap, DesktopFontPreference, DesktopThemePreference } from "../../protocol.js";
import { readAppearanceCache } from "./appearance.js";

export function useDesktopAppearance(onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<AppearanceSnapshot>(() => readAppearanceCache() ?? {
    themePreference: (document.documentElement.dataset.themePreference ?? "system") as DesktopThemePreference,
    appearancePreference: structuredClone(DEFAULT_APPEARANCE), fontPreference: DEFAULT_FONT_PREFERENCE
  });
  const current = useRef(snapshot);
  const adopt = useCallback((value: AppearanceSnapshot): void => { current.current = value; setSnapshot(value); }, []);
  useEffect(() => window.biny.onAppearanceChanged(adopt), [adopt]);
  const bootstrap = useCallback((value: DesktopBootstrap): void => adopt({
    themePreference: value.themePreference ?? "system", appearancePreference: normalizeAppearancePreference(value.appearancePreference), fontPreference: value.fontPreference ?? DEFAULT_FONT_PREFERENCE
  }), [adopt]);
  const preview = useCallback((patch: Partial<AppearanceSnapshot>): void => {
    const next = { ...current.current, ...patch };
    adopt(next);
    void window.biny.previewAppearance(next).catch((error: unknown) => onError(`外观预览失败：${error instanceof Error ? error.message : String(error)}`));
  }, [adopt, onError]);
  const changeThemePreference = useCallback((themePreference: DesktopThemePreference): void => preview({ themePreference }), [preview]);
  const changeFontPreference = useCallback((fontPreference: DesktopFontPreference): void => preview({ fontPreference }), [preview]);
  const changeAppearancePreference = useCallback((appearancePreference: AppearancePreference): void => preview({ appearancePreference }), [preview]);
  return { snapshot, adopt, bootstrap, changeThemePreference, changeFontPreference, changeAppearancePreference };
}
