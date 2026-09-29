/**
 * 终端组件的主题适配。
 *
 * 框架组件接受的是 `(text) => string` 着色函数，这里把主题 token 包成组件需要的形状。
 * 每次调用都读当前生效主题，所以切换主题后重新取一次即可。
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";
import { getTheme } from "./theme.js";
import type { ThemeBg, ThemeColor } from "./tokens.js";

/**
 * 取色代理：`theme.fg("accent", text)`。
 *
 * 直接导出 `getTheme()` 的结果会在切换主题后拿到旧实例，所以这里每次转发。
 */
export const theme = {
  fg: (token: ThemeColor, text: string): string => getTheme().fg(token, text),
  bg: (token: ThemeBg, text: string): string => getTheme().bg(token, text),
  bold: (text: string): string => getTheme().bold(text),
  italic: (text: string): string => getTheme().italic(text),
  underline: (text: string): string => getTheme().underline(text),
  strikethrough: (text: string): string => getTheme().strikethrough(text),
  inverse: (text: string): string => getTheme().inverse(text),
  /** 便于传给组件的着色函数工厂。 */
  color: (token: ThemeColor) => (text: string): string => getTheme().fg(token, text),
  background: (token: ThemeBg) => (text: string): string => getTheme().bg(token, text),
  thinkingBorder: (level: string | undefined) => getTheme().thinkingBorder(level)
};

export function markdownTheme(): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
    // 代码块暂不做语法高亮，整块用 mdCodeBlock 着色，与主题保持一致。
    highlightCode: (code) => code.split("\n").map((line) => theme.fg("mdCodeBlock", line))
  };
}

export function selectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.bg("selectedBg", theme.fg("text", theme.bold(text))),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text)
  };
}

export function editorTheme(): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: selectListTheme()
  };
}

export function settingsListTheme(): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text)
  };
}
