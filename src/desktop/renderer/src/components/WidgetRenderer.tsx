import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import { readWidgetMessage } from "../../../../widgets/document.js";
import { WIDGET_MAX_HTML_LENGTH, widgetSchema, type WidgetInput } from "../../../../widgets/widget.js";
import type { TimelineTool } from "../sessionTimeline.js";
import { WidgetContext } from "./WidgetContext.js";
import { CopyButton } from "./CopyButton.js";
import { readThemeColors } from "../themeColors.js";

export const WidgetRenderer = React.memo(function WidgetRenderer({ tool, running, onOpenExternal }: { tool: TimelineTool; running: boolean; onOpenExternal(url: string): void }): React.JSX.Element | null {
  const result = tool.result && typeof tool.result === "object" ? tool.result as Record<string, unknown> : undefined;
  const parsed = result?.kind === "widget" ? widgetSchema.safeParse({ title: result.title, description: result.description, html: result.html }) : undefined;
  const executable = tool.status === "success" && result?.truncated !== true && parsed?.success === true;
  const value = executable ? parsed.data : tool.args && typeof tool.args === "object" ? tool.args as Partial<WidgetInput> : {};
  return tool.tool === "WidgetRenderer" ? <WidgetFrame key={tool.id} title={typeof value.title === "string" ? value.title.slice(0, 160) : "可视化"}
    html={typeof value.html === "string" ? value.html.slice(0, WIDGET_MAX_HTML_LENGTH) : ""} executable={executable} streaming={running && ["waiting", "running"].includes(tool.status)} onOpenExternal={onOpenExternal} /> : null;
});

function WidgetFrame({ title, html, executable, streaming, onOpenExternal }: { title: string; html: string; executable: boolean; streaming: boolean; onOpenExternal(url: string): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [token] = useState(() => globalThis.crypto.randomUUID());
  const [document, setDocument] = useState<string>();
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(80);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<{ type: "send-prompt"; text: string } | { type: "open-link"; url: string }>();
  const revision = useRef(0);
  const latest = useRef({ html, executable });
  const sent = useRef("");
  const pending = useRef<number | undefined>(undefined);
  const { onDraftPrompt } = useContext(WidgetContext);
  useEffect(() => { latest.current = { html, executable }; }, [html, executable]);

  const sendContent = useCallback(() => {
    const value = latest.current;
    const key = `${value.executable}:${value.html}`;
    if (sent.current === key) return;
    frame.current?.contentWindow?.postMessage({ type: "set-content", token, revision: ++revision.current, html: value.html, complete: value.executable }, "*");
    sent.current = key;
  }, [token]);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => { if (active) setError("可视化加载超时，请重试。"); }, 10_000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = readWidgetMessage(event.data, token);
      if (!message) return;
      if (message.type === "widget-ready") { window.clearTimeout(timer); setReady(true); sendContent(); }
      else if (message.type === "widget-resize") setHeight(message.height);
      else if (message.type === "widget-error") setError(message.message);
      else setAction(message);
    };
    window.addEventListener("message", receive);
    setReady(false); setError(undefined); sent.current = ""; setAction(undefined);
    void import("./widgetEngine.js").then(module => { if (active) setDocument(module.loadWidgetDocument(token)); })
      .catch(() => { if (active) setError("可视化加载失败，请重试。"); });
    return () => { active = false; window.clearTimeout(timer); window.clearTimeout(pending.current); pending.current = undefined; window.removeEventListener("message", receive); };
  }, [token, attempt, sendContent]);
  useEffect(() => {
    if (!ready) return;
    if (!streaming) { window.clearTimeout(pending.current); pending.current = undefined; sendContent(); return; }
    if (pending.current === undefined) pending.current = window.setTimeout(() => { pending.current = undefined; sendContent(); }, 150);
  }, [html, executable, streaming, ready, sendContent]);
  useEffect(() => {
    if (!ready) return;
    const update = () => {
      const colors = readThemeColors(window.document.body, {
        background: "--surface", foreground: "--biny-text", primary: "--accent", muted: "--biny-surface-soft",
        secondary: "--biny-text-secondary", border: "--biny-border", card: "--surface-raised", green: "--green", purple: "--file-purple", red: "--red", yellow: "--amber"
      });
      const font = window.getComputedStyle(window.document.body).fontFamily;
      const css = `:root{--background:${colors.background};--foreground:${colors.foreground};--primary:${colors.primary};--muted:${colors.muted};--muted-foreground:${colors.secondary};--border:${colors.border};--card:${colors.card};--chart-1:${colors.primary};--chart-2:${colors.green};--chart-3:${colors.purple};--chart-4:${colors.red};--chart-5:${colors.yellow}}body{font-family:${font}}`;
      const selection = window.document.documentElement.dataset.theme;
      frame.current?.contentWindow?.postMessage({ type: "set-theme", token, css, dark: selection === "dark" || (selection !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches) }, "*");
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(window.document.documentElement, { attributes: true });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, [ready, token]);
  return <section className="chat-widget" data-executable={String(executable)} aria-label={title}>
    {!ready ? <p role="status">正在生成可视化…</p> : null}
    <iframe key={attempt} ref={frame} srcDoc={document} sandbox="allow-scripts" title={title} style={{ height }} />
    {error ? <p role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p> : null}
    <div className="chat-widget-actions"><CopyButton value={html} label="复制可视化源码" size={14} />
      {streaming ? <span role="status">生成中</span> : !executable ? <span>预览未完成，交互尚未启用</span> : null}
      {action?.type === "send-prompt" && onDraftPrompt ? <button type="button" title={action.text} onClick={() => { onDraftPrompt(action.text); setAction(undefined); }}>填入输入框</button> : null}
      {action?.type === "open-link" ? <button type="button" title={action.url} onClick={() => { onOpenExternal(action.url); setAction(undefined); }}>打开链接</button> : null}
    </div>
  </section>;
}
