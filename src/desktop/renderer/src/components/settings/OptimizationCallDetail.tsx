import { useEffect, useState } from "react";
import type { ToolOptimizationEntry } from "../../../../../session/toolOptimization.js";
import { buildSessionTimeline, type TimelineTool } from "../../sessionTimeline.js";
import { ToolActivityDetail } from "../ToolActivity.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";

export function OptimizationCallDetail({ origin, onClose }: {
  origin: NonNullable<ToolOptimizationEntry["origin"]>;
  onClose(): void;
}): React.JSX.Element {
  const [tool, setTool] = useState<TimelineTool>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setTool(undefined); setError(undefined);
    void window.biny.toolOptimizationDetail(origin.projectId, origin.sessionId, origin.toolCallId).then(result => {
      if (!current) return;
      const found = buildSessionTimeline(result.events, []).flatMap(turn => turn.tools).find(item => item.id === origin.toolCallId);
      if (found) setTool(found); else setError("对应调用无法还原。");
    }, failure => { if (current) setError(String(failure)); });
    return () => { current = false; };
  }, [origin]);
  return <SettingsDetailLayer onClose={onClose}><section className="model-dialog savings-call-detail" role="dialog" aria-modal="true" aria-label="工具调用详情">
    <header><h3>工具调用详情</h3><button type="button" onClick={onClose}>关闭</button></header>
    <p className="savings-notice">会话 {origin.sessionId} · {origin.toolCallId}</p>
    {error ? <p role="alert">{error}</p> : tool ? <ToolActivityDetail projectId={origin.projectId} tool={tool}
      onPreviewFile={file => { void window.biny.openWorkspaceFile(origin.projectId, file).catch(failure => setError(String(failure))); }}
      onOpenExternal={url => { void window.biny.openExternal(url).catch(failure => setError(String(failure))); }} /> : <p role="status">正在读取调用…</p>}
  </section></SettingsDetailLayer>;
}
