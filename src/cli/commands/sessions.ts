/**
 * 会话列表命令模块。
 *
 * `sessions` 读取本项目对应的全局 JSONL 文件，展示每个 session 的创建时间、
 * 最近更新时间、事件数、首条用户消息和最后一条 assistant 消息摘要。
 */
import { ensureAgentDirs } from "../../session/store.js";
import { querySessionCatalog, type SessionBranchPoint, type SessionCatalogPage } from "../../session/catalog.js";
import type { SessionSummary } from "../../session/events.js";

export interface SessionsCommandOptions {
  limit?: number;
  cursor?: string;
  parent?: string;
  json?: boolean;
}

export async function sessionsCommand(workspaceRoot: string, options: SessionsCommandOptions = {}): Promise<void> {
  // sessions 命令会先确保目录存在，这样新项目也能给出友好的空列表。
  await ensureAgentDirs(workspaceRoot);
  const page = await querySessionCatalog(workspaceRoot, {
    limit: options.limit,
    cursor: options.cursor,
    parentSessionId: options.parent
  });
  if (options.json) {
    console.log(JSON.stringify(page));
    return;
  }
  if (page.revisionChanged) {
    console.log("Session list changed; request the first page again.");
    return;
  }
  printSessionCatalogPage(page);
}

export function printSessionCatalogPage(page: SessionCatalogPage): void {
  if (!page.items.length) {
    console.log("No sessions found.");
    return;
  }

  for (const item of page.items) {
    printSessionSummary(item.summary, item.parentSessionId, item.branchPoint);
  }
  if (page.nextCursor) console.log(`next-cursor: ${page.nextCursor}`);
}

/** 保留给嵌入方的简单打印函数；新列表走 catalog page。 */
export function printSessionSummaries(sessions: SessionSummary[]): void {
  if (!sessions.length) {
    console.log("No sessions found.");
    return;
  }

  for (const session of sessions) printSessionSummary(session);
}

function printSessionSummary(
  session: SessionSummary,
  parentSessionId?: string,
  branchPoint?: SessionBranchPoint
): void {
  // 摘要压成单行，避免长对话内容把 session 列表冲散。
  const firstMessage = sessionSummaryPreview(session.firstUserMessage) || "(no user_message)";
  const lastAssistant = sessionSummaryPreview(session.lastAssistantMessage) || "(no assistant_message)";
  const terminalStatus = session.lastTurnStatus ? `\t${session.lastTurnStatus.status}` : "";
  console.log(`${session.fileName}\t${session.createdAt}\t${relativeTime(session.updatedAt)}\t${session.eventCount} events${terminalStatus}`);
  console.log(`  user: ${firstMessage}`);
  console.log(`  biny: ${lastAssistant}`);
  if (parentSessionId && branchPoint) {
    console.log(`  branch: ${parentSessionId} @ ${branchPoint.kind}:${String(branchPoint.index)}`);
  }
}

function sessionSummaryPreview(content: string): string {
  const text = content.replace(/\s+/g, " ");
  let end = Math.min(80, text.length);
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

function relativeTime(value: string): string {
  // 简单相对时间只用于列表展示，不参与任何排序或恢复逻辑。
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${String(Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${String(Math.floor(diff / hour))}h ago`;
  return `${String(Math.floor(diff / day))}d ago`;
}
