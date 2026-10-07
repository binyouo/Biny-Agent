/**
 * 命令运行时装配模块。
 *
 * 每个 CLI/TUI 入口最终都会通过这里创建一个 AgentSession。这里是 composition
 * root，只装配配置、provider、工具和权限，不向宿主泄露可变 conversation 或 recorder。
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import type { AgentConfig } from "../config/schema.js";
import { AgentSession } from "../agent/AgentSession.js";
import type { AgentTurnOutcome, AgentPermissionRequest, AgentPermissionResult } from "../agent/types.js";
import { ModelManager } from "../llm/ModelManager.js";
import type { ToolModelSelectionState } from "../llm/toolModelRequest.js";
import { resolveToolModel, resolveToolModelCandidates } from "../llm/toolModel.js";
import { runSkillExtraction } from "../agent/skillExtraction.js";
import { preselectCapabilities } from "../agent/capabilityPreselection.js";
import { SessionRecorder, type SessionEvent } from "../session/recorder.js";
import { readSessionEvents } from "../session/events.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry, type ToolCatalogDefinition } from "../tools/registry.js";
import { getToolExposure, isToolModelVisible } from "../tools/exposure.js";
import { createTodoTool } from "../tools/todo.js";
import { createAskUserQuestionTool } from "../tools/askUserQuestion.js";
import { UserInputRequests } from "./userInput.js";

import { TodoStore } from "../session/todoStore.js";
import { CheckpointStore } from "../session/checkpointStore.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { createSkillLookupTool, createSkillResourceTool, createSkillTool, type SkillBundle, type SkillDefinition } from "../extensions/skills.js";
import { createSkillInstallTool, createSkillSearchTool } from "../tools/skillDiscovery.js";
import { skillPathsForSelection, skillPromptForSelection } from "../extensions/skills.js";
import type { ToolRisk, ToolSource } from "../tools/types.js";
import { perfNow, recordPerfPhase } from "../observability/perfTiming.js";
import { loadPlugins, loadPluginsFromRoot } from "../extensions/plugins.js";
import type { McpToolHost } from "../extensions/mcp.js";
import { createSubagentTool, createTaskStatusTool, createTaskControlTools, prepareSubagentTask, runSubagentTask as executeSubagentTask, type PreparedSubagentTask, type SubagentOptions } from "../extensions/subagent.js";
import { TaskCommunication } from "./TaskCommunication.js";
import { createPlanTools } from "../extensions/plan.js";
import { createSessionGoalTools } from "../extensions/sessionGoal.js";
import { buildSubagentDefinitionsPrompt, loadSubagentDefinitions, type SubagentDefinition } from "../extensions/agents.js";
import { createHistoryTools } from "../extensions/history.js";
import { createCheckpointEvidenceTool } from "../extensions/checkpointEvidence.js";
import { createMemoryTools } from "../extensions/memory.js";
import { createToolCounts, formatExtensionReport, type ExtensionSection, type ExtensionStatus } from "../extensions/report.js";
import { createModelSettings, createProviderCredentialPersistence, type ModelSettings } from "../llm/modelFactory.js";
import {
  SubagentTaskIncompleteError,
  SubagentTaskManager,
  type SubagentTaskRunOptions,
  type SubmittedSubagentTask
} from "./SubagentTaskManager.js";
import { ManagedProcessService, type ManagedProcessLifetime } from "./ManagedProcessService.js";
import { subagentAccessMode } from "./subagentAccess.js";
import { modelReasoningConfig } from "../ai/capabilities.js";
import { attachmentRoot, ensureAttachmentRoot } from "../attachments/store.js";
import { AiRegistry } from "../llm/AiRegistry.js";
import { RuntimeEventAuthority } from "./RuntimeAuthority.js";
import { DurableTaskRunStore, isTaskRunTerminal, type TaskRetrySafety, type TaskRunWithAttempts } from "./TaskRunStore.js";
import { evaluateTaskRetry } from "./TaskRetryPolicy.js";
import { readWorkerAttemptCheckpoint, runTaskClosure, type TaskClosureResult } from "./TaskClosure.js";
import { isSessionWriterConflictError } from "./SessionLease.js";
import { readWorkerSessionCheckpoint } from "./WorkerSession.js";
import { AutomationStore } from "./AutomationScheduler.js";
import { GoalGraphStore } from "./GoalGraphStore.js";
import { SessionGoalStore } from "./SessionGoalStore.js";
import { recordSessionGoalRequestUsage } from "./sessionGoalUsage.js";
import { CapabilityStore } from "./CapabilityStore.js";
import { RuntimeHostResourceScope, type RuntimeHostResourceRegistry, type RuntimeResourceSnapshot, type RuntimeResourceReadiness } from "./host/resources.js";
import { listEnabledGlobalPluginPaths, listEnabledProjectPluginPaths } from "../extensions/pluginRegistry.js";
import { globalPluginRoot } from "../config/paths.js";
import { HeartbeatScheduler } from "../agent/context/heartbeat.js";
import { createBrowserTools, type BrowserAutomationEndpoint } from "../tools/browser.js";
import { createWebFetchTool } from "../tools/web/fetch.js";
import { createWebSearchTool } from "../tools/web/search.js";
import { ToolExecutionCoordinator } from "../agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../agent/types.js";
import {
  isTaskVerificationEvidence,
  isTaskVerificationPermissionResult,
  pendingTaskVerificationApproval,
  readTaskDefinition,
  type TaskVerificationContract,
  recoverTaskCheckExecution,
  taskCheckRecoveryToolCallIds,
  taskCheckToolCallId,
  taskVerificationPermissionRequiredReason,
  type TaskCommandExecution,
  type TaskVerificationApproval
} from "./taskVerification.js";

export interface CommandRuntime {
  workspaceRoot: string;
  /** Location that owns durable runtime/session state. Project work uses the workspace; desktop may pass a global root for non-project sessions. */
  persistenceRoot: string;
  config: AgentConfig;
  agent: AgentSession;
  managedProcesses: ManagedProcessService;
  checkpoints: CheckpointStore | undefined;
  mcp: McpToolHost;
  runtimeAuthority: RuntimeEventAuthority;
  taskRuns: DurableTaskRunStore;
  automationStore: AutomationStore;
  heartbeat: HeartbeatScheduler;
  graphs: GoalGraphStore;
  sessionGoals: SessionGoalStore;
  capabilities: CapabilityStore;
  subagents: SubagentTaskManager | undefined;
  taskCommunication?: TaskCommunication;
  userInput?: UserInputRequests;
  setUserInputRun?(run?: { sessionId: string; runId: string }): void;
  extensionReport(section?: ExtensionSection): string;
  /** 扩展实时状态的快照；`/status` 等命令的卡片和文本报告共用。 */
  extensionStatus(): ExtensionStatus;
  /** 当前可用于 TUI 补全的 Skill 元数据；正文仍按需加载。 */
  listSkills(): SkillDefinition[];
  /** 当前注册表的脱敏工具目录，供 Desktop 的单回合能力选择器使用。 */
  listTools(): RuntimeToolCatalogEntry[];
  /** 每个新根回合前重新扫描 Skill，使新增和元数据修改无需重启即可生效。 */
  refreshSkills(): Promise<void>;
  /** 刷新共享 MCP/Skill 代理；回合开始前调用，避免活动回合看到半套工具。 */
  refreshExtensionTools?(): void;
  /** Desktop 客户端能力可在 Host 生命周期内挂载或撤销。 */
  setBrowserAutomation?(endpoint?: BrowserAutomationEndpoint): void;
  /** 固定本轮 Skill 可见集；后续资源变化只影响下一回合。 */
  captureRunResourceSnapshot?(runId: string): void;
  runSkillPaths?(runId: string): string[];
  releaseRunResourceSnapshot?(runId: string): void;
  resourceSnapshot?(): RuntimeResourceReadiness;
  subscribeResourceChanges?(listener: (snapshot: RuntimeResourceSnapshot) => void): () => void;
  /** 实时重新扫描具名子代理定义（会话期间可编辑生效）。 */
  listSubagentAgents(): Promise<SubagentDefinition[]>;
  startSubagentTask(task: string, options?: SubagentTaskRunOptions): SubmittedSubagentTask;
  /** Host、Desktop fallback 与模型可见 Task 共用的唯一 TaskRun 派发入口。 */
  startTaskRun(taskRunId: string, options?: { retrySafety?: TaskRetrySafety }): Promise<{
    task: TaskRunWithAttempts;
    completion: Promise<TaskClosureResult>;
  }>;
  /** Attach to a live TaskRun or continue only a persisted verification/retry boundary. */
  resumeTaskRun(taskRunId: string): Promise<{
    task: TaskRunWithAttempts;
    completion: Promise<TaskClosureResult>;
  }>;
  continueTaskRun(taskRunId: string, message: string, requestId?: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  canResumeWorkerTask?(taskRunId: string): Promise<boolean>;
  /** 一次性主任务通过同一份 TaskRun 验收闭环执行，不把回合完成当作产物已验证。 */
  runTaskWithVerification(input: {
    prompt: string;
    verification: TaskVerificationContract;
    signal?: AbortSignal;
    /** Stops model work before the full run deadline so verification can use the reserve. */
    attemptSignal?: AbortSignal;
    confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  }): Promise<{
    taskRunId: string;
    closure: TaskClosureResult;
    turnOutcome?: AgentTurnOutcome;
  }>;
  cancelTaskRun(taskRunId: string, reason?: string): TaskRunWithAttempts;
  startPlanDraft(graphId: string, revision: number, signal?: AbortSignal): Promise<unknown>;
  /** Task 验收只允许通过与 Agent 相同的 Bash 权限、调度、审计和取消链执行。 */
  executeTaskCheck(input: {
    command: string;
    checkId: string;
    contractFingerprint: string;
    cwd?: string;
    timeoutMs?: number;
    taskRunId: string;
    attemptId: string;
    approval?: TaskVerificationApproval;
    signal?: AbortSignal;
  }): Promise<TaskCommandExecution>;
  refreshDailyDiary(dateKey: string, options?: { force?: boolean }): Promise<unknown>;
  /** 不依赖前台 session 状态的进程内工作，防止空闲回收打断日报或子代理。 */
  hasBackgroundWork(): boolean;
  setSubagentParentRunId(parentRunId?: string): void;
  close(): Promise<void>;
}

export interface RuntimeToolCatalogEntry {
  name: string;
  description: string;
  source: ToolSource;
  risk?: ToolRisk;
  exposure?: ToolCatalogDefinition["exposure"];
  namespace?: ToolCatalogDefinition["namespace"];
  parameters?: ToolCatalogDefinition["parameters"];
  outputSchema?: ToolCatalogDefinition["outputSchema"];
}

// 日报和心跳是进程级后台工作；增加 Session 不能增加相同工作的计时器。
// 当前承载实例关闭后交给下一个存活实例，避免 LRU/配置重建停掉后台工作。
const backgroundOwners = new Set<{ start(): void; stop(): void }>();

export interface CommandRuntimeOptions {
  persistenceRoot?: string;
  /** Defaults to Runtime ownership; only a disposable enclosing environment may outlive it. */
  processLifetime?: ManagedProcessLifetime;
  configStore?: AgentConfigStore;
  attachmentRoot?: string;
  /** Host 为新 session 预先分配的 id；历史 session 仍由 InteractiveAgentRuntime.resumeSession 载入。 */
  sessionId?: string;
  /** Runtime Host 注入的 workspace 级共享扩展资源。 */
  resourceScope?: RuntimeHostResourceScope;
  /** Host 后台启动扩展；私有 CLI/TUI runtime 默认阻塞到首个能力快照。 */
  resourceBoot?: "blocking" | "background";
  /** Runtime Host 内部传递的 scope 注册表。 */
  resourceRegistry?: RuntimeHostResourceRegistry;
  /** Desktop 可见浏览器的控制端点；其它入口不设置则不注册 browser_* 工具。 */
  browserAutomation?: BrowserAutomationEndpoint;
}

export async function createCommandRuntime(workspaceRoot: string, options: CommandRuntimeOptions = {}): Promise<CommandRuntime> {
  // Session store 和其余运行组件都根据 workspace 定位全局按项目隔离的持久化分区。
  const persistenceRoot = options.persistenceRoot ?? workspaceRoot;
  const projectAttachmentRoot = options.attachmentRoot ?? attachmentRoot(persistenceRoot);
  const configStore = options.configStore ?? createFileConfigStore(persistenceRoot);
  const config = await configStore.load(workspaceRoot);
  const providerCredentials = createProviderCredentialPersistence(configStore, workspaceRoot);
  const resourceScope = options.resourceScope
    ?? options.resourceRegistry?.acquire(workspaceRoot, config)
    ?? new RuntimeHostResourceScope(workspaceRoot, config);
  let skills: SkillBundle = resourceScope.skills;
  const runSkillSnapshots = new Map<string, SkillBundle>();
  const skillsForRun = (runId?: string): SkillBundle => runId === undefined
    ? requireSkillBundle(skills)
    : runSkillSnapshots.get(runId) ?? requireSkillBundle(skills);
  const ownsResourceScope = options.resourceScope === undefined && options.resourceRegistry === undefined;
  const resourceBoot = options.resourceBoot ?? (ownsResourceScope ? "blocking" : "background");
  const resourceStart = resourceScope.start();
  const unsubscribeResources = resourceScope.subscribe(() => {
    skills = resourceScope.skills;
  });
  const ai = new AiRegistry();
  await ensureAgentDirs(persistenceRoot);
  await ensureAttachmentRoot(persistenceRoot);
  const runtimeAuthority = await RuntimeEventAuthority.open(persistenceRoot);
  const taskRuns = await DurableTaskRunStore.open(persistenceRoot, runtimeAuthority);
  const automationStore = await AutomationStore.open(persistenceRoot, runtimeAuthority);
  const graphs = await GoalGraphStore.open(persistenceRoot, runtimeAuthority);
  const sessionGoals = await SessionGoalStore.open(persistenceRoot, runtimeAuthority);
  const capabilities = await CapabilityStore.open(persistenceRoot, runtimeAuthority);
  const recorder = new SessionRecorder(persistenceRoot, options.sessionId, undefined, runtimeAuthority.asSink());
  const taskCommunication = new TaskCommunication(taskRuns, recorder.sessionId);
  const managedProcesses = new ManagedProcessService({
    workspaceRoot,
    persistenceRoot,
    processLifetime: options.processLifetime
  });
  await managedProcesses.initialize();
  // 选择状态只属于本 Runtime；配置变更替换状态，迟到请求不能污染新配置。
  let toolModelSelectionState: ToolModelSelectionState = { unavailableConnections: new Map() };
  let toolModelConfigHash: string | undefined;
  let toolModelConfig = config;
  const selectionStateForConfig = (current: AgentConfig): ToolModelSelectionState => {
    const hash = createHash("sha256").update(JSON.stringify({ toolModel: current.toolModel, providers: current.providers, models: current.models })).digest("hex");
    if (hash !== toolModelConfigHash) toolModelSelectionState = { unavailableConnections: new Map() };
    toolModelConfigHash = hash;
    toolModelConfig = current;
    return toolModelSelectionState;
  };
  const toolRegistry = createToolRegistry(
    { workspaceRoot, ignore: config.workspace.ignore, attachmentRoot: projectAttachmentRoot },
    config.web.search,
    managedProcesses,
    config.web.fetch,
    config.sandbox,
    config.web.cookies,
    () => resolveToolModelCandidates(toolModelConfig, providerCredentials),
    options.browserAutomation,
    () => selectionStateForConfig(toolModelConfig)
  );
  const browserToolNames = ["BrowserOpen", "BrowserReadDom", "BrowserClick", "BrowserType", "BrowserPress", "ComputerMirror", "ComputerList", "ComputerObserve", "ComputerAction"];
  const setBrowserAutomation = (endpoint?: BrowserAutomationEndpoint): void => {
    for (const name of [...browserToolNames, "WebSearch", "WebFetch"]) toolRegistry.unregister(name);
    if (endpoint) {
      for (const tool of createBrowserTools(endpoint)) toolRegistry.registerBuiltinTool(tool);
      toolRegistry.registerBuiltinTool(createWebSearchTool(config.web.search, config.web.cookies, endpoint));
    }
    if (endpoint || config.web.fetch.enabled !== false) {
      toolRegistry.registerBuiltinTool(createWebFetchTool(config.web.fetch, config.web.cookies, {
        browser: endpoint,
        visibleBrowsing: config.web.search.visibleBrowsing
      }));
    }
  };
  setBrowserAutomation(options.browserAutomation);
  // 快照挂在工作区的 git 仓库上；非 git 目录下这项能力直接不可用。
  const checkpoints = config.checkpoints.enabled ? await CheckpointStore.open(workspaceRoot) : undefined;
  const todos = new TodoStore(persistenceRoot, recorder.sessionId);
  await todos.initialize();
  toolRegistry.registerBuiltinTool(createTodoTool(todos));
  const userInput = new UserInputRequests();
  const permissionManager = new PermissionManager({ ...config.permission, source: "global config.json + project .biny/settings.json" });
  const mcpHost = resourceScope.mcp;
  let agent: AgentSession | undefined;
  let modelManager: ModelManager | undefined;
  let subagentParentRunId: string | undefined;
  const currentSkillBundle = (): SkillBundle => subagentParentRunId === undefined
    ? requireSkillBundle(skills)
    : skillsForRun(subagentParentRunId);
  let subagentDefinitions: SubagentDefinition[] = [];
  let registeredMcpTools: string[] = [];
  const durableSubagentBindings = new Map<string, {
    taskRunId: string;
    attemptId: string;
    completedStatus: "completed" | "verifying";
  }>();
  const taskCheckPromises = new Map<string, Promise<TaskCommandExecution>>();
  const durableTaskPromises = new Map<string, Promise<TaskClosureResult>>();
  const durableTaskControllers = new Map<string, AbortController>();
  const workerContinuations = new Map<string, PreparedSubagentTask>();
  const workerGoalBindings = new Map<string, { parentSessionId: string; parentRunId: string; sessionGoalId?: string }>();
  const workerResumeAdmissions = new Map<string, ReturnType<CommandRuntime["resumeTaskRun"]>>();
  let startTaskRun: CommandRuntime["startTaskRun"] = async () => {
    throw new Error("TaskRun execution is not initialized.");
  };
  let resumeTaskRun: CommandRuntime["resumeTaskRun"] = async () => {
    throw new Error("TaskRun resume is not initialized.");
  };
  let runTaskWithVerification: CommandRuntime["runTaskWithVerification"] = async () => {
    throw new Error("Verified one-shot task execution is not initialized.");
  };
  let cancelTaskRun: CommandRuntime["cancelTaskRun"] = () => {
    throw new Error("TaskRun cancellation is not initialized.");
  };
  const refreshExtensionTools = (): void => {
    const previous = new Set(registeredMcpTools);
    const registered = new Map(toolRegistry.listEntries().map((entry) => [entry.tool.name, entry]));
    registeredMcpTools = [];
    for (const tool of [...resourceScope.createTools(), ...resourceScope.createResourceTools()]) {
      const existing = registered.get(tool.name);
      if (previous.has(tool.name) && existing?.source === "mcp") {
        previous.delete(tool.name);
        if (existing.tool === tool) {
          registeredMcpTools.push(tool.name);
          continue;
        }
        toolRegistry.unregister(tool.name);
      }
      try {
        toolRegistry.registerMcpTool(tool);
        registeredMcpTools.push(tool.name);
        try {
          capabilities.ensureHostCapability(`host:mcp:${tool.name}`, tool.parameters);
        } catch {
          // 非法 schema 保留现有工具行为；调用时由统一 coordinator 记录失败。
        }
      } catch {
        // session 内的 plugin/builtin 同名工具优先，单个 MCP 工具不影响其它能力。
      }
    }
    for (const name of previous) {
      if (registered.get(name)?.source === "mcp") toolRegistry.unregister(name);
    }
  };
  const refreshSkills = async (force = false): Promise<void> => {
    await resourceScope.refreshSkills(force);
    skills = resourceScope.skills;
  };
  const releaseResourceScope = async (): Promise<void> => {
    unsubscribeResources();
    if (ownsResourceScope) await resourceScope.close();
    else if (options.resourceRegistry) await options.resourceRegistry.release(resourceScope);
    else resourceScope.release();
  };
  // 具名子代理定义每次委派时重新读取（会话期间可编辑生效）；启动时读一次用于 prompt 与报告。
  const loadAgentDefinitions = (): Promise<SubagentDefinition[]> => loadSubagentDefinitions({
    workspaceRoot,
    projectPaths: config.extensions.subagent.agentPaths
  });
  const subagentOptions: SubagentOptions = {
    workspaceRoot,
    config,
    getModelSettings: (modelAlias?: string) => subagentModelSettings(config, requireModelManager(modelManager), modelAlias),
    loadAgentDefinitions,
    toolRegistry,
    onUsage: async (usage, operation, modelAlias) => agent?.observeModelUsage(usage, operation, modelAlias),
    onRequestMetrics: async (metrics) => recordSessionGoalRequestUsage(sessionGoals, metrics),
    goalBudgetStopped: (context) => {
      if (!context?.sessionId || !context.sessionGoalId) return false;
      const goal = sessionGoals.get(context.sessionId);
      return goal?.goalId === context.sessionGoalId && (goal.status === "budget_limited" || Boolean(goal.tokenBudget !== undefined && !goal.usageKnown));
    },
    communication: taskCommunication,
    cancelTask: (taskRunId, reason) => cancelTaskRun(taskRunId, reason),
    continueTask: (taskRunId, message, requestId, signal) => continueTaskRun(taskRunId, message, requestId, signal),
    runTask: async (input, context) => {
      const sessionId = context.sessionId ?? recorder.sessionId;
      const taskRunId = `agent-task:${sessionId}:${context.toolCallId}`;
      taskRuns.create({
        taskRunId,
        sessionId,
        parentRunId: context.runId ?? subagentParentRunId,
        task: {
          prompt: input.task,
          constraints: input.constraints,
          communication: true,
          notifyParent: input.background === true,
          agent: input.agent,
          verification: input.verification
        }
      });
      const abort = (): void => {
        try { cancelTaskRun(taskRunId, "Parent Agent run was cancelled."); } catch { /* 终态或并发取消以持久化状态为准。 */ }
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      const unsubscribe = subagentTaskManager?.subscribe((snapshot) => {
        const binding = durableSubagentBindings.get(snapshot.taskId);
        if (snapshot.taskId !== taskRunId && binding?.taskRunId !== taskRunId) return;
        context.onUpdate?.({ kind: "status", customKind: "subagent", customData: {
          taskId: taskRunId, status: snapshot.status, agent: snapshot.agent
        } });
      });
      let detached = false;
      try {
        context.signal?.throwIfAborted();
        const started = await startTaskRun(taskRunId);
        if (input.background) {
          // 父回合正常结束不撤销已准入任务；显式取消仍通过 TaskCancel / Host 传递。
          void started.completion.finally(() => context.signal?.removeEventListener("abort", abort)).catch(() => undefined);
          detached = true;
          return taskRunToolResult(taskRuns.get(taskRunId));
        }
        const result = await started.completion;
        return taskRunToolResult(taskRuns.get(taskRunId), result);
      } finally {
        unsubscribe?.();
        if (!detached) context.signal?.removeEventListener("abort", abort);
      }
    },
    readTaskResult: async (input, context) => {
      const task = await taskCommunication.wait(input.taskRunId, input.waitMs, input.afterRevision, context.signal);
      return { ...taskRunToolResult(task), messages: taskCommunication.messages(input.taskRunId).slice(-4).map((message) => ({ ...message, content: message.content.slice(0, 1000) })) };
    }
  };
  const subagentTaskManager = config.extensions.subagent.enabled
    ? new SubagentTaskManager({
      maxConcurrentSubagents: config.extensions.subagent.maxConcurrentSubagents,
      maxPendingSubagents: config.extensions.subagent.maxPendingSubagents,
      timeoutMs: config.extensions.subagent.timeoutMs,
      onSnapshot: (snapshot) => {
        if (snapshot.status === "queued" && !workerGoalBindings.has(snapshot.taskId)) {
          const binding = durableSubagentBindings.get(snapshot.taskId);
          const parentSessionId = taskRuns.get(binding?.taskRunId ?? snapshot.taskId)?.sessionId ?? agent?.getInfo().sessionId ?? recorder.sessionId;
          const goal = sessionGoals.get(parentSessionId);
          workerGoalBindings.set(snapshot.taskId, { parentSessionId, parentRunId: snapshot.parentRunId, sessionGoalId: goal?.status === "active" ? goal.goalId : undefined });
        }
        taskRuns.syncSubagentSnapshot(snapshot, durableSubagentBindings.get(snapshot.taskId));
        taskCommunication.notify(durableSubagentBindings.get(snapshot.taskId)?.taskRunId ?? snapshot.taskId);
        if (snapshot.status !== "queued" && snapshot.status !== "running") workerGoalBindings.delete(snapshot.taskId);
      },
      persistCompletion: (snapshot, output) => {
        taskRuns.syncSubagentSnapshot(snapshot, durableSubagentBindings.get(snapshot.taskId), output);
        taskCommunication.notify(durableSubagentBindings.get(snapshot.taskId)?.taskRunId ?? snapshot.taskId);
      },
      execute: async (task, context) => {
        const prepared = workerContinuations.get(context.taskId);
        if (prepared) return await prepared.run(context.signal);
        const binding = durableSubagentBindings.get(context.taskId);
        const durable = taskRuns.get(binding?.taskRunId ?? context.taskId);
        const attempt = durable?.attempts.at(-1);
        if (durable && attempt && durable.status === "running") {
          const artifacts = attempt.artifacts as Record<string, unknown> | undefined;
          taskRuns.transition(durable.taskRunId, "running", { attemptId: attempt.attemptId, artifacts: {
            ...artifacts, workerExecution: { ...readWorkerAttemptCheckpoint(artifacts), prompt: task, accessMode: context.accessMode, agent: context.agent,
              communication: durable.sessionId === recorder.sessionId }
          } });
        }
        return await executeSubagentTask(subagentOptions, task, context.signal, context.accessMode, context.agent, {
          persistenceRoot, taskId: attempt?.attemptId ?? context.taskId,
          parentRunId: workerGoalBindings.get(context.taskId)?.parentRunId,
          sessionGoalId: workerGoalBindings.get(context.taskId)?.sessionGoalId,
          parentSessionId: durable?.sessionId ?? workerGoalBindings.get(context.taskId)?.parentSessionId,
          runtimeEventSink: { appendSessionEvent: (event) => {
            runtimeAuthority.appendSessionEvent(event);
            if (durable) taskCommunication.notify(durable.taskRunId);
          } },
          communication: durable?.sessionId === recorder.sessionId && attempt ? taskCommunication.worker(durable.taskRunId, attempt.attemptId) : undefined
        });
      }
    })
    : undefined;
  const loadedPlugins: string[] = [];
  try {
    // Desktop Host 的 MCP/Skill 启动在后台进行；私有 CLI/TUI runtime 仍在这里等待首个稳定快照。
    if (resourceBoot === "blocking") await resourceStart;
    skills = resourceScope.skills;
    toolRegistry.registerUserTool(createSkillTool(currentSkillBundle));
    toolRegistry.registerHostReadQuery(createSkillResourceTool(currentSkillBundle), "read_skill_resource");
    toolRegistry.registerHostReadQuery(createSkillLookupTool(currentSkillBundle), "skill_lookup");
    toolRegistry.registerBuiltinTool(createSkillSearchTool({
      getInstalledNames: () => {
        const installed = new Set<string>();
        for (const skill of currentSkillBundle().skills) {
          installed.add(skill.name.toLocaleLowerCase());
          installed.add(path.basename(path.dirname(skill.filePath)).toLocaleLowerCase());
        }
        return installed;
      }
    }));
    toolRegistry.registerBuiltinTool(createSkillInstallTool({
      refreshSkills: async () => await refreshSkills(true)
    }));
    refreshExtensionTools();
    const pluginsPerfStartedAt = perfNow();
    const managedPluginPaths = await listEnabledProjectPluginPaths(workspaceRoot).catch((error: unknown) => {
      loadedPlugins.push(`managed plugins (failed: ${error instanceof Error ? error.message : String(error)})`);
      return [];
    });
    for (const pluginPath of [...config.extensions.plugins, ...managedPluginPaths]) {
      try {
        loadedPlugins.push(...await loadPlugins(workspaceRoot, [pluginPath], config, toolRegistry, ai));
      } catch (error) {
        // 单个 Plugin 失败只影响它自己；主 Runtime、其它 Plugin 和内置工具仍可用。
        loadedPlugins.push(`${pluginPath} (failed: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const managedGlobalPluginPaths = await listEnabledGlobalPluginPaths().catch((error: unknown) => {
      loadedPlugins.push(`global managed plugins (failed: ${error instanceof Error ? error.message : String(error)})`);
      return [];
    });
    const globalPluginPaths = [...config.extensions.globalPlugins, ...managedGlobalPluginPaths];
    if (globalPluginPaths.length) {
      try {
        loadedPlugins.push(...await loadPluginsFromRoot(workspaceRoot, globalPluginRoot(), globalPluginPaths, config, toolRegistry, ai));
      } catch (error) {
        loadedPlugins.push(`global plugins (failed: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
    recordPerfPhase("host.loadPlugins", pluginsPerfStartedAt, { count: loadedPlugins.length }, workspaceRoot);
    // 插件必须先完成 Provider/API 注册，默认模型才能使用插件提供的新类型。
    const modelManagerPerfStartedAt = perfNow();
    modelManager = await ModelManager.create(workspaceRoot, config, configStore, ai);
    recordPerfPhase("host.modelManagerCreate", modelManagerPerfStartedAt, undefined, workspaceRoot);
    for (const tool of createSessionGoalTools(sessionGoals, () => agent?.getInfo().sessionId ?? recorder.sessionId, () => agent?.currentSessionGoalRequest())) {
      toolRegistry.registerBuiltinTool(tool);
    }
    if (config.extensions.subagent.enabled) {
      toolRegistry.registerSubagentTool(createSubagentTool(subagentOptions));
      toolRegistry.registerHostReadQuery(createTaskStatusTool(subagentOptions), "TaskStatus");
      for (const tool of createTaskControlTools(subagentOptions)) toolRegistry.registerSubagentTool(tool);
      for (const tool of createPlanTools({
        graphs,
        taskRuns,
        stopGraph: (graphId, reason) => {
          const current = graphs.inspectGraph(graphId);
          const activeTaskRunIds = current.nodes.flatMap((node) => node.status === "running" && node.taskRunId !== undefined ? [node.taskRunId] : []);
          const cancelled = graphs.cancelGraph(graphId);
          for (const taskRunId of activeTaskRunIds) {
            const task = taskRuns.get(taskRunId);
            if (!task || isTaskRunTerminal(task.status)) continue;
            try { cancelTaskRun(taskRunId, reason ?? "Supervised plan stopped."); } catch { /* Graph 终态已经阻止晚到结果，取消竞态以 TaskRun 当前事实为准。 */ }
          }
          return cancelled;
        }
      })) toolRegistry.registerSubagentTool(tool);
      subagentDefinitions = await loadAgentDefinitions();
    }
    // 读取/写入 durable memory 与“当前聊天是否自动召回/贡献”是两组独立开关。
    // 工具始终注册；显式 save_memory 不会因聊天策略关闭而丢失。
    for (const tool of createMemoryTools(
      () => agent?.getLocalMemory(),
      async (query, paths, options) => {
        const currentAgent = agent;
        if (!currentAgent) throw new Error("Local memory is unavailable.");
        return await currentAgent.searchMemory(query, paths, options);
      }
    )) {
      toolRegistry.registerBuiltinTool(tool);
    }
    for (const tool of createHistoryTools({
      getIndex: () => (agent ? agent.getSessionSearchIndex() : undefined),
      flushCurrentSession: async (signal) => {
        signal?.throwIfAborted();
        const currentAgent = agent;
        if (!currentAgent) return;
        await currentAgent.flushSessionSearchIndex(signal);
      }
    })) {
      toolRegistry.registerBuiltinTool(tool);
    }
    toolRegistry.registerBuiltinTool(createCheckpointEvidenceTool(async (args, signal) => {
      if (!agent) throw new Error("Session is unavailable.");
      return await agent.readCheckpointEvidence(args, signal);
    }));
    // MCP/Plugin 仍由 Host 持有连接和执行权；共享 MCP 工具在回合开始前按最新快照同步。
    for (const entry of toolRegistry.listEntries()) {
      if (entry.source !== "mcp" && entry.source !== "plugin") continue;
      try {
        capabilities.ensureHostCapability(`host:${entry.source}:${entry.tool.name}`, entry.tool.parameters);
      } catch {
        // 扩展 schema 不合法时保留原有工具加载行为；实际调用会由 coordinator 记录失败。
      }
    }
    agent = new AgentSession({
      workspaceRoot,
      persistenceRoot,
      configStore,
      config,
      model: undefined,
      modelManager,
      toolRegistry,
      permissionManager,
      recorder,
      skillPrompt: (selection, runId) => skillPromptForSelection(skillsForRun(runId), selection),
      extractSkill: async ({ messageId, events, minToolCalls, onNotice }) => await runSkillExtraction({
        messageId,
        events,
        minToolCalls,
        onNotice,
        installedSkills: requireSkillBundle(skills).skills,
        model: resolveToolModel(config, providerCredentials),
        refreshSkills: async () => await refreshSkills(true)
      }),
      subagentPrompt: buildSubagentDefinitionsPrompt(subagentDefinitions),
      skillPaths: (selection, runId) => skillPathsForSelection(skillsForRun(runId), selection),
      selectCapabilities: async (input, runId) => {
        return await preselectCapabilities({
          ...input, models: resolveToolModelCandidates(input.config, providerCredentials), tools: toolRegistry.list().filter(isToolModelVisible), skills: skillsForRun(runId).skills,
          selectionState: selectionStateForConfig(input.config)
        });
      },
      prepareToolDiscovery: async (query, signal) => {
        const result = await resourceScope.waitForMcpDiscovery({ query, signal });
        refreshExtensionTools();
        return { pending: result.pending, timedOut: result.timedOut };
      },
      mcpPrompt: () => mcpHost.instructionsPrompt(),
      todoStore: todos,
      sessionGoals,
      taskCommunication,
      createCheckpoint: checkpoints ? async (label) => await checkpoints.create(label) : undefined,
      attachmentRoot: projectAttachmentRoot,
      runtimeEventSink: runtimeAuthority.asSink(),
      capabilities,
      createSelfReflectionTask: async (candidate) => {
        taskRuns.create({
          taskRunId: candidate.taskRunId,
          sessionId: recorder.sessionId,
          task: {
            type: "self_reflection_action",
            title: candidate.title,
            description: candidate.description,
            evidence: candidate.evidence,
            sourceDate: candidate.dateKey,
            sourceHash: candidate.sourceHash
          }
        });
        return true;
      }
    });
    await agent.initialize();
  } catch (error) {
    // agent.initialize() 失败时 agent 已构造但不随下方资源关闭；recorder.close 幂等，重复调用安全。
    await agent?.close().catch(() => undefined);
    await subagentTaskManager?.close();
    await managedProcesses.close();
    await releaseResourceScope();
    await recorder.close();
    automationStore.close();
    graphs.close();
    sessionGoals.close();
    capabilities.close();
    taskCommunication.close();
    taskRuns.close();
    runtimeAuthority.close();
    throw error;
  }
  if (!agent) throw new Error("Failed to initialize Biny agent runtime.");

  const heartbeatAgent = agent;
  const heartbeat = new HeartbeatScheduler({
    configDir: undefined,
    enabled: config.heartbeat.enabled,
    schedule: {
      intervalMinutes: config.heartbeat.intervalMinutes,
      activeHoursStart: config.heartbeat.activeHoursStart,
      activeHoursEnd: config.heartbeat.activeHoursEnd
    },
    run: async (prompt, signal) => {
      const outcome = await heartbeatAgent.runTask(prompt, { abortSignal: signal, runId: randomUUID(), turnId: randomUUID(), emotionAnalysis: false, source: "heartbeat" });
      if (outcome.status !== "completed") throw new Error(outcome.error ?? "Heartbeat did not complete.");
    }
  });
  const backgroundOwner = {
    start: (): void => { heartbeat.start(); },
    stop: (): void => { heartbeat.stop(); }
  };
  backgroundOwners.add(backgroundOwner);
  if (backgroundOwners.size === 1) backgroundOwner.start();

  // MCP 连接状态与工具集合在运行期会变（断线、重连、list_changed），报告每次实时取。
  const extensionStatus = (): ExtensionStatus => ({
    mcp: mcpHost.listServers(),
    skills: [...requireSkillBundle(skills).skills],
    skillWarnings: [...requireSkillBundle(skills).warnings],
    plugins: [...loadedPlugins],
    subagent: { ...config.extensions.subagent, agents: [...subagentDefinitions] },
    toolScheduling: {
      maxConcurrentTools: config.agent.maxConcurrentTools,
      maxQueuedToolCalls: config.agent.maxQueuedToolCalls
    },
    toolCounts: createToolCounts(toolRegistry.listEntries())
  });

  const startSubagentTask = (task: string, taskOptions?: SubagentTaskRunOptions): SubmittedSubagentTask => {
    if (!config.extensions.subagent.enabled) throw new Error("Subagent extension is disabled in config.json.");
    if (!subagentTaskManager) throw new Error("Subagent runtime is unavailable.");
    const taskId = taskOptions?.taskId ?? randomUUID();
    const auditCallId = workerContinuations.has(taskId) ? randomUUID() : taskId;
    agent.recordHostedUserMessage(task);
    const sequence = agent.recordHostedToolCall("Task", taskOptions?.agent ? { task, agent: taskOptions.agent } : { task }, auditCallId);
    let submitted: SubmittedSubagentTask;
    try {
      taskOptions?.signal?.throwIfAborted();
      if (taskOptions?.taskRunId && taskOptions.attemptId) {
        durableSubagentBindings.set(taskId, {
          taskRunId: taskOptions.taskRunId,
          attemptId: taskOptions.attemptId,
          completedStatus: taskOptions.completedStatus ?? "completed"
        });
      }
      submitted = subagentTaskManager.submit(task, {
        taskId,
        parentRunId: taskOptions?.parentRunId,
        signal: taskOptions?.signal,
        timeoutMs: taskOptions?.timeoutMs,
        accessMode: taskOptions?.accessMode ?? subagentAccessMode(permissionManager),
        agent: taskOptions?.agent
      });
    } catch (error) {
      durableSubagentBindings.delete(taskId);
      const failure = error instanceof Error ? error : new Error(String(error));
      agent.recordHostedToolResult("Task", { error: failure.message }, auditCallId, sequence);
      throw failure;
    }

    const completion = submitted.completion.then(
      (result) => {
        agent.recordHostedToolResult("Task", result, auditCallId, sequence);
        agent.recordHostedAssistantMessage(result);
        return result;
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        agent.recordHostedToolResult("Task", { error: failure.message }, auditCallId, sequence);
        throw failure;
      }
    ).finally(() => {
      durableSubagentBindings.delete(taskId);
    });
    // Background CLI starts intentionally do not await completion. Attaching a
    // rejection observer keeps cancellation/failure from becoming unhandled;
    // foreground callers can still await the original completion promise.
    void completion.catch(() => undefined);
    return { ...submitted, completion };
  };

  const dispatchTaskRun = async (
    taskRunId: string,
    taskOptions: { retrySafety?: TaskRetrySafety } = {},
    workerContinuation?: PreparedSubagentTask
  ): Promise<{ task: TaskRunWithAttempts; completion: Promise<TaskClosureResult> }> => {
    const task = taskRuns.get(taskRunId);
    if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
    const existingPromise = durableTaskPromises.get(taskRunId);
    if (existingPromise) return { task, completion: existingPromise };
    const definition = readTaskDefinition(task.task);
    const closureRequired = Boolean(definition.verification || definition.review || definition.reportOnly);
    if (isTaskRunTerminal(task.status) && !(task.status === "completed" && closureRequired)) {
      return {
        task,
        completion: Promise.resolve({ status: task.status === "completed" ? "completed" : task.status === "cancelled" ? "cancelled" : "blocked" })
      };
    }

    let current = task;
    if (current.status === "running" && !workerContinuation) {
      const reason = "This TaskRun has no live Worker or persisted checkpoint; replaying its unknown side effects is unsafe.";
      current = taskRuns.transition(taskRunId, "blocked", {
        attemptId: current.attempts.at(-1)?.attemptId,
        failure: { failureClass: "unsafe_recovery", message: reason }
      });
      return { task: current, completion: Promise.resolve({ status: "blocked", reason }) };
    }
    if (current.status === "queued" && current.attempts.length > 0 && !hasSafeQueuedTaskContinuation(current, taskRuns.events(taskRunId))) {
      const reason = "This queued TaskRun has no persisted retry or verification-repair admission; replaying its Worker is unsafe.";
      current = taskRuns.transition(taskRunId, "blocked", {
        attemptId: current.attempts.at(-1)?.attemptId,
        failure: { failureClass: "unsafe_recovery", message: reason }
      });
      return { task: current, completion: Promise.resolve({ status: "blocked", reason }) };
    }
    if (current.status === "created") current = taskRuns.transition(taskRunId, "queued");
    const latest = taskRuns.get(taskRunId);
    if (!latest) throw new Error(`TaskRun ${taskRunId} disappeared before execution.`);
    const controller = new AbortController();
    durableTaskControllers.set(taskRunId, controller);
    const completion = runTaskClosure({
      taskRuns,
      taskRunId,
      workspaceRoot,
      ignore: config.workspace.ignore,
      executor: { executeTaskCheck: async (checkInput) => await executeTaskCheck(checkInput) },
      retrySafety: taskOptions.retrySafety,
      resumeWorker: workerContinuation !== undefined,
      signal: controller.signal,
      executeAttempt: async (prompt, attempt) => {
        let submitted;
        const workerTaskId = closureRequired ? attempt.attemptId : taskRunId;
        if (workerContinuation) workerContinuations.set(workerTaskId, workerContinuation);
        try {
          submitted = startSubagentTask(prompt, {
            taskId: workerTaskId,
            taskRunId,
            attemptId: attempt.attemptId,
            completedStatus: closureRequired ? "verifying" : "completed",
            parentRunId: latest.parentRunId,
            signal: controller.signal,
            accessMode: definition.review || definition.reportOnly ? "read-only" : definition.verification ? "workspace" : subagentAccessMode(permissionManager),
            agent: definition.agent
          });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          finishTaskAttempt(taskRuns, taskRunId, attempt.attemptId, "failed", {
            failure: { message: failure.message, failureClass: "dispatch_failed" }
          });
          throw failure;
        }
        try {
          return await submitted.completion;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          const status = failure.name === "SubagentTaskAbortedError" || failure.name === "AbortError" ? "aborted"
            : failure instanceof SubagentTaskIncompleteError ? "incomplete" : "failed";
          finishTaskAttempt(taskRuns, taskRunId, attempt.attemptId, status, {
            artifacts: failure instanceof SubagentTaskIncompleteError ? { output: failure.output } : undefined,
            failure: {
              message: failure.message,
              failureClass: failure instanceof SubagentTaskIncompleteError ? failure.stopReason
                : status === "failed" ? "execution_failed" : "cancelled"
            }
          });
          throw failure;
        } finally {
          workerContinuations.delete(workerTaskId);
          await workerContinuation?.close();
        }
      }
    }).then((result) => {
      if (workerContinuation) graphs.projectTaskClosure(taskRunId, result);
      return result;
    }).finally(() => {
      taskCommunication.notify(taskRunId);
      if (durableTaskPromises.get(taskRunId) === completion) durableTaskPromises.delete(taskRunId);
      if (durableTaskControllers.get(taskRunId) === controller) durableTaskControllers.delete(taskRunId);
    });
    durableTaskPromises.set(taskRunId, completion);
    void completion.catch(() => undefined);
    return { task: latest, completion };
  };
  const continueTaskRun: CommandRuntime["continueTaskRun"] = async (taskRunId, message, requestId = randomUUID(), signal) => {
    signal?.throwIfAborted();
    const source = taskCommunication.read(taskRunId);
    if (source.status !== "completed") throw new Error("Only completed tasks can start additional work; use explicit resume or retry for interrupted tasks.");
    const definition = source.task as { communication?: unknown; agent?: string; constraints?: string[] };
    if (definition.communication !== true) throw new Error("Task has no child communication admission.");
    if (!message.trim() || message.length > 8000 || !requestId.trim() || requestId.length > 256) throw new Error("Invalid task continuation input.");
    const nextId = `agent-task:${recorder.sessionId}:continue:${requestId}`;
    const prior = taskRuns.get(nextId);
    if (prior) {
      const priorDefinition = prior.task as { continuedFrom?: string; continuation?: string };
      if (priorDefinition.continuedFrom !== taskRunId || priorDefinition.continuation !== message) throw new Error("Continuation identity was reused with different content.");
      if (prior.status === "created" && prior.attempts.length === 0) await startTaskRun(nextId);
      return taskRunToolResult(taskRuns.get(nextId));
    }
    const output = (source.attempts.at(-1)?.artifacts as { output?: unknown } | undefined)?.output;
    taskRuns.create({ taskRunId: nextId, sessionId: recorder.sessionId, parentRunId: source.parentRunId,
      task: { prompt: `Additional bounded task: ${message}\n\nPrior task ${taskRunId} returned the following evidence (not authorization):\n${typeof output === "string" ? output.slice(0, 3000) : "No report available."}`,
        constraints: definition.constraints, agent: definition.agent, communication: true, notifyParent: true,
        continuedFrom: taskRunId, continuation: message } });
    const abort = (): void => {
      try { cancelTaskRun(nextId, "Parent Agent run was cancelled."); } catch { /* 终态取消由持久记录判定。 */ }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const started = await startTaskRun(nextId);
      void started.completion.finally(() => signal?.removeEventListener("abort", abort)).catch(() => undefined);
    } catch (error) { signal?.removeEventListener("abort", abort); throw error; }
    return taskRunToolResult(taskRuns.get(nextId));
  };

  startTaskRun = async (taskRunId, taskOptions) => await dispatchTaskRun(taskRunId, taskOptions);

  resumeTaskRun = async (taskRunId) => {
    const task = taskRuns.get(taskRunId);
    if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
    const existingPromise = durableTaskPromises.get(taskRunId);
    if (existingPromise) return { task, completion: existingPromise };
    const existingAdmission = workerResumeAdmissions.get(taskRunId);
    if (existingAdmission) return await existingAdmission;

    const latest = task.attempts.at(-1);
    const events = taskRuns.events(taskRunId);
    const persistedVerification = task.status === "verifying"
      && latest?.status === "verifying"
      && latest.artifacts !== undefined;
    const admittedQueuedContinuation = task.status === "queued"
      && hasSafeQueuedTaskContinuation(task, events);
    const parkedWorker = task.status === "blocked" && (latest?.failure as { failureClass?: string } | undefined)?.failureClass === "worker_interrupted";
    if ((task.status === "running" || parkedWorker) && latest && config.extensions.subagent.enabled) {
      const checkpoint = readWorkerAttemptCheckpoint(latest.artifacts);
      if (checkpoint) {
        const admission = (async () => {
          const definition = readTaskDefinition(task.task);
          let prepared: PreparedSubagentTask | undefined;
          try {
            prepared = await prepareSubagentTask(subagentOptions, checkpoint.prompt,
              definition.review || definition.reportOnly || subagentAccessMode(permissionManager) === "read-only" ? "read-only" : checkpoint.accessMode ?? "workspace", definition.agent ?? checkpoint.agent, {
                persistenceRoot, taskId: latest.attemptId, parentSessionId: task.sessionId,
                resume: true, runtimeEventSink: { appendSessionEvent: (event) => {
                  runtimeAuthority.appendSessionEvent(event);
                  taskCommunication.notify(taskRunId);
                } },
                communication: checkpoint.communication && task.sessionId === recorder.sessionId ? taskCommunication.worker(taskRunId, latest.attemptId) : undefined
              });
            const current = taskRuns.get(taskRunId);
            if (current?.status !== task.status || current.revision !== task.revision || current.attempts.at(-1)?.attemptId !== latest.attemptId) throw new Error("Worker Attempt changed during continuation admission.");
            if (parkedWorker) taskRuns.resumeWorkerAttempt(taskRunId, latest.attemptId, task.revision);
            const submitted = await dispatchTaskRun(taskRunId, {}, prepared);
            void submitted.completion.finally(async () => { await prepared?.close(); }).catch(() => undefined);
            return submitted;
          } catch (error) {
            await prepared?.close();
            const current = taskRuns.get(taskRunId);
            if (!isSessionWriterConflictError(error) && current?.status === "running" && current.attempts.at(-1)?.attemptId === latest.attemptId) {
              taskRuns.transition(taskRunId, "blocked", { attemptId: latest.attemptId, artifacts: latest.artifacts,
                failure: { failureClass: "unsafe_recovery", message: error instanceof Error ? error.message : String(error) } });
            }
            throw error;
          }
        })();
        workerResumeAdmissions.set(taskRunId, admission);
        try { return await admission; }
        finally { if (workerResumeAdmissions.get(taskRunId) === admission) workerResumeAdmissions.delete(taskRunId); }
      }
    }
    if (!persistedVerification && !admittedQueuedContinuation) {
      throw new Error("TaskRun resume requires a live Worker, persisted verification candidate, or an admitted retry/repair boundary.");
    }
    return await startTaskRun(taskRunId);
  };

  cancelTaskRun = (taskRunId: string, reason = "TaskRun cancelled."): TaskRunWithAttempts => {
    const task = taskRuns.get(taskRunId);
    if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
    const latestAttempt = task.attempts.at(-1);
    const subagentId = latestAttempt && subagentTaskManager?.getSnapshot(latestAttempt.attemptId)
      ? latestAttempt.attemptId
      : taskRunId;
    subagentTaskManager?.cancelTask(subagentId, reason);
    durableTaskControllers.get(taskRunId)?.abort(new Error(reason));
    const current = taskRuns.get(taskRunId);
    if (!current) throw new Error(`TaskRun ${taskRunId} does not exist.`);
    if (isTaskRunTerminal(current.status)) return current;
    const cancelled = taskRuns.transition(taskRunId, "cancelled", { attemptId: current.attempts.at(-1)?.attemptId });
    taskCommunication.notify(taskRunId);
    return cancelled;
  };

  const executeTaskCheckOnce = async (input: {
    command: string;
    checkId: string;
    contractFingerprint: string;
    cwd?: string;
    timeoutMs?: number;
    taskRunId: string;
    attemptId: string;
    approval?: TaskVerificationApproval;
    signal?: AbortSignal;
  }): Promise<TaskCommandExecution> => {
    const checkRecorder = agent.getSessionRecorder();
    await checkRecorder.flush();
    const currentSessionEvents = await readSessionEvents(checkRecorder.filePath);
    const durableEvents = runtimeAuthority.readToolEvents(taskCheckRecoveryToolCallIds(input))
      .filter((event) => event.runId === input.taskRunId && event.turnId === input.attemptId)
      .map((event) => event.payload)
      .filter(isTaskCheckSessionEvent);
    const recovery = recoverTaskCheckExecution(
      mergeTaskCheckEvents(
        durableEvents,
        currentSessionEvents,
        taskCheckRecoveryToolCallIds(input),
        input.taskRunId,
        input.attemptId
      ),
      checkRecorder.sessionId,
      input
    );
    if (recovery.action !== "execute") return recovery.execution;
    const toolCallId = recovery.toolCallId;
    const approvalMatches = input.approval?.taskRunId === input.taskRunId
      && input.approval.attemptId === input.attemptId
      && input.approval.checkId === input.checkId
      && input.approval.contractFingerprint === input.contractFingerprint
      && input.approval.toolCallId === taskCheckToolCallId(input);
    let approvalRequired = false;
    const events: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
    const coordinator = new ToolExecutionCoordinator(
      {
        workspaceRoot,
        config,
        recorder: checkRecorder,
        toolRegistry,
        permissionManager,
        // 后台验收不能弹出隐藏的交互确认；task.approve 已绑定到当前检查及候选版本，
        // 因此它本身就是这一次调用的显式强确认，不产生工具级或会话级授权。
        confirmPermission: async (request) => {
          if (approvalMatches) {
            return { approved: true, action: "allow_once", scope: "once", confirmation: request.requireFullYes ? "yes" : undefined };
          }
          approvalRequired = true;
          return { approved: false, message: taskVerificationPermissionRequiredReason };
        },
        createCheckpoint: checkpoints ? async (label) => await checkpoints.create(label) : undefined,
        capabilities,
        runId: input.taskRunId,
        turnId: input.attemptId
      },
      permissionManager,
      (event) => events.push(event),
      () => ({}),
      new Set(["Bash"]),
      { maxToolCalls: 1, maxRepeatedActions: 1 }
    );
    const bash = coordinator.createAgentTools().find((tool) => tool.name === "Bash");
    if (!bash) throw new Error("Bash verification tool is unavailable.");
    const response = await bash.execute(toolCallId, {
      command: input.command,
      cwd: input.cwd ?? ".",
      timeoutMs: input.timeoutMs ?? 120_000
    }, input.signal);
    await coordinator.waitForIdle();
    await checkRecorder.flush();
    const persistedResult = latestTaskCheckResult(await readSessionEvents(checkRecorder.filePath), toolCallId);
    const lifecycle = [...events].reverse().find((event) =>
      (event.type === "tool.completed" || event.type === "tool.failed") && event.toolCallId === toolCallId
    );
    return {
      result: response.details ?? response,
      toolCallId,
      operationId: lifecycle && "operationId" in lifecycle ? lifecycle.operationId : undefined,
      resultEventId: persistedResult?.runtime?.eventId,
      eventReferences: [
        toolCallId,
        lifecycle && "operationId" in lifecycle ? lifecycle.operationId : undefined,
        persistedResult?.runtime?.eventId
      ].filter((reference): reference is string => reference !== undefined),
      approvalRequired: approvalRequired || isTaskVerificationPermissionResult(response.details ?? response)
    };
  };

  const executeTaskCheck = (input: Parameters<CommandRuntime["executeTaskCheck"]>[0]): Promise<TaskCommandExecution> => {
    const key = taskCheckToolCallId(input);
    const existing = taskCheckPromises.get(key);
    if (existing) return existing;
    const completion = executeTaskCheckOnce(input).finally(() => {
      if (taskCheckPromises.get(key) === completion) taskCheckPromises.delete(key);
    });
    taskCheckPromises.set(key, completion);
    return completion;
  };

  runTaskWithVerification = async (input) => {
    const attemptSignal = input.attemptSignal ?? input.signal;
    const task = taskRuns.create({
      task: { prompt: input.prompt, verification: input.verification }
    });
    let turnOutcome: AgentTurnOutcome | undefined;
    try {
      const closure = await runTaskClosure({
        taskRuns,
        taskRunId: task.taskRunId,
        workspaceRoot,
        ignore: config.workspace.ignore,
        executor: { executeTaskCheck: async (checkInput) => await executeTaskCheck(checkInput) },
        signal: input.signal,
        canRepair: () => attemptSignal?.aborted !== true,
        executeAttempt: async (prompt, attempt) => {
          turnOutcome = await agent.runTask(prompt, {
            abortSignal: attemptSignal,
            confirmPermission: input.confirmPermission,
            runId: attempt.runId,
            turnId: attempt.turnId
          });
          if (attemptSignal?.aborted && !input.signal?.aborted) return turnOutcome.output;
          if (turnOutcome.status === "completed") return turnOutcome.output;

          const status = closureStatusForTurn(turnOutcome.status);
          const current = taskRuns.get(task.taskRunId);
          if (current && !isTaskRunTerminal(current.status)) {
            taskRuns.transition(task.taskRunId, status, {
              attemptId: attempt.attemptId,
              artifacts: { output: turnOutcome.output },
              failure: {
                failureClass: turnOutcome.stopReason,
                message: turnOutcome.error ?? `Agent turn ended with ${turnOutcome.status}.`
              }
            });
          }
          throw new VerifiedTaskTurnStopped(status, turnOutcome);
        }
      });
      return { taskRunId: task.taskRunId, closure, turnOutcome };
    } catch (error) {
      if (error instanceof VerifiedTaskTurnStopped) {
        return {
          taskRunId: task.taskRunId,
          closure: {
            status: error.closureStatus,
            output: error.outcome.output,
            reason: error.outcome.error ?? `Agent turn ended with ${error.outcome.status}.`
          },
          turnOutcome: error.outcome
        };
      }
      const latest = taskRuns.get(task.taskRunId);
      if (latest && !isTaskRunTerminal(latest.status)) {
        taskRuns.transition(task.taskRunId, "failed", {
          attemptId: latest.attempts.at(-1)?.attemptId,
          failure: {
            failureClass: "verified_run_failed",
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
      return {
        taskRunId: task.taskRunId,
        closure: {
          status: input.signal?.aborted ? "cancelled" : "incomplete",
          output: turnOutcome?.output,
          reason: error instanceof Error ? error.message : String(error)
        },
        turnOutcome
      };
    }
  };

  const runtime: CommandRuntime = {
    workspaceRoot,
    persistenceRoot,
    config,
    agent,
    managedProcesses,
    checkpoints,
    mcp: mcpHost,
    runtimeAuthority,
    taskRuns,
    automationStore,
    heartbeat,
    graphs,
    sessionGoals,
    capabilities,
    subagents: subagentTaskManager,
    taskCommunication,
    userInput,
    setUserInputRun(run) {
      userInput.setRun(run);
      toolRegistry.unregister("AskUserQuestion");
      if (run) toolRegistry.registerBuiltinTool(createAskUserQuestionTool(userInput));
    },
    hasBackgroundWork: () => heartbeat.status().running
      || durableTaskPromises.size > 0
      || Boolean(subagentTaskManager?.listSnapshots().some((task) => task.status === "queued" || task.status === "running")),
    extensionReport: (section?: ExtensionSection): string => formatExtensionReport(extensionStatus(), section),
    extensionStatus: (): ExtensionStatus => extensionStatus(),
    listSkills: (): SkillDefinition[] => [...requireSkillBundle(skills).skills],
    captureRunResourceSnapshot: (runId: string): void => {
      runSkillSnapshots.set(runId, structuredClone(requireSkillBundle(skills)));
    },
    runSkillPaths: (runId: string): string[] => skillPathsForSelection(skillsForRun(runId)),
    releaseRunResourceSnapshot: (runId: string): void => { runSkillSnapshots.delete(runId); },
    listTools: (): RuntimeToolCatalogEntry[] => {
      const entries = toolRegistry.listEntries();
      const knownNames = new Set(entries.map(({ tool }) => tool.name));
      const extensionTools = [...resourceScope.createTools(), ...resourceScope.createResourceTools()]
        .filter((tool) => !knownNames.has(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description, source: "mcp" as const, risk: tool.risk,
          exposure: getToolExposure(tool), namespace: tool.namespace, parameters: tool.parameters, outputSchema: tool.outputSchema }));
      return [
        ...entries.map(({ source, tool }) => ({
          name: tool.name,
          description: tool.description,
          source,
          risk: tool.risk,
          exposure: getToolExposure(tool), namespace: tool.namespace, parameters: tool.parameters, outputSchema: tool.outputSchema
        })),
        ...extensionTools
      ];
    },
    refreshSkills,
    refreshExtensionTools,
    setBrowserAutomation,
    resourceSnapshot: (): RuntimeResourceReadiness => resourceScope.readiness(),
    subscribeResourceChanges: (listener: (snapshot: RuntimeResourceSnapshot) => void): (() => void) => resourceScope.subscribe(listener),
    listSubagentAgents: async (): Promise<SubagentDefinition[]> => {
      subagentDefinitions = await loadAgentDefinitions();
      return [...subagentDefinitions];
    },
    startSubagentTask,
    startTaskRun,
    resumeTaskRun,
    continueTaskRun,
    async canResumeWorkerTask(taskRunId) {
      const task = taskRuns.get(taskRunId);
      const attempt = task?.attempts.at(-1);
      const admission = readWorkerAttemptCheckpoint(attempt?.artifacts);
      if (!task || !attempt || !admission) return false;
      try {
        const { checkpoint, facts } = await readWorkerSessionCheckpoint(persistenceRoot, attempt.attemptId);
        return checkpoint.prompt === admission.prompt && facts.parentSessionId === task.sessionId;
      } catch { return false; }
    },
    runTaskWithVerification,
    cancelTaskRun,
    async startPlanDraft(graphId, revision, signal) {
      const graph = graphs.inspectGraph(graphId);
      if (graph.mode !== "supervised" || graph.supervisorSessionId !== agent.getInfo().sessionId || graph.status !== "draft" || graph.revision !== revision) {
        throw new Error("Plan draft is stale, started, or belongs to another session.");
      }
      // 仍通过同一个 PlanStart 工具入口，保留权限、审计和调度检查。
      const coordinator = new ToolExecutionCoordinator({
        workspaceRoot, config, recorder: agent.getSessionRecorder(), toolRegistry, permissionManager,
        confirmPermission: async (request) => ({ approved: !request.requireFullYes, action: "allow_once", scope: "once" }),
        runId: `plan-start:${graphId}:${String(revision)}`
      }, permissionManager, () => undefined, () => ({}), new Set(["PlanStart"]), { maxToolCalls: 1, maxRepeatedActions: 1 });
      const tool = coordinator.createAgentTools().find((entry) => entry.name === "PlanStart");
      if (!tool) throw new Error("PlanStart is unavailable.");
      const result = await tool.execute(randomUUID(), { graphId, revision }, signal);
      await coordinator.waitForIdle();
      await agent.getSessionRecorder().flush();
      if (result.isError) throw new Error(JSON.stringify(result.details));
      return result.details;
    },
    executeTaskCheck,
    refreshDailyDiary: async (dateKey: string, refreshOptions: { force?: boolean } = {}): Promise<unknown> => await agent.refreshDailyDiary(dateKey, refreshOptions),
    setSubagentParentRunId: (parentRunId?: string): void => {
      subagentParentRunId = parentRunId;
    },
    close: async () => {
      userInput.setRun();
      try {
        const wasOwner = backgroundOwners.values().next().value === backgroundOwner;
        backgroundOwner.stop();
        backgroundOwners.delete(backgroundOwner);
        if (wasOwner) backgroundOwners.values().next().value?.start();
        await subagentTaskManager?.close();
        await agent.close();
      } finally {
        try {
          await managedProcesses.close();
        } finally {
          try {
            await releaseResourceScope();
          } finally {
            try {
              automationStore.close();
            } finally {
              try {
                graphs.close();
                sessionGoals.close();
              } finally {
                try {
                  capabilities.close();
                } finally {
                  try {
                    taskCommunication.close();
                    taskRuns.close();
                  } finally {
                    runtimeAuthority.close();
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  return runtime;
}

function latestTaskCheckResult(
  events: readonly SessionEvent[],
  toolCallId: string
): Extract<SessionEvent, { type: "tool_result" }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "tool_result" && event.toolCallId === toolCallId) return event;
  }
  return undefined;
}

function hasSafeQueuedTaskContinuation(
  task: TaskRunWithAttempts,
  events: ReturnType<DurableTaskRunStore["events"]>
): boolean {
  const attempt = task.attempts.at(-1);
  const latestEvent = events.at(-1);
  if (!attempt || attempt.status !== "failed" || !latestEvent) return false;
  if (latestEvent.eventType === "task.retry") {
    const decision = evaluateTaskRetry({ ...task, status: "failed" });
    return decision.allowed && decision.attempt.attemptId === attempt.attemptId;
  }
  if (latestEvent.eventType !== "task.verification.repair") return false;
  const evidence = attempt.verification;
  const artifacts = typeof attempt.artifacts === "object" && attempt.artifacts !== null
    ? attempt.artifacts as { output?: unknown; definitionFingerprint?: unknown; artifactFingerprint?: unknown }
    : undefined;
  return latestEvent.attemptId === attempt.attemptId
    && isTaskVerificationEvidence(evidence)
    && evidence.status === "failed"
    && evidence.taskRunId === task.taskRunId
    && evidence.attemptId === attempt.attemptId
    && typeof artifacts?.output === "string"
    && artifacts.output.trim().length > 0
    && artifacts.definitionFingerprint === evidence.definitionFingerprint
    && artifacts.artifactFingerprint === evidence.artifactFingerprint;
}

function isTaskCheckSessionEvent(
  value: unknown
): value is Extract<SessionEvent, { type: "tool_call" | "tool_execution" | "tool_result" }> {
  if (typeof value !== "object" || value === null) return false;
  const event = value as { type?: unknown; toolCallId?: unknown };
  return (event.type === "tool_call" || event.type === "tool_execution" || event.type === "tool_result")
    && typeof event.toolCallId === "string";
}

function mergeTaskCheckEvents(
  durableEvents: readonly Extract<SessionEvent, { type: "tool_call" | "tool_execution" | "tool_result" }>[],
  currentSessionEvents: readonly SessionEvent[],
  toolCallIds: readonly string[],
  taskRunId: string,
  attemptId: string
): SessionEvent[] {
  const selected = new Set(toolCallIds);
  const seen = new Set(durableEvents.flatMap((event) => event.runtime?.eventId ? [event.runtime.eventId] : []));
  return [
    ...durableEvents,
    ...currentSessionEvents.filter((event) => {
      if ((event.type !== "tool_call" && event.type !== "tool_execution" && event.type !== "tool_result")
        || event.toolCallId === undefined
        || !selected.has(event.toolCallId)
        || event.runtime?.runId !== taskRunId
        || event.runtime.turnId !== attemptId) return false;
      const eventId = event.runtime?.eventId;
      return eventId === undefined || !seen.has(eventId);
    })
  ];
}

function finishTaskAttempt(
  taskRuns: DurableTaskRunStore,
  taskRunId: string,
  attemptId: string,
  status: "completed" | "incomplete" | "failed" | "aborted",
  input: { artifacts?: unknown; failure?: unknown }
): void {
  try {
    const current = taskRuns.get(taskRunId);
    if (current && !isTaskRunTerminal(current.status)) {
      taskRuns.transition(taskRunId, status, { attemptId, ...input });
    } else if (current?.status === status) {
      taskRuns.transition(taskRunId, status, { attemptId, ...input });
    }
  } catch {
    // Worker 结果已由 Session 事件记录；过时回调不能覆盖更新的 TaskRun 状态。
  }
}

class VerifiedTaskTurnStopped extends Error {
  constructor(
    readonly closureStatus: TaskClosureResult["status"],
    readonly outcome: AgentTurnOutcome
  ) {
    super(outcome.error ?? `Agent turn ended with ${outcome.status}.`);
  }
}

function closureStatusForTurn(status: AgentTurnOutcome["status"]): TaskClosureResult["status"] {
  if (status === "cancelled" || status === "aborted") return "cancelled";
  if (status === "blocked") return "blocked";
  return "incomplete";
}

function taskRunToolResult(task: TaskRunWithAttempts | undefined, result?: TaskClosureResult): Record<string, unknown> {
  if (!task) throw new Error("TaskRun disappeared before its result was projected.");
  const attempt = task.attempts.at(-1);
  const approval = pendingTaskVerificationApproval(attempt?.verification);
  const pendingCheck = approval === undefined || typeof attempt?.verification !== "object" || attempt.verification === null
    ? undefined
    : (attempt.verification as { checks?: Array<{ checkId?: string; command?: string; cwd?: string; reason?: string }> }).checks
      ?.find((check) => check.checkId === approval.checkId);
  const artifacts = typeof attempt?.artifacts === "object" && attempt.artifacts !== null
    ? attempt.artifacts as { output?: unknown }
    : undefined;
  return {
    taskRunId: task.taskRunId,
    status: task.status,
    revision: task.revision,
    attemptId: attempt?.attemptId,
    attempts: task.attempts.length,
    output: (result?.output ?? (typeof artifacts?.output === "string" ? artifacts.output : undefined))?.slice(0, 4000),
    outputTruncated: (result?.output ?? (typeof artifacts?.output === "string" ? artifacts.output : "")).length > 4000,
    reason: (result?.reason ?? taskFailureReason(attempt?.failure))?.slice(0, 2000),
    verification: typeof attempt?.verification === "object" && attempt.verification !== null
      ? { status: (attempt.verification as { status?: unknown }).status, evidence: "Inspect the TaskRun for full verification evidence." } : attempt?.verification,
    approval: approval === undefined ? undefined : {
      approvalId: approval.approvalId,
      checkId: approval.checkId,
      command: pendingCheck?.command,
      cwd: pendingCheck?.cwd ?? ".",
      reason: pendingCheck?.reason,
      taskRunId: approval.taskRunId,
      attemptId: approval.attemptId
    }
  };
}

function taskFailureReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function subagentModelSettings(config: AgentConfig, modelManager: ModelManager, modelAlias?: string): ModelSettings {
  // 具名定义的 model 覆盖优先于全局 subagent model；两者都未配置时沿用当前会话模型。
  const alias = modelAlias ?? config.extensions.subagent.model;
  if (!alias) return modelManager.getModelSettings();
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown subagent model alias: ${alias}`);
  if (model.supportsTools === false) throw new Error(`Subagent model ${alias} does not support tools.`);
  const reasoning = modelReasoningConfig(model);
  const modelConfig = {
    ...config,
    defaultModel: alias,
    thinking: reasoning
      ? { enabled: true, effort: reasoning.defaultEffort }
      : { enabled: false, effort: "high" as const }
  };
  return createModelSettings(modelConfig, alias);
}

function requireModelManager(modelManager: ModelManager | undefined): ModelManager {
  if (!modelManager) throw new Error("Model runtime is not initialized.");
  return modelManager;
}

function requireSkillBundle(skills: SkillBundle | undefined): SkillBundle {
  if (!skills) throw new Error("Skill runtime is not initialized.");
  return skills;
}

export async function withCommandRuntime(workspaceRoot: string, fn: (runtime: CommandRuntime) => Promise<void>): Promise<void> {
  const runtime = await createCommandRuntime(workspaceRoot);
  try {
    await fn(runtime);
  } catch (error) {
    // 命令层的异常统一落到 session，方便 resume 时看到失败原因。
    runtime.agent.recordError(error);
    throw error;
  } finally {
    await runtime.close();
  }
}
