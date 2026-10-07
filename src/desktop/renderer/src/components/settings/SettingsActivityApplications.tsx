import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopActivityApplication } from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";

export function SettingsActivityApplications({ excluded, onChange }: {
  excluded: string[];
  onChange(bundles: string[]): Promise<void>;
}): React.JSX.Element {
  const [applications, setApplications] = useState<DesktopActivityApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const loadEpoch = useRef(0);
  const pending = useRef(false);
  const loadApplications = useCallback(async (): Promise<void> => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setLoadError(undefined);
    try {
      const next = await window.biny.activityApplications();
      if (mounted.current && epoch === loadEpoch.current) setApplications(next);
    } catch (error) {
      if (mounted.current && epoch === loadEpoch.current) setLoadError(error instanceof Error ? error.message : "应用列表加载失败，请重试。");
    } finally {
      if (mounted.current && epoch === loadEpoch.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void loadApplications();
    return () => { mounted.current = false; };
  }, [loadApplications]);

  const save = async (bundles: string[], closePicker = false): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      await onChange(bundles);
      if (mounted.current && closePicker) setPickerOpen(false);
    } catch (error) {
      if (mounted.current) setSaveError(error instanceof Error ? error.message : "设置保存失败，请重试。");
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const names = new Map(applications.map(app => [app.bundleId, app]));
  const selected = new Set(excluded);
  const search = query.trim().toLocaleLowerCase();
  const choices = applications.filter(app => `${app.name}\n${app.bundleId}`.toLocaleLowerCase().includes(search));
  const closePicker = (): void => { if (!pending.current) setPickerOpen(false); };
  const saveFeedback = saveError ? <p className="activity-section-description is-error" role="alert">{saveError}</p> : null;
  const catalogFeedback = <>
    {loading ? <p className="activity-section-description" role="status">正在加载应用列表…</p> : null}
    {loadError ? <div className="activity-applications-feedback"><p className="activity-section-description is-error" role="alert">{loadError}</p><button className="ghost-button" disabled={loading || saving} onClick={() => void loadApplications()} type="button">重试加载应用列表</button></div> : null}
  </>;
  return <div aria-busy={saving} className="activity-applications">
    <p className="activity-section-description">这些应用在前台时，暂停记录其活动和截图。移除后恢复记录，不影响已有历史。</p>
    {selected.size ? <ul aria-label="不记录的应用" className="activity-application-list">
      {[...selected].map(bundleId => {
        const app = names.get(bundleId);
        const label = app?.name ?? bundleId;
        const sameName = app && applications.some(other => other.name === app.name && other.bundleId !== bundleId);
        return <li key={bundleId}>
          <div className="activity-application-copy"><span>{label}</span>
            {!app ? <small>未找到此应用，排除设置仍保留</small> : sameName ? <small>{app.path ?? bundleId}</small> : null}
          </div>
          <button aria-label={`恢复记录 ${label}`} className="ghost-button" disabled={saving} onClick={() => void save(excluded.filter(value => value !== bundleId))} type="button">移除</button>
        </li>;
      })}
    </ul> : <p className="activity-section-description">尚未排除任何应用。</p>}
    <div className="activity-application-actions">
      <button className="ghost-button" disabled={saving || excluded.length >= 256} onClick={() => { setQuery(""); setSaveError(undefined); setPickerOpen(true); }} type="button"><Icon name="add" size={13} />添加应用</button>
      <button aria-label="刷新应用列表" className="ghost-button" disabled={loading || saving} onClick={() => void loadApplications()} type="button"><Icon name="refresh" size={13} />刷新列表</button>
    </div>
    {excluded.length >= 256 ? <p className="activity-section-description">最多排除 256 个应用，请先移除已有条目。</p> : null}
    {!pickerOpen ? <>{catalogFeedback}{saveFeedback}</> : null}
    {pickerOpen ? <SettingsDetailLayer onClose={closePicker}>
      <section aria-labelledby="activity-application-picker-title" aria-modal="true" className="settings-confirm-panel activity-application-picker" role="dialog">
        <div className="activity-application-picker-heading"><h3 id="activity-application-picker-title">添加不记录的应用</h3><button aria-label="关闭应用列表" className="ghost-button" disabled={saving} onClick={closePicker} type="button"><Icon name="close" size={14} /></button></div>
        <input aria-label="搜索应用" autoComplete="off" data-settings-detail-autofocus placeholder="搜索应用名称" onChange={event => setQuery(event.target.value)} type="search" value={query} />
        {catalogFeedback}
        {saveFeedback}
        <ul aria-label="可选应用" className="activity-application-list activity-application-choices">
          {choices.map(app => <li data-application-choice={app.bundleId} key={app.bundleId}>
            <div className="activity-application-copy"><span>{app.name}</span><small>{app.path ?? app.bundleId}</small></div>
            <button aria-label={`不记录 ${app.name}（${app.bundleId}）`} className="ghost-button" disabled={saving || selected.has(app.bundleId) || excluded.length >= 256} onClick={() => void save([...excluded, app.bundleId], true)} type="button">{selected.has(app.bundleId) ? "已添加" : "添加"}</button>
          </li>)}
        </ul>
        {!loading && !loadError && choices.length === 0 ? <p className="activity-section-description" role="status">{search ? "没有匹配的应用。" : "未找到可添加的应用，请刷新列表。"}</p> : null}
      </section>
    </SettingsDetailLayer> : null}
  </div>;
}
