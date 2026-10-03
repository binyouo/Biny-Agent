/**
 * 异步语法高亮 hook。
 *
 * Shiki 一次高亮是大块同步 CPU 工作（两百行代码 50-200ms，tokenize 占大头），绝不能
 * 跟着每个流式增量跑。聊天代码每 250ms 补色并保留已完成行，文件阅读去抖 300ms；
 * 语言标签同步给出，避免「纯文本 → 具体语言」跳动。
 * cleanup 作废未落地的高亮请求，只有当前请求可以更新展示。
 */
import { useEffect, useRef, useState } from "react";
import { escapeHtml, highlightFencedCode, highlightWorkspaceFile, languageForFence, languageForPath, type HighlightedCode } from "./syntaxHighlight.js";
import { useAppearance } from "./appearanceContext.js";
import type { ThemePalette } from "../../../appearance/types.js";

/** 代码持续变化期间的高亮去抖间隔；打字机流式场景下等于「停顿才上色」。 */
const HIGHLIGHT_DEBOUNCE_MS = 300;

export function useHighlightedCode(code: string, language?: string, filePath?: string, isStreaming?: boolean): HighlightedCode {
  const { palette } = useAppearance();
  const [state, setState] = useState<{ code: string; language?: string; filePath?: string; palette?: ThemePalette; highlighted: HighlightedCode } | undefined>();
  const lastRequest = useRef(0);

  useEffect(() => {
    let active = true;
    const run = (): void => {
      lastRequest.current = Date.now();
      const request = filePath
        ? highlightWorkspaceFile(filePath, code, palette)
        : highlightFencedCode(code, language, palette);
      request
        .then((highlighted) => {
          if (active) setState({ code, language, filePath, palette, highlighted });
        })
        .catch(() => {});
    };
    // 聊天历史立即上色，流式期间定期补色；文件阅读仍沿用去抖。
    const delay = isStreaming === undefined ? HIGHLIGHT_DEBOUNCE_MS : isStreaming ? Math.max(0, 250 - (Date.now() - lastRequest.current)) : 0;
    const timer = delay ? window.setTimeout(run, delay) : undefined;
    if (!delay) run();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [code, language, filePath, palette, isStreaming]);

  if (state && state.code === code && state.language === language && state.filePath === filePath && state.palette === palette) return state.highlighted;
  // 只复用内容完全一致的行：正在增长或被替换的行必须显示当前转义文本。
  if (isStreaming && state && state.language === language && state.filePath === filePath && state.palette === palette) {
    const previous = state.code.split("\n");
    const current = code.split("\n");
    const colored = state.highlighted.html.split("\n");
    let common = 0;
    while (common < Math.min(previous.length, current.length, colored.length) && previous[common] === current[common]) common++;
    return { html: [...colored.slice(0, common), ...current.slice(common).map(escapeHtml)].join("\n"), language: state.highlighted.language };
  }
  return { html: escapeHtml(code), language: filePath ? languageForPath(filePath) : languageForFence(language) };
}
