import { useEffect, useRef, useState } from "react";
import type { DesktopBrowserEnvironment, DesktopBrowserEnvironmentInput } from "../../../../protocol.js";
import { Icon } from "../Icon.js";

export function BrowserEnvironmentMenu({ current, disabled, onOpen, onNotice }: {
  current?: Pick<DesktopBrowserEnvironment, "id" | "name" | "color">;
  disabled: boolean;
  onOpen(environmentId: string): void;
  onNotice(message: string): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [environments, setEnvironments] = useState<DesktopBrowserEnvironment[]>([]);
  const [editing, setEditing] = useState<DesktopBrowserEnvironment | "new">();
  const [name, setName] = useState("");
  const [proxyMode, setProxyMode] = useState<DesktopBrowserEnvironmentInput["proxy"]["mode"]>("system");
  const [proxyRules, setProxyRules] = useState("");
  const [proxyBypassRules, setProxyBypassRules] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") { setOpen(false); setEditing(undefined); } };
    const closeOutside = (event: MouseEvent): void => { if (!anchor.current?.contains(event.target as Node)) { setOpen(false); setEditing(undefined); } };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOutside);
    return () => { window.removeEventListener("keydown", closeOnEscape); document.removeEventListener("mousedown", closeOutside); };
  }, [open]);

  const refresh = async (): Promise<void> => {
    try { setEnvironments(await window.biny.browserEnvironments()); setError(undefined); }
    catch (reason) { setError(String(reason)); }
  };
  const openMenu = async (): Promise<void> => {
    if (open) { setOpen(false); setEditing(undefined); return; }
    setOpen(true);
    await refresh();
  };
  const beginEdit = (environment: DesktopBrowserEnvironment | "new"): void => {
    setEditing(environment);
    setName(environment === "new" ? "" : environment.name);
    setProxyMode(environment === "new" ? "system" : environment.proxy.mode);
    setProxyRules(environment === "new" ? "" : environment.proxy.proxyRules ?? "");
    setProxyBypassRules(environment === "new" ? "" : environment.proxy.proxyBypassRules ?? "");
    setError(undefined);
  };
  const save = async (): Promise<void> => {
    if (!editing || busy) return;
    const input: DesktopBrowserEnvironmentInput = {
      name,
      proxy: { mode: proxyMode, proxyRules: proxyRules || undefined, proxyBypassRules: proxyBypassRules || undefined }
    };
    setBusy(true); setError(undefined);
    try {
      if (editing === "new") await window.biny.createBrowserEnvironment(input);
      else await window.biny.updateBrowserEnvironment(editing.id, input);
      setEditing(undefined);
      await refresh();
      onNotice(editing === "new" ? "浏览器环境已创建。" : "浏览器环境已更新。");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const clear = async (environment: DesktopBrowserEnvironment): Promise<void> => {
    if (busy || environment.id === "default" || !window.confirm(`清空“${environment.name}”的 Cookie 和网页存储？`)) return;
    setBusy(true); setError(undefined);
    try { await window.biny.clearBrowserEnvironment(environment.id); onNotice(`已清空“${environment.name}”的网页数据。`); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const remove = async (environment: DesktopBrowserEnvironment): Promise<void> => {
    if (busy || environment.id === "default" || !window.confirm(`删除“${environment.name}”？它的 Cookie 和网页存储也会清除。`)) return;
    setBusy(true); setError(undefined);
    try { await window.biny.deleteBrowserEnvironment(environment.id); await refresh(); onNotice(`已删除“${environment.name}”。`); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const importDefaultCookies = async (environment: DesktopBrowserEnvironment): Promise<void> => {
    if (busy || !window.confirm(`用默认环境的 Cookie 替换“${environment.name}”的 Cookie？`)) return;
    setBusy(true); setError(undefined);
    try {
      const result = await window.biny.importBrowserEnvironmentCookies("default", environment.id);
      onNotice(`已复制 ${result.imported} 个 Cookie 到“${environment.name}”。`);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <div className="inspector-browser-environment-anchor" ref={anchor}>
    <button className="inspector-browser-environment-trigger" type="button" aria-label="浏览器环境" title={`浏览器环境：${current?.name ?? "默认"}`} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => void openMenu()}>
      <span className="inspector-browser-env-dot" style={{ backgroundColor: current?.color ?? "#aeb5c2" }} />
      <span>{current?.name ?? "默认"}</span>
    </button>
    {open ? <div className="inspector-browser-environment-menu" role="dialog" aria-label="浏览器环境">
      <div className="inspector-browser-environment-heading"><strong>浏览器环境</strong><button type="button" disabled={busy} aria-label="刷新环境列表" title="刷新" onClick={() => void refresh()}><Icon name="refresh" size={14} /></button></div>
      <p>每个环境单独保存 Cookie 和网页存储。</p>
      {environments.map((environment) => <div className="inspector-browser-environment-row" key={environment.id}>
        <button className="inspector-browser-environment-open" type="button" disabled={disabled || busy} onClick={() => { setOpen(false); onOpen(environment.id); }}>
          <span className="inspector-browser-env-dot" style={{ backgroundColor: environment.color }} />
          <span>{environment.name}</span>
          {environment.id === current?.id ? <small>当前</small> : null}
        </button>
        {environment.id !== "default" ? <div className="inspector-browser-environment-row-actions">
          <button type="button" aria-label={`编辑 ${environment.name}`} title="编辑" disabled={busy} onClick={() => beginEdit(environment)}>编辑</button>
          <button type="button" aria-label={`复制默认 Cookie 到 ${environment.name}`} title="复制默认环境 Cookie" disabled={busy} onClick={() => void importDefaultCookies(environment)}>导入登录态</button>
          <button type="button" aria-label={`清空 ${environment.name}`} title="清空网页数据" disabled={busy} onClick={() => void clear(environment)}>清空</button>
          <button type="button" aria-label={`删除 ${environment.name}`} title="删除环境" disabled={busy} onClick={() => void remove(environment)}>删除</button>
        </div> : null}
      </div>)}
      {editing ? <div className="inspector-browser-environment-form" role="group" aria-label={editing === "new" ? "新建浏览器环境" : "编辑浏览器环境"} onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLElement && ["INPUT", "SELECT"].includes(event.target.tagName)) { event.preventDefault(); void save(); }
      }}>
        <strong>{editing === "new" ? "新建环境" : "编辑环境"}</strong>
        <label>名称<input autoFocus maxLength={60} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>代理<select disabled={busy} value={proxyMode} onChange={(event) => setProxyMode(event.target.value as typeof proxyMode)}>
          <option value="system">系统代理</option><option value="direct">直连</option><option value="fixed_servers">手动代理</option>
        </select></label>
        {proxyMode === "fixed_servers" ? <>
          <label>代理规则<input disabled={busy} placeholder="http=127.0.0.1:7890;https=127.0.0.1:7890" value={proxyRules} onChange={(event) => setProxyRules(event.target.value)} /></label>
          <label>绕过规则<input disabled={busy} placeholder="localhost;127.0.0.1" value={proxyBypassRules} onChange={(event) => setProxyBypassRules(event.target.value)} /></label>
        </> : null}
        <div><button type="button" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>取消</button></div>
      </div> : <button className="inspector-browser-environment-create" type="button" disabled={busy} onClick={() => beginEdit("new")}><Icon name="add" size={15} />新建环境</button>}
      {error ? <div className="inspector-error" role="alert">{error}</div> : null}
    </div> : null}
  </div>;
}
