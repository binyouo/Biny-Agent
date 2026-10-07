import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ApplicationImportHistory, ApplicationImportPreview, ApplicationImportSnapshot, ApplicationImportSource } from "../../../../../imports/types.js";
import type { DesktopProject } from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";

const categoryLabels = { settings: "模型设置", mcp: "MCP 服务器", sessions: "会话" };
const resultLabels = { imported: "已导入", skipped: "已跳过", failed: "失败", unknown: "结果待确认" };

export function SettingsImport({ projectId, disabled, onImported }: {
  projectId?: string; disabled: boolean; onImported(projectId: string): Promise<void>;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ApplicationImportSnapshot>();
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [target, setTarget] = useState(projectId ?? "");
  const [preview, setPreview] = useState<ApplicationImportPreview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const alive = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    const request = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const [next, bootstrap] = await Promise.all([window.biny.applicationImports(), window.biny.bootstrap()]);
      if (!alive.current || request !== generation.current) return;
      setSnapshot(next);
      setProjects(bootstrap.projects.filter(project => !project.missing));
      setTarget(current => bootstrap.projects.some(project => project.id === current && !project.missing)
        ? current : bootstrap.activeProjectId ?? bootstrap.projects.find(project => !project.missing)?.id ?? "");
    } catch (failure) {
      if (alive.current && request === generation.current) setError(failure instanceof Error ? failure.message : "无法加载导入信息。");
    } finally {
      if (alive.current && request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    const unsubscribe = window.biny.onApplicationImportsChanged(() => { void reload(); });
    return () => { unsubscribe(); alive.current = false; generation.current += 1; };
  }, [reload]);
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { await operation(); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "导入操作失败。"); }
    finally { if (alive.current) setBusy(false); }
  };
  const choose = (source: ApplicationImportSource, forSync = false, selectedWorkspace?: string, savedItemIds?: string[]): void => {
    void perform(async () => {
      const next = await window.biny.previewApplicationImport(source);
      if (!alive.current || !next) return;
      setPreview(next);
      setSelectionOnly(forSync);
      setCustomize(false);
      const workspace = selectedWorkspace ?? projects.find(project => project.id === target)?.path;
      const saved = snapshot?.sync.selections?.find(selection => selection.source === source && selection.workspaceRoot === workspace && selection.itemIds.some(id => next.items.some(item => item.id === id)));
      const savedIds = savedItemIds ?? saved?.itemIds;
      setSelected(savedIds ? next.items.filter(item => savedIds.includes(item.id)).map(item => item.id) : next.items.map(item => item.id));
    });
  };
  const run = (): void => {
    if (!preview || !target || (!selected.length && !selectionOnly) || disabled) return;
    const input = { previewId: preview.id, itemIds: selected, projectId: target };
    void perform(async () => {
      if (selectionOnly) await window.biny.configureApplicationImportSync(input);
      else await window.biny.runApplicationImport(input);
      if (!alive.current) return;
      setPreview(undefined);
      await reload();
      if (!selectionOnly) await onImported(input.projectId);
    });
  };
  return <>
    <SettingsImportContent snapshot={snapshot} loading={loading} error={error} busy={busy || disabled}
      onRetry={() => { void reload(); }} onChoose={choose} onCustomize={() => setCustomize(true)}
      onSyncChange={enabled => { void perform(async () => { const next = await window.biny.setApplicationImportSync(enabled); if (alive.current) setSnapshot(next); }); }}
      onSync={() => { void perform(async () => { const next = await window.biny.syncApplicationImports(); if (alive.current) setSnapshot(next); for (const project of projects) await onImported(project.id); }); }} />
    {disabled ? <p role="status" className="import-warning">请先结束运行中的任务，并保存或取消其他设置更改，再导入内容。</p> : null}
    {customize && snapshot ? <SettingsDetailLayer onClose={() => setCustomize(false)}><section className="model-dialog import-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="import-sync-title">
      <header><h3 id="import-sync-title">要同步的内容</h3><button type="button" aria-label="关闭同步范围" onClick={() => setCustomize(false)}><Icon name="close" size={16} /></button></header>
      {snapshot.sync.selections?.length ? snapshot.sync.selections.map((selection, index) => <div className="import-card-row" key={index}><span><strong>{selection.label}</strong><small>{selection.workspaceRoot} · {selection.itemIds.length} 项</small></span><button type="button" className="settings-secondary-button" disabled={!projects.some(project => project.path === selection.workspaceRoot)} onClick={() => { const project = projects.find(project => project.path === selection.workspaceRoot); if (!project) return; setTarget(project.id); choose(selection.source, true, selection.workspaceRoot, selection.itemIds); }}>调整</button></div>) : <p>尚未选择同步内容。</p>}
      <p>ChatGPT 的同步范围调整需要重新选择同一份导出文件。</p>
    </section></SettingsDetailLayer> : null}
    {preview ? <SettingsDetailLayer onClose={() => { if (!busy) setPreview(undefined); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="import-preview-title" className="model-dialog import-preview-dialog" aria-busy={busy}>
        <header><h3 id="import-preview-title">从 {preview.label} 导入</h3><button type="button" aria-label="关闭导入选择" disabled={busy} onClick={() => setPreview(undefined)}><Icon name="close" size={16} /></button></header>
        <label className="import-target">导入到项目<select value={target} disabled={busy || disabled} onChange={event => setTarget(event.target.value)}><option value="">选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <p>会话保存到所选项目；模型设置和 MCP 配置保存为全局配置。同名配置会跳过，MCP 导入后默认关闭。</p>
        {preview.warnings.map((warning, index) => <p className="import-warning" key={index}>{warning}</p>)}
        <div className="import-preview-items">{preview.items.length ? preview.items.map(item => <label key={item.id} className="import-preview-item">
          <input type="checkbox" checked={selected.includes(item.id)} disabled={busy || disabled} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
          <span><small>{categoryLabels[item.category]}</small><strong>{item.label}</strong><small>{item.detail}</small></span>
        </label>) : <p>没有可导入的内容。</p>}</div>
        {error ? <p role="alert">{error}</p> : null}
        <footer><span>{selected.length} 项已选</span><button className="settings-primary-button" disabled={busy || disabled || !target || (!selected.length && !selectionOnly)} type="button" onClick={run}>{busy ? "正在保存…" : selectionOnly ? "保存同步选择" : "导入所选内容"}</button></footer>
      </section>
    </SettingsDetailLayer> : null}
  </>;
}

export function SettingsImportContent({ snapshot, loading, error, busy, onRetry, onChoose, onCustomize, onSyncChange, onSync }: {
  snapshot?: ApplicationImportSnapshot; loading: boolean; error?: string; busy: boolean;
  onRetry(): void; onCustomize(): void; onChoose(source: ApplicationImportSource): void; onSyncChange(enabled: boolean): void; onSync(): void;
}): React.JSX.Element {
  return <div className="settings-import" aria-busy={busy || loading}>
    <p className="settings-import-intro">将其他 AI 应用的模型设置、MCP 配置和会话导入 Biny。</p>
    {error ? <div role="alert" className="import-error"><p>{error}</p><button type="button" className="settings-secondary-button" disabled={busy} onClick={onRetry}>重新加载</button></div> : null}
    {loading && !snapshot ? <p role="status">正在检测导入来源…</p> : null}
    {snapshot ? <>
      <section><h3>自动同步</h3><div className="import-card">
        <SettingsSwitch checked={snapshot.sync.enabled} disabled={busy || !snapshot.sync.hasSelection} label="保持导入同步" detail={snapshot.sync.enabled ? "每分钟检查已选内容；变化的会话创建新副本。" : "同步已暂停。所选内容与导入历史保留。"} onChange={onSyncChange} />
        <div className="import-card-row"><span><strong>要同步的内容</strong><small>{snapshot.sync.hasSelection ? "沿用首次导入选择；重新导入可更新选择。" : "首次导入后可用。"}</small></span><button type="button" className="settings-secondary-button" disabled={busy || !snapshot.sync.hasSelection} onClick={onCustomize}>自定义</button></div>
        {snapshot.sync.hasSelection ? <div className="import-card-row"><span>检查已选择的来源内容</span><button type="button" className="settings-secondary-button" disabled={busy || !snapshot.sync.enabled} onClick={onSync}>立即检查</button></div> : null}
        {snapshot.sync.lastError ? <p role="alert" className="import-warning">{snapshot.sync.lastError}</p> : null}
      </div></section>
      <section><h3>从其他 AI 应用导入</h3><p className="import-section-note">检测本机配置与会话，也可选择 ChatGPT 导出文件。</p><div className="import-card">
        {snapshot.sources.map(source => <div className="import-card-row" key={source.source}>
          <span className={`import-source-icon is-${source.source}`} aria-hidden="true"><Icon name={source.source === "chatgpt" ? "message" : "terminal"} size={20} /></span>
          <span className="import-source-copy"><strong>{source.label}</strong><small>{source.description}</small></span>
          <button type="button" className="settings-secondary-button" disabled={busy || (!source.detected && source.source !== "chatgpt")} aria-label={`从 ${source.label} 导入`} onClick={() => onChoose(source.source)}>{source.source === "chatgpt" ? "选择文件" : source.detected ? "导入" : "未检测到"}</button>
        </div>)}
      </div></section>
      <section><h3>导入历史</h3>{snapshot.history.length ? snapshot.history.map(history => <ImportHistoryCard key={history.id} history={history} />) : <p className="import-empty">尚未导入内容。</p>}</section>
    </> : null}
  </div>;
}

function ImportHistoryCard({ history }: { history: ApplicationImportHistory }): React.JSX.Element {
  const imported = history.results.filter(result => result.status === "imported").length;
  return <details className="import-card import-history"><summary><strong>从 {history.label} 导入</strong><small><time dateTime={history.time}>{new Date(history.time).toLocaleString()}</time> · 已导入 {imported} 项</small></summary>
    <p className="import-history-target">{history.workspaceRoot}</p>
    {(["settings", "mcp", "sessions"] as const).map(category => {
      const results = history.results.filter(result => result.category === category);
      if (!results.length) return null;
      return <details className="import-history-category" key={category}><summary><strong>{categoryLabels[category]}</strong><span>已导入 {results.filter(result => result.status === "imported").length} 项 / {results.length} 项</span></summary><ul>{results.map(result => <li key={result.id}><strong>{result.label}</strong><span className={`import-result is-${result.status}`}>{resultLabels[result.status]}</span>{result.detail ? <small>{result.detail}</small> : null}</li>)}</ul></details>;
    })}
  </details>;
}
