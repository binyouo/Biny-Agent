/**
 * 命令运行时装配模块。
 *
 * 每个 CLI/TUI 入口最终都会通过这里创建一个 AgentSession。这里是 composition
 * root，只装配配置、provider、工具和权限，不向宿主泄露可变 conversation 或 recorder。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import type { AgentConfig } from "../config/schema.js";
import { AgentSession } from "../agent/AgentSession.js";
import { ModelManager } from "../llm/ModelManager.js";
import { resolveToolModel } from "../llm/toolModel.js";
import { preselectCapabilities } from "../agent/capabilityPreselection.js";
import { SessionRecorder, type SessionEvent } from "../session/recorder.js";
import { readSessionEvents } from "../session/events.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry } from "../tools/registry.js";
import { createTodoTool } from "../tools/todo.js";
import type { ActivitySettings } from "../activity/settings.js";

import { TodoStore } from "../session/todoStore.js";
import { CheckpointStore } from "../session/checkpointStore.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { createSkillResourceTool, createSkillTool, expandSkillCommand as expandSkillCommandText, type SkillBundle, type SkillDefinition } from "../extensions/skills.js";
import { createSkillInstallTool, createSkillSearchTool } from "../tools/skillDiscovery.js";
import { skillPathsForSelection, skillPromptForSelection } from "../extensions/skills.js";
import type { ToolRisk, ToolSource } from "../tools/types.js";
import { perfNow, recordPerfPhase } from "../observability/perfTiming.js";
import { loadPlugins, loadPluginsFromRoot } from "../extensions/plugins.js";
import type { McpToolHost } from "../extensions/mcp.js";
import { createSubagentTool, createTaskStatusTool, runSubagentTask as executeSubagentTask, type SubagentOptions } from "../extensions/subagent.js";
import { createPlanTools } from "../extensions/plan.js";
import { buildSubagentDefinitionsPrompt, loadSubagentDefinitions, type SubagentDefinition } from "../extensions/agents.js";
import { createMemoryTools } from "../extensions/memory.js";
import { createActivityReportTool } from "../tools/activity/report.js";
import { createActivityDigestTool } from "../tools/activity/digest.js";
import { createActivitySearchTool } from "../tools/activity/search.js";
import { createActivitySessionsTool } from "../tools/activity/sessions.js";
import { createToolCounts, formatExtensionReport, type ExtensionSection, type ExtensionStatus } from "../extensions/report.js";
import { createModelSettings, type ModelSettings } from "../llm/modelFactory.js";
import {
  SubagentTaskIncompleteError,
  SubagentTaskManager,
  type SubagentTaskRunOptions,
  type SubmittedSubagentTask
} from "./SubagentTaskManager.js";
import { ManagedProcessService } from "./ManagedProcessService.js";
import { subagentAccessMode } from "./subagentAccess.js";
import { modelReasoningConfig } from "../ai/capabilities.js";
import { attachmentRoot, ensureAttachmentRoot } from "../attachments/store.js";
import { AiRegistry } from "../llm/AiRegistry.js";
import { RuntimeEventAuthority } from "./RuntimeAuthority.js";
import { DurableTaskRunStore, isTaskRunTerminal, type TaskRetrySafety, type TaskRunWithAttempts } from "./TaskRunStore.js";
import { runTaskClosure, type TaskClosureResult } from "./TaskClosure.js";
import { AutomationStore } from "./AutomationScheduler.js";
import { GoalGraphStore } from "./GoalGraphStore.js";
import { CapabilityStore } from "./CapabilityStore.js";
import { RuntimeHostResourceScope, RuntimeResourceBaselinePendingError, type RuntimeHostResourceRegistry, type RuntimeResourceSnapshot, type RuntimeResourceReadiness } from "./host/resources.js";
import { listEnabledGlobalPluginPaths, listEnabledProjectPluginPaths } from "../extensions/pluginRegistry.js";
import { globalPluginRoot } from "../config/paths.js";
import { DailyDiaryScheduler } from "../agent/context/chatDiary.js";
import { HeartbeatScheduler } from "../agent/context/heartbeat.js";
import { createBrowserTools, type BrowserAutomationEndpoint } from "../tools/browser.js";
import { ToolExecutionCoordinator } from "../agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../agent/types.js";
import {
  isTaskVerificationPermissionResult,
  pendingTaskVerificationApproval,
  readTaskDefinition,
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
  capabilities: CapabilityStore;
  subagents: SubagentTaskManager | undefined;
  extensionReport(section?: ExtensionSection): string;
  /** 扩展实时状态的快照；`/status` 等命令的卡片和文本报告共用。 */
  extensionStatus(): ExtensionStatus;
  /** 当前可用于 TUI 补全的 Skill 元数据；正文仍按需加载。 */
  listSkills(): SkillDefinition[];
  /** 当前注册表的脱敏工具目录，供 Desktop 的单回合能力选择器使用。 */
  listTools(): RuntimeToolCatalogEntry[];
  /** 用户提交 `/skill:name` 后才读取并展开 Skill 正文。 */
  expandSkillCommand(input: string): Promise<string>;
  /** 每个新根回合前重新扫描 Skill，使新增和元数据修改无需重启即可生效。 */
  refreshSkills(): Promise<void>;
  /** 刷新共享 MCP/Skill 代理；回合开始前调用，避免活动回合看到半套工具。 */
  refreshExtensionTools?(): void;
  resourceSnapshot?(): RuntimeResourceReadiness;
  assertResourceBaselineReady?(): void;
  subscribeResourceChanges?(listener: (snapshot: RuntimeResourceSnapshot) => void): () => void;
  /** 实时重新扫描具名子代理定义（会话期间可编辑生效）。 */
  listSubagentAgents(): Promise<SubagentDefinition[]>;
  startSubagentTask(task: string, options?: SubagentTaskRunOptions): SubmittedSubagentTask;
  /** Host、Desktop fallback 与模型可见 Task 共用的唯一 TaskRun 派发入口。 */
  startTaskRun(taskRunId: string, options?: { retrySafety?: TaskRetrySafety }): Promise<{
    task: TaskRunWithAttempts;
    completion: Promise<TaskClosureResult>;
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
  setSubagentParentRunId(parentRunId?: string): void;
  close(): Promise<void>;
}

export interface RuntimeToolCatalogEntry {
  name: string;
  description: string;
  source: ToolSource;
  risk?: ToolRisk;
}

// 日报和心跳是进程级后台工作；增加 Session 不能增加相同工作的计时器。
// 当前承载实例关闭后交给下一个存活实例，避免 LRU/配置重建停掉后台工作。
const backgroundOwners = new Set<{ start(): void; stop(): void }>();

export interface CommandRuntimeOptions {
  persistenceRoot?: string;
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
  const resourceScope = options.resourceScope
    ?? options.resourceRegistry?.acquire(workspaceRoot, config)
    ?? new RuntimeHostResourceScope(workspaceRoot, config);
  let skills: SkillBundle = resourceScope.skills;
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
  const capabilities = await CapabilityStore.open(persistenceRoot, runtimeAuthority);
  const recorder = new SessionRecorder(persistenceRoot, options.sessionId, undefined, runtimeAuthority.asSink());
  const managedProcesses = new ManagedProcessService({ workspaceRoot, persistenceRoot });
  await managedProcesses.initialize();
  const toolRegistry = createToolRegistry(
    { workspaceRoot, ignore: config.workspace.ignore, attachmentRoot: projectAttachmentRoot },
    config.web.search,
    managedProcesses,
    config.web.fetch,
    config.sandbox,
    config.web.cookies,
    () => resolveToolModel(config)
  );
  if (options.browserAutomation) {
    for (const tool of createBrowserTools(options.browserAutomation)) toolRegistry.registerBuiltinTool(tool);
  }
  // 快照挂在工作区的 git 仓库上；非 git 目录下这项能力直接不可用。
  const checkpoints = config.checkpoints.enabled ? await CheckpointStore.open(workspaceRoot) : undefined;
  const todos = new TodoStore(persistenceRoot, recorder.sessionId);
  await todos.initialize();
  toolRegistry.registerBuiltinTool(createTodoTool(todos));
  const permissionManager = new PermissionManager({ ...config.permission, source: "global config.json + project .biny/settings.json" });
  const mcpHost = resourceScope.mcp;
  let agent: AgentSession | undefined;
  let modelManager: ModelManager | undefined;
  let subagentParentRunId: string | undefined;
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
  let startTaskRun: CommandRuntime["startTaskRun"] = async () => {
    throw new Error("TaskRun execution is not initialized.");
  };
  let cancelTaskRun: CommandRuntime["cancelTaskRun"] = () => {
    throw new Error("TaskRun cancellation is not initialized.");
  };
  const refreshExtensionTools = (): void => {
    for (const name of registeredMcpTools) toolRegistry.unregister(name);
    registeredMcpTools = [];
    for (const tool of [...resourceScope.createTools(), ...resourceScope.createResourceTools()]) {
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
    getAccessMode: () => subagentAccessMode(permissionManager),
    getParentRunId: () => subagentParentRunId,
    loadAgentDefinitions,
    toolRegistry,
    onUsage: async (usage, operation, modelAlias) => agent?.observeModelUsage(usage, operation, modelAlias),
    runVerifiedTask: async (input, context) => {
      const sessionId = context.sessionId ?? recorder.sessionId;
      const taskRunId = `agent-task:${sessionId}:${context.toolCallId}`;
      taskRuns.create({
        taskRunId,
        sessionId,
        parentRunId: context.runId ?? subagentParentRunId,
        task: {
          prompt: input.task,
          constraints: input.constraints,
          agent: input.agent,
          verification: input.verification
        }
      });
      const abort = (): void => {
        try { cancelTaskRun(taskRunId, "Parent Agent run was cancelled."); } catch { /* 终态或并发取消以持久化状态为准。 */ }
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      try {
        const started = await startTaskRun(taskRunId);
        const result = await started.completion;
        return taskRunToolResult(taskRuns.get(taskRunId), result);
      } finally {
        context.signal?.removeEventListener("abort", abort);
      }
    },
    readTaskResult: async (taskRunId, context) => {
      const task = taskRuns.get(taskRunId);
      if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
      const sessionId = context.sessionId ?? recorder.sessionId;
      if (task.sessionId !== sessionId) throw new Error(`TaskRun ${taskRunId} belongs to another session.`);
      return taskRunToolResult(task);
    }
  };
  const subagentTaskManager = config.extensions.subagent.enabled
    ? new SubagentTaskManager({
      maxConcurrentSubagents: config.extensions.subagent.maxConcurrentSubagents,
      maxPendingSubagents: config.extensions.subagent.maxPendingSubagents,
      timeoutMs: config.extensions.subagent.timeoutMs,
      onSnapshot: (snapshot) => {
        taskRuns.syncSubagentSnapshot(snapshot, durableSubagentBindings.get(snapshot.taskId));
      },
      execute: async (task, context) => await executeSubagentTask(subagentOptions, task, context.signal, context.accessMode, context.agent)
    })
    : undefined;
  const loadedPlugins: string[] = [];
  try {
    // Desktop Host 的 MCP/Skill 启动在后台进行；私有 CLI/TUI runtime 仍在这里等待首个稳定快照。
    if (resourceBoot === "blocking") await resourceStart;
    skills = resourceScope.skills;
    toolRegistry.registerUserTool(createSkillTool(() => requireSkillBundle(skills)));
    toolRegistry.registerUserTool(createSkillResourceTool(() => requireSkillBundle(skills)));
    toolRegistry.registerBuiltinTool(createSkillSearchTool({
      getInstalledNames: () => {
        const installed = new Set<string>();
        for (const skill of requireSkillBundle(skills).skills) {
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
    if (config.extensions.subagent.enabled) {
      toolRegistry.registerSubagentTool(createSubagentTool(subagentOptions, subagentTaskManager!));
      toolRegistry.registerSubagentTool(createTaskStatusTool(subagentOptions));
      for (const tool of createPlanTools({
        graphs,
        taskRuns,
        isPlanning: () => agent?.getInfo().planning === true,
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
    // Activity 回忆改为主动工具集：模型按需生成打工日记、时间线或搜索，而不是把脱敏事件
    // 注入每个回合。模型、策略与嵌入运行时都在调用时现取，不沿用装配时的快照。
    const loadActivitySettings = async (): Promise<ActivitySettings> =>
      (await configStore.load(workspaceRoot)).activity;

    const getActivityChatModel = () => modelManager?.getModel();
    toolRegistry.registerBuiltinTool(createActivityReportTool({
      getChatModel: getActivityChatModel,
      getModel: async () => resolveToolModel(await configStore.load(workspaceRoot)),
      loadSettings: loadActivitySettings
    }));
    toolRegistry.registerBuiltinTool(createActivityDigestTool({
      getChatModel: getActivityChatModel,
      loadSettings: loadActivitySettings
    }));
    toolRegistry.registerBuiltinTool(createActivitySearchTool({
      getChatModel: getActivityChatModel,
      loadSettings: loadActivitySettings,
      getEmbeddingRuntime: async () => await agent?.getActivityEmbeddingRuntime()
    }));
    toolRegistry.registerBuiltinTool(createActivitySessionsTool({ loadSettings: loadActivitySettings, getChatModel: getActivityChatModel }));
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
      skillPrompt: (selection) => skillPromptForSelection(requireSkillBundle(skills), selection),
      subagentPrompt: buildSubagentDefinitionsPrompt(subagentDefinitions),
      skillPaths: (selection) => skillPathsForSelection(requireSkillBundle(skills), selection),
      selectCapabilities: async (input) => await preselectCapabilities({
        ...input, model: resolveToolModel(input.config), tools: toolRegistry.list(), skills: requireSkillBundle(skills).skills
      }),
      mcpPrompt: () => mcpHost.instructionsPrompt(),
      todoStore: todos,
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
    capabilities.close();
    taskRuns.close();
    runtimeAuthority.close();
    throw error;
  }
  if (!agent) throw new Error("Failed to initialize Biny agent runtime.");

  const dailyDiaryAgent = agent;
  const dailyDiaryScheduler = new DailyDiaryScheduler({
    run: async (dateKeys, signal) => {
      for (const dateKey of dateKeys) {
        await dailyDiaryAgent.refreshDailyDiary(dateKey, { signal }).catch(() => undefined);
      }
    }
  });
  const heartbeat = new HeartbeatScheduler({
    configDir: undefined,
    enabled: config.heartbeat.enabled,
    schedule: {
      intervalMinutes: config.heartbeat.intervalMinutes,
      activeHoursStart: config.heartbeat.activeHoursStart,
      activeHoursEnd: config.heartbeat.activeHoursEnd
    },
    run: async (prompt, signal) => {
      await dailyDiaryAgent.runTask(prompt, { abortSignal: signal, runId: randomUUID(), turnId: randomUUID(), emotionAnalysis: false });
    }
  });
  const backgroundOwner = {
    start: (): void => { dailyDiaryScheduler.start(); heartbeat.start(); },
    stop: (): void => { dailyDiaryScheduler.stop(); heartbeat.stop(); }
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
    if (agent.getInfo().planning) throw new Error("Planning mode forbids delegation.");
    if (!config.extensions.subagent.enabled) throw new Error("Subagent extension is disabled in config.json.");
    if (!subagentTaskManager) throw new Error("Subagent runtime is unavailable.");
    const taskId = taskOptions?.taskId ?? randomUUID();
    agent.recordHostedUserMessage(task);
    const sequence = agent.recordHostedToolCall("Task", taskOptions?.agent ? { task, agent: taskOptions.agent } : { task }, taskId);
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
      agent.recordHostedToolResult("Task", { error: failure.message }, taskId, sequence);
      throw failure;
    }

    const completion = submitted.completion.then(
      (result) => {
        agent.recordHostedToolResult("Task", result, taskId, sequence);
        agent.recordHostedAssistantMessage(result);
        return result;
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        agent.recordHostedToolResult("Task", { error: failure.message }, taskId, sequence);
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

  startTaskRun = async (
    taskRunId: string,
    taskOptions: { retrySafety?: TaskRetrySafety } = {}
  ): Promise<{ task: TaskRunWithAttempts; completion: Promise<TaskClosureResult> }> => {
    if (agent.getInfo().planning) throw new Error("Planning mode forbids TaskRun execution.");
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
    if (current.status === "running") {
      if (closureRequired) {
        current = taskRuns.transition(taskRunId, "blocked", {
          attemptId: current.attempts.at(-1)?.attemptId,
          failure: {
            failureClass: "unsafe_recovery",
            message: "A TaskRun with required closure cannot replay an unproven running Attempt."
          }
        });
        return { task: current, completion: Promise.resolve({ status: "blocked" }) };
      }
      current = taskRuns.requeue(taskRunId);
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
      signal: controller.signal,
      executeAttempt: async (prompt, attempt) => {
        let submitted;
        try {
          submitted = startSubagentTask(prompt, {
            taskId: closureRequired ? attempt.attemptId : taskRunId,
            taskRunId,
            attemptId: attempt.attemptId,
            completedStatus: closureRequired ? "verifying" : "completed",
            parentRunId: latest.parentRunId,
            signal: controller.signal,
            accessMode: definition.review || definition.reportOnly ? "read-only" : "workspace",
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
        }
      }
    }).finally(() => {
      if (durableTaskPromises.get(taskRunId) === completion) durableTaskPromises.delete(taskRunId);
      if (durableTaskControllers.get(taskRunId) === controller) durableTaskControllers.delete(taskRunId);
    });
    durableTaskPromises.set(taskRunId, completion);
    void completion.catch(() => undefined);
    return { task: latest, completion };
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
    return taskRuns.transition(taskRunId, "cancelled", { attemptId: current.attempts.at(-1)?.attemptId });
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
    if (agent.getInfo().planning) throw new Error("Planning mode forbids verification commands.");
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
    capabilities,
    subagents: subagentTaskManager,
    extensionReport: (section?: ExtensionSection): string => formatExtensionReport(extensionStatus(), section),
    extensionStatus: (): ExtensionStatus => extensionStatus(),
    listSkills: (): SkillDefinition[] => [...requireSkillBundle(skills).skills],
    listTools: (): RuntimeToolCatalogEntry[] => {
      const entries = toolRegistry.listEntries();
      const knownNames = new Set(entries.map(({ tool }) => tool.name));
      const extensionTools = [...resourceScope.createTools(), ...resourceScope.createResourceTools()]
        .filter((tool) => !knownNames.has(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description, source: "mcp" as const, risk: tool.risk }));
      return [
        ...entries.map(({ source, tool }) => ({
          name: tool.name,
          description: tool.description,
          source,
          risk: tool.risk
        })),
        ...extensionTools
      ];
    },
    expandSkillCommand: async (input: string): Promise<string> => await expandSkillCommandText(requireSkillBundle(skills), input),
    refreshSkills,
    refreshExtensionTools,
    resourceSnapshot: (): RuntimeResourceReadiness => resourceScope.readiness(),
    assertResourceBaselineReady: (): void => {
      if (!resourceScope.isReadyForSubmission()) throw new RuntimeResourceBaselinePendingError();
    },
    subscribeResourceChanges: (listener: (snapshot: RuntimeResourceSnapshot) => void): (() => void) => resourceScope.subscribe(listener),
    listSubagentAgents: async (): Promise<SubagentDefinition[]> => {
      subagentDefinitions = await loadAgentDefinitions();
      return [...subagentDefinitions];
    },
    startSubagentTask,
    startTaskRun,
    cancelTaskRun,
    async startPlanDraft(graphId, revision, signal) {
      const graph = graphs.inspectGraph(graphId);
      if (graph.mode !== "supervised" || graph.supervisorSessionId !== agent.getInfo().sessionId || graph.status !== "draft" || graph.revision !== revision) {
        throw new Error("Plan draft is stale, started, or belongs to another session.");
      }
      const wasPlanning = agent.getInfo().planning === true;
      // 点击开始只授权这个已展示版本的 PlanStart；仍经过策略 deny、审计及工具调度，
      // 不产生 Bash/验收检查的授权。调用方持有会话维护锁。
      await agent.setPlanning(false);
      try {
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
      } catch (error) {
        if (graphs.inspectGraph(graphId).status === "draft") await agent.setPlanning(wasPlanning);
        throw error;
      }
    },
    executeTaskCheck,
    refreshDailyDiary: async (dateKey: string, refreshOptions: { force?: boolean } = {}): Promise<unknown> => await agent.refreshDailyDiary(dateKey, refreshOptions),
    setSubagentParentRunId: (parentRunId?: string): void => {
      subagentParentRunId = parentRunId;
    },
    close: async () => {
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
              } finally {
                try {
                  capabilities.close();
                } finally {
                  try {
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
    attemptId: attempt?.attemptId,
    attempts: task.attempts.length,
    output: result?.output ?? (typeof artifacts?.output === "string" ? artifacts.output : undefined),
    reason: result?.reason ?? taskFailureReason(attempt?.failure),
    verification: attempt?.verification,
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
