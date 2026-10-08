/**
 * Session 消息快照层。
 *
 * 每次 replay 完成之后将 SessionReplay 中 resume() 需要的关键字段序列化到磁盘，
 * 后续加载同一 session 时直接读取快照，跳过「读字节 + JSON.parse + zod + 事件重放」
 * 整条链路，把加载时间从 O(n) 事件重放降到 O(1) 一次反序列化。
 *
 * 快照文件与 JSONL 同级，名为 <sessionId>.snap.json。快照内嵌 JSONL 的
 * (size, mtimeMs) 指纹，文件变化时自动失效并回退到完整重放路径。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../agent/core/types.js";
import type { SessionReplay, SessionMessageReference, SessionDiscardedToolCall, SessionMessageNode } from "./replay.js";
import type { SessionEvent, SessionContextUsage, SessionContextState, SessionContextCheckpoint, SessionUsage } from "./recorder.js";
import type { ModelRequestMetrics } from "../agent/core/types.js";
import type { RuntimeHighWater } from "./runtimeEvent.js";

// 只标记可重建的 replay 投影版本；原始 JSONL 的事件格式不变。
const replayVersion = 2;

export interface SessionSnapshotData {
  replayVersion: number;
  /** 快照时刻 JSONL 的指纹，用于判断快照是否过时。 */
  fingerprint: { size: number; mtimeMs: number };
  /** 快照创建时间。 */
  createdAt: string;

  // ── SessionReplay 的核心字段 ──
  messages: AgentMessage[];
  messageReferences: SessionMessageReference[];
  contextStartMessageIndex: number;
  contextStartUserMessageIndex: number;
  totalMessageCount: number;
  contextUsage?: SessionContextUsage;
  contextState?: SessionContextState;
  contextCheckpoint?: SessionContextCheckpoint;
  usage: SessionUsage[];
  modelRequests: ModelRequestMetrics[];
  recoveredToolResults: Array<Extract<SessionEvent, { type: "tool_result" }>>;
  discardedToolCalls: SessionDiscardedToolCall[];
  messageTree: SessionMessageNode[];
  runtimeHighWater?: RuntimeHighWater;

  /**
   * 预计算的 maxToolCallSequence，避免在 resume 路径上依赖 replay.events。
   * 等于 maxToolCallSequence(replay.events) 的结果。
   */
  maxToolCallSequence: number;
}

/** 快照文件路径：与 JSONL 同级，后缀改为 .snap.json。 */
function snapshotFilePath(jsonlPath: string): string {
  const dir = path.dirname(jsonlPath);
  const base = path.basename(jsonlPath, ".jsonl");
  return path.join(dir, `${base}.snap.json`);
}

/**
 * 尝试读取快照。
 *
 * @returns 快照数据；如果快照不存在、指纹不匹配或损坏，返回 undefined。
 */
export async function tryReadSessionSnapshot(
  jsonlPath: string,
  fingerprint: { size: number; mtimeMs: number }
): Promise<SessionSnapshotData | undefined> {
  const snapPath = snapshotFilePath(jsonlPath);
  try {
    const raw = await fs.readFile(snapPath, "utf-8");
    const snapshot: SessionSnapshotData = JSON.parse(raw);

    // 旧投影可能保留其他分支的 checkpoint 或漏掉未提交工具步骤，必须从原日志重算。
    if (snapshot.replayVersion !== replayVersion) return undefined;

    // 校验指纹：只要 size 或 mtimeMs 变了，快照作废。
    if (
      snapshot.fingerprint.size !== fingerprint.size ||
      snapshot.fingerprint.mtimeMs !== fingerprint.mtimeMs
    ) {
      return undefined;
    }

    return snapshot;
  } catch {
    // 文件不存在、JSON 解析失败等，一律回退到完整重放。
    return undefined;
  }
}

/**
 * 将 replay 结果写入快照文件。
 *
 * 快照写入是"尽力而为"的：失败不会影响主流程，catch 静默吞掉。
 * 写入是异步的，不会阻塞 resume 调用链。
 */
export async function writeSessionSnapshot(
  jsonlPath: string,
  fingerprint: { size: number; mtimeMs: number },
  replay: SessionReplay
): Promise<void> {
  try {
    const snapPath = snapshotFilePath(jsonlPath);
    const data: SessionSnapshotData = {
      replayVersion,
      fingerprint: { size: fingerprint.size, mtimeMs: fingerprint.mtimeMs },
      createdAt: new Date().toISOString(),
      messages: replay.messages,
      messageReferences: replay.messageReferences,
      contextStartMessageIndex: replay.contextStartMessageIndex,
      contextStartUserMessageIndex: replay.contextStartUserMessageIndex,
      totalMessageCount: replay.totalMessageCount,
      contextUsage: replay.contextUsage,
      contextState: replay.contextState,
      contextCheckpoint: replay.contextCheckpoint,
      usage: replay.usage,
      modelRequests: replay.modelRequests,
      recoveredToolResults: replay.recoveredToolResults,
      discardedToolCalls: replay.discardedToolCalls,
      messageTree: replay.messageTree,
      runtimeHighWater: replay.runtimeHighWater,
      maxToolCallSequence: maxToolCallSequence(replay.events),
    };
    await fs.writeFile(snapPath, JSON.stringify(data), "utf-8");
  } catch {
    // 尽力而为：写入失败不影响主流程。
  }
}

/**
 * 从快照数据重建 SessionReplay 对象（不含 events）。
 *
 * 返回的 replay 对象包含 resume() 需要的所有字段，events 为空数组——调用方
 * 不应依赖返回值的 events 字段（快照路径下也没有 events）。
 */
export function snapshotToReplay(snapshot: SessionSnapshotData): SessionReplay {
  return {
    events: [],
    messages: snapshot.messages,
    messageReferences: snapshot.messageReferences,
    contextStartMessageIndex: snapshot.contextStartMessageIndex,
    contextStartUserMessageIndex: snapshot.contextStartUserMessageIndex,
    totalMessageCount: snapshot.totalMessageCount,
    contextUsage: snapshot.contextUsage,
    contextState: snapshot.contextState,
    contextCheckpoint: snapshot.contextCheckpoint,
    usage: snapshot.usage,
    modelRequests: snapshot.modelRequests,
    recoveredToolResults: snapshot.recoveredToolResults,
    discardedToolCalls: snapshot.discardedToolCalls,
    messageTree: snapshot.messageTree,
    runtimeHighWater: snapshot.runtimeHighWater,
  };
}

/** 计算事件流中最大的 tool_call / tool_result sequence 编号。 */
function maxToolCallSequence(events: SessionReplay["events"]): number {
  return events.reduce((maximum, event) => {
    if ((event.type !== "tool_call" && event.type !== "tool_result") || typeof event.sequence !== "number") return maximum;
    return Math.max(maximum, event.sequence);
  }, 0);
}
