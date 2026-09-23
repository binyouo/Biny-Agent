/**
 * Runtime Host 的 session → runtime 注册表。
 *
 * Host 仍然是 workspace 级单例，但 AgentSession 是 session 级资源。注册表负责
 * 保证同一个 session 不会并发创建两份 runtime，并把每个 runtime 的事件交回 Host
 * 做全局 sequence 和按 session 扇出。
 */
import { randomUUID } from "node:crypto";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../agentEvents.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import { runtimeIsBusy } from "../agentEvents.js";
import type { RuntimeHostFactory, RuntimeHostFactoryOptions } from "./types.js";

export interface ManagedSessionRuntime {
  sessionId: string;
  runtime: InteractiveRuntimeHandle;
  commands: CommandRuntime;
  readonly primary: boolean;
  lastActiveAt: number;
  unsubscribe(): void;
}

export interface SessionRuntimeRegistryOptions {
  readonly createRuntime?: RuntimeHostFactory;
  readonly sessionRuntimeCacheTarget?: number;
  /** 有外部 writer claim 的 session 仍是用户正在使用的资源，不能被 LRU 静默驱逐。 */
  canEvict?(entry: ManagedSessionRuntime): boolean;
  onUpdate(update: AgentRuntimeUpdate, managed: ManagedSessionRuntime): void;
}

export class SessionRuntimeRegistry {
  private readonly entries = new Map<string, ManagedSessionRuntime>();
  private readonly initializations = new Map<string, Promise<ManagedSessionRuntime>>();
  /** 将正在创建的会话计入缓存需求，提前尝试回收空闲实例；不作为准入上限。 */
  private readonly reservations = new Set<string>();
  private readonly sessionRuntimeCacheTarget: number;
  private readonly primaryEntry: ManagedSessionRuntime;
  private closed = false;

  constructor(
    initial: { runtime: InteractiveRuntimeHandle; commands: CommandRuntime },
    private readonly options: SessionRuntimeRegistryOptions
  ) {
    this.sessionRuntimeCacheTarget = options.sessionRuntimeCacheTarget ?? 8;
    if (!Number.isSafeInteger(this.sessionRuntimeCacheTarget) || this.sessionRuntimeCacheTarget < 1) {
      throw new Error("sessionRuntimeCacheTarget must be a positive safe integer.");
    }
    this.primaryEntry = this.attach(initial, true);
    this.entries.set(this.primaryEntry.sessionId, this.primaryEntry);
  }

  primary(): ManagedSessionRuntime {
    return this.primaryEntry;
  }

  get(sessionId: string): ManagedSessionRuntime | undefined {
    return this.entries.get(sessionId);
  }

  list(): ManagedSessionRuntime[] {
    return [...this.entries.values()];
  }

  snapshots(): InteractiveRuntimeSnapshot[] {
    return this.list().map((entry) => entry.runtime.getSnapshot());
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.lastActiveAt = Date.now();
  }

  async ensure(sessionId: string, factoryOptions?: RuntimeHostFactoryOptions): Promise<ManagedSessionRuntime> {
    if (this.closed) throw new Error("Runtime Host session registry is closed.");
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    const pending = this.initializations.get(sessionId);
    if (pending) return await pending;

    this.reservations.add(sessionId);
    const initialization = this.create(sessionId, factoryOptions);
    this.initializations.set(sessionId, initialization);
    try {
      return await initialization;
    } finally {
      if (this.initializations.get(sessionId) === initialization) this.initializations.delete(sessionId);
      this.reservations.delete(sessionId);
    }
  }

  /** 创建一个新 session；显式 sessionId 由调用方传入以便先建立 worktree。 */
  async createFresh(factoryOptions?: RuntimeHostFactoryOptions): Promise<ManagedSessionRuntime> {
    if (this.closed) throw new Error("Runtime Host session registry is closed.");
    const sessionId = factoryOptions?.sessionId ?? randomUUID();
    if (this.entries.has(sessionId)) return this.entries.get(sessionId)!;
    return await this.ensure(sessionId, { ...factoryOptions, sessionId, fresh: true });
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.primary) throw new Error("The primary Runtime Host session cannot be closed.");
    if (runtimeIsBusy(entry.runtime.getSnapshot())) throw new Error("Cannot close a busy session runtime.");
    this.entries.delete(sessionId);
    entry.unsubscribe();
    await entry.runtime.close();
  }

  /** 替换一个已存在的 runtime；replacement 必须继续绑定同一个 session。 */
  async replace(sessionId: string, host: { runtime: InteractiveRuntimeHandle; commands: CommandRuntime }): Promise<ManagedSessionRuntime> {
    if (this.closed) throw new Error("Runtime Host session registry is closed.");
    const actualSessionId = host.runtime.getSnapshot().info.sessionId;
    const current = this.entries.get(sessionId);
    // 新聊天由 createFresh() 负责；replacement 只能刷新同一 session 的资源，避免
    // 注册表把一个 runtime 的 session 改名后接到另一条会话上。
    if (actualSessionId !== sessionId) {
      await host.runtime.close();
      throw new Error(`Replacement runtime session ${actualSessionId} does not match ${sessionId}.`);
    }
    if (current?.runtime.getSnapshot().state.kind !== "idle") {
      throw new Error(`Cannot replace busy session runtime ${sessionId}.`);
    }
    const conflicting = this.entries.get(actualSessionId);
    if (conflicting && conflicting !== current) {
      throw new Error(`Runtime session ${actualSessionId} is already registered.`);
    }

    if (current?.primary) {
      const previous = current.runtime;
      current.unsubscribe();
      this.entries.delete(sessionId);
      current.runtime = host.runtime;
      current.commands = host.commands;
      current.sessionId = actualSessionId;
      current.lastActiveAt = Date.now();
      current.unsubscribe = host.runtime.subscribe((update) => {
        current.lastActiveAt = Date.now();
        this.options.onUpdate(update, current);
      });
      this.entries.set(actualSessionId, current);
      await previous.close();
      return current;
    }

    if (current) {
      this.entries.delete(sessionId);
      current.unsubscribe();
      await current.runtime.close();
    }
    const managed = this.attach(host, false);
    this.entries.set(actualSessionId, managed);
    return managed;
  }

  /** 删除主 session 前轮换主 runtime；这是删除语义，不与普通 restart 混用。 */
  async replacePrimary(host: { runtime: InteractiveRuntimeHandle; commands: CommandRuntime }): Promise<ManagedSessionRuntime> {
    if (this.closed) throw new Error("Runtime Host session registry is closed.");
    const current = this.primaryEntry;
    if (runtimeIsBusy(current.runtime.getSnapshot())) {
      await host.runtime.close();
      throw new Error(`Cannot replace busy session runtime ${current.sessionId}.`);
    }
    const actualSessionId = host.runtime.getSnapshot().info.sessionId;
    if (actualSessionId === current.sessionId) {
      await host.runtime.close();
      throw new Error(`Primary replacement must create a new session, received ${actualSessionId}.`);
    }
    const conflicting = this.entries.get(actualSessionId);
    if (conflicting && conflicting !== current) {
      await host.runtime.close();
      throw new Error(`Runtime session ${actualSessionId} is already registered.`);
    }

    const previous = current.runtime;
    current.unsubscribe();
    this.entries.delete(current.sessionId);
    current.runtime = host.runtime;
    current.commands = host.commands;
    current.sessionId = actualSessionId;
    current.lastActiveAt = Date.now();
    current.unsubscribe = host.runtime.subscribe((update) => {
      current.lastActiveAt = Date.now();
      this.options.onUpdate(update, current);
    });
    this.entries.set(actualSessionId, current);
    await previous.close();
    return current;
  }

  /** primary runtime 通过 startDraft 原地换 session 后，同步注册表键。 */
  syncPrimarySession(): ManagedSessionRuntime {
    const actualSessionId = this.primaryEntry.runtime.getSnapshot().info.sessionId;
    if (this.primaryEntry.sessionId === actualSessionId) return this.primaryEntry;
    this.entries.delete(this.primaryEntry.sessionId);
    this.primaryEntry.sessionId = actualSessionId;
    this.entries.set(actualSessionId, this.primaryEntry);
    return this.primaryEntry;
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.list().map(async (entry) => {
      entry.unsubscribe();
      await entry.runtime.close();
    }));
    this.entries.clear();
  }

  /** 只回收 idle、非主 runtime；返回实际回收的 sessionId。 */
  async evictIdle(requiredFreeSlots = 1): Promise<string[]> {
    const candidates = this.list()
      .filter((entry) => !entry.primary && !runtimeIsBusy(entry.runtime.getSnapshot()) && (this.options.canEvict?.(entry) ?? true))
      .sort((left, right) => left.lastActiveAt - right.lastActiveAt);
    const evicted: string[] = [];
    for (const entry of candidates) {
      if (evicted.length >= Math.max(0, requiredFreeSlots)) break;
      // 关闭上一个实例期间可能有新请求进入；重新确认候选仍空闲且没有新的使用者。
      if (this.entries.get(entry.sessionId) !== entry || runtimeIsBusy(entry.runtime.getSnapshot()) || !(this.options.canEvict?.(entry) ?? true)) continue;
      await this.closeSession(entry.sessionId);
      evicted.push(entry.sessionId);
    }
    return evicted;
  }

  private async create(sessionId: string, factoryOptions?: RuntimeHostFactoryOptions): Promise<ManagedSessionRuntime> {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    if (!this.options.createRuntime) throw new Error("Runtime Host cannot create a second session runtime without a factory.");
    // 缓存目标只触发尽力回收；忙碌、被 claim 或有在途操作的会话不能驱逐，也不能挡住新聊天。
    const occupiedSlots = this.entries.size + this.reservations.size;
    if (occupiedSlots > this.sessionRuntimeCacheTarget) {
      await this.evictIdle(occupiedSlots - this.sessionRuntimeCacheTarget);
    }

    let host: { runtime: InteractiveRuntimeHandle; commands: CommandRuntime } | undefined;
    try {
      host = await this.options.createRuntime(sessionId, factoryOptions);
      if (this.closed) {
        await host.runtime.close().catch(() => undefined);
        throw new Error("Runtime Host session registry is closed.");
      }
      const actualSessionId = host.runtime.getSnapshot().info.sessionId;
      if (actualSessionId !== sessionId) {
        throw new Error(`Runtime Host factory returned session ${actualSessionId}, expected ${sessionId}.`);
      }
      const managed = this.attach(host, false);
      this.entries.set(sessionId, managed);
      return managed;
    } catch (error) {
      await host?.runtime.close().catch(() => undefined);
      throw error;
    }
  }

  private attach(host: { runtime: InteractiveRuntimeHandle; commands: CommandRuntime }, primary: boolean): ManagedSessionRuntime {
    const sessionId = host.runtime.getSnapshot().info.sessionId;
    const managed: ManagedSessionRuntime = {
      sessionId,
      runtime: host.runtime,
      commands: host.commands,
      primary,
      lastActiveAt: Date.now(),
      unsubscribe: () => undefined
    };
    managed.unsubscribe = host.runtime.subscribe((update) => {
      managed.lastActiveAt = Date.now();
      this.options.onUpdate(update, managed);
    });
    return managed;
  }
}
