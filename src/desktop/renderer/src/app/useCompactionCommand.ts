/** 手动压缩的 Desktop 请求反馈；压缩结果仍由会话时间线呈现。 */
import { useCallback, useRef, useState } from "react";
import type { DesktopSlashResult } from "../../../protocol.js";

export interface CompactionCommandState {
  status: "pending" | "unchanged" | "failed" | "cancelled";
  message: string;
  retryable?: boolean;
}

export function useCompactionCommand({ projectId, sessionId, execute }: {
  projectId?: string;
  sessionId?: string;
  execute(projectId: string, sessionId: string | undefined, command: string): Promise<DesktopSlashResult>;
}): {
  state?: CompactionCommandState;
  run(projectId: string, sessionId: string | undefined, command: string): Promise<void>;
  start(projectId: string, sessionId: string | undefined, runId: string): void;
  fail(projectId: string, sessionId: string | undefined, error: string, cancelled: boolean, runId?: string): void;
  retry(): Promise<void>;
  dismiss(): void;
} {
  const [feedback, setFeedback] = useState(() => new Map<string, { state: CompactionCommandState; runId?: string }>());
  const requests = useRef(new Map<string, Promise<void>>());
  const commands = useRef(new Map<string, string>());
  const eventRunIds = useRef(new Map<string, string | undefined>());
  const start = useCallback((requestProjectId: string, requestSessionId: string | undefined, runId: string): void => {
    const key = scopeKey(requestProjectId, requestSessionId);
    if (eventRunIds.current.get(key) === runId) return;
    eventRunIds.current.set(key, runId);
    const localPending = requests.current.has(key);
    setFeedback((current) => {
      const next = new Map(current);
      if (localPending) next.set(key, { state: { status: "pending", message: "正在压缩上下文" }, runId });
      else next.delete(key);
      return next;
    });
  }, []);
  const fail = useCallback((requestProjectId: string, requestSessionId: string | undefined, error: string, cancelled: boolean, runId?: string): void => {
    const key = scopeKey(requestProjectId, requestSessionId);
    const activeEventRunId = eventRunIds.current.get(key);
    if (runId !== undefined && (requests.current.has(key) || activeEventRunId !== undefined) && activeEventRunId !== runId) return;
    const feedbackRunId = runId ?? activeEventRunId;
    setFeedback((current) => current.get(key)?.state.status === "cancelled" && current.get(key)?.runId === feedbackRunId && !cancelled
      ? current
      : new Map(current).set(key, { state: cancelled ? { status: "cancelled", message: "上下文压缩已取消" } : compactionFailure(error), runId: feedbackRunId }));
  }, []);
  const run = useCallback((requestProjectId: string, requestSessionId: string | undefined, command: string): Promise<void> => {
    const key = scopeKey(requestProjectId, requestSessionId);
    const pending = requests.current.get(key);
    if (pending) return pending;
    commands.current.set(key, command);
    eventRunIds.current.set(key, undefined);
    setFeedback((current) => new Map(current).set(key, { state: { status: "pending", message: "正在压缩上下文" }, runId: undefined }));
    const completion = Promise.resolve().then(async () => {
      try {
        const result = await execute(requestProjectId, requestSessionId, command);
        setFeedback((current) => {
          const next = new Map(current);
          if (result.compaction?.outcome === "unchanged") next.set(key, { state: { status: "unchanged", message: "本次未压缩，上下文保持原样。" }, runId: eventRunIds.current.get(key) });
          else next.delete(key);
          return next;
        });
      } catch (error) {
        const feedbackRunId = eventRunIds.current.get(key);
        setFeedback((current) => {
          // 只保护同一 run 的取消结果，旧批次中的取消不能掩盖新压缩的失败。
          if (current.get(key)?.state.status === "cancelled" && current.get(key)?.runId === feedbackRunId) return current;
          return new Map(current).set(key, { state: error instanceof Error && error.name === "AbortError"
            ? { status: "cancelled", message: "上下文压缩已取消" }
            : compactionFailure(error instanceof Error ? error.message : String(error)), runId: feedbackRunId });
        });
      } finally {
        requests.current.delete(key);
      }
    });
    requests.current.set(key, completion);
    return completion;
  }, [execute]);
  const key = projectId === undefined ? undefined : scopeKey(projectId, sessionId);
  const retry = useCallback(async (): Promise<void> => {
    if (projectId === undefined || key === undefined) return;
    await run(projectId, sessionId, commands.current.get(key) ?? "/compact");
  }, [key, projectId, run, sessionId]);
  const dismiss = useCallback((): void => {
    if (key === undefined || requests.current.has(key)) return;
    setFeedback((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, [key]);
  return { state: key === undefined ? undefined : feedback.get(key)?.state, run, start, fail, retry, dismiss };
}

function scopeKey(projectId: string, sessionId: string | undefined): string {
  return JSON.stringify([projectId, sessionId ?? null]);
}

function compactionFailure(error: string): CompactionCommandState {
  if (error.includes("Checkpoint persistence failed;")) {
    return { status: "failed", message: "压缩结果保存失败，请关闭并重新打开会话后重试。", retryable: false };
  }
  const kind = /Compaction summary rejected: (\w+)/u.exec(error)?.[1];
  const messages: Record<string, string> = {
    invalid_structure: "摘要结构不完整，原上下文已保留。",
    invalid_evidence: "摘要来源校验失败，原上下文已保留。",
    output_truncated: "摘要超出输出长度，原上下文已保留。",
    empty_checkpoint: "摘要没有可核验来源，原上下文已保留。",
    input_budget: "摘要模型的输入容量不足，请检查模型容量或减少待压缩内容。"
  };
  return { status: "failed", message: (kind && messages[kind]) || `上下文压缩失败：${error}` };
}
