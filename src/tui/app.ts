/**
 * TUI 应用外壳。
 *
 * 负责把终端渲染循环、TUI runtime、reducer 状态和各展示组件串起来：
 * 组装布局、订阅运行时事件、分发 slash command、处理全局键位。
 * 具体的上下文、会话、工具逻辑仍在 runtime 层，这里不直接执行工具。
 */
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  matchesKey,
  Spacer,
  TUI,
  type OverlayHandle,
  type SelectItem
} from "@earendil-works/pi-tui";
import { formatPermissionModeChanged } from "../permission/commands.js";
import type { PermissionMode } from "../permission/PermissionManager.js";
import { filterPickerModelChoices, parseThinkingSelection, type ModelChoice, type ThinkingSelection } from "../llm/ModelManager.js";
import { globalConfigDir } from "../config/paths.js";
import { slashCommandsForSurface } from "../runtime/commandRegistry.js";
import { withAttachmentReferences } from "../attachments/references.js";
import { forkSession } from "../session/fork.js";
import { executeRuntimeCommand } from "../runtime/commands.js";
import {
  createInteractiveAgentHost,
  type InteractiveRuntimeHandle
} from "../runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../runtime/CommandRuntime.js";
import {
  connectOrSpawnRuntimeHost,
  connectRuntimeHost,
  startRuntimeHost,
  RuntimeHostClient,
  type RuntimeHostFactory,
  type RuntimeHostFactoryOptions,
  type RuntimeHostServer
} from "../runtime/RuntimeHost.js";
import {
  isTerminalRunEvent,
  pendingPermission,
  runtimeIsBusy,
  type AgentHostEvent,
  type InteractiveRuntimeSnapshot
} from "../runtime/agentEvents.js";
import type { SessionSummary } from "../session/events.js";
import type { UsageSummary } from "../session/metadata.js";
import { FooterComponent, ShortcutsBarComponent, StatusIndicatorComponent, WelcomeComponent } from "./components/chrome.js";
import { CardComponent } from "./components/cards.js";
import { PermissionDialog, SelectDialog, TextViewerDialog } from "./components/dialogs.js";
import { PendingAttachmentsComponent } from "./components/pendingAttachments.js";
import { SessionWriterConflictComponent } from "./components/sessionWriterConflict.js";
import { TranscriptView } from "./components/transcriptView.js";
import { appendInputHistory, loadInputHistory } from "./inputHistory.js";
import { permissionModeOptions } from "./permissionModeOptions.js";
import { pasteTuiClipboard } from "./runtime/clipboard.js";
import { permissionChoiceToResult } from "./runtime/permissionChoice.js";
import { readGitBranch } from "./runtime/gitBranch.js";
import { openDesktopSession } from "./runtime/desktopHandoff.js";
import { sessionIdFromFile } from "../session/store.js";
import { readStoredSessionEvents } from "../session/events.js";
import { isSessionWriterConflictError } from "../runtime/SessionLease.js";
import { sessionEventsToTranscript } from "./sessionTranscript.js";
import { modelThinkingOptions, selectedThinkingForModel } from "./modelOptions.js";
import { createInitialTuiState, tuiReducer } from "./reducer.js";
import { editorTheme, theme } from "./theme/index.js";
import { formatSessionAge } from "./transcriptText.js";
import type { PermissionChoice, TuiLaunchMode, TuiState, TuiStatus } from "./types.js";
import type { AgentAttachment } from "../agent/AgentSession.js";
import type { SkillDefinition } from "../extensions/skills.js";
import type { WorktreeStatusView } from "../runtime/host/worktree.js";
import type {
  AgentPersonalizationState,
  ChatPersonalizationOverridePatch
} from "../personalization/index.js";
import {
  formatTuiWorktreeError,
  tuiWorktreeActionDescription,
  tuiWorktreeActionLabel,
  tuiWorktreeView,
  type TuiWorktreeAction
} from "./worktreePresentation.js";

export interface TuiExitSummary {
  sessionId: string;
  sessionFile: string;
}

const TUI_SLASH_COMMANDS = slashCommandsForSurface("tui");
const TUI_AUTOCOMPLETE_COMMANDS = TUI_SLASH_COMMANDS.filter((command) => command.name !== "/skills");
const TUI_SHUTDOWN_DRAIN_MS = 1_500;

interface ModelPresentation {
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  thinking: ThinkingSelection;
}

export const memoryPolicySelectOptions = [
  { value: "inherit", label: "Inherit", description: "Use the global memory defaults for this chat." },
  { value: "both", label: "Use and contribute", description: "Recall relevant memory and contribute successful turns." },
  { value: "use", label: "Use only", description: "Recall relevant memory without automatic contribution." },
  { value: "contribute", label: "Contribute only", description: "Contribute successful turns without recalling memory." },
  { value: "off", label: "All off", description: "Neither recall nor automatically contribute memory." }
] as const;

/** 把已加载 Skill 的元数据投影成 Pi 风格的 `skill:<name>` 补全项。 */
export function skillSlashCommandItems(
  skills: readonly Pick<SkillDefinition, "name" | "description">[]
): Array<{ name: string; description: string }> {
  const seen = new Set<string>();
  return skills
    .filter((skill) => {
      if (seen.has(skill.name)) return false;
      seen.add(skill.name);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({ name: `skill:${skill.name}`, description: skill.description }));
}

export class BinyTui {
  private readonly ui: TUI;
  private readonly workspaceRoot: string;
  private readonly version: string | undefined;
  private readonly initialSession: string | undefined;
  private readonly launchMode: TuiLaunchMode;

  private state: TuiState;
  private runtime: InteractiveRuntimeHandle | undefined;
  private commands: CommandRuntime | undefined;
  private runtimeHost: RuntimeHostServer | undefined;
  private runtimeSnapshot: InteractiveRuntimeSnapshot | undefined;

  private readonly headerContainer = new Container();
  private readonly chatContainer = new TranscriptView();
  private readonly editorContainer = new Container();
  private readonly pendingAttachmentsView = new PendingAttachmentsComponent();
  private sessionWriterConflict: { sessionId: string; ownerSurface?: string } | undefined;
  private readonly ownedSessionIds = new Set<string>();
  private sessionWriterConflictView: SessionWriterConflictComponent | undefined;
  private readonly status: StatusIndicatorComponent;
  private readonly footer: FooterComponent;
  private readonly shortcuts = new ShortcutsBarComponent();
  private readonly editor: Editor;

  /** 最近一张命令卡片的 transcript id，供 ctrl+o 展开/折叠细节。 */
  private lastCardId: string | undefined;
  /** 当前输入尚未发送的图片；实际读写剪贴板和存储都在 TUI runtime。 */
  private pendingAttachments: AgentAttachment[] = [];
  private permissionMode: PermissionMode = "ask";
  private thinking: ThinkingSelection = "off";
  /** 模型切换先更新 TUI 展示，再按顺序等待 Runtime 确认。 */
  private modelSwitchQueue: Promise<void> = Promise.resolve();
  private modelSwitchPromise: Promise<void> | undefined;
  private modelSwitchGeneration = 0;
  private confirmedModel: ModelPresentation | undefined;
  private gitBranch: string | undefined;
  private contextUsage: { usedTokens?: number; maxTokens?: number; source?: "estimated" | "provider" } = {};
  private cacheHitRate: number | undefined;
  private sessionCacheHitRate: number | undefined;
  private overlay: OverlayHandle | undefined;
  private permissionDialog: PermissionDialog | undefined;
  /** 当前权限弹层对应的请求 id；同一请求的重复同步不重置用户已选选项和确认输入。 */
  private permissionDialogRequestId: string | undefined;
  /** 与 pi 一致：空闲时 Ctrl+C 需要在短时间内连续按两次才退出。 */
  private lastCtrlCAt = 0;
  private exiting = false;
  private exitSummary: TuiExitSummary | undefined;
  private unsubscribe: (() => void) | undefined;
  private resolveExit: (() => void) | undefined;

  constructor(ui: TUI, workspaceRoot: string, version?: string, initialSession?: string, launchMode: TuiLaunchMode = "new") {
    this.ui = ui;
    this.workspaceRoot = workspaceRoot;
    this.version = version;
    this.initialSession = initialSession;
    this.launchMode = launchMode;
    this.state = createInitialTuiState(workspaceRoot);
    this.status = new StatusIndicatorComponent(ui);
    this.footer = new FooterComponent(this.footerData());
    this.editor = new Editor(ui, editorTheme(), { paddingX: 1 });
    this.editorContainer.addChild(this.pendingAttachmentsView);
    this.editorContainer.addChild(this.editor);
  }

  /** 启动界面并等待退出。 */
  async run(): Promise<TuiExitSummary | undefined> {
    this.ui.addChild(this.headerContainer);
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(this.status);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.footer);
    this.ui.addChild(this.shortcuts);

    this.headerContainer.addChild(new Spacer(1));
    this.headerContainer.addChild(new WelcomeComponent(this.workspaceRoot, this.version));

    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
    this.ui.setFocus(this.editor);
    this.ui.addInputListener((data) => {
      if (shouldConfirmAutocompleteOnEnter(data, this.editor.isShowingAutocomplete(), this.editor.getText())) {
        // pi-tui 的 Editor 对 slash 补全会在 Enter 确认后继续 fall through 到 submit。
        // 在 TUI 边界把这次 Enter 转成 Tab，只完成插入，下一次 Enter 才是用户发送。
        this.editor.handleInput("\t");
        // 全局监听器消费了原始 Enter，TUI 不会再自动请求重绘；补全后的文本要立即可见。
        this.ui.requestRender();
        return { consume: true };
      }
      // 自动补全弹出且输入仅为 "/" 时，按 Enter 应弹出命令选择器（SelectDialog），
      // 而不是让 Editor 自动补全选中第一个命令并执行。
      if (this.editor.isShowingAutocomplete() && matchesKey(data, "enter") && this.editor.getText().trim() === "/") {
        this.dismissAutocomplete();
        this.ui.requestRender();
        return undefined;
      }
      if (this.editor.isShowingAutocomplete() && matchesKey(data, "escape")) {
        // 忙碌时 Escape 默认会取消 Agent；补全弹层打开时应先关闭弹层，不能误取消当前任务。
        this.dismissAutocomplete();
        return { consume: true };
      }
      return this.handleGlobalKey(data);
    });
    this.ui.start();

    await this.startRuntime();
    // Ctrl+C 可能在 runtime 初始化期间到达；此时 exit 没有等待者可唤醒，
    // 初始化完成后必须直接结束，不能再把 TUI 留在半关闭状态。
    if (this.exiting) return this.exitSummary;
    this.refreshChrome();

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    return this.exitSummary;
  }

  private async startRuntime(): Promise<void> {
    try {
      let attached: RuntimeHostClient | undefined;
      try {
        attached = await connectOrSpawnRuntimeHost(this.workspaceRoot, {
          workspaceRoot: this.workspaceRoot,
          configDir: globalConfigDir(),
          sessionId: this.initialSession,
          resumeInterrupted: false,
          clientId: `tui-${process.pid}`,
          surface: "tui"
        });
      } catch {
        // 无配置或独立 Host 启动失败时，保留当前进程内的最小 fallback。
      }
      let runtime: InteractiveRuntimeHandle;
      let commands: CommandRuntime | undefined;
      if (attached) {
        runtime = attached;
      } else {
        const createLocalRuntime: RuntimeHostFactory = async (sessionId?: string, factoryOptions?: RuntimeHostFactoryOptions) => {
          const fresh = factoryOptions?.fresh === true;
          const local = await createInteractiveAgentHost(factoryOptions?.workspaceRoot ?? this.workspaceRoot, {
            persistenceRoot: this.workspaceRoot,
            sessionId: fresh ? sessionId : undefined,
            resourceRegistry: factoryOptions?.resourceRegistry,
            resourceBoot: factoryOptions?.resourceBoot ?? (factoryOptions?.resourceRegistry === undefined ? "blocking" : "background")
          });
          if (sessionId !== undefined && !fresh) await local.runtime.resumeSession(sessionId);
          return local;
        };
        // 显式 session 在 Host/界面完成 attach 后再恢复；这样 writer conflict 可以
        // 转成只读历史，而不会在本地 fallback 创建阶段直接终止 TUI。
        try {
          this.runtimeHost = await startRuntimeHost(this.workspaceRoot, (resourceRegistry) => createLocalRuntime(undefined, {
            resourceRegistry,
            resourceBoot: "background"
          }), {
            createRuntime: createLocalRuntime,
            resumeInterrupted: false,
            configDir: globalConfigDir()
          });
          runtime = this.runtimeHost.getCurrentRuntime();
          commands = this.runtimeHost.getCurrentCommands();
          // TUI owner 也通过 socket client 使用同一条 Host 路径，这样 owner 自己和
          // attach 进来的 Desktop/CLI 看到的 session 注册表与事件扇出完全一致。
          const ownerClient = await connectRuntimeHost(this.workspaceRoot, {
            clientId: `tui-${process.pid}`,
            surface: "tui"
          }).catch(() => undefined);
          if (ownerClient) {
            runtime = ownerClient;
            commands = undefined;
          }
        } catch (error) {
          await this.runtimeHost?.close();
          const retry = await connectOrSpawnRuntimeHost(this.workspaceRoot, {
            workspaceRoot: this.workspaceRoot,
            configDir: globalConfigDir(),
            sessionId: this.initialSession,
            resumeInterrupted: false,
            clientId: `tui-${process.pid}`,
            surface: "tui"
          });
          if (!retry) throw error;
          runtime = retry;
          commands = undefined;
        }
      }
      this.runtime = runtime;
      this.commands = commands;
      // 补全器要的是不带斜杠的命令名，它自己会补上 `/`；带斜杠会补出 `//resume`。
      // 提前设置 autocomplete：即使模型未配置或 skills 加载失败，slash 命令补全也必须可用。
      try {
        const skills = commands
          ? commands.listSkills()
          : await requireRemoteRuntime(runtime).listSkills().catch(() => [] as SkillDefinition[]);
        this.setAutocompleteProvider(skills, this.workspaceRoot);
      } catch {
        this.setAutocompleteProvider([], this.workspaceRoot);
      }

      // 普通入口在 Host 上新建独立 Session；已有运行不影响新窗口，也不会被替换。
      if ((this.launchMode === "new" || this.launchMode === "resume-picker")
        && this.initialSession === undefined
        && (runtime instanceof RuntimeHostClient || !runtimeIsBusy(runtime.getSnapshot()))) {
        await this.restartRuntimeForNewChat();
        runtime = this.runtime;
        commands = this.commands;
      }
      this.runtimeSnapshot = runtime.getSnapshot();
      const { info, permissionMode } = this.runtimeSnapshot;
      this.permissionMode = permissionMode;
      this.thinking = info.thinking;
      this.confirmedModel = modelPresentationFromInfo(info);
      this.editor.borderColor = theme.thinkingBorder(this.thinking);

      void readGitBranch(info.workspaceRoot).then((branch) => {
        this.gitBranch = branch;
        this.refreshChrome();
      });
      void loadInputHistory(info.workspaceRoot)
        .then((history) => {
          for (const entry of history.slice(-100)) this.editor.addToHistory(entry);
        })
        .catch((error) => this.notify(`读取输入历史失败：${describeError(error)}`));

      this.subscribeRuntime(runtime);
      this.dispatch({
        type: "session.started",
        sessionId: info.sessionId,
        sessionFile: info.sessionFile,
        cwd: info.workspaceRoot,
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel
      });
      // 显式 session 加载自己的 transcript，Host 中其他 Session 的运行保持不变。
      if (this.initialSession) await this.resumeSession(this.initialSession);
      if (this.launchMode === "resume-picker" && this.initialSession === undefined) await this.showSessionPicker();
      void this.refreshContextUsage();
      void this.refreshUsage();
    } catch (error) {
      // Runtime 启动失败（例如模型 provider 缺 API Key）时，slash 补全和命令选择器
      // 仍应可用，否则用户连命令列表和 /exit 都打不开。skills 拿不到就退化为纯命令集。
      this.setAutocompleteProvider([], this.workspaceRoot);
      this.notify(`TUI startup failed: ${describeError(error)}`);
    }
  }

  private subscribeRuntime(runtime: InteractiveRuntimeHandle): void {
    this.unsubscribe?.();
    this.unsubscribe = runtime.subscribe((update) => {
      this.runtimeSnapshot = update.snapshot;
      if (update.event) this.dispatch(update.event);
      else if (update.snapshot.state.kind === "maintenance") this.dispatch({ type: "maintenance.started" });
      else this.refreshChrome();
      if (isTerminalRunEvent(update.event)) {
        void this.refreshContextUsage();
        void this.refreshUsage();
      }
    });
  }

  /** 创建一个新聊天；只有显式 `/new` 或普通入口才会调用，绝不等同于续跑。 */
  private async restartRuntimeForNewChat(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("TUI runtime is not ready.");
    if (!(runtime instanceof RuntimeHostClient) && runtimeIsBusy(runtime.getSnapshot())) {
      throw new Error("当前任务仍在运行，请先取消后再创建新聊天。");
    }

    if (runtime instanceof RuntimeHostClient) {
      // Host 多 session 下，新聊天是新 registry entry；restart 只用于刷新同一
      // session 的 runtime 资源，不能用它把旧会话从注册表里替换掉。
      await runtime.startDraft();
      this.runtimeSnapshot = runtime.getSnapshot();
      return;
    }

    const host = this.runtimeHost;
    if (!host) throw new Error("新聊天需要可重建的 Runtime Host。");
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await host.startDraftRuntime();
    this.runtime = host.getCurrentRuntime();
    this.commands = host.getCurrentCommands();
    this.runtimeSnapshot = this.runtime.getSnapshot();
    this.subscribeRuntime(this.runtime);
  }

  private announceCurrentSession(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const info = runtime.getSnapshot().info;
    this.confirmedModel = modelPresentationFromInfo(info);
    this.dispatch({
      type: "session.started",
      sessionId: info.sessionId,
      sessionFile: info.sessionFile,
      cwd: info.workspaceRoot,
      provider: info.provider,
      modelLabel: info.modelLabel,
      reasoningLabel: info.reasoningLabel
    });
  }

  private async startNewChat(): Promise<void> {
    try {
      await this.restartRuntimeForNewChat();
      this.clearSessionWriterConflict();
      this.chatContainer.reset();
      this.dispatch({ type: "transcript.replaced", items: [], viewingSessionId: this.runtimeSnapshot?.info.sessionId });
      this.announceCurrentSession();
      this.setEditorText("");
      await this.refreshContextUsage();
      await this.refreshUsage();
      this.notify("New chat started.");
    } catch (error) {
      this.showTextViewer("New chat", describeError(error));
    }
  }

  private async openCurrentSessionInDesktop(): Promise<void> {
    const info = this.runtime?.getSnapshot().info;
    if (!info) return;
    try {
      await openDesktopSession(info.workspaceRoot, info.sessionId);
      this.notify("已将当前会话交给 Biny Desktop。");
    } catch (error) {
      this.showTextViewer("Desktop", describeError(error));
    }
  }

  private setAutocompleteProvider(skills: readonly SkillDefinition[], workspaceRoot: string): void {
    const provider = new CombinedAutocompleteProvider(
      [
        ...TUI_AUTOCOMPLETE_COMMANDS.map((command) => ({
          name: command.name.replace(/^\//, ""),
          description: command.description
        })),
        ...skillSlashCommandItems(skills)
      ],
      workspaceRoot
    );
    this.editor.setAutocompleteProvider(provider);
  }

  private dispatch(event: Parameters<typeof tuiReducer>[1]): void {
    // 技能提取（自进化）是回合后旁路：进度不进 reducer 状态，完成时通知一条即可。
    if (event.type === "skill_extraction.updated" && event.stage === "done" && event.skillName) {
      this.notify(`${event.updated ? "已更新技能" : "已提取新技能"} ${event.skillName}，下一回合可用。`);
    }
    const nextState = tuiReducer(this.state, event);
    // 长思考会产生大量 reasoning.delta；这些增量只用于 provider/session，TUI
    // 不展示原文。忽略没有改变界面的增量，避免每个 token 都同步组件树并请求重绘。
    if (nextState === this.state && event.type === "reasoning.delta") return;
    this.state = nextState;
    this.syncPermissionDialog();
    this.chatContainer.sync(this.state.transcript);
    this.refreshChrome();
  }

  private notify(content: string): void {
    this.dispatch({ type: "system.message", content });
  }

  private refreshChrome(): void {
    const status = runtimeStatus(this.runtimeSnapshot);
    this.status.setState(status, this.state.turnStartedAt, this.state.lastWorkedMs);
    this.shortcuts.setState(status);
    this.footer.setData(this.footerData());
    this.ui.requestRender();
  }

  private footerData(): Parameters<FooterComponent["setData"]>[0] {
    return {
      cwd: this.state.cwd,
      sessionId: this.state.sessionId,
      viewingSessionId: this.state.viewingSessionId,
      gitBranch: this.gitBranch,
      modelLabel: this.state.modelLabel,
      thinkingLabel: this.state.reasoningLabel,
      permissionMode: this.permissionMode,
      contextUsedTokens: this.contextUsage.usedTokens,
      contextMaxTokens: this.contextUsage.maxTokens,
      contextSource: this.contextUsage.source,
      cacheHitRate: this.cacheHitRate,
      sessionCacheHitRate: this.sessionCacheHitRate
    };
  }

  private async refreshContextUsage(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const sessionId = runtime.getSnapshot().info.sessionId;
    try {
      const context = this.commands
        ? await this.commands.agent.contextStatus()
        : await requireRemoteRuntime(runtime).contextStatus();
      if (runtime.getSnapshot().info.sessionId !== sessionId) return;
      // 百分比按模型自身的上下文窗口算；没有窗口信息时才退回输入预算。
      this.contextUsage = {
        usedTokens: context.budget.usedTokens,
        maxTokens: context.budget.contextWindow ?? context.budget.maxTokens,
        source: context.budget.source
      };
      this.refreshChrome();
    } catch {
      // Footer telemetry is best effort and must never interrupt the TUI.
    }
  }

  private async refreshUsage(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const sessionId = runtime.getSnapshot().info.sessionId;
    try {
      const summary: UsageSummary = this.commands
        ? await this.commands.agent.usageSummary()
        : (await requireRemoteRuntime(runtime).usage()).summary;
      if (runtime.getSnapshot().info.sessionId !== sessionId) return;
      this.cacheHitRate = summary.latestCacheHitRate;
      this.sessionCacheHitRate = summary.sessionCacheHitRate;
      this.refreshChrome();
    } catch {
      // Footer telemetry is best effort and must never interrupt the TUI.
    }
  }

  // ---------------------------------------------------------------- 输入分发

  private async submit(text: string): Promise<void> {
    const value = text.trim();
    if (!value && !this.pendingAttachments.length) return;
    const runtime = this.runtime;
    const commands = this.commands;
    // TUI 在 runtime 启动完成前（或启动失败时）已经可以接收键盘输入；
    // slash 命令里有一部分（命令选择器、/clear、/exit）不依赖 runtime，照常路由过去，
    // 避免「runtime 没起来 → 连 /exit 都打不出来」。普通消息仍保留在编辑器里等 runtime。
    if (!runtime) {
      if (value.startsWith("/")) {
        try {
          await this.handleSlashCommand(value);
        } catch (error) {
          this.showTextViewer("Command Error", describeError(error));
        }
        return;
      }
      this.setEditorText(text);
      this.notify("Runtime 尚未就绪，无法发送消息。请检查模型配置（API Key）后重启 TUI。");
      this.ui.requestRender();
      return;
    }
    const sessionId = runtime.getSnapshot().info.sessionId;
    const pendingModelSwitch = this.modelSwitchPromise;
    if (pendingModelSwitch) {
      // 底部模型名已经立即变化，但消息必须等真实 Runtime 切换完成后再提交，
      // 避免用户紧接着按 Enter 时仍由旧模型处理。
      try {
        await pendingModelSwitch;
      } catch {
        // applyModel 已经展示具体失败原因；Editor 提交时已清空输入，这里恢复，避免误发到旧模型。
        this.setEditorText(text);
        return;
      }
    }
    const prompt = value || "请分析这个附件。";
    const attachments = this.pendingAttachments;
    this.setPendingAttachments([]);
    this.setEditorText("");
    this.editor.addToHistory(prompt);
    void appendInputHistory(this.workspaceRoot, prompt)
      .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));

    // /skill:name、/skills:name 是技能调用而非 slash 命令，保留原文走普通提交；
    // 正文由模型按 <available_skills> 指引调用 Skill 工具按需加载（渐进式披露）。
    if (value.startsWith("/") && !isSkillInvocationText(value)) {
      // slash 命令不消费附件；保留它们给用户执行命令后继续编辑并发送。
      this.setPendingAttachments(attachments);
      try {
        await this.handleSlashCommand(value);
      } catch (error) {
        this.showTextViewer("Command Error", describeError(error));
      }
      return;
    }

    try {
      await this.ensureSessionWriteAccess(sessionId);
      if (runtimeIsBusy(runtime instanceof RuntimeHostClient ? runtime.getSnapshot(sessionId) : runtime.getSnapshot())) {
        if (runtime instanceof RuntimeHostClient) {
          const queued = await runtime.queueRunMessageForSession(sessionId, withAttachmentReferences(prompt, attachments), "queue", attachments);
          if (!queued.accepted) throw new Error(queued.reason);
        } else await runtime.enqueue(withAttachmentReferences(prompt, attachments), attachments);
        this.notify("消息已加入待发送队列，将在当前任务结束后继续处理。");
        return;
      }
      await (runtime instanceof RuntimeHostClient
        ? runtime.submitPromptForSession(sessionId, withAttachmentReferences(prompt, attachments), attachments)
        : runtime.submitPrompt(withAttachmentReferences(prompt, attachments), attachments)).completion;
    } catch (error) {
      if (isSessionWriterConflictError(error)) {
        await this.showSessionWriterConflict(error.sessionId, error.ownerSurface);
        return;
      }
      this.setPendingAttachments([...attachments, ...this.pendingAttachments]);
      this.setEditorText(prompt);
      this.dispatch({ type: "error.message", message: describeError(error) });
    } finally {
      await this.refreshContextUsage();
    }
  }

  /** 全局键位。返回 `{consume:true}` 表示不再投递给焦点组件。 */
  private handleGlobalKey(data: string): { consume?: boolean } | undefined {
    const busy = runtimeIsBusy(this.runtimeSnapshot);

    // 连续两次 Ctrl+C 始终退出（弹层打开时也一样，和 Codex 体感一致）；
    // 单次 Ctrl+C 在弹层打开时交给弹层自己处理（选择器取消、查看器关闭），
    // 避免「想退出却发现被弹层卡住」。
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (ctrlCAction(this.lastCtrlCAt, now) === "exit") {
        this.lastCtrlCAt = 0;
        void this.exit();
      } else {
        this.lastCtrlCAt = now;
        if (this.overlay) return undefined;
        if (busy) {
          this.dismissAutocomplete();
          this.runtime?.cancelCurrentRun();
        } else {
          this.setEditorText("");
          this.setPendingAttachments([]);
        }
      }
      return { consume: true };
    }
    if (this.sessionWriterConflict) {
      if (matchesKey(data, "enter") || data.toLowerCase() === "r") {
        this.sessionWriterConflictView?.handleInput(data);
      }
      // 冲突状态只允许 Retry 和退出，普通输入不能落入 Editor。
      return { consume: true };
    }
    // steer 消费的是编辑器内容，必须排在冲突遮罩之后，避免冲突期间改写已隐藏的编辑器。
    if (matchesKey(data, "ctrl+s") && busy && !this.overlay) {
      this.dismissAutocomplete();
      void this.steerCurrentInput();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.overlay) return undefined;
      if (busy) {
        this.runtime?.cancelCurrentRun();
        return { consume: true };
      }
      return undefined;
    }
    if (this.overlay) return undefined;
    // ctrl+o 展开/折叠最近一张命令卡片的细节；权限弹层内由 PermissionDialog 自己处理。
    if (matchesKey(data, "ctrl+o") && this.lastCardId) {
      const component = this.chatContainer.componentFor(this.lastCardId);
      if (component instanceof CardComponent) {
        this.dismissAutocomplete();
        component.toggleDetails();
        this.ui.requestRender();
        return { consume: true };
      }
    }
    // Windows 终端通常把 Ctrl+V 留给文本粘贴，只用 Alt+V 读取图片剪贴板。
    const isClipboardPaste = process.platform === "win32" ? matchesKey(data, "alt+v") : matchesKey(data, "ctrl+v");
    if (isClipboardPaste) {
      this.dismissAutocomplete();
      void this.pasteClipboard();
      return { consume: true };
    }
    return undefined;
  }

  private async steerCurrentInput(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const sessionId = runtime.getSnapshot().info.sessionId;
    const value = this.editor.getText().trim();
    if (!value && !this.pendingAttachments.length) return;
    const prompt = value || "请分析这个附件。";
    const attachments = this.pendingAttachments;
    try {
      await this.ensureSessionWriteAccess(sessionId);
      if (runtime instanceof RuntimeHostClient) {
        const queued = await runtime.queueRunMessageForSession(sessionId, withAttachmentReferences(prompt, attachments), "steer", attachments);
        if (!queued.accepted) throw new Error(queued.reason);
      } else await runtime.steer(withAttachmentReferences(prompt, attachments), attachments);
      this.setPendingAttachments([]);
      this.setEditorText("");
      this.editor.addToHistory(prompt);
      void appendInputHistory(this.workspaceRoot, prompt)
        .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));
      this.notify("消息已加入 steer 队列，将在当前模型步骤和工具批次结束后处理。");
    } catch (error) {
      if (isSessionWriterConflictError(error)) {
        await this.showSessionWriterConflict(error.sessionId, error.ownerSurface);
        return;
      }
      this.dispatch({ type: "error.message", message: describeError(error) });
    }
  }

  /** Remote Host 的写入口先取得当前 session 的长期 claim，避免 TUI 只靠瞬时执行 lease。 */
  private async ensureSessionWriteAccess(sessionId: string): Promise<void> {
    const runtime = this.runtime;
    if (!(runtime instanceof RuntimeHostClient)) return;
    await runtime.ensureSession({ sessionId, writeIntent: true, focus: false });
    this.ownedSessionIds.add(sessionId);
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const pasted = await pasteTuiClipboard(this.workspaceRoot);
      if (pasted.kind === "image") {
        this.setPendingAttachments([...this.pendingAttachments, pasted.attachment]);
        this.notify(`已附加 [Image #${String(this.pendingAttachments.length)}]。按 Enter 发送；当前模型需声明 vision 能力。`);
        return;
      }
      if (pasted.kind === "text") {
        this.editor.insertTextAtCursor(pasted.text);
        this.ui.requestRender();
        return;
      }
      this.notify("剪贴板中没有可读取的图片或文本。");
    } catch (error) {
      this.notify(`读取剪贴板失败：${describeError(error)}`);
    }
  }

  private setPendingAttachments(attachments: AgentAttachment[]): void {
    this.pendingAttachments = attachments;
    this.pendingAttachmentsView.setAttachments(attachments);
    this.ui.requestRender();
  }

  private setEditorText(text: string): void {
    this.editor.setText(text);
  }

  private dismissAutocomplete(): void {
    if (!this.editor.isShowingAutocomplete()) return;
    this.editor.handleInput("\x1b");
    this.ui.requestRender();
  }

  // ---------------------------------------------------------------- 弹层

  private showOverlay(component: Container, options?: {
    maxHeight?: `${number}%`;
    placement?: "below_editor";
  }): void {
    this.dismissAutocomplete();
    this.closeOverlay();
    const maxHeight = options?.maxHeight ?? "70%";
    const row = options?.placement === "below_editor"
      ? selectDialogRow(
        this.ui.render(this.ui.terminal.columns).length,
        Math.min(
          component.render(this.ui.terminal.columns).length,
          Math.max(1, Math.floor(this.ui.terminal.rows * Number.parseFloat(maxHeight) / 100))
        ),
        this.ui.terminal.rows,
        this.footer.render(this.ui.terminal.columns).length + this.shortcuts.render(this.ui.terminal.columns).length
      )
      : undefined;
    this.overlay = this.ui.showOverlay(component, {
      width: "100%",
      anchor: row === undefined ? "bottom-center" : undefined,
      row,
      maxHeight
    });
    this.overlay.focus();
  }

  private closeOverlay(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.permissionDialog = undefined;
    this.permissionDialogRequestId = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private showTextViewer(title: string, content: string): void {
    const rows = Math.max(4, Math.floor(this.ui.terminal.rows * 0.6));
    const viewer = new TextViewerDialog(title, content, rows, () => this.closeOverlay());
    this.showOverlay(viewer);
  }

  private showSelect(options: {
    title: string;
    items: SelectItem[];
    selectedIndex?: number;
    hint?: string;
    onSelect: (item: SelectItem) => void;
  }): void {
    const dialog = new SelectDialog({
      title: options.title,
      items: options.items,
      selectedIndex: options.selectedIndex,
      hint: options.hint,
      maxVisible: Math.max(4, Math.floor(this.ui.terminal.rows * 0.4)),
      onSelect: (item) => {
        this.closeOverlay();
        options.onSelect(item);
      },
      onCancel: () => this.closeOverlay()
    });
    this.showOverlay(dialog, { placement: "below_editor" });
  }

  /** 权限请求进出时同步弹层，避免请求切换后还留着上一份确认状态。 */
  private syncPermissionDialog(): void {
    const pending = pendingPermission(this.runtimeSnapshot);
    if (!pending) {
      if (this.permissionDialog) this.closeOverlay();
      return;
    }
    if (this.permissionDialog) {
      // 并行工具的进度事件会反复触发同步；同一请求只刷新展开状态，
      // 换成新请求时才允许 setRequest 重置已选选项和已输入的确认词。
      if (pending.requestId !== this.permissionDialogRequestId) {
        this.permissionDialog.setRequest({ ...pending.request });
        this.permissionDialogRequestId = pending.requestId;
      }
      this.permissionDialog.setDetailsExpanded(this.state.permissionDetailsExpanded);
      return;
    }
    const dialog = new PermissionDialog(
      { ...pending.request },
      (choice, denialReason) => {
        this.closeOverlay();
        this.answerPermission(choice, denialReason);
      },
      () => {
        this.dispatch({ type: "permission.details.toggled" });
      },
      Math.max(10, this.ui.terminal.rows - 4)
    );
    dialog.setDetailsExpanded(this.state.permissionDetailsExpanded);
    this.showOverlay(dialog, { maxHeight: "100%" });
    // showOverlay 内部会先 closeOverlay 清空弹层引用，归属登记必须放在之后。
    this.permissionDialog = dialog;
    this.permissionDialogRequestId = pending.requestId;
  }

  private answerPermission(choice: PermissionChoice, denialReason?: string): void {
    const runtime = this.runtime;
    const request = pendingPermission(this.runtimeSnapshot);
    if (!runtime || !request) return;
    runtime.answerPermission(
      request.requestId,
      permissionChoiceToResult(choice, request.request, denialReason)
    );
  }

  // ---------------------------------------------------------------- slash

  private async handleSlashCommand(value: string): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    // 容忍多打的斜杠：`//resume` 只可能是想写 `/resume`。
    const [command = "", ...args] = value.trim().replace(/^\/+/, "/").split(/\s+/);

    // 命令选择器、/exit、/clear 不依赖 runtime；runtime 启动失败（例如缺模型 API Key）
    // 时也必须可用，否则用户在坏配置下连退出和命令列表都打不开。
    if (command === "/") {
      this.showSelect({
        title: "Commands",
        items: TUI_SLASH_COMMANDS.map((entry) => ({
          value: entry.name,
          label: entry.name,
          description: entry.description
        })),
        hint: "↑↓ navigate · enter insert · esc/ctrl+c cancel",
        onSelect: (item) => {
          this.setEditorText(`${item.value} `);
          this.ui.requestRender();
        }
      });
      return;
    }

    if (command === "/exit") {
      await this.exit();
      return;
    }

    if (command === "/clear") {
      this.dispatch({ type: "transcript.replaced", items: [] });
      this.chatContainer.reset();
      this.ui.requestRender();
      return;
    }

    if (!runtime) {
      this.notify(`Runtime 尚未就绪，${command} 暂不可用。请检查模型配置（API Key）后重启 TUI。`);
      return;
    }

    if (command === "/new") {
      await this.startNewChat();
      return;
    }

    if (command === "/app") {
      await this.openCurrentSessionInDesktop();
      return;
    }

    if (command === "/model") {
      await this.handleModelCommand(args);
      return;
    }

    if (command === "/memories") {
      await this.handleMemoriesCommand(args);
      return;
    }

    if (command === "/sessions") {
      await this.showRuntimeSessionPicker();
      return;
    }

    if (command === "/worktree") {
      await this.handleWorktreeCommand(args);
      return;
    }

    if (command === "/resume" && !(runtime instanceof RuntimeHostClient) && runtimeIsBusy(this.runtimeSnapshot)) {
      this.notify("当前任务仍在运行，请先取消后再恢复会话。");
      return;
    }

    if (command === "/resume" && !args[0]) {
      await this.showSessionPicker();
      return;
    }

    if (command === "/resume") {
      await this.resumeSession(args[0] ?? "");
      return;
    }

    if (command === "/fork") {
      const upTo = args[1] === undefined ? undefined : Number.parseInt(args[1], 10);
      if (args[1] !== undefined && !Number.isSafeInteger(upTo)) {
        this.showTextViewer("Fork", "Usage: /fork [session] [upToEvent]");
        return;
      }
      const forked = await forkSession(
        commands?.persistenceRoot ?? this.workspaceRoot,
        args[0],
        upTo === undefined ? {} : { upToEvent: upTo }
      );
      this.showTextViewer("Fork", `Forked ${forked.sourceSessionId} at ${String(forked.events)} event(s) into ${forked.sessionId}\n${forked.filePath}`);
      return;
    }

    if (command === "/permissions") {
      if (runtimeIsBusy(this.runtimeSnapshot)) {
        this.notify("当前任务仍在运行，请先取消后再修改权限设置。");
        return;
      }
      if (args.length === 0) {
        this.showPermissionModePicker();
        return;
      }
      const result = commands
        ? await runtime.runExclusiveOperation(
          "permission",
          async () => await commands.agent.runPermissionCommand(args)
        )
        : await requireRemoteRuntime(runtime).runPermissionCommand(args);
      this.showTextViewer("Permissions", result);
      this.permissionMode = runtime.getSnapshot().permissionMode;
      this.refreshChrome();
      return;
    }

    if (command === "/automation" && args[0]?.toLowerCase() === "run") {
      const automationId = args[1]?.trim();
      if (!automationId) {
        this.notify("Usage: /automation run <automation-id>");
        return;
      }
      const fire = runtime instanceof RuntimeHostClient
        ? await runtime.automationRun(automationId)
        : await this.runtimeHost?.runAutomation(automationId);
      this.showTextViewer("Automation", JSON.stringify(fire, null, 2));
      return;
    }

    const sharedResult = commands
      ? await executeRuntimeCommand(runtime, commands, value, "tui")
      : await requireRemoteRuntime(runtime).executeCommand(value, "tui");
    if (sharedResult) {
      if (sharedResult.card) {
        // 卡片 id 由 reducer 按同一公式生成；这里先算出来，供 ctrl+o 定位组件。
        const cardId = `card-${String(this.state.transcript.committed.length + this.state.transcript.active.length + 1)}`;
        this.lastCardId = cardId;
        this.dispatch({
          type: "command.card",
          command: sharedResult.command,
          title: sharedResult.title,
          data: sharedResult.card
        });
      } else {
        this.showTextViewer(sharedResult.title, sharedResult.content);
      }
      if (command === "/compact") await this.refreshContextUsage();
      return;
    }

    // 未知命令是小错误，用一条通知就够，不必占一整个弹层。
    this.notify(`Unknown command: ${command}. Type / to see the list.`);
  }

  private async handleModelCommand(args: string[]): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    if (args[0]) {
      this.applyModel(args[0], parseThinkingSelection(args[1]));
      return;
    }
    if (commands) {
      await runtime.runExclusiveOperation(
        "refresh_model",
        async () => await commands.agent.refreshModelFromDisk()
      );
    } else {
      await requireRemoteRuntime(runtime).refreshModel();
    }
    // /model 只读取配置和已恢复的目录缓存，不能因为远程目录请求阻塞模型选择。
    const info = runtime.getSnapshot().info;
    const models = commands
      ? commands.agent.listModels()
      : await requireRemoteRuntime(runtime).listModels();
    const pickerModels = filterPickerModelChoices(models);
    // 选择器只展示配置列表里勾选启用且可用的模型；一个都没有时给出明确提示，
    // 而不是弹一个空列表（对应 Codex 在目录不可用时显示提示而非空 picker 的做法）。
    if (pickerModels.length === 0) {
      this.showTextViewer("Select model", "当前没有可用模型。请在桌面端设置 > 模型供应商中配置并启用模型，或检查连接的密钥/登录状态后重试。");
      return;
    }
    this.showSelect({
      title: "Select model",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, pickerModels.findIndex((model) => model.alias === info.modelAlias)),
      items: pickerModels.map((model) => ({
        value: model.alias,
        label: model.alias === info.modelAlias ? `${model.alias} ← current` : model.alias,
        description: `${model.provider}  ${model.description ?? model.model}`
      })),
      onSelect: (item) => {
        // 远程 listModels 等在 Host 断连时会抛错，就地提示而不是 unhandled rejection。
        void this.selectModel(item.value)
          .catch((error: unknown) => this.notify(`切换模型失败：${describeError(error)}`));
      }
    });
  }

  private async handleMemoriesCommand(args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase();
    if (action !== undefined) {
      if (!memoryPolicySelectOptions.some((option) => option.value === action)) {
        this.showTextViewer("Memories", "Usage: /memories [inherit|both|use|contribute|off]");
        return;
      }
      await this.applyChatMemoryPolicy(action as typeof memoryPolicySelectOptions[number]["value"]);
      return;
    }
    const state = await this.readPersonalizationState();
    const selected = memoryPolicyOptionForOverride(state);
    this.showSelect({
      title: "Chat memory policy",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, memoryPolicySelectOptions.findIndex((option) => option.value === selected)),
      items: memoryPolicySelectOptions.map((option) => ({
        ...option,
        label: option.value === selected ? `${option.label} ← current` : option.label
      })),
      onSelect: (item) => {
        void this.applyChatMemoryPolicy(item.value as typeof memoryPolicySelectOptions[number]["value"]);
      }
    });
  }

  private async applyChatMemoryPolicy(
    policy: typeof memoryPolicySelectOptions[number]["value"]
  ): Promise<void> {
    const patch: ChatPersonalizationOverridePatch = policy === "inherit"
      ? { useMemories: "inherit", contributeMemories: "inherit" }
      : policy === "both"
        ? { useMemories: true, contributeMemories: true }
        : policy === "use"
          ? { useMemories: true, contributeMemories: false }
          : policy === "contribute"
            ? { useMemories: false, contributeMemories: true }
            : { useMemories: false, contributeMemories: false };
    await this.applyChatPersonalization(patch);
  }

  private async readPersonalizationState(): Promise<AgentPersonalizationState> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("TUI runtime is not ready.");
    return this.commands
      ? await this.commands.agent.getPersonalizationState()
      : await requireRemoteRuntime(runtime).getPersonalizationState();
  }

  private async applyChatPersonalization(patch: ChatPersonalizationOverridePatch): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const sessionId = runtime.getSnapshot().info.sessionId;
    try {
      const state = runtime instanceof RuntimeHostClient
        ? await runtime.getPersonalizationState(sessionId)
        : await this.readPersonalizationState();
      if (!state.catalogRevision) throw new Error("Chat personalization revision is unavailable.");
      const updated = this.commands
        ? await runtime.runExclusiveOperation(
          "personalization",
          async () => await this.commands!.agent.updateChatPersonalization(patch, state.catalogRevision)
        )
        : await requireRemoteRuntime(runtime).updateChatPersonalization(patch, state.catalogRevision, sessionId);
      const memory = memoryPolicyOptionForOverride(updated);
      this.notify(`Chat settings saved (memory ${memory}). They apply from the next root turn.`);
    } catch (error) {
      this.showTextViewer("Personalization", describeError(error));
    }
  }

  private async selectModel(alias: string): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    const models = commands
      ? commands.agent.listModels()
      : await requireRemoteRuntime(runtime).listModels();
    const model = models.find((candidate) => candidate.alias === alias);
    if (!model) {
      this.showTextViewer("Model", `Unknown model alias: ${alias}`);
      return;
    }
    if (!model.efforts.length) {
      this.applyModel(alias, "off", model);
      return;
    }

    const current = runtime.getSnapshot().info;
    const currentThinking = selectedThinkingForModel(current.modelAlias, current.thinking, model);
    const options = modelThinkingOptions(model);
    this.showSelect({
      title: "Thinking Level",
      hint: "↑↓ navigate · enter select · esc back",
      selectedIndex: Math.max(0, options.findIndex((option) => option.value === currentThinking)),
      items: options.map((option) => ({
        value: option.value,
        label: option.label
      })),
      onSelect: (item) => {
        this.applyModel(alias, item.value as ThinkingSelection, model);
      }
    });
  }

  private applyModel(alias: string, thinking?: ThinkingSelection, model?: ModelChoice): void {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    const sessionId = runtime.getSnapshot().info.sessionId;
    const requestId = ++this.modelSwitchGeneration;
    const optimistic = modelPresentationFromChoice(
      alias,
      thinking ?? model?.defaultThinking ?? "off",
      model,
      this.state.provider
    );
    this.applyModelPresentation(optimistic);

    const request = this.modelSwitchQueue
      .catch(() => undefined)
      .then(async () => {
        const info = commands
          ? await runtime.runExclusiveOperation(
            "switch_model",
            async () => await commands.agent.switchModel(alias, thinking)
          )
          : await requireRemoteRuntime(runtime).switchModel(alias, thinking, sessionId);
        const confirmed = modelPresentationFromInfo(info);
        if (this.modelSwitchGeneration === requestId && runtime.getSnapshot().info.sessionId === sessionId) {
          this.confirmedModel = confirmed;
          this.applyModelPresentation(confirmed);
          this.notify(`Model changed to ${info.modelLabel} ${info.reasoningLabel.toLowerCase()}`);
        }
      });
    this.modelSwitchQueue = request.catch(() => undefined);
    this.modelSwitchPromise = request;
    void request.then(
      () => {
        if (this.modelSwitchGeneration === requestId) this.modelSwitchPromise = undefined;
      },
      (error: unknown) => {
        if (this.modelSwitchGeneration !== requestId) return;
        this.modelSwitchPromise = undefined;
        if (runtime.getSnapshot().info.sessionId !== sessionId) return;
        this.applyModelPresentation(this.confirmedModel ?? modelPresentationFromInfo(runtime.getSnapshot().info));
        this.showTextViewer("Model", `Model switch failed: ${describeError(error)}`);
      }
    );
  }

  private applyModelPresentation(presentation: ModelPresentation): void {
    this.thinking = presentation.thinking;
    this.editor.borderColor = theme.thinkingBorder(this.thinking);
    this.dispatch({
      type: "model.changed",
      provider: presentation.provider,
      modelLabel: presentation.modelLabel,
      reasoningLabel: presentation.reasoningLabel
    });
  }

  private showPermissionModePicker(): void {
    this.showSelect({
      title: "Select permission mode",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, permissionModeOptions.findIndex((option) => option.mode === this.permissionMode)),
      items: permissionModeOptions.map((option) => ({
        value: option.mode,
        label: option.mode === this.permissionMode ? `${option.label} ← current` : option.label,
        description: option.description
      })),
      onSelect: (item) => {
        // applyPermissionMode 在 runtime 忙时会被 runExclusiveOperation 拒绝，就地提示而不是 unhandled rejection。
        void this.applyPermissionMode(item.value as PermissionMode)
          .catch((error: unknown) => this.notify(`切换权限模式失败：${describeError(error)}`));
      }
    });
  }

  private async applyPermissionMode(mode: PermissionMode): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    if (commands) {
      await runtime.runExclusiveOperation(
        "permission",
        async () => await commands.agent.setPermissionMode(mode)
      );
    } else {
      await requireRemoteRuntime(runtime).setPermissionMode(mode);
    }
    this.permissionMode = mode;
    this.notify(formatPermissionModeChanged(mode));
  }

  private async showSessionPicker(): Promise<void> {
    const commands = this.commands;
    const runtime = this.runtime;
    if (!runtime) return;
    const summaries = (await (commands
      ? commands.agent.listSessions()
      : requireRemoteRuntime(runtime).listSessions()))
      .filter((summary) => summary.firstUserMessage.trim())
      .slice();
    if (!summaries.length) {
      this.showTextViewer("Sessions", "No sessions yet.");
      return;
    }
    const nowMs = Date.now();
    this.showSelect({
      title: "Resume session",
      hint: "↑↓ navigate · enter resume · esc cancel",
      items: summaries.map((summary) => ({
        value: summary.fileName.replace(/\.jsonl$/, ""),
        label: sessionLabel(summary, nowMs),
        description: summary.firstUserMessage.replace(/\s+/g, " ").slice(0, 80)
      })),
      onSelect: (item) => {
        // resumeSession 会把非 writer-conflict 错误（runtime 忙、会话损坏）重抛，必须就地提示。
        void this.resumeSession(item.value)
          .catch((error: unknown) => this.notify(`恢复会话失败：${describeError(error)}`));
      }
    });
  }

  /** 展示 Host 注册表中的驻留 session；历史会话选择仍由 /resume 负责。 */
  private async showRuntimeSessionPicker(): Promise<void> {
    const runtime = this.runtime;
    if (!(runtime instanceof RuntimeHostClient)) {
      this.showTextViewer("Runtime sessions", "当前 TUI 没有连接到 Runtime Host，只有当前会话可用。请先在 Unix 环境启用 Runtime Host。");
      return;
    }
    const summaries = await runtime.listRuntimeSessions();
    if (!summaries.length) {
      this.showTextViewer("Runtime sessions", "No active Runtime Host sessions.");
      return;
    }
    let worktreeSessionIds: Set<string>;
    try {
      worktreeSessionIds = new Set((await runtime.worktreeList()).map((record) => record.sessionId));
    } catch (error) {
      this.showTextViewer("Runtime sessions", formatTuiWorktreeError(error));
      return;
    }
    const focusedSessionId = runtime.getFocusedSessionId();
    this.showSelect({
      title: "Runtime sessions",
      hint: "↑↓ navigate · enter focus · esc cancel",
      selectedIndex: Math.max(0, summaries.findIndex((summary) => summary.sessionId === focusedSessionId)),
      items: summaries.map((summary) => ({
        value: summary.sessionId,
        label: runtimeSessionLabel(summary, worktreeSessionIds.has(summary.sessionId)),
        // session 文件路径属于诊断信息；普通 session 列表只展示状态和可写姿态，避免把
        // 本机目录结构暴露到交互层。需要路径时仍由退出摘要和诊断命令提供。
        description: summary.snapshot.permissionMode === "read-only" ? "read-only session" : "writable session"
      })),
      onSelect: (item) => {
        void this.focusRuntimeSession(item.value)
          .catch((error: unknown) => this.notify(`切换 session 失败：${describeError(error)}`));
      }
    });
  }

  private async handleWorktreeCommand(args: string[]): Promise<void> {
    const runtime = this.runtime;
    if (!(runtime instanceof RuntimeHostClient)) {
      this.showTextViewer("Worktrees", "当前 TUI 没有连接到 Runtime Host，无法管理隔离工作树。");
      return;
    }
    const action = args[0]?.toLowerCase();
    if (action !== undefined && action !== "list" && action !== "status" && action !== "merge" && action !== "remove") {
      this.showTextViewer("Worktrees", "Usage: /worktree [list|status|merge <session>|remove <session>]");
      return;
    }
    if (action === "merge" || action === "remove") {
      const requestedSession = args[1];
      if (!requestedSession) {
        this.showTextViewer("Worktrees", `Usage: /worktree ${action} <session>`);
        return;
      }
      let statuses: WorktreeStatusView[];
      try {
        statuses = await runtime.worktreeStatus();
      } catch (error) {
        this.showTextViewer("Worktrees", formatTuiWorktreeError(error));
        return;
      }
      const status = resolveWorktreeStatus(statuses, requestedSession);
      if (!status) {
        this.showTextViewer("Worktrees", `No unique worktree matches session ${requestedSession}.`);
        return;
      }
      await this.runWorktreeAction(status, action === "merge" ? "merge" : removeActionForStatus(status));
      return;
    }
    await this.showWorktreePicker();
  }

  /** 只展示生命周期和安全提示；路径、分支、base commit 仍留在诊断层。 */
  private async showWorktreePicker(): Promise<void> {
    const runtime = this.runtime;
    if (!(runtime instanceof RuntimeHostClient)) return;
    let statuses: WorktreeStatusView[];
    try {
      statuses = await runtime.worktreeStatus();
    } catch (error) {
      this.showTextViewer("Worktrees", formatTuiWorktreeError(error));
      return;
    }
    if (!statuses.length) {
      this.showTextViewer("Worktrees", "No isolated worktrees.");
      return;
    }
    this.showSelect({
      title: "Isolated worktrees",
      hint: "↑↓ navigate · enter inspect · esc cancel",
      items: statuses.map((status) => {
        const view = tuiWorktreeView(status);
        return {
          value: status.sessionId,
          label: `${status.sessionId.slice(0, 8)} · ${view.label}`,
          description: view.detail
        };
      }),
      onSelect: (item) => {
        const status = statuses.find((candidate) => candidate.sessionId === item.value);
        if (!status) return;
        void this.showWorktreeActions(status)
          .catch((error: unknown) => this.notify(formatTuiWorktreeError(error)));
      }
    });
  }

  private async showWorktreeActions(status: WorktreeStatusView): Promise<void> {
    const view = tuiWorktreeView(status);
    if (!view.actions.length) {
      this.showTextViewer(`Worktree ${status.sessionId.slice(0, 8)}`, `${view.label}\n${view.detail}`);
      return;
    }
    this.showSelect({
      title: `Worktree ${status.sessionId.slice(0, 8)}`,
      hint: "↑↓ navigate · enter confirm · esc back",
      items: view.actions.map((action) => ({
        value: action,
        label: tuiWorktreeActionLabel(action),
        description: tuiWorktreeActionDescription(action)
      })),
      onSelect: (item) => {
        void this.runWorktreeAction(status, item.value as TuiWorktreeAction)
          .catch((error: unknown) => this.notify(formatTuiWorktreeError(error)));
      }
    });
  }

  private async runWorktreeAction(status: WorktreeStatusView, action: TuiWorktreeAction): Promise<void> {
    const runtime = this.runtime;
    if (!(runtime instanceof RuntimeHostClient)) return;
    const view = tuiWorktreeView(status);
    if (!view.actions.includes(action)) {
      this.showTextViewer("Worktrees", `${view.label}\n${view.detail}`);
      return;
    }
    try {
      if (action === "merge") {
        await runtime.worktreeMerge(status.sessionId, { strategy: "merge", deleteAfter: true });
        this.notify(`Worktree ${status.sessionId.slice(0, 8)} merged and cleaned.`);
      } else {
        await runtime.worktreeRemove(status.sessionId, action === "remove-branch");
        this.notify(`Worktree ${status.sessionId.slice(0, 8)} cleaned.`);
      }
    } catch (error) {
      this.showTextViewer("Worktrees", formatTuiWorktreeError(error));
      return;
    }
    const focusedSessionId = runtime.getFocusedSessionId();
    if (focusedSessionId !== undefined && focusedSessionId !== this.state.sessionId) {
      await this.focusRuntimeSession(focusedSessionId);
      return;
    }
    this.runtimeSnapshot = runtime.getSnapshot();
    this.refreshChrome();
  }

  private async focusRuntimeSession(sessionId: string): Promise<void> {
    const runtime = this.runtime;
    if (!(runtime instanceof RuntimeHostClient)) return;
    let snapshot: InteractiveRuntimeSnapshot;
    try {
      snapshot = await runtime.focusSession(sessionId);
    } catch (error) {
      if (!isSessionWriterConflictError(error)) throw error;
      await this.showSessionWriterConflict(sessionId, error.ownerSurface);
      return;
    }
    const { info } = snapshot;
    this.runtimeSnapshot = snapshot;
    this.permissionMode = snapshot.permissionMode;
    this.thinking = info.thinking;
    this.confirmedModel = modelPresentationFromInfo(info);
    this.clearSessionWriterConflict();
    this.chatContainer.reset();
    this.dispatch({
      type: "session.started",
      sessionId: info.sessionId,
      sessionFile: info.sessionFile,
      cwd: info.workspaceRoot,
      provider: info.provider,
      modelLabel: info.modelLabel,
      reasoningLabel: info.reasoningLabel
    });
    const stored = await readStoredSessionEvents(runtime.persistenceRoot, sessionId);
    this.dispatch({
      type: "transcript.replaced",
      viewingSessionId: sessionId,
      items: sessionEventsToTranscript(stored.events)
    });
    if (snapshot.state.kind === "idle") {
      try {
        // 切换到空闲 session 时提前取得长期 claim，避免用户看到可写编辑器后才发现
        // 另一个 surface 已经占用同一会话；运行中的 session 继续保持只观察/排队语义。
        await runtime.claimSession(sessionId);
      } catch (error) {
        if (!isSessionWriterConflictError(error)) throw error;
        await this.showSessionWriterConflict(sessionId, error.ownerSurface);
        return;
      }
    }
    void readGitBranch(info.workspaceRoot).then((branch) => {
      this.gitBranch = branch;
      this.refreshChrome();
    });
    await this.refreshContextUsage();
    await this.refreshUsage();
    this.notify(`已切换到 session ${sessionId.slice(0, 8)}。`);
  }

  private async resumeSession(session: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !session) return;
    try {
      if (runtime instanceof RuntimeHostClient) {
        // 驻留会话只切换观察目标；历史会话由 Host 按 ID 懒加载，不重放正在运行的实例。
        const stored = await readStoredSessionEvents(runtime.persistenceRoot, session);
        await this.focusRuntimeSession(sessionIdFromFile(stored.filePath));
        return;
      }
      const resumed = await runtime.resumeSession(session);
      this.clearSessionWriterConflict();
      this.announceCurrentSession();
      this.chatContainer.reset();
      this.dispatch({
        type: "transcript.replaced",
        viewingSessionId: resumed.sessionId,
        items: sessionEventsToTranscript(resumed.events)
      });
      await this.refreshContextUsage();
      await this.refreshUsage();
    } catch (error) {
      if (!isSessionWriterConflictError(error)) throw error;
      await this.showSessionWriterConflict(session, error.ownerSurface);
    }
  }

  private async showSessionWriterConflict(sessionId: string, ownerSurface?: string): Promise<void> {
    this.sessionWriterConflict = { sessionId, ownerSurface };
    this.editorContainer.removeChild(this.pendingAttachmentsView);
    this.editorContainer.removeChild(this.editor);
    this.sessionWriterConflictView = new SessionWriterConflictComponent(
      this.sessionWriterConflict,
      () => {
        // resumeSession 会把非冲突错误重抛，回调里必须兜住，避免 unhandled rejection。
        void this.retrySessionWriterConflict()
          .catch((error: unknown) => this.notify(`恢复会话失败：${describeError(error)}`));
      }
    );
    this.editorContainer.addChild(this.sessionWriterConflictView);
    this.ui.setFocus(this.sessionWriterConflictView);
    this.setPendingAttachments([]);
    this.chatContainer.reset();
    try {
      const stored = await readStoredSessionEvents(this.commands?.persistenceRoot ?? this.workspaceRoot, sessionId);
      this.dispatch({
        type: "transcript.replaced",
        viewingSessionId: sessionId,
        items: sessionEventsToTranscript(stored.events)
      });
    } catch (error) {
      this.dispatch({ type: "error.message", message: `读取只读会话失败：${describeError(error)}` });
    }
    this.ui.requestRender();
  }

  private clearSessionWriterConflict(): void {
    if (!this.sessionWriterConflict && !this.sessionWriterConflictView) return;
    if (this.sessionWriterConflictView) this.editorContainer.removeChild(this.sessionWriterConflictView);
    this.sessionWriterConflictView = undefined;
    this.sessionWriterConflict = undefined;
    this.editorContainer.addChild(this.pendingAttachmentsView);
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private async retrySessionWriterConflict(): Promise<void> {
    const conflict = this.sessionWriterConflict;
    const view = this.sessionWriterConflictView;
    if (!conflict || !view) return;
    view.setRetrying(true);
    this.ui.requestRender();
    try {
      await this.resumeSession(conflict.sessionId);
    } finally {
      if (this.sessionWriterConflictView === view) view.setRetrying(false);
      this.ui.requestRender();
    }
  }

  // ---------------------------------------------------------------- 退出

  async exit(): Promise<void> {
    // 幂等：Ctrl+C 和外部关闭可能同时触发。
    if (this.exiting) return;
    this.exiting = true;
    this.status.dispose();
    try {
      const runtime = this.runtime;
      if (runtime) {
        let snapshot = this.runtimeSnapshot;
        try {
          snapshot ??= runtime.getSnapshot();
        } catch {
          // runtime 可能正处于 Host 断线或初始化失败；仍需继续清理 TUI。
        }
        if (snapshot) {
          const { info } = snapshot;
          this.exitSummary = { sessionId: info.sessionId, sessionFile: info.sessionFile };
        }
        // 只取消本窗口取得写权限的 Session，观察其他窗口的任务不代表拥有它。
        if (runtime instanceof RuntimeHostClient) {
          await Promise.all([...this.ownedSessionIds].map(async (sessionId) => await drainRuntimeBeforeExit(runtime, sessionId)));
        } else if (snapshot && runtimeIsBusy(snapshot)) {
          await drainRuntimeBeforeExit(runtime);
        }
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        await this.runtimeHost?.close();
        await runtime.close();
      } else {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    } catch {
      // 关闭 Host/runtime 失败不能中断退出：终端必须恢复，run() 的等待者必须被唤醒。
    } finally {
      this.ui.stop();
      this.resolveExit?.();
    }
  }
}

/** Skill 补全沿用两步交互，普通 slash 命令则由 Editor 在同一次 Enter 中提交。 */
export function shouldConfirmAutocompleteOnEnter(
  data: string,
  autocompleteVisible: boolean,
  inputText: string
): boolean {
  return autocompleteVisible && /^\/skill(?::|$)/u.test(inputText.trimStart()) && matchesKey(data, "enter");
}

/** 判断两次 Ctrl+C 是否处于 pi 的 500ms 退出窗口内。 */
export function isDoubleCtrlC(lastCtrlCAt: number, now: number): boolean {
  return lastCtrlCAt > 0 && now >= lastCtrlCAt && now - lastCtrlCAt < 500;
}

export function ctrlCAction(lastCtrlCAt: number, now: number): "cancel" | "exit" {
  return isDoubleCtrlC(lastCtrlCAt, now) ? "exit" : "cancel";
}

async function drainRuntimeBeforeExit(runtime: InteractiveRuntimeHandle, sessionId?: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (runtime instanceof RuntimeHostClient) {
          const snapshot = runtime.getSnapshot(sessionId);
          if (snapshot.state.kind === "runs") await runtime.cancelRunRequest(snapshot.state.activeRun.runId, sessionId);
          await runtime.waitForIdle(sessionId);
        } else {
          runtime.cancelCurrentRun();
          await runtime.waitForIdle();
        }
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TUI_SHUTDOWN_DRAIN_MS);
      })
    ]);
  } catch {
    // 退出路径 fail-closed：取消或等待失败不能阻止 TUI 断开连接。
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sessionLabel(summary: SessionSummary, nowMs: number): string {
  return `${summary.fileName.replace(/\.jsonl$/, "")} · ${formatSessionAge(summary.updatedAt, nowMs)}`;
}

function runtimeSessionLabel(summary: {
  sessionId: string;
  primary: boolean;
  snapshot: InteractiveRuntimeSnapshot;
}, isolated: boolean): string {
  const state = summary.snapshot.state.kind === "idle"
    ? "idle"
    : summary.snapshot.state.kind === "maintenance"
      ? "maintenance"
      : summary.snapshot.state.pendingPermission
        ? "permission"
        : "running";
  return `${summary.primary ? "●" : "○"} ${summary.sessionId.slice(0, 8)} · ${state}${isolated ? " · worktree" : ""}`;
}

function resolveWorktreeStatus(statuses: readonly WorktreeStatusView[], requestedSession: string): WorktreeStatusView | undefined {
  const exact = statuses.find((status) => status.sessionId === requestedSession);
  if (exact) return exact;
  const matches = statuses.filter((status) => status.sessionId.startsWith(requestedSession));
  return matches.length === 1 ? matches[0] : undefined;
}

function removeActionForStatus(status: WorktreeStatusView): TuiWorktreeAction {
  return status.status === "merged" || status.mergedIntoBase ? "remove-branch" : "remove-worktree";
}

function modelPresentationFromInfo(info: { provider: string; modelLabel: string; reasoningLabel: string; thinking: ThinkingSelection }): ModelPresentation {
  return {
    provider: info.provider,
    modelLabel: info.modelLabel,
    reasoningLabel: info.reasoningLabel,
    thinking: info.thinking
  };
}

function modelPresentationFromChoice(
  alias: string,
  thinking: ThinkingSelection,
  model: ModelChoice | undefined,
  fallbackProvider: string
): ModelPresentation {
  return {
    provider: model?.providerType ?? fallbackProvider,
    modelLabel: model?.displayName ?? alias,
    reasoningLabel: formatReasoningLabel(thinking),
    thinking
  };
}

function formatReasoningLabel(thinking: ThinkingSelection): string {
  if (thinking === "off") return "Off";
  return thinking === "xhigh"
    ? "XHigh"
    : `${thinking[0]?.toUpperCase() ?? ""}${thinking.slice(1)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRemoteRuntime(runtime: InteractiveRuntimeHandle): RuntimeHostClient {
  if (!(runtime instanceof RuntimeHostClient)) throw new Error("Remote runtime client is unavailable.");
  return runtime;
}

/** /skill:name、/skills:name 是技能调用而非 slash 命令，按普通输入原文提交。 */
function isSkillInvocationText(value: string): boolean {
  return /^\/skills?:[^\s]+/u.test(value.trim().replace(/\u00a0/g, " "));
}

export function memoryPolicyOptionForOverride(
  state: Pick<AgentPersonalizationState, "override" | "resolved">
): typeof memoryPolicySelectOptions[number]["value"] {
  const { useMemories, contributeMemories } = state.override;
  if (useMemories === "inherit" && contributeMemories === "inherit") return "inherit";
  if (state.resolved.useMemories && state.resolved.contributeMemories) return "both";
  if (state.resolved.useMemories) return "use";
  if (state.resolved.contributeMemories) return "contribute";
  return "off";
}

export function runtimeStatus(snapshot: InteractiveRuntimeSnapshot | undefined): TuiStatus {
  if (!snapshot || snapshot.state.kind === "idle") return "idle";
  // 模型切换、会话恢复和内存整理等 maintenance 不是 Agent 工作回合，
  // 状态行保持空闲留白，不展示 Working 或耗时。
  if (snapshot.state.kind !== "runs") return "idle";
  if (snapshot.state.pendingPermission) return "waiting_permission";
  return snapshot.state.activeRun.status === "thinking" ? "thinking" : "running";
}

/**
 * 选择器从输入框下方展开，临时覆盖 footer 和快捷键行。
 * 窄终端或长列表时向上收缩，保证弹层不越过当前视口。
 */
export function selectDialogRow(
  contentHeight: number,
  dialogHeight: number,
  terminalHeight: number,
  chromeTailHeight: number
): number {
  const belowEditor = Math.max(0, contentHeight - chromeTailHeight);
  return Math.min(belowEditor, Math.max(0, terminalHeight - dialogHeight));
}
