import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DesktopMaskRecord } from "../../../../protocol.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { PrivacyFlow } from "./PrivacyFlow.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { providerBrandType } from "./providerBrand.js";
import { PrivacyComparison } from "./PrivacyComparison.js";
import { privacyKinds } from "./privacyLabels.js";
import { privacyState } from "./privacyState.js";
import { privacyView } from "./privacyViewData.js";
import { privacySize } from "./privacyExcerpt.js";

export function SettingsPrivacy(): React.JSX.Element {
  const { draft, snapshot, setRedaction } = useSettingsDraft();
  if (!draft || !snapshot) return <p role="status">正在加载设置…</p>;
  return <div className="settings-sections privacy-settings">
    <section><SettingsSwitch checked={draft.redaction.enabled} label="发送前脱敏"
      detail="发送前替换敏感文字，回复后在本机还原。"
      onChange={(enabled) => setRedaction({ enabled })} />
      <p className="privacy-note">仅处理内置对话模型的非签名文字，可能漏报或误报。</p>
    </section>
    <PrivacyRecords key={snapshot.projectId} projectId={snapshot.projectId} enabled={snapshot.redaction.enabled} />
  </div>;
}

function PrivacyRecords({ projectId, enabled }: { projectId: string; enabled: boolean }): React.JSX.Element {
  const state = privacyState(window.biny, projectId);
  const { data, loading, error } = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<DesktopMaskRecord>();
  const [detailError, setDetailError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const [provider, setProvider] = useState("");
  const [session, setSession] = useState("");
  const [kind, setKind] = useState("");
  const [days, setDays] = useState(7);
  const [day, setDay] = useState("");
  const [page, setPage] = useState(0);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    void state.refresh();
    return window.biny.onAgentEvent((event) => {
      if (event.projectId === projectId && event.event && ["run.completed", "run.failed", "run.cancelled", "run.blocked", "run.incomplete"].includes(event.event.type)) void state.refresh(true);
    });
  }, [state, projectId]);
  useEffect(() => {
    let active = true;
    setDetail(undefined); setDetailError(undefined);
    if (selected) {
      void window.biny.maskingDetail(projectId, selected).then((record) => {
        if (!active) return;
        if (record) setDetail(record); else setDetailError("记录已清除或过期。");
      }).catch(() => { if (active) setDetailError("读取失败，请返回重试。"); });
    }
    return () => { active = false; };
  }, [projectId, selected]);
  useEffect(() => { if (!selected) returnFocus.current?.focus(); }, [selected]);
  const back = (): void => { setSelected(undefined); };
  const records = data?.records ?? [];
  const providers = [...new Set(records.map((r) => r.provider))];
  const sessions = [...new Set(records.flatMap((r) => r.sessionId ? [r.sessionId] : []))];
  const kinds = [...new Set(records.flatMap(record => Object.keys(record.kinds)))];
  const view = privacyView(records, { days, day, provider, session, kind });
  const pages = Math.max(1, Math.ceil(view.records.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const selectedIndex = view.records.findIndex(record => record.id === selected);
  const max = Math.max(1, ...view.days.map(item => item.count));
  const replaced = view.records.filter(record => record.count > 0).length;
  const reset = (): void => { setProvider(""); setSession(""); setKind(""); setDay(""); setPage(0); };
  const clear = async (): Promise<void> => {
    setClearing(true); setActionError(undefined); setSelected(undefined);
    try { await state.clear(); } catch { setActionError("清除失败，请重试。"); } finally { setClearing(false); }
  };
  return <section className="privacy-records" onKeyDown={(event) => { if (event.key === "Escape" && selected) { event.stopPropagation(); back(); } }}>
    {error || actionError ? <p role="alert">{error ?? actionError}</p> : null}
    {!data && !error ? <p role="status">正在读取记录…</p> : null}
    <div hidden={selected !== undefined}>
      <div className="privacy-overview">
        <div className="privacy-toolbar"><h3>本机脱敏记录</h3><div className="privacy-modes" role="group" aria-label="时间范围">
          {[7, 30].map(value => <button type="button" key={value} aria-pressed={days === value} onClick={() => { setDays(value); setDay(""); setPage(0); }}>{value} 天</button>)}
        </div></div>
        <div className="privacy-summary"><strong>{view.total.toLocaleString()}<span>处替换</span></strong><span>{view.records.length} 次请求 · {replaced} 次含替换{view.records.length > replaced ? `，${view.records.length - replaced} 次原样发送` : ""}</span></div>
        <div className="privacy-history" role="group" aria-label="按日期筛选">
          {view.days.map(item => <button type="button" key={item.day} aria-pressed={day === item.day}
            aria-label={`${item.day}，${item.count} 处替换`} title={`${item.day} · ${item.count} 处替换`}
            onClick={() => { setDay(day === item.day ? "" : item.day); setPage(0); }}>
            <span style={{ height: `${Math.max(3, item.count / max * 100)}%` }} />
          </button>)}
        </div>
        <div className="privacy-history-labels"><span>{view.days[0]?.day.slice(5)}</span><span>{day || "今天"}</span></div>
        <PrivacyFlow records={view.records} enabled={enabled} session={session} provider={provider}
          onSessionChange={(value) => { setSession(session === value ? "" : value); setPage(0); }}
          onProviderChange={(value) => { setProvider(provider === value ? "" : value); setPage(0); }} />
      </div>
      <div className="privacy-toolbar privacy-filters"><select aria-label="筛选供应商" value={provider} onChange={(e) => { setProvider(e.target.value); setPage(0); }}><option value="">所有供应商</option>{providers.map((p) => <option key={p}>{p}</option>)}</select>
        <select aria-label="筛选会话" value={session} onChange={(e) => { setSession(e.target.value); setPage(0); }}><option value="">所有会话</option>{sessions.map((s) => <option key={s} value={s}>会话 {s.slice(-6)}</option>)}</select>
        <div className="privacy-actions"><button type="button" className="settings-text-action" disabled={loading || clearing} onClick={() => void state.refresh(true)}>{loading ? "刷新中…" : "刷新"}</button>
          <button type="button" className="settings-text-action" disabled={clearing || !records.length} onClick={() => void clear()}>清除</button></div>
      </div>
      <div className="privacy-type-filters" role="group" aria-label="筛选敏感类型"><button type="button" aria-pressed={!kind} onClick={() => { setKind(""); setPage(0); }}>全部</button>
        {kinds.map(value => <button type="button" key={value} aria-pressed={kind === value} onClick={() => { setKind(kind === value ? "" : value); setPage(0); }}>{privacyKinds[value] ?? value}</button>)}
        {provider || session || kind || day ? <button type="button" onClick={reset}>重置筛选</button> : null}
      </div>
      {!view.records.length ? <p className="privacy-empty">{records.length ? "无匹配记录" : "暂无请求记录。"}</p> : null}
      <ul className="privacy-record-list">{view.records.slice(currentPage * 20, (currentPage + 1) * 20).map((record) => <li key={record.id}><button type="button" onClick={(e) => { returnFocus.current = e.currentTarget; setSelected(record.id); }}>
        <time dateTime={record.time}>{new Date(record.time).toLocaleDateString([], { month: "numeric", day: "numeric" })}<small>{new Date(record.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></time>
        <span className="privacy-request-name"><strong>{record.model}</strong><small>{record.provider} · 会话 {record.sessionId?.slice(-6) ?? "辅助请求"}</small></span>
        <span className="privacy-kind-tags">{record.count === 0 ? <span className="is-unmasked">未替换</span> : Object.entries(record.kinds).slice(0, 2).map(([k, n]) => <span key={k}>{privacyKinds[k] ?? k} ×{n}</span>)}</span>
        <strong>{record.count}</strong><span aria-hidden="true">›</span>
      </button></li>)}</ul>
      {view.records.length > 20 ? <div className="privacy-toolbar privacy-pagination"><span>{currentPage * 20 + 1}–{Math.min((currentPage + 1) * 20, view.records.length)} / {view.records.length}</span><div className="privacy-actions">
        <button type="button" className="settings-text-action" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button type="button" className="settings-text-action" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div></div> : null}
      <p className="privacy-note">内存满时移除最早记录；退出运行进程后清空。</p>
    </div>
    {selected ? <div className="privacy-request-detail"><div className="privacy-toolbar"><button type="button" className="settings-text-action" onClick={back}>‹ 返回列表</button>
      <div className="privacy-actions"><span>{selectedIndex >= 0 ? `${selectedIndex + 1} / ${view.records.length}` : ""}</span>
        <button type="button" className="settings-text-action" disabled={selectedIndex <= 0} onClick={() => setSelected(view.records[selectedIndex - 1]?.id)}>上一条</button>
        <button type="button" className="settings-text-action" disabled={selectedIndex < 0 || selectedIndex + 1 >= view.records.length} onClick={() => setSelected(view.records[selectedIndex + 1]?.id)}>下一条</button>
      </div></div>
      {detailError ? <p role="alert">{detailError}</p> : !detail || detail.id !== selected ? <p role="status">正在读取请求详情…</p> : <>
        <p className="privacy-detail-caption">{new Date(detail.time).toLocaleString()}</p>
        <section className="privacy-request-summary">
          <div className="privacy-summary-route">
            <span className="privacy-summary-endpoint"><span className="privacy-summary-icon"><Icon name="message" size={14} /></span>{detail.sessionId ? `会话 ${detail.sessionId.slice(-6)}` : "辅助请求"}</span>
            <span className="privacy-summary-arrow" aria-hidden="true"><Icon name="arrow-right" size={14} /></span>
            <span className="privacy-summary-endpoint"><span className="privacy-summary-icon"><ProviderBrandGlyph type={providerBrandType(detail.provider)} /></span>{detail.provider}</span>
            <span className="privacy-summary-chip">{detail.model}</span>
            <span className="privacy-summary-operation">{detail.operation === "agent" ? "对话" : detail.operation}</span>
          </div>
          <dl className="privacy-summary-stats">
            <div><dt>请求体积</dt><dd>{detail.requestBytes !== undefined ? privacySize(detail.requestBytes) : "未记录"}<small>发送前的大小</small></dd></div>
            <div><dt>发现 {detail.uniqueValues} 个值</dt><dd>{Object.keys(detail.kinds).map(kind => privacyKinds[kind] ?? kind).join("、") || "——"}<small>本机匹配到的敏感内容</small></dd></div>
            <div><dt>{detail.count === 0 ? "未替换" : `替换 ${detail.count} 处`}</dt><dd>{detail.count === 0 ? "原样发送" : "换成占位符"}<small>{detail.count === 0 ? "本次未命中敏感内容" : "仅发送替换后的文本"}</small></dd></div>
            <div><dt>发送模型</dt><dd>{detail.model}<small>{detail.provider}</small></dd></div>
          </dl>
        </section>
        <PrivacyComparison key={detail.id} groups={detail.preview} truncated={detail.truncated} />
      </>}
    </div> : null}
  </section>;
}
