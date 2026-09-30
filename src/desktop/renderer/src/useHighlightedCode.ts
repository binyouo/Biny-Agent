/**
 * 异步语法高亮 hook。
 *
 * Shiki 一次高亮是大块同步 CPU 工作（两百行代码 50-200ms，tokenize 占大头），绝不能
 * 跟着流式增量跑。这里用 300ms debounce：代码持续变化期间只出转义纯文本（先可读），
 * 停顿/结束后才高亮一次，颜色随后补上；语言标签同步给出，避免「纯文本 → 具体语言」跳动。
 * cleanup 作废未落地的高亮请求，deps 频繁变化时永远只有最后一次会写入状态。
 */
import { useEffect, useState } from "react";
import { escapeHtml, highlightFencedCode, highlightWorkspaceFile, languageForFence, languageForPath, type HighlightedCode } from "./syntaxHighlight.js";
import { useAppearance } from "./appearanceContext.js";
import type { ThemePalette } from "../../../appearance/types.js";

/** 代码持续变化期间的高亮去抖间隔；打字机流式场景下等于「停顿才上色」。 */
const HIGHLIGHT_DEBOUNCE_MS = 300;

export function useHighlightedCode(code: string, language?: string, filePath?: string): HighlightedCode {
  const { palette } = useAppearance();
  const [state, setState] = useState<{ code: string; language?: string; filePath?: string; palette?: ThemePalette; highlighted: HighlightedCode } | undefined>();

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      const request = filePath
        ? highlightWorkspaceFile(filePath, code, palette)
        : highlightFencedCode(code, language, palette);
      request
        .then((highlighted) => {
          if (active) setState({ code, language, filePath, palette, highlighted });
        })
        .catch(() => {});
    }, HIGHLIGHT_DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [code, language, filePath, palette]);

  if (state && state.code === code && state.language === language && state.filePath === filePath && state.palette === palette) return state.highlighted;
  return { html: escapeHtml(code), language: filePath ? languageForPath(filePath) : languageForFence(language) };
}
