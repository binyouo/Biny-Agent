/** 经用户显式动作读取 macOS EventKit；结果只返回给调用方，不进入记忆或会话索引。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDateReferenceRange, type DateReferenceRange } from "./dateReference.js";

export interface NativeCalendarEvent {
  title: string;
  startDate: string;
  endDate: string;
  calendar?: string;
  isAllDay: boolean;
  identifier?: string;
}
export interface NativeCalendarResult {
  events: NativeCalendarEvent[];
  hasMore: boolean;
  coverage: "host-eventkit-calendars";
}
type CalendarRun = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

function calendarReaderPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = path.join(resourcesPath ?? "", "native", "calendar-reader");
  if (resourcesPath && existsSync(packaged)) return packaged;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledCli = path.resolve(moduleDir, "../native/calendar-reader");
  return existsSync(bundledCli) ? bundledCli : path.resolve(moduleDir, "../../out/native/calendar-reader");
}

const defaultRun: CalendarRun = async (command, args, options) => await promisify(execFile)(command, args, options);

function localMidnight(day: string, timeZone: string): number {
  const target = Date.parse(`${day}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value);
    const displayed = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    instant += target - displayed;
  }
  return instant;
}

export async function readNativeCalendar(
  range: DateReferenceRange,
  options: { authorized: boolean; platform?: NodeJS.Platform; run?: CalendarRun }
): Promise<NativeCalendarResult> {
  if (!options.authorized) throw new Error("Calendar read requires explicit authorization.");
  validateDateReferenceRange(range);
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Native calendar is unavailable outside macOS.");
  const rangeStart = localMidnight(range.startDate, range.timeZone);
  const rangeEnd = localMidnight(range.endDate, range.timeZone);
  let output: { stdout: string; stderr: string };
  try {
    output = await (options.run ?? defaultRun)(calendarReaderPath(), [], {
      env: { ...process.env, BINY_CALENDAR_FROM: range.startDate, BINY_CALENDAR_TO: range.endDate, BINY_CALENDAR_ZONE: range.timeZone },
      timeout: 20_000, maxBuffer: 2_000_000
    });
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { killed?: boolean };
    if (cause.killed || /timed out|ETIMEDOUT/u.test(cause.message)) throw new Error("Calendar read timed out.", { cause: error });
    throw new Error("Native calendar service unavailable.", { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(output.stdout); }
  catch { throw new Error("Native calendar returned invalid data."); }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Native calendar returned invalid data.");
  const result = parsed as Record<string, unknown>;
  if (result.status === "denied") throw new Error("Calendar access denied.");
  if (result.status === "timeout") throw new Error("Calendar read timed out.");
  if (result.status !== "ok" || !Array.isArray(result.events) || result.events.length > 200 || typeof result.hasMore !== "boolean") {
    throw new Error("Native calendar returned invalid data.");
  }
  const events = result.events.map((value): NativeCalendarEvent => {
    if (typeof value !== "object" || value === null) throw new Error("Native calendar returned an invalid event.");
    const event = value as Record<string, unknown>;
    if (typeof event.title !== "string" || event.title.length > 500 || typeof event.startDate !== "string" || typeof event.endDate !== "string"
      || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(event.startDate) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(event.endDate)
      || Number.isNaN(Date.parse(event.startDate)) || Number.isNaN(Date.parse(event.endDate)) || Date.parse(event.startDate) >= Date.parse(event.endDate)
      || typeof event.isAllDay !== "boolean" || (event.calendar !== undefined && typeof event.calendar !== "string")
      || (event.identifier !== undefined && typeof event.identifier !== "string")) throw new Error("Native calendar returned an invalid event.");
    if (Date.parse(event.startDate) >= rangeEnd || Date.parse(event.endDate) <= rangeStart) {
      throw new Error("Native calendar returned an event outside the requested range.");
    }
    return { title: event.title, startDate: event.startDate, endDate: event.endDate, isAllDay: event.isAllDay,
      calendar: event.calendar as string | undefined, identifier: event.identifier as string | undefined };
  });
  return { events, hasMore: result.hasMore, coverage: "host-eventkit-calendars" };
}
