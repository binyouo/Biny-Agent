/** Desktop 使用原始会话的日期投影，并把来源定位到已登记项目。 */
import path from "node:path";
import { realpathSync } from "node:fs";
import { projectSessionsDir } from "../config/paths.js";
import { globalAgentDir } from "../config/paths.js";
import { listAllSessionFiles, sessionIdFromFile } from "../session/store.js";
import { TemporalMemoryIndex, type TemporalClueHit, type TemporalQuery } from "../session/temporalMemory.js";
import type { AutomationRecord } from "../runtime/AutomationScheduler.js";

export interface DesktopTemporalClue extends TemporalClueHit { projectId?: string }
export interface ScheduledTemporalRow {
  id: string;
  automationId: string;
  projectId: string;
  name: string;
  dueAt: string;
  date: string;
  time: string;
  fired: boolean;
}
export interface DesktopTemporalPage {
  clues: DesktopTemporalClue[];
  scheduled: ScheduledTemporalRow[];
  unread: number;
  hasMore: boolean;
  nextOffset: number | null;
  coverage: string;
}
export interface DesktopTemporalQuery extends TemporalQuery { timeZone?: string; includeScheduled?: boolean }

type ScheduledAutomation = Pick<AutomationRecord, "automationId" | "name" | "triggerType" | "schedule" | "status" | "fireCount">;

/** 一次性任务只从 Host 的自动化快照投影，删除与改期在下一次读取时自然消失。 */
export function scheduledTemporalRows(
  sources: Array<{ projectId: string; automations: ScheduledAutomation[] }>,
  range: Pick<TemporalQuery, "startDate" | "endDate">, timeZone: string, offset: number
): ScheduledTemporalRow[] {
  if (offset !== 0) return [];
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  return sources.flatMap(({ projectId, automations }) => automations.flatMap((automation) => {
    const dueAt = automation.schedule.at;
    if (automation.triggerType !== "once" || !dueAt || Number.isNaN(Date.parse(dueAt))) return [];
    const parts = formatter.formatToParts(new Date(dueAt));
    const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    if (date < range.startDate || date >= range.endDate) return [];
    return [{ id: `automation:${projectId}:${automation.automationId}`, automationId: automation.automationId,
      projectId, name: automation.name, dueAt, date, time: `${part("hour")}:${part("minute")}`,
      fired: automation.fireCount > 0 }];
  })).sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id));
}

export { parseTemporalSourceUri } from "../session/temporalSourceUri.js";

export class DesktopTemporalMemoryService {
  private readonly index: TemporalMemoryIndex;
  private readonly root: string;
  constructor(root?: string) { this.root = root ?? globalAgentDir(); this.index = new TemporalMemoryIndex(this.root); }
  close(): void { this.index.close(); }

  async query(query: DesktopTemporalQuery, projects: Array<{ id: string; path: string }>,
    scheduledSources: Array<{ projectId: string; automations: ScheduledAutomation[] }> = []): Promise<DesktopTemporalPage> {
    await this.index.refreshAll();
    const page = this.index.queryClues(query);
    const projectRoots = projects.map((project) => ({ id: project.id, sessions: projectSessionsDir(project.path, { env: { ...process.env, BINY_AGENT_DIR: this.root } }) }));
    const projectBySession = new Map<string, string | undefined>();
    for (const file of await listAllSessionFiles(this.root)) {
      const canonicalFile = realpathSync(file);
      const owner = projectRoots.find((project) => canonicalFile.startsWith(`${project.sessions}${path.sep}`));
      if (owner) {
        const sessionId = sessionIdFromFile(file);
        projectBySession.set(sessionId, projectBySession.has(sessionId) && projectBySession.get(sessionId) !== owner.id
          ? undefined : owner.id);
      }
    }
    return { ...page, clues: page.clues.map((clue) => ({ ...clue, projectId: projectBySession.get(clue.sessionId) })),
      scheduled: scheduledTemporalRows(scheduledSources, query, query.timeZone ?? "UTC", query.offset ?? 0) };
  }

  ignore(id: string): boolean { return this.index.ignoreClue(id); }
  markSeen(ids: string[], day: string, timeZone: string, now = new Date()): number {
    return this.index.markSeen(ids, day, timeZone, now);
  }
  markTodaySeen(day: string, timeZone: string, now = new Date()): number {
    return this.index.markTodaySeen(day, timeZone, now);
  }
}
