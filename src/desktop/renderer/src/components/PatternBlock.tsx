import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppearance } from "../appearanceContext.js";
import { useHighlightedCode } from "../useHighlightedCode.js";
import { readPatternPlayerStatus, type PatternPlayerStatus } from "../patternPlayer.js";
import { CopyButton } from "./CopyButton.js";

const players = new Set<() => void>();

export function PatternBlock({ code, isStreaming = false }: { code: string; isStreaming?: boolean }): React.JSX.Element {
  const highlighted = useHighlightedCode(code, "javascript", undefined, isStreaming);
  const { mode, variables } = useAppearance();
  const frame = useRef<HTMLIFrameElement>(null);
  const playerWindow = useRef<Window | null>(null);
  const initialized = useRef(false);
  const [token] = useState(() => crypto.randomUUID());
  const [document, setDocument] = useState<string>();
  const [status, setStatus] = useState<PatternPlayerStatus>({ kind: "pattern-state", token, state: "ready" });
  const currentCode = useRef(code);
  const theme = useRef({ mode, variables });
  useEffect(() => { currentCode.current = code; theme.current = { mode, variables }; }, [code, mode, variables]);
  const sendCode = useCallback((): void => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    playerWindow.current = target;
    initialized.current = true;
    const rootStyle = window.getComputedStyle(window.document.documentElement);
    const bodyStyle = window.getComputedStyle(window.document.body);
    target.postMessage({ kind: "pattern-control", token, action: "set-code", code: currentCode.current,
      theme: { ...theme.current, fontScale: (parseFloat(bodyStyle.fontSize) || 14) / 14,
        fontFamily: bodyStyle.fontFamily,
        fontMono: rootStyle.getPropertyValue("--font-mono") }
    }, "*");
  }, [token]);
  useEffect(() => {
    let active = true;
    void import("../patternPlayerEngine.js").then(module => { if (active) setDocument(module.loadPatternPlayerDocument(token)); })
      .catch(() => { if (active) setStatus({ kind: "pattern-state", token, state: "error", message: "音乐播放器加载失败。" }); });
    return () => { active = false; };
  }, [token]);
  useEffect(() => {
    const stop = (): void => playerWindow.current?.postMessage({ kind: "pattern-control", token, action: "stop" }, "*");
    players.add(stop);
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const next = readPatternPlayerStatus(event.data, token);
      if (!next) return;
      if (next.state === "loading") { for (const other of players) if (other !== stop) other(); }
      setStatus(next);
      if (next.state === "ready" && !initialized.current) sendCode();
    };
    window.addEventListener("message", receive);
    return () => { stop(); players.delete(stop); window.removeEventListener("message", receive); };
  }, [token, sendCode]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ kind: "pattern-control", token, action: "stop" }, "*");
    sendCode();
  }, [code, mode, variables, token, sendCode]);
  return <section className="markdown-pattern" data-state={status.state} aria-label="音乐片段">
    <header className="markdown-pattern-header"><span className="markdown-pattern-title"><span className="markdown-pattern-dot" />音乐片段</span>
      <CopyButton value={code} label="复制音乐代码" size={12} /></header>
    <div className="markdown-pattern-code"><code className="shiki" dangerouslySetInnerHTML={{ __html: highlighted.html }} /></div>
    {document ? <iframe ref={frame} className="markdown-pattern-player" title="音乐播放器" sandbox="allow-scripts" allow="autoplay" srcDoc={document} onLoad={sendCode} />
      : <p className="markdown-pattern-loading" role="status">加载音乐播放器…</p>}
    {status.state === "error" ? <p className="markdown-pattern-error" role="alert">{status.message}</p> : null}
  </section>;
}
