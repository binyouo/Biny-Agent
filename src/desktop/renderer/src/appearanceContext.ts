import { createContext, useContext } from "react";
import { DEFAULT_APPEARANCE } from "../../../appearance/preferences.js";
import { resolveAppearance } from "../../../appearance/resolve.js";
import type { ResolvedAppearance } from "../../../appearance/types.js";

export const AppearanceContext = createContext<ResolvedAppearance>(resolveAppearance(DEFAULT_APPEARANCE, "system", false));
export function useAppearance(): ResolvedAppearance { return useContext(AppearanceContext); }
