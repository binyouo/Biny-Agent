/**
 * Runtime Host 的业务组合边界。
 *
 * Host kernel 只负责连接、生命周期和请求路由；自动化与目标图监督器由这里统一装配，避免
 * Server 构造函数继续增长成第二个 composition root。
 */
import { AutomationScheduler } from "../AutomationScheduler.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import { GraphSupervisor } from "../GoalGraphStore.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate } from "../agentEvents.js";
import {
  createRuntimeHostMemoryMaintenance,
  type RuntimeHostMemoryMaintenance
} from "./maintenance.js";
import type { RuntimeHostFactory } from "./types.js";

export interface RuntimeHostBusinessComposition {
  start(): void;
  startMemoryMaintenance(): void;
  stop(): void;
  handleRuntimeUpdate(update: AgentRuntimeUpdate): void;
  scheduleMemoryEmbeddingRebuild(): void;
  runMemorySleep(): Promise<unknown>;
  previewMemorySleep(): Promise<unknown>;
  cancelMemorySleep(): boolean;
  runAutomation(automationId: string): Promise<unknown>;
  recoverGraphs(): void;
}

export interface RuntimeHostBusinessCompositionOptions {
  getRuntime(): InteractiveRuntimeHandle;
  getCommands(): CommandRuntime;
  isBusy?: () => boolean;
  createRuntime?: RuntimeHostFactory;
  createFreshRuntime?: (sessionId?: string) => Promise<InteractiveRuntimeHandle>;
  canStartAutomationRun?: () => boolean;
  restartRuntime(): Promise<void>;
}

export function createRuntimeHostBusinessComposition(
  options: RuntimeHostBusinessCompositionOptions
): RuntimeHostBusinessComposition {
  let automationScheduler: AutomationScheduler | undefined;
  let graphSupervisor: GraphSupervisor | undefined;
  const memoryMaintenance: RuntimeHostMemoryMaintenance = createRuntimeHostMemoryMaintenance({
    getRuntime: options.getRuntime,
    getCommands: options.getCommands,
    isBusy: options.isBusy
  });
  let stopped = false;

  const createSchedulers = (): void => {
    const commands = options.getCommands();
    automationScheduler = commands.automationStore
      ? new AutomationScheduler({
        getRuntime: options.getRuntime,
        getStore: () => options.getCommands().automationStore,
        createFreshRuntime: options.createRuntime === undefined
          ? undefined
          : options.createFreshRuntime,
        canStartRun: options.canStartAutomationRun
      })
      : undefined;
    graphSupervisor = commands.graphs
      ? new GraphSupervisor({
        getStore: () => options.getCommands().graphs,
        getRuntime: options.getRuntime,
        getTaskRuns: () => options.getCommands().taskRuns,
        getTaskCommandExecutor: () => options.getCommands(),
        getWorkspaceRoot: () => options.getCommands().workspaceRoot,
        getWorkspaceIgnore: () => options.getCommands().config.workspace.ignore
      })
      : undefined;
  };

  createSchedulers();

  return {
    start(): void {
      if (stopped) return;
      automationScheduler?.start();
      graphSupervisor?.start();
    },
    startMemoryMaintenance(): void {
      memoryMaintenance.start();
    },
    stop(): void {
      automationScheduler?.stop();
      graphSupervisor?.stop();
      memoryMaintenance.stop();
      stopped = true;
    },
    handleRuntimeUpdate(update: AgentRuntimeUpdate): void {
      memoryMaintenance.handleRuntimeUpdate(update);
    },
    scheduleMemoryEmbeddingRebuild(): void {
      memoryMaintenance.scheduleEmbeddingRebuild();
    },
    runMemorySleep(): Promise<unknown> {
      return memoryMaintenance.runNow();
    },
    previewMemorySleep(): Promise<unknown> {
      return memoryMaintenance.preview();
    },
    cancelMemorySleep(): boolean {
      return memoryMaintenance.cancel();
    },
    async runAutomation(automationId: string): Promise<unknown> {
      if (!automationScheduler) throw new Error("Automation scheduler is unavailable.");
      return await automationScheduler.runNow(automationId);
    },
    recoverGraphs(): void {
      const commands = options.getCommands();
      if (graphSupervisor && commands.graphs) commands.graphs.recoverRunningNodes(commands.taskRuns);
    }
  };
}
