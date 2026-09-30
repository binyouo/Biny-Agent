import { useEffect, useState } from "react";
import { useAppearance } from "../appearanceContext.js";

export function RetroFolderIcon(): React.JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges"><path d="M1 3h5l2 2h6v9H1z" fill="#ffff80" stroke="#808000" /><path d="M2 6h13l-2 8H1z" fill="#ffff00" stroke="#808000" /></svg>;
}

export function WindowChrome({ title = "Biny" }: { title?: string }): React.JSX.Element | null {
  const appearance = useAppearance();
  const [error, setError] = useState<string>();
  const retro = appearance.skin !== "default";
  useEffect(() => {
    const root = document.documentElement;
    if (!retro) { root.removeAttribute("data-win98-blurred"); return; }
    const sync = (): void => { if (document.hasFocus()) root.removeAttribute("data-win98-blurred"); else root.setAttribute("data-win98-blurred", ""); };
    sync(); window.addEventListener("focus", sync); window.addEventListener("blur", sync);
    return () => { window.removeEventListener("focus", sync); window.removeEventListener("blur", sync); root.removeAttribute("data-win98-blurred"); };
  }, [retro]);
  if (!retro) return null;
  const action = (value: "minimize" | "maximize" | "close"): void => { void window.biny.windowAction(value).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))); };
  return <><header className="desktop-title-bar biny-retro-titlebar" onDoubleClick={() => action("maximize")}><span className="win98-window-title"><span className="win98-title-icon">▣</span>{title}</span>
    <div className="win98-window-controls" onDoubleClick={event => event.stopPropagation()}>
      <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => action("minimize")}><svg width="8" height="7" viewBox="0 0 8 7" aria-hidden="true"><rect x="0" y="5" width="6" height="2" fill="currentColor" /></svg></button>
      <button type="button" aria-label="最大化或还原窗口" title="最大化 / 还原" onClick={() => action("maximize")}><svg width="9" height="8" viewBox="0 0 9 8" aria-hidden="true"><path d="M0 0h9v8H0V0zm1 3v4h7V3H1z" fill="currentColor" /></svg></button>
      <button type="button" aria-label="关闭窗口" title="关闭" className="win98-close" onClick={() => action("close")}><svg width="8" height="7" viewBox="0 0 8 7" aria-hidden="true"><path d="M0.5 0.5l7 6M7.5 0.5l-7 6" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg></button>
    </div></header>{error ? <p role="alert" className="biny-retro-window-error">{error}</p> : null}</>;
}

export function RetroStatusBar({ children }: { children?: React.ReactNode }): React.JSX.Element | null {
  const appearance = useAppearance();
  if (appearance.skin === "default") return null;
  return <footer className="win98-status-bar"><span className="win98-status-cell grow">{children ?? "就绪"}</span><span className="win98-status-cell">Biny</span></footer>;
}
