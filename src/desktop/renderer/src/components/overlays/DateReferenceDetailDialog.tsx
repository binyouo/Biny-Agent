/** 日期引用详情只展示来源服务明确覆盖的记录；日历和原文索引由用户显式触发。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { DateReferenceDetail } from "../../../../../session/dateReferenceDetail.js";
import type { NativeCalendarResult } from "../../../../../session/nativeCalendar.js";
import { parseTemporalSourceUri } from "../../../../../session/temporalSourceUri.js";

interface Props {
  projectId: string;
  uri: string;
  onClose(): void;
  onSource(sessionId: string, messageId: string): void;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function DateReferenceDetailDialog({ projectId, uri, onClose, onSource }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<DateReferenceDetail>();
  const [error, setError] = useState<string>();
  const [calendar, setCalendar] = useState<NativeCalendarResult>();
  const [calendarError, setCalendarError] = useState<string>();
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [indexBusy, setIndexBusy] = useState<string>();
  const [indexError, setIndexError] = useState<string>();
  const [indexStatus, setIndexStatus] = useState<string>();
  const request = useRef(0);
  const indexRequest = useRef<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    const current = ++request.current;
    setError(undefined);
    try {
      const result = await window.biny.referenceDateDetail(projectId, uri);
      if (current === request.current) setDetail(result);
    } catch (cause) {
      if (current === request.current) { setDetail(undefined); setError(message(cause)); }
    }
  }, [projectId, uri]);
  useEffect(() => {
    setDetail(undefined);
    setCalendar(undefined);
    setCalendarError(undefined);
    setIndexError(undefined);
    void load();
    return () => { request.current += 1; if (indexRequest.current) void window.biny.referenceCancelIndex(indexRequest.current); };
  }, [load]);

  const readCalendar = async (): Promise<void> => {
    setCalendarBusy(true); setCalendar(undefined); setCalendarError(undefined);
    try { setCalendar(await window.biny.referenceDateCalendar(projectId, uri)); }
    catch (cause) { setCalendarError(message(cause)); }
    finally { setCalendarBusy(false); }
  };
  const indexOriginal = async (sessionId: string): Promise<void> => {
    const id = crypto.randomUUID();
    indexRequest.current = id;
    setIndexBusy(sessionId); setIndexError(undefined); setIndexStatus(undefined);
    try {
      const result = await window.biny.referenceIndexOriginal(projectId, sessionId, id);
      setIndexStatus(`已索引 ${result.indexedMessages} 条原始消息`);
      await load();
    } catch (cause) { setIndexError(message(cause)); }
    finally { indexRequest.current = undefined; setIndexBusy(undefined); }
  };
  const sessions = [...new Set(detail?.conversations.map((item) => item.sessionId) ?? [])];

  return <Dialog isOpen maxHeight="min(82vh, 720px)" onOpenChange={(open) => { if (!open) onClose(); }} padding={0} purpose="info" width="min(600px, calc(100vw - 48px))">
    <section className="time-clues-dialog">
      <DialogHeader onOpenChange={(open) => { if (!open) onClose(); }} title="日期详情"
        subtitle={detail ? `${detail.range.startDate} 至 ${detail.range.endDate}（结束日期不含） · ${detail.range.timeZone}` : undefined} />
      <div className="time-clues-list" aria-live="polite">
        {!detail && !error ? <p>正在读取…</p> : null}
        {error ? <p role="alert">读取失败：{error} <button onClick={() => void load()} type="button">重试</button></p> : null}
        {detail ? <>
          <section className="time-clues-group"><h3>对话</h3><p>{detail.coverage.conversations}</p>
            {detail.conversations.length ? detail.conversations.map((item) => <button className="time-clues-source" key={`${item.sessionId}:${item.messageId}`}
              onClick={() => onSource(item.sessionId, item.messageId)} type="button"><strong>{item.time}</strong><span>{item.quote}</span></button>) : <p>此范围没有对话。</p>}
            {detail.hasMore.conversations ? <p>仅显示前 100 条。</p> : null}</section>
          <section className="time-clues-group"><h3>时间线索</h3><p>{detail.coverage.clues}</p>
            {detail.clues.length ? detail.clues.map((item) => <button className="time-clues-source" key={item.id}
              onClick={() => { try { const source = parseTemporalSourceUri(item.sourceUri); onSource(source.sessionId, source.messageId); } catch { setError("来源已不可用。"); } }}
              type="button"><strong>{item.expression} · {item.date}</strong><span>{item.quote}</span></button>) : <p>此范围没有线索。</p>}
            {detail.hasMore.clues ? <p>仅显示前 50 条。</p> : null}</section>
          <section className="time-clues-group"><h3>工作事实</h3><p>{detail.coverage.facts}</p>
            {detail.facts.length ? detail.facts.map((item) => <button className="time-clues-source" key={item.id}
              onClick={() => { try { const source = parseTemporalSourceUri(item.sourceUri); onSource(source.sessionId, source.messageId); } catch { setError("来源已不可用。"); } }}
              type="button"><strong>{item.title} · {item.state}</strong><span>{item.quote}</span></button>) : <p>尚无已索引工作事实。</p>}
            {detail.hasMore.facts ? <p>仅显示前 50 条。</p> : null}
            {sessions.map((sessionId) => <button disabled={Boolean(indexBusy)} key={sessionId} onClick={() => void indexOriginal(sessionId)}
              type="button">{indexBusy === sessionId ? "正在索引…" : `索引会话 ${sessionId} 的原文`}</button>)}
            {indexBusy ? <button onClick={() => { if (indexRequest.current) void window.biny.referenceCancelIndex(indexRequest.current); }} type="button">取消索引</button> : null}
            {indexStatus ? <p>{indexStatus}</p> : null}{indexError ? <p role="alert">索引失败：{indexError}</p> : null}</section>
          <section className="time-clues-group"><h3>一次性任务</h3><p>{detail.coverage.scheduled}</p>
            {detail.scheduled.length ? detail.scheduled.map((item) => <p key={item.automationId}>{item.name} · {item.dueAt} · {item.status}{item.fired ? " · 已触发" : ""}</p>) : <p>此范围没有一次性任务。</p>}
            {detail.hasMore.scheduled ? <p>仅显示前 100 条。</p> : null}</section>
          <section className="time-clues-group"><h3>运行记录</h3><p>{detail.coverage.runs}</p>
            {detail.runs.length ? detail.runs.map((item) => <p key={`${item.kind}:${item.id}`}>{item.kind} · {item.occurredAt} · {item.status}</p>) : <p>此范围没有运行记录。</p>}
            {detail.hasMore.runs ? <p>仅显示前 100 条。</p> : null}</section>
          <section className="time-clues-group"><h3>本机日历</h3><p>只在点击后读取，不保存到记忆。</p>
            <button disabled={calendarBusy} onClick={() => void readCalendar()} type="button">{calendarBusy ? "正在读取…" : calendar ? "重新读取日历" : "读取本机日历"}</button>
            {calendarError ? <p role="alert">日历读取失败：{calendarError}</p> : null}
            {calendar && (calendar.events.length ? calendar.events.map((item, index) => <p key={`${item.identifier ?? item.startDate}:${index}`}>{item.title} · {item.startDate}–{item.endDate}</p>) : <p>此范围没有日历事件。</p>)}
            {calendar?.hasMore ? <p>仅显示部分日历事件。</p> : null}</section>
        </> : null}
      </div>
    </section>
  </Dialog>;
}
