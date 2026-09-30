/** 浅深主题共用语义映射；层级由中性色表达，强调色留给选择、代码与状态。 */
import type { ThemeDefinition } from "./tokens.js";

const semanticColors: ThemeDefinition["colors"] = {
  accent: "accent",
  border: "border",
  borderAccent: "accent",
  borderMuted: "borderMuted",
  success: "green",
  error: "red",
  warning: "yellow",
  muted: "subtext",
  dim: "dim",
  text: "text",
  thinkingText: "subtext",
  selectedBg: "selectedBg",
  userMessageBg: "surface",
  userMessageText: "text",
  customMessageBg: "surface",
  customMessageText: "text",
  customMessageLabel: "mauve",
  toolPendingBg: "surface",
  toolSuccessBg: "surface",
  toolErrorBg: "errorBg",
  toolTitle: "text",
  toolOutput: "subtext",
  mdHeading: "text",
  mdLink: "blue",
  mdLinkUrl: "dim",
  mdCode: "peach",
  mdCodeBlock: "text",
  mdCodeBlockBorder: "border",
  mdQuote: "subtext",
  mdQuoteBorder: "border",
  mdHr: "borderMuted",
  mdListBullet: "subtext",
  toolDiffAdded: "green",
  toolDiffRemoved: "red",
  toolDiffContext: "subtext",
  syntaxComment: "dim",
  syntaxKeyword: "mauve",
  syntaxFunction: "blue",
  syntaxVariable: "text",
  syntaxString: "green",
  syntaxNumber: "peach",
  syntaxType: "teal",
  syntaxOperator: "subtext",
  syntaxPunctuation: "subtext",
  thinkingOff: "border",
  thinkingMinimal: "dim",
  thinkingLow: "teal",
  thinkingMedium: "blue",
  thinkingHigh: "accent",
  thinkingXhigh: "mauve",
  thinkingMax: "mauve",
  bashMode: "teal"
};

export const darkTheme: ThemeDefinition = {
  name: "dark",
  vars: {
    text: "#ededed",
    subtext: "#b8b8b8",
    dim: "#a3a3a3",
    border: "#525252",
    borderMuted: "#3b3b3b",
    accent: "#74b6fb",
    mauve: "#74b6fb",
    green: "#6fd99b",
    red: "#f28b82",
    yellow: "#f2b544",
    teal: "#67e8f9",
    blue: "#93c5fd",
    peach: "#f2b544",
    surface: "#242424",
    selectedBg: "#343434",
    errorBg: "#45272a"
  },
  colors: { ...semanticColors },
  export: { pageBg: "#1a1a1a", cardBg: "#242424", infoBg: "#2b2b2b" }
};

export const lightTheme: ThemeDefinition = {
  name: "light",
  vars: {
    text: "#171717",
    subtext: "#525252",
    dim: "#616161",
    border: "#bdbdbd",
    borderMuted: "#dedede",
    accent: "#0f5fa8",
    mauve: "#0f5fa8",
    green: "#137644",
    red: "#bf3343",
    yellow: "#96520a",
    teal: "#0e7490",
    blue: "#1d4ed8",
    peach: "#b45309",
    surface: "#f0f0f0",
    selectedBg: "#e9e9e9",
    errorBg: "#fbe9e9"
  },
  colors: { ...semanticColors },
  export: { pageBg: "#f5f5f5", cardBg: "#ffffff", infoBg: "#fafafa" }
};

export const builtInThemes: Record<string, ThemeDefinition> = {
  dark: darkTheme,
  light: lightTheme
};
