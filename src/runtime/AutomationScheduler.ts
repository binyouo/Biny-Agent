/**
 * 本地 Host Automation 调度器。
 *
 * 调度器只负责 durable fire、唯一 claim 和失败策略；真正的 AgentRun 仍由 Host
 * admission 入口创建。这样 Host 重启时可以从 pending fire 继续，而不会用内存 timer
 * 作为“已经执行”的依据。
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEventAuthority } from "./RuntimeAuthority.js";
import type { InteractiveRuntimeHandle } from "./InteractiveAgentRuntime.js";

export type AutomationTriggerType = "heartbeat" | "cron" | "interval" | "once";
export type AutomationStatus = "active" | "paused" | "completed" | "failed" | "expired";

export interface AutomationSchedule {
  cron?: string;
  intervalMs?: number;
  at?: string;
  jitterMs?: number;
}

export interface AutomationExecutionTemplate {
  prompt: string;
  sessionId?: string;
}

export interface AutomationRecord {
  automationId: string;
  workspaceId: string;
  name: string;
  triggerType: AutomationTriggerType;
  schedule: AutomationSchedule;
  executionTemplate: AutomationExecutionTemplate;
  status: AutomationStatus;
  nextFireAt?: string;
  lastFireAt?: string;
  fireCount: number;
  consecutiveFailures: number;
  maxFires?: number;
  expiresAt?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationPendingFire {
  fireId: string;
  automationId: string;
  scheduledAt: string;
  claimToken?: string;
  claimedAt?: string;
  status: "pending" | "running" | "completed" | "failed" | "deferred" | "needs_approval";
  runId?: string;
  error?: string;
  createdAt: string;
}

export interface AutomationCreateInput {
  automationId?: string;
  name: string;
  triggerType: AutomationTriggerType;
  schedule: AutomationSchedule;
  executionTemplate: AutomationExecutionTemplate;
  maxFires?: number;
  expiresAt?: string;
}

/** Host 已经找到目标 session，但它正在运行；调度器应延后 fire，而不是把它记成失败。 */
export class AutomationTargetBusyError extends Error {
  readonly code = "automation_target_busy";

  constructor(readonly sessionId: string) {
    super(`Automation target session ${sessionId} is busy.`);
    this.name = "AutomationTargetBusyError";
  }
}

class AutomationClaimRejectedError extends Error {}

interface AutomationRow {
  automation_id: unknown;
  workspace_id: unknown;
  name: unknown;
  trigger_type: unknown;
  schedule_json: unknown;
  execution_template_json: unknown;
  status: unknown;
  next_fire_at: unknown;
  last_fire_at: unknown;
  fire_count: unknown;
  consecutive_failures: unknown;
  max_fires: unknown;
  expires_at: unknown;
  revision: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface PendingRow {
  fire_id: unknown;
  automation_id: unknown;
  scheduled_at: unknown;
  claim_token: unknown;
  claimed_at: unknown;
  status: unknown;
  run_id: unknown;
  error: unknown;
  created_at: unknown;
}

export class AutomationStore {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly authority: RuntimeEventAuthority
  ) {}

  static async open(persistenceRoot: string, authority: RuntimeEventAuthority): Promise<AutomationStore> {
    void persistenceRoot;
    return new AutomationStore(authority.databaseHandle(), authority);
  }

  create(input: AutomationCreateInput): AutomationRecord {
    this.assertOpen();
    const normalized = normalizeAutomationInput(input);
    const automationId = normalized.automationId ?? randomUUID();
    const existing = this.get(automationId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const nextFireAt = initialFireAt(normalized.triggerType, normalized.schedule, now);
    return this.authority.runEventTransaction({
      eventId: "automation:" + automationId + ":created",
      sessionId: normalized.executionTemplate.sessionId ?? "automation:" + automationId,
      invocationId: automationId,
      runId: "automation:" + automationId,
      turnId: "automation:" + automationId,
      eventType: "automation.created",
      payload: normalized,
      createdAt: now
    }, () => {
      this.database.prepare(
        "INSERT INTO automations (automation_id, workspace_id, name, trigger_type, schedule_json, execution_template_json, status, next_fire_at, fire_count, consecutive_failures, max_fires, expires_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, 0, ?, ?, 0, ?, ?)"
      ).run(
        automationId,
        this.authority.workspaceId,
        normalized.name,
        normalized.triggerType,
        JSON.stringify(normalized.schedule),
        JSON.stringify(normalized.executionTemplate),
        nextFireAt ?? null,
        normalized.maxFires ?? null,
        normalized.expiresAt ?? null,
        now,
        now
      );
      return this.require(automationId);
    });
  }

  get(automationId: string): AutomationRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT automation_id, workspace_id, name, trigger_type, schedule_json, execution_template_json, status, next_fire_at, last_fire_at, fire_count, consecutive_failures, max_fires, expires_at, revision, created_at, updated_at FROM automations WHERE automation_id = ? AND workspace_id = ?"
    ).get(automationId, this.authority.workspaceId) as unknown as AutomationRow | undefined;
    return row ? toAutomation(row) : undefined;
  }

  list(): AutomationRecord[] {
    this.assertOpen();
    const rows = this.database.prepare(
      "SELECT automation_id, workspace_id, name, trigger_type, schedule_json, execution_template_json, status, next_fire_at, last_fire_at, fire_count, consecutive_failures, max_fires, expires_at, revision, created_at, updated_at FROM automations WHERE workspace_id = ? ORDER BY created_at ASC"
    ).all(this.authority.workspaceId) as unknown as AutomationRow[];
    return rows.map(toAutomation);
  }

  pause(automationId: string): AutomationRecord {
    return this.updateStatus(automationId, "paused");
  }

  resume(automationId: string): AutomationRecord {
    const automation = this.require(automationId);
    const now = new Date().toISOString();
    const next = automation.nextFireAt ?? initialFireAt(automation.triggerType, automation.schedule, now);
    if (automation.status === "active") return automation;
    return this.withAutomationEvent(automation, "automation.status", { status: "active" }, now, () => {
      this.database.prepare("UPDATE automations SET status = 'active', next_fire_at = ?, consecutive_failures = 0, revision = revision + 1, updated_at = ? WHERE automation_id = ?").run(next ?? null, now, automationId);
      return this.require(automationId);
    });
  }

  delete(automationId: string): void {
    const automation = this.require(automationId);
    const now = new Date().toISOString();
    this.withAutomationEvent(automation, "automation.deleted", { automationId }, now, () => {
      this.database.prepare("DELETE FROM automations WHERE automation_id = ? AND workspace_id = ?").run(automationId, this.authority.workspaceId);
    });
  }

  forceFire(automationId: string, scheduledAt = new Date().toISOString()): AutomationPendingFire {
    const automation = this.require(automationId);
    if (automation.status === "expired" || (automation.expiresAt !== undefined && Date.parse(automation.expiresAt) <= Date.now())) {
      throw new Error(`Automation ${automationId} has expired.`);
    }
    if (automation.status === "completed" && automation.maxFires !== undefined && automation.fireCount >= automation.maxFires) {
      throw new Error(`Automation ${automationId} reached its maximum fire count.`);
    }
    const fireId = randomUUID();
    const now = new Date().toISOString();
    this.withAutomationEvent(automation, "automation.fire.pending", { fireId, scheduledAt }, now, () => {
      this.database.prepare("INSERT INTO automation_pending_fires (fire_id, automation_id, scheduled_at, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(fireId, automation.automationId, scheduledAt, now);
    });
    return this.requireFire(fireId);
  }

  claimDue(now = new Date(), limit = 32): AutomationPendingFire[] {
    this.assertOpen();
    const fires: AutomationPendingFire[] = [];
    const recoverable = this.database.prepare(
      "SELECT fire_id, automation_id, scheduled_at, claim_token, claimed_at, status, run_id, error, created_at FROM automation_pending_fires WHERE status IN ('pending', 'deferred') AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT ?"
    ).all(now.toISOString(), limit) as unknown as PendingRow[];
    for (const row of recoverable) {
      const fireId = stringValue(row.fire_id);
      const automation = this.require(stringValue(row.automation_id));
      if (automation.status !== "active") continue;
      const status = pendingStatus(row.status);
      if (status === "deferred") {
        const createdAt = new Date().toISOString();
        this.withAutomationEvent(automation, "automation.fire.requeued", { fireId, scheduledAt: row.scheduled_at }, createdAt, () => {
          this.database.prepare("UPDATE automation_pending_fires SET status = 'pending', claim_token = NULL, claimed_at = NULL, error = NULL WHERE fire_id = ? AND status = 'deferred'").run(fireId);
        });
      }
      const recovered = this.database.prepare("SELECT fire_id, automation_id, scheduled_at, claim_token, claimed_at, status, run_id, error, created_at FROM automation_pending_fires WHERE fire_id = ? AND status = 'pending'").get(fireId) as unknown as PendingRow | undefined;
      if (recovered) fires.push(toFire(recovered));
    }
    if (fires.length >= limit) return fires;
    const candidates = this.database.prepare(
      "SELECT automation_id, next_fire_at FROM automations WHERE workspace_id = ? AND status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC LIMIT ?"
    ).all(this.authority.workspaceId, now.toISOString(), limit - fires.length) as Array<Record<string, unknown>>;
    for (const candidate of candidates) {
      const automationId = stringValue(candidate.automation_id);
      const automation = this.require(automationId);
      if (automation.expiresAt !== undefined && Date.parse(automation.expiresAt) <= now.getTime()) {
        this.updateStatus(automationId, "expired");
        continue;
      }
      if (automation.maxFires !== undefined && automation.fireCount >= automation.maxFires) {
        this.updateStatus(automationId, "completed");
        continue;
      }
      const scheduledAt = stringValue(candidate.next_fire_at);
      const fireId = randomUUID();
      const createdAt = new Date().toISOString();
      try {
        this.withAutomationEvent(automation, "automation.fire.pending", { fireId, scheduledAt }, createdAt, () => {
          this.database.prepare("INSERT OR IGNORE INTO automation_pending_fires (fire_id, automation_id, scheduled_at, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(fireId, automationId, scheduledAt, createdAt);
          const next = advanceFireAt(automation, new Date(scheduledAt));
          this.database.prepare("UPDATE automations SET next_fire_at = ?, revision = revision + 1, updated_at = ? WHERE automation_id = ?").run(next ?? null, createdAt, automationId);
        });
      } catch (error) {
        // 单个 automation 推进失败（如只在闰日命中的 cron 触发后 366 天内没有下一次）不能
        // 中断整轮 claim，否则它按 next_fire_at 永远排在最前，让后面的 automation 全部停摆。
        this.updateStatus(automationId, "paused", error instanceof Error ? error.message : String(error));
        continue;
      }
      const fire = this.database.prepare("SELECT fire_id, automation_id, scheduled_at, claim_token, claimed_at, status, run_id, error, created_at FROM automation_pending_fires WHERE automation_id = ? AND scheduled_at = ?").get(automationId, scheduledAt) as unknown as PendingRow | undefined;
      if (fire) fires.push(toFire(fire));
    }
    return fires;
  }

  claimFire(fireId: string, claimToken = randomUUID()): AutomationPendingFire | undefined {
    this.assertOpen();
    const now = new Date().toISOString();
    const pending = this.requireFire(fireId);
    if (pending.status !== "pending" && pending.status !== "deferred") return undefined;
    const automation = this.require(pending.automationId);
    try {
      this.withAutomationEvent(automation, "automation.fire.claimed", { fireId, claimToken }, now, () => {
        const result = this.database.prepare(`
          UPDATE automation_pending_fires
          SET status = 'running', claim_token = ?, claimed_at = ?
          WHERE fire_id = ?
            AND status IN ('pending', 'deferred')
            AND EXISTS (
              SELECT 1 FROM automations
              WHERE automation_id = automation_pending_fires.automation_id
                AND workspace_id = ?
                AND status = 'active'
                AND (max_fires IS NULL OR fire_count < max_fires)
            )
        `).run(claimToken, now, fireId, this.authority.workspaceId);
        // 抛错会回滚同一事务里刚写入的 claimed 事件，避免留下并未取得执行权的假事实。
        if (result.changes === 0) throw new AutomationClaimRejectedError();
      });
    } catch (error) {
      if (error instanceof AutomationClaimRejectedError) return undefined;
      throw error;
    }
    return this.requireFire(fireId);
  }

  completeFire(fireId: string, runId: string): AutomationPendingFire {
    const fire = this.requireFire(fireId);
    if (fire.status === "completed") return fire;
    if (fire.status !== "running") throw new Error(`Automation fire ${fireId} is not running.`);
    const automation = this.require(fire.automationId);
    const now = new Date().toISOString();
    return this.withAutomationEvent(automation, "automation.fire.completed", { fireId, runId }, now, () => {
      this.database.prepare("UPDATE automation_pending_fires SET status = 'completed', run_id = ? WHERE fire_id = ?").run(runId, fireId);
      this.database.prepare("UPDATE automations SET status = CASE WHEN max_fires IS NOT NULL AND fire_count + 1 >= max_fires THEN 'completed' ELSE status END, fire_count = fire_count + 1, consecutive_failures = 0, last_fire_at = ?, updated_at = ?, revision = revision + 1 WHERE automation_id = ?").run(now, now, automation.automationId);
      return this.requireFire(fireId);
    });
  }

  failFire(fireId: string, error: string, pauseAfter = 3): AutomationPendingFire {
    const fire = this.requireFire(fireId);
    if (fire.status === "failed") return fire;
    if (fire.status !== "running") throw new Error(`Automation fire ${fireId} is not running.`);
    const automation = this.require(fire.automationId);
    const now = new Date().toISOString();
    const failures = automation.consecutiveFailures + 1;
    const status = failures >= pauseAfter ? "failed" : "active";
    return this.withAutomationEvent(automation, "automation.fire.failed", { fireId, error, failures }, now, () => {
      this.database.prepare("UPDATE automation_pending_fires SET status = 'failed', error = ? WHERE fire_id = ?").run(error, fireId);
      // 用户可能在本次执行期间手动暂停；失败回调只推动仍为 active 的任务，不能覆盖人工或终态状态。
      this.database.prepare("UPDATE automations SET status = CASE WHEN status = 'active' THEN ? ELSE status END, consecutive_failures = ?, last_fire_at = ?, updated_at = ?, revision = revision + 1 WHERE automation_id = ?").run(status, failures, now, now, automation.automationId);
      return this.requireFire(fireId);
    });
  }

  deferFire(fireId: string, at: Date, error?: string): AutomationPendingFire {
    const fire = this.requireFire(fireId);
    if (fire.status === "deferred") return fire;
    if (fire.status !== "running") throw new Error(`Automation fire ${fireId} is not running.`);
    const automation = this.require(fire.automationId);
    const now = new Date().toISOString();
    return this.withAutomationEvent(automation, "automation.fire.deferred", { fireId, at: at.toISOString(), error }, now, () => {
      this.database.prepare("UPDATE automation_pending_fires SET status = 'deferred', scheduled_at = ?, claim_token = NULL, claimed_at = NULL, error = ? WHERE fire_id = ?").run(at.toISOString(), error ?? null, fireId);
      return this.requireFire(fireId);
    });
  }

  bindFireRun(fireId: string, runId: string): AutomationPendingFire {
    const fire = this.requireFire(fireId);
    if (fire.status !== "running") throw new Error(`Automation fire ${fireId} is not running.`);
    if (fire.runId === runId) return fire;
    const automation = this.require(fire.automationId);
    const now = new Date().toISOString();
    return this.withAutomationEvent(automation, "automation.fire.run_bound", { fireId, runId }, now, () => {
      this.database.prepare("UPDATE automation_pending_fires SET run_id = ? WHERE fire_id = ? AND status = 'running'").run(runId, fireId);
      return this.requireFire(fireId);
    });
  }

  /** Host 新 owner 启动时回收上一个 owner 的在途 fire；无法证明结果时停在 needs_approval。 */
  recoverInFlight(): void {
    const rows = this.database.prepare("SELECT fire_id, automation_id, scheduled_at, claim_token, claimed_at, status, run_id, error, created_at FROM automation_pending_fires WHERE status = 'running'").all() as unknown as PendingRow[];
    for (const row of rows) {
      const fireId = stringValue(row.fire_id);
      const runId = optionalString(row.run_id);
      const run = runId === undefined ? undefined : this.authority.getRun(runId);
      if (runId !== undefined && run?.terminalStatus === "completed") {
        this.completeFire(fireId, runId);
        continue;
      }
      if (run?.terminalStatus !== undefined) {
        this.failFire(fireId, run.terminalStatus);
        continue;
      }
      const automation = this.require(stringValue(row.automation_id));
      const now = new Date().toISOString();
      this.withAutomationEvent(automation, "automation.fire.needs_approval", { fireId, runId, reason: "Host restarted before the fire outcome was proven." }, now, () => {
        this.database.prepare("UPDATE automation_pending_fires SET status = 'needs_approval', error = ? WHERE fire_id = ? AND status = 'running'").run("Host restarted before the fire outcome was proven; verify side effects before retrying.", fireId);
      });
    }
  }

  listPending(automationId?: string): AutomationPendingFire[] {
    const query = automationId === undefined
      ? "SELECT fire_id, automation_id, scheduled_at, claim_token, claimed_at, status, run_id, error, created_at FROM automation_pending_fires ORDER BY scheduled_at ASC"
      : "SELECT fire_id, automation_id, scheduled_at, claim_token, claimed_at, status, run_id, error, created_at FROM automation_pending_fires WHERE automation_id = ? ORDER BY scheduled_at ASC";
    const rows = this.database.prepare(query).all(...(automationId === undefined ? [] : [automationId])) as unknown as PendingRow[];
    return rows.map(toFire);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }

  private withAutomationEvent<T>(automation: AutomationRecord, eventType: string, payload: unknown, createdAt: string, execute: () => T): T {
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
    return this.authority.runEventTransaction({
      eventId: "automation:" + automation.automationId + ":revision:" + String(automation.revision + 1) + ":" + eventType + ":" + payloadHash,
      sessionId: automation.executionTemplate.sessionId ?? "automation:" + automation.automationId,
      invocationId: automation.automationId,
      runId: "automation:" + automation.automationId,
      turnId: "automation:" + automation.automationId,
      eventType,
      payload,
      createdAt
    }, execute);
  }

  private updateStatus(automationId: string, status: AutomationStatus, error?: string): AutomationRecord {
    const automation = this.require(automationId);
    if (automation.status === status) return automation;
    const now = new Date().toISOString();
    // error 只作为事件 payload 的诊断信息；undefined 时序列化结果与原先完全一致。
    return this.withAutomationEvent(automation, "automation.status", { status, error }, now, () => {
      this.database.prepare("UPDATE automations SET status = ?, revision = revision + 1, updated_at = ? WHERE automation_id = ?").run(status, now, automationId);
      return this.require(automationId);
    });
  }

  private require(automationId: string): AutomationRecord {
    const automation = this.get(automationId);
    if (!automation) throw new Error("Automation " + automationId + " does not exist.");
    return automation;
  }

  private requireFire(fireId: string): AutomationPendingFire {
    const row = this.database.prepare("SELECT fire_id, automation_id, scheduled_at, claim_token, claimed_at, status, run_id, error, created_at FROM automation_pending_fires WHERE fire_id = ?").get(fireId) as unknown as PendingRow | undefined;
    if (!row) throw new Error("Automation fire " + fireId + " does not exist.");
    return toFire(row);
  }

  private transaction<T>(execute: () => T): T {
    return this.authority.runTransaction(execute);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Automation store is closed.");
  }
}

export interface AutomationSchedulerOptions {
  getRuntime: () => InteractiveRuntimeHandle;
  /** 重建 runtime 后数据库连接会替换；scheduler 必须取当前 authority projection。 */
  getStore?: () => AutomationStore;
  store?: AutomationStore;
  /** 为某个 fire 取得专属 session runtime；不传目标时创建新的自动化 session。 */
  createFreshRuntime?: (sessionId?: string) => Promise<InteractiveRuntimeHandle>;
  onRuntimeReplaced?: (runtime: InteractiveRuntimeHandle) => void;
  canStartRun?: () => boolean;
  tickMs?: number;
}

export class AutomationScheduler {
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private fireTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.tickMs = options.tickMs ?? 1_000;
    if (!Number.isSafeInteger(this.tickMs) || this.tickMs < 100) throw new Error("Automation scheduler tickMs must be at least 100ms.");
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.store().recoverInFlight();
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.tickMs);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    const fires = this.store().claimDue(new Date());
    await Promise.all(fires.map((fire) => this.enqueueFire(fire)));
  }

  async runNow(automationId: string): Promise<AutomationPendingFire> {
    const fire = this.store().forceFire(automationId);
    await this.enqueueFire(fire);
    return this.store().listPending(automationId).find((candidate) => candidate.fireId === fire.fireId) ?? fire;
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async executeFire(fire: AutomationPendingFire): Promise<void> {
    let store = this.store();
    const claimed = store.claimFire(fire.fireId);
    if (!claimed) return;
    const automation = store.get(claimed.automationId);
    if (!automation) return;
    const targetSessionId = automation.executionTemplate.sessionId;
    const usesDedicatedRuntime = this.options.createFreshRuntime !== undefined
      && (automation.triggerType !== "heartbeat" || targetSessionId !== undefined);
    if (this.options.canStartRun && !this.options.canStartRun()) {
      store.deferFire(claimed.fireId, new Date(Date.now() + deferDelay(automation)), "Runtime Host reached its concurrent run limit; fire deferred.");
      return;
    }
    const current = this.options.getRuntime();
    // 非 heartbeat fire 会创建独立 runtime；primary 忙不应挡住它，否则自动化仍会
    // 退化成“所有任务都排在交互 session 后面”的单 runtime 语义。
    if (!usesDedicatedRuntime && current.getSnapshot().state.kind !== "idle") {
      store.deferFire(claimed.fireId, new Date(Date.now() + deferDelay(automation)), "Runtime Host is busy; fire deferred.");
      return;
    }
    try {
      let target = current;
      if (usesDedicatedRuntime && this.options.createFreshRuntime) {
        // 目标 session 由模板决定；没有目标的非 heartbeat fire 使用独立的新 session，
        // 绝不能复用当前 UI session。heartbeat 沿用 primary，避免每次心跳都创建新会话。
        target = await this.options.createFreshRuntime(targetSessionId);
        this.options.onRuntimeReplaced?.(target);
        // createFreshRuntime 可能已经替换并关闭了旧 authority；后续 fire 状态必须
        // 写入当前 store，否则会在已关闭的 DatabaseSync 上失败，留下 running fire。
        store = this.store();
      }
      if (target.getSnapshot().state.kind !== "idle") {
        if (targetSessionId !== undefined) throw new AutomationTargetBusyError(targetSessionId);
        store.deferFire(claimed.fireId, new Date(Date.now() + deferDelay(automation)), "Runtime Host is busy; fire deferred.");
        return;
      }
      if (targetSessionId !== undefined && target.getSnapshot().info.sessionId !== targetSessionId) {
        // 没有 Host registry 的同进程 fallback 仍允许复用单 runtime；正常 Host 会在
        // createFreshRuntime(sessionId) 中直接创建/取得目标条目，不会在这里改写 session。
        await target.resumeSession(targetSessionId);
      }
      if (target.getSnapshot().info.planning) {
        store.deferFire(claimed.fireId, new Date(Date.now() + deferDelay(automation)), "Target session is in planning mode; fire deferred.");
        return;
      }
      const submitted = target.submitPrompt(
        automation.executionTemplate.prompt,
        [],
        { runId: randomUUID(), continuationSource: "automation:" + automation.automationId }
      );
      store.bindFireRun(claimed.fireId, submitted.runId);
      const outcome = await submitted.completion;
      if (outcome.status === "completed") store.completeFire(claimed.fireId, submitted.runId);
      else store.failFire(claimed.fireId, outcome.error ?? "Automation run ended as " + outcome.status + ".");
    } catch (error) {
      const currentStore = this.store();
      if (error instanceof AutomationTargetBusyError) {
        currentStore.deferFire(claimed.fireId, new Date(Date.now() + deferDelay(automation)), error.message);
        return;
      }
      currentStore.failFire(claimed.fireId, error instanceof Error ? error.message : String(error));
    }
  }

  private enqueueFire(fire: AutomationPendingFire): Promise<void> {
    const execution = this.fireTail.then(() => this.executeFire(fire), () => this.executeFire(fire));
    this.fireTail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  private store(): AutomationStore {
    const store = this.options.getStore?.() ?? this.options.store;
    if (!store) throw new Error("Automation store is unavailable.");
    return store;
  }
}

function normalizeAutomationInput(input: AutomationCreateInput): AutomationCreateInput {
  if (!input.name.trim()) throw new Error("Automation name cannot be empty.");
  const executionTemplate = normalizeExecutionTemplate(input.executionTemplate);
  if (input.maxFires !== undefined && (!Number.isSafeInteger(input.maxFires) || input.maxFires < 1)) throw new Error("Automation maxFires must be a positive integer.");
  if (input.triggerType === "cron" && !input.schedule.cron?.trim()) throw new Error("Cron automation requires a cron expression.");
  if ((input.triggerType === "interval" || input.triggerType === "heartbeat") && (!Number.isSafeInteger(input.schedule.intervalMs) || (input.schedule.intervalMs ?? 0) < 100)) throw new Error("Interval automation requires intervalMs >= 100.");
  if (input.triggerType === "once" && input.schedule.at !== undefined && Number.isNaN(Date.parse(input.schedule.at))) throw new Error("Once automation at must be an ISO timestamp.");
  if (input.schedule.jitterMs !== undefined && (!Number.isSafeInteger(input.schedule.jitterMs) || input.schedule.jitterMs < 0)) throw new Error("Automation jitterMs must be a non-negative integer.");
  return { ...input, name: input.name.trim(), executionTemplate };
}

function normalizeExecutionTemplate(value: unknown): AutomationExecutionTemplate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Automation execution template must be an object.");
  }
  const template = value as Record<string, unknown>;
  const unexpected = Object.keys(template).find((key) => key !== "prompt" && key !== "sessionId");
  if (unexpected !== undefined) {
    throw new Error(`Automation execution template contains unsupported field: ${unexpected}.`);
  }
  if (typeof template.prompt !== "string" || !template.prompt.trim()) {
    throw new Error("Automation prompt cannot be empty.");
  }
  const sessionId = optionalString(template.sessionId);
  return { prompt: template.prompt, sessionId };
}

function initialFireAt(type: AutomationTriggerType, schedule: AutomationSchedule, now: string): string | undefined {
  if (type === "once") return schedule.at ?? now;
  if (type === "interval" || type === "heartbeat") return new Date(Date.parse(now) + (schedule.intervalMs ?? 60_000)).toISOString();
  return nextCron(schedule.cron ?? "* * * * *", new Date(now)).toISOString();
}

function advanceFireAt(automation: AutomationRecord, scheduledAt: Date): string | undefined {
  if (automation.triggerType === "once") return undefined;
  if (automation.triggerType === "interval" || automation.triggerType === "heartbeat") {
    return new Date(scheduledAt.getTime() + (automation.schedule.intervalMs ?? 60_000) + jitter(automation.schedule.jitterMs)).toISOString();
  }
  return nextCron(automation.schedule.cron ?? "* * * * *", scheduledAt).toISOString();
}

function nextCron(expression: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new Error("Cron expression must have five fields.");
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    const minute = start.getMinutes();
    const hour = start.getHours();
    const day = start.getDate();
    const month = start.getMonth() + 1;
    const weekday = start.getDay();
    if (
      cronField(fields[0] ?? "*", minute, 0, 59)
      && cronField(fields[1] ?? "*", hour, 0, 23)
      && cronField(fields[2] ?? "*", day, 1, 31)
      && cronField(fields[3] ?? "*", month, 1, 12)
      && cronField(fields[4] ?? "*", weekday, 0, 6)
    ) return start;
    start.setMinutes(start.getMinutes() + 1);
  }
  throw new Error("Cron expression has no occurrence within one year.");
}

function cronField(field: string, value: number, minimum: number, maximum: number): boolean {
  return field.split(",").some((part) => {
    const parts = part.split("/");
    const range = parts[0] ?? "*";
    const step = parts[1] === undefined ? 1 : Number(parts[1]);
    if (!Number.isSafeInteger(step) || step < 1) return false;
    if (range === "*") return (value - minimum) % step === 0;
    if (range.includes("-")) {
      const rangeParts = range.split("-");
      const start = Number(rangeParts[0]);
      const end = Number(rangeParts[1]);
      return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end && (value - start) % step === 0;
    }
    return Number(range) === value;
  }) && value >= minimum && value <= maximum;
}

function jitter(maximum = 0): number {
  return maximum > 0 ? Math.floor(Math.random() * (maximum + 1)) : 0;
}

function deferDelay(automation: AutomationRecord): number {
  return Math.max(1_000, Math.min(automation.schedule.intervalMs ?? 5_000, 60_000));
}

function toAutomation(row: AutomationRow): AutomationRecord {
  return {
    automationId: stringValue(row.automation_id),
    workspaceId: stringValue(row.workspace_id),
    name: stringValue(row.name),
    triggerType: triggerType(row.trigger_type),
    schedule: parseJson(row.schedule_json) as AutomationSchedule,
    executionTemplate: normalizeExecutionTemplate(parseJson(row.execution_template_json)),
    status: automationStatus(row.status),
    nextFireAt: optionalString(row.next_fire_at),
    lastFireAt: optionalString(row.last_fire_at),
    fireCount: integerValue(row.fire_count),
    consecutiveFailures: integerValue(row.consecutive_failures),
    maxFires: row.max_fires === null ? undefined : integerValue(row.max_fires),
    expiresAt: optionalString(row.expires_at),
    revision: integerValue(row.revision),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function pendingStatus(value: unknown): AutomationPendingFire["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "deferred" || value === "needs_approval") return value;
  throw new Error("Invalid automation pending fire status: " + String(value));
}

function toFire(row: PendingRow): AutomationPendingFire {
  return {
    fireId: stringValue(row.fire_id),
    automationId: stringValue(row.automation_id),
    scheduledAt: stringValue(row.scheduled_at),
    claimToken: optionalString(row.claim_token),
    claimedAt: optionalString(row.claimed_at),
    status: fireStatus(row.status),
    runId: optionalString(row.run_id),
    error: optionalString(row.error),
    createdAt: stringValue(row.created_at)
  };
}

function triggerType(value: unknown): AutomationTriggerType {
  if (value === "heartbeat" || value === "cron" || value === "interval" || value === "once") return value;
  throw new Error("Invalid automation trigger type: " + String(value));
}

function automationStatus(value: unknown): AutomationStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "failed" || value === "expired") return value;
  throw new Error("Invalid automation status: " + String(value));
}

function fireStatus(value: unknown): AutomationPendingFire["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "deferred" || value === "needs_approval") return value;
  throw new Error("Invalid automation fire status: " + String(value));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid automation storage string.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function integerValue(value: unknown): number {
  const candidate = typeof value === "bigint" ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) throw new Error("Invalid automation storage integer.");
  return candidate;
}
