/** 浏览器标签由主进程持有；这里仅同步可见槽位与导航动作，不向网页注入应用接口。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopBrowserAction, DesktopBrowserSnapshot } from "../../../../protocol.js";
import type { LocalReferenceResult } from "../../../../../session/localReferences.js";
import { Icon } from "../Icon.js";

export function WorkspaceBrowserPanel({ projectId, active, expanded, onToggleExpanded, onAttachReference, onWarning, onOpenTerminal, onFixPreview }: {
  projectId: string;
  active: boolean;
  expanded?: boolean;
  onToggleExpanded?(): void;
  onAttachReference?(reference: LocalReferenceResult): void;
  onWarning(message: string): void;
  onOpenTerminal(): void;
  onFixPreview?(error: string): void;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopBrowserSnapshot>();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  const [serverId, setServerId] = useState<string>();
  const [staticUrl, setStaticUrl] = useState<string>();
  const [serverStarting, setServerStarting] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverNotice, setServerNotice] = useState<string>();
  const [previewFailure, setPreviewFailure] = useState<string>();
  const [profiles, setProfiles] = useState<Array<{ id: string; appName: string; profileName: string; userName?: string }>>([]);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [importingProfileId, setImportingProfileId] = useState<string>();
  const [profileError, setProfileError] = useState<string>();
  const [previewAvailability, setPreviewAvailability] = useState<{ available: true; command: string } | { available: true; kind: "static"; entry: string; entries: string[] } | { available: false; reason: string }>();
  const [htmlPickerOpen, setHtmlPickerOpen] = useState(false);
  const [selectedHtmlFile, setSelectedHtmlFile] = useState<string>();
  const serverPending = useRef(false);
  const exitedServers = useRef(new Set<string>());
  const openedPreviewUrls = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const focusAfterAction = useRef<string | undefined>(undefined);
  const profileAnchor = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const selected = snapshot?.tabs.find((tab) => tab.id === snapshot.activeId);
  const adopt = useCallback((next: DesktopBrowserSnapshot): void => {
    if (next.projectId === projectId && alive.current) setSnapshot((current) => !current || next.revision >= current.revision ? next : current);
  }, [projectId]);
  useEffect(() => {
    setSnapshot(undefined); setServerId(undefined); setStaticUrl(undefined); setServerStarting(false); setPreviewAvailability(undefined);
    openedPreviewUrls.current.clear();
    setPreviewFailure(undefined); setProfilePickerOpen(false); setProfiles([]); setHtmlPickerOpen(false); setSelectedHtmlFile(undefined);
  }, [projectId]);
  useEffect(() => {
    if (!profilePickerOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setProfilePickerOpen(false); };
    const closeOutside = (event: MouseEvent): void => { if (!profileAnchor.current?.contains(event.target as Node)) setProfilePickerOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOutside);
    return () => { window.removeEventListener("keydown", closeOnEscape); document.removeEventListener("mousedown", closeOutside); };
  }, [profilePickerOpen]);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.biny.onBrowserState(adopt);
    void window.biny.browserSnapshot(projectId).then(adopt).catch((reason: unknown) => { if (alive.current) setError(String(reason)); });
    return () => { alive.current = false; unsubscribe(); };
  }, [adopt, projectId]);
  useEffect(() => setAddress(selected?.url ?? ""), [selected?.id, selected?.url]);
  const perform = async (action: DesktopBrowserAction): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      const next = await window.biny.browserAction(projectId, action);
      if (action.type === "new" && !action.url) focusAfterAction.current = "address";
      else if (action.type === "select" || action.type === "close") focusAfterAction.current = next.activeId ?? "address";
      adopt(next);
    }
    catch (reason) { if (alive.current) setError(String(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const inspect = async (): Promise<void> => {
    if (!selected || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { adopt(await window.biny.browserInspect(projectId, selected.id, !selected.inspecting)); }
    catch (reason) { if (alive.current) setError(String(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const capture = async (selection = false): Promise<void> => {
    if (!selected || pending.current || !onAttachReference) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      const reference = await window.biny.browserCapture(projectId, selected.id, selection);
      if (alive.current) { onAttachReference(reference); setServerNotice("已附加到聊天输入框，发送后模型才能读取。"); }
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  useLayoutEffect(() => {
    if (busy || !active) return;
    const target = focusAfterAction.current;
    focusAfterAction.current = undefined;
    const tab = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find((item) => item.dataset.tabId === snapshot?.activeId);
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (target === "address") addressInput.current?.focus();
    else if (target) tab?.focus();
  }, [snapshot, busy, active]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const refreshStatus = async (): Promise<void> => {
      try {
        const status = await window.biny.projectPreviewStatus(projectId);
        if (disposed || serverPending.current) return;
        setServerId(status.kind === "script" || status.kind === "starting" ? status.terminalId : undefined);
        setStaticUrl(status.kind === "static" ? status.url : undefined);
        setServerStarting(status.kind === "starting");
        if (status.kind === "failed") { setPreviewFailure(status.error); openedPreviewUrls.current.clear(); }
        if (status.kind === "failed") setServerNotice(undefined);
        if (status.kind === "script" || status.kind === "static") {
          if (!openedPreviewUrls.current.has(status.url)) {
            openedPreviewUrls.current.add(status.url);
            try {
              const current = await window.biny.browserSnapshot(projectId);
              if (!current.tabs.some((tab) => tab.url === status.url)) adopt(await window.biny.browserAction(projectId, { type: "new", url: status.url }));
            } catch (reason) { if (!disposed) setError(String(reason)); }
          }
        }
      } catch (reason) { if (!disposed) setError(String(reason)); }
    };
    const refreshAvailability = (): void => {
      void window.biny.projectPreviewAvailability(projectId).then((availability) => {
        if (!disposed) {
          setPreviewAvailability(availability);
          setSelectedHtmlFile((current) => current && availability.available && "kind" in availability && availability.entries.includes(current) ? current : undefined);
        }
      }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    };
    refreshAvailability();
    window.addEventListener("focus", refreshAvailability);
    void refreshStatus();
    const statusTimer = window.setInterval(() => { void refreshStatus(); }, 500);
    const unsubscribe = window.biny.onTerminalEvent((event) => {
      if (event.type === "exit") {
        exitedServers.current.add(event.terminalId);
        if (exitedServers.current.size > 128) exitedServers.current.delete(exitedServers.current.values().next().value!);
        setServerId((current) => current === event.terminalId ? undefined : current);
        void refreshStatus();
      }
    });
    return () => { disposed = true; window.clearInterval(statusTimer); unsubscribe(); window.removeEventListener("focus", refreshAvailability); };
  }, [active, adopt, projectId]);
  const toggleServer = async (entry?: string): Promise<void> => {
    if (serverPending.current || (!serverId && !staticUrl && previewAvailability?.available === false)) return;
    if (!serverId && !staticUrl && !entry && !selectedHtmlFile && previewAvailability?.available && "kind" in previewAvailability
      && !previewAvailability.entries.includes("index.html") && previewAvailability.entries.length > 1) {
      setHtmlPickerOpen(true);
      return;
    }
    setHtmlPickerOpen(false);
    serverPending.current = true; setServerBusy(true); setError(undefined); setPreviewFailure(undefined);
    try {
      if (serverId || staticUrl) {
        await window.biny.stopProjectPreview(projectId);
        if (alive.current) { openedPreviewUrls.current.clear(); setServerId(undefined); setStaticUrl(undefined); setServerStarting(false); setServerNotice("预览服务已停止。"); }
      } else {
        const result = await window.biny.startProjectPreview(projectId, entry ?? selectedHtmlFile);
        if (!alive.current) return;
        if (result.kind === "static") {
          setStaticUrl(result.url); setServerNotice("静态预览已启动。");
          openedPreviewUrls.current.add(result.url);
          adopt(await window.biny.browserAction(projectId, { type: "new", url: result.url }));
        } else {
          setServerId(exitedServers.current.has(result.terminalId) ? undefined : result.terminalId);
          setServerStarting(true);
          setServerNotice(`正在启动 ${result.command}…`);
        }
      }
    } catch (reason) {
      if (alive.current) {
        try {
          const availability = await window.biny.projectPreviewAvailability(projectId);
          if (!alive.current) return;
          setPreviewAvailability(availability);
          setSelectedHtmlFile((current) => current && availability.available && "kind" in availability && availability.entries.includes(current) ? current : undefined);
          setPreviewFailure(availability.available ? String(reason) : undefined);
        } catch { if (alive.current) setError(String(reason)); }
      }
    }
    finally { serverPending.current = false; if (alive.current) setServerBusy(false); }
  };
  const navigate = (): void => {
    const raw = address.trim();
    if (!raw) return;
    try {
      // 显式协议先校验；普通词句才走搜索，避免把脚本地址送给搜索引擎。
      const explicitScheme = /^[a-z][a-z\d+.-]*:/iu.test(raw) && !/^[^/:]+:\d+(?:\/|$)/u.test(raw);
      const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/iu.test(raw);
      const hostname = !/\s/u.test(raw) && (/^[^/]+\.[^/]+/u.test(raw) || /^[^/:]+:\d+(?:\/|$)/u.test(raw));
      const value = explicitScheme ? raw : local || hostname ? `${local ? "http" : "https"}://${raw}`
        : `https://www.google.com/search?${new URLSearchParams({ q: raw })}`;
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("请输入 HTTP 或 HTTPS 地址。");
      void perform(selected ? { type: "navigate", tabId: selected.id, url: url.href } : { type: "new", url: url.href });
    } catch (reason) { setError(String(reason)); }
  };
  const openProfilePicker = async (): Promise<void> => {
    if (profilePickerOpen) { setProfilePickerOpen(false); return; }
    setProfilePickerOpen(true); setProfilesLoading(true); setProfileError(undefined);
    try { setProfiles(await window.biny.listBrowserProfiles()); }
    catch (reason) { setProfileError(String(reason)); }
    finally { setProfilesLoading(false); }
  };
  const importProfile = async (profileId: string): Promise<void> => {
    if (importingProfileId) return;
    setImportingProfileId(profileId); setProfileError(undefined);
    try {
      const result = await window.biny.importBrowserProfile(profileId);
      setProfilePickerOpen(false);
      setServerNotice(`已从 ${result.appName} 导入 ${result.imported} 个 Cookie${result.failed ? `，${result.failed} 个未能导入` : ""}。`);
      try {
        const current = await window.biny.browserSnapshot(projectId);
        const activeTab = current.tabs.find((tab) => tab.id === current.activeId);
        if (activeTab?.url) adopt(await window.biny.browserAction(projectId, { type: "reload", tabId: activeTab.id }));
      } catch (reason) { setError(`Cookie 已导入，但网页刷新失败：${String(reason)}`); }
    } catch (reason) { setProfileError(String(reason)); }
    finally { setImportingProfileId(undefined); }
  };
  const selectedId = selected?.id;
  const previewRunning = Boolean((serverId && !serverStarting) || staticUrl);
  const previewUnavailable = !serverId && !staticUrl && !serverStarting && previewAvailability?.available === false;
  const displayedFailure = previewUnavailable ? undefined : previewFailure;
  const selectedUrl = selected?.url;
  const selectedError = selected?.error;
  const selectedFloating = selected?.floating;
  useLayoutEffect(() => {
    const element = slot.current;
    const tabId = selectedId;
    if (!element || !tabId) return;
    let disposed = false;
    // 面板会保留挂载。不可见时只同步一次原生隐藏，不能继续观察整页流式 DOM、
    // 排帧扫描模态框和读取布局；重新激活由此 effect 重建观察器并立即同步。
    if (!active || !selectedUrl || selectedFloating || selectedError) {
      void window.biny.browserBounds(projectId, tabId).catch((reason: unknown) => { if (!disposed) onWarning(String(reason)); });
      return () => { disposed = true; };
    }
    let last = "";
    let frame = 0;
    const sync = (): void => {
      frame = 0;
      if (disposed) return;
      // 原生网页位于 DOM 上层；任何打开的模态框都必须先遮住网页视图。
      const modal = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].some((node) => node.getClientRects().length > 0);
      const rect = element.getBoundingClientRect();
      const bounds = active && selectedUrl && !selectedFloating && !selectedError && !modal && document.visibilityState !== "hidden" && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
      const signature = JSON.stringify(bounds) ?? "hidden";
      if (signature === last) return;
      last = signature;
      void window.biny.browserBounds(projectId, tabId, bounds).catch((reason: unknown) => { if (!disposed) onWarning(String(reason)); });
    };
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(sync); };
    sync();
    const observer = new ResizeObserver(schedule); observer.observe(element);
    const overlays = new MutationObserver(schedule); overlays.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "aria-hidden", "class", "style"] });
    window.addEventListener("resize", schedule); document.addEventListener("visibilitychange", schedule);
    return () => {
      disposed = true; observer.disconnect(); overlays.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule); document.removeEventListener("visibilitychange", schedule);
      void window.biny.browserBounds(projectId, tabId).catch(() => undefined);
    };
  }, [active, onWarning, projectId, selectedId, selectedUrl, selectedError, selectedFloating]);
  return <section ref={panel} className="inspector-utility-panel inspector-browser-panel" aria-label="内嵌浏览器" onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault(); event.stopPropagation(); addressInput.current?.focus(); addressInput.current?.select();
    }
  }}>
    <div className="inspector-subtoolbar inspector-browser-tabbar"><div className="inspector-browser-tabs" role="tablist" aria-label="网页标签">
      {snapshot?.tabs.map((tab) => <div className={`inspector-browser-tab${selected?.id === tab.id ? " is-active" : ""}`} key={tab.id}>
        <button type="button" role="tab" data-tab-id={tab.id} tabIndex={selected?.id === tab.id ? 0 : -1} aria-selected={selected?.id === tab.id} disabled={busy} onClick={() => void perform({ type: "select", tabId: tab.id })} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const tabs = snapshot.tabs;
          const index = tabs.findIndex((item) => item.id === tab.id);
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
          void perform({ type: "select", tabId: tabs[next]!.id });
        }} title={tab.url || "新标签页"}><Icon name="globe" size={14} /><span>{tab.title}</span></button>
        <button type="button" aria-label={`关闭 ${tab.title}`} title="关闭标签页" disabled={busy} onClick={() => void perform({ type: "close", tabId: tab.id })}><Icon name="close" size={14} /></button>
      </div>)}
    </div><button className="inspector-browser-new-tab" type="button" aria-label="新建网页标签" title="新建标签页" disabled={busy} onClick={() => void perform({ type: "new" })}><Icon name="add" size={18} /></button></div>
    <form className="inspector-subtoolbar inspector-browser-navigation" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
      <button className="inspector-browser-preview-action" type="button" title={previewUnavailable && previewAvailability?.available === false ? previewAvailability.reason : "运行或停止项目预览"} disabled={serverBusy || previewUnavailable} onClick={() => void toggleServer()}><Icon name={serverId || staticUrl ? "stop" : "play"} size={16} />{serverBusy ? "处理中…" : serverStarting ? "停止启动" : previewRunning ? "停止预览" : "运行预览"}</button>
      <div className="inspector-browser-history" role="group" aria-label="网页导航">
        <button type="button" aria-label="后退" title="后退" disabled={busy || !selected?.canGoBack} onClick={() => selected && void perform({ type: "back", tabId: selected.id })}><Icon name="arrow-left" size={16} /></button>
        <button type="button" aria-label="前进" title="前进" disabled={busy || !selected?.canGoForward} onClick={() => selected && void perform({ type: "forward", tabId: selected.id })}><Icon name="arrow-right" size={16} /></button>
        <button type="button" aria-label={selected?.loading ? "停止加载" : "重新加载"} title={selected?.loading ? "停止加载" : "重新加载"} disabled={busy || !selected?.url} onClick={() => selected && void perform({ type: selected.loading ? "stop" : "reload", tabId: selected.id })}><Icon name={selected?.loading ? "stop" : "refresh"} size={16} /></button>
        <button type="button" aria-label="选取页面元素" title={selected?.inspecting ? "取消元素选取" : "选取页面元素"} aria-pressed={Boolean(selected?.inspecting)} disabled={busy || !selected?.url} onClick={() => void inspect()}><Icon name="inspect" size={16} /></button>
      <div className="inspector-profile-anchor" ref={profileAnchor}>
        <button type="button" aria-label="复用浏览器登录态" title="从本机浏览器导入 Cookie" aria-expanded={profilePickerOpen} aria-haspopup="dialog" onClick={() => void openProfilePicker()}><Icon name="key" size={16} /></button>
        {profilePickerOpen ? <div className="inspector-profile-picker" role="dialog" aria-label="复用浏览器登录态">
          <strong>复用浏览器登录态</strong>
          <p>从本机浏览器配置导入 Cookie。macOS 首次可能请求钥匙串权限。</p>
          {profilesLoading ? <small>正在查找浏览器配置…</small> : profiles.length ? profiles.map((profile) => <button type="button" key={profile.id} disabled={Boolean(importingProfileId)} onClick={() => void importProfile(profile.id)}>
            <Icon name="person" size={18} /><span><strong>{profile.appName} · {profile.profileName}</strong>{profile.userName ? <small>{profile.userName}</small> : null}</span>{importingProfileId === profile.id ? <small>导入中…</small> : null}
          </button>) : <small>未找到 Chrome、Edge、Brave 等浏览器配置。</small>}
          {profileError ? <div className="inspector-error" role="alert">{profileError}</div> : null}
        </div> : null}
      </div>
        <button type="button" aria-label={selected?.floating ? "收回浮动窗口" : "在浮动窗口浏览"} title={selected?.floating ? "收回浮动窗口" : "在浮动窗口浏览"} aria-pressed={Boolean(selected?.floating)} disabled={busy || !selected?.url} onClick={() => selected && void perform({ type: "float", tabId: selected.id })}><Icon name="pip" size={16} /></button>
      </div>
      <div className="inspector-browser-address">
        <Icon name="globe" size={15} />
        <input ref={addressInput} aria-label="网页地址" placeholder="搜索或输入网址" autoComplete="off" spellCheck={false} value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setAddress(selected?.url ?? ""); setError(undefined); }
        }} />
        <button type="submit" aria-label="前往" title="前往（Enter）" disabled={busy || !address.trim()}><Icon name="arrow-right" size={16} /></button>
      </div>
      <div className="inspector-browser-actions">
      {onToggleExpanded ? <button type="button" aria-label={expanded ? "收起浏览器" : "展开浏览器"} title={expanded ? "收起浏览器" : "展开浏览器"} aria-pressed={Boolean(expanded)} onClick={onToggleExpanded}><Icon name={expanded ? "collapse" : "expand"} size={16} /></button> : null}
      <button type="button" aria-label="将网页附加到聊天" title="将网页附加到聊天" disabled={busy || !selected?.url || !onAttachReference} onClick={() => void capture()}><Icon name="paperclip" size={16} /></button>
      <button type="button" aria-label="在系统浏览器打开" title="在系统浏览器打开" disabled={!selected?.url} onClick={() => selected && void window.biny.openExternal(selected.url).catch((reason: unknown) => setError(String(reason)))}><Icon name="external" size={16} /></button>
      </div>
    </form>
    {htmlPickerOpen && previewAvailability?.available && "kind" in previewAvailability ? <div className="inspector-preview-entries" role="group" aria-label="选择 HTML 入口"><span>选择要预览的 HTML 页面</span>{previewAvailability.entries.map((entry) => <button type="button" key={entry} onClick={() => { setSelectedHtmlFile(entry); void toggleServer(entry); }}>{entry}</button>)}<button type="button" onClick={() => setHtmlPickerOpen(false)}>取消</button></div> : null}
    {selected?.inspecting ? <div className="inspector-subtoolbar" role="status"><span>点击网页中的元素以选取</span><button type="button" disabled={busy} onClick={() => void inspect()}>取消</button></div> : null}
    {selected?.inspectionError ? <div className="inspector-error" role="alert">元素选取失败：{selected.inspectionError}</div> : null}
    {selected?.selection ? <div className="inspector-subtoolbar inspector-browser-selection"><span title={selected.selection.selector}>已选取 {selected.selection.tag}：{selected.selection.text.slice(0, 80) || selected.selection.selector}</span><button type="button" disabled={busy || !onAttachReference} onClick={() => void capture(true)}>附加元素</button></div> : null}
    {serverNotice || serverId || staticUrl ? <div className="inspector-subtoolbar" role="status"><span>{serverNotice || "预览正在运行"}</span><button type="button" onClick={onOpenTerminal}>查看终端</button></div> : null}
    {displayedFailure ? <div className="inspector-preview-failure" role="alert"><Icon name="warning" size={17} /><div><strong>无法启动预览</strong><p>{displayedFailure}</p></div><button type="button" disabled={serverBusy || previewUnavailable} onClick={() => void toggleServer()}>重试</button>{onFixPreview ? <button type="button" onClick={() => onFixPreview(displayedFailure)}>用 AI 修复</button> : null}</div> : null}
    {error ? <div className="inspector-error" role="alert">{error}<button type="button" onClick={() => void window.biny.browserSnapshot(projectId).then((next) => { adopt(next); setError(undefined); }).catch((reason: unknown) => setError(String(reason)))}>重试连接</button></div> : null}
    {selected?.loading ? <div className="inspector-browser-progress" role="status" aria-label="网页加载中" /> : null}
    <div className="inspector-browser-slot" ref={slot}>
      {selected?.floating ? <div className="inspector-empty"><Icon name="pip" size={36} /><p>正在浮动窗口中浏览</p><button type="button" disabled={busy} onClick={() => void perform({ type: "float", tabId: selected.id })}>收回到此处</button></div> : selected?.error ? <div className="inspector-empty" role="alert"><Icon name="warning" size={28} /><p>网页加载失败</p><small>{selected.error}</small><button type="button" onClick={() => void perform({ type: "reload", tabId: selected.id })}>重新加载</button></div>
        : !selected?.url ? <div className="inspector-empty inspector-browser-welcome"><div className="inspector-browser-welcome-icon"><Icon name="globe" size={36} /></div><p>{serverStarting ? "正在启动预览" : "随时可以浏览"}</p><small>{serverStarting ? "等待开发服务器提供可访问的本地地址。" : previewAvailability?.available ? "在地址栏搜索或输入网址，也可以运行此项目的预览。" : previewAvailability ? `${previewAvailability.reason}。仍可在地址栏搜索或输入网址。` : "在地址栏搜索或输入网址即可浏览。"}</small>{previewUnavailable ? <button type="button" onClick={() => addressInput.current?.focus()}>输入网址</button> : <button type="button" disabled={serverBusy} onClick={() => void toggleServer()}><Icon name={serverId || staticUrl ? "stop" : "play"} size={16} />{serverStarting ? "停止启动" : previewRunning ? "停止预览" : "运行预览"}</button>}</div> : null}
    </div>
  </section>;
}
