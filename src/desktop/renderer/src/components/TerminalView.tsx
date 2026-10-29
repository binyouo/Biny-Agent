/** 项目终端标签持有 PTY，隐藏视图只暂停尺寸同步；关闭标签才终止对应 shell。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { DesktopTerminalHandle, DesktopTerminalTab } from "../../../protocol.js";
import { readThemeColors } from "../themeColors.js";
import { Icon } from "./Icon.js";
import "@xterm/xterm/css/xterm.css";
import { TerminalConnectionOwner } from "./terminalConnectionOwner.js";

type TerminalTab = DesktopTerminalTab & { connectionOwner: TerminalConnectionOwner };

export function TerminalView({ projectId, active = true }: { projectId: string; active?: boolean }): React.JSX.Element {
  const [tabs, setTabs] = useState<TerminalTab[]>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(false);
  const listMutationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const connectionOwners = useRef(new Map<string, TerminalConnectionOwner>());
  const [closingSlots, setClosingSlots] = useState<Set<string>>(new Set());
  const ownerFor = useCallback((tab: DesktopTerminalTab): TerminalConnectionOwner => {
    let owner = connectionOwners.current.get(tab.slotId);
    if (!owner) { owner = new TerminalConnectionOwner(tab.terminalId, () => { listMutationRef.current++; }); connectionOwners.current.set(tab.slotId, owner); }
    return owner;
  }, []);
  const acceptEntries = useCallback((entries: DesktopTerminalTab[]): void => {
    for (const entry of entries) {
      const owner = connectionOwners.current.get(entry.slotId);
      if (owner) connectionOwners.current.set(entry.slotId, owner.refresh(entry.terminalId));
    }
    setTabs(entries.map(entry => ({ ...entry, connectionOwner: ownerFor(entry) })));
  }, [ownerFor]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const mutation = ++listMutationRef.current;
    void window.biny.listTerminals(projectId).then(async (existing) => {
      if (disposed || mutation !== listMutationRef.current) return;
      const entries = existing.length ? existing : [{ ...(await window.biny.createTerminal(projectId, 80, 24)), slotId: "default" }];
      if (disposed || mutation !== listMutationRef.current) return;
      acceptEntries(entries);
      setSelected((current) => entries.some((entry) => entry.slotId === current) ? current : entries[0]?.slotId);
    }).catch((reason: unknown) => { if (!disposed && mutation === listMutationRef.current) setError(String(reason)); });
    return () => { disposed = true; };
  }, [active, projectId, acceptEntries]);
  const add = async (): Promise<void> => {
    if (requestRef.current) return;
    requestRef.current = true;
    listMutationRef.current++;
    setBusy(true);
    setError(undefined);
    try {
      const slotId = crypto.randomUUID();
      const handle = await window.biny.createTerminal(projectId, 80, 24, slotId);
      const tab = { terminalId: handle.terminalId, slotId };
      const connectionOwner = ownerFor(tab);
      setTabs((current) => [...(current ?? []), { ...tab, connectionOwner }]);
      setSelected(slotId);
    } catch (reason) { setError(String(reason)); }
    finally { requestRef.current = false; setBusy(false); }
  };
  const close = async (tab: TerminalTab): Promise<void> => {
    const owner = tab.connectionOwner;
    listMutationRef.current++;
    setClosingSlots(current => new Set(current).add(tab.slotId));
    try {
      await owner.close(terminalId => window.biny.disposeTerminal(terminalId));
      if (connectionOwners.current.get(tab.slotId) === owner) connectionOwners.current.delete(tab.slotId);
      setTabs((current) => current?.filter((entry) => entry.slotId !== tab.slotId || !owner.owns(entry.terminalId)));
    } catch (reason) {
      if (mountedRef.current) setError(String(reason));
      else console.error("Terminal close could not be confirmed after leaving the view.", reason);
    }
    finally { setClosingSlots(current => { const next = new Set(current); next.delete(tab.slotId); return next; }); }
  };
  const activeSlot = tabs?.some(tab => tab.slotId === selected) ? selected : tabs?.[0]?.slotId;
  return <section className="inspector-terminals" aria-label="项目终端">
    <div className="inspector-subtoolbar">
      <div className="inspector-terminal-tabs" role="tablist" aria-label="终端会话" onKeyDown={(event) => {
        if (!tabs || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const current = Math.max(0, tabs.findIndex((tab) => tab.slotId === activeSlot));
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault();
        setSelected(tabs[next]!.slotId);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {(tabs ?? []).map((tab, index) => <div className={`inspector-terminal-tab${activeSlot === tab.slotId ? " is-active" : ""}`} key={tab.slotId}>
          <button type="button" role="tab" aria-selected={activeSlot === tab.slotId} tabIndex={activeSlot === tab.slotId ? 0 : -1} onClick={() => setSelected(tab.slotId)}><Icon name="terminal" size={13} />{tab.slotId === "preview" ? "开发服务器" : `终端 ${index + 1}`}</button>
          <button type="button" aria-label={`关闭终端 ${index + 1} 并终止进程`} title="关闭并终止进程" disabled={closingSlots.has(tab.slotId)} onClick={() => void close(tab)}><Icon name="close" size={12} /></button>
        </div>)}
      </div>
      <button type="button" aria-label="新建终端" title="新建终端" disabled={busy || tabs === undefined} onClick={() => void add()}><Icon name="add" size={15} /></button>
    </div>
    {error ? <div className="inspector-error" role="alert">{error}<button type="button" onClick={() => {
      if (tabs !== undefined) { setError(undefined); return; }
      const mutation = ++listMutationRef.current;
      void window.biny.listTerminals(projectId).then((entries) => {
        if (!mountedRef.current || mutation !== listMutationRef.current) return;
        acceptEntries(entries); setSelected(entries[0]?.slotId); setError(undefined);
      }).catch((reason: unknown) => { if (mountedRef.current && mutation === listMutationRef.current) setError(String(reason)); });
    }}>{tabs === undefined ? "重试连接" : "关闭提示"}</button></div> : null}
    {tabs === undefined && !error ? <div className="inspector-empty" role="status">正在连接终端…</div> : null}
    {tabs?.length === 0 ? <div className="inspector-empty"><Icon name="terminal" size={24} /><p>没有打开的终端</p><button type="button" disabled={busy} onClick={() => void add()}>新建终端</button></div> : null}
    {(tabs ?? []).map((tab) => <div className="inspector-terminal-screen" hidden={activeSlot !== tab.slotId} key={tab.slotId}>
      <TerminalScreen projectId={projectId} slotId={tab.slotId} connectionOwner={tab.connectionOwner} closing={closingSlots.has(tab.slotId)} active={active && activeSlot === tab.slotId} onHandle={(terminalId) => setTabs((current) => current?.map((entry) => entry.slotId === tab.slotId && entry.terminalId !== terminalId ? { ...entry, terminalId } : entry))} />
    </div>)}
  </section>;
}

function TerminalScreen({ projectId, slotId, active, onHandle, connectionOwner, closing }: { projectId: string; slotId: string; active: boolean; onHandle(id: string): void; connectionOwner: TerminalConnectionOwner; closing: boolean }): React.JSX.Element {
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
      term.options.theme = readThemeColors(container, {
        background: "--code", foreground: "--text", cursor: "--accent", cursorAccent: "--code",
        selectionBackground: "--text-selection", selectionForeground: "--text",
        black: "--text-secondary", red: "--red-text", green: "--green-text", yellow: "--amber-text",
        blue: "--syntax-function", magenta: "--syntax-keyword", cyan: "--syntax-type", white: "--text",
        brightBlack: "--text-tertiary", brightRed: "--red-text", brightGreen: "--green-text", brightYellow: "--amber-text",
        brightBlue: "--syntax-function", brightMagenta: "--syntax-operator", brightCyan: "--syntax-type", brightWhite: "--text"
      });
    };
    applyTheme();
    const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    themeMedia.addEventListener("change", applyTheme);
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
    const connect = async (): Promise<DesktopTerminalHandle> => {
      if (slotId !== "preview" || restartToken === 0) {
        return await window.biny.createTerminal(projectId, 80, 24, slotId);
      }
      const result = await window.biny.startProjectPreview(projectId);
      if (result.kind !== "script") throw new Error("当前项目使用静态预览，请在浏览器面板查看。");
      return result;
    };
    void connectionOwner.connect(connect, slotId !== "preview" || restartToken > 0).then((handle) => {
      if (disposed) return;
      terminalId = handle.terminalId;
      handleRef.current(terminalId);
      if (handle.replay) term.write(handle.replay);
      for (const event of pending) if (event.sequence > handle.sequence) applyEvent(event);
      pending.length = 0;
      fitVisible();
      if (activeRef.current) term.focus();
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; observer.disconnect(); themeObserver.disconnect(); themeMedia.removeEventListener("change", applyTheme); unsubscribe(); data.dispose(); resize.dispose(); term.dispose(); terminalRef.current = undefined; fitRef.current = undefined; };
  }, [projectId, slotId, restartToken, connectionOwner]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { if ((containerRef.current?.clientWidth ?? 0) > 40) { fitRef.current?.fit(); terminalRef.current?.focus(); } });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return <div className="terminal-view">
    <div className="terminal-screen" ref={containerRef} />
    {error !== undefined || exitCode !== undefined ? <div className="terminal-overlay" role="alert"><span>{error ?? `进程已退出（${exitCode}）`}</span><button autoFocus type="button" disabled={closing} onClick={() => setRestartToken((token) => token + 1)}>重新启动</button></div> : null}
  </div>;
}
