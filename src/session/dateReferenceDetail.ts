/** 日期引用详情只组合权威源的当前状态，各列表保留自身覆盖口径。 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { projectSessionsDir } from "../config/paths.js";
import { validateDateReferenceRange, type DateReferenceRange } from "./dateReference.js";
import { readSessionEvents } from "./events.js";
import { activeSessionEventsForPath } from "./messageTree.js";
import { listAllSessionFiles, sessionIdFromFile } from "./store.js";
import { TemporalMemoryIndex, type TemporalClueHit, type TemporalFactHit } from "./temporalMemory.js";

export interface DateConversationHit { projectId: string; sessionId: string; messageId: string; time: string; quote: string }
export interface DateScheduledHit { automationId: string; name: string; dueAt: string; status: string; fired: boolean }
export interface DateRunHit { id: string; occurredAt: string; status: string; kind: "task" | "automation" }
export interface DateReferenceDetail {
  range: DateReferenceRange;
  conversations: DateConversationHit[];
  clues: TemporalClueHit[];
  facts: TemporalFactHit[];
  scheduled: DateScheduledHit[];
  runs: DateRunHit[];
  coverage: { conversations: string; clues: string; facts: string; scheduled: string; runs: string };
  hasMore: { conversations: boolean; clues: boolean; facts: boolean; scheduled: boolean; runs: boolean };
}

function rows(value: unknown, key?: string): Record<string, unknown>[] {
  const source = key && typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : value;
  return Array.isArray(source) ? source.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

function instantDay(value: string, timeZone: string): string | undefined {
  if (Number.isNaN(Date.parse(value))) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export class DateReferenceDetailService {
  private readonly index: TemporalMemoryIndex;
  constructor(private readonly root: string) { this.index = new TemporalMemoryIndex(root); }
  close(): void { this.index.close(); }

  async query(range: DateReferenceRange, projects: Array<{ id: string; path: string }>, runtime: {
    automations?: unknown; pendingFires?: unknown; tasks?: unknown
  } = {}, signal?: AbortSignal): Promise<DateReferenceDetail> {
    validateDateReferenceRange(range);
    signal?.throwIfAborted();
    await this.index.refreshAll(signal);
    const owners = projects.map((project) => ({ id: project.id,
      directory: projectSessionsDir(project.path, { env: { ...process.env, BINY_AGENT_DIR: this.root } }) }));
    const ownedFiles: Array<{ file: string; projectId: string; sessionId: string }> = [];
    for (const file of await listAllSessionFiles(this.root)) {
      const canonical = await realpath(file);
      const owner = owners.find((item) => canonical.startsWith(`${item.directory}${path.sep}`));
      if (owner) ownedFiles.push({ file, projectId: owner.id, sessionId: sessionIdFromFile(file) });
    }
    const query = { startDate: range.startDate, endDate: range.endDate, limit: 50,
      sessionIds: ownedFiles.map((item) => item.sessionId) };
    const cluePage = this.index.queryClues(query);
    const factPage = this.index.queryFacts(query);
    const conversations: DateConversationHit[] = [];
    for (const { file, projectId, sessionId } of ownedFiles) {
      signal?.throwIfAborted();
      const messages = new Map<string, { hit: DateConversationHit; day: string; canonical: boolean }>();
      for (const event of activeSessionEventsForPath(await readSessionEvents(file))) {
        if (event.type !== "user_message" && event.type !== "assistant_message" && event.type !== "agent_message") continue;
        if (("auditOnly" in event && event.auditOnly === true) || typeof event.messageId !== "string" || !event.messageId.trim() || typeof event.time !== "string") continue;
        const content = event.type === "agent_message"
          ? event.message.role === "assistant" ? event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : undefined
          : event.content;
        if (!content?.trim()) continue;
        const day = instantDay(event.time, range.timeZone);
        if (!day) continue;
        const previous = messages.get(event.messageId);
        const canonical = event.type === "agent_message";
        // 同一消息的扁平投影可能稍后跨日写入；先选权威源，再判断日期及结果上限。
        if (!previous || (!previous.canonical && canonical)) messages.set(event.messageId, {
          hit: { projectId, sessionId, messageId: event.messageId, time: event.time, quote: content.slice(0, 300) }, day, canonical
        });
      }
      for (const { hit, day } of messages.values()) {
        if (day >= range.startDate && day < range.endDate) conversations.push(hit);
      }
    }
    const orderedConversations = conversations.map((hit) => ({ hit, instant: Date.parse(hit.time) }))
      .sort((left, right) => left.instant - right.instant || left.hit.sessionId.localeCompare(right.hit.sessionId));
    const scheduled: DateScheduledHit[] = [];
    for (const automation of rows(runtime.automations)) {
      if (automation.triggerType !== "once" || typeof automation.automationId !== "string" || typeof automation.name !== "string") continue;
      const schedule = automation.schedule;
      if (typeof schedule !== "object" || schedule === null || typeof (schedule as Record<string, unknown>).at !== "string") continue;
      const dueAt = (schedule as { at: string }).at;
      const day = instantDay(dueAt, range.timeZone);
      if (day && day >= range.startDate && day < range.endDate) scheduled.push({ automationId: automation.automationId,
        name: automation.name, dueAt, status: typeof automation.status === "string" ? automation.status : "unknown",
        fired: typeof automation.fireCount === "number" && automation.fireCount > 0 });
    }
    const runs: DateRunHit[] = [];
    for (const task of rows(runtime.tasks, "tasks")) {
      if (typeof task.taskRunId !== "string" || typeof task.createdAt !== "string") continue;
      const day = instantDay(task.createdAt, range.timeZone);
      if (day && day >= range.startDate && day < range.endDate) runs.push({ id: task.taskRunId, occurredAt: task.createdAt,
        status: typeof task.status === "string" ? task.status : "unknown", kind: "task" });
    }
    for (const fire of rows(runtime.pendingFires)) {
      if (typeof fire.fireId !== "string" || typeof fire.scheduledAt !== "string") continue;
      const day = instantDay(fire.scheduledAt, range.timeZone);
      if (day && day >= range.startDate && day < range.endDate) runs.push({ id: fire.fireId, occurredAt: fire.scheduledAt,
        status: typeof fire.status === "string" ? fire.status : "unknown", kind: "automation" });
    }
    const orderedScheduled = scheduled.map((hit) => ({ hit, instant: Date.parse(hit.dueAt) }))
      .sort((left, right) => left.instant - right.instant);
    const orderedRuns = runs.map((hit) => ({ hit, instant: Date.parse(hit.occurredAt) }))
      .sort((left, right) => left.instant - right.instant);
    return { range, conversations: orderedConversations.slice(0, 100).map(({ hit }) => hit), clues: cluePage.clues, facts: factPage.facts,
      scheduled: orderedScheduled.slice(0, 100).map(({ hit }) => hit), runs: orderedRuns.slice(0, 100).map(({ hit }) => hit),
      coverage: { conversations: "有时间戳的本机 Session 用户及助手消息", clues: cluePage.coverage,
        facts: "仅显式索引的原始用户文本与原文引文", scheduled: "Host 当前一次性定时任务快照", runs: "Host 当前任务及自动化触发记录" },
      hasMore: { conversations: conversations.length > 100, clues: cluePage.hasMore, facts: factPage.hasMore,
        scheduled: scheduled.length > 100, runs: runs.length > 100 } };
  }
}
