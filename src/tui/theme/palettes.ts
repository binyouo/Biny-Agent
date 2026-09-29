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
    text: "#ededf1",
    subtext: "#b9b9c1",
    dim: "#a2a2ad",
    border: "#50505c",
    borderMuted: "#333339",
    accent: "#a5b4fc",
    mauve: "#c4b5fd",
    green: "#6fd99b",
    red: "#f28b82",
    yellow: "#f2b544",
    teal: "#67e8f9",
    blue: "#93c5fd",
    peach: "#f2b544",
    surface: "#232327",
    selectedBg: "#33345a",
    errorBg: "#45272a"
  },
  colors: { ...semanticColors },
  export: { pageBg: "#1a1a1e", cardBg: "#232327", infoBg: "#2d2d33" }
};

export const lightTheme: ThemeDefinition = {
  name: "light",
  vars: {
    text: "#1c1c21",
    subtext: "#4b4b53",
    dim: "#676772",
    border: "#c8c8d2",
    borderMuted: "#e3e3e8",
    accent: "#4f46e5",
    mauve: "#7c3aed",
    green: "#137644",
    red: "#bf3343",
    yellow: "#96520a",
    teal: "#0e7490",
    blue: "#1d4ed8",
    peach: "#b45309",
    surface: "#f1f1f4",
    selectedBg: "#ecebfb",
    errorBg: "#fbe9e9"
  },
  colors: { ...semanticColors },
  export: { pageBg: "#f4f4f6", cardBg: "#ffffff", infoBg: "#f9f9fb" }
};

export const builtInThemes: Record<string, ThemeDefinition> = {
  dark: darkTheme,
  light: lightTheme
};
