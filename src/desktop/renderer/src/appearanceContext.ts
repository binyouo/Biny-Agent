import { createContext, useContext } from "react";

export const ThemeModeContext = createContext<"light" | "dark">("light");
export function useThemeMode(): "light" | "dark" { return useContext(ThemeModeContext); }
