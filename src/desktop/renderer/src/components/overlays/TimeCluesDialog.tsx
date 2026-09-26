/** 侧栏时间线索弹层；只显示原始用户消息索引，来源操作交给 App 导航。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, type DateRange, type ISODateString } from "@astryxdesign/core/Calendar";
import { Icon } from "../Icon.js";
import { usePopover } from "@astryxdesign/core/Popover";
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
  const { triggerRef, triggerProps, toggle: toggleCalendar, hide: hideCalendar, isOpen: calendarOpen, render: renderCalendar } = usePopover({ hasSurface: false, dialogLabel: "选择日期范围", closeButtonLabel: "关闭日历" });
  const [calendarError, setCalendarError] = useState<string>();
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

  const selectRange = ({ start, end }: DateRange): void => {
    try {
      setCustom(customTemporalRange(start, end));
      setRangeKind("custom");
      setOffset(0);
      setCalendarError(undefined);
      hideCalendar();
    } catch (cause) { setCalendarError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <Dialog isOpen={open} maxHeight="min(82vh, 720px)" onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} padding={0} purpose="info" width="min(600px, calc(100vw - 48px))">
    <section className="time-clues-dialog">
      <div className="time-clues-header"><DialogHeader onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} subtitle="对话里提到的日期，点开即可回到原文。" title="时间线索" /></div>
      <div className="time-clues-tabs">
        {(["today", "thisWeek", "nextWeek"] as const).map((kind) => <button aria-pressed={rangeKind === kind} key={kind}
          onClick={() => { setRangeKind(kind); hideCalendar(); setOffset(0); }} type="button">{RANGE_LABELS[kind]}</button>)}
        <button {...triggerProps} aria-pressed={rangeKind === "custom"} ref={triggerRef}
          onClick={() => { setCalendarError(undefined); toggleCalendar(); }} type="button">
          选择日期<Icon className={calendarOpen ? "time-clues-chevron is-open" : "time-clues-chevron"} name="chevron" size={12} />
        </button>
      </div>
      {renderCalendar(calendarOpen ? <div className="time-clues-calendar">
        <Calendar mode="range" weekStartsOn="mon" value={{ start: startDate as ISODateString, end: shiftTemporalDay(endDate, -1) as ISODateString }} onChange={selectRange} />
        <p>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${startDate}T00:00:00Z`))} – {new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${shiftTemporalDay(endDate, -1)}T00:00:00Z`))}</p>
        {calendarError ? <p role="alert">{calendarError}</p> : null}
      </div> : null, { placement: "below", alignment: "start" })}
      <div aria-live="polite" className="time-clues-list">
        {busy && !page ? <p className="time-clues-status" role="status">正在读取…</p> : null}
        {error ? <p role="alert">读取时间线索失败：{error} <button onClick={() => void load(offset)} type="button">重试</button></p> : null}
        {!busy && !error && page?.clues.length === 0 && page.scheduled.length === 0 ? <p className="time-clues-status">此范围没有时间线索。</p> : null}
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
          <button aria-expanded={aboutOpen} onClick={() => setAboutOpen((value) => !value)} type="button">关于时间线索<Icon className={aboutOpen ? "time-clues-chevron is-open" : "time-clues-chevron"} name="chevron" size={12} /></button>
          {page && page.unread > 0 ? <button disabled={busy} onClick={() => void markSeen()} type="button">标记今日已读（{page.unread}）</button> : null}
        </div>
        {aboutOpen ? <p>仅覆盖已索引的原始用户消息 · {range.startDate} 至 {range.endDate}（结束日期不含） · {timeZone}</p> : null}
      </footer>
    </section>
  </Dialog>;
}
