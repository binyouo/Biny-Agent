/** 设置 → 记忆与数据 → 对话摘要中的配置卡片；开关即时保存，数字失焦保存，不提供摘要浏览入口。 */
import React, { useEffect, useRef, useState } from "react";
import type { ThreadBriefSettings } from "../../../../../session/threadBriefTypes.js";
import { useThreadBrief } from "../../threadBrief/context.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
export function ThreadBriefCard(): React.JSX.Element | null {
  const state = useThreadBrief();
  const config = state?.snapshot?.config;
  const [draft, setDraft] = useState<ThreadBriefSettings | undefined>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const saveVersion = useRef(0);
  useEffect(() => { if (config) setDraft(config); }, [config]);
  if (!state) return null;
  if (!draft) return state.error ? <p role="alert">{state.error}</p> : null;
  const save = async (next: ThreadBriefSettings): Promise<void> => {
    const version = ++saveVersion.current;
    setDraft(next); setSaving(true); setError(undefined);
    try { const saved = await state.request({ action: "configure", config: next }); if (version === saveVersion.current) setDraft(saved.config); }
    catch (reason) { if (version === saveVersion.current) { setError(reason instanceof Error ? reason.message : String(reason)); if (config) setDraft(config); } }
    finally { if (version === saveVersion.current) setSaving(false); }
  };
  const number = (label: string, value: number, min: number, max: number, update: (value: number) => ThreadBriefSettings): React.JSX.Element => <label>{label}<input type="number" value={value} min={min} max={max} onChange={(event) => setDraft(update(Number(event.target.value)))} onBlur={() => void save(update(Math.max(min, Math.min(max, Math.round(value)))))} /></label>;
  return <section className="biny-thread-brief-settings">
    <header><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" /></svg><h3>对话摘要</h3>{saving ? <small>保存中…</small> : null}<button type="button" onClick={() => state.snapshot && void save(state.snapshot.defaults)}><svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11a9 9 0 1 1 2.6 6.4M3 4v7h7" /></svg>恢复默认</button></header>
    <p className="biny-brief-description">自动整理对话，保留摘要、待办和项目建议。</p>
    <div className="biny-brief-controls">
    <SettingsSwitch label="后台生成对话摘要" detail="有实质新增时生成摘要。旧对话需手动选择后才处理。" checked={draft.enabled} onChange={(enabled) => void save({ ...draft, enabled })} />
    <SettingsSwitch label="识别待办" detail="仅识别你明确表达的后续计划，保留手动修改的状态。" checked={draft.autoTodo} disabled={!draft.enabled} onChange={(autoTodo) => void save({ ...draft, autoTodo })} />
    <SettingsSwitch label="项目建议" detail="生成待确认的草稿，不自动创建或关联项目。" checked={draft.projectSuggestions} disabled={!draft.enabled} onChange={(projectSuggestions) => void save({ ...draft, projectSuggestions })} />
    <details className="settings-disclosure"><summary>生成条件</summary><div className="biny-brief-budget"><span>摘要</span>{number("最少轮数", draft.minUserTurns, 1, 100, (minUserTurns) => ({ ...draft, minUserTurns }))}{number("新增字符", draft.minNewChars, 0, 100000, (minNewChars) => ({ ...draft, minNewChars }))}</div>
    <div className="biny-brief-budget"><span>收敛门槛</span>{number("对话数", draft.cluster.threads, 2, 50, (threads) => ({ ...draft, cluster: { ...draft.cluster, threads } }))}{number("跨天数", draft.cluster.spread, 1, 50, (spread) => ({ ...draft, cluster: { ...draft.cluster, spread } }))}</div>
    <p className="biny-brief-hint">多少次重复出现才值得叫「一个项目」。只是关键词相似永远不够。</p></details>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
