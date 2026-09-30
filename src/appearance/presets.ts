import type { SimpleThemeColors } from "./editing.js";

export const DEFAULT_SIMPLE_THEME_COLORS: SimpleThemeColors = {
  background: "#1e222a",
  foreground: "#abb2bf",
  accent: "#61afef",
  secondary: "#98c379"
};

export const SIMPLE_THEME_PRESETS: Record<string, { name: string; dark: SimpleThemeColors; light: SimpleThemeColors }> = {
  "ocean": {
    "name": "Ocean",
    "dark": {
      "background": "#1a1b26",
      "foreground": "#c0caf5",
      "accent": "#7aa2f7",
      "secondary": "#9ece6a"
    },
    "light": {
      "background": "#f5f5f5",
      "foreground": "#343b58",
      "accent": "#2e7de9",
      "secondary": "#587539"
    }
  },
  "forest": {
    "name": "Forest",
    "dark": {
      "background": "#1e2326",
      "foreground": "#d3c6aa",
      "accent": "#a7c080",
      "secondary": "#83c092"
    },
    "light": {
      "background": "#fdf6e3",
      "foreground": "#5c6a72",
      "accent": "#8da101",
      "secondary": "#35a77c"
    }
  },
  "sunset": {
    "name": "Sunset",
    "dark": {
      "background": "#1f1d2e",
      "foreground": "#e0def4",
      "accent": "#eb6f92",
      "secondary": "#f6c177"
    },
    "light": {
      "background": "#faf4ed",
      "foreground": "#575279",
      "accent": "#b4637a",
      "secondary": "#ea9d34"
    }
  },
  "nord": {
    "name": "Nord",
    "dark": {
      "background": "#2e3440",
      "foreground": "#eceff4",
      "accent": "#88c0d0",
      "secondary": "#a3be8c"
    },
    "light": {
      "background": "#eceff4",
      "foreground": "#2e3440",
      "accent": "#5e81ac",
      "secondary": "#a3be8c"
    }
  },
  "monokai": {
    "name": "Monokai",
    "dark": {
      "background": "#272822",
      "foreground": "#f8f8f2",
      "accent": "#66d9ef",
      "secondary": "#a6e22e"
    },
    "light": {
      "background": "#fafafa",
      "foreground": "#272822",
      "accent": "#0095d8",
      "secondary": "#7eb105"
    }
  }
};
