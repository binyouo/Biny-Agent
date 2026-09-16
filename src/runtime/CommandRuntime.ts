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
import { SessionRecorder } from "../session/recorder.js";
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
import { createSubagentTool, runSubagentTask as executeSubagentTask, type SubagentOptions } from "../extensions/subagent.js";
import { buildSubagentDefinitionsPrompt, loadSubagentDefinitions, type SubagentDefinition } from "../extensions/agents.js";
import { createMemoryTools } from "../extensions/memory.js";
import { createActivityReportTool } from "../tools/activity/report.js";
import { createActivityDigestTool } from "../tools/activity/digest.js";
import { createActivitySearchTool } from "../tools/activity/search.js";
import { createActivitySessionsTool } from "../tools/activity/sessions.js";
import { createToolCounts, formatExtensionReport, type ExtensionSection, type ExtensionStatus } from "../extensions/report.js";
import { createNativeModelSettings, type NativeModelSettings } from "../llm/nativeFactory.js";
import {
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
import { DurableTaskRunStore } from "./TaskRunStore.js";
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
import { recoverTaskCheckExecution, taskCheckToolCallId, type TaskCommandExecution } from "./taskVerification.js";

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
  /** Task 验收只允许通过与 Agent 相同的 Bash 权限、调度、审计和取消链执行。 */
  executeTaskCheck(input: {
    command: string;
    checkId: string;
    contractFingerprint: string;
    cwd?: string;
    timeoutMs?: number;
    taskRunId: string;
    attemptId: string;
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
    onUsage: async (usage, operation, modelAlias) => agent?.observeModelUsage(usage, operation, modelAlias)
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

  const executeTaskCheckOnce = async (input: {
    command: string;
    checkId: string;
    contractFingerprint: string;
    cwd?: string;
    timeoutMs?: number;
    taskRunId: string;
    attemptId: string;
    signal?: AbortSignal;
  }): Promise<TaskCommandExecution> => {
    await recorder.flush();
    const recovery = recoverTaskCheckExecution(await readSessionEvents(recorder.filePath), recorder.sessionId, input);
    if (recovery.action !== "execute") return recovery.execution;
    const toolCallId = recovery.toolCallId;
    const events: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
    const coordinator = new ToolExecutionCoordinator(
      {
        workspaceRoot,
        config,
        recorder,
        toolRegistry,
        permissionManager,
        // 后台验收不能弹出隐藏的交互确认；未预授权时保留拒绝证据并阻塞 TaskRun。
        confirmPermission: async () => ({ approved: false, message: "Task verification requires explicit permission for this command." }),
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
    const lifecycle = [...events].reverse().find((event) =>
      (event.type === "tool.completed" || event.type === "tool.failed") && event.toolCallId === toolCallId
    );
    return {
      result: response.details ?? response,
      toolCallId,
      operationId: lifecycle && "operationId" in lifecycle ? lifecycle.operationId : undefined,
      eventReferences: [toolCallId, lifecycle && "operationId" in lifecycle ? lifecycle.operationId : undefined]
        .filter((reference): reference is string => reference !== undefined)
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

function subagentModelSettings(config: AgentConfig, modelManager: ModelManager, modelAlias?: string): NativeModelSettings {
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
  return createNativeModelSettings(modelConfig, alias);
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
