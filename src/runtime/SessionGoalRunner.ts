import { createHash } from "node:crypto";
import { readSessionEvents } from "../session/events.js";
import { replaySessionEvents } from "../session/replay.js";
import { resolveContinuationPlan } from "../session/recoveryPlan.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "./InteractiveAgentRuntime.js";
import type { RuntimeRunRecord } from "./RuntimeAuthority.js";
import { SessionGoalConflictError, type SessionGoalRecord, type SessionGoalStore } from "./SessionGoalStore.js";
import { runtimeIsBusy } from "./agentEvents.js";

export interface SessionGoalRunnerOptions {
  getCommands(): CommandRuntime;
  resolveRuntime(sessionId: string): Promise<InteractiveRuntimeHandle>;
  resolveCommands(sessionId: string): Promise<CommandRuntime>;
  sessionExists?(sessionId: string): Promise<boolean>;
  canStart(): boolean;
  admit<T>(sessionId: string, execute: () => Promise<T>): Promise<T>;
  onActivity?(): void;
  onChange?(): void;
}

/** 目标只决定何时提交新回合；权限、执行、事件和副作用恢复仍属于现有 Runtime。 */
export class SessionGoalRunner {
  private stopped = true;
  private scheduled: NodeJS.Immediate | undefined;
  private unsubscribe: (() => void) | undefined;
  private subscribedStore: SessionGoalStore | undefined;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();

  constructor(private readonly options: SessionGoalRunnerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.requestTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribedStore = undefined;
  }

  hasActiveWork(): boolean {
    return this.pending.size > 0 || this.scheduled !== undefined;
  }

  requestTick(): void {
    if (this.stopped || this.scheduled || !this.options.canStart()) return;
    const store = this.options.getCommands().sessionGoals;
    if (store !== this.subscribedStore) {
      this.unsubscribe?.();
      this.subscribedStore = store;
      this.unsubscribe = store?.subscribe(() => {
        this.options.onChange?.();
        this.requestTick();
      });
    }
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      if (this.stopped || !this.options.canStart()) return;
      for (const goal of this.options.getCommands().sessionGoals?.list({ status: "active" }) ?? []) {
        if (this.pending.has(goal.sessionId)) {
          this.rerun.add(goal.sessionId);
          continue;
        }
        const task = this.advance(goal).catch(error => {
          if (error instanceof SessionGoalConflictError || this.stopped || !this.options.canStart()) return;
          this.block(goal, error instanceof Error ? error.message : String(error));
        }).finally(() => {
          this.pending.delete(goal.sessionId);
          if (this.rerun.delete(goal.sessionId)) this.requestTick();
        });
        this.pending.set(goal.sessionId, task);
      }
    });
  }

  private current(goal: SessionGoalRecord): SessionGoalRecord | undefined {
    const current = this.options.getCommands().sessionGoals.get(goal.sessionId);
    return current?.goalId === goal.goalId && current.generation === goal.generation && current.status === "active" ? current : undefined;
  }

  private block(goal: SessionGoalRecord, reason: string): void {
    const current = this.current(goal);
    if (!current) return;
    this.options.getCommands().sessionGoals.block(goal.sessionId, current, {
      summary: reason, requirements: [{ requirement: "安全继续目标执行", evidence: reason }]
    });
    this.options.onChange?.();
  }

  private async advance(initial: SessionGoalRecord): Promise<void> {
    if (this.options.sessionExists && !await this.options.sessionExists(initial.sessionId)) {
      this.block(initial, "The goal session no longer exists.");
      return;
    }
    const [runtime, commands] = await Promise.all([
      this.options.resolveRuntime(initial.sessionId), this.options.resolveCommands(initial.sessionId)
    ]);
    if (this.stopped || !this.options.canStart() || runtimeIsBusy(runtime.getSnapshot())) return;
    const unavailable = commands.agent.sessionGoalUnavailableReason?.();
    if (unavailable) {
      this.block(initial, unavailable);
      return;
    }
    // idle 事件可先于 completion.finally；等待真正释放执行权及已有用户队列。
    await runtime.waitForIdle();
    if (this.stopped || !this.options.canStart() || !this.current(initial)) return;
    await this.options.admit(initial.sessionId, async () => {
      if (this.stopped || !this.options.canStart()) return;
      // 排队期间会话可能重建；恢复事实必须在同一会话准入队列内从当前实例读取。
      const [runtime, commands] = await Promise.all([
        this.options.resolveRuntime(initial.sessionId), this.options.resolveCommands(initial.sessionId)
      ]);
      if (this.stopped || !this.options.canStart() || runtimeIsBusy(runtime.getSnapshot()) || runtime.getSnapshot().queuedMessages?.length) return;
      const goal = this.current(initial);
      if (!goal) return;
      const unavailable = commands.agent.sessionGoalUnavailableReason?.();
      if (unavailable) {
        this.block(goal, unavailable);
        return;
      }
      const interrupted = await commands.agent.interruptedTurn();
      if (interrupted) {
        const events = await readSessionEvents(runtime.getSnapshot().info.sessionFile);
        const plan = resolveContinuationPlan(interrupted, replaySessionEvents(events, { sessionId: initial.sessionId }), Infinity);
        if (plan.action === "block" || plan.action === "require-user-input") {
          this.block(goal, plan.message);
          return;
        }
      }
      if (this.stopped || !this.options.canStart() || !this.current(goal) || runtimeIsBusy(runtime.getSnapshot()) || runtime.getSnapshot().queuedMessages?.length) return;
      const source = `goal:${goal.goalId}:${goal.generation}`;
      const row = commands.runtimeAuthority.databaseHandle().prepare(`
        SELECT run_id FROM agent_runs WHERE workspace_id = ? AND session_id = ? AND continuation_source = ? ORDER BY rowid DESC LIMIT 1
      `).get(commands.runtimeAuthority.workspaceId, goal.sessionId, source) as { run_id: string } | undefined;
      let previous = row ? commands.runtimeAuthority.getRun(row.run_id) : undefined;
      if (previous && previous.terminalStatus === undefined) {
        previous = await commands.runtimeAuthority.reconcileRunFromSession(previous.runId);
        if (previous?.terminalStatus === undefined) {
          this.block(goal, "The previous goal run has no confirmed terminal result; inspect recovery before resuming.");
          return;
        }
      }
      if (previous?.terminalStatus === "failed" || previous?.terminalStatus === "blocked" || previous?.terminalStatus === "unknown") {
        this.block(goal, terminalReason(previous));
        return;
      }
      if (previous?.terminalStatus === "cancelled" || previous?.terminalStatus === "aborted") {
        const current = this.current(goal);
        if (current) commands.sessionGoals.pause(goal.sessionId, current);
        return;
      }
      const payload = previous?.terminalPayload as { stopReason?: string; output?: string; error?: string } | undefined;
      if (payload?.stopReason === "provider_error") {
        if (!/没有输出|empty|no.*(?:response|output)/iu.test(payload.error ?? "") || this.emptyTurns(commands, source, goal.sessionId) >= 3) {
          this.block(goal, payload.error ?? "The provider could not continue the goal.");
          return;
        }
      }
      // 首次用户输入可留下一次续跑审计；自动回合的文字或状态查询不能无限触发下一轮。
      if (previous && payload?.stopReason !== "provider_error" && (previous.payload as { supervision?: boolean } | undefined)?.supervision === true) {
        const latestRun = commands.runtimeAuthority.databaseHandle().prepare(`
          SELECT run_id FROM agent_runs WHERE workspace_id = ? AND session_id = ? ORDER BY rowid DESC LIMIT 1
        `).get(commands.runtimeAuthority.workspaceId, goal.sessionId) as { run_id: string } | undefined;
        const workTool = commands.runtimeAuthority.databaseHandle().prepare(`
          SELECT 1 FROM runtime_events WHERE workspace_id = ? AND session_id = ? AND run_id = ?
            AND event_type = 'session.tool_call' AND json_extract(payload_json, '$.tool') NOT IN ('GoalGet', 'GoalUpdate')
            AND json_extract(payload_json, '$.auditOnly') IS NOT 1 LIMIT 1
        `).get(commands.runtimeAuthority.workspaceId, goal.sessionId, previous.runId);
        if (latestRun?.run_id === previous.runId && !workTool) {
          const current = this.current(goal);
          if (current) {
            commands.sessionGoals.pause(goal.sessionId, current, {
              summary: "自动续跑仅产生文字或目标状态操作，已暂停以避免空转。检查原因或补充要求后可恢复目标。",
              requirements: [{ requirement: "自动续跑需要工作工具活动", evidence: `回合 ${previous.runId} 已结束，未记录 GoalGet/GoalUpdate 之外的新工具调用。` }]
            });
            this.options.onChange?.();
          }
          return;
        }
      }
      const id = createHash("sha256").update(`${source}:${previous?.runId ?? "start"}`).digest("hex");
      const runId = `goal-${id}`;
      // 同一持久来源只认领同一个 child；重启不会重派已经准入的回合。
      if (previous) commands.runtimeAuthority.claimContinuation(previous.runId, runId);
      const latest = this.current(goal);
      if (!latest || this.stopped || !this.options.canStart() || runtimeIsBusy(runtime.getSnapshot()) || runtime.getSnapshot().queuedMessages?.length) return;
      // generation 在恢复时也会递增；用已准入的原始输入区分恢复和目标编辑，避免伪造或重复用户消息。
      const lastInput = commands.runtimeAuthority.databaseHandle().prepare(`
        SELECT json_extract(payload_json, '$.input') AS input FROM agent_runs
        WHERE workspace_id = ? AND session_id = ? AND continuation_source LIKE ?
          AND COALESCE(json_extract(payload_json, '$.input'), '') != ''
          AND COALESCE(json_extract(payload_json, '$.supervision'), 0) = 0
        ORDER BY rowid DESC LIMIT 1
      `).get(commands.runtimeAuthority.workspaceId, goal.sessionId, `goal:${goal.goalId}:%`) as { input: string } | undefined;
      const request = { runId, parentRunId: previous?.runId, continuationSource: source };
      const followup = previous || lastInput?.input === goal.objective;
      if (followup && !runtime.submitFollowupTurn) throw new Error("The session runtime does not support internal goal continuation.");
      const submitted = followup
        ? runtime.submitFollowupTurn!(request)
        : runtime.submitPrompt(goal.objective, [], request);
      this.options.onActivity?.();
      void submitted.completion.finally(() => this.requestTick()).catch(() => undefined);
    });
  }

  private emptyTurns(commands: CommandRuntime, source: string, sessionId: string): number {
    const rows = commands.runtimeAuthority.databaseHandle().prepare(`
      SELECT terminal_payload_json FROM agent_runs WHERE workspace_id = ? AND session_id = ? AND continuation_source = ? ORDER BY rowid DESC LIMIT 3
    `).all(commands.runtimeAuthority.workspaceId, sessionId, source) as Array<{ terminal_payload_json: string | null }>;
    let count = 0;
    for (const row of rows) {
      const payload = row.terminal_payload_json ? JSON.parse(row.terminal_payload_json) as { stopReason?: string; error?: string } : undefined;
      if (payload?.stopReason !== "provider_error" || !/没有输出|empty|no.*(?:response|output)/iu.test(payload.error ?? "")) break;
      count += 1;
    }
    return count;
  }
}

function terminalReason(run: RuntimeRunRecord): string {
  const payload = run.terminalPayload as { error?: string } | undefined;
  return payload?.error ?? `The previous goal run ended as ${run.terminalStatus}; resolve the blocker before resuming.`;
}
