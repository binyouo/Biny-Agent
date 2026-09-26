/** 项目终端标签持有 PTY，隐藏视图只暂停尺寸同步；关闭标签才终止对应 shell。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { DesktopTerminalTab } from "../../../protocol.js";
import { Icon } from "./Icon.js";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ projectId, active = true }: { projectId: string; active?: boolean }): React.JSX.Element {
  const [tabs, setTabs] = useState<DesktopTerminalTab[]>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void window.biny.listTerminals(projectId).then(async (existing) => {
      const entries = existing.length ? existing : [{ ...(await window.biny.createTerminal(projectId, 80, 24)), slotId: "default" }];
      if (disposed) return;
      setTabs(entries);
      setSelected((current) => entries.some((entry) => entry.slotId === current) ? current : entries[0]?.slotId);
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [active, projectId]);
  const add = async (): Promise<void> => {
    if (requestRef.current) return;
    requestRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const slotId = crypto.randomUUID();
      const handle = await window.biny.createTerminal(projectId, 80, 24, slotId);
      setTabs((current) => [...(current ?? []), { terminalId: handle.terminalId, slotId }]);
      setSelected(slotId);
    } catch (reason) { setError(String(reason)); }
    finally { requestRef.current = false; setBusy(false); }
  };
  const close = async (tab: DesktopTerminalTab): Promise<void> => {
    try {
      await window.biny.disposeTerminal(tab.terminalId);
      setTabs((current) => current?.filter((entry) => entry.slotId !== tab.slotId));
      setSelected((current) => current === tab.slotId ? undefined : current);
    } catch (reason) { setError(String(reason)); }
  };
  const activeSlot = selected ?? tabs?.[0]?.slotId;
  return <section className="inspector-terminals" aria-label="项目终端">
    <div className="inspector-subtoolbar">
      <div className="inspector-terminal-tabs" role="tablist" aria-label="终端会话">
        {(tabs ?? []).map((tab, index) => <div className={`inspector-terminal-tab${activeSlot === tab.slotId ? " is-active" : ""}`} key={tab.slotId}>
          <button type="button" role="tab" aria-selected={activeSlot === tab.slotId} onClick={() => setSelected(tab.slotId)}><Icon name="terminal" size={13} />{tab.slotId === "preview" ? "开发服务器" : `终端 ${index + 1}`}</button>
          <button type="button" aria-label={`关闭终端 ${index + 1} 并终止进程`} title="关闭并终止进程" onClick={() => void close(tab)}><Icon name="close" size={12} /></button>
        </div>)}
      </div>
      <button type="button" aria-label="新建终端" title="新建终端" disabled={busy || tabs === undefined} onClick={() => void add()}><Icon name="add" size={15} /></button>
    </div>
    {error ? <div className="inspector-error" role="alert">{error}<button type="button" onClick={() => {
      if (tabs !== undefined) { setError(undefined); return; }
      void window.biny.listTerminals(projectId).then((entries) => { setTabs(entries); setSelected(entries[0]?.slotId); setError(undefined); }).catch((reason: unknown) => setError(String(reason)));
    }}>{tabs === undefined ? "重试连接" : "关闭提示"}</button></div> : null}
    {tabs === undefined && !error ? <div className="inspector-empty" role="status">正在连接终端…</div> : null}
    {tabs?.length === 0 ? <div className="inspector-empty"><Icon name="terminal" size={24} /><p>没有打开的终端</p><button type="button" disabled={busy} onClick={() => void add()}>新建终端</button></div> : null}
    {(tabs ?? []).map((tab) => <div className="inspector-terminal-screen" hidden={activeSlot !== tab.slotId} key={tab.slotId}>
      <TerminalScreen projectId={projectId} slotId={tab.slotId} active={active && activeSlot === tab.slotId} onHandle={(terminalId) => setTabs((current) => current?.map((entry) => entry.slotId === tab.slotId && entry.terminalId !== terminalId ? { ...entry, terminalId } : entry))} />
    </div>)}
  </section>;
}

function TerminalScreen({ projectId, slotId, active, onHandle }: { projectId: string; slotId: string; active: boolean; onHandle(id: string): void }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const activeRef = useRef(active);
  const handleRef = useRef(onHandle);
  useLayoutEffect(() => { activeRef.current = active; handleRef.current = onHandle; }, [active, onHandle]);
  const [error, setError] = useState<string>();
  const [exitCode, setExitCode] = useState<number>();
  const [restartToken, setRestartToken] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setError(undefined);
    setExitCode(undefined);
    const term = new Terminal({ cursorBlink: true, scrollback: 5_000, fontSize: 13, lineHeight: 1.3,
      fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "Menlo, monospace" });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminalRef.current = term;
    fitRef.current = fit;
    let terminalId: string | undefined;
    let disposed = false;
    const applyTheme = (): void => {
      const styles = getComputedStyle(container);
      term.options.theme = { background: styles.getPropertyValue("--code").trim(), foreground: styles.getPropertyValue("--text").trim(), cursor: styles.getPropertyValue("--text").trim() };
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const fitVisible = (): void => { if (activeRef.current && container.clientWidth > 40 && container.clientHeight > 40) fit.fit(); };
    const observer = new ResizeObserver(fitVisible);
    observer.observe(container);
    const data = term.onData((value) => { if (terminalId) window.biny.writeTerminal(terminalId, value); });
    const resize = term.onResize(({ cols, rows }) => { if (terminalId) window.biny.resizeTerminal(terminalId, cols, rows); });
    // 先订阅再连接；用输出序号排除 replay 已包含的事件，覆盖 IPC 回执前的输出窗口。
    const pending: import("../../../protocol.js").DesktopTerminalEvent[] = [];
    const applyEvent = (event: import("../../../protocol.js").DesktopTerminalEvent): void => {
      if (event.terminalId !== terminalId) return;
      if (event.type === "data") term.write(event.data);
      else setExitCode(event.exitCode);
    };
    const unsubscribe = window.biny.onTerminalEvent((event) => { if (!terminalId) pending.push(event); else applyEvent(event); });
    void window.biny.createTerminal(projectId, 80, 24, slotId).then((handle) => {
      if (disposed) return;
      terminalId = handle.terminalId;
      handleRef.current(terminalId);
      if (handle.replay) term.write(handle.replay);
      for (const event of pending) if (event.sequence > handle.sequence) applyEvent(event);
      pending.length = 0;
      fitVisible();
      if (activeRef.current) term.focus();
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; observer.disconnect(); themeObserver.disconnect(); unsubscribe(); data.dispose(); resize.dispose(); term.dispose(); terminalRef.current = undefined; fitRef.current = undefined; };
  }, [projectId, slotId, restartToken]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { if ((containerRef.current?.clientWidth ?? 0) > 40) { fitRef.current?.fit(); terminalRef.current?.focus(); } });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return <div className="terminal-view">
    <div className="terminal-screen" ref={containerRef} />
    {error !== undefined || exitCode !== undefined ? <div className="terminal-overlay"><span>{error ?? `进程已退出（${exitCode}）`}</span><button type="button" onClick={() => setRestartToken((token) => token + 1)}>重新启动</button></div> : null}
  </div>;
}
