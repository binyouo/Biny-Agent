/** 侧栏时间线索弹层；只显示原始用户消息索引，来源操作交给 App 导航。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { DesktopTemporalPage } from "../../../../temporalMemoryService.js";
import { parseTemporalSourceUri } from "../../../../../session/temporalSourceUri.js";
import { customTemporalRange, naturalTemporalRanges, shiftTemporalDay, type TemporalDateRange } from "../../temporalRanges.js";

type RangeKind = "today" | "thisWeek" | "nextWeek" | "custom";
const RANGE_LABELS: Record<RangeKind, string> = { today: "今天", thisWeek: "本周", nextWeek: "下周", custom: "自选" };
const PAGE_SIZE = 50;

interface Props {
  open: boolean;
  currentSessionId?: string;
  refreshKey?: string;
  onClose(): void;
  onSource(projectId: string, sessionId: string, messageId: string): void;
}

export function TimeCluesDialog({ open, currentSessionId, refreshKey, onClose, onSource }: Props): React.JSX.Element {
  const [rangeKind, setRangeKind] = useState<RangeKind>("today");
  const [now, setNow] = useState(() => new Date());
  const [page, setPage] = useState<DesktopTemporalPage>();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [custom, setCustom] = useState<TemporalDateRange>();
  const [rangeStart, setRangeStart] = useState<string>();
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const requestRef = useRef(0);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ranges = naturalTemporalRanges(now, timeZone);
  const today = ranges.today.startDate;
  const range: TemporalDateRange = rangeKind === "custom" ? custom ?? ranges.today : ranges[rangeKind];
  const { startDate, endDate } = range;

  const load = useCallback(async (nextOffset: number): Promise<void> => {
    const request = ++requestRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.biny.temporalClues({ startDate, endDate, today, currentSessionId: rangeKind === "today" ? currentSessionId : undefined,
        timeZone, limit: PAGE_SIZE, offset: nextOffset });
      if (request !== requestRef.current) return;
      setPage(next);
      setOffset(nextOffset);
    } catch (cause) {
      if (request === requestRef.current) { setPage(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, [startDate, endDate, today, currentSessionId, rangeKind, timeZone]);

  useEffect(() => {
    if (!open) { requestRef.current += 1; setPage(undefined); return; }
    setPage(undefined);
    void load(0);
  }, [open, refreshKey, load]);
  useEffect(() => {
    if (!open) return;
    const refreshDay = (): void => setNow(new Date());
    refreshDay();
    const timer = window.setInterval(refreshDay, 60_000);
    document.addEventListener("visibilitychange", refreshDay);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshDay); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const refresh = (): void => { if (document.visibilityState === "visible") void load(0); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [open, load]);

  const ignore = async (id: string): Promise<void> => {
    try { await window.biny.temporalIgnoreClue(id); await load(offset); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const markSeen = async (): Promise<void> => {
    try { await window.biny.temporalMarkTodaySeen(today, timeZone); await load(offset); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const groups = new Map<string, NonNullable<DesktopTemporalPage>["clues"]>();
  for (const clue of page?.clues ?? []) {
    const date = clue.date ?? "";
    const group = groups.get(date) ?? [];
    group.push(clue);
    groups.set(date, group);
  }

  const selectDay = (day: string): void => {
    if (!rangeStart || day < rangeStart) { setRangeStart(day); return; }
    try {
      setCustom(customTemporalRange(rangeStart, day));
      setRangeKind("custom");
      setOffset(0);
      setCalendarOpen(false);
      setRangeStart(undefined);
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const [calendarYear, calendarMonthNumber] = calendarMonth.split("-").map(Number);
  const firstWeekday = (new Date(Date.UTC(calendarYear!, calendarMonthNumber! - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(calendarYear!, calendarMonthNumber!, 0)).getUTCDate();
  const shiftMonth = (amount: number): void => {
    const month = new Date(Date.UTC(calendarYear!, calendarMonthNumber! - 1 + amount, 1));
    setCalendarMonth(month.toISOString().slice(0, 7));
  };

  return <Dialog isOpen={open} maxHeight="min(82vh, 720px)" onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} padding={0} purpose="info" width="min(600px, calc(100vw - 48px))">
    <section className="time-clues-dialog">
      <DialogHeader onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} subtitle="按日期找回原始对话中的时间线索" title="时间线索" />
      <div className="time-clues-tabs">
        {(Object.keys(RANGE_LABELS) as RangeKind[]).map((kind) => <button aria-pressed={rangeKind === kind} key={kind}
          onClick={() => { if (kind === "custom") setCalendarOpen((value) => !value); else { setRangeKind(kind); setCalendarOpen(false); setOffset(0); } }} type="button">
          {kind === "custom" && custom ? `${shiftTemporalDay(custom.startDate, 0)}–${shiftTemporalDay(custom.endDate, -1)}` : RANGE_LABELS[kind]}</button>)}
      </div>
      {calendarOpen ? <div className="time-clues-calendar">
        <div className="time-clues-calendar-heading">
          <button aria-label="上个月" onClick={() => shiftMonth(-1)} type="button">‹</button>
          <strong>{calendarMonth}</strong>
          <button aria-label="下个月" onClick={() => shiftMonth(1)} type="button">›</button>
        </div>
        <p>{rangeStart ? `选择结束日期（起始 ${rangeStart}）` : "选择起始日期"}</p>
        <div className="time-clues-calendar-grid">
          {["一", "二", "三", "四", "五", "六", "日"].map((label) => <span key={label}>{label}</span>)}
          {Array.from({ length: firstWeekday }, (_, index) => <span key={`empty-${index}`} />)}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const day = `${calendarMonth}-${String(index + 1).padStart(2, "0")}`;
            return <button aria-pressed={day === rangeStart} key={day} onClick={() => selectDay(day)} type="button">{index + 1}</button>;
          })}
        </div>
      </div> : null}
      <div aria-live="polite" className="time-clues-list">
        {busy && !page ? <p>正在读取…</p> : null}
        {error ? <p role="alert">读取时间线索失败：{error} <button onClick={() => void load(offset)} type="button">重试</button></p> : null}
        {!busy && !error && page?.clues.length === 0 && page.scheduled.length === 0 ? <p>此范围没有时间线索。</p> : null}
        {[...groups].map(([date, clues]) => <section className="time-clues-group" key={date}>
          <h3>{date === today ? `今天 · ${date}` : date || "日期未确定"}</h3>
          {clues.map((clue) => <article className="time-clues-row" key={clue.id}>
            <button className="time-clues-source" disabled={!clue.projectId} onClick={() => {
              if (!clue.projectId) return;
              const source = parseTemporalSourceUri(clue.sourceUri);
              onSource(clue.projectId, source.sessionId, source.messageId);
            }} type="button">
              <strong>{clue.expression}</strong>{clue.endDate ? ` · ${clue.date}–${clue.endDate}` : ""}
              <span>{clue.quote}</span>
            </button>
            <button aria-label={`忽略线索：${clue.expression}`} disabled={busy} onClick={() => void ignore(clue.id)} type="button">忽略</button>
          </article>)}
        </section>)}
        {page?.scheduled.length ? <section className="time-clues-group">
          <h3>一次性任务</h3>
          {page.scheduled.map((task) => <article className="time-clues-row" key={task.id}>
            <div className="time-clues-source"><strong>{task.name}</strong><span>{task.date} {task.time} · {task.fired ? "已运行" : "待运行"}</span></div>
          </article>)}
        </section> : null}
      </div>
      <footer className="time-clues-footer">
        {offset > 0 || page?.hasMore ? <div className="time-clues-pagination">
          <button disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))} type="button">上一页</button>
          <button disabled={busy || !page?.hasMore} onClick={() => void load(page?.nextOffset ?? offset)} type="button">下一页</button>
        </div> : null}
        <div className="time-clues-footer-actions">
          <button aria-expanded={aboutOpen} onClick={() => setAboutOpen((value) => !value)} type="button">关于线索</button>
          {page && page.unread > 0 ? <button disabled={busy} onClick={() => void markSeen()} type="button">标记今日已读（{page.unread}）</button> : null}
        </div>
        {aboutOpen ? <p>仅覆盖已索引的原始用户消息 · {range.startDate} 至 {range.endDate}（结束日期不含） · {timeZone}</p> : null}
      </footer>
    </section>
  </Dialog>;
}
