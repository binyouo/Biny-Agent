import type { MaskRecord, MaskingOverview } from "../../../privacy/record.js";
import { TaskCommunication, type TaskInspection, type TaskInspectionOptions } from "../../../runtime/TaskCommunication.js";
import { readAttachment } from "../../../attachments/store.js";
/**
 * 桌面端 agent 运行时管理。
 *
 * 每个项目一个 Host client，按需创建并缓存在 runtimes 中。
 * 根据凭据存储能力，Host 可在当前 Electron 进程内运行、独立启动，或复用其他客户端的 owner。
 * 多 session 的注册、创建、回收和事件路由统一由 Runtime Host 负责。
 *
 * 几处需要注意的状态：
 * - `runtimeInitializations` 缓存正在创建中的 promise，避免并发请求把同一个项目初始化两次；
 * - `liveEvents` 暂存本轮的实时事件，界面重新打开会话时要把它们接在历史事件后面；终态事件
 *   已经随 session 落盘后会清掉对应缓存，避免刷新时把同一轮再次拼到历史后面；
 * - `runtimeErrors` 记住初始化失败原因，让界面能显示「为什么这个项目起不来」而不是一直转圈。
 *
 * 模型配置的保存与连通性测试也在这里：写入前先用候选配置实际发一次请求，避免存下一份用不了的配置。
 */
import type { AgentAttachment } from "../../../agent/AgentSession.js";
import { generateText } from "ai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { planStatus } from "../../../extensions/plan.js";
import { TodoStore } from "../../../session/todoStore.js";
import type { AgentCapabilitySelection } from "../../../agent/capabilitySelection.js";
import type {
  MemoryArchiveEntriesResult,
  MemoryEntriesResult,
  MemoryMaintenanceStatus,
  MemoryEntry,
  MemorySimilarSearchOptions,
  MemoryOverview,
  MemorySearchResult
} from "../../../agent/context/memoryTypes.js";
import { MemoryStorage } from "../../../agent/context/memoryStorage.js";
import { AgentMemoryClient } from "../../../runtime/memory/client.js";
import { resolveToolModelAlias } from "../../../llm/toolModel.js";
import { IdentityStorage } from "../../../agent/context/identityStorage.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ModelCatalogEntry } from "../../../ai/types.js";
import { effectiveThinkingSelection, modelThinkingLevelMap, projectThinkingSelectionToModel } from "../../../ai/capabilities.js";
import { providerDefinition } from "../../../ai/provider.js";
import { builtinProviderModels } from "../../../ai/builtinModels.js";
import { loadProjectSettings } from "../../../config/projectSettings.js";
import { globalAgentDir, globalConfigDir } from "../../../config/paths.js";
import { createProjectSkillKey } from "../../../extensions/skillRef.js";
import { synchronizeCredentialRevisions, type DeferredCredentialTransactionStatus } from "../../../config/credentials.js";
import { configSchema, reasoningEffortSchema, type AgentConfig, type ProviderConfig } from "../../../config/schema.js";
import { AcpClient, acpMcpServers } from "../../../acp/client.js";
import type { AgentConfigStore } from "../../../config/store.js";
import { configChangeRequiresRuntimeRestart, configDocumentRevision } from "../../../config/versioned.js";
import { createModelSettings, validateModelConfiguration } from "../../../llm/modelFactory.js";
import { ModelRuntime } from "../../../llm/ModelRuntime.js";
import { LocalEmbeddingManager, listLocalEmbeddingModels } from "../../../llm/embedding/LocalEmbeddingRuntime.js";
import { listProviderEmbeddingModels } from "../../../llm/embedding/ProviderEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, LocalEmbeddingModelId } from "../../../llm/embedding/types.js";
import { selectMemoryEmbeddingModel } from "../../../llm/embedding/selectMemoryModel.js";
import { MemoryVectorIndex } from "../../../agent/context/MemoryVectorIndex.js";
import { MemoryEmbeddingService, type MemoryEmbeddingRuntimeStatus } from "../../../agent/context/MemoryEmbeddingService.js";
import { FileModelsStore, restoreProviderCatalogs, type ModelsStore } from "../../../llm/ModelsStore.js";
import { filterPickerModelChoices, listConfiguredModelChoices, listPickerModelChoices, modelRuntimeInfo, saveModelSelection, type ModelRuntimeInfo, type ThinkingSelection } from "../../../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import type { UserInputResponse } from "../../../runtime/userInput.js";
import type { BrowserAutomationEndpoint } from "../../../tools/browser.js";
import { createToolRegistry } from "../../../tools/registry.js";
import { runtimeCommandOperation } from "../../../runtime/commands.js";
import { SessionGoalStore, type SessionGoalExpected } from "../../../runtime/SessionGoalStore.js";
import type { AgentRunOutcome } from "../../../runtime/InteractiveAgentRuntime.js";
import { SubagentTaskManager } from "../../../runtime/SubagentTaskManager.js";
import { buildInspectorTask, type InspectorMessage } from "../../inspectorTask.js";
import {
  connectOrSpawnRuntimeHostWithOwnership,
  connectRuntimeHost,
  errorFromHostOperation,
  startRuntimeHost,
  RuntimeHostClient,
  type HostOperationResult,
  type RuntimeHostServer
} from "../../../runtime/RuntimeHost.js";
import { createRuntimeHostFactory } from "../../../runtime/host/runtimeFactory.js";
import { isSessionWriterConflictError } from "../../../runtime/SessionLease.js";
import { RuntimeHostProtocolMismatchError, RuntimeHostStartupError, RuntimeHostUnavailableError } from "../../../runtime/host/errors.js";
import { runtimeHostSpawnCircuitFor } from "../../../runtime/host/reconnect.js";
import { runtimeHostPaths } from "../../../runtime/host/lifecycle.js";
import {
  deleteSessionCatalogRecord,
  readSessionCatalogRecord,
  sessionCatalogRecordRevision,
  SESSION_CATALOG_MISSING_REVISION,
  writeSessionCatalogRecord,
  type SessionCatalogRecord
} from "../../../session/catalog.js";
import { readSessionEvents } from "../../../session/events.js";
import { openRecipeSuggestions, recipeIds, RecipeStateStore, type RecipeId } from "../../../session/recipes.js";
import { resolveSessionFile } from "../../../session/store.js";
import { AutomationStore, type AutomationRecord } from "../../../runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../../../runtime/RuntimeAuthority.js";
import {
  defaultChatPersonalizationOverride,
  type AgentPersonalizationState,
  type GlobalPersonalizationUpdate
} from "../../../personalization/index.js";
import { activeRun, isTerminalRunEvent, pendingPermission, runtimeIsBusy, type AgentHostEvent, type AgentRuntimeUpdate, type InteractiveRuntimeSnapshot } from "../../../runtime/agentEvents.js";
import { DurableTaskRunStore } from "../../../runtime/TaskRunStore.js";
import { splitAttachmentReferences } from "../../attachmentReferences.js";
import type {
  DesktopAttachment,
  DesktopChatPersonalizationOverride,
  DesktopEmbeddingModelDescriptor,
  DesktopGitBranch,
  DesktopMemoryEmbeddingCancellationResult,
  DesktopMemoryEmbeddingDeleteResult,
  DesktopMemoryEmbeddingStatus,
  DesktopMemoryArchivePage,
  DesktopMemoryArchiveMutationResult,
  DesktopMemoryEntry,
  DesktopMemoryEntryInput,  DesktopMemoryEntryPatch,
  DesktopMemoryEntriesPage,
  DesktopMemoryOverview,
  DesktopMemoryStats,
  DesktopMemorySearchMatch,
  DesktopMemorySettingsInput,
  DesktopMemorySettingsSnapshot,
  DesktopIdentityDocumentKind,
  DesktopIdentityOverview,
  DesktopModelCatalogResult,
  DesktopModelConfigurationInput,
  DesktopModelConnection,
  DesktopModelConnectionTestResult,
  DesktopCustomProviderInput,
  DesktopModelLoginProvider,
  DesktopModelLoginStartResult,
  DesktopPersonalizationOverview,
  DesktopProject,
  DesktopRecipeId,
  DesktopRecipeState,
  DesktopRecipeSuggestion,
  DesktopRunReceipt,
  DesktopRuntimeMutation,
  DesktopRuntimeError,
  DesktopRuntimeRetryResult,
  DesktopRuntimeProjection,
  DesktopSessionDocument,
  DesktopSessionTarget,
  DesktopSessionDeleteResult,
  DesktopSessionWriterConflict,
  DesktopSessionSummary,
  DesktopSessionTreePage,
  DesktopSessionTreePageOptions,
  DesktopSlashResult,
  DesktopWebSearchSettings,
  DesktopWorktreeStatus,
  DesktopSettingsChatSnapshot,
  DesktopSettingsCredentialScope,
  DesktopSettingsModelsSnapshot,
  DesktopSkillSettings,
  DesktopToolCatalogEntry,
  DesktopSettingsSaveInput,
  DesktopStagedModelLoginResult,
  DesktopStagedSettingsCredential,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { McpToolHost, type McpServerDetails, type McpServerStatus } from "../../../extensions/mcp.js";
import { attachDesktopComputerMcp } from "../../../computer/desktopMcp.js";
import type { AutomationCreateInput } from "../../../runtime/AutomationScheduler.js";
import { GoalGraphStore } from "../../../runtime/GoalGraphStore.js";
import { CapabilityStore } from "../../../runtime/CapabilityStore.js";
import { WorktreeManager, type WorktreeStatusView } from "../../../runtime/host/worktree.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopModelLoginService, type AuthenticatedModelLogin } from "./DesktopModelLoginService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { perfNow, recordPerfPhase } from "../../../observability/perfTiming.js";

interface ManagedRuntime {
  runtime: RuntimeHostClient;
  host?: RuntimeHostServer;
  unsubscribe(): void;
}

const SETTINGS_CREDENTIAL_TTL_MS = 30 * 60 * 1000;

/** Desktop 预热的 Host 在窗口关闭/切走后最多驻留的宽限；活跃项目由 keepAlive 常驻。 */
const DESKTOP_HOST_IDLE_GRACE_MS = 10 * 60 * 1000;

type StagedSettingsCredential =
  | {
      kind: "api-key";
      secret: string;
      expiresAt: number;
      scope: DesktopSettingsCredentialScope;
    }
  | {
      kind: "oauth-login";
      projectId: string;
      authenticated: AuthenticatedModelLogin;
      expiresAt: number;
    };

export interface DesktopSettingsConfigSnapshot {
  revision: string;
  activity: AgentConfig["activity"];
  identity: AgentConfig["context"]["identity"];
  memory: AgentConfig["context"]["memory"];
  compaction: AgentConfig["context"]["compaction"];
  chatParams: AgentConfig["chat"];
  rtkEnabled?: boolean;
  toolExecutionMode: AgentConfig["agent"]["toolExecutionMode"];
  subagent: import("../../protocol.js").DesktopSubagentSettings;
  externalSubagentBlockers: string[];
  permission: AgentConfig["permission"];
  webSearch: DesktopWebSearchSettings;
  redaction: AgentConfig["redaction"];
  models: DesktopSettingsModelsSnapshot;
  skills?: DesktopSkillSettings;
}

export interface PreparedDesktopSettingsConfig {
  projectId: string;
  workspaceRoot: string;
  before: AgentConfig;
  after: AgentConfig;
  beforeRevision: string;
  targetRevision: string;
  credentialHandles: string[];
}

export interface PreparedDesktopSettingsChat {
  projectId: string;
  persistenceRoot: string;
  sessionId: string;
  before?: SessionCatalogRecord;
  after: SessionCatalogRecord;
  beforeRevision: string;
  targetRevision: string;
}

export class DesktopAgentManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly runtimeInitializations = new Map<string, Promise<ManagedRuntime | undefined>>();
  /** Disposal retires an admission identity; pending promises remain owned until cleanup settles. */
  private readonly runtimeLifetimes = new Map<string, symbol>();
  private readonly projectDisposals = new Map<string, Promise<void>>();
  private activeProjectId?: string;
  private readonly liveEvents = new Map<string, Map<string, AgentHostEvent[]>>();
  private readonly runtimeErrors = new Map<string, DesktopRuntimeError>();
  private readonly writerConflicts = new Map<string, DesktopSessionWriterConflict>();
  /** Renderer 用 undefined 表示空白草稿；主进程仍需记住它实际对应的 session runtime。 */
  private readonly draftSessionIds = new Map<string, string>();
  /** 侧栏工作使用独立 session，不能占用或污染主对话。并发初始化共用一个 promise。 */
  private readonly inspectorSessions = new Map<string, Promise<string>>();
  /** 同一发送/编辑操作键复用 Promise，避免 IPC 重入再次产生用户消息或分叉会话。 */
  private readonly idempotentPromptRequests = new Map<string, Promise<DesktopRunReceipt>>();
  private idleRuntimeRebuildTail: Promise<void> = Promise.resolve();
  private readonly pendingSessionReads = new Map<string, {
    initialRevision: string | undefined;
    promise: Promise<SessionCatalogRecord>;
  }>();
  /** 置顶等操作可提前消费 revision 映射，退出仍需独立排空派生索引发布。 */
  private readonly pendingSessionReadPublications = new Set<Promise<void>>();
  private readonly modelLoginOperations = new Map<string, AbortController>();
  private readonly stagedSettingsCredentials = new Map<string, StagedSettingsCredential>();
  private readonly modelLogin: DesktopModelLoginService;
  private readonly identityStorage = new IdentityStorage();
  private closing = false;

  constructor(
    private readonly state: DesktopStateStore,
    private readonly projects: DesktopProjectService,
    private readonly configStore: AgentConfigStore,
    private readonly emit: (projectId: string, update: AgentRuntimeUpdate, meta?: { sessionId?: string; primary?: boolean }) => void,
    openExternal?: (url: string) => Promise<void>,
    private readonly modelsStore: ModelsStore = new FileModelsStore(),
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
    private readonly browserAutomation?: BrowserAutomationEndpoint,
    private readonly runtimeHostAppPath?: string
  ) {
    this.modelLogin = new DesktopModelLoginService(openExternal ?? (async () => {
      throw new Error("当前环境无法打开浏览器。");
    }), this.fetcher);
  }

  /** Activity 的记忆模型与索引独立于聊天 Session，后台分析不强行启动 Runtime。 */
  async findMemorySimilarEntries(
    query: string,
    options: MemorySimilarSearchOptions
  ): Promise<MemoryEntry[] | undefined> {
    return await this.memoryOwner().findSimilarInScope(query, options);
  }

  /** Activity 事实已经写入 SQLite 后，尽力把它投影进现有的全局向量索引。 */
  async indexActivityMemoryEntry(entry: MemoryEntry): Promise<void> {
    await this.memoryOwner().indexEntry(entry);
  }

  private memoryOwner(): AgentMemoryClient {
    return new AgentMemoryClient(globalAgentDir(), this.configStore.configPath
      ? path.dirname(this.configStore.configPath()) : undefined);
  }

  async prepareWorkspace(projectId: string): Promise<DesktopWorkspaceSnapshot> {
    const previousProjectId = this.activeProjectId;
    const previous = previousProjectId === projectId ? undefined : this.residentRuntime(previousProjectId ?? "");
    this.activeProjectId = projectId;
    try {
      if (previous !== undefined) {
        const previousLifetime = this.runtimeLifetimes.get(previousProjectId!);
        void previous.runtime.setKeepAlive(false).catch((error) => {
          if (previousLifetime !== undefined && this.isRuntimeLifetimeCurrent(previousProjectId!, previousLifetime)
            && this.runtimes.get(previousProjectId!) === previous) this.recordRuntimeFailure(previousProjectId!, error);
        });
      }
      // 后台预热不阻塞首屏；发送等消费操作复用 getRuntime 的同一次初始化。
      this.prewarmRuntime(projectId);
    } catch (error) {
      this.recordRuntimeFailure(projectId, error);
    }
    return await this.workspaceSnapshot(projectId, false);
  }

  /** 后台预热：就绪后为当前项目建立保活，失败只记录，透出与显式入口共用 runtimeErrors 通道。 */
  private prewarmRuntime(projectId: string, lifetime = this.runtimeLifetime(projectId)): void {
    let warmed: ManagedRuntime | undefined;
    void this.getRuntime(projectId, true, lifetime).then(async (managed) => {
      warmed = managed;
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime) || !managed
        || this.runtimes.get(projectId) !== managed) return;
      await managed.runtime.setKeepAlive(this.activeProjectId === projectId);
    }).catch((error: unknown) => {
      if (this.isRuntimeLifetimeCurrent(projectId, lifetime)
        && (warmed === undefined || this.runtimes.get(projectId) === warmed)) this.recordRuntimeFailure(projectId, error);
    });
  }

  async retryRuntime(projectId: string, sessionId?: string): Promise<DesktopRuntimeRetryResult> {
    const lifetime = this.runtimeLifetime(projectId);
    const project = this.projects.requireProject(projectId);
    if (sessionId !== undefined) await this.projects.openSession(project, sessionId, [], new Map());
    const persistenceRoot = await this.projects.dataRoot(project);
    // 旧预热可能已捕获熔断错误，先等它结算，避免重试复用复位前的失败初始化。
    await this.runtimeInitializations.get(projectId)?.catch(() => undefined);
    if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) throw new Error("Project runtime was disposed.");
    const hadRuntimeFailure = this.runtimeErrors.has(projectId);
    runtimeHostSpawnCircuitFor(runtimeHostPaths(persistenceRoot).endpoint).reset();
    try {
      await this.configStore.load();
      const resident = this.residentRuntime(projectId);
      if (resident?.runtime instanceof RuntimeHostClient) await resident.runtime.retryConnection();
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) throw new Error("Project runtime was disposed.");
      const managed = sessionId === undefined
        ? await this.ensureRuntime(projectId)
        : await this.resolveSessionRuntime(projectId, sessionId, false);
      // 连接成功不代表旧 owner 能加载当前配置；在真正重建成功之前保留故障。
      if (hadRuntimeFailure) {
        await managed.runtime.restartRuntime(sessionId);
      }
      if (this.isRuntimeLifetimeCurrent(projectId, lifetime)) this.runtimeErrors.delete(projectId);
    } catch (error) {
      if (this.isRuntimeLifetimeCurrent(projectId, lifetime)) this.recordRuntimeFailure(projectId, error);
    }
    if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) throw new Error("Project runtime was disposed.");
    const document = sessionId === undefined ? undefined : await this.openSession(projectId, sessionId);
    return { workspace: await this.workspaceSnapshot(projectId, false), document };
  }

  private recordRuntimeFailure(projectId: string, error: unknown): void {
    if (isSessionWriterConflictError(error)) {
      this.writerConflicts.set(`${projectId}\0${error.sessionId}`, {
        sessionId: error.sessionId,
        ownerSurface: error.ownerSurface === "desktop" || error.ownerSurface === "tui" || error.ownerSurface === "cli"
          ? error.ownerSurface
          : undefined,
        ownerPid: error.ownerPid,
        conflictKind: error.conflictKind,
        runId: error.runId
      });
      return;
    }
    this.runtimeErrors.set(projectId, formatRuntimeInitializationError(error));
  }

  async workspaceSnapshot(projectId: string, refreshDetails = true): Promise<DesktopWorkspaceSnapshot> {
    // Keep lastOpenedAt stable on select/refresh so the sidebar order does not jump.
    const project = await this.projects.refreshStoredProject(projectId, refreshDetails);
    const managed = this.residentRuntime(projectId);
    const runtimeSnapshots = this.runtimeSnapshots(projectId);
    const [config, sessionData] = await Promise.all([
      this.configStore.load(project.path).catch(() => undefined),
      this.projects.listWorkspaceSessions(project, runtimeSnapshots, this.projectEvents(projectId))
    ]);
    const catalogs = config ? await restoreProviderCatalogs(Object.keys(config.providers), this.modelsStore, config.providers) : [];
    const models = config ? listConfiguredModelChoices(config, catalogs) : [];
    const pickerModels = filterPickerModelChoices(models);
    if (config && pickerModels.some((model) => model.alias === config.defaultModel)) {
      const info = modelRuntimeInfo(config, catalogs);
      pickerModels.sort((left, right) => Number(right.alias === info.modelAlias) - Number(left.alias === info.modelAlias));
      pickerModels[0] = { ...pickerModels[0]!, defaultThinking: info.thinking };
    }
    let runtimeProjection: DesktopRuntimeProjection | undefined;
    if (refreshDetails && managed && this.residentRuntime(projectId) === managed) {
      try {
        runtimeProjection = await this.readRuntimeProjection(managed);
      } catch (error) {
        if (!managed.runtime.isRetired) throw error;
      }
    }
    const runtime = this.residentRuntime(projectId)?.runtime;
    // 磁盘配置是跨 Desktop/TUI 共享的持久化来源；Runtime 快照只在配置不可读时兜底。
    // 这样调试客户端重开时不会被一个仍存活的旧 Host 内存快照改回 ask。
    const permissionMode = config?.permission.mode
      ?? runtime?.getSnapshot().permissionMode
      ?? "ask";
    return {
      project,
      sessions: sessionData.sessions,
      sessionPage: sessionData.sessionPage,
      selectedSessionId: this.state.selectedSessionId(projectId),
      runtime: runtime?.getSnapshot(),
      sessionRuntimes: Object.fromEntries(this.runtimeSnapshots(projectId).map((snapshot) => [snapshot.info.sessionId, snapshot])),
      runtimeError: this.runtimeErrors.get(projectId),
      memory: config?.context.memory,
      permissionMode,
      capabilityDefaults: {
        tools: config?.chat.defaultToolSelection ?? "auto",
        skills: config?.chat.defaultSkillSelection ?? "auto"
      },
      // 默认模型失效不等于整个应用没有模型。只要选择器里还有一个可用模型，
      // 用户就应能继续输入并切换过去，不能被“需要配置模型”状态锁死。
      requiresModelConfiguration: !config || pickerModels.length === 0,
      pickerModels,
      selectedModel: config && pickerModels.some((model) => model.alias === config.defaultModel) ? modelRuntimeInfo(config, catalogs) : undefined,
      models,
      connections: config ? describeModelConnections(config) : [],
      runtimeProjection
    };
  }

  async mcpStatuses(projectId: string): Promise<McpServerStatus[] | undefined> {
    const managed = this.residentRuntime(projectId);
    if (!managed) return undefined;
    return await managed.runtime.mcpStatus();
  }

  async toolCatalog(projectId: string): Promise<DesktopToolCatalogEntry[]> {
    const managed = await this.getRuntime(projectId, false);
    if (!managed) {
      const project = this.projects.requireProject(projectId);
      const config = await this.configStore.load(project.path);
      const registry = createToolRegistry(
        { workspaceRoot: project.path, ignore: config.workspace.ignore, attachmentRoot: this.projects.attachmentsRoot(project) },
        config.web.search, undefined, config.web.fetch, config.sandbox, config.web.cookies, undefined,
        this.browserAutomation ? { ...this.browserAutomation, projectId } : undefined
      );
      if (this.browserAutomation) {
        const catalog = new McpToolHost();
        try {
          await attachDesktopComputerMcp(catalog, { ...this.browserAutomation, projectId });
          for (const tool of catalog.createTools()) registry.registerMcpTool(tool);
        } finally { await catalog.close(); }
      }
      return registry.listEntries().map(({ source, tool }) => ({ name: tool.name, description: tool.description, source, risk: tool.risk, exposure: tool.exposure,
        namespace: tool.namespace ? { name: tool.namespace.name } : undefined }));
    }
    const entries = await managed.runtime.listTools();
    return entries.map(({ name, description, source, risk, exposure, namespace }) => ({ name, description, source, risk, exposure,
      namespace: namespace ? { name: namespace.name } : undefined }));
  }

  async mcpDetails(projectId: string, serverName: string): Promise<McpServerDetails> {
    const managed = await this.ensureRuntime(projectId);
    return await managed.runtime.mcpDetails(serverName);
  }

  async mcpReconnect(projectId: string, serverName: string): Promise<McpServerStatus> {
    const managed = await this.ensureRuntime(projectId);
    return await managed.runtime.mcpReconnect(serverName);
  }

  /** MCP 配置保存后的统一刷新入口；调用方先检查全局运行态。 */
  async refreshMcpRuntimes(): Promise<void> {
    await this.rebuildIdleManagedRuntimes();
  }

  /**
   * 侧栏首屏保留每个项目最近一页和全部置顶会话；子节点通过 listSessionTreePage 按需读取。
   * 这不会初始化其它项目的 runtime。
   */
  async sidebarSessions(workspace?: DesktopWorkspaceSnapshot): Promise<DesktopSessionSummary[]> {
    const sessionGroups = await Promise.all(this.state.projects().map(async (storedProject) => {
      // bootstrap 已刷新所有项目；侧栏只读摘要，不再次为每个项目启动 Git 子进程。
      if (workspace?.project.id === storedProject.id) {
        const pageIds = new Set((workspace.sessionPage?.sessions ?? workspace.sessions).map((session) => session.id));
        return workspace.sessions.filter((session) => session.pinned || pageIds.has(session.id));
      }
      return await this.projects.listSidebarSessions(storedProject, this.runtimeSnapshots(storedProject.id), this.projectEvents(storedProject.id));
    }));
    return sessionGroups.flat();
  }

  async listSessionTreePage(projectId: string, options: DesktopSessionTreePageOptions = {}): Promise<DesktopSessionTreePage> {
    const project = await this.projects.inspectProject(this.projects.requireProject(projectId), false);
    return await this.projects.listSessionTreePage(project, this.runtimeSnapshots(projectId), this.projectEvents(projectId), options);
  }

  async startDraft(projectId: string, isolation: "shared" | "worktree" = "shared"): Promise<DesktopWorkspaceSnapshot> {
    await this.ensureDraftRuntime(projectId, isolation);
    return await this.workspaceSnapshot(projectId);
  }

  /**
   * 空闲 runtime 只切草稿、不销毁重建：MCP 连接、持久化 store、技能扫描等昂贵基础设施
   * 全部保留，仅由 AgentSession.startNewSession 重置会话级状态。sendPrompt 等不需要
   * 快照的调用方走这条轻量路径；startDraft 在此基础上补一份 workspaceSnapshot。
   */
  private async ensureDraftRuntime(projectId: string, isolation?: "shared" | "worktree"): Promise<void> {
    // 清掉旧的初始化失败闩锁，让「新聊天」始终能作为重试入口。
    this.runtimeErrors.delete(projectId);
    const managed = isolation === "worktree" ? await this.ensureRuntime(projectId) : this.residentRuntime(projectId);
    if (!managed) {
      this.draftSessionIds.delete(projectId);
      return;
    }
    const existingDraftSessionId = this.draftSessionIds.get(projectId);
    if (existingDraftSessionId !== undefined) {
      const existingDraft = managed.runtime.runtimeSnapshots().find((entry) => entry.sessionId === existingDraftSessionId);
      const matchesIsolation = existingDraft && (isolation === undefined
        || (path.resolve(existingDraft.snapshot.info.workspaceRoot) !== path.resolve(this.projects.requireProject(projectId).path)) === (isolation === "worktree"));
      if (existingDraft && !runtimeIsBusy(existingDraft.snapshot) && matchesIsolation) {
        await managed.runtime.focusSession(existingDraftSessionId);
        return;
      }
      this.draftSessionIds.delete(projectId);
    }

    const previousSessionId = managed.runtime.getFocusedSessionId();
    const previousSnapshot = previousSessionId === undefined
      ? undefined
      : managed.runtime.getSnapshot(previousSessionId);
    const info = await managed.runtime.startDraft(isolation);
    if (previousSessionId !== undefined
      && previousSessionId !== info.sessionId && previousSnapshot?.state.kind === "idle") {
      await managed.runtime.releaseSessionClaim(previousSessionId);
    }
    this.draftSessionIds.set(projectId, info.sessionId);
  }

  private residentRuntime(projectId: string): ManagedRuntime | undefined {
    const managed = this.runtimes.get(projectId);
    return managed !== undefined && managed.runtime.isRetired ? undefined : managed;
  }

  /** Runtime Host 注册表是并行 session 的唯一 owner；Desktop 只管理一个 client 及自己拥有的 Host。 */
  private runtimeEntries(projectId: string): ManagedRuntime[] {
    const managed = this.residentRuntime(projectId);
    return managed === undefined ? [] : [managed];
  }

  private runtimeSnapshots(projectId: string): InteractiveRuntimeSnapshot[] {
    const managed = this.residentRuntime(projectId);
    if (managed === undefined) return [];
    return managed.runtime.runtimeSnapshots().map(({ snapshot }) => snapshot);
  }

  /** 事件订阅统一出口：所有 runtime 的事件按 sessionId 分桶后广播，meta 标记来源实例。 */
  private wireRuntimeEvents(projectId: string, runtime: RuntimeHostClient): () => void {
    return runtime.subscribeAllRuntimeEvents((update) => {
      const event = update.event;
      if (event) {
        const projectEvents = this.projectEvents(projectId);
        if (isTerminalRunEvent(event)) {
          // terminal 之前已经完成 session 落盘；继续保留 live events 会让 openSession 把已落盘
          // 的新版本和旧 retry run 再拼一次，表现为同一用户消息出现两个 assistant turn。
          projectEvents.delete(event.sessionId);
        } else {
          const sessionEvents = projectEvents.get(event.sessionId) ?? [];
          const previous = sessionEvents.at(-1);
          if (event.type === "tool.input" && previous?.type === "tool.input" && previous.runId === event.runId
            && previous.toolCallId === event.toolCallId && previous.tool === event.tool) sessionEvents[sessionEvents.length - 1] = event;
          else sessionEvents.push(event);
          // 实时事件只为「重新打开会话时补上本轮内容」，按会话保留最近 4000 条，防止长跑占满内存。
          if (sessionEvents.length > 4_000) sessionEvents.splice(0, sessionEvents.length - 4_000);
          projectEvents.set(event.sessionId, sessionEvents);
        }
        if (isTerminalRunEvent(event) && this.state.selectedSessionId(projectId) !== event.sessionId) {
          void this.projects.updateSessionMetadata(this.projects.requireProject(projectId), event.sessionId, { unread: true }).catch(() => undefined);
          if (update.snapshot.state.kind === "idle") {
            void runtime.releaseSessionClaim(event.sessionId).catch(() => undefined);
          }
        }
      }
      const sessionId = event?.sessionId ?? update.snapshot.info.sessionId;
      const isPrimary = runtime.runtimeSnapshots().find((entry) => entry.sessionId === sessionId)?.primary === true;
      this.emit(projectId, update, { sessionId, primary: isPrimary });
    });
  }

  async listProjectBranches(projectId: string): Promise<DesktopGitBranch[]> {
    return await this.projects.listProjectBranches(projectId);
  }

  async switchProjectBranch(projectId: string, branchName: string): Promise<DesktopWorkspaceSnapshot> {
    this.assertProjectGitMutationIdle(projectId);
    await this.projects.switchProjectBranch(projectId, branchName);
    return await this.startDraft(projectId);
  }

  async createProjectBranch(projectId: string, branchName: string): Promise<DesktopWorkspaceSnapshot> {
    this.assertProjectGitMutationIdle(projectId);
    await this.projects.createProjectBranch(projectId, branchName);
    return await this.startDraft(projectId);
  }

  async setProjectPinned(projectId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot> {
    await this.state.setProjectPinned(projectId, pinned);
    return await this.workspaceSnapshot(projectId);
  }

  async renameProject(projectId: string, name: string): Promise<DesktopWorkspaceSnapshot> {
    await this.state.setProjectName(projectId, name);
    return await this.workspaceSnapshot(projectId);
  }

  async removeProject(projectId: string): Promise<void> {
    if (this.isProjectRunning(projectId)) throw new Error("Stop the running task before removing this project from the sidebar.");
    await this.disposeProject(projectId);
    await this.state.removeProject(projectId);
  }

  async openSession(projectId: string, sessionId: string): Promise<DesktopSessionDocument> {
    const lifetime = this.runtimeLifetime(projectId);
    const project = this.projects.requireProject(projectId);
    if (this.draftSessionIds.get(projectId) !== sessionId) this.draftSessionIds.delete(projectId);
    // 浏览只消费磁盘历史和本地事件投影；聚焦 RPC 会让读取排在 Host 操作后面。
    const snapshots = this.runtimeSnapshots(projectId);
    const document = await this.projects.openSession(project, sessionId, snapshots, this.projectEvents(projectId));
    const runtimeSnapshot = this.runtimeSnapshots(projectId).find((snapshot) => snapshot.info.sessionId === sessionId);
    const runtimeError = this.runtimeErrors.get(projectId);
    const writerConflict = this.writerConflicts.get(`${projectId}\0${sessionId}`);
    // 已读标记只影响侧栏状态，不应阻塞会话正文首屏。后续元数据写入会先等待这次
    // 后台更新，并把同一份 revision 传给 catalog CAS，避免用户紧接着置顶/改名时误冲突。
    if (this.isRuntimeLifetimeCurrent(projectId, lifetime)) {
      this.scheduleSessionRead(project, sessionId, document.session.metadataRevision);
      // 打开历史会话时预热项目 Host；同项目已有实例或正在初始化时复用，不阻塞正文。
      if (this.residentRuntime(projectId) === undefined && !this.runtimeInitializations.has(projectId)) {
        this.prewarmRuntime(projectId, lifetime);
      }
    }
    return {
      ...document,
      session: {
        ...document.session,
        unread: false
      },
      writerConflict,
      runtimeError,
      runtimeSnapshot
    };
  }

  async recipeSuggestions(projectId: string, sessionId: string): Promise<DesktopRecipeSuggestion[]> {
    const project = this.projects.requireProject(projectId);
    const persistenceRoot = await this.projects.dataRoot(project);
    const filePath = await resolveSessionFile(persistenceRoot, sessionId);
    const events = await readSessionEvents(filePath);
    const states = await new RecipeStateStore(persistenceRoot).read(sessionId);
    return openRecipeSuggestions(events, sessionId, states).map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      slots: recipe.slots.map((slot) => ({ ...slot })),
      extractPrompt: recipe.extractPrompt
    }));
  }

  async setRecipeState(projectId: string, sessionId: string, recipeId: DesktopRecipeId, state: DesktopRecipeState): Promise<void> {
    const project = this.projects.requireProject(projectId);
    if (!recipeIds.includes(recipeId as RecipeId)) throw new Error("Unknown recipe id.");
    const persistenceRoot = await this.projects.dataRoot(project);
    await resolveSessionFile(persistenceRoot, sessionId);
    await new RecipeStateStore(persistenceRoot).set(sessionId, recipeId as RecipeId, state);
  }

  async renameSession(projectId: string, sessionId: string, title: string, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    const revision = (await this.resolvePendingSessionRead(projectId, sessionId, expectedRevision)) ?? expectedRevision;
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { title }, revision);
    return await this.workspaceSnapshot(projectId);
  }

  async pinSession(projectId: string, sessionId: string, pinned: boolean, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    const revision = await this.resolvePendingSessionRead(projectId, sessionId, expectedRevision);
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { pinned }, revision);
    return await this.workspaceSnapshot(projectId);
  }

  async archiveSession(projectId: string, sessionId: string, archived: boolean, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    const revision = await this.resolvePendingSessionRead(projectId, sessionId, expectedRevision);
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { archived }, revision);
    return await this.workspaceSnapshot(projectId);
  }

  async setSessionFastMode(projectId: string, sessionId: string, fastMode: boolean, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    const revision = await this.resolvePendingSessionRead(projectId, sessionId, expectedRevision);
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { fastMode }, revision);
    return await this.workspaceSnapshot(projectId);
  }

  async markSessionRead(projectId: string, sessionId: string, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    const revision = await this.resolvePendingSessionRead(projectId, sessionId, expectedRevision);
    await this.projects.markSessionRead(this.projects.requireProject(projectId), sessionId, revision);
    return await this.workspaceSnapshot(projectId);
  }

  async preparePrompt(projectId: string): Promise<void> {
    const managed = await this.ensureRuntime(projectId);
    await managed.runtime.waitForReady();
  }

  async sendPrompt(
    projectId: string,
    sessionId: string | undefined,
    input: string,
    attachments: DesktopAttachment[],
    delivery?: "steer" | "queue",
    personalization?: DesktopChatPersonalizationOverride,
    idempotencyKey?: string,
    promptContext?: string,
    capabilitySelection?: AgentCapabilitySelection,
    fastMode?: boolean
  ): Promise<DesktopRunReceipt> {
    try {
      return await this.runIdempotently(projectId, "send", idempotencyKey, async () => await this.sendPromptOnce(
        projectId,
        sessionId,
        input,
        attachments,
        delivery,
        personalization,
        promptContext,
        capabilitySelection,
        idempotencyKey?.trim() || undefined,
        fastMode
      ));
    } catch (error) {
      if (isSessionWriterConflictError(error)) this.recordRuntimeFailure(projectId, error);
      throw error;
    }
  }

  private async sendPromptOnce(
    projectId: string,
    sessionId: string | undefined,
    input: string,
    attachments: DesktopAttachment[],
    delivery?: "steer" | "queue",
    personalization?: DesktopChatPersonalizationOverride,
    promptContext?: string,
    capabilitySelection?: AgentCapabilitySelection,
    messageId?: string,
    fastMode?: boolean
  ): Promise<DesktopRunReceipt> {
    const sendPerfStartedAt = perfNow();
    const selectedBeforeSend = this.state.selectedSessionId(projectId);
    const requestedSessionId = sessionId ?? this.draftSessionIds.get(projectId);
    const runtimeForPromptPerfStartedAt = perfNow();
    const { managed, snapshot } = await this.runtimeForPrompt(projectId, requestedSessionId, personalization);
    const runtime = managed.runtime;
    const targetSessionId = snapshot.info.sessionId;
    const project = this.projects.requireProject(projectId);
    recordPerfPhase("desktop.runtimeForPrompt", runtimeForPromptPerfStartedAt, { projectId }, project.path);
    const prompt = input;
    const attachmentsPerfStartedAt = perfNow();
    const agentAttachments = await loadAgentAttachments(project.path, attachments);
    recordPerfPhase("desktop.loadAttachments", attachmentsPerfStartedAt, { count: attachments.length }, project.path);
    // 前端发送占位与持久用户消息共用身份，重复文本、事件先于回执到达也不会误合并。
    const requestIds = { messageId };
    if (runtimeIsBusy(snapshot)) {
      const queued: HostOperationResult<import("../../../runtime/InteractiveAgentRuntime.js").QueuedAgentMessage> = await runtime.queueRunMessageForSession(targetSessionId, prompt, delivery === "steer" ? "steer" : "queue", agentAttachments, requestIds);
      if (!queued.accepted || queued.result === undefined) {
        throw errorFromHostOperation(queued);
      }
      if (this.draftSessionIds.get(projectId) === targetSessionId) this.draftSessionIds.delete(projectId);
      if (this.state.selectedSessionId(projectId) === selectedBeforeSend) await this.state.setSelectedSession(projectId, targetSessionId);
      recordPerfPhase("desktop.sendPrompt", sendPerfStartedAt, { projectId, queued: true }, project.path);
      return {
        sessionId: targetSessionId,
        runId: queued.result.runId,
        messageId: queued.result.messageId
      };
    }
    const info = snapshot.info;
    const accepted = await runtime.submitRunForSession(
      targetSessionId,
      prompt,
      agentAttachments,
      requestIds,
      promptContext,
      capabilitySelection,
      fastMode
    );
    if (!accepted.accepted || accepted.result === undefined) throw errorFromHostOperation(accepted);
    if (this.draftSessionIds.get(projectId) === targetSessionId) this.draftSessionIds.delete(projectId);
    if (this.state.selectedSessionId(projectId) === selectedBeforeSend) await this.state.setSelectedSession(projectId, info.sessionId);
    recordPerfPhase("desktop.sendPrompt", sendPerfStartedAt, { projectId, queued: false }, project.path);
    return {
      sessionId: info.sessionId,
      runId: accepted.result.runId,
      messageId: accepted.result.messageId
    };
  }

  async mutateQueuedMessage(
    projectId: string,
    sessionId: string,
    action: import("../../protocol.js").DesktopQueuedMessageAction,
    mutation: import("../../protocol.js").DesktopQueuedMessageMutation = {}
  ): Promise<void> {
    const managed = await this.resolveSessionRuntime(projectId, sessionId);
    await managed.runtime.mutateQueuedRunMessageForSession(sessionId, action, mutation);
    return;
  }

  /**
   * 给待发消息选择 Host 注册表中的 session runtime。Desktop 不再在进程内 mint
   * 并行实例；没有目标 session 且主 runtime 忙时，由 Host 创建一个新 session。
   */
  private async runtimeForPrompt(
    projectId: string,
    sessionId: string | undefined,
    personalization?: DesktopChatPersonalizationOverride
  ): Promise<{ managed: ManagedRuntime; snapshot: InteractiveRuntimeSnapshot }> {
    const lifetime = this.runtimeLifetime(projectId);
    try {
      const primary = await this.ensureRuntime(projectId);
      const target = await primary.runtime.ensureSession({ sessionId, writeIntent: true, focus: false });
      this.writerConflicts.delete(`${projectId}\0${target.sessionId}`);
      if (personalization !== undefined) {
        const state = await primary.runtime.getPersonalizationState(target.sessionId);
        await primary.runtime.updateChatPersonalization(personalization, state.catalogRevision, target.sessionId);
      }
      return { managed: primary, snapshot: primary.runtime.getSnapshot(target.sessionId) };
    } catch (error) {
      if (this.isRuntimeLifetimeCurrent(projectId, lifetime)) this.recordRuntimeFailure(projectId, error);
      throw error;
    }
  }

  /** 找到或准备 Host 注册表中的目标 session runtime。 */
  private async resolveSessionRuntime(projectId: string, sessionId: string, focus = true): Promise<ManagedRuntime> {
    const lifetime = this.runtimeLifetime(projectId);
    try {
      const primary = await this.ensureRuntime(projectId);
      await primary.runtime.ensureSession({ sessionId, writeIntent: true, focus });
      this.writerConflicts.delete(`${projectId}\0${sessionId}`);
      return primary;
    } catch (error) {
      if (this.isRuntimeLifetimeCurrent(projectId, lifetime)) this.recordRuntimeFailure(projectId, error);
      throw error;
    }
  }

  async resumeInterruptedTurn(projectId: string, sessionId: string): Promise<DesktopRunReceipt | undefined> {
    const { runtime } = await this.resolveSessionRuntime(projectId, sessionId);
    const submitted = await runtime.startInterruptedTurnForSession(sessionId, undefined, "newTurn");
    if (!submitted) return undefined;
    await this.state.setSelectedSession(projectId, sessionId);
    this.observeRunCompletion(projectId, submitted.completion);
    return {
      sessionId,
      runId: submitted.runId,
      messageId: submitted.messageId
    };
  }

  /** 在原会话的同一消息位置生成新的用户/assistant版本，不创建侧栏子会话。 */
  async editPrompt(
    projectId: string,
    sessionId: string,
    userMessageIndex: number,
    input: string,
    attachments: DesktopAttachment[],
    idempotencyKey?: string
  ): Promise<DesktopRunReceipt> {
    return await this.runIdempotently(projectId, "edit", idempotencyKey, async () => await this.editPromptOnce(
      projectId,
      sessionId,
      userMessageIndex,
      input,
      attachments
    ));
  }

  /** 在原会话的同一消息槽生成新 assistant 版本，不创建子会话。 */
  async retryPrompt(
    projectId: string,
    sessionId: string,
    targetMessageId: string,
    input: string,
    attachments: DesktopAttachment[],
    idempotencyKey?: string
  ): Promise<DesktopRunReceipt> {
    return await this.runIdempotently(projectId, "retry", idempotencyKey, async () => {
      const managed = await this.resolveSessionRuntime(projectId, sessionId);
      const { runtime } = managed;
      const snapshot = runtime.getSnapshot(sessionId);
      if (snapshot.state.kind === "runs") {
        throw new Error("当前会话正在生成，请等待本轮完成后再重新生成。");
      } else if (snapshot.state.kind === "maintenance") {
        throw new Error("Runtime 正在处理其他操作，请稍候再重新生成。");
      }
      const project = this.projects.requireProject(projectId);
      const parsed = splitAttachmentReferences(input);
      const retryAttachments = attachments.length
        ? attachments
        : parsed.attachments.map((attachment) => ({
          name: attachment.name,
          path: attachment.path,
          mimeType: attachment.mimeType,
          size: attachment.size ?? 0
        }));
      const prompt = splitAttachmentReferences(input).text;
      const agentAttachments = await loadAgentAttachments(project.path, retryAttachments);
      const requestIds = { retryOfMessageId: targetMessageId };
      const accepted = await runtime.submitRunForSession(sessionId, prompt, agentAttachments, requestIds);
      if (!accepted.accepted || accepted.result === undefined) throw errorFromHostOperation(accepted);
      await this.state.setSelectedSession(projectId, sessionId);
      return { sessionId, runId: accepted.result.runId, messageId: accepted.result.messageId };
    });
  }

  async switchMessageVersion(
    projectId: string,
    sessionId: string,
    messageId: string,
    direction: "prev" | "next"
  ): Promise<DesktopSessionDocument> {
    const managed = await this.resolveSessionRuntime(projectId, sessionId);
    await managed.runtime.switchMessageVersion(messageId, direction, sessionId);
    return await this.openSession(projectId, sessionId);
  }

  private async editPromptOnce(
    projectId: string,
    sessionId: string,
    userMessageIndex: number,
    input: string,
    attachments: DesktopAttachment[]
  ): Promise<DesktopRunReceipt> {
    const managed = await this.resolveSessionRuntime(projectId, sessionId);
    const { runtime } = managed;
    const snapshot = runtime.getSnapshot(sessionId);
    if (snapshot.state.kind === "runs") {
      await runtime.cancelRunRequest(snapshot.state.activeRun.runId, "replaced", sessionId);
      await runtime.waitForIdle(sessionId);
    } else if (snapshot.state.kind === "maintenance") {
      throw new Error("Runtime 正在处理其他操作，请稍候再编辑消息。");
    }
    const project = this.projects.requireProject(projectId);
    const targetMessageId = await this.projects.sessionUserMessageIdAtIndex(project, sessionId, userMessageIndex);
    this.runtimeErrors.delete(projectId);
    const prompt = input;
    const agentAttachments = await loadAgentAttachments(project.path, attachments);
    const requestIds = {
      retryOfMessageId: targetMessageId,
      replaceUserMessageId: targetMessageId
    };
    const accepted = await runtime.submitRunForSession(sessionId, prompt, agentAttachments, requestIds);
    if (!accepted.accepted || accepted.result === undefined) throw errorFromHostOperation(accepted);
    await this.state.setSelectedSession(projectId, sessionId);
    return {
      sessionId,
      runId: accepted.result.runId,
      messageId: accepted.result.messageId
    };
  }

  /**
   * 在执行副作用前登记操作 Promise。失败 Promise 也保留在缓存里：IPC 若因超时重入，
   * 必须复用原结果，不能把一次已经写入 session 的请求再执行一遍；用户主动重试会生成新键。
   */
  private runIdempotently(
    projectId: string,
    operation: "send" | "edit" | "retry",
    idempotencyKey: string | undefined,
    execute: () => Promise<DesktopRunReceipt>
  ): Promise<DesktopRunReceipt> {
    const normalizedKey = idempotencyKey?.trim();
    if (!normalizedKey) return execute();
    const cacheKey = JSON.stringify([operation, projectId, normalizedKey]);
    const existing = this.idempotentPromptRequests.get(cacheKey);
    if (existing) return existing;
    // 先把 Promise 放进缓存，再在 microtask 中启动 runtime/session 副作用。
    const pending = Promise.resolve().then(execute);
    this.idempotentPromptRequests.set(cacheKey, pending);
    return pending;
  }

  async cancelRun(projectId: string, runId: string): Promise<void> {
    const entries = this.runtimeEntries(projectId);
    const owner = entries.find((entry) => activeRun(entry.runtime.getSnapshot())?.runId === runId) ?? entries[0];
    if (!owner) throw new Error("Project runtime is not active.");
    const runtime = owner.runtime;
    const targetSessionId = runtime.runtimeSnapshots()
      .find((entry) => activeRun(entry.snapshot)?.runId === runId)?.sessionId;
    const result = await runtime.cancelRunRequest(runId, "paused", targetSessionId);
    if (!result.accepted) throw new Error(result.reason ?? "Runtime Host did not accept cancellation.");
    return;
  }

  async resolvePermission(projectId: string, requestId: string, result: PermissionResult): Promise<void> {
    const entries = this.runtimeEntries(projectId);
    const owner = entries.find((entry) => pendingPermission(entry.runtime.getSnapshot())?.requestId === requestId) ?? entries[0];
    if (!owner) throw new Error("Project runtime is not active.");
    const targetSessionId = owner.runtime.runtimeSnapshots()
      .find((entry) => pendingPermission(entry.snapshot)?.requestId === requestId)?.sessionId;
    const response = await owner.runtime.answerPermissionRequest(requestId, result, targetSessionId);
    if (!response.accepted) throw new Error(response.reason ?? "Runtime Host did not accept the permission response.");
    return;
  }

  async answerUserInput(projectId: string, sessionId: string, runId: string, toolCallId: string, response: UserInputResponse): Promise<void> {
    const owner = this.residentRuntime(projectId);
    if (!owner) throw new Error("Project runtime is not active.");
    await owner.runtime.answerUserInput(sessionId, runId, toolCallId, response);
  }

  async setPermissionMode(projectId: string, mode: PermissionMode): Promise<DesktopWorkspaceSnapshot> {
    const { runtime } = await this.ensureRuntime(projectId);
    await runtime.setPermissionMode(mode);
    return await this.workspaceSnapshot(projectId);
  }

  async switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const project = this.projects.requireProject(projectId);
    const config = await this.configStore.load(project.path);
    const reference = alias.trim();
    const slash = reference.indexOf("/");
    const selectedProvider = (config.models[reference] ?? config.models[reference.toLowerCase()])?.provider
      ?? (slash > 0 ? reference.slice(0, slash) : undefined);
    const catalogs = selectedProvider && config.providers[selectedProvider]
      ? await restoreProviderCatalogs([selectedProvider], this.modelsStore, config.providers) : [];
    const effective = await saveModelSelection(project.path, this.configStore, alias, thinking, catalogs);
    // 项目覆盖可能使保存后的有效模型仍属于另一连接，只补读该连接的目录。
    const effectiveProvider = effective.models[effective.defaultModel]?.provider;
    if (effectiveProvider && effectiveProvider !== selectedProvider) {
      catalogs.push(...await restoreProviderCatalogs([effectiveProvider], this.modelsStore, effective.providers));
    }
    this.runtimeErrors.delete(projectId);
    return modelRuntimeInfo(effective, catalogs);
  }

  async settingsConfigRevision(projectId: string): Promise<string> {
    const project = this.projects.requireProject(projectId);
    return (await this.requireVersionedConfig().loadVersioned!(project.path)).revision;
  }

  async maskingOverview(projectId: string): Promise<MaskingOverview> {
    return await (await this.ensureRuntime(projectId)).runtime.maskingOverview();
  }

  async maskingDetail(projectId: string, id: string): Promise<MaskRecord | undefined> {
    return await (await this.ensureRuntime(projectId)).runtime.maskingDetail(id);
  }

  async clearMaskRecords(projectId: string): Promise<void> {
    await (await this.ensureRuntime(projectId)).runtime.clearMaskRecords();
  }

  async settingsConfigSnapshot(projectId: string): Promise<DesktopSettingsConfigSnapshot> {
    const project = this.projects.requireProject(projectId);
    const current = await this.requireVersionedConfig().loadVersioned!(project.path);
    const catalogs = await restoreProviderCatalogs(Object.keys(current.config.providers), this.modelsStore, current.config.providers);
    return describeSettingsConfigSnapshot(current.config, current.revision, projectId, project.path, catalogs);
  }

  async settingsChatSnapshot(projectId: string, sessionId: string): Promise<DesktopSettingsChatSnapshot> {
    const project = this.projects.requireProject(projectId);
    const persistenceRoot = await this.projects.dataRoot(project);
    const current = await readSessionCatalogRecord(persistenceRoot, sessionId);
    return {
      sessionId,
      metadataRevision: current === undefined ? SESSION_CATALOG_MISSING_REVISION : sessionCatalogRecordRevision(current),
      personalization: current?.personalization ?? defaultChatPersonalizationOverride
    };
  }

  async prepareSettingsConfig(
    projectId: string,
    input: DesktopSettingsSaveInput
  ): Promise<PreparedDesktopSettingsConfig> {
    // 只保存主题/字体时这里只读 config，真正提交的是独立的 DesktopStateStore 偏好段。
    if (input.activity !== undefined
      || input.identity !== undefined
      || input.memory !== undefined
      || input.compaction !== undefined
      || input.chatParams !== undefined
      || input.rtkEnabled !== undefined
      || input.toolExecutionMode !== undefined
      || input.subagent !== undefined
      || input.permission !== undefined
      || input.webSearch !== undefined
      || input.redaction !== undefined
      || input.skills !== undefined) {
      this.assertNoRunningTasks("任务运行期间不能提交全局设置。");
    }
    const project = this.projects.requireProject(projectId);
    const current = await this.requireVersionedConfig().loadVersioned!(project.path);
    let next = structuredClone(current.config);
    const credentialHandles = new Set<string>();

    if (input.memory !== undefined) {
      next = configSchema.parse({
        ...next,
        context: {
          ...next.context,
          memory: input.memory
        }
      });
    }
    if (input.identity !== undefined) {
      next = configSchema.parse({
        ...next,
        context: {
          ...next.context,
          identity: input.identity
        }
      });
    }
    if (input.compaction !== undefined) {
      next = configSchema.parse({
        ...next,
        context: {
          ...next.context,
          compaction: input.compaction
        }
      });
    }
    if (input.rtkEnabled !== undefined) next = configSchema.parse({ ...next, agent: { ...next.agent, rtkEnabled: input.rtkEnabled } });
    if (input.toolExecutionMode !== undefined) {
      next = configSchema.parse({ ...next, agent: { ...next.agent, toolExecutionMode: input.toolExecutionMode } });
    }
    if (input.chatParams !== undefined) {
      next = configSchema.parse({
        ...next,
        chat: input.chatParams
      });
    }
    if (input.permission !== undefined) {
      next = configSchema.parse({
        ...next,
        permission: input.permission
      });
    }
    if (input.skills !== undefined) {
      const projectKey = createProjectSkillKey(project.path);
      next = configSchema.parse({
        ...next,
        extensions: {
          ...next.extensions,
          skillDefaults: input.skills.globalDefaults,
          skillProjectOverrides: {
            ...next.extensions.skillProjectOverrides,
            [projectKey]: input.skills.projectOverrides
          }
        }
      });
    }
    if (input.activity !== undefined) {
      next = configSchema.parse({
        ...next,
        // 分析和回忆策略都通过同一份版本化设置保存。
        activity: { ...next.activity, ...input.activity }
      });
    }
    if (input.webSearch !== undefined) {
      next = configSchema.parse({ ...next, web: { ...next.web, search: input.webSearch } });
    }
    if (input.redaction !== undefined) {
      next = configSchema.parse({ ...next, redaction: input.redaction });
    }
    if (input.models !== undefined) {
      for (const handle of input.models.oauthCredentialHandles ?? []) {
        const staged = this.requireStagedCredential(handle);
        if (staged.kind !== "oauth-login" || staged.projectId !== projectId) {
          throw new Error("OAuth credential handle 与当前项目或用途不匹配。");
        }
        credentialHandles.add(handle);
        next = this.buildConfigWithAuthenticatedLogin(next, staged.authenticated);
      }
      for (const custom of input.models.customProviders ?? []) {
        const apiKey = custom.apiKeyHandle === undefined
          ? custom.apiKey
          : this.requireApiKeyHandle(custom.apiKeyHandle, credentialHandles, {
              projectId,
              purpose: "model",
              providerAlias: custom.alias
            });
        next = this.buildConfigWithCustomProvider(next, { ...custom, apiKey, apiKeyHandle: undefined });
      }
      if (input.models.upserts.length) {
        // 整批合并后只校验一次，避免每个模型都扫描、复制和校验整份配置。
        const beforeUpserts = next;
        const resolved: DesktopModelConfigurationInput[] = [];
        for (const upsert of input.models.upserts) {
          const apiKey = upsert.apiKeyHandle === undefined
            ? upsert.apiKey
            : this.requireApiKeyHandle(upsert.apiKeyHandle, credentialHandles, {
                projectId,
                purpose: "model",
                providerAlias: upsert.providerAlias
              });
          resolved.push({ ...upsert, apiKey, apiKeyHandle: undefined });
        }
        next = this.parseModelProfileEdit(beforeUpserts, this.applyModelUpserts(next, resolved), current.config);
      }
      const projectSettings = await loadProjectSettings(project.path);
      const removeProviderAliases = new Set(input.models.removeProviderAliases ?? []);
      for (const providerAlias of removeProviderAliases) {
        if (!next.providers[providerAlias]) throw new Error(`未知服务商：${providerAlias}`);
      }
      const removeAliases = new Set<string>();
      for (const requestedAlias of [
        ...input.models.removeAliases,
        ...Object.entries(next.models).filter(([, model]) => removeProviderAliases.has(model.provider)).map(([alias]) => alias)
      ]) {
        const alias = resolveConfiguredModelAlias(next, requestedAlias);
        if (!alias) throw new Error(`未知模型：${requestedAlias}`);
        if (projectSettings.defaultModel === alias) {
          throw new Error(`不能删除项目 .biny/settings.json 当前引用的模型：${alias}`);
        }
        removeAliases.add(alias);
      }
      if (removeAliases.size) {
        const models = Object.fromEntries(Object.entries(next.models).filter(([alias]) => !removeAliases.has(alias)));
        const firstRemaining = Object.keys(models)[0];
        if (!firstRemaining) throw new Error("至少需要保留一个可用模型。");
        const providers = { ...next.providers };
        for (const alias of removeAliases) {
          const removed = next.models[alias]!;
          const provider = providers[removed.provider]!;
          const modelProfiles = { ...provider.modelProfiles };
          delete modelProfiles[removed.model];
          providers[removed.provider] = { ...provider, modelProfiles };
        }
        const defaultRemoved = removeAliases.has(next.defaultModel);
        let candidate = {
          ...next,
          defaultModel: defaultRemoved ? firstRemaining : next.defaultModel,
          toolModel: next.toolModel && removeAliases.has(next.toolModel) ? undefined : next.toolModel,
          visionModel: next.visionModel && removeAliases.has(next.visionModel) ? undefined : next.visionModel,
          models,
          providers
        };
        if (defaultRemoved && input.models.defaultModel) {
          const alias = resolveConfiguredModelAlias(candidate, input.models.defaultModel.alias);
          if (!alias) throw new Error(`未知模型：${input.models.defaultModel.alias}`);
          const selection = input.models.defaultModel.thinking;
          candidate = { ...candidate, defaultModel: alias, thinking: {
            enabled: selection !== "off", effort: selection === "off" ? next.thinking.effort : selection
          } };
        }
        // 只在最终保留模型拒绝继承档位时投影；显式选择和仍有效的配置不被目录/profile 改写。
        const parsed = configSchema.safeParse(candidate);
        if (!parsed.success && defaultRemoved && input.models.defaultModel === undefined
          && parsed.error.issues.every((issue) => issue.path.length === 2 && issue.path[0] === "thinking"
            && (issue.path[1] === "enabled" || issue.path[1] === "effort"))) {
          const model = models[candidate.defaultModel]!;
          const efforts = reasoningEffortSchema.options.filter((effort) => model.thinkingLevelMap
            ? model.thinkingLevelMap[effort] !== undefined && model.thinkingLevelMap[effort] !== null
            : model.reasoning?.efforts.includes(effort));
          const effort = projectThinkingSelectionToModel(modelThinkingLevelMap(model), efforts, next.thinking.effort) ?? efforts[0];
          candidate.thinking = {
            enabled: model.compatibility?.supportsReasoning !== false && effort !== undefined,
            effort: effort ?? next.thinking.effort
          };
        }
        next = parsed.success ? parsed.data : configSchema.parse(candidate);
      }
      if (input.models.modelProfiles !== undefined) {
        for (const [providerAlias, profiles] of Object.entries(input.models.modelProfiles)) {
          const provider = next.providers[providerAlias];
          if (!provider) throw new Error(`未知服务商：${providerAlias}`);
          next = this.parseModelProfileEdit(next, {
            ...next,
            providers: {
              ...next.providers,
              [providerAlias]: {
                ...provider,
                modelProfiles: profiles
              }
            }
          }, current.config);
        }
      }
      if (removeProviderAliases.size > 0) {
        next = configSchema.parse({
          ...next,
          providers: Object.fromEntries(Object.entries(next.providers).filter(([alias]) => !removeProviderAliases.has(alias)))
        });
      }
      for (const [providerAlias, format] of Object.entries(input.models.providerApiFormats ?? {})) {
        const provider = next.providers[providerAlias];
        if (!provider) throw new Error(`未知服务商：${providerAlias}`);
        // 只更新连接默认值；逐模型覆盖由模型选项独立维护。
        next = configSchema.parse({
          ...next,
          providers: { ...next.providers, [providerAlias]: { ...provider, apiBackend: format === "auto" ? undefined : format } }
        });
      }
      if (input.models.defaultModel !== undefined) {
        const alias = resolveConfiguredModelAlias(next, input.models.defaultModel.alias);
        if (!alias) throw new Error(`未知模型：${input.models.defaultModel.alias}`);
        const selection = input.models.defaultModel.thinking;
        next = configSchema.parse({
          ...next,
          defaultModel: alias,
          thinking: {
            enabled: selection !== "off",
            effort: selection === "off" ? next.thinking.effort : selection
          }
        });
      }
      if (input.models.visionModel !== undefined) {
        const reference = input.models.visionModel.alias;
        const alias = reference === undefined ? undefined : resolveConfiguredModelAlias(next, reference);
        if (reference !== undefined && !alias) throw new Error(`未知视觉模型：${reference}`);
        if (alias) {
          validateModelConfiguration(next, alias);
          const visionCatalogs = await restoreProviderCatalogs(Object.keys(next.providers), this.modelsStore, next.providers);
          const choice = listConfiguredModelChoices(next, visionCatalogs).find(model => model.alias === alias);
          if (choice?.providerType === "acp" || choice?.capabilities?.vision !== true) throw new Error("请选择支持图片输入的视觉模型。");
        }
        next = configSchema.parse({ ...next, visionModel: alias });
      }
      if (input.models.toolModel !== undefined) {
        const reference = input.models.toolModel.alias;
        const alias = reference === undefined ? undefined : resolveConfiguredModelAlias(next, reference);
        if (reference !== undefined && !alias) throw new Error(`未知工具模型：${reference}`);
        if (alias) validateModelConfiguration(next, alias);
        next = configSchema.parse({ ...next, toolModel: alias });
      }
      // 连接停用、删除密钥等管理操作可以暂时让原默认模型不可用；明确选择新默认时才验证请求条件。
      if (input.models.defaultModel !== undefined || next.defaultModel !== current.config.defaultModel) {
        validateModelConfiguration(next, next.defaultModel);
      }
    }

    if (input.subagent !== undefined) {
      const settings = input.subagent;
      if (settings.enabled && settings.runtime === "codex" && !settings.model?.trim()) {
        throw new Error("请选择子代理模型。");
      }
      const selectedSubagentProviderAlias = settings.runtime === "acp"
        ? settings.providerAlias ?? (settings.model ? next.models[settings.model]?.provider : undefined) : undefined;
      if (settings.enabled && settings.runtime === "acp") {
        const provider = selectedSubagentProviderAlias ? next.providers[selectedSubagentProviderAlias] : undefined;
        if (!provider || provider.type !== "acp" || !provider.acp || provider.enabled === false) throw new Error("请选择已启用的 ACP Provider。");
      }
      if (settings.model && (settings.runtime === "builtin" || settings.runtime === "auto" || settings.runtime === "acp")) {
        const model = next.models[settings.model];
        const provider = model ? next.providers[model.provider] : undefined;
        if (!provider || (settings.enabled && provider.enabled === false) || (provider.type === "acp") !== (settings.runtime === "acp")
          || (settings.providerAlias !== undefined && model?.provider !== settings.providerAlias)) {
          throw new Error("子代理模型与所选 Agent 不匹配，或连接已停用。");
        }
      }
      next = configSchema.parse({ ...next, extensions: { ...next.extensions,
        subagent: { ...next.extensions.subagent, enabled: settings.enabled, runtime: settings.runtime,
          providerAlias: selectedSubagentProviderAlias, model: settings.model?.trim() } } });
    }

    if (input.memory !== undefined
      && !sameEmbeddingModel(current.config.context.memory.embeddingModel, next.context.memory.embeddingModel)) {
      next = configSchema.parse({ ...next, needsEmbeddingRebuild: true });
    }

    synchronizeCredentialRevisions(next, current.config);
    if (!isModelSelectionChange(current.config, next)) {
      this.assertNoRunningTasks("任务运行期间不能修改供应商或共享设置。");
    }

    return {
      projectId,
      workspaceRoot: project.path,
      before: current.config,
      after: next,
      beforeRevision: current.revision,
      targetRevision: configDocumentRevision(next),
      credentialHandles: [...credentialHandles]
    };
  }

  async commitSettingsConfig(prepared: PreparedDesktopSettingsConfig, transactionId: string): Promise<void> {
    if (!isModelSelectionChange(prepared.before, prepared.after)) {
      this.assertNoRunningTasks("任务运行期间不能提交全局设置。");
    }
    const saved = await this.requireSettingsTransactionConfig().saveVersionedDeferred!(
      prepared.after,
      prepared.beforeRevision,
      transactionId,
      prepared.workspaceRoot
    );
    if (saved.revision !== prepared.targetRevision) {
      throw new Error(`全局配置保存后的 revision 与事务候选不一致：${prepared.targetRevision} -> ${saved.revision}。`);
    }
    // 设置事务只负责持久化配置并完成 CAS；空闲 Runtime 是派生状态，等事务 journal
    // 清理完成后由 settingsCommitted 放到后台刷新，避免保存按钮被 Host 重建拖住。
  }

  async settingsConfigTransactionStatus(
    projectId: string,
    transactionId: string
  ): Promise<DeferredCredentialTransactionStatus> {
    const project = this.projects.requireProject(projectId);
    return await this.requireSettingsTransactionConfig().deferredCredentialStatus!(transactionId, project.path);
  }

  async finalizeSettingsConfig(projectId: string, transactionId: string): Promise<void> {
    const project = this.projects.requireProject(projectId);
    await this.requireSettingsTransactionConfig().finalizeDeferredCredentials!(transactionId, project.path);
  }

  async rollbackSettingsConfig(
    prepared: PreparedDesktopSettingsConfig,
    transactionId: string
  ): Promise<"not_needed" | "completed" | "failed"> {
    try {
      const result = await this.requireSettingsTransactionConfig().rollbackVersionedDeferred!(
        prepared.before,
        prepared.targetRevision,
        transactionId,
        prepared.workspaceRoot
      );
      if (result === "failed") return result;
      await this.rebuildIdleManagedRuntimes();
      return result;
    } catch {
      return "failed";
    }
  }

  async rollbackPendingSettingsConfig(
    projectId: string,
    transactionId: string
  ): Promise<"not_needed" | "completed" | "failed"> {
    const project = this.projects.requireProject(projectId);
    const result = await this.requireSettingsTransactionConfig().rollbackDeferredCredentials!(transactionId, project.path);
    if (result !== "failed") await this.rebuildIdleManagedRuntimes();
    return result;
  }

  async prepareSettingsChat(
    projectId: string,
    input: NonNullable<DesktopSettingsSaveInput["chat"]>
  ): Promise<PreparedDesktopSettingsChat> {
    const project = this.projects.requireProject(projectId);
    const persistenceRoot = await this.projects.dataRoot(project);
    const before = await readSessionCatalogRecord(persistenceRoot, input.sessionId);
    const now = new Date().toISOString();
    const after: SessionCatalogRecord = {
      ...(before ?? {
        version: 1,
        sessionId: input.sessionId,
        rootSessionId: input.sessionId,
        createdAt: now,
        updatedAt: now
      }),
      personalization: input.personalization,
      updatedAt: now
    };
    return {
      projectId,
      persistenceRoot,
      sessionId: input.sessionId,
      before,
      after,
      beforeRevision: before === undefined ? SESSION_CATALOG_MISSING_REVISION : sessionCatalogRecordRevision(before),
      targetRevision: sessionCatalogRecordRevision(after)
    };
  }

  async commitSettingsChat(prepared: PreparedDesktopSettingsChat): Promise<void> {
    this.assertNoRunningTasks("任务运行期间不能提交聊天设置。");
    await writeSessionCatalogRecord(prepared.persistenceRoot, prepared.after, {
      expectedRevision: prepared.beforeRevision
    });
  }

  async rollbackSettingsChat(prepared: PreparedDesktopSettingsChat): Promise<"not_needed" | "completed" | "failed"> {
    try {
      const current = await readSessionCatalogRecord(prepared.persistenceRoot, prepared.sessionId);
      const revision = current === undefined ? SESSION_CATALOG_MISSING_REVISION : sessionCatalogRecordRevision(current);
      if (revision === prepared.beforeRevision) return "not_needed";
      if (revision !== prepared.targetRevision) return "failed";
      if (prepared.before === undefined) {
        await deleteSessionCatalogRecord(prepared.persistenceRoot, prepared.sessionId);
      } else {
        await writeSessionCatalogRecord(prepared.persistenceRoot, {
          ...prepared.before,
          // catalog merge 不会用 undefined 删除字段；显式默认覆盖与原先“无覆盖”的行为等价。
          personalization: prepared.before.personalization ?? defaultChatPersonalizationOverride
        }, {
          expectedRevision: prepared.targetRevision
        });
      }
      return "completed";
    } catch {
      return "failed";
    }
  }

  stageSettingsCredential(secret: string, scope: DesktopSettingsCredentialScope): DesktopStagedSettingsCredential {
    if (!secret.trim() || secret.length > 16_000) throw new Error("凭据不能为空且不能超过 16000 个字符。");
    this.projects.requireProject(scope.projectId);
    if (!scope.providerAlias.trim() || scope.purpose !== "model") {
      throw new Error("暂存凭据用途无效。");
    }
    this.pruneStagedSettingsCredentials();
    const handle = randomUUID();
    const expiresAt = Date.now() + SETTINGS_CREDENTIAL_TTL_MS;
    this.stagedSettingsCredentials.set(handle, { kind: "api-key", secret, scope: { ...scope }, expiresAt });
    return { handle, kind: "api-key", expiresAt: new Date(expiresAt).toISOString(), provider: undefined };
  }

  async completeModelLoginForSettings(
    projectId: string,
    provider: DesktopModelLoginProvider,
    authRequestId: string,
    pastedAuthorization?: string
  ): Promise<DesktopStagedModelLoginResult> {
    this.projects.requireProject(projectId);
    const operation = new AbortController();
    this.modelLoginOperations.set(authRequestId, operation);
    try {
      const authenticated = await this.modelLogin.complete(provider, authRequestId, pastedAuthorization);
      operation.signal.throwIfAborted();
      let models: NonNullable<AuthenticatedModelLogin["models"]>;
      try {
        models = await this.modelLogin.discoverModels(provider, authenticated.accessToken, operation.signal);
      } catch {
        operation.signal.throwIfAborted();
        models = [];
      }
      const handle = randomUUID();
      const expiresAt = Date.now() + SETTINGS_CREDENTIAL_TTL_MS;
      this.stagedSettingsCredentials.set(handle, {
        kind: "oauth-login",
        projectId,
        authenticated: { ...authenticated, models },
        expiresAt
      });
      return {
        handle,
        kind: "oauth-login",
        expiresAt: new Date(expiresAt).toISOString(),
        provider,
        models
      };
    } finally {
      this.modelLoginOperations.delete(authRequestId);
    }
  }

  releaseSettingsCredentials(handles: string[]): void {
    for (const handle of handles) this.stagedSettingsCredentials.delete(handle);
  }

  consumeSettingsCredentials(handles: string[]): void {
    this.releaseSettingsCredentials(handles);
  }

  async startModelLogin(projectId: string, provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult> {
    this.projects.requireProject(projectId);
    return await this.modelLogin.start(provider);
  }

  async cancelModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string): Promise<void> {
    this.projects.requireProject(projectId);
    this.modelLoginOperations.get(authRequestId)?.abort(new DOMException("OAuth authorization cancelled", "AbortError"));
    this.modelLogin.cancel(provider, authRequestId);
  }

  /** 个性化总览：全局设置读取真实 global config，聊天有效值由当前 runtime 统一解析。 */
  async personalizationOverview(projectId: string, sessionId?: string): Promise<DesktopPersonalizationOverview> {
    this.projects.requireProject(projectId);
    const state = sessionId === undefined
      ? await this.currentPersonalizationState(projectId)
      : await this.personalizationState(projectId, sessionId);
    return describePersonalizationOverview(state, sessionId);
  }

  async saveChatPersonalization(
    projectId: string,
    sessionId: string,
    input: DesktopChatPersonalizationOverride,
    expectedRevision: string
  ): Promise<DesktopWorkspaceSnapshot> {
    this.assertNoRunningTasks("任务运行期间不能修改当前聊天的个性化设置。");
    const revision = (await this.resolvePendingSessionRead(projectId, sessionId, expectedRevision)) ?? expectedRevision;
    this.assertNoRunningTasks("任务运行期间不能修改当前聊天的个性化设置。");
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { personalization: input }, revision);
    return await this.workspaceSnapshot(projectId, false);
  }

  /** 单一记忆库条目与 revision；记忆是扁平全库视图。 */
  async memoryOverview(projectId: string): Promise<DesktopMemoryOverview> {
    const project = this.projects.requireProject(projectId);
    const managed = this.residentRuntime(projectId);
    // runtime 未驻留时不触发冷启动：记忆策略/config revision 直接读 config 文件，
    // 记忆条目直接读全局记忆库（存储层无锁快照读）。
    const [config, store] = managed
      ? await Promise.all([
          this.currentPersonalizationState(projectId).then((state) => ({
            configRevision: requireConfigRevision(state),
            memory: state.memory
          })),
          this.readMemoryStoreFromRuntime(managed)
        ])
      : await Promise.all([
          this.requireVersionedConfig().loadVersioned!(project.path).then((current) => ({
            configRevision: current.revision,
            memory: current.config.context.memory
          })),
          this.readMemoryStoreFromDisk(projectId)
        ]);
    return {
      configRevision: config.configRevision,
      // entries 与 storeRevision 来自同一份单库快照；overview 只补充统计，不能替代 CAS revision。
      revision: store.entries.storeRevision,
      settings: { ...config.memory },
      totalEntries: store.overview.entryCount,
      memoryStats: memoryStats(store.allEntries),
      maintenance: { ...store.maintenance },
      entries: store.entries.entries
    };
  }

  /** 记忆库统计：不含条目内容，runtime 驻留与否都返回（config 与全局库均可廉价直读）。 */
  async memoryStats(projectId: string): Promise<DesktopMemoryStats> {
    const project = this.projects.requireProject(projectId);
    const managed = this.residentRuntime(projectId);
    const storage = new MemoryStorage(project.path);
    const reads = [
      managed
        ? this.currentPersonalizationState(projectId).then(state => ({ configRevision: requireConfigRevision(state), memory: state.memory }))
        : this.requireVersionedConfig().loadVersioned!(project.path).then(current => ({ configRevision: current.revision, memory: current.config.context.memory })),
      storage.getStats(),
      storage.readMaintenanceStatus()
    ] as const;
    try {
      const [config, stats, maintenance] = await Promise.all(reads);
      return {
        configRevision: config.configRevision,
        revision: stats.storeRevision,
        settings: { ...config.memory },
        totalEntries: stats.total,
        memoryStats: { total: stats.total, manualAdded: stats.manualAdded, autoGenerated: stats.autoGenerated },
        maintenance: { ...maintenance }
      };
    } finally {
      await Promise.allSettled(reads);
      storage.close();
    }
  }

  /** 记忆条目分页读取；offset 分页，revision 供翻页一致性判断。 */
  async memoryEntries(
    projectId: string,
    offset: number,
    limit: number,
    includeArchived = false
  ): Promise<DesktopMemoryEntriesPage> {
    this.projects.requireProject(projectId);
    const store = await this.readMemoryStorePaged(projectId, offset, limit, includeArchived);
    return {
      revision: store.storeRevision,
      entries: store.entries,
      total: store.total,
      offset,
      limit
    };
  }

  async memoryEmbeddingStatus(projectId: string): Promise<DesktopMemoryEmbeddingStatus> {
    const project = this.projects.requireProject(projectId);
    const existing = await this.memoryOwner().existingStatus();
    if (existing) return describeMemoryEmbeddingStatus(existing);
    // 冷态读取同一持久化投影，不启动模型或为状态查询建立索引。
    return describeMemoryEmbeddingStatus(await this.readEmbeddingStatusFromDisk(project.path));
  }

  async downloadMemoryEmbeddingModel(
    projectId: string,
    model: LocalEmbeddingModelId
  ): Promise<DesktopMemoryEmbeddingStatus> {
    this.projects.requireProject(projectId);
    const owner = this.memoryOwner();
    await owner.download(model);
    return describeMemoryEmbeddingStatus(await owner.status());
  }

  async cancelMemoryEmbeddingDownload(projectId: string, model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult> {
    this.projects.requireProject(projectId);
    const owner = this.memoryOwner();
    return { cancelled: await owner.cancelDownload(model), status: describeMemoryEmbeddingStatus(await owner.status()) };
  }

  async deleteMemoryEmbeddingModel(projectId: string, model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingDeleteResult> {
    this.projects.requireProject(projectId);
    const owner = this.memoryOwner();
    return { ...(await owner.removeLocalModel(model)), status: describeMemoryEmbeddingStatus(await owner.status()) };
  }

  async rebuildMemoryEmbeddingIndex(projectId: string): Promise<DesktopMemoryEmbeddingStatus> {
    this.projects.requireProject(projectId);
    const owner = this.memoryOwner();
    await owner.rebuild();
    return describeMemoryEmbeddingStatus(await owner.status());
  }

  async cancelMemoryEmbeddingRebuild(projectId: string): Promise<DesktopMemoryEmbeddingCancellationResult> {
    this.projects.requireProject(projectId);
    const owner = this.memoryOwner();
    return { cancelled: await owner.cancelRebuild(), status: describeMemoryEmbeddingStatus(await owner.status()) };
  }

  async saveMemorySettings(projectId: string, input: DesktopMemorySettingsInput): Promise<DesktopMemorySettingsSnapshot> {
    this.projects.requireProject(projectId);
    const state = await this.updateGlobalPersonalization(
      projectId,
      { memory: input.settings },
      input.expectedRevision
    );
    return { configRevision: requireConfigRevision(state), settings: { ...state.memory } };
  }

  async identityOverview(projectId: string): Promise<DesktopIdentityOverview> {
    this.projects.requireProject(projectId);
    return await this.identityStorage.overview();
  }

  async saveIdentityDocument(
    projectId: string,
    document: DesktopIdentityDocumentKind,
    content: string,
    expectedRevision: number,
    reason?: string
  ): Promise<DesktopIdentityOverview> {
    this.assertNoRunningTasks("任务运行期间不能编辑身份资料。");
    this.projects.requireProject(projectId);
    return await this.identityStorage.saveDocument(document, content, expectedRevision, reason);
  }

  async searchMemory(projectId: string, query: string): Promise<DesktopMemorySearchMatch[]> {
    this.projects.requireProject(projectId);
    const { runtime } = await this.ensureRuntime(projectId);
    const result = await runtime.memory<MemorySearchResult>("search", { query, limit: 8 });
    if (result.report.degraded) throw new Error(`记忆语义搜索暂不可用：${result.report.degraded}`);
    return result.matches.map((match) => ({
      id: match.entry.id,
      originalId: match.entry.originalId,
      content: match.entry.content,
      source: match.entry.source,
      tags: match.entry.tags,
      importance: match.entry.importance,
      createdAt: match.entry.createdAt,
      updatedAt: match.entry.updatedAt,
      durability: match.entry.durability,
      expiresAt: match.entry.expiresAt,
      path: match.path,
      excerpt: match.excerpt,
      score: match.score,
      accessCount: match.entry.accessCount,
      lastAccessedAt: match.entry.lastAccessedAt,
      archivedAt: match.entry.archivedAt,
      archivedReason: match.entry.archivedReason,
      mergedInto: match.entry.mergedInto,
      archivedBy: match.entry.archivedBy
    }));
  }

  async addMemoryEntry(
    projectId: string,
    input: DesktopMemoryEntryInput
  ): Promise<DesktopMemoryStats> {
    this.projects.requireProject(projectId);
    const { runtime } = await this.runtimeForGlobalWrite(
      projectId,
      "任务运行期间不能新增记忆。"
    );
    const entry = {
      content: input.content,
      source: "manual",
      tags: input.tags,
      importance: input.importance,
      durability: input.durability,
      rationale: input.rationale
    };
    const result = await runtime.memory<{ written: boolean; path?: string }>("write", { entry });
    if (!result.written) {
      throw new Error(result.path ? "已存在等价的记忆条目，未重复保存。" : "记忆正文不能为空。");
    }
    return await this.memoryStats(projectId);
  }

  async updateMemoryEntry(
    projectId: string,
    entryId: string,
    patch: DesktopMemoryEntryPatch
  ): Promise<DesktopMemoryStats> {
    this.projects.requireProject(projectId);
    const { runtime } = await this.runtimeForGlobalWrite(
      projectId,
      "任务运行期间不能编辑记忆。"
    );
    const result = await runtime.memory<{ written: boolean }>("update", {
        id: entryId,
      patch
    });
    if (!result.written) throw new Error("未找到该记忆条目，或修改后的正文为空。");
    return await this.memoryStats(projectId);
  }

  async memorySleepStatus(projectId: string): Promise<MemoryMaintenanceStatus> {
    const project = this.projects.requireProject(projectId);
    const managed = this.residentRuntime(projectId);
    if (managed) return await managed.runtime.memory<MemoryMaintenanceStatus>("sleep-status", {});
    const storage = new MemoryStorage(project.path);
    try { return await storage.readMaintenanceStatus(); }
    finally { storage.close(); }
  }

  async memorySleepRuns(projectId: string): Promise<import("../../../agent/context/memoryTypes.js").MemorySleepRun[]> {
    const status = await this.memorySleepStatus(projectId);
    return status.sleepRuns ?? [];
  }

  async previewMemorySleep(projectId: string): Promise<import("../../protocol.js").DesktopMemorySleepPreview> {
    this.projects.requireProject(projectId);
    return await this.memoryOwner().previewSleep();
  }

  async cancelMemorySleep(projectId: string): Promise<{ cancelled: boolean }> {
    this.projects.requireProject(projectId);
    return { cancelled: await this.memoryOwner().cancelSleep() };
  }

  async runMemorySleep(projectId: string): Promise<DesktopMemoryStats> {
    this.projects.requireProject(projectId);
    await this.memoryOwner().runSleep();
    return await this.memoryStats(projectId);
  }

  async archivedMemoryEntries(projectId: string, offset: number, limit: number, includeChains = false): Promise<DesktopMemoryArchivePage> {
    const project = this.projects.requireProject(projectId);
    if (includeChains && limit > 25) throw new Error("归档合并链仅支持每页至多 25 条。");
    const managed = this.residentRuntime(projectId);
    if (!managed) {
      const storage = new MemoryStorage(project.path);
      try {
        const result = await storage.listArchivedEntries({ offset, limit });
        const entryIds = result.entries.filter((entry) => entry.mergedInto).map((entry) => entry.id);
        const chains = !includeChains || entryIds.length === 0 ? undefined : await storage.resolveArchiveChains(entryIds);
        return { revision: result.storeRevision, entries: result.entries as DesktopMemoryEntry[], chains, total: result.total, offset, limit };
      } finally {
        storage.close();
      }
    }
    const { runtime } = managed;
    const result = await runtime.memory<MemoryArchiveEntriesResult>("archive-list", { offset, limit });
    const entryIds = result.entries.filter((entry) => entry.mergedInto).map((entry) => entry.id);
    const chains = !includeChains || entryIds.length === 0 ? undefined : await runtime.memory<Record<string, { finalId: string; depth: number }>>("archive-chains", { entryIds });
    return { revision: result.storeRevision, entries: result.entries as DesktopMemoryEntry[], chains, total: result.total, offset, limit };
  }

  async archiveMemoryEntry(
    projectId: string,
    entryId: string,
    archived: boolean
  ): Promise<DesktopMemoryArchiveMutationResult> {
    this.projects.requireProject(projectId);
    const { runtime } = await this.runtimeForGlobalWrite(projectId, archived ? "任务运行期间不能归档记忆。" : "任务运行期间不能恢复记忆。");
    // 恢复会消耗归档行。与 HTTP 入口一致，写入前读取合并指向；只向界面报告仍为活动事实的目标。
    const source = archived ? null : await runtime.memory<MemoryEntry | null>("get", { id: entryId });
    const target = source?.archivedAt && (source.archivedReason === "llm_merge" || source.archivedReason === "updated") && source.mergedInto
      ? await runtime.memory<MemoryEntry | null>("get", { id: source.mergedInto }) : null;
    const result = await runtime.memory<{ archived: boolean; entry?: MemoryEntry }>("archive", { id: entryId, archived });
    const mergedTarget = target && !target.archivedAt ? { id: target.id, content: target.content } : null;
    // `archived` is the resulting state, so a successful restore legitimately
    // returns false. Presence of the returned entry is the mutation/no-op
    // success signal; absence means the id was not found.
    if (!result.entry) throw new Error("未找到该记忆条目，可能已被其他操作改变。");
    return { ...await this.memoryStats(projectId), mergedTarget };
  }

  async deleteMemoryEntry(
    projectId: string,
    entryId: string
  ): Promise<DesktopMemoryStats> {
    this.projects.requireProject(projectId);
    const { runtime } = await this.runtimeForGlobalWrite(
      projectId,
      "任务运行期间不能删除记忆。"
    );
    const result = await runtime.memory<{ deleted: boolean }>("delete", { id: entryId });
    if (!result.deleted) throw new Error("未找到该记忆条目，可能已被删除。");
    return await this.memoryStats(projectId);
  }

  async clearMemory(projectId: string): Promise<DesktopMemoryStats> {
    this.projects.requireProject(projectId);
    const { runtime } = await this.runtimeForGlobalWrite(
      projectId,
      "任务运行期间不能清空记忆。"
    );
    await runtime.memory("clear", {});
    return await this.memoryStats(projectId);
  }

  /** 设置事务只提交配置；驻留 Runtime 的刷新仍在后台进行，向量索引按自身状态收敛。 */
  settingsCommitted(prepared: PreparedDesktopSettingsConfig): void {
    if (prepared.beforeRevision !== prepared.targetRevision && configChangeRequiresRuntimeRestart(prepared.before, prepared.after)) {
      this.scheduleIdleManagedRuntimeRebuild();
    }
  }

  /**
   * 拉取服务商的实时模型目录。只有服务商成功返回非空目录时才算成功；失败由 Renderer
   * 明确提示，已有目录状态保持不变，不能把缓存包装成当前账号的实时库存。
   */
  async fetchModelCatalog(projectId: string, providerAlias: string, force = false): Promise<DesktopModelCatalogResult> {
    this.projects.requireProject(projectId);
    const config = await this.loadProjectConfig(projectId);
    const provider = config.providers[providerAlias];
    // 自定义/聚合端点不在本地 provider 表里，没有实时目录可言；回退到静态候选而不是抛错，
    // 调用方会把它和已配置模型合并展示（详情层会静默预取，不能让缺失配置刷错误日志）。
    if (!provider) return { providerAlias, source: "static", fetchedAt: new Date().toISOString(), models: [] };
    const catalogs = await restoreProviderCatalogs(Object.keys(config.providers), this.modelsStore, config.providers);
    const runtime = new ModelRuntime(config, catalogs, undefined, this.modelsStore, this.fetcher);
    try {
      const models = await runtime.refreshModels(providerAlias, undefined, force);
      return { providerAlias, source: "fetched", fetchedAt: new Date().toISOString(), models };
    } catch (error) {
      throw new Error(`无法从服务商获取模型列表：${formatModelConnectionError(error)}`, { cause: error });
    }
  }

  /**
   * 用尚未保存的候选配置拉取模型目录：新增连接流程中用户填完密钥后，先凭临时密钥向
   * 服务商要模型列表再勾选启用，避免用户手填模型 ID。失败时返回明确错误；渲染层可以
   * 展示内置候选，但必须保留其静态来源，不能当成实时目录。
   */
  async testModelConfiguration(projectId: string, input: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult> {
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    const candidate = this.buildConfigWithModel(current, input);
    if (input.providerType === "acp") {
      const launch = candidate.providers[input.providerAlias]?.acp;
      if (!launch) return { ok: false, message: "请填写 ACP 启动命令。" };
      const started = Date.now();
      let client: AcpClient | undefined;
      try {
        client = new AcpClient({ launch, cwd: this.projects.requireProject(projectId).path, mcpServers: acpMcpServers(candidate, launch), timeoutMs: candidate.providers[input.providerAlias]?.timeoutMs });
        const acp = await client.connect();
        return { ok: true, message: "ACP 会话连接成功", latencyMs: Date.now() - started, acp };
      } catch (error) { return { ok: false, message: formatModelConnectionError(error) }; }
      finally { await client?.close(); }
    }
    return await this.testCandidate(candidate, input.alias);
  }

  /**
   * 设置页按需读取当前服务商的 API Key。密钥不进入普通工作区快照，只在用户打开模型设置时返回。
   * OAuth 连接的 access token 不作为可编辑 API Key 暴露，避免把订阅登录凭据混进密钥输入框。
   */
  async readModelApiKey(projectId: string, providerAlias: string): Promise<string | undefined> {
    const provider = (await this.loadProjectConfig(projectId)).providers[providerAlias];
    if (!provider || provider.authMode === "oauth-bearer") return undefined;
    const apiKeyEnv = provider.apiKeyEnv ?? providerDefinition(provider.type).apiKeyEnv;
    return provider.apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined);
  }

  private async testCandidate(candidate: AgentConfig, alias: string): Promise<DesktopModelConnectionTestResult> {
    const model = candidate.models[alias];
    if (!model) return { ok: false, message: `未知模型：${alias}` };
    const provider = candidate.providers[model.provider];
    if (!provider) {
      return { ok: false, message: `未找到服务商配置：${model.provider}` };
    }
    const profile = providerDefinition(provider.type);
    const envName = provider.apiKeyEnv ?? profile.apiKeyEnv;
    const hasKey = Boolean(provider.apiKey || (envName && process.env[envName]));
    if ((provider.requiresApiKey ?? profile.requiresApiKey) && !hasKey) {
      return { ok: false, message: envName ? `缺少 API Key。请填写密钥，或设置环境变量 ${envName}。` : "缺少 API Key。请先填写密钥后再测试。" };
    }
    const started = Date.now();
    try {
      const settings = createModelSettings(candidate, alias, this.fetcher);
      if (!settings.vercelModel) throw new Error("Vercel model is unavailable.");
      const timeout = settings.timeoutMs === undefined ? undefined : new AbortController();
      const timer = timeout === undefined ? undefined : setTimeout(
        () => timeout.abort(new DOMException("Model connection test timed out.", "TimeoutError")),
        settings.timeoutMs
      );
      try {
        await generateText({
          model: settings.vercelModel,
          messages: [{ role: "user", content: "ping" }],
          maxOutputTokens: 16,
          providerOptions: settings.providerOptions as LanguageModelV4CallOptions["providerOptions"],
          maxRetries: settings.maxRetries ?? 0,
          abortSignal: timeout?.signal
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        message: `连接成功 · ${String(latencyMs)}ms`,
        latencyMs
      };
    } catch (error) {
      return {
        ok: false,
        message: formatModelConnectionError(error),
        latencyMs: Date.now() - started
      };
    }
  }

  private requireVersionedConfig(): AgentConfigStore & Required<Pick<AgentConfigStore, "loadVersioned" | "saveVersioned">> {
    if (!this.configStore.loadVersioned || !this.configStore.saveVersioned) {
      throw new Error("当前配置存储不支持统一设置事务。");
    }
    return this.configStore as AgentConfigStore & Required<Pick<AgentConfigStore, "loadVersioned" | "saveVersioned">>;
  }

  private requireSettingsTransactionConfig(): AgentConfigStore & Required<Pick<
    AgentConfigStore,
    | "loadVersioned"
    | "saveVersionedDeferred"
    | "deferredCredentialStatus"
    | "finalizeDeferredCredentials"
    | "rollbackVersionedDeferred"
    | "rollbackDeferredCredentials"
  >> {
    const store = this.configStore;
    if (!store.loadVersioned
      || !store.saveVersionedDeferred
      || !store.deferredCredentialStatus
      || !store.finalizeDeferredCredentials
      || !store.rollbackVersionedDeferred
      || !store.rollbackDeferredCredentials) {
      throw new Error("当前配置存储不支持统一设置凭据事务。");
    }
    return store as AgentConfigStore & Required<Pick<
      AgentConfigStore,
      | "loadVersioned"
      | "saveVersionedDeferred"
      | "deferredCredentialStatus"
      | "finalizeDeferredCredentials"
      | "rollbackVersionedDeferred"
      | "rollbackDeferredCredentials"
    >>;
  }

  private requireStagedCredential(handle: string): StagedSettingsCredential {
    this.pruneStagedSettingsCredentials();
    const staged = this.stagedSettingsCredentials.get(handle);
    if (!staged) throw new Error("暂存凭据不存在或已过期，请重新输入或登录。");
    return staged;
  }

  private requireApiKeyHandle(handle: string, used: Set<string>, scope: DesktopSettingsCredentialScope): string {
    const staged = this.requireStagedCredential(handle);
    if (staged.kind !== "api-key" || !sameCredentialScope(staged.scope, scope)) {
      throw new Error("API Key 句柄与当前项目、用途或服务商不匹配。");
    }
    used.add(handle);
    return staged.secret;
  }

  private pruneStagedSettingsCredentials(): void {
    const now = Date.now();
    for (const [handle, staged] of this.stagedSettingsCredentials) {
      if (staged.expiresAt <= now) this.stagedSettingsCredentials.delete(handle);
    }
  }

  /**
   * 只写 providers 段、不动 models：自定义服务商「先建连接、后补模型」的入口。
   * 字段按合并语义落到 provider 上（未提供即保留）；别名不存在时新建为
   * openai-compatible。端点允许被补丁改写（与模型级「服务地址」提交语义一致）；
   * 新建别名的唯一性由渲染层生成规则保证，并发提交由 CAS 事务兜底。
   */
  private buildConfigWithCustomProvider(current: AgentConfig, input: DesktopCustomProviderInput): AgentConfig {
    const existing = current.providers[input.alias];
    if (input.clearApiKey && (input.apiKey || input.apiKeyHandle)) throw new Error("删除密钥不能同时提供新密钥。");
    if (input.clearApiKey && existing?.authMode === "oauth-bearer") throw new Error("订阅凭据请通过退出登录移除。");
    const provider: ProviderConfig = {
      ...existing,
      type: existing?.type ?? "openai-compatible",
      enabled: input.enabled ?? existing?.enabled ?? true,
      displayName: input.displayName ?? existing?.displayName,
      // 图标是展示偏好：省略 = 保留现值，显式 null = 清除覆盖（回到目录默认）。
      icon: input.icon === null ? undefined : input.icon ?? existing?.icon,
      protocol: input.protocol ?? existing?.protocol,
      baseUrl: input.baseUrl ?? existing?.baseUrl,
      apiKey: input.clearApiKey ? undefined : input.apiKey ?? existing?.apiKey,
      requiresApiKey: existing?.requiresApiKey ?? true,
      apiBackend: input.apiBackend ?? existing?.apiBackend
    };
    return configSchema.parse({
      ...current,
      providers: { ...current.providers, [input.alias]: provider }
    });
  }

  private buildConfigWithModel(
    current: AgentConfig,
    input: DesktopModelConfigurationInput,
    selectedFrom: AgentConfig = current
  ): AgentConfig {
    return this.parseModelProfileEdit(current, this.applyModelUpsert(current, input), selectedFrom);
  }

  /**
   * 把单个模型 upsert 落到候选配置上，不做全量校验；批量启用先在内存里累加，最后统一
   * 过一次 configSchema（见 prepareSettingsConfig）。
   */
  private applyModelUpsert(
    current: AgentConfig,
    input: DesktopModelConfigurationInput
  ): AgentConfig {
    return this.applyModelUpserts(current, [input]);
  }

  /** 一次复制并建立去重索引，按输入顺序合并；默认模型与推理选择仍逐项推进。 */
  private applyModelUpserts(
    current: AgentConfig,
    inputs: DesktopModelConfigurationInput[]
  ): AgentConfig {
    if (!inputs.length) return current;
    const models: Record<string, AgentConfig["models"][string]> = { ...current.models };
    const providers: Record<string, AgentConfig["providers"][string]> = { ...current.providers };
    const aliasesByModelKey = new Map<string, Set<string>>();
    const modelKeyByAlias = new Map<string, string>();
    for (const [alias, model] of Object.entries(models)) {
      const key = `${model.provider}\u0000${model.model}`;
      modelKeyByAlias.set(alias, key);
      const existing = aliasesByModelKey.get(key);
      if (existing) existing.add(alias);
      else aliasesByModelKey.set(key, new Set([alias]));
    }
    let defaultModel = current.defaultModel;
    let thinking = current.thinking;
    for (const input of inputs) {
      const existingProvider = providers[input.providerAlias];
      const profile = providerDefinition(input.providerType);
      const sameProvider = existingProvider?.type === input.providerType;
      const modelProfiles = input.modelProfile === undefined
        ? (sameProvider ? existingProvider?.modelProfiles : undefined)
        : Object.assign({}, sameProvider ? existingProvider?.modelProfiles : undefined, { [input.model]: input.modelProfile });
      providers[input.providerAlias] = {
        type: input.providerType,
        acp: input.acp ?? (sameProvider ? existingProvider.acp : undefined),
        enabled: existingProvider?.enabled,
        icon: sameProvider ? existingProvider.icon : undefined,
        dataResidency: sameProvider ? existingProvider.dataResidency : undefined,
        // 自定义服务商的显示名保存在 provider 上；模型级 upsert 不携带它，不能清掉。
        displayName: sameProvider ? existingProvider.displayName : undefined,
        protocol: input.protocol,
        baseUrl: input.baseUrl ?? existingProvider?.baseUrl ?? profile.baseUrl,
        apiKey: input.apiKey ?? existingProvider?.apiKey,
        apiKeyEnv: input.apiKeyEnv ?? existingProvider?.apiKeyEnv ?? profile.apiKeyEnv,
        requiresApiKey: input.requiresApiKey,
        modelsRequiresApiKey: input.modelsRequiresApiKey ?? (sameProvider ? existingProvider.modelsRequiresApiKey : undefined),
        authMode: existingProvider?.authMode,
        oauth: existingProvider?.oauth,
        timeoutMs: sameProvider ? existingProvider.timeoutMs : undefined,
        retry: sameProvider ? existingProvider.retry : undefined,
        modelsEndpoint: sameProvider ? existingProvider.modelsEndpoint : undefined,
        headers: sameProvider ? existingProvider.headers : undefined,
        // 连接默认与模型覆盖分别保存，只有显式 providerApiBackend 才更新连接默认。
        apiBackend: input.providerApiBackend
          ?? (sameProvider ? existingProvider.apiBackend : input.apiBackend),
        compatibility: sameProvider ? existingProvider.compatibility : undefined,
        applyPatchProtocol: sameProvider ? existingProvider.applyPatchProtocol : undefined,
        embeddingModels: sameProvider ? existingProvider.embeddingModels : undefined,
        modelProfiles
      };
      const existingModel = models[input.alias];
      const sameModel = existingModel?.provider === input.providerAlias && existingModel.model === input.model;
      const modelKey = `${input.providerAlias}\u0000${input.model}`;
      // 别名改指时同步旧索引，避免后续去重误删已指向别处的模型。
      const previousKey = modelKeyByAlias.get(input.alias);
      if (previousKey !== undefined && previousKey !== modelKey) aliasesByModelKey.get(previousKey)?.delete(input.alias);
      // 同 provider+model 的其它别名让位给本次 upsert；本条自己的别名随后覆盖。
      const occupying = aliasesByModelKey.get(modelKey);
      if (occupying) {
        for (const alias of occupying) {
          if (alias === input.alias) continue;
          delete models[alias];
          modelKeyByAlias.delete(alias);
        }
        occupying.clear();
        occupying.add(input.alias);
      } else {
        aliasesByModelKey.set(modelKey, new Set([input.alias]));
      }
      modelKeyByAlias.set(input.alias, modelKey);
      // 保留仍存在的默认模型；去重移除了它或明确指定默认时才切换。
      const keepsCurrentDefault = input.alias === defaultModel || Boolean(models[defaultModel]);
      const nextDefaultModel = input.makeDefault || !keepsCurrentDefault ? input.alias : defaultModel;
      // 批内切走再切回也不能恢复已重置的推理开关。
      if (nextDefaultModel !== defaultModel) thinking = { enabled: false, effort: thinking.effort };
      defaultModel = nextDefaultModel;
      models[input.alias] = {
        provider: input.providerAlias,
        model: input.model,
        displayName: input.displayName,
        supportsTools: undefined,
        // 自动识别能力只参与运行时解析；用户覆盖统一保存在 modelProfiles。
        capabilities: undefined,
        contextWindow: sameModel ? existingModel.contextWindow : undefined,
        maxInputTokens: sameModel ? existingModel.maxInputTokens : undefined,
        maxOutputTokens: sameModel ? existingModel.maxOutputTokens : undefined,
        limits: sameModel ? existingModel.limits : undefined,
        apiBackend: input.apiBackend,
        baseUrl: sameModel ? existingModel.baseUrl : undefined,
        headers: input.headers ?? (sameModel ? existingModel.headers : undefined),
        thinkingLevelMap: sameModel ? existingModel.thinkingLevelMap : undefined,
        compatibility: input.compatibility ?? (sameModel ? existingModel.compatibility : undefined),
        pricing: sameModel ? existingModel.pricing : undefined
      };
    }
    return {
      ...current,
      defaultModel,
      providers,
      models,
      thinking
    };
  }

  /** Only profile edits may project an inherited selection that no longer parses. */
  private parseModelProfileEdit(before: AgentConfig, candidate: AgentConfig, selectedFrom: AgentConfig): AgentConfig {
    const parsed = configSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    if (parsed.error.issues.length !== 1 || issue?.code !== "custom"
      || issue.path.length !== 2 || issue.path[0] !== "thinking" || issue.path[1] !== "effort"
      || issue.message !== `Model ${candidate.defaultModel} does not support ${candidate.thinking.effort} effort.`) throw parsed.error;

    const original = selectedFrom.models[selectedFrom.defaultModel];
    const previous = before.models[before.defaultModel];
    const next = candidate.models[candidate.defaultModel];
    if (!original || !previous || !next || before.defaultModel !== selectedFrom.defaultModel
      || candidate.defaultModel !== selectedFrom.defaultModel
      || previous.provider !== original.provider || next.provider !== original.provider
      || previous.model !== original.model || next.model !== original.model
      || before.providers[previous.provider]?.type !== selectedFrom.providers[original.provider]?.type
      || candidate.providers[next.provider]?.type !== selectedFrom.providers[original.provider]?.type
      || candidate.thinking.enabled !== before.thinking.enabled || candidate.thinking.effort !== before.thinking.effort
      || !configSchema.safeParse(before).success) throw parsed.error;

    const previousProfile = before.providers[previous.provider]?.modelProfiles?.[previous.model];
    const nextProfile = candidate.providers[next.provider]?.modelProfiles?.[next.model];
    const previousMap = previousProfile?.thinkingLevelMap;
    const nextMap = nextProfile?.thinkingLevelMap;
    const sameMap = previousMap === undefined ? nextMap === undefined
      : nextMap !== undefined && Object.keys(previousMap).length === Object.keys(nextMap).length
        && Object.entries(previousMap).every(([level, native]) => nextMap[level] === native);
    if (sameMap && previousProfile?.capabilities?.reasoning === nextProfile?.capabilities?.reasoning) throw parsed.error;

    // Use the same preference projection as runtime, without validating credentials
    // or copying resolved metadata into the alias. Explicit settings selections are
    // applied verbatim after profile processing, never through this fallback.
    const model = new ModelRuntime(candidate).resolve(candidate.defaultModel).model;
    const selection = effectiveThinkingSelection(model, before.thinking);
    return configSchema.parse({ ...candidate, thinking: {
      enabled: selection !== "off",
      effort: selection === "off" ? before.thinking.effort : selection
    } });
  }

  async compact(projectId: string, hint?: string): Promise<string> {
    return await (await this.ensureRuntime(projectId)).runtime.compactConversation(hint);
  }

  /**
   * 桌面端斜杠命令。报告类命令直接读 runtime 状态，不产生会话消息；
   * `/subagent <task>` 与 `/review` 会实际派发一个子代理任务（权限档位随会话权限推导，
   * 与 TUI 相同），结果同样只进弹层、不写入会话。
   */
  async runSlashCommand(projectId: string, sessionId: string | undefined, input: string): Promise<DesktopSlashResult> {
    const operation = runtimeCommandOperation(input);
    if (operation?.startsWith("session.goal.") && sessionId === undefined && operation !== "session.goal.set") {
      if (operation === "session.goal.get" || operation === "session.goal.clear") return {
        command: "/goal", title: "当前目标", content: "当前会话没有目标。使用 /goal <目标> 开始。",
        sessionGoal: { action: operation === "session.goal.get" ? "get" : "clear" }
      };
      throw new Error("请先用 /goal set <目标> 设置当前会话目标。");
    }
    if (!["session.goal.get", "session.goal.pause", "session.goal.clear"].includes(operation ?? "")) await this.requireConfiguredModel(projectId);
    const managed = await this.ensureRuntime(projectId);
    if (operation === "session.goal.set" && sessionId === undefined) sessionId = (await managed.runtime.ensureSession({ writeIntent: true })).sessionId;
    if (sessionId !== undefined) await managed.runtime.focusSession(sessionId);
    const result = await managed.runtime.executeCommand(input, "desktop", sessionId);
    if (!result) throw new Error(`未知命令：${input.trim().split(/\s+/, 1)[0] ?? input}`);
    return operation?.startsWith("session.goal.") ? { ...result, sessionId: sessionId ?? managed.runtime.getSnapshot().info.sessionId } : result;
  }

  async runInspectorCommand(projectId: string, owner: string, kind: "review" | "side-chat", input: string, history: InspectorMessage[]): Promise<DesktopSlashResult> {
    await this.requireConfiguredModel(projectId);
    const managed = await this.ensureRuntime(projectId);
    const runtime = managed.runtime;
    const key = JSON.stringify([projectId, owner, kind]);
    let session = this.inspectorSessions.get(key);
    if (!session) {
      session = runtime.ensureSession({ writeIntent: true, focus: false }).then((created) => created.sessionId);
      this.inspectorSessions.set(key, session);
      void session.catch(() => {
        if (this.inspectorSessions.get(key) === session) this.inspectorSessions.delete(key);
      });
    }
    const sessionId = await session;
    const task = buildInspectorTask(kind, input, history, SubagentTaskManager.maxTaskCharacters);
    try {
      const result = await runtime.executeCommand(`/inspect ${task}`, "desktop", sessionId);
      if (!result) throw new Error("侧栏检查命令不可用。");
      return { ...result, title: kind === "review" ? "审阅结果" : "Biny" };
    } finally {
      await runtime.releaseSessionClaim(sessionId).catch(() => undefined);
    }
  }

  async planProjection(projectId: string, sessionId: string): Promise<import("../../protocol.js").DesktopPlanProjection> {
    const project = this.projects.requireProject(projectId);
    const persistenceRoot = await this.projects.dataRoot(project);
    await resolveSessionFile(persistenceRoot, sessionId);
    const todos = new TodoStore(persistenceRoot, sessionId);
    await todos.initialize();
    const authority = await RuntimeEventAuthority.openReadOnly(persistenceRoot);
    if (!authority) return { sessionId, plans: [], todos: todos.list(), goal: undefined };
    try {
      const graphs = await GoalGraphStore.open(persistenceRoot, authority);
      const taskRuns = await DurableTaskRunStore.open(persistenceRoot, authority);
      const goals = await SessionGoalStore.open(persistenceRoot, authority);
      authority.databaseHandle().exec("BEGIN");
      const plans = graphs.listSupervisedGraphIds(sessionId)
        .map((graphId) => planStatus({ graphs, taskRuns }, graphId, sessionId));
      return { sessionId, plans, todos: todos.list(), goal: goals.get(sessionId) };
    } finally {
      authority.close();
    }
  }

  /** 日期列表只需持久化任务；不得迁移数据库、加载模型或启动其他项目的调度器。 */
  async scheduledAutomations(projectId: string): Promise<AutomationRecord[]> {
    const project = this.projects.requireProject(projectId);
    if (project.missing) return [];
    const authority = await RuntimeEventAuthority.openReadOnly(project.path);
    if (!authority) return [];
    try {
      const store = await AutomationStore.open(project.path, authority);
      try { return store.list(); }
      finally { store.close(); }
    } finally { authority.close(); }
  }

  async taskInspection(projectId: string, sessionId: string, taskRunId: string, options: TaskInspectionOptions = {}): Promise<TaskInspection> {
    const managed = await this.getRuntime(projectId, false);
    if (managed !== undefined) {
      try { return await managed.runtime.taskInspect(taskRunId, sessionId, { ...options, waitMs: 0 }); }
      catch (error) { if (!managed.runtime.isRetired) throw error; }
    }

    const project = this.projects.requireProject(projectId);
    const root = await this.projects.dataRoot(project);
    const authority = await RuntimeEventAuthority.openReadOnly(root);
    if (!authority) throw new Error("任务记录暂不可用。");
    const tasks = await DurableTaskRunStore.open(root, authority);
    const channel = new TaskCommunication(tasks, sessionId);
    try { return await channel.inspect(taskRunId, { ...options, waitMs: 0 }); }
    finally { channel.close(); tasks.close(); authority.close(); }
  }

  async runtimeProjection(projectId: string): Promise<DesktopRuntimeProjection> {
    const managed = await this.getRuntime(projectId, false);
    if (managed) {
      try {
        return await this.readRuntimeProjection(managed);
      } catch (error) {
        if (!managed.runtime.isRetired) throw error;
      }
    }
    const project = this.projects.requireProject(projectId);
    const persistenceRoot = await this.projects.dataRoot(project);
    const worktrees = (await new WorktreeManager(project.path, persistenceRoot).status()).map(toDesktopWorktreeStatus);
    const authority = await RuntimeEventAuthority.openReadOnly(persistenceRoot);
    if (!authority) return { tasks: { tasks: [], nextCursor: undefined, hasMore: false }, automations: [], pendingFires: [], graphs: [], capabilities: [], worktrees };
    try {
      const tasks = await DurableTaskRunStore.open(persistenceRoot, authority);
      const automations = await AutomationStore.open(persistenceRoot, authority);
      const graphs = await GoalGraphStore.open(persistenceRoot, authority);
      const capabilities = await CapabilityStore.open(persistenceRoot, authority);
      authority.databaseHandle().exec("BEGIN");
      return {
        tasks: tasks.list({ order: "desc" }),
        automations: automations.list(),
        pendingFires: automations.listPending(),
        graphs: graphs.listGraphs(),
        capabilities: capabilities.list(),
        worktrees
      };
    } finally {
      authority.close();
    }
  }

  private async readRuntimeProjection({ runtime }: ManagedRuntime): Promise<DesktopRuntimeProjection> {
    const [tasks, automations, pendingFires, graphs, capabilities, worktrees] = await Promise.all([
      runtime.taskList({ order: "desc" }),
      runtime.automationList(),
      runtime.automationPending(),
      runtime.graphList(),
      runtime.capabilityList(),
      runtime.worktreeStatus()
    ]);
    return { tasks, automations, pendingFires, graphs, capabilities, worktrees: worktrees.map(toDesktopWorktreeStatus) };
  }

  async runtimeEvents(projectId: string, afterSequence?: number, limit?: number): Promise<unknown> {
    const { runtime } = await this.ensureRuntime(projectId);
    return await runtime.subscribeRuntimeEvents({ afterSequence, limit });
  }

  async runtimeMutation(projectId: string, operation: DesktopRuntimeMutation, payload: Record<string, unknown> = {}): Promise<unknown> {
    const { runtime } = await this.ensureRuntime(projectId);
    return await executeRemoteRuntimeMutation(runtime, operation, payload);
  }

  /** Creation does not select: the originating renderer owns subsequent navigation. */
  async branchSessionAtMessage(projectId: string, sessionId: string, messageId: string): Promise<string> {
    const project = this.projects.requireProject(projectId);
    return await this.projects.branchSessionAtMessage(project, sessionId, messageId);
  }

  async duplicateSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const project = this.projects.requireProject(projectId);
    const targetSessionId = await this.projects.duplicateSession(project, sessionId);
    await this.state.setSelectedSession(projectId, targetSessionId);
    return await this.workspaceSnapshot(projectId);
  }

  /**
   * 导出会话到用户选定的文件。`targetPath` 由 IPC 层的保存对话框给出；用户取消时它是
   * undefined，这里就只回一份快照、不写任何文件。
   */
  async exportSession(projectId: string, sessionId: string, format: "biny" | "claude", targetPath?: string): Promise<DesktopWorkspaceSnapshot> {
    const project = this.projects.requireProject(projectId);
    if (targetPath) {
      this.assertNoRunningTasks("任务运行期间不能导出会话。");
      const exported = await this.projects.buildSessionExport(project, sessionId, format);
      await this.projects.writeSessionExport(targetPath, exported);
    }
    return await this.workspaceSnapshot(projectId);
  }

  /**
   * 从外部文件导入一条新会话并选中它。`sourcePath` 由 IPC 层的打开对话框给出；用户取消时
   * 它是 undefined，这里只回一份快照。
   */
  async importSession(projectId: string, sourcePath?: string): Promise<DesktopWorkspaceSnapshot> {
    const project = this.projects.requireProject(projectId);
    if (sourcePath) {
      this.assertNoRunningTasks("任务运行期间不能导入会话。");
      const imported = await this.projects.importSessionFromFile(project, sourcePath);
      await this.state.setSelectedSession(projectId, imported.sessionId);
    }
    return await this.workspaceSnapshot(projectId);
  }

  async deleteSessions(targets: DesktopSessionTarget[]): Promise<DesktopSessionDeleteResult> {
    const result: DesktopSessionDeleteResult = { cancelled: false, deleted: [], failures: [] };
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.projectId}\0${target.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await this.deleteSessionData(target.projectId, target.sessionId);
        result.deleted.push(target);
      } catch (error) {
        result.failures.push({ ...target, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private async deleteSessionData(projectId: string, sessionId: string): Promise<void> {
    const managed = await this.getRuntime(projectId, false);
    if (managed) {
      const target = managed.runtime.runtimeSnapshots().find((entry) => entry.sessionId === sessionId);
      if (target && runtimeIsBusy(target.snapshot)) throw new Error("Stop the running task before deleting this session.");
      if (target?.primary || managed.runtime.getSnapshot().info.sessionId === sessionId) {
        // 先轮换 primary 并关闭旧 runtime，再删除旧文件；普通 restart 会保留
        // sessionId，不能拿来承担删除语义。
        await managed.runtime.rotatePrimarySession();
      } else if (target) {
        await managed.runtime.closeSession(sessionId);
      }
    }
    await this.projects.deleteSession(this.projects.requireProject(projectId), sessionId);
    this.liveEvents.get(projectId)?.delete(sessionId);
    if (this.state.selectedSessionId(projectId) === sessionId) {
      await this.state.setSelectedSession(projectId, undefined);
    }
  }

  async disposeProject(projectId: string): Promise<void> {
    const disposing = this.projectDisposals.get(projectId);
    if (disposing) return await disposing;
    // Retire admitted work synchronously, before any resource cleanup yields.
    this.runtimeLifetimes.delete(projectId);
    if (this.activeProjectId === projectId) this.activeProjectId = undefined;
    // 移除项目同时清理展示缓存；后台任务是否需要驻留由 Host 判断。
    this.liveEvents.delete(projectId);
    this.draftSessionIds.delete(projectId);
    this.runtimeErrors.delete(projectId);
    for (const key of this.writerConflicts.keys()) {
      if (key.startsWith(`${projectId}\0`)) this.writerConflicts.delete(key);
    }
    const managed = this.runtimes.get(projectId);
    this.runtimes.delete(projectId);
    const pending = this.runtimeInitializations.get(projectId);
    const disposal = Promise.resolve().then(async () => {
      // A stale initializer closes what it acquired before its promise settles.
      // Do not drop it from runtimeInitializations: closeAll must also drain it.
      await Promise.allSettled([pending]);
      if (managed) await this.closeManagedRuntime(managed);
    });
    this.projectDisposals.set(projectId, disposal);
    try {
      await disposal;
    } finally {
      if (this.projectDisposals.get(projectId) === disposal) this.projectDisposals.delete(projectId);
    }
  }

  /** 关窗前用它决定要不要提示用户：等待权限也算「在跑」，直接关掉会丢掉这次询问。 */
  hasRunningTasks(): boolean {
    return [...this.runtimes.keys()]
      .some((projectId) => this.isProjectRunning(projectId));
  }

  /**
   * 全局配置、共享记忆库、Embedding 缓存和 Cookie 都跨项目复用。任何驻留项目仍在
   * 运行时都不能写这些资源，否则另一个 Runtime 会在单次回合中读到两套状态。
   */
  assertNoRunningTasks(message = "任务运行期间不能修改全局共享状态。"): void {
    if (this.hasRunningTasks()) throw new Error(message);
  }

  isProjectRunning(projectId: string): boolean {
    return this.runtimeEntries(projectId).some(({ runtime }) => runtime.runtimeSnapshots().some(({ snapshot }) => runtimeIsBusy(snapshot)));
  }

  private assertProjectGitMutationIdle(projectId: string): void {
    this.projects.requireProject(projectId);
    if (this.runtimeInitializations.has(projectId) || this.isProjectRunning(projectId)) {
      throw new Error("当前项目正在运行或维护中，不能切换 Git 分支。请稍后重试。");
    }
  }

  cancelAll(): void {
    for (const projectId of this.runtimes.keys()) {
      for (const { runtime } of this.runtimeEntries(projectId)) {
        for (const { sessionId, snapshot } of runtime.runtimeSnapshots()) {
          const run = activeRun(snapshot);
          if (run) void runtime.cancelRunRequest(run.runId, "cancelled", sessionId).catch(() => undefined);
        }
      }
    }
  }

  /**
   * Desktop 关闭时先让暂停请求到达 Host，保留断点并等待快照收敛。
   * 超时只是不再阻塞窗口关闭；Host 仍负责执行收尾和落盘。
   */
  async pauseAllForExit(timeoutMs = 2_500): Promise<void> {
    const projectIds = new Set(this.runtimes.keys());
    await Promise.all([...projectIds].flatMap((projectId) => this.runtimeEntries(projectId).map(async ({ runtime }) => {
      const deadline = Date.now() + timeoutMs;
      const runs = await waitForRuntimeOperation(runtime.pauseOwnedRunsForExit(), remainingTimeout(deadline));
      await Promise.all((runs ?? []).map(async ({ sessionId }) => {
        await waitForRuntimeIdle(runtime, remainingTimeout(deadline), sessionId);
      }));
    })));
  }

  /** 先从后台 Host 撤销 Desktop 持有的浏览器端点，再销毁浏览器服务。 */
  async detachBrowserAutomation(): Promise<void> {
    const targets = new Set<RuntimeHostClient | RuntimeHostServer>();
    for (const managed of this.runtimes.values()) {
      if (managed.host) targets.add(managed.host);
      else targets.add(managed.runtime);
    }
    await Promise.all([...targets].map(async (target) => await target.setBrowserAutomation(undefined)));
  }

  /**
   * 退出前收尾。先置 `closing` 挡住新的创建请求，再等正在初始化的运行时结束（否则它们会
   * 在关闭之后才注册进来，成为泄漏的运行时），最后统一取消订阅并关闭。
   */
  async closeAll(): Promise<void> {
    this.closing = true;
    for (const operation of this.modelLoginOperations.values()) operation.abort(new DOMException("Desktop is shutting down", "AbortError"));
    this.modelLoginOperations.clear();
    this.stagedSettingsCredentials.clear();
    await Promise.allSettled([...this.pendingSessionReads.values()].map(({ promise }) => promise));
    this.pendingSessionReads.clear();
    await Promise.allSettled(this.pendingSessionReadPublications);
    await Promise.allSettled(this.runtimeInitializations.values());
    await Promise.allSettled(this.projectDisposals.values());
    this.runtimeLifetimes.clear();
    await this.idleRuntimeRebuildTail.catch(() => undefined);
    const managedRuntimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.draftSessionIds.clear();
    await Promise.all(managedRuntimes.map(async (managed) => await this.closeManagedRuntime(managed)));
  }

  private async disposeRuntime(projectId: string): Promise<void> {
    const managed = this.runtimes.get(projectId);
    if (!managed) return;
    await this.closeManagedRuntime(managed);
    this.runtimes.delete(projectId);
  }

  /** 配置变更需要 owner 重建 CommandRuntime；远端 client 通过 Host RPC 完成同一件事。 */
  private async rebuildManagedRuntime(projectId: string, managed: ManagedRuntime): Promise<void> {
    if (managed.runtime.isRetired) {
      await this.disposeRuntime(projectId);
      return;
    }
    const focusedSessionId = managed.runtime.getFocusedSessionId();
    for (const entry of managed.runtime.runtimeSnapshots()) {
      await managed.runtime.restartRuntime(entry.sessionId);
    }
    // 配置重载覆盖所有驻留 Session，不能把用户正在查看的
    // 非主 session 偷偷切回 primary。
    if (focusedSessionId !== undefined && focusedSessionId !== managed.runtime.getFocusedSessionId()) {
      const stillResident = managed.runtime.runtimeSnapshots().some((entry) => entry.sessionId === focusedSessionId);
      if (stillResident) await managed.runtime.focusSession(focusedSessionId);
    }
    return;
  }

  /** 全局 config 对每个项目 Runtime 生效；显式事务提交与补偿会等待空闲实例刷新。 */
  private async rebuildIdleManagedRuntimes(): Promise<void> {
    const resident = [...this.runtimes.entries()];
    for (const [projectId, managed] of resident) {
      // 只处理快照中的原实例；并发导航若已经替换了它，不应误关新 Runtime。
      if (this.runtimes.get(projectId) !== managed || this.runtimeSnapshots(projectId).some((snapshot) => runtimeIsBusy(snapshot))) continue;
      await this.rebuildManagedRuntime(projectId, managed);
      this.runtimeErrors.delete(projectId);
    }
  }

  /** 后台派生刷新逐个容错，单个项目的 Host 异常不能阻止其它项目收敛到新配置。 */
  private async rebuildIdleManagedRuntimesInBackground(): Promise<void> {
    const resident = [...this.runtimes.entries()];
    for (const [projectId, managed] of resident) {
      // 只处理快照中的原实例；并发导航若已经替换了它，不应误关新 Runtime。
      if (this.runtimes.get(projectId) !== managed || this.runtimeSnapshots(projectId).some((snapshot) => runtimeIsBusy(snapshot))) continue;
      try {
        await this.rebuildManagedRuntime(projectId, managed);
        this.runtimeErrors.delete(projectId);
      } catch (error) {
        this.recordRuntimeFailure(projectId, error);
      }
    }
  }

  /**
   * 全局即时设置只需先确认当前 Runtime 的写入；其它空闲实例的重建放到后台串行执行，
   * 避免一个项目的 Host 重启把所有项目的开关点击拖成可见延迟。
   */
  private scheduleIdleManagedRuntimeRebuild(): void {
    const scheduled = this.idleRuntimeRebuildTail
      .catch(() => undefined)
      .then(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await this.rebuildIdleManagedRuntimesInBackground();
      });
    this.idleRuntimeRebuildTail = scheduled.catch(() => undefined);
  }

  private async closeManagedRuntime(managed: ManagedRuntime): Promise<void> {
    managed.unsubscribe();
    try {
      await managed.host?.close();
    } finally {
      await managed.runtime.close();
      // 独立 Host 可能已被 CLI/TUI 复用；是否退出由 Host 的连接和驻留工作共同决定。
    }
  }

  /**
   * 取得项目运行时，没有就创建。并发调用会复用同一个初始化 promise，避免同一项目被初始化两次
   * （两个运行时抢同一份 session 和运行锁）。
   */
  private async ensureRuntime(projectId: string): Promise<ManagedRuntime> {
    const managed = await this.getRuntime(projectId, true);
    if (!managed) throw new Error("Runtime Host initialization did not produce a client.");
    return managed;
  }

  private runtimeLifetime(projectId: string): symbol {
    let lifetime = this.runtimeLifetimes.get(projectId);
    if (lifetime === undefined) {
      lifetime = Symbol(projectId);
      // Admissions attempted during disposal must stay stale after its barrier clears.
      if (!this.closing && !this.projectDisposals.has(projectId) && this.state.project(projectId) !== undefined) {
        this.runtimeLifetimes.set(projectId, lifetime);
      }
    }
    return lifetime;
  }

  private isRuntimeLifetimeCurrent(projectId: string, lifetime: symbol): boolean {
    return !this.closing && !this.projectDisposals.has(projectId)
      && this.runtimeLifetimes.get(projectId) === lifetime && this.state.project(projectId) !== undefined;
  }

  private async getRuntime(projectId: string, allowSpawn: boolean, lifetime = this.runtimeLifetime(projectId)): Promise<ManagedRuntime | undefined> {
    if (this.closing) throw new Error("Desktop runtime is shutting down.");
    if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
    const current = this.runtimes.get(projectId);
    if (current && !(current.runtime.isRetired)) return current;
    const pending = this.runtimeInitializations.get(projectId);
    if (pending && !allowSpawn) return undefined;
    if (pending) {
      const managed = await pending;
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
      if (managed && this.runtimes.get(projectId) === managed) return managed;
      return await this.getRuntime(projectId, true, lifetime);
    }
    const initialization = (async () => {
      if (current) {
        await current.runtime.waitForRetirement();
        await this.closeManagedRuntime(current);
        if (this.runtimes.get(projectId) === current) this.runtimes.delete(projectId);
      }
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
      return await this.initializeRuntime(projectId, allowSpawn, lifetime);
    })();
    this.runtimeInitializations.set(projectId, initialization);
    try {
      const managed = await initialization;
      return this.isRuntimeLifetimeCurrent(projectId, lifetime) ? managed : undefined;
    } catch (error) {
      if (this.isRuntimeLifetimeCurrent(projectId, lifetime)) this.recordRuntimeFailure(projectId, error);
      throw error;
    } finally {
      if (this.runtimeInitializations.get(projectId) === initialization) this.runtimeInitializations.delete(projectId);
    }
  }

  private observeRunCompletion(projectId: string, completion: Promise<AgentRunOutcome>): void {
    void completion.then(
      (outcome) => {
        // 正常的终态结果通过 AgentHostEvent 呈现，这里不重复上报；
        // 只有真正跑成功了才清掉之前记下的初始化错误。
        if (outcome.status === "completed") this.runtimeErrors.delete(projectId);
      },
      (error: unknown) => {
        // busy admission 拒绝只是竞态信号，run 从未开始；锁死项目视图会把正在正常跑的任务也挡在门外。
        if (isBusyAdmissionError(error)) return;
        this.recordRuntimeFailure(projectId, error);
      }
    );
  }

  private async initializeRuntime(projectId: string, allowSpawn: boolean, lifetime: symbol): Promise<ManagedRuntime | undefined> {
    const project = this.projects.requireProject(projectId);
    if (project.missing) throw new Error(`Project path is unavailable: ${project.path}`);
    // session 和附件都走全局按项目隔离的目录；三端通过同一个 workspace 定位同一份历史。
    const persistenceRoot = await this.projects.dataRoot(project);
    if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
    let runtime: RuntimeHostClient | undefined;
    let host: RuntimeHostServer | undefined;
    let attached: RuntimeHostClient | undefined;
    const supportsDetachedRuntimeHost = this.configStore.supportsDetachedRuntimeHost !== false
      && this.runtimeHostAppPath !== undefined;
    const configPath = this.configStore.configPath?.();
    const configDir = configPath === undefined ? globalConfigDir() : path.dirname(configPath);
    let published = false;
    try {
      if (allowSpawn && supportsDetachedRuntimeHost) {
        const connected = await connectOrSpawnRuntimeHostWithOwnership(persistenceRoot, {
          lifecycleMode: "ephemeral",
          idleGraceMs: DESKTOP_HOST_IDLE_GRACE_MS,
          workspaceRoot: project.path,
          configDir,
          attachmentRoot: this.projects.attachmentsRoot(project),
          electronAppPath: this.runtimeHostAppPath,
          // Desktop 启动本身不是恢复动作；只有用户打开会话或发送新消息时才选择 session。
          sessionId: undefined,
          resumeInterrupted: false,
          clientId: `desktop-${process.pid}`,
          surface: "desktop",
          keepAlive: this.activeProjectId === projectId,
          browserAutomation: this.browserAutomation ? { ...this.browserAutomation, projectId } : undefined
        });
        attached = connected?.client;
      } else {
        // 凭据限制的是独立启动能力；同环境已有 owner 时仍复用它，且不授予自动接管能力。
        attached = await connectRuntimeHost(persistenceRoot, {
          configDir,
          clientId: `desktop-${process.pid}`,
          surface: "desktop",
          keepAlive: this.activeProjectId === projectId
        });
      }
      runtime = attached;
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime) || (!attached && !allowSpawn)) return undefined;
      if (attached) {
        runtime = attached;
        await attached.waitForReady();
        await attached.setBrowserAutomation(this.browserAutomation
          ? { ...this.browserAutomation, projectId }
          : undefined);
      } else {
        const createLocalRuntime = createRuntimeHostFactory(project.path, () => ({
          persistenceRoot,
          configStore: this.configStore,
          attachmentRoot: this.projects.attachmentsRoot(project),
          browserAutomation: this.browserAutomation ? { ...this.browserAutomation, projectId } : undefined
        }));
        // safeStorage 留在 Electron；仍通过统一 Host 注册表承载每个 Session。
        // 先取得 owner lock，再打开 Runtime 的 store，避免失败候选提前执行恢复。
        host = await startRuntimeHost(persistenceRoot, (resourceRegistry) => createLocalRuntime(undefined, {
          resourceRegistry,
          resourceBoot: "background"
        }), {
          workspaceRoot: project.path,
          createRuntime: createLocalRuntime,
          resumeInterrupted: false,
          configDir
        });
        void this.memoryOwner().sleepStatus().catch(() => undefined);
        if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
        const client = await connectRuntimeHost(persistenceRoot, {
          configDir,
          clientId: `desktop-${process.pid}`,
          surface: "desktop",
          keepAlive: this.activeProjectId === projectId
        });
        if (!client) throw new Error("无法连接当前 Desktop 的 Runtime Host。");
        runtime = client;
      }
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
      await runtime.waitForReady();
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
      // Desktop 可能 attach 到上一次启动后仍存活的 Runtime Host。先把 owner 的内存策略
      // 对齐到磁盘，再订阅历史事件，避免旧快照在首轮回放时覆盖刚恢复的权限模式。
      await this.synchronizePersistedPermissionMode(project.path, runtime);
      if (!this.isRuntimeLifetimeCurrent(projectId, lifetime)) return undefined;
      const unsubscribe = this.wireRuntimeEvents(projectId, runtime);
      const managed: ManagedRuntime = { runtime, host, unsubscribe };
      this.runtimes.set(projectId, managed);
      published = true;
      for (const entry of runtime.runtimeSnapshots()) {
        this.emit(projectId, { snapshot: entry.snapshot }, { sessionId: entry.sessionId, primary: entry.primary });
      }
      this.runtimeErrors.delete(projectId);
      return managed;
    } finally {
      if (!published) {
        // Only this Desktop client and its own in-process fallback are owned here.
        // An attached/detached Host and its other clients/jobs remain Host-owned.
        try {
          await runtime?.close();
        } finally {
          await host?.close();
        }
      }
    }
  }

  private async synchronizePersistedPermissionMode(
    workspaceRoot: string,
    runtime: RuntimeHostClient
  ): Promise<void> {
    const persistedMode = (await this.configStore.load(workspaceRoot)).permission.mode;
    const snapshot = runtime.getSnapshot();
    if (snapshot.permissionMode === persistedMode || runtimeIsBusy(snapshot)) return;

    await runtime.setPermissionMode(persistedMode);
  }

  private async requireConfiguredModel(projectId: string): Promise<void> {
    const config = await this.loadProjectConfig(projectId);
    if (listPickerModelChoices(config).length === 0) {
      throw new Error("请先在设置的“模型”中配置一个可用模型，再开始任务。");
    }
  }

  private async personalizationState(projectId: string, sessionId: string): Promise<AgentPersonalizationState> {
    const managed = await this.ensureRuntime(projectId);
    await managed.runtime.ensureSession({ sessionId, focus: false });
    return await managed.runtime.getPersonalizationState(sessionId);
  }

  private async currentPersonalizationState(projectId: string): Promise<AgentPersonalizationState> {
    return await this.readManagedPersonalizationState(await this.ensureRuntime(projectId));
  }

  private async readManagedPersonalizationState(managed: ManagedRuntime): Promise<AgentPersonalizationState> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await managed.runtime.getPersonalizationState();
      } catch (error) {
        lastError = error;
        // Host 启动时的记忆维护也会读取 config；loader 在校正文件权限时可能改变 ctime，
        // 让两个只读请求之一得到瞬时快照冲突。这里只重试明确的只读竞态，不重试写操作。
        if (attempt === 2 || !(error instanceof Error) || !error.message.includes("config.json changed while it was being read")) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async updateGlobalPersonalization(
    projectId: string,
    update: GlobalPersonalizationUpdate,
    expectedRevision: string
  ): Promise<AgentPersonalizationState> {
    // 上一次全局设置提交后的空闲实例重建不能和本次 Runtime RPC 并发，
    // 否则用户连续点击时可能正好撞上 Host 重启；首个点击仍不等待本次写入后的后台任务。
    await this.idleRuntimeRebuildTail.catch(() => undefined);
    this.assertNoRunningTasks("任务运行期间不能修改个性化或记忆设置。");
    const managed = await this.ensureRuntime(projectId);
    this.assertNoRunningTasks("任务运行期间不能修改个性化或记忆设置。");
    const state = await managed.runtime.updateGlobalPersonalization(update, expectedRevision);
    this.scheduleIdleManagedRuntimeRebuild();
    return state;
  }

  private async runtimeForGlobalWrite(projectId: string, busyMessage: string): Promise<ManagedRuntime> {
    this.assertNoRunningTasks(busyMessage);
    const managed = await this.ensureRuntime(projectId);
    // 初始化 Runtime 期间另一个项目可能开始运行，真正写入前必须再做一次全局检查。
    this.assertNoRunningTasks(busyMessage);
    return managed;
  }

  /** runtime 已驻留：普通读取不占用 Runtime 独占，允许各投影短暂跨 revision。 */
  private async readMemoryStoreFromRuntime(
    managed: ManagedRuntime
  ): Promise<{ overview: MemoryOverview; entries: MemoryEntriesResult; allEntries: MemoryEntriesResult; maintenance: MemoryMaintenanceStatus }> {
    const { runtime } = managed;
    return await runtime.memory<{
      overview: MemoryOverview;
      entries: MemoryEntriesResult;
      allEntries: MemoryEntriesResult;
      maintenance: MemoryMaintenanceStatus;
    }>("overview", {});
  }

  /**
   * runtime 未驻留：不触发冷启动，主进程直接读 Agent SQLite。
   * SQLite 读取使用自己的只读查询；与正在写入的进程并发时由 SQLite 事务保证一致性。
   */
  private async readMemoryStoreFromDisk(
    projectId: string
  ): Promise<{ overview: MemoryOverview; entries: MemoryEntriesResult; allEntries: MemoryEntriesResult; maintenance: MemoryMaintenanceStatus }> {
    const project = this.projects.requireProject(projectId);
    const storage = new MemoryStorage(project.path);
    // entries 与 allEntries 是同一份全量结果的两个用途（分页页脚 / 统计），
    // 原来读了两次，等于把全部记忆正文反序列化两遍。
    const reads = [
      storage.getOverview(),
      storage.listEntries(),
      storage.readMaintenanceStatus()
    ] as const;
    try {
      const [overview, allEntries, maintenance] = await Promise.all(reads);
      return { overview, entries: allEntries, allEntries, maintenance };
    } finally {
      // Promise.all rejects early; finish every owned read before closing its storage.
      await Promise.allSettled(reads);
      storage.close();
    }
  }

  /** 记忆条目分页读取；runtime 驻留走 runtime，未驻留直连。 */
  private async readMemoryStorePaged(
    projectId: string,
    offset: number,
    limit: number,
    includeArchived = false
  ): Promise<{ entries: MemoryEntriesResult["entries"]; total: number; storeRevision: number }> {
    const managed = this.residentRuntime(projectId);
    if (managed) {
      const result = await managed.runtime.memory<MemoryEntriesResult>("list", { offset, limit, includeArchived });
      return { entries: result.entries, total: result.total, storeRevision: result.storeRevision };
    }
    const project = this.projects.requireProject(projectId);
    const storage = new MemoryStorage(project.path);
    try {
      const result = await storage.listEntries({ offset, limit, includeArchived });
      return { entries: result.entries, total: result.total, storeRevision: result.storeRevision };
    } finally {
      storage.close();
    }
  }

  /** 冷态复用只读索引统计，不加载模型权重或创建向量投影。 */
  private async readEmbeddingStatusFromDisk(workspaceRoot: string): Promise<MemoryEmbeddingRuntimeStatus> {
    const config = (await this.requireVersionedConfig().loadVersioned!(workspaceRoot)).config;
    const localManager = new LocalEmbeddingManager(path.join(globalAgentDir(), "models", "embeddings"));
    const storage = new MemoryStorage(workspaceRoot);
    const providerModels = describeEmbeddingModels(config).filter(descriptor => descriptor.source === "provider");
    const service = new MemoryEmbeddingService({
      localMemory: {
        listMemoryEntries: options => storage.listEntries(options),
        getOverview: options => storage.getOverview(options)
      },
      localManager,
      getVectorIndex: () => { throw new Error("Settings status cannot create an embedding index."); },
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(globalAgentDir()),
      getActiveModel: () => selectMemoryEmbeddingModel(config.context.memory.embeddingModel, providerModels),
      getProviderModels: () => providerModels,
      getRuntime: async () => undefined,
      getNeedsRebuild: () => config.needsEmbeddingRebuild === true
    });
    try { return await service.status(); }
    finally { service.close(); storage.close(); await localManager.close(); }
  }

  private buildConfigWithAuthenticatedLogin(current: AgentConfig, authenticated: AuthenticatedModelLogin): AgentConfig {
    const providerAlias = authenticated.provider;
    const providerType = authenticated.provider === "claude-code" ? "claude-subscription" : "openai-codex";
    const profile = providerDefinition(providerType);
    const existingProvider = current.providers[providerAlias];
    const models = Object.fromEntries(Object.entries(current.models).filter(([, model]) => model.provider !== providerAlias));
    const existingModels = Object.entries(current.models)
      .filter(([, model]) => model.provider === providerAlias)
      .map(([, model]) => ({
        id: model.model,
        displayName: model.displayName ?? model.model,
        supportsThinking: model.capabilities?.reasoning === true
      }));
    const fallbackSource = providerType === "openai-codex"
      ? builtinProviderModels["openai-codex"] ?? []
      : builtinProviderModels.anthropic ?? [];
    const fallbackModels = fallbackSource.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      supportsThinking: model.capabilities.reasoning === true
    }));
    const authenticatedModels = authenticated.models?.length
      ? authenticated.models
      : existingModels.length ? existingModels : fallbackModels;
    const aliases = new Set<string>();
    const configuredModels = authenticatedModels.map((model) => {
      const baseAlias = modelAliasForAuthenticatedModel(providerAlias, model.id);
      let alias = baseAlias;
      let suffix = 2;
      while (aliases.has(alias)) alias = `${baseAlias}-${String(suffix++)}`;
      aliases.add(alias);
      return [alias, {
        provider: providerAlias,
        model: model.id,
        displayName: model.displayName,
        supportsTools: true,
        capabilities: { tools: true, reasoning: model.supportsThinking }
      }] as const;
    });
    const defaultModel = configuredModels[0]?.[0];
    if (!defaultModel) throw new Error("账号没有返回可用模型。");
    return configSchema.parse({
      ...current,
      defaultModel,
      providers: {
        ...current.providers,
        [providerAlias]: {
          type: providerType,
          enabled: existingProvider?.enabled,
          icon: existingProvider?.icon,
          displayName: existingProvider?.displayName,
          baseUrl: profile.baseUrl,
          apiKey: authenticated.accessToken,
          apiKeyEnv: undefined,
          authMode: "oauth-bearer",
          oauth: {
            provider: authenticated.provider,
            refreshToken: authenticated.refreshToken,
            expiresAt: authenticated.expiresAt,
            accountId: authenticated.accountId
          },
          timeoutMs: existingProvider?.timeoutMs,
          applyPatchProtocol: existingProvider?.applyPatchProtocol,
          modelProfiles: existingProvider?.modelProfiles
        }
      },
      models: { ...models, ...Object.fromEntries(configuredModels) },
      thinking: { enabled: false, effort: "high" }
    });
  }

  private async loadProjectConfig(projectId: string): Promise<AgentConfig> {
    return await this.configStore.load(this.projects.requireProject(projectId).path);
  }

  private scheduleSessionRead(project: DesktopProject, sessionId: string, initialRevision: string | undefined): void {
    if (this.closing) return;
    const key = sessionReadKey(project.id, sessionId);
    const pending = this.pendingSessionReads.get(key);
    if (pending && pending.initialRevision === initialRevision) return;
    const onIndexRefresh = (completion: Promise<void>): void => {
      this.pendingSessionReadPublications.add(completion);
      void completion.then(() => this.pendingSessionReadPublications.delete(completion), () => this.pendingSessionReadPublications.delete(completion));
    };
    let promise: Promise<SessionCatalogRecord>;
    try {
      // 新 revision 的已读写入接在旧请求后，保证替换映射后关闭仍能等完全部写入。
      promise = pending === undefined
        ? this.projects.markSessionRead(project, sessionId, undefined, onIndexRefresh)
        : pending.promise.catch(() => undefined).then(() => this.projects.markSessionRead(project, sessionId, undefined, onIndexRefresh));
    } catch {
      return;
    }
    this.pendingSessionReads.set(key, { initialRevision, promise });
    // 保留已完成的 promise 一小段时间，让紧接着发生的置顶/改名仍能拿到后台写入后的
    // revision；否则清理微任务和用户点击之间会出现一个很窄的 CAS 冲突窗口。
    void promise.then(() => {
      if (this.pendingSessionReads.get(key)?.promise !== promise) return;
      const cleanup = setTimeout(() => {
        if (this.pendingSessionReads.get(key)?.promise === promise) this.pendingSessionReads.delete(key);
      }, 30_000);
      cleanup.unref?.();
    }, () => {
      if (this.pendingSessionReads.get(key)?.promise === promise) this.pendingSessionReads.delete(key);
    });
  }

  private async resolvePendingSessionRead(
    projectId: string,
    sessionId: string,
    expectedRevision: string | undefined
  ): Promise<string | undefined> {
    const pending = this.pendingSessionReads.get(sessionReadKey(projectId, sessionId));
    if (!pending) return expectedRevision;
    const record = await pending.promise.catch(() => undefined);
    const key = sessionReadKey(projectId, sessionId);
    if (this.pendingSessionReads.get(key) === pending) this.pendingSessionReads.delete(key);
    return record && expectedRevision === pending.initialRevision
      ? sessionCatalogRecordRevision(record)
      : expectedRevision;
  }

  private projectEvents(projectId: string): Map<string, AgentHostEvent[]> {
    const current = this.liveEvents.get(projectId);
    if (current) return current;
    const events = new Map<string, AgentHostEvent[]>();
    this.liveEvents.set(projectId, events);
    return events;
  }
}

function sessionReadKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

function memoryStats(entries: MemoryEntriesResult): { total: number; autoGenerated: number; manualAdded: number } {
  let autoGenerated = 0;
  let manualAdded = 0;
  for (const entry of entries.entries) {
    if (entry.source === "manual") manualAdded += 1;
    else autoGenerated += 1;
  }
  return { total: entries.entries.length, autoGenerated, manualAdded };
}

function modelAliasForAuthenticatedModel(providerAlias: string, modelId: string): string {
  return `${providerAlias}-${modelId}`.replace(/[^a-z0-9.-]+/gi, "-");
}

function resolveConfiguredModelAlias(config: AgentConfig, aliasOrReference: string): string | undefined {
  if (config.models[aliasOrReference]) return aliasOrReference;
  const separator = aliasOrReference.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = aliasOrReference.slice(0, separator);
  const model = aliasOrReference.slice(separator + 1);
  return Object.entries(config.models).find(([, candidate]) => candidate.provider === provider && candidate.model === model)?.[0];
}

/**
 * Projects the saved provider configs into the credential/endpoint facts the
 * settings UI needs. 普通设置快照只报告存在性；API Key 只有在设置页明确读取时才跨 IPC 返回，
 * refresh token 始终不跨桥。
 */
function describeWebSearchSettings(search: AgentConfig["web"]["search"]): DesktopWebSearchSettings {
  return { provider: search.provider, visibleBrowsing: search.visibleBrowsing, timeoutMs: search.timeoutMs, maxResults: search.maxResults };
}

function describeSettingsConfigSnapshot(
  config: AgentConfig,
  revision: string,
  projectId: string,
  workspaceRoot: string,
  catalogs: readonly [string, ModelCatalogEntry[]][]
): DesktopSettingsConfigSnapshot {
  return {
    revision,
    activity: structuredClone(config.activity),
    identity: structuredClone(config.context.identity),
    memory: structuredClone(config.context.memory),
    compaction: structuredClone(config.context.compaction),
    chatParams: structuredClone(config.chat),
    rtkEnabled: config.agent.rtkEnabled,
    toolExecutionMode: config.agent.toolExecutionMode,
    externalSubagentBlockers: [
      ...(config.sandbox.mode !== "off" || !config.sandbox.allowNetwork ? ["当前沙箱或网络限制不支持外部子代理。"] : []),
      ...(config.extensions.subagent.maxSteps !== undefined || config.extensions.subagent.maxCostUsd !== undefined
        ? ["请先在配置文件中移除子代理步数或费用上限，或使用 Biny 内置运行方式。"] : [])
    ],
    subagent: { enabled: config.extensions.subagent.enabled, runtime: config.extensions.subagent.runtime ?? "builtin", model: config.extensions.subagent.model,
      providerAlias: config.extensions.subagent.runtime === "acp"
        ? config.extensions.subagent.providerAlias ?? (config.extensions.subagent.model ? config.models[config.extensions.subagent.model]?.provider : undefined) : undefined },
    permission: structuredClone(config.permission),
    webSearch: describeWebSearchSettings(config.web.search),
    redaction: structuredClone(config.redaction),
    models: {
      configured: listConfiguredModelChoices(config, catalogs),
      connections: describeModelConnections(config),
      catalogs: Object.fromEntries(catalogs.map(([providerAlias, models]) => [
        providerAlias,
        structuredClone(models)
      ])),
      embeddingModels: describeEmbeddingModels(config),
      defaultModel: config.defaultModel,
      toolModel: config.toolModel,
      visionModel: config.visionModel,
      resolvedToolModel: resolveToolModelAlias(config),
      thinking: config.thinking.enabled ? config.thinking.effort : "off",
      modelProfiles: Object.fromEntries(Object.entries(config.providers).map(([providerAlias, provider]) => [
        providerAlias,
        structuredClone(provider.modelProfiles ?? {})
      ]))
    },
    skills: {
      projectId,
      projectKey: createProjectSkillKey(workspaceRoot),
      globalDefaults: { ...config.extensions.skillDefaults },
      projectOverrides: { ...config.extensions.skillProjectOverrides[createProjectSkillKey(workspaceRoot)] },
      activations: []
    }
  };
}

function describeEmbeddingModels(config: AgentConfig): DesktopEmbeddingModelDescriptor[] {
  return [
    ...listLocalEmbeddingModels(),
    ...Object.entries(config.providers).flatMap(([providerAlias, provider]) => (
      listProviderEmbeddingModels(providerAlias, provider, providerDefinition(provider.type))
    ))
  ].map(describeDesktopEmbeddingModel);
}

function describeMemoryEmbeddingStatus(status: MemoryEmbeddingRuntimeStatus): DesktopMemoryEmbeddingStatus {
  return {
    ...status,
    models: status.models.map(describeDesktopEmbeddingModel)
  };
}

function describeDesktopEmbeddingModel(descriptor: EmbeddingModelDescriptor): DesktopEmbeddingModelDescriptor {
  return {
    ...descriptor,
    privacyEndpointHash: descriptor.privacyEndpointHash
  };
}

function describePersonalizationOverview(
  state: AgentPersonalizationState,
  sessionId?: string
): DesktopPersonalizationOverview {
  return {
    configRevision: requireConfigRevision(state),
    memory: { ...state.memory },
    chat: sessionId === undefined ? undefined : {
      sessionId,
      override: state.override,
      effective: {
        useMemories: state.resolved.useMemories,
        contributeMemories: state.resolved.contributeMemories
      },
      metadataRevision: state.catalogRevision
    }
  };
}

function requireConfigRevision(state: AgentPersonalizationState): string {
  if (!state.configRevision) throw new Error("当前配置存储没有返回 versioned CAS revision。");
  return state.configRevision;
}

function describeModelConnections(config: AgentConfig): DesktopModelConnection[] {
  return Object.entries(config.providers).map(([providerAlias, provider]) => {
    const profile = providerDefinition(provider.type);
    const apiKeyEnv = provider.apiKeyEnv ?? profile.apiKeyEnv;
    const credentialSource = describeCredentialSource(provider, apiKeyEnv);
    return {
      providerAlias,
      providerType: provider.type,
      acp: provider.acp,
      enabled: provider.enabled ?? true,
      displayName: provider.displayName,
      icon: provider.icon,
      protocol: provider.protocol,
      apiBackend: provider.apiBackend,
      baseUrl: provider.baseUrl ?? profile.baseUrl,
      requiresApiKey: provider.requiresApiKey ?? profile.requiresApiKey,
      hasCredential: credentialSource !== undefined,
      credentialSource,
      apiKeyEnv,
      authMode: provider.authMode,
      oauthProvider: provider.oauth?.provider,
      oauthExpiresAt: provider.oauth?.expiresAt
    };
  });
}

function describeCredentialSource(provider: ProviderConfig, apiKeyEnv: string | undefined): "keychain" | "config" | "env" | undefined {
  if (provider.apiKey) return process.platform === "darwin" ? "keychain" : "config";
  if (apiKeyEnv && process.env[apiKeyEnv]) return "env";
  return undefined;
}

async function waitForRuntimeIdle(runtime: RuntimeHostClient, timeoutMs: number, sessionId?: string): Promise<void> {
  const idle = runtime.waitForIdle(sessionId);
  await waitForRuntimeOperation(idle, timeoutMs);
}

async function waitForRuntimeOperation<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(finish, timeoutMs);
    void operation.then(finish, () => finish());
  });
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function executeRemoteRuntimeMutation(runtime: RuntimeHostClient, operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<unknown> {
  if (operation === "task.message" || operation === "task.continue") {
    const taskRunId = requiredPayloadString(payload.taskRunId, "taskRunId");
    const sessionId = requiredPayloadString(payload.sessionId, "sessionId");
    const message = requiredPayloadString(payload.message, "message");
    return operation === "task.message" ? await runtime.taskMessage(taskRunId, sessionId, message, optionalPayloadString(payload.messageId))
      : await runtime.taskContinue(taskRunId, sessionId, message, optionalPayloadString(payload.messageId));
  }
  if (operation.startsWith("session.goal.")) {
    const sessionId = requiredPayloadString(payload.sessionId, "sessionId");
    const expected = sessionGoalExpected(payload.expected);
    if (operation === "session.goal.set") return await unwrapHostOperationResult(runtime.sessionGoalSet(sessionId, requiredPayloadString(payload.objective, "objective"), { tokenBudget: sessionGoalTokenBudget(payload.tokenBudget), expected }));
    if (operation === "session.goal.pause") return await unwrapHostOperationResult(runtime.sessionGoalPause(sessionId, expected));
    if (operation === "session.goal.resume") return await unwrapHostOperationResult(runtime.sessionGoalResume(sessionId, expected));
    return await unwrapHostOperationResult(runtime.sessionGoalClear(sessionId, expected));
  }
  if (operation === "plan.start") {
    if (!Number.isSafeInteger(payload.revision)) throw new Error("缺少草稿版本。");
    return await runtime.startPlanDraft(requiredPayloadString(payload.sessionId, "sessionId"), requiredPayloadString(payload.graphId, "graphId"), payload.revision as number);
  }
  if (operation === "worktree.merge") {
    return await runtime.worktreeMerge(requiredPayloadString(payload.sessionId, "sessionId"), {
      strategy: payload.strategy === "squash" ? "squash" : "merge",
      deleteAfter: payload.deleteAfter === true
    });
  }
  if (operation === "worktree.remove") {
    await runtime.worktreeRemove(requiredPayloadString(payload.sessionId, "sessionId"), payload.deleteBranch === true);
    return undefined;
  }
  if (operation === "task.create") return await unwrapHostOperationResult(runtime.taskCreate({ task: payload.task, sessionId: optionalPayloadString(payload.sessionId), parentRunId: optionalPayloadString(payload.parentRunId) }));
  if (operation === "task.start") return await unwrapHostOperationResult(runtime.taskStart(requiredPayloadString(payload.taskRunId, "taskRunId"), { attemptId: optionalPayloadString(payload.attemptId), runId: optionalPayloadString(payload.runId), turnId: optionalPayloadString(payload.turnId), retrySafety: optionalPayloadString(payload.retrySafety) }));
  if (operation === "task.run") return await unwrapHostOperationResult(runtime.taskRun(requiredPayloadString(payload.taskRunId, "taskRunId"), { retrySafety: optionalPayloadString(payload.retrySafety) }));
  if (operation === "task.cancel") return await unwrapHostOperationResult(runtime.taskCancel(requiredPayloadString(payload.taskRunId, "taskRunId"), optionalPayloadString(payload.reason)));
  if (operation === "task.approve") return await unwrapHostOperationResult(runtime.taskApprove(
    requiredPayloadString(payload.taskRunId, "taskRunId"),
    requiredPayloadString(payload.approvalId, "approvalId")
  ));
  if (operation === "task.resume") return await unwrapHostOperationResult(runtime.taskResume(requiredPayloadString(payload.taskRunId, "taskRunId"), { runId: optionalPayloadString(payload.runId), turnId: optionalPayloadString(payload.turnId), retrySafety: optionalPayloadString(payload.retrySafety) }));
  if (operation === "task.retry") return await unwrapHostOperationResult(runtime.taskRetry(requiredPayloadString(payload.taskRunId, "taskRunId")));
  if (operation === "automation.create") return await unwrapHostOperationResult(runtime.automationCreate(payload as unknown as AutomationCreateInput));
  if (operation === "automation.pause") return await unwrapHostOperationResult(runtime.automationPause(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "automation.resume") return await unwrapHostOperationResult(runtime.automationResume(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "automation.run") return await unwrapHostOperationResult(runtime.automationRun(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "automation.delete") return await unwrapHostOperationResult(runtime.automationDelete(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "graph.pause") return await unwrapHostOperationResult(runtime.graphPause(requiredPayloadString(payload.graphId, "graphId")));
  if (operation === "graph.resume") return await unwrapHostOperationResult(runtime.graphResume(requiredPayloadString(payload.graphId, "graphId")));
  if (operation === "graph.cancel") return await unwrapHostOperationResult(runtime.graphCancel(requiredPayloadString(payload.graphId, "graphId")));
  if (operation === "capability.register") return await unwrapHostOperationResult(runtime.capabilityRegister({ registrationId: optionalPayloadString(payload.registrationId), ownerType: payload.ownerType as "host" | "client", capabilityName: requiredPayloadString(payload.capabilityName, "capabilityName"), schema: payload.schema, expiresAt: optionalPayloadString(payload.expiresAt) }));
  if (operation === "capability.replace") return await unwrapHostOperationResult(runtime.capabilityReplace(requiredPayloadString(payload.registrationId, "registrationId"), payload.schema, optionalPayloadString(payload.expiresAt)));
  if (operation === "capability.admit") return await unwrapHostOperationResult(runtime.capabilityAdmit(requiredPayloadString(payload.registrationId, "registrationId")));
  if (operation === "capability.reject") return await unwrapHostOperationResult(runtime.capabilityReject(requiredPayloadString(payload.registrationId, "registrationId"), optionalPayloadString(payload.reason)));
  if (operation === "capability.release") return await unwrapHostOperationResult(runtime.capabilityRelease(requiredPayloadString(payload.registrationId, "registrationId"), optionalPayloadString(payload.reason)));
  if (operation === "capability.invoke") return await unwrapHostOperationResult(runtime.capabilityInvoke(payload as never));
  if (operation === "capability.accept") return await unwrapHostOperationResult(runtime.capabilityAccept(requiredPayloadString(payload.invocationId, "invocationId")));
  if (operation === "capability.start") return await unwrapHostOperationResult(runtime.capabilityStart(requiredPayloadString(payload.invocationId, "invocationId")));
  if (operation === "capability.result") return await unwrapHostOperationResult(runtime.capabilityResult(requiredPayloadString(payload.invocationId, "invocationId"), payload.result));
  if (operation === "capability.chunk") return await unwrapHostOperationResult(runtime.capabilityChunk(requiredPayloadString(payload.invocationId, "invocationId"), Number(payload.chunkIndex), payload.data, payload.final === true));
  if (operation === "capability.fail") return await unwrapHostOperationResult(runtime.capabilityFail(requiredPayloadString(payload.invocationId, "invocationId"), requiredPayloadString(payload.error, "error")));
  return await unwrapHostOperationResult(runtime.capabilityCancel(requiredPayloadString(payload.invocationId, "invocationId"), optionalPayloadString(payload.reason)));
}

function toDesktopWorktreeStatus(status: WorktreeStatusView): DesktopWorktreeStatus {
  return {
    sessionId: status.sessionId,
    status: status.status,
    exists: status.exists,
    dirty: status.dirty,
    mergedIntoBase: status.mergedIntoBase
  };
}

async function unwrapHostOperationResult<T>(operation: Promise<HostOperationResult<T>>): Promise<T | undefined> {
  const result = await operation;
  if (!result.accepted) throw errorFromHostOperation(result);
  return result.result;
}

function requiredPayloadString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Desktop runtime field ${name} must be a non-empty string.`);
  return value;
}

function sessionGoalExpected(value: unknown): SessionGoalExpected | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("会话目标版本无效。");
  const record = value as Record<string, unknown>;
  const goalId = requiredPayloadString(record.goalId, "expected.goalId");
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error("会话目标版本无效。");
  return { goalId, revision: record.revision };
}

function sessionGoalTokenBudget(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("目标 token 预算必须是正整数。");
  return value;
}

function optionalPayloadString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameCredentialScope(left: DesktopSettingsCredentialScope, right: DesktopSettingsCredentialScope): boolean {
  return left.projectId === right.projectId
    && left.purpose === right.purpose
    && left.providerAlias === right.providerAlias;
}

function sameEmbeddingModel(
  left: AgentConfig["context"]["memory"]["embeddingModel"],
  right: AgentConfig["context"]["memory"]["embeddingModel"]
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "local" && right.kind === "local") return left.model === right.model;
  if (left.kind === "provider" && right.kind === "provider") {
    return left.provider === right.provider && left.model === right.model;
  }
  return false;
}

function formatModelConnectionError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "未知错误");
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  if (statusCode !== undefined) {
    if (statusCode === 401 || statusCode === 403) parts.push(`鉴权失败（HTTP ${String(statusCode)}）`);
    else if (statusCode === 404) parts.push(`接口不存在（HTTP 404）`);
    else if (statusCode === 429) parts.push(`请求过于频繁（HTTP 429）`);
    else parts.push(`HTTP ${String(statusCode)}`);
  }
  const message = typeof record.message === "string" ? record.message.trim() : error instanceof Error ? error.message : String(error);
  if (message) parts.push(message);
  const responseBody = typeof record.responseBody === "string" ? record.responseBody.trim() : undefined;
  if (responseBody) {
    const compact = compactJsonError(responseBody);
    if (compact && !parts.some((part) => part.includes(compact))) parts.push(compact);
  }
  const url = typeof record.url === "string" ? record.url : undefined;
  if (url) parts.push(`请求：${url}`);
  const cause = record.cause;
  if (cause instanceof Error && cause.message && !parts.some((part) => part.includes(cause.message))) {
    parts.push(cause.message);
  }
  return parts.filter(Boolean).join(" · ") || "连接失败";
}

/** runtime 忙时的 admission 拒绝（本地快照滞后于 Host 的瞬时竞态），run 根本没开始，不算运行失败。 */
function isBusyAdmissionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("while the runtime is busy");
}

function formatRuntimeInitializationError(error: unknown): DesktopRuntimeError {
  return {
    kind: error instanceof RuntimeHostStartupError && error.reason === "timeout"
      ? "startup_timeout"
      : error instanceof RuntimeHostProtocolMismatchError ? "protocol_mismatch"
      : error instanceof RuntimeHostUnavailableError ? "host_unavailable" : "startup_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true
  };
}

function compactJsonError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const detail = error as Record<string, unknown>;
      if (typeof detail.message === "string") return detail.message;
      if (typeof detail.msg === "string") return detail.msg;
    }
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.msg === "string") return parsed.msg;
  } catch {
    // fall through
  }
  const trimmed = body.replace(/\s+/g, " ").trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed || undefined;
}

async function loadAgentAttachments(persistenceRoot: string, attachments: DesktopAttachment[]): Promise<AgentAttachment[]> {
  const loadedAttachments: AgentAttachment[] = [];
  for (const attachment of attachments) {
    try {
      const loaded = await readAttachment(persistenceRoot, attachment);
      if (!loaded) throw new Error("attachment_file_missing_or_invalid");
      loadedAttachments.push(loaded);
    } catch (cause) {
      throw new Error(`附件文件不可读取：${attachment.name}。请重新添加附件后重试。`, { cause });
    }
  }
  return loadedAttachments;
}

/** 选择只在回合入口读取；连接、凭据和其它共享资源仍要求空闲。 */
function isModelSelectionChange(before: AgentConfig, after: AgentConfig): boolean {
  return configDocumentRevision({ ...after, defaultModel: before.defaultModel, thinking: before.thinking, toolModel: before.toolModel, visionModel: before.visionModel })
    === configDocumentRevision(before);
}
