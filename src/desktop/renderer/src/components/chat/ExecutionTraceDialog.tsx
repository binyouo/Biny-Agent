/** Trace 按消息刷新持久记录；请求输出与执行结果按调用 ID 关联，不推算缺失指标。 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { TimelineTurn } from "../../sessionTimeline.js";
import { buildSessionTimeline, executionToolLabel } from "../../sessionTimeline.js";
import { finishReasonTone } from "../../chatModel.js";
import { Icon } from "../Icon.js";

export function ExecutionTraceDialog({ turn, projectId, sessionId, onClose }: { turn: TimelineTurn; projectId?: string; sessionId?: string; onClose(): void }): React.JSX.Element {
  const [loaded, setLoaded] = useState<TimelineTurn>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(projectId && sessionId));
  const [revision, setRevision] = useState(0);
  const messageId = turn.assistantMessageId;
  const userMessageId = turn.userMessageId;
  useEffect(() => {
    if (!projectId || !sessionId) return;
    let current = true;
    setLoading(true); setError(undefined); setLoaded(undefined);
    void window.biny.readSessionTrace(projectId, sessionId).then((events) => {
      if (!current) return;
      const turns = buildSessionTimeline(events, []);
      const target = turns.find((item) => messageId ? item.assistantMessageId === messageId : userMessageId && item.userMessageId === userMessageId);
      if (!target) throw new Error("此消息已切换版本或无法读取，请关闭后重新打开。");
      setLoaded(target);
    }).catch((reason: unknown) => { if (current) setError(String(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, sessionId, messageId, userMessageId, revision]);
  return <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} purpose="info" width="min(672px, calc(100vw - 48px))">
    <DialogHeader title="执行 Trace" onOpenChange={(open) => { if (!open) onClose(); }} />
    {loading ? <p className="execution-trace-empty" role="status">正在加载 Trace…</p> : error ? <div role="alert" className="execution-trace-empty">{error}<button type="button" onClick={() => setRevision((value) => value + 1)}>重试</button></div> : <ExecutionTraceContent turn={loaded ?? turn} />}
  </Dialog>;
}

const tokens = (value?: number): string => value === undefined ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const seconds = (value?: number): string => value === undefined ? "—" : `${(value / 1000).toFixed(1)}s`;

export function ExecutionTraceContent({ turn }: { turn: TimelineTurn }): React.JSX.Element {
  const requests = turn.modelRequests ?? [];
  const windows = new Map<string, { start: number; end: number }>();
  for (const request of requests) {
    const start = Date.parse(request.startedAt);
    if (!Number.isFinite(start)) continue;
    const key = request.requestContext?.runId ?? request.requestId;
    const previous = windows.get(key);
    windows.set(key, { start: Math.min(previous?.start ?? start, start), end: Math.max(previous?.end ?? start, start + request.durationMs) });
  }
  // 每个 run 的请求区间包含其间工具执行，跨 run 的暂停时间不计入。缺失时不拿消息间隔冒充执行耗时。
  const duration = windows.size ? [...windows.values()].reduce((sum, item) => sum + item.end - item.start, 0) : undefined;
  const counts = requests.map((request) => request.usage?.totalTokens ?? (request.usage?.inputTokens !== undefined && request.usage.outputTokens !== undefined ? request.usage.inputTokens + request.usage.outputTokens : undefined));
  const total = counts.length && counts.every((value) => value !== undefined) ? counts.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined;
  const last = requests.at(-1);
  const reason = turn.finishReason ?? last?.finishReason;
  return <div className="execution-trace">
    <header className="execution-trace-summary"><div><code>{last ? `${last.provider}/${last.modelId}` : turn.model?.label ?? "—"}</code><span className={`trace-status is-${turn.status}`}>{turn.status}</span></div>
      <div><span className={`trace-reason is-${finishReasonTone(reason ?? "")}`}><i />{reason ?? "未记录"}</span><small>({turn.finishReason ? "turn" : last?.finishReason ? "step" : "unrecorded"})</small><small className="trace-totals" title="按 run 汇总已记录请求的执行区间，不包含跨运行的暂停；ctx 为最后一次请求输入 token。">{requests.length ? `${requests.length} 步` : "步数未记录"} · {seconds(duration)} · {tokens(total)} tok · ctx {tokens(last?.usage?.inputTokens)}</small></div>
      {turn.error ? <p className="trace-error">{turn.error}</p> : null}
    </header>
    {requests.length ? requests.map((request, index) => {
      const calls = request.output?.toolCalls ?? [];
      const toolStep = calls.length > 0 || request.finishReason === "tool-calls";
      return <div className="execution-trace-step" key={request.requestId}>
        <div className="trace-step-heading"><span>#{index + 1}</span><span className={`trace-step-type${toolStep ? " is-tool" : ""}`}><Icon name={toolStep ? "wrench" : "brain"} size={12} />{toolStep ? "call_tool" : "call_llm"}</span><span className={`trace-reason is-${finishReasonTone(request.finishReason ?? (request.error ? "error" : ""))}`}><i />{request.finishReason ?? (request.error ? "error" : "未记录")}</span><small>in {tokens(request.usage?.inputTokens)} · out {tokens(request.usage?.outputTokens)} · {seconds(request.durationMs)}</small></div>
        {calls.length ? <div className="trace-tool-tags">{calls.map((call) => <span key={call.id}>{executionToolLabel(call.name)}</span>)}</div> : null}
        {request.output?.textPreview ? <p className="trace-text-preview">{request.output.textPreview}</p> : null}
        {request.error ? <p className="trace-error" role="alert">{request.error}</p> : null}

      </div>;
    }) : <p className="execution-trace-empty">此回合未记录模型请求明细。</p>}

  </div>;
}
