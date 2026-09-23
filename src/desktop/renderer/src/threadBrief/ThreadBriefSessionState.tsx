/** 摘要的待办结果只映射到原有会话行和会话右键菜单。 */
import React, { useState } from "react";
import { useThreadBrief } from "./context.js";
import { Icon } from "../components/Icon.js";
export function ThreadBriefSessionState({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const record = useThreadBrief()?.snapshot?.briefs.find((brief) => brief.sessionId === sessionId);
  if (!record || record.status === "inbox") return null;
  const label = record.status === "done" ? "已完成" : "待办";
  return <span className="biny-brief-session-status" aria-label={label} title={record.status === "todo" && record.autoTodo ? `自动标记待办：${record.autoTodo.what}` : label}><Icon name={record.status === "done" ? "check" : "layout-list"} size={12} /></span>;
}
export function ThreadBriefSessionMenu({ sessionId, onClose }: { sessionId: string; onClose(): void }): React.JSX.Element | null {
  const state = useThreadBrief();
  const record = state?.snapshot?.briefs.find((brief) => brief.sessionId === sessionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!state || !record) return null;
  return <>
    <div className="biny-sidebar-menu-separator" />
    {([ ["inbox", "收件箱"], ["todo", "待办"], ["done", "已完成"] ] as const).map(([status, label]) => <button key={status} type="button" role="menuitemradio" aria-checked={record.status === status} disabled={busy} onClick={() => {
      setBusy(true); setError(undefined);
      void state.request({ action: "status", sessionId, status }).then(onClose).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
    }}><Icon name={record.status === status ? "check" : "layout-list"} size={15} /><span>{label}</span></button>)}
    {error ? <small role="alert">{error}</small> : null}
  </>;
}
