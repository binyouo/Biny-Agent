/** 项目建议仅在所属对话的输入框上方出现，草稿只能从该提示打开。 */
import React, { useEffect, useId, useRef, useState } from "react";
import type { BriefProjectSuggestion } from "../../../../session/threadBriefTypes.js";
import { Icon } from "../components/Icon.js";
import { useThreadBrief, type ThreadBriefContextValue } from "./context.js";
export function ProjectSuggestionBanner({ sessionId }: { sessionId?: string }): React.JSX.Element | null {
  const state = useThreadBrief();
  const suggestion = state?.snapshot?.suggestions.find((item) => item.status === "open" && item.threads.some((thread) => thread.sessionId === sessionId));
  const [openId, setOpenId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!state || !suggestion) return null;
  return <>
    <section className="biny-project-suggestion-banner" aria-label="项目建议">
      <Icon name="folder" size={15} />
      <div><strong>{suggestion.kind === "link" ? "这段对话像是你已有项目的一部分" : "你有几段对话看起来是同一件事"}</strong><small>{suggestion.reason}</small>{error ? <small role="alert">{error}</small> : null}</div>
      <button type="button" onClick={() => setOpenId(suggestion.id)}>看看草稿</button>
      <button type="button" aria-label="先不处理" disabled={busy} onClick={() => {
        setBusy(true); setError(undefined);
        void state.request({ action: "dismiss", id: suggestion.id }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
      }}><Icon name="close" size={13} /></button>
    </section>
    {openId === suggestion.id ? <ProjectSuggestionDialog key={`${sessionId}:${suggestion.id}`} suggestion={suggestion} state={state} onClose={() => setOpenId(undefined)} /> : null}
  </>;
}

function ProjectSuggestionDialog({ suggestion, state, onClose }: { suggestion: BriefProjectSuggestion; state: ThreadBriefContextValue; onClose(): void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState(suggestion);
  const [dropped, setDropped] = useState(new Set<string>());
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isLink = draft.kind === "link";
  useEffect(() => { dialog.current?.showModal(); }, []);
  const kept = draft.threads.filter((thread) => !dropped.has(thread.sessionId));
  const conclusions = [...new Set(state.snapshot?.briefs.filter((brief) => kept.some((thread) => thread.sessionId === brief.sessionId)).flatMap((brief) => brief.brief.conclusions))];
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(undefined);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const saveDraft = async (): Promise<void> => { await state.request({ action: "revise", id: draft.id, name: draft.name.trim(), brief: draft.brief.trim(), focus: draft.focus.trim(), sessionIds: kept.map((thread) => thread.sessionId) }); };
  return <dialog ref={dialog} className="biny-project-suggestion-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={titleId}>{isLink ? "把这段对话归到某个项目？" : "把这几段对话变成一个项目？"}</h2><button type="button" aria-label="关闭草稿" disabled={busy} onClick={onClose}><Icon name="close" size={16} /></button></header>
    <p>{draft.reason || "这几段对话一直在绕同一件事。"}</p>
    <fieldset disabled={busy}>
      {!isLink ? <label>项目名<input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label> : null}
      <label>Biny 对这件事的理解<textarea value={draft.brief} maxLength={2000} rows={3} disabled={isLink} onChange={(event) => setDraft({ ...draft, brief: event.target.value })} /></label>
      {!isLink ? <label>目前进展<textarea value={draft.focus} maxLength={500} rows={2} onChange={(event) => setDraft({ ...draft, focus: event.target.value })} /></label> : null}
      <div className="biny-suggestion-threads"><strong>包含的对话（{kept.length}）</strong>{draft.threads.map((thread) => <div key={thread.sessionId} className={dropped.has(thread.sessionId) ? "is-dropped" : ""}><Icon name="message" size={13} /><span>{thread.title}<small>{state.snapshot?.briefs.find((brief) => brief.sessionId === thread.sessionId)?.brief.topic}</small></span><button type="button" onClick={() => setDropped((previous) => { const next = new Set(previous); if (next.has(thread.sessionId)) next.delete(thread.sessionId); else next.add(thread.sessionId); return next; })}>{dropped.has(thread.sessionId) ? "放回来" : "不是这件事"}</button></div>)}</div>
      {conclusions.length ? <div><strong>已有结论</strong><ul>{conclusions.slice(0, 12).map((text) => <li key={text}>{text}</li>)}</ul></div> : null}
      <label>保存位置<div className="biny-suggestion-location"><input readOnly value={draft.location ?? ""} placeholder={isLink ? "已有项目目录" : "选择项目保存位置"} />{!isLink ? <button type="button" onClick={() => void run(async () => {
        const next = await state.request({ action: "choose-location", id: draft.id });
        const location = next.suggestions.find((item) => item.id === draft.id)?.location;
        setDraft((current) => ({ ...current, location }));
      })}>选择…</button> : null}</div></label>
      <small>只是把这些对话关联到项目，不会移动或复制任何文件。</small>
      <div className="biny-suggestion-feedback"><p>哪里理解偏了？直接告诉 Biny，它会重写这张卡片，不用你自己改。</p><div><input value={feedback} maxLength={4000} onChange={(event) => setFeedback(event.target.value)} placeholder="例如：这两段不是同一件事 / 重点理解偏了" /><button type="button" disabled={!feedback.trim() || !kept.length} onClick={() => void run(async () => {
        await saveDraft();
        const next = await state.request({ action: "rewrite", id: draft.id, feedback: feedback.trim() });
        const revised = next.suggestions.find((item) => item.id === draft.id);
        if (revised) { setDraft(revised); setDropped(new Set()); setFeedback(""); }
      })}>重写</button></div></div>
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    <footer><button type="button" disabled={busy} onClick={() => void run(async () => { await state.request({ action: "dismiss", id: draft.id }); onClose(); })}>先不处理</button><button type="button" disabled={busy || !kept.length || !draft.name.trim() || !draft.brief.trim()} onClick={() => void run(async () => {
      await saveDraft();
      const next = await state.request({ action: "accept", id: draft.id });
      if (!next.suggestions.some((item) => item.id === draft.id)) onClose();
    })}>{busy ? "处理中…" : isLink ? "归入项目" : "创建项目"}</button></footer>
  </dialog>;
}
