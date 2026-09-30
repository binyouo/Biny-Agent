import type { ThemeRegistration } from "shiki";
import type { Base16Colors, ThemePalette } from "./types.js";
import { readableCommentColor } from "./contrast.js";

export function palettePreviewColors(palette: ThemePalette): string[] {
  const colors = palette.base_30;
  return [palette.type === "light" ? colors.black : colors.one_bg, colors.blue, colors.green, colors.red, colors.purple, colors.white];
}

export function mapPaletteVariables(palette: ThemePalette): Record<string, string> {
  const { base_30, type } = palette;
  const isLight = type === "light";
  if (isLight) {
    return {

      "--background": base_30.black,

      "--foreground": base_30.white,


      "--card": base_30.black,
      "--card-foreground": base_30.white,

      "--popover": base_30.black,
      "--popover-foreground": base_30.white,

      "--primary": base_30.blue,
      "--primary-foreground": base_30.black,

      "--secondary": base_30.darker_black,
      "--secondary-foreground": base_30.white,

      "--muted": base_30.darker_black,
      "--muted-foreground": base_30.grey_fg2,

      "--accent": base_30.black2,

      "--accent-foreground": base_30.white,

      "--destructive": base_30.red,
      "--destructive-foreground": base_30.black,

      "--border": `${base_30.white}20`,
      "--input": base_30.darker_black,
      "--ring": `${base_30.blue}40`,

      "--chart-1": base_30.blue,
      "--chart-2": base_30.purple,
      "--chart-3": base_30.yellow,
      "--chart-4": base_30.green,
      "--chart-5": base_30.red,

      "--sidebar": base_30.black,
      "--sidebar-foreground": base_30.white,
      "--sidebar-primary": base_30.blue,
      "--sidebar-primary-foreground": base_30.black,
      "--sidebar-accent": base_30.black2,

      "--sidebar-accent-foreground": base_30.white,
      "--sidebar-border": `${base_30.white}20`,
      "--sidebar-ring": base_30.blue,

      "--chat-user-bg": base_30.darker_black,
      "--chat-user-foreground": base_30.white
    };
  }
  return {

    "--background": base_30.one_bg,
    "--foreground": base_30.white,

    "--card": base_30.black2,
    "--card-foreground": base_30.white,

    "--popover": base_30.black2,
    "--popover-foreground": base_30.white,

    "--primary": base_30.blue,
    "--primary-foreground": base_30.black,

    "--secondary": base_30.one_bg2,
    "--secondary-foreground": base_30.white,

    "--muted": base_30.one_bg3,
    "--muted-foreground": `${base_30.white}99`,

    "--accent": base_30.green,
    "--accent-foreground": base_30.black,

    "--destructive": base_30.red,
    "--destructive-foreground": base_30.white,

    "--border": base_30.grey,
    "--input": base_30.one_bg2,
    "--ring": `${base_30.blue}40`,


    "--chart-1": base_30.blue,
    "--chart-2": base_30.purple,
    "--chart-3": base_30.yellow,
    "--chart-4": base_30.green,
    "--chart-5": base_30.red,

    "--sidebar": base_30.darker_black,
    "--sidebar-foreground": base_30.white,
    "--sidebar-primary": base_30.blue,
    "--sidebar-primary-foreground": base_30.black,
    "--sidebar-accent": base_30.one_bg,
    "--sidebar-accent-foreground": base_30.white,
    "--sidebar-border": base_30.grey,
    "--sidebar-ring": base_30.blue,

    "--chat-user-bg": base_30.one_bg2,
    "--chat-user-foreground": base_30.white
  };
}
const DEFAULT_DARK_BASE16 = {
  base00: "#282c34",
  base01: "#353b45",
  base02: "#3e4451",
  base03: "#7f848e",

  base04: "#565c64",
  base05: "#abb2bf",
  base06: "#b6bdca",
  base07: "#c8ccd4",
  base08: "#e06c75",
  base09: "#d19a66",
  base0A: "#e5c07b",
  base0B: "#98c379",
  base0C: "#56b6c2",
  base0D: "#61afef",
  base0E: "#c678dd",
  base0F: "#be5046"
};
const DEFAULT_LIGHT_BASE16 = {
  base00: "#fafafa",
  base01: "#f0f0f1",
  base02: "#e5e5e6",
  base03: "#a0a1a7",
  base04: "#696c77",
  base05: "#383a42",
  base06: "#202227",
  base07: "#090a0b",
  base08: "#e45649",
  base09: "#986801",
  base0A: "#c18401",
  base0B: "#50a14f",
  base0C: "#0184bc",
  base0D: "#4078f2",
  base0E: "#a626a4",
  base0F: "#ca1243"
};
export function completeSyntaxColors(palette: ThemePalette): Base16Colors {
  const defaults2 = palette.type === "dark" ? DEFAULT_DARK_BASE16 : DEFAULT_LIGHT_BASE16;
  const { base_16 } = palette;
  const isDark = palette.type === "dark";
  const base00 = base_16.base00 ?? defaults2.base00;
  const rawBase03 = base_16.base03 ?? defaults2.base03;
  const base03 = readableCommentColor(rawBase03, base00, isDark);
  return {
    base00,
    base01: base_16.base01 ?? defaults2.base01,
    base02: base_16.base02 ?? defaults2.base02,
    base03,
    base04: base_16.base04 ?? defaults2.base04,
    base05: base_16.base05 ?? defaults2.base05,
    base06: base_16.base06 ?? defaults2.base06,
    base07: base_16.base07 ?? defaults2.base07,
    base08: base_16.base08 ?? defaults2.base08,
    base09: base_16.base09 ?? defaults2.base09,
    base0A: base_16.base0A ?? defaults2.base0A,
    base0B: base_16.base0B ?? defaults2.base0B,
    base0C: base_16.base0C ?? defaults2.base0C,
    base0D: base_16.base0D ?? defaults2.base0D,
    base0E: base_16.base0E ?? defaults2.base0E,
    base0F: base_16.base0F ?? defaults2.base0F
  };
}
export function syntaxVariables(palette: ThemePalette): Record<string, string> {
  const colors2 = completeSyntaxColors(palette);
  return {
    "--syntax-bg": colors2.base00,
    "--syntax-fg": colors2.base05,
    "--syntax-comment": colors2.base03,
    "--syntax-variable": colors2.base08,
    "--syntax-constant": colors2.base09,
    "--syntax-string": colors2.base0B,
    "--syntax-regex": colors2.base0C,
    "--syntax-function": colors2.base0D,
    "--syntax-keyword": colors2.base0E,
    "--syntax-class": colors2.base0A,
    "--syntax-tag": colors2.base08,
    "--syntax-attribute": colors2.base09,
    "--syntax-selection": colors2.base02
  };
}
export function createSyntaxTheme(palette: ThemePalette): ThemeRegistration {
  const colors2 = completeSyntaxColors(palette);
  const themeName = `biny-theme-${palette.name}`;
  return {
    name: themeName,
    type: palette.type,
    colors: {
      "editor.background": colors2.base00,
      "editor.foreground": colors2.base05,
      "editor.selectionBackground": colors2.base02,
      "editor.lineHighlightBackground": colors2.base01,
      "editorCursor.foreground": colors2.base05,
      "editorWhitespace.foreground": colors2.base03
    },
    tokenColors: [

      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: {
          foreground: colors2.base03,
          fontStyle: "italic"
        }
      },

      {
        scope: ["variable", "variable.other", "variable.parameter", "meta.definition.variable", "entity.name.variable"],
        settings: {
          foreground: colors2.base08
        }
      },

      {
        scope: ["constant", "constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant"],
        settings: {
          foreground: colors2.base09
        }
      },

      {
        scope: ["string", "string.quoted", "string.template"],
        settings: {
          foreground: colors2.base0B
        }
      },

      {
        scope: ["constant.character.escape", "string.regexp", "constant.other.character-class.regexp"],
        settings: {
          foreground: colors2.base0C
        }
      },

      {
        scope: ["entity.name.function", "meta.function-call", "support.function", "meta.function"],
        settings: {
          foreground: colors2.base0D
        }
      },

      {
        scope: ["keyword", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "storage", "storage.type", "storage.modifier"],
        settings: {
          foreground: colors2.base0E
        }
      },

      {
        scope: ["entity.name.class", "entity.name.type", "entity.other.inherited-class", "support.class", "support.type", "entity.name.namespace"],
        settings: {
          foreground: colors2.base0A
        }
      },

      {
        scope: ["entity.name.tag", "meta.tag", "punctuation.definition.tag"],
        settings: {
          foreground: colors2.base08
        }
      },

      {
        scope: ["entity.other.attribute-name"],
        settings: {
          foreground: colors2.base09
        }
      },

      {
        scope: ["keyword.operator", "punctuation.accessor"],
        settings: {
          foreground: colors2.base05
        }
      },

      {
        scope: ["punctuation", "punctuation.separator", "punctuation.terminator", "meta.brace"],
        settings: {
          foreground: colors2.base05
        }
      },

      {
        scope: ["variable.other.property", "variable.other.object.property", "support.variable.property", "meta.object-literal.key"],
        settings: {
          foreground: colors2.base08
        }
      },

      {
        scope: ["support.type.property-name.json"],
        settings: {
          foreground: colors2.base0D
        }
      },

      {
        scope: ["markup.heading", "entity.name.section"],
        settings: {
          foreground: colors2.base0D,
          fontStyle: "bold"
        }
      },

      {
        scope: ["markup.bold"],
        settings: {
          foreground: colors2.base0A,
          fontStyle: "bold"
        }
      },

      {
        scope: ["markup.italic"],
        settings: {
          foreground: colors2.base0E,
          fontStyle: "italic"
        }
      },

      {
        scope: ["markup.inline.raw", "markup.raw"],
        settings: {
          foreground: colors2.base0B
        }
      },

      {
        scope: ["markup.underline.link"],
        settings: {
          foreground: colors2.base0C
        }
      },

      {
        scope: ["markup.inserted", "meta.diff.header.to-file"],
        settings: {
          foreground: colors2.base0B
        }
      },

      {
        scope: ["markup.deleted", "meta.diff.header.from-file"],
        settings: {
          foreground: colors2.base08
        }
      },

      {
        scope: ["markup.changed"],
        settings: {
          foreground: colors2.base0E
        }
      },

      {
        scope: ["invalid", "invalid.deprecated"],
        settings: {
          foreground: colors2.base0F
        }
      }
    ]
  };
}
