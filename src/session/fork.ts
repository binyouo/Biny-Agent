/**
 * 会话分叉模块。
 *
 * 探索性任务需要"两条路都试试再比"。在此之前只能 resume 一条线性会话：想换个方向，要么
 * 在同一条会话里继续（前一条路的上下文还挂着，会影响模型判断），要么开一个全新会话（此前
 * 所有铺垫全丢）。
 *
 * 分叉把某个时点之前的历史复制成一条新会话，两边此后各走各的，原会话完全不受影响。
 *
 * 截断点有一条硬规则：不能停在 tool_call 和它的 tool_result 中间。那样重放会给这个调用补
 * 一条"已中断"的假结果（见 `replay.ts` 的 `interruptedToolResults`），分叉出来的会话从第一
 * 步起就带着一个从未发生过的失败。
 */
import { randomUUID } from "node:crypto";
import { createSessionFile, resolveSessionFile, sessionIdFromFile } from "./store.js";
import { createSessionId } from "./recorder.js";
import { readStoredSessionEvents } from "./events.js";
import type { SessionEvent } from "./recorder.js";
import { registerSessionBranch } from "./catalog.js";

export interface ForkSessionOptions {
  /** 保留前 N 条事件；不给则复制整条会话。会向前对齐到安全的截断点。 */
  upToEvent?: number;
}

export interface ForkedSession {
  sessionId: string;
  filePath: string;
  sourceSessionId: string;
  /** 实际保留的事件数，可能小于请求值（为了不切断工具调用配对）。 */
  events: number;
}

/**
 * 分叉复制的是对话内容，不是原会话已经发生过的运行事实。
 *
 * runtime event id 在整个 workspace 内唯一，run/turn id 也会关联 authority 中的运行记录；
 * 原样复制这些 metadata 会让新会话在下次启动重建 projection 时被判定为冲突。重新编号不会
 * 改变模型消息、工具参数或消息父链，只把新分支视为一条独立的运行历史。
 */
export function rebaseForkedSessionEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const runIds = new Map<string, string>();
  const turnIds = new Map<string, string>();
  let eventSeq = 0;
  const remap = (ids: Map<string, string>, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const existing = ids.get(value);
    if (existing !== undefined) return existing;
    const replacement = randomUUID();
    ids.set(value, replacement);
    return replacement;
  };

  return events.map((event) => {
    const runtime = event.runtime;
    if (runtime === undefined) return event;
    eventSeq += 1;
    return {
      ...event,
      runtime: {
        eventId: randomUUID(),
        eventSeq,
        runId: remap(runIds, runtime.runId),
        turnId: remap(turnIds, runtime.turnId)
      }
    };
  });
}

export async function forkSession(
  persistenceRoot: string,
  sourceSession: string | undefined,
  options: ForkSessionOptions = {}
): Promise<ForkedSession> {
  const sourcePath = await resolveSessionFile(persistenceRoot, sourceSession);
  const { events } = await readStoredSessionEvents(persistenceRoot, sourceSession);
  if (!events.length) throw new Error("Cannot fork an empty session.");

  const requested = options.upToEvent ?? events.length;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new RangeError("upToEvent must be a positive integer.");
  }
  const cut = safeCutPoint(events, Math.min(requested, events.length));
  if (cut === 0) throw new Error("No safe fork point exists before the requested event.");

  const kept = rebaseForkedSessionEvents(events.slice(0, cut));
  const bytes = Buffer.from(`${kept.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const sessionId = createSessionId();
  const filePath = await createSessionFile(persistenceRoot, sessionId, bytes);
  await registerSessionBranch(persistenceRoot, {
    sessionId,
    parentSessionId: sessionIdFromFile(sourcePath),
    branchPoint: { kind: "event", index: kept.length }
  });
  return { sessionId, filePath, sourceSessionId: sessionIdFromFile(sourcePath), events: kept.length };
}

/**
 * 向前找到最近一个不会切断工具调用配对的位置。
 *
 * 从请求点往回退，直到该前缀里每个 tool_call 都有配对的 tool_result。
 * 消息回执或后续对话不是工具结果，不能使尚未配对的调用变成安全截断点。
 */
function safeCutPoint(events: readonly SessionEvent[], requested: number): number {
  for (let cut = requested; cut > 0; cut -= 1) {
    if (!hasUnmatchedToolCalls(events.slice(0, cut))) return cut;
  }
  return 0;
}

function hasUnmatchedToolCalls(events: readonly SessionEvent[]): boolean {
  const open = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.type === "tool_call") {
      open.add(event.toolCallId ?? `sequence-${String(event.sequence ?? index)}`);
      continue;
    }
    if (event.type === "tool_result") open.delete(event.toolCallId ?? `sequence-${String(event.sequence ?? index)}`);
  }
  return open.size > 0;
}
