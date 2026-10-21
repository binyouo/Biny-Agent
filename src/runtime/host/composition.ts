/**
 * Runtime Host 的业务组合边界。
 *
 * Host kernel 只负责连接、生命周期和请求路由；自动化与目标图监督器由这里统一装配，避免
 * Server 构造函数继续增长成第二个 composition root。
 */
import { AutomationScheduler } from "../AutomationScheduler.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import { GraphSupervisor } from "../GoalGraphStore.js";
import { SessionGoalRunner } from "../SessionGoalRunner.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate } from "../agentEvents.js";

export interface RuntimeHostBusinessComposition {
  hasActiveWork(): boolean;
  start(): void;
  stop(): void;
  handleRuntimeUpdate(update: AgentRuntimeUpdate): void;
  scheduleMemoryEmbeddingRebuild(): void;
  runMemorySleep(): Promise<unknown>;
  previewMemorySleep(): Promise<unknown>;
  cancelMemorySleep(): Promise<boolean>;
  runAutomation(automationId: string): Promise<unknown>;
  recoverGraphs(): void;
  scheduleGraphs(): void;
  scheduleGoals(): void;
}

export interface RuntimeHostBusinessCompositionOptions {
  onActivity?(): void;
  getRuntime(): InteractiveRuntimeHandle;
  getCommands(): CommandRuntime;
  createFreshRuntime: (sessionId?: string) => Promise<InteractiveRuntimeHandle>;
  resolveSessionRuntime: (sessionId: string) => Promise<InteractiveRuntimeHandle>;
  resolveSessionCommands: (sessionId: string) => Promise<CommandRuntime>;
  sessionExists?: (sessionId: string) => Promise<boolean>;
  canStartAutomationRun?: () => boolean;
  canStartGoalRun?: () => boolean;
  onGraphChange?(): void;
  admitGoal<T>(sessionId: string, execute: () => Promise<T>): Promise<T>;
}

export function createRuntimeHostBusinessComposition(
  options: RuntimeHostBusinessCompositionOptions
): RuntimeHostBusinessComposition {
  let stopped = false;
  const unsubscribeGraphs = options.getCommands().graphs.subscribe(() => {
    if (!stopped) options.onGraphChange?.();
  });
  const automationScheduler = new AutomationScheduler({
    onActivity: options.onActivity,
    getRuntime: options.getRuntime,
    getStore: () => options.getCommands().automationStore,
    createFreshRuntime: options.createFreshRuntime,
    canStartRun: options.canStartAutomationRun
  });
  const graphSupervisor = new GraphSupervisor({
    onActivity: options.onActivity,
    getStore: () => options.getCommands().graphs,
    getTaskRuns: () => options.getCommands().taskRuns,
    resolveSupervisorRuntime: options.resolveSessionRuntime,
    resolveSupervisorCommands: options.resolveSessionCommands,
    supervisorSessionExists: options.sessionExists
  });
  const goalRunner = new SessionGoalRunner({
    getCommands: options.getCommands,
    resolveRuntime: options.resolveSessionRuntime,
    resolveCommands: options.resolveSessionCommands,
    sessionExists: options.sessionExists,
    canStart: () => !stopped && (options.canStartGoalRun?.() ?? options.canStartAutomationRun?.() ?? true),
    admit: options.admitGoal,
    onActivity: options.onActivity,
    onChange: options.onGraphChange
  });

  return {
    hasActiveWork: () => Boolean(automationScheduler.hasActiveWork()) || Boolean(graphSupervisor.hasActiveWork()) || Boolean(goalRunner.hasActiveWork()),
    start(): void {
      if (stopped) return;
      automationScheduler.start();
      graphSupervisor.start();
      goalRunner.start();
    },
    stop(): void {
      automationScheduler.stop();
      graphSupervisor.stop();
      goalRunner.stop();
      stopped = true;
      unsubscribeGraphs();
    },
    handleRuntimeUpdate(update: AgentRuntimeUpdate): void {
      if (update.snapshot.state.kind === "idle" || update.event?.type === "tool.completed") {
        graphSupervisor.requestTick();
        goalRunner.requestTick();
      }
    },
    scheduleMemoryEmbeddingRebuild(): void {
      void options.getCommands().agent.maintainMemory().catch(() => undefined);
    },
    runMemorySleep(): Promise<unknown> {
      return options.getCommands().agent.runMemoryMaintenance();
    },
    previewMemorySleep(): Promise<unknown> {
      return options.getCommands().agent.previewMemoryMaintenance();
    },
    cancelMemorySleep(): Promise<boolean> {
      return options.getCommands().agent.cancelMemoryMaintenance();
    },
    async runAutomation(automationId: string): Promise<unknown> {
      return await automationScheduler.runNow(automationId);
    },
    recoverGraphs(): void {
      const commands = options.getCommands();
      commands.graphs.recoverRunningNodes(commands.taskRuns);
      graphSupervisor.requestTick();
    },
    scheduleGraphs(): void {
      graphSupervisor.requestTick();
    },
    scheduleGoals(): void {
      goalRunner.requestTick();
    }
  };
}
