/**
 * Desktop 后台运行面板。
 *
 * 面板只消费主进程提供的 projection，并通过统一 mutation 回调请求动作；它不读取
 * SQLite，也不持有 RuntimeHost。这样断线后刷新 projection 仍然是 authority 的结果。
 */
import { useEffect, useState } from "react";
import type { DesktopRuntimeMutation, DesktopRuntimeProjection } from "../../../protocol.js";
import { useClosingPresence } from "../useClosingPresence.js";
import { desktopWorktreeView } from "../worktreePresentation.js";
import { Icon } from "./Icon.js";

type RuntimeRecord = Record<string, unknown>;

interface RuntimePanelProps {
  open: boolean;
  onClose(): void;
  projection?: DesktopRuntimeProjection;
  selectedSessionId?: string;
  worktreeSession?: boolean;
  onError(error: unknown): void;
  onMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onRefresh(): Promise<void>;
}

export function RuntimePanel({ open, onClose, projection, selectedSessionId, worktreeSession = false, onError, onMutation, onRefresh }: RuntimePanelProps): React.JSX.Element | null {
  const [busyAction, setBusyAction] = useState<string>();
  const presence = useClosingPresence(open);

  useEffect(() => {
    if (!open) return;
    void onRefresh().catch(onError);
  }, [onError, onRefresh, open]);

  const runAction = async (
    key: string,
    operation: DesktopRuntimeMutation,
    payload: Record<string, unknown>,
    reportError: (error: unknown) => void = onError
  ): Promise<void> => {
    setBusyAction(key);
    try {
      await onMutation(operation, payload);
    } catch (error) {
      reportError(error);
    } finally {
      setBusyAction(undefined);
    }
  };

  const tasks = records(projection?.tasks);
  const goals = records(projection?.goals);
  const graphs = records(projection?.graphs);
  const capabilities = records(projection?.capabilities);
  const selectedWorktree = selectedSessionId === undefined
    ? undefined
    : projection?.worktrees.find((worktree) => worktree.sessionId === selectedSessionId);
  const worktree = worktreeSession && selectedSessionId !== undefined
    ? { sessionId: selectedSessionId, view: desktopWorktreeView(selectedWorktree) }
    : undefined;

  if (!presence.present) return null;

  return (
    <aside aria-label="后台运行" className="biny-runtime-panel" data-panel-phase={presence.phase}>
      <header className="biny-runtime-panel-header">
        <div>
          <strong>后台运行</strong>
          <span>任务与 Graph 由 Runtime authority 管理</span>
        </div>
        <div className="biny-runtime-panel-actions">
          <button aria-label="刷新后台运行状态" className="biny-runtime-panel-icon" disabled={busyAction !== undefined} onClick={() => void onRefresh().catch(onError)} title="刷新" type="button">
            <Icon name="refresh" size={14} />
          </button>
          <button aria-label="关闭后台运行面板" className="biny-runtime-panel-icon" onClick={onClose} title="关闭" type="button">
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      <div className="biny-runtime-summary" aria-label="后台运行统计">
        <span>任务 {tasks.length}</span>
        <span>Graph {graphs.length}</span>
      </div>

      {worktree ? (
        <WorktreeSection
          busyAction={busyAction}
          sessionId={worktree.sessionId}
          onAction={(operation, payload, key) => {
            const message = operation === "worktree.merge"
              ? "确认将当前隔离工作树合并到项目主分支吗？只有工作树和主工作区都干净时才会执行。"
              : worktree.view.deleteBranchOnRemove
                ? "确认清理已合并的隔离工作树和对应分支吗？"
                : "确认移除当前隔离工作树吗？未提交改动会被拦截，Git 分支会保留。";
            if (!window.confirm(message)) return;
            void runAction(key, operation, payload, (error) => onError(formatWorktreeError(error)));
          }}
          view={worktree.view}
        />
      ) : null}

      <RuntimeSection title="任务" empty="暂无持久任务">
        {tasks.map((task) => {
          const id = recordId(task, "taskRunId", "id");
          if (!id) return null;
          const status = recordText(task, "status") ?? "unknown";
          const action = taskAction(status);
          return (
            <RuntimeRow key={id} label={id} status={status}>
              {action ? (
                <button
                  className="biny-runtime-row-action"
                  disabled={busyAction !== undefined}
                  onClick={() => void runAction(`${action.operation}:${id}`, action.operation, { taskRunId: id })}
                  type="button"
                >
                  {busyAction === `${action.operation}:${id}` ? "处理中…" : action.label}
                </button>
              ) : null}
            </RuntimeRow>
          );
        })}
      </RuntimeSection>

      <RuntimeSection title="工作区目标 / Graph" empty="暂无工作区目标或 Graph">
        {goals.map((goal) => {
          const id = recordId(goal, "goalId", "id");
          if (!id) return null;
          return <RuntimeRow key={`goal:${id}`} label={`Goal · ${recordText(goal, "title") ?? id}`} status={recordText(goal, "status") ?? "unknown"} />;
        })}
        {graphs.map((graph) => {
          const id = recordId(graph, "graphId", "id");
          if (!id) return null;
          const status = recordText(graph, "status") ?? "unknown";
          const paused = status === "paused";
          return (
            <RuntimeRow key={`graph:${id}`} label={`Graph · ${id}`} status={status}>
              {paused || status === "running" ? (
                <button
                  className="biny-runtime-row-action"
                  disabled={busyAction !== undefined}
                  onClick={() => void runAction(`${paused ? "graph.resume" : "graph.pause"}:${id}`, paused ? "graph.resume" : "graph.pause", { graphId: id })}
                  type="button"
                >
                  {paused ? "恢复" : "暂停"}
                </button>
              ) : null}
            </RuntimeRow>
          );
        })}
      </RuntimeSection>

      <div className="biny-runtime-panel-footer">
        <span>Capability {capabilities.length}</span>
        <span>断线恢复从 SQLite authority 继续</span>
      </div>
    </aside>
  );
}

function WorktreeSection({
  busyAction,
  onAction,
  sessionId,
  view
}: {
  busyAction?: string;
  onAction(operation: Extract<DesktopRuntimeMutation, "worktree.merge" | "worktree.remove">, payload: Record<string, unknown>, key: string): void;
  sessionId: string;
  view: ReturnType<typeof desktopWorktreeView>;
}): React.JSX.Element {
  const mergeKey = "worktree.merge";
  const removeKey = "worktree.remove";
  return (
    <section className={`biny-runtime-section biny-runtime-worktree is-${view.tone}`}>
      <h3>当前会话的隔离工作树</h3>
      <div className="biny-runtime-worktree-status">
        <div className="biny-runtime-row-copy">
          <strong>{view.label}</strong>
          <small>{view.detail}</small>
        </div>
        <div className="biny-runtime-row-actions">
          {view.canMerge ? (
            <button
              className="biny-runtime-row-action"
              disabled={busyAction !== undefined}
              onClick={() => onAction("worktree.merge", { sessionId, strategy: "merge", deleteAfter: true }, mergeKey)}
              type="button"
            >
              {busyAction === mergeKey ? "处理中…" : "合并到项目"}
            </button>
          ) : null}
          {view.canRemove ? (
            <button
              className="biny-runtime-row-action"
              disabled={busyAction !== undefined}
              onClick={() => onAction("worktree.remove", { sessionId, deleteBranch: view.deleteBranchOnRemove }, removeKey)}
              type="button"
            >
              {busyAction === removeKey ? "处理中…" : "清理隔离环境"}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function RuntimeSection({ children, empty, title }: { children?: React.ReactNode; empty: string; title: string }): React.JSX.Element {
  const content = Array.isArray(children) ? children.filter(Boolean) : children;
  const isEmpty = Array.isArray(content) ? content.length === 0 : !content;
  return (
    <section className="biny-runtime-section">
      <h3>{title}</h3>
      {isEmpty ? <p className="biny-runtime-empty">{empty}</p> : content}
    </section>
  );
}

function RuntimeRow({ children, label, status }: { children?: React.ReactNode; label: string; status: string }): React.JSX.Element {
  return (
    <div className="biny-runtime-row">
      <div className="biny-runtime-row-copy">
        <span title={label}>{label}</span>
        <small>{status}</small>
      </div>
      <div className="biny-runtime-row-actions">{children}</div>
    </div>
  );
}

function taskAction(status: string): { label: string; operation: Extract<DesktopRuntimeMutation, "task.cancel"> } | undefined {
  if (status === "queued" || status === "created" || status === "running" || status === "verifying") return { label: "取消", operation: "task.cancel" };
  return undefined;
}

function records(value: unknown): RuntimeRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const tasks = value.tasks;
  return Array.isArray(tasks) ? tasks.filter(isRecord) : [];
}

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null;
}

function recordId(record: RuntimeRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function recordText(record: RuntimeRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatWorktreeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("uncommitted") || message.includes("未提交")) {
    return new Error("隔离工作树有未提交改动，已保留；请先手动处理后再试。");
  }
  if (message.includes("merge") || message.includes("合并")) {
    return new Error("隔离工作树合并未完成，工作树已保留；请手动处理冲突后再试。");
  }
  return new Error("隔离工作树操作未完成，已保留；请刷新状态后重试。");
}
