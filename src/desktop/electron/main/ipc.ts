/**
 * 桌面端 IPC handler 注册。
 *
 * 每个 `desktopIpc` 通道在这里对应一个 handler。渲染进程虽然是自己的代码，但仍按不可信输入
 * 对待：所有参数先过 zod schema 校验（长度、枚举、URL 协议等），再转交给对应服务。
 *
 * 这一层只做「校验 + 转发 + 系统对话框/菜单」，项目、会话、agent 的实际逻辑都在各服务里。
 */
import { spawn } from "node:child_process";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  systemPreferences,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions
} from "electron";
import { z } from "zod";
import { desktopCrystalRequestSchema } from "../../crystalProtocol.js";
import type { DesktopCrystalService } from "./DesktopCrystalService.js";
import { agentCapabilitySelectionSchema } from "../../../agent/capabilitySelection.js";
import {
  chatPersonalizationSchema,
  configRevisionSchema,
  fontPreferenceSchema,
  idSchema,
  memorySettingsSchema,
  modelConfigurationSchema,
  settingsSaveInputSchema,
  themePreferenceSchema,
  thinkingSchema
} from "./settingsSaveInputSchema.js";
import { clampFontSize } from "../../fontPreference.js";
import type { DesktopActiveView, DesktopBootstrap, DesktopQuickChatSettings, DesktopSettingsCloseResponse, DesktopSettingsDraftState, DesktopSettingsSaveInput, DesktopSystemSettingsPane, DesktopThemePreference } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";
import { DesktopAgentManager } from "./DesktopAgentManager.js";
import { ActivityRecorderService } from "./ActivityRecorderService.js";
import { DesktopBrowserService } from "./DesktopBrowserService.js";
import { DesktopMcpService } from "./DesktopMcpService.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopSkillService } from "./DesktopSkillService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { DesktopSettingsTransaction } from "./DesktopSettingsTransaction.js";
import { DesktopTerminalManager } from "./DesktopTerminalManager.js";
import { QuickChatContextService } from "./QuickChatContextService.js";
import type { QuickChatWindowController } from "./quickChatWindow.js";
import { runtimeMutationStartsWork } from "./settingsRuntimeGate.js";
import { exportSessionBundle, exportSessionClaudeCode } from "../../../session/transfer.js";
import { activitySettingsPatchSchema } from "../../../activity/settings.js";
import { resolveActivityReportRange } from "../../../activity/analyzer.js";
import { readDailyMemoryNote } from "../../../activity/dailyNotes.js";

interface IpcContext {
  crystals: DesktopCrystalService;
  state: DesktopStateStore;
  projects: DesktopProjectService;
  agents: DesktopAgentManager;
  settings: DesktopSettingsTransaction;
  activity: ActivityRecorderService;
  terminals: DesktopTerminalManager;
  browser: DesktopBrowserService;
  skills: DesktopSkillService;
  mcp: DesktopMcpService;
  getWindow(): BrowserWindow | undefined;
  /** 惰性创建/返回 QuickChat 悬浮窗控制器；toggle/hide/applySettings 经它落到窗口。 */
  ensureQuickChatWindow(): QuickChatWindowController;
  /** 只读取已创建的 QuickChat 窗口，设置读取/隐藏不应无故创建窗口。 */
  getQuickChatWindow(): QuickChatWindowController | undefined;
  quickChatContext: QuickChatContextService;
  toggleQuickChat(): Promise<void>;
  bootstrap(): Promise<DesktopBootstrap>;
  updateSettingsDraftState(state: DesktopSettingsDraftState): void;
  resolveSettingsCloseRequest(requestId: string, response: DesktopSettingsCloseResponse): boolean;
}

// 以下 schema 是渲染层参数的唯一入口校验，上限值都刻意给得比正常用法宽松，
// 只用于挡住异常大的输入，不承担业务规则校验。
const promptSchema = z.string().min(1).max(1_000_000);
const promptContextSchema = z.string().max(30_000).optional();
const userMessageIndexSchema = z.number().int().nonnegative();
const titleSchema = z.string().trim().min(1).max(120);
const identityDocumentSchema = z.enum(["user"]);
const identityContentSchema = z.string().max(64 * 1024);
const pluginScopeSchema = z.enum(["project", "global"]).optional();
const identityReasonSchema = z.string().max(1_000).optional();
const branchNameSchema = z.string().trim().min(1).max(255);
const revisionSchema = z.string().max(200).optional();
const idempotencyKeySchema = z.string().trim().min(1).max(240).optional();
const sessionTreePageOptionsSchema = z.object({
  parentSessionId: idSchema.optional(),
  cursor: z.string().max(4_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  includeArchived: z.boolean().optional()
}).optional();
const permissionModeSchema = z.enum(["ask", "read-only", "auto", "full-access"]);
const activeViewSchema = z.enum(["chat", "runtime", "extensions"]);
const systemSettingsPaneSchema = z.enum(["screen-recording", "accessibility"]);
/** QuickChat 三开关的入参边界：逐字段布尔，额外字段拒绝，与 DesktopStateStore 归一化逻辑对齐。 */
const quickChatSettingsSchema = z.object({
  autoHideOnBlur: z.boolean(),
  injectScreenContext: z.boolean(),
  clickThrough: z.boolean()
}).strict();
const terminalSizeSchema = z.number().int().min(2).max(1_000);
const terminalDataSchema = z.string().max(1_000_000);
const activityQuerySchema = z.string().trim().max(500);
const activityLimitSchema = z.number().int().min(1).max(100).optional();
const activitySessionIdSchema = z.string().trim().min(1).max(128);
const activitySnapshotIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const activityReportDateSchema = z.string().trim().min(1).max(40).optional();
const modelLoginProviderSchema = z.enum(["claude-code", "openai-codex"]);
const settingsCredentialScopeSchema = z.object({
  projectId: idSchema,
  purpose: z.enum(["model", "web-search"]),
  providerAlias: idSchema
}).strict();
const permissionResultSchema = z.object({
  approved: z.boolean(),
  scope: z.enum(["once", "command", "session", "tool", "path"]).optional(),
  nextMode: permissionModeSchema.optional(),
  message: z.string().max(500).optional(),
  confirmation: z.string().max(16).optional()
});
const attachmentSchema = z.object({
  name: z.string().max(240),
  path: z.string().max(2_000),
  mimeType: z.string().max(200),
  size: z.number().int().nonnegative().max(50 * 1024 * 1024)
});
// 搜索结果与正文外链可能仍是 http://，交给系统浏览器打开是安全的；其余协议一律拒绝。
const externalUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Only HTTP(S) links can be opened externally.");
const memoryOriginFilterSchema = z.enum(["all", "current_workspace", "user", "other_workspaces"]);
const memoryAudienceSchema = z.enum(["workspace", "universal"]);
const memoryTopicSchema = z.string().trim().min(1).max(64);
const memoryTitleSchema = z.string().trim().min(1).max(120);
const memorySummarySchema = z.string().trim().min(1).max(4_000);
const memoryDecisionListSchema = z.array(z.string().trim().min(1).max(500)).max(8);
const memoryPathListSchema = z.array(z.string().trim().min(1).max(500)).max(16);
const memoryKeywordListSchema = z.array(z.string().trim().min(1).max(120)).max(12);
const memoryUserEvidenceSchema = z.string().trim().min(1).max(1_000).optional();
const memoryQuerySchema = z.string().trim().min(1).max(2_000);
const memoryEntryIdSchema = z.string().min(1).max(512);
const localEmbeddingModelSchema = z.literal("multilingual-e5-small");
const memoryRevisionSchema = z.number().int().nonnegative();
const memorySettingsInputSchema = z.object({
  expectedRevision: configRevisionSchema,
  settings: memorySettingsSchema
}).strict();
const memoryEntryInputSchema = z.object({
  audience: memoryAudienceSchema,
  topic: memoryTopicSchema,
  kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]),
  title: memoryTitleSchema,
  summary: memorySummarySchema,
  decisions: memoryDecisionListSchema,
  paths: memoryPathListSchema,
  keywords: memoryKeywordListSchema,
  importance: z.number().finite(),
  userEvidence: memoryUserEvidenceSchema
}).strict();
const memoryEntryPatchSchema = z.object({
  topic: memoryTopicSchema.optional(),
  kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]).optional(),
  title: memoryTitleSchema.optional(),
  summary: memorySummarySchema.optional(),
  decisions: memoryDecisionListSchema.optional(),
  paths: memoryPathListSchema.optional(),
  keywords: memoryKeywordListSchema.optional(),
  importance: z.number().finite().optional(),
  userEvidence: memoryUserEvidenceSchema
}).strict();
const runtimeMutationSchema = z.enum([
  "plan.mode", "plan.start",
  "task.create", "task.start", "task.run", "task.cancel", "task.approve", "task.resume", "task.retry",
  "automation.create", "automation.pause", "automation.resume", "automation.run", "automation.delete",
  "goal.create", "goal.pause", "goal.resume", "goal.cancel",
  "graph.create", "graph.start", "graph.pause", "graph.resume", "graph.cancel",
  "capability.register", "capability.replace", "capability.admit", "capability.reject", "capability.release",
  "capability.invoke", "capability.accept", "capability.start", "capability.result", "capability.chunk", "capability.fail", "capability.cancel",
  "worktree.merge", "worktree.remove"
]);
const runtimePayloadSchema = z.record(z.unknown()).optional();
const settingsDraftStateSchema = z.object({
  dirty: z.boolean(),
  canSave: z.boolean(),
  open: z.boolean()
}).strict();
const settingsCloseResponseSchema = z.enum(["saved", "discarded", "cancelled"]);
const skillIdSchema = z.string().trim().min(1).max(128);
const skillProjectIdSchema = idSchema;
const skillFilePathSchema = z.string().trim().min(1).max(2_000);
const skillFileContentSchema = z.string().max(512 * 1024);
const skillImportIdsSchema = z.array(skillIdSchema).max(256);
const skillRepositoryOwnerSchema = z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/u);
const skillRepositoryNameSchema = z.string().trim().regex(/^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u);
const skillRepositoryBranchSchema = z.string().trim().min(1).max(255).refine(
  (value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") && !value.includes("//") && !/[\\#%?*^ ~:]/u.test(value) && value.split("/").every((part) => part.length > 0 && !part.startsWith(".")),
  "Skill 仓库分支无效。"
);
const skillRepositorySchema = z.object({
  owner: skillRepositoryOwnerSchema,
  name: skillRepositoryNameSchema,
  branch: skillRepositoryBranchSchema,
  enabled: z.boolean()
}).strict();
const skillDiscoverySearchQuerySchema = z.string().trim().min(2).max(120);
const skillDiscoverySearchLimitSchema = z.number().int().min(1).max(50).optional();
const skillDiscoverySearchOffsetSchema = z.number().int().min(0).max(10_000).optional();
const discoverableSkillSchema = z.object({
  key: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4_000),
  directory: z.string().trim().min(1).max(1_000),
  readmeUrl: externalUrlSchema.optional(),
  repoOwner: skillRepositoryOwnerSchema,
  repoName: skillRepositoryNameSchema,
  repoBranch: skillRepositoryBranchSchema,
  installed: z.boolean()
}).strict();
const mcpProjectIdSchema = idSchema.optional();
const mcpFieldMutationSchema = z.object({
  key: z.string().trim().min(1).max(200),
  action: z.enum(["set", "keep", "clear"]),
  value: z.string().max(16_000).optional()
}).strict().superRefine((field, context) => {
  if (field.action === "set" && field.value === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "set MCP 字段必须提供 value。" });
  }
});
const mcpDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
  transport: z.enum(["stdio", "remote"]),
  command: z.string().trim().max(2_000).optional(),
  args: z.array(z.string().max(4_000)).max(256),
  cwd: z.string().trim().max(2_000).optional(),
  stderr: z.enum(["ignore", "inherit", "pipe"]).optional(),
  url: z.string().url().max(4_000).optional(),
  remoteProtocol: z.enum(["streamable-http", "sse"]).optional(),
  oauth: z.object({
    clientId: z.string().trim().min(1).max(2_000).optional(),
    scopes: z.array(z.string().trim().min(1).max(200)).max(32).optional(),
    redirectPort: z.number().int().min(1024).max(65535).optional()
  }).strict().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  env: z.array(mcpFieldMutationSchema).max(256),
  headers: z.array(mcpFieldMutationSchema).max(256)
}).strict();

function settingsSaveRequiresIdleRuntime(input: DesktopSettingsSaveInput): boolean {
  return input.activity !== undefined
    || input.identity !== undefined
    || input.memory !== undefined
    || input.compaction !== undefined
    || input.chatParams !== undefined
    || input.permission !== undefined
    || input.webSearch !== undefined
    || input.models !== undefined
    || input.skills !== undefined
    || input.chat !== undefined;
}

export function registerDesktopIpc(context: IpcContext): void {
  const settings = context.settings;
  const handleRecoveryGated = (
    channel: string,
    listener: Parameters<typeof ipcMain.handle>[1]
  ): void => {
    handle(channel, async (event, ...args) => {
      await settings.assertRuntimeReady();
      return await listener(event, ...args);
    });
  };
  handle(desktopIpc.bootstrap, async () => await context.bootstrap());
  handleRecoveryGated(desktopIpc.crystalRequest, async (_event, input: unknown) => {
    return await context.crystals.request(desktopCrystalRequestSchema.parse(input));
  });
  handleRecoveryGated(desktopIpc.activitySuggestions, async () => (await context.activity.suggestions()).suggestions);

  handle(desktopIpc.openProject, async () => {
    const window = context.getWindow();
    const options: OpenDialogOptions = {
      title: "打开 Biny 项目",
      buttonLabel: "打开项目",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const projectPath = result.filePaths[0];
    if (result.canceled || !projectPath) return undefined;
    const project = await context.projects.createProject(projectPath);
    return await context.agents.workspaceSnapshot(project.id);
  });

  handle(desktopIpc.createEmptyProject, async () => {
    const window = context.getWindow();
    const options: SaveDialogOptions = {
      title: "新建 Biny 项目",
      buttonLabel: "创建项目",
      defaultPath: "Biny 项目",
      properties: ["createDirectory", "showOverwriteConfirmation"]
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return undefined;
    const project = await context.projects.createEmptyProject(result.filePath);
    return await context.agents.workspaceSnapshot(project.id);
  });

  handle(desktopIpc.selectProject, async (_event, projectId: unknown) => {
    return await context.agents.workspaceSnapshot(idSchema.parse(projectId));
  });

  handle(desktopIpc.commitSelection, async (_event, projectId: unknown, sessionId: unknown, activeView: unknown) => {
    await context.state.commitSelection(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId),
      activeViewSchema.parse(activeView)
    );
  });

  handle(desktopIpc.setActiveView, async (_event, activeView: unknown) => {
    await context.state.setActiveView(activeViewSchema.parse(activeView) satisfies DesktopActiveView);
  });

  handle(desktopIpc.setProjectPinned, async (_event, projectId: unknown, pinned: unknown) => {
    return await context.agents.setProjectPinned(idSchema.parse(projectId), z.boolean().parse(pinned));
  });

  handle(desktopIpc.reorderProjects, async (_event, projectIds: unknown) => {
    const ids = z.array(idSchema).parse(projectIds);
    await context.state.reorderProjects(ids);
    return context.state.projects();
  });

  handle(desktopIpc.renameProject, async (_event, projectId: unknown, name: unknown) => {
    return await context.agents.renameProject(idSchema.parse(projectId), titleSchema.parse(name));
  });

  handle(desktopIpc.removeProject, async (_event, projectId: unknown) => {
    const id = idSchema.parse(projectId);
    if (context.agents.isProjectRunning(id)) throw new Error("Stop the running task before removing this project from the sidebar.");
    await context.agents.disposeProject(id);
    await context.state.removeProject(id);
    return await context.bootstrap();
  });

  handle(desktopIpc.refreshProject, async (_event, projectId: unknown) => {
    return await context.agents.workspaceSnapshot(idSchema.parse(projectId));
  });

  handle(desktopIpc.listProjectBranches, async (_event, projectId: unknown) => {
    return await context.agents.listProjectBranches(idSchema.parse(projectId));
  });

  handle(desktopIpc.switchProjectBranch, async (_event, projectId: unknown, branchName: unknown) => {
    return await context.agents.switchProjectBranch(idSchema.parse(projectId), branchNameSchema.parse(branchName));
  });

  handle(desktopIpc.createProjectBranch, async (_event, projectId: unknown, branchName: unknown) => {
    return await context.agents.createProjectBranch(idSchema.parse(projectId), branchNameSchema.parse(branchName));
  });

  handle(desktopIpc.revealProject, async (_event, projectId: unknown) => {
    shell.showItemInFolder(context.projects.requireProject(idSchema.parse(projectId)).path);
  });

  handle(desktopIpc.openProjectTerminal, async (_event, projectId: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    const child = spawn("/usr/bin/open", ["-a", "Terminal", project.path], { detached: true, stdio: "ignore" });
    // spawn 失败（如系统命令缺失）会以 error 事件异步抛出，不兜底会变成主进程 uncaughtException。
    child.on("error", () => undefined);
    child.unref();
  });

  handle(desktopIpc.listTerminals, async (_event, projectId: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    return context.terminals.list(project.id);
  });
  handle(desktopIpc.createTerminal, async (_event, projectId: unknown, cols: unknown, rows: unknown, slotId: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    if (project.missing) throw new Error("项目目录不可用，无法打开终端。");
    return await context.terminals.create(project.id, project.path, terminalSizeSchema.parse(cols), terminalSizeSchema.parse(rows), z.string().min(1).max(100).optional().parse(slotId));
  });

  // 键盘输入和窗口尺寸走 fire-and-forget 的 send 通道，省掉 invoke 往返延迟。
  ipcMain.on(desktopIpc.writeTerminal, (_event, terminalId: unknown, data: unknown) => {
    const parsedId = idSchema.safeParse(terminalId);
    const parsedData = terminalDataSchema.safeParse(data);
    if (parsedId.success && parsedData.success) context.terminals.write(parsedId.data, parsedData.data);
  });

  ipcMain.on(desktopIpc.resizeTerminal, (_event, terminalId: unknown, cols: unknown, rows: unknown) => {
    const parsedId = idSchema.safeParse(terminalId);
    const parsedCols = terminalSizeSchema.safeParse(cols);
    const parsedRows = terminalSizeSchema.safeParse(rows);
    if (parsedId.success && parsedCols.success && parsedRows.success) context.terminals.resize(parsedId.data, parsedCols.data, parsedRows.data);
  });

  handle(desktopIpc.disposeTerminal, async (_event, terminalId: unknown) => {
    context.terminals.dispose(idSchema.parse(terminalId));
  });

  handleRecoveryGated(desktopIpc.startDraft, async (_event, projectId: unknown) => {
    return await context.agents.startDraft(idSchema.parse(projectId));
  });

  handle(desktopIpc.openSession, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.openSession(idSchema.parse(projectId), idSchema.parse(sessionId));
  });

  handle(desktopIpc.listSessionTreePage, async (_event, projectId: unknown, options: unknown) => {
    return await context.agents.listSessionTreePage(idSchema.parse(projectId), sessionTreePageOptionsSchema.parse(options) ?? {});
  });

  handle(desktopIpc.renameSession, async (_event, projectId: unknown, sessionId: unknown, title: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.renameSession(parsedProjectId, idSchema.parse(sessionId), titleSchema.parse(title), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.pinSession, async (_event, projectId: unknown, sessionId: unknown, pinned: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.pinSession(parsedProjectId, idSchema.parse(sessionId), z.boolean().parse(pinned), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.archiveSession, async (_event, projectId: unknown, sessionId: unknown, archived: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.archiveSession(parsedProjectId, idSchema.parse(sessionId), z.boolean().parse(archived), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.markSessionRead, async (_event, projectId: unknown, sessionId: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.markSessionRead(parsedProjectId, idSchema.parse(sessionId), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.duplicateSession, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.duplicateSession(idSchema.parse(projectId), idSchema.parse(sessionId));
  });

  handle(desktopIpc.deleteSession, async (_event, projectId: unknown, sessionId: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    const parsedSessionId = idSchema.parse(sessionId);
    const options: MessageBoxOptions = {
      type: "warning",
      title: "删除会话",
      message: "确定要删除这个会话吗？",
      detail: "会删除全局项目会话目录中对应的 JSONL 文件，但不会删除项目文件。此操作无法撤销。",
      buttons: ["删除", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const window = context.getWindow();
    const confirmation = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return await context.agents.workspaceSnapshot(parsedProjectId);
    return await context.agents.deleteSession(parsedProjectId, parsedSessionId);
  });

  handle(desktopIpc.exportSession, async (_event, projectId: unknown, sessionId: unknown, format: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    const parsedSessionId = idSchema.parse(sessionId);
    const exportFormat = z.enum(["biny", "claude"]).parse(format);
    const project = context.projects.requireProject(parsedProjectId);
    const dataRoot = await context.projects.dataRoot(project);
    // 先在主进程拿到导出内容，用内容里的会话 id 给保存对话框一个可读、不重复的默认文件名。
    const exported = exportFormat === "claude"
      ? await exportSessionClaudeCode(dataRoot, parsedSessionId)
      : await exportSessionBundle(dataRoot, parsedSessionId);
    const defaultFileName = exportFormat === "claude" ? `${exported.baseName}.claude.jsonl` : `${exported.baseName}.biny.json`;
    const options: SaveDialogOptions = {
      title: exportFormat === "claude" ? "导出为 Claude Code 会话" : "导出会话包",
      defaultPath: defaultFileName,
      filters: exportFormat === "claude"
        ? [{ name: "Claude Code 会话", extensions: ["jsonl"] }]
        : [{ name: "Biny 会话包", extensions: ["json"] }]
    };
    const window = context.getWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return await context.agents.workspaceSnapshot(parsedProjectId);
    return await context.agents.exportSession(parsedProjectId, parsedSessionId, exportFormat, result.filePath);
  });

  handle(desktopIpc.importSession, async (_event, projectId: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    const options: OpenDialogOptions = {
      title: "导入会话",
      filters: [
        { name: "会话文件 (Biny / Claude Code / Codex)", extensions: ["json", "jsonl"] },
        { name: "全部文件", extensions: ["*"] }
      ],
      properties: ["openFile"]
    };
    const window = context.getWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const sourcePath = result.filePaths[0];
    if (result.canceled || !sourcePath) return await context.agents.workspaceSnapshot(parsedProjectId);
    return await context.agents.importSession(parsedProjectId, sourcePath);
  });

  handleRecoveryGated(desktopIpc.sendPrompt, async (_event, projectId: unknown, sessionId: unknown, input: unknown, attachments: unknown, delivery: unknown, personalization: unknown, idempotencyKey: unknown, promptContext: unknown, capabilitySelection: unknown, draftPlanning: unknown) => {
    return await context.agents.sendPrompt(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId),
      promptSchema.parse(input),
      z.array(attachmentSchema).max(20).parse(attachments),
      z.enum(["steer", "queue"]).optional().parse(delivery),
      chatPersonalizationSchema.optional().parse(personalization),
      idempotencyKeySchema.parse(idempotencyKey),
      promptContextSchema.parse(promptContext),
      capabilitySelection === undefined ? undefined : agentCapabilitySelectionSchema.parse(capabilitySelection),
      z.boolean().optional().parse(draftPlanning)
    );
  });

  handleRecoveryGated(desktopIpc.mutateQueuedMessage, async (_event, projectId: unknown, sessionId: unknown, action: unknown, mutation: unknown) => {
    const parsedMutation = z.object({
      messageId: idSchema.optional(),
      input: promptSchema.optional(),
      targetMessageId: idSchema.optional(),
      placeAfter: z.boolean().optional()
    }).optional().parse(mutation);
    await context.agents.mutateQueuedMessage(
      idSchema.parse(projectId),
      idSchema.parse(sessionId),
      z.enum(["update", "remove", "move", "steer", "send-all"]).parse(action),
      parsedMutation
    );
  });

  handle(desktopIpc.toolCatalog, async (_event, projectId: unknown) => await context.agents.toolCatalog(idSchema.parse(projectId)));

  handleRecoveryGated(desktopIpc.resumeInterruptedTurn, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.resumeInterruptedTurn(idSchema.parse(projectId), idSchema.parse(sessionId));
  });

  handleRecoveryGated(desktopIpc.editPrompt, async (_event, projectId: unknown, sessionId: unknown, userMessageIndex: unknown, input: unknown, attachments: unknown, idempotencyKey: unknown) => {
    return await context.agents.editPrompt(
      idSchema.parse(projectId),
      idSchema.parse(sessionId),
      userMessageIndexSchema.parse(userMessageIndex),
      promptSchema.parse(input),
      z.array(attachmentSchema).max(20).parse(attachments),
      idempotencyKeySchema.parse(idempotencyKey)
    );
  });

  handleRecoveryGated(desktopIpc.retryPrompt, async (_event, projectId: unknown, sessionId: unknown, targetMessageId: unknown, input: unknown, attachments: unknown, idempotencyKey: unknown) => {
    return await context.agents.retryPrompt(
      idSchema.parse(projectId),
      idSchema.parse(sessionId),
      idSchema.parse(targetMessageId),
      promptSchema.parse(input),
      z.array(attachmentSchema).max(20).parse(attachments),
      idempotencyKeySchema.parse(idempotencyKey)
    );
  });

  handleRecoveryGated(desktopIpc.switchMessageVersion, async (_event, projectId: unknown, sessionId: unknown, messageId: unknown, direction: unknown) => {
    return await context.agents.switchMessageVersion(
      idSchema.parse(projectId),
      idSchema.parse(sessionId),
      idSchema.parse(messageId),
      z.enum(["prev", "next"]).parse(direction)
    );
  });

  handle(desktopIpc.cancelRun, async (_event, projectId: unknown, runId: unknown) => {
    await context.agents.cancelRun(idSchema.parse(projectId), idSchema.parse(runId));
  });

  handleRecoveryGated(desktopIpc.runSlashCommand, async (_event, projectId: unknown, sessionId: unknown, command: unknown) => {
    return await context.agents.runSlashCommand(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId),
      z.string().trim().min(1).max(200).parse(command)
    );
  });

  handleRecoveryGated(desktopIpc.runInspectorCommand, async (_event, projectId: unknown, owner: unknown, kind: unknown, input: unknown, history: unknown) => {
    return await context.agents.runInspectorCommand(
      idSchema.parse(projectId),
      z.string().min(1).max(300).parse(owner),
      z.enum(["review", "side-chat"]).parse(kind),
      z.string().max(8_000).parse(input),
      z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(32_000) })).max(20).parse(history)
    );
  });

  handleRecoveryGated(desktopIpc.skillExpand, async (_event, projectId: unknown, input: unknown) => await context.agents.expandSkillCommand(
    idSchema.parse(projectId),
    z.string().min(1).max(200_000).parse(input)
  ));

  handleRecoveryGated(desktopIpc.resolvePermission, async (_event, projectId: unknown, requestId: unknown, result: unknown) => {
    await context.agents.resolvePermission(idSchema.parse(projectId), idSchema.parse(requestId), permissionResultSchema.parse(result));
  });

  handleRecoveryGated(desktopIpc.setPermissionMode, async (_event, projectId: unknown, mode: unknown) => {
    return await context.agents.setPermissionMode(idSchema.parse(projectId), permissionModeSchema.parse(mode));
  });

  handleRecoveryGated(desktopIpc.switchModel, async (_event, projectId: unknown, alias: unknown, thinking: unknown) => {
    return await context.agents.switchModel(idSchema.parse(projectId), idSchema.parse(alias), thinkingSchema.parse(thinking));
  });

  // 「设为默认」走即时 CAS 写，不进跨页草稿事务；写完复读一次权威快照返回给渲染层同步基线。
  handleRecoveryGated(desktopIpc.setDefaultModel, async (_event, projectId: unknown, alias: unknown, thinking: unknown, expectedConfigRevision: unknown, sessionId: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    await context.agents.setDefaultModelImmediate(
      parsedProjectId,
      idSchema.parse(alias),
      thinkingSchema.parse(thinking),
      z.string().parse(expectedConfigRevision)
    );
    return await settings.snapshot(parsedProjectId, sessionId === undefined ? undefined : idSchema.parse(sessionId));
  });

  handleRecoveryGated(desktopIpc.testModelConfiguration, async (_event, projectId: unknown, configuration: unknown) => {
    return await context.agents.testModelConfiguration(idSchema.parse(projectId), modelConfigurationSchema.parse(configuration));
  });

  handleRecoveryGated(desktopIpc.readModelApiKey, async (_event, projectId: unknown, providerAlias: unknown) => {
    return await context.agents.readModelApiKey(idSchema.parse(projectId), idSchema.parse(providerAlias));
  });

  handleRecoveryGated(desktopIpc.readWebSearchApiKey, async (_event, projectId: unknown, provider: unknown) => {
    return await context.agents.readWebSearchApiKey(idSchema.parse(projectId), z.enum(["anysearch", "google", "duckduckgo", "tavily", "brave"]).parse(provider));
  });

  handle(desktopIpc.fetchModelCatalog, async (_event, projectId: unknown, providerAlias: unknown, force: unknown) => {
    return await context.agents.fetchModelCatalog(idSchema.parse(projectId), idSchema.parse(providerAlias), force === true);
  });

  handle(desktopIpc.fetchModelCatalogCandidate, async (_event, projectId: unknown, configuration: unknown) => {
    return await context.agents.fetchModelCatalogCandidate(idSchema.parse(projectId), modelConfigurationSchema.parse(configuration));
  });

  handle(desktopIpc.startModelLogin, async (_event, projectId: unknown, provider: unknown) => {
    return await context.agents.startModelLogin(idSchema.parse(projectId), modelLoginProviderSchema.parse(provider));
  });

  handle(desktopIpc.cancelModelLogin, async (_event, projectId: unknown, provider: unknown, authRequestId: unknown) => {
    await context.agents.cancelModelLogin(idSchema.parse(projectId), modelLoginProviderSchema.parse(provider), idSchema.parse(authRequestId));
  });

  handleRecoveryGated(desktopIpc.compact, async (_event, projectId: unknown, hint: unknown) => {
    return await context.agents.compact(idSchema.parse(projectId), hint === undefined ? undefined : z.string().max(2_000).parse(hint));
  });

  handleRecoveryGated(desktopIpc.runtimeProjection, async (_event, projectId: unknown) => {
    return await context.agents.runtimeProjection(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.planProjection, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.planProjection(idSchema.parse(projectId), idSchema.parse(sessionId));
  });

  handle(desktopIpc.runtimeMutation, async (_event, projectId: unknown, operation: unknown, payload: unknown) => {
    const parsedOperation = runtimeMutationSchema.parse(operation);
    if (runtimeMutationStartsWork(parsedOperation)) await settings.assertRuntimeReady();
    return await context.agents.runtimeMutation(
      idSchema.parse(projectId),
      parsedOperation,
      runtimePayloadSchema.parse(payload) ?? {}
    );
  });

  handleRecoveryGated(desktopIpc.runtimeEvents, async (_event, projectId: unknown, afterSequence: unknown, limit: unknown) => {
    return await context.agents.runtimeEvents(
      idSchema.parse(projectId),
      afterSequence === undefined ? undefined : z.number().int().nonnegative().parse(afterSequence),
      limit === undefined ? undefined : z.number().int().min(1).max(1_000).parse(limit)
    );
  });

  handle(desktopIpc.openBrowser, async (_event, url: unknown) => {
    await context.browser.open(url === undefined ? undefined : externalUrlSchema.parse(url));
  });

  handle(desktopIpc.cookieJarStatus, async () => await context.browser.status());

  handle(desktopIpc.exportCookies, async () => {
    context.agents.assertNoRunningTasks("任务运行期间不能导出 Cookie。");
    return await context.browser.exportToFile(context.getWindow());
  });

  handle(desktopIpc.importCookies, async () => {
    context.agents.assertNoRunningTasks("任务运行期间不能导入 Cookie。");
    return await context.browser.importFromFile(context.getWindow());
  });

  handle(desktopIpc.clearCookies, async () => {
    context.agents.assertNoRunningTasks("任务运行期间不能清除 Cookie。");
    const options: MessageBoxOptions = {
      type: "warning",
      title: "清除 Cookie",
      message: "确定要清除全部 Cookie 吗？",
      detail: "浏览器窗口和 agent 工具都会退出所有已登录的网站。此操作无法撤销。",
      buttons: ["清除", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const window = context.getWindow();
    const confirmation = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return await context.browser.status();
    context.agents.assertNoRunningTasks("任务运行期间不能清除 Cookie。");
    return await context.browser.clear();
  });

  handleRecoveryGated(desktopIpc.personalizationOverview, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.personalizationOverview(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId)
    );
  });

  handleRecoveryGated(desktopIpc.saveChatPersonalization, async (_event, projectId: unknown, sessionId: unknown, input: unknown, expectedRevision: unknown) => {
    return await context.agents.saveChatPersonalization(
      idSchema.parse(projectId),
      idSchema.parse(sessionId),
      chatPersonalizationSchema.parse(input),
      configRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.memoryOverview, async (_event, projectId: unknown, filter: unknown) => {
    return await context.agents.memoryOverview(
      idSchema.parse(projectId),
      filter === undefined ? undefined : memoryOriginFilterSchema.parse(filter)
    );
  });

  handleRecoveryGated(desktopIpc.memoryStats, async (_event, projectId: unknown, filter: unknown) => {
    return await context.agents.memoryStats(
      idSchema.parse(projectId),
      filter === undefined ? undefined : memoryOriginFilterSchema.parse(filter)
    );
  });

  handleRecoveryGated(desktopIpc.memoryEntries, async (_event, projectId: unknown, filter: unknown, offset: unknown, limit: unknown, includeArchived: unknown) => {
    return await context.agents.memoryEntries(
      idSchema.parse(projectId),
      memoryOriginFilterSchema.parse(filter),
      typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : 0,
      typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : 20,
      includeArchived === true
    );
  });

  handleRecoveryGated(desktopIpc.saveMemorySettings, async (_event, projectId: unknown, input: unknown) => {
    return await context.agents.saveMemorySettings(idSchema.parse(projectId), memorySettingsInputSchema.parse(input));
  });

  handleRecoveryGated(desktopIpc.identityOverview, async (_event, projectId: unknown) => {
    return await context.agents.identityOverview(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.saveIdentityDocument, async (
    _event,
    projectId: unknown,
    document: unknown,
    content: unknown,
    expectedRevision: unknown,
    reason: unknown
  ) => {
    return await context.agents.saveIdentityDocument(
      idSchema.parse(projectId),
      identityDocumentSchema.parse(document),
      identityContentSchema.parse(content),
      z.number().int().nonnegative().parse(expectedRevision),
      identityReasonSchema.parse(reason)
    );
  });

  handle(desktopIpc.settingsSnapshot, async (_event, projectId: unknown, sessionId: unknown) => {
    return await settings.snapshot(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId)
    );
  });

  handle(desktopIpc.activitySnapshot, async () => context.activity.snapshot());

  handle(desktopIpc.activitySettings, async () => context.activity.settingsSnapshot());

  handle(desktopIpc.activityUpdateSettings, async (_event, patch: unknown, expectedConfigRevision: unknown) => (
    await context.activity.updateSettings(
      activitySettingsPatchSchema.parse(patch),
      configRevisionSchema.parse(expectedConfigRevision)
    )
  ));

  handle(desktopIpc.activityRequestPermission, async (_event, pane: unknown) => {
    const selected = systemSettingsPaneSchema.parse(pane) as DesktopSystemSettingsPane;
    if (selected === "accessibility" && process.platform === "darwin") {
      // TCC 要把授权归到真正的 Biny.app；不能让独立 sidecar 代替 Electron 主进程发起请求。
      systemPreferences.isTrustedAccessibilityClient(true);
      return;
    }
    await context.activity.requestPermission(selected);
  });

  handle(desktopIpc.activitySearch, async (_event, query: unknown, limit: unknown) => (
    await context.activity.search(activityQuerySchema.parse(query), activityLimitSchema.parse(limit))
  ));

  handle(desktopIpc.activitySessionDetail, async (_event, sessionId: unknown) => (
    await context.activity.sessionDetail(activitySessionIdSchema.parse(sessionId))
  ));

  handle(desktopIpc.activitySnapshotPreview, async (_event, snapshotId: unknown) => (
    await context.activity.snapshotPreview(activitySnapshotIdSchema.parse(snapshotId))
  ));

  handle(desktopIpc.activityReport, async (_event, date: unknown) => (
    await context.activity.buildReport(activityReportDateSchema.parse(date))
  ));

  handle(desktopIpc.dailyMemoryNote, async (_event, date: unknown) => {
    const dateLabel = resolveActivityReportRange(activityReportDateSchema.parse(date) ?? "today").label;
    return { dateKey: dateLabel, content: await readDailyMemoryNote(dateLabel) };
  });

  handleRecoveryGated(desktopIpc.activityClear, async () => {
    context.agents.assertNoRunningTasks("任务运行期间不能清除 Activity 数据。");
    return await context.activity.clear();
  });

  handle(desktopIpc.saveSettings, async (_event, projectId: unknown, input: unknown) => {
    const parsedInput = settingsSaveInputSchema.parse(input);
    if (settingsSaveRequiresIdleRuntime(parsedInput)) {
      context.agents.assertNoRunningTasks("任务运行期间不能保存设置。");
    }
    const result = await settings.save(idSchema.parse(projectId), parsedInput);
    if (result.status === "committed" && result.appliedFields.includes("activity")) {
      // 配置已经完成事务提交；Activity sidecar 的停启是派生刷新，不应阻塞保存响应。
      void context.activity.refresh().catch(() => undefined);
    }
    const preference = result.snapshot?.themePreference;
    if (preference !== undefined) {
      applyNativeThemePreference(preference);
      const window = context.getWindow();
      if (window && !window.isDestroyed()) {
        window.setBackgroundColor(themeBackgroundColor(preference));
      }
    }
    return result;
  });

  handle(desktopIpc.stageSettingsCredential, async (_event, secret: unknown, scope: unknown) => {
    return context.agents.stageSettingsCredential(
      z.string().min(1).max(16_000).parse(secret),
      settingsCredentialScopeSchema.parse(scope)
    );
  });

  handle(desktopIpc.completeModelLoginForSettings, async (
    _event,
    projectId: unknown,
    provider: unknown,
    authRequestId: unknown,
    pastedAuthorization: unknown
  ) => {
    return await context.agents.completeModelLoginForSettings(
      idSchema.parse(projectId),
      modelLoginProviderSchema.parse(provider),
      idSchema.parse(authRequestId),
      pastedAuthorization === undefined ? undefined : z.string().max(16_000).parse(pastedAuthorization)
    );
  });

  handle(desktopIpc.releaseSettingsCredentials, async (_event, handles: unknown) => {
    context.agents.releaseSettingsCredentials(z.array(z.string().uuid()).max(200).parse(handles));
  });

  handle(desktopIpc.settingsDraftState, async (_event, value: unknown) => {
    context.updateSettingsDraftState(settingsDraftStateSchema.parse(value));
  });

  handle(desktopIpc.settingsCloseResponse, async (_event, requestId: unknown, response: unknown) => {
    return context.resolveSettingsCloseRequest(
      idSchema.parse(requestId),
      settingsCloseResponseSchema.parse(response)
    );
  });

  handleRecoveryGated(desktopIpc.searchMemory, async (_event, projectId: unknown, filter: unknown, query: unknown, includeArchived: unknown) => {
    return await context.agents.searchMemory(
      idSchema.parse(projectId),
      memoryOriginFilterSchema.parse(filter),
      memoryQuerySchema.parse(query),
      includeArchived === true
    );
  });

  handleRecoveryGated(desktopIpc.addMemoryEntry, async (_event, projectId: unknown, input: unknown, expectedRevision: unknown) => {
    return await context.agents.addMemoryEntry(
      idSchema.parse(projectId),
      memoryEntryInputSchema.parse(input),
      memoryRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.updateMemoryEntry, async (_event, projectId: unknown, entryId: unknown, patch: unknown, expectedRevision: unknown) => {
    return await context.agents.updateMemoryEntry(
      idSchema.parse(projectId),
      memoryEntryIdSchema.parse(entryId),
      memoryEntryPatchSchema.parse(patch),
      memoryRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.runMemorySleep, async (_event, projectId: unknown) => {
    return await context.agents.runMemorySleep(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.memorySleepStatus, async (_event, projectId: unknown) => {
    return await context.agents.memorySleepStatus(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.memorySleepRuns, async (_event, projectId: unknown) => {
    return await context.agents.memorySleepRuns(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.previewMemorySleep, async (_event, projectId: unknown) => {
    return await context.agents.previewMemorySleep(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.cancelMemorySleep, async (_event, projectId: unknown) => {
    return await context.agents.cancelMemorySleep(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.archivedMemoryEntries, async (_event, projectId: unknown) => {
    return await context.agents.archivedMemoryEntries(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.archiveMemoryEntry, async (_event, projectId: unknown, entryId: unknown, archived: unknown, expectedRevision: unknown) => {
    return await context.agents.archiveMemoryEntry(idSchema.parse(projectId), memoryEntryIdSchema.parse(entryId), archived === true, memoryRevisionSchema.parse(expectedRevision));
  });

  handleRecoveryGated(desktopIpc.deleteMemoryEntry, async (_event, projectId: unknown, entryId: unknown, expectedRevision: unknown) => {
    return await context.agents.deleteMemoryEntry(
      idSchema.parse(projectId),
      memoryEntryIdSchema.parse(entryId),
      memoryRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.clearMemory, async (_event, projectId: unknown, filter: unknown, expectedRevision: unknown) => {
    return await context.agents.clearMemory(
      idSchema.parse(projectId),
      memoryOriginFilterSchema.parse(filter),
      memoryRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.memoryEmbeddingStatus, async (_event, projectId: unknown) => {
    return await context.agents.memoryEmbeddingStatus(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.downloadMemoryEmbeddingModel, async (_event, projectId: unknown, model: unknown) => {
    return await context.agents.downloadMemoryEmbeddingModel(
      idSchema.parse(projectId),
      localEmbeddingModelSchema.parse(model)
    );
  });

  handleRecoveryGated(desktopIpc.cancelMemoryEmbeddingDownload, async (_event, projectId: unknown, model: unknown) => {
    return await context.agents.cancelMemoryEmbeddingDownload(
      idSchema.parse(projectId),
      localEmbeddingModelSchema.parse(model)
    );
  });

  handleRecoveryGated(desktopIpc.deleteMemoryEmbeddingModel, async (_event, projectId: unknown, model: unknown) => {
    return await context.agents.deleteMemoryEmbeddingModel(
      idSchema.parse(projectId),
      localEmbeddingModelSchema.parse(model)
    );
  });

  handleRecoveryGated(desktopIpc.rebuildMemoryEmbeddingIndex, async (_event, projectId: unknown) => {
    return await context.agents.rebuildMemoryEmbeddingIndex(idSchema.parse(projectId));
  });

  handleRecoveryGated(desktopIpc.cancelMemoryEmbeddingRebuild, async (_event, projectId: unknown) => {
    return await context.agents.cancelMemoryEmbeddingRebuild(idSchema.parse(projectId));
  });

  handle(desktopIpc.saveAttachment, async (_event, projectId: unknown, name: unknown, mimeType: unknown, bytes: unknown) => {
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength > 50 * 1024 * 1024) throw new Error("Attachment is invalid or larger than 50 MB.");
    return await context.projects.saveAttachment(
      context.projects.requireProject(idSchema.parse(projectId)),
      z.string().min(1).max(240).parse(name),
      z.string().max(200).parse(mimeType),
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    );
  });

  handle(desktopIpc.readWorkspaceFile, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    return await context.projects.readWorkspaceFile(project, z.string().min(1).max(2_000).parse(relativePath));
  });

  handle(desktopIpc.readInlineImage, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    return await context.projects.readInlineImage(project, z.string().min(1).max(2_000).parse(relativePath));
  });

  handle(desktopIpc.listWorkspaceDirectory, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    return await context.projects.listWorkspaceDirectory(project, z.string().min(1).max(2_000).parse(relativePath));
  });

  handle(desktopIpc.openWorkspaceFile, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    const filePath = context.projects.workspaceFile(project, z.string().min(1).max(2_000).parse(relativePath));
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  });

  handle(desktopIpc.skillCatalog, async (_event, projectId: unknown) => await context.skills.snapshot(
    projectId === undefined ? undefined : skillProjectIdSchema.parse(projectId)
  ));

  handle(desktopIpc.skillSettings, async (_event, projectId: unknown) => await context.skills.settings(idSchema.parse(projectId)));
  handle(desktopIpc.recipeSuggestions, async (_event, projectId: unknown, sessionId: unknown) => await context.agents.recipeSuggestions(
    idSchema.parse(projectId),
    idSchema.parse(sessionId)
  ));
  handle(desktopIpc.recipeState, async (_event, projectId: unknown, sessionId: unknown, recipeId: unknown, state: unknown) => await context.agents.setRecipeState(
    idSchema.parse(projectId),
    idSchema.parse(sessionId),
    z.enum(["repeatable-doc-task", "mcp-pipeline", "thread-to-workflow"]).parse(recipeId),
    z.enum(["dismissed", "extracted"]).parse(state)
  ));

  handle(desktopIpc.skillSourceImport, async () => {
    const window = context.getWindow();
    const options: OpenDialogOptions = {
      title: "导入本地 Skill",
      buttonLabel: "导入 Skill",
      properties: ["openFile"],
      filters: [{ name: "Skill", extensions: ["md"] }]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return undefined;
    return await context.skills.importSource(result.filePaths[0]);
  });

  handle(desktopIpc.skillSourceInstall, async (_event, sourceId: unknown) => {
    await context.skills.installSource(skillIdSchema.parse(sourceId));
  });

  handle(desktopIpc.skillImportExisting, async (_event, skillIds: unknown) => {
    return await context.skills.importExistingSkills(skillImportIdsSchema.parse(skillIds));
  });

  handle(desktopIpc.skillDiscoverySnapshot, async () => await context.skills.skillDiscovery());

  handle(desktopIpc.skillDiscoverySearch, async (_event, query: unknown, limit: unknown, offset: unknown) => {
    return await context.skills.searchSkills(
      skillDiscoverySearchQuerySchema.parse(query),
      skillDiscoverySearchLimitSchema.parse(limit),
      skillDiscoverySearchOffsetSchema.parse(offset)
    );
  });

  handle(desktopIpc.skillDiscoveryInstall, async (_event, skill: unknown) => {
    return await context.skills.installDiscoveredSkill(discoverableSkillSchema.parse(skill));
  });

  handle(desktopIpc.skillRepositoryAdd, async (_event, repository: unknown) => {
    return await context.skills.addSkillRepository(skillRepositorySchema.parse(repository));
  });

  handle(desktopIpc.skillRepositoryRemove, async (_event, owner: unknown, name: unknown) => {
    return await context.skills.removeSkillRepository(skillRepositoryOwnerSchema.parse(owner), skillRepositoryNameSchema.parse(name));
  });

  handle(desktopIpc.skillFileRead, async (_event, skillId: unknown, relativePath: unknown) => {
    return await context.skills.readFile(skillIdSchema.parse(skillId), skillFilePathSchema.parse(relativePath));
  });

  handle(desktopIpc.skillCheck, async (_event, skillId: unknown) => await context.skills.check(skillIdSchema.parse(skillId)));
  handle(desktopIpc.skillVersion, async (_event, skillId: unknown) => await context.skills.version(skillIdSchema.parse(skillId)));
  handleRecoveryGated(desktopIpc.skillVersionUpdate, async (_event, skillId: unknown, expectedVersion: unknown) => {
    return await context.skills.updateVersion(skillIdSchema.parse(skillId), z.string().uuid().parse(expectedVersion));
  });
  handleRecoveryGated(desktopIpc.skillVersionRollback, async (_event, skillId: unknown, expectedVersion: unknown) => {
    return await context.skills.rollbackVersion(skillIdSchema.parse(skillId), z.string().uuid().parse(expectedVersion));
  });

  handle(desktopIpc.skillFileWrite, async (_event, skillId: unknown, relativePath: unknown, content: unknown) => {
    await context.skills.writeFile(
      skillIdSchema.parse(skillId),
      skillFilePathSchema.parse(relativePath),
      skillFileContentSchema.parse(content)
    );
  });

  handle(desktopIpc.skillOpenDirectory, async (_event, skillId: unknown) => {
    const error = await shell.openPath(await context.skills.directory(skillIdSchema.parse(skillId)));
    if (error) throw new Error(error);
  });

  handle(desktopIpc.pluginRegistry, async (_event, projectId: unknown) => await context.skills.pluginRegistry(idSchema.parse(projectId)));
  handle(desktopIpc.pluginRegistryRefresh, async (_event, projectId: unknown) => await context.skills.pluginRegistry(idSchema.parse(projectId), true));
  handleRecoveryGated(desktopIpc.pluginInstall, async (_event, projectId: unknown, pluginId: unknown, scope: unknown) => {
    context.agents.assertNoRunningTasks("任务运行期间不能安装 Plugin。");
    return await context.skills.installPlugin(idSchema.parse(projectId), idSchema.parse(pluginId), pluginScopeSchema.parse(scope));
  });
  handleRecoveryGated(desktopIpc.pluginSetEnabled, async (_event, projectId: unknown, pluginId: unknown, enabled: unknown, scope: unknown) => {
    context.agents.assertNoRunningTasks("任务运行期间不能切换 Plugin。");
    return await context.skills.setPluginEnabled(idSchema.parse(projectId), idSchema.parse(pluginId), z.boolean().parse(enabled), pluginScopeSchema.parse(scope));
  });
  handleRecoveryGated(desktopIpc.pluginUninstall, async (_event, projectId: unknown, pluginId: unknown, scope: unknown) => {
    context.agents.assertNoRunningTasks("任务运行期间不能卸载 Plugin。");
    await context.skills.uninstallPlugin(idSchema.parse(projectId), idSchema.parse(pluginId), pluginScopeSchema.parse(scope));
  });
  handle(desktopIpc.pluginOpenDirectory, async (_event, projectId: unknown, scope: unknown) => {
    const error = await shell.openPath(await context.skills.pluginDirectory(idSchema.parse(projectId), pluginScopeSchema.parse(scope)));
    if (error) throw new Error(error);
  });

  handle(desktopIpc.mcpSnapshot, async (_event, projectId: unknown) => {
    return await context.mcp.snapshot(mcpProjectIdSchema.parse(projectId));
  });

  handle(desktopIpc.mcpCatalog, async () => context.mcp.catalog());
  handle(desktopIpc.mcpRefreshCatalog, async () => await context.mcp.refreshCatalog());

  handleRecoveryGated(desktopIpc.mcpUpsertServer, async (_event, projectId: unknown, originalName: unknown, draft: unknown, expectedRevision: unknown) => {
    return await context.mcp.upsertServer(
      mcpProjectIdSchema.parse(projectId),
      originalName === undefined ? undefined : idSchema.parse(originalName),
      mcpDraftSchema.parse(draft),
      configRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.mcpSetEnabled, async (_event, projectId: unknown, name: unknown, enabled: unknown, expectedRevision: unknown) => {
    return await context.mcp.setEnabled(
      mcpProjectIdSchema.parse(projectId),
      idSchema.parse(name),
      z.boolean().parse(enabled),
      configRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.mcpDeleteServer, async (_event, projectId: unknown, name: unknown, expectedRevision: unknown) => {
    return await context.mcp.deleteServer(
      mcpProjectIdSchema.parse(projectId),
      idSchema.parse(name),
      configRevisionSchema.parse(expectedRevision)
    );
  });

  handleRecoveryGated(desktopIpc.mcpTestServer, async (_event, projectId: unknown, draft: unknown) => {
    return await context.mcp.testServer(mcpProjectIdSchema.parse(projectId), mcpDraftSchema.parse(draft));
  });

  handleRecoveryGated(desktopIpc.mcpReconnect, async (_event, projectId: unknown, name: unknown) => {
    return await context.mcp.reconnect(idSchema.parse(projectId), idSchema.parse(name));
  });

  handleRecoveryGated(desktopIpc.mcpDetails, async (_event, projectId: unknown, name: unknown) => {
    return await context.mcp.details(idSchema.parse(projectId), idSchema.parse(name));
  });

  handleRecoveryGated(desktopIpc.mcpLoginStart, async (_event, projectId: unknown, name: unknown) => {
    return await context.mcp.loginStart(mcpProjectIdSchema.parse(projectId), idSchema.parse(name));
  });
  handleRecoveryGated(desktopIpc.mcpLoginFinish, async (_event, projectId: unknown, name: unknown, id: unknown) => {
    return await context.mcp.loginFinish(mcpProjectIdSchema.parse(projectId), idSchema.parse(name), z.string().uuid().parse(id));
  });
  handle(desktopIpc.mcpLoginCancel, async (_event, id: unknown) => {
    await context.mcp.loginCancel(z.string().uuid().parse(id));
  });
  handleRecoveryGated(desktopIpc.mcpLogout, async (_event, projectId: unknown, name: unknown) => {
    return await context.mcp.logout(mcpProjectIdSchema.parse(projectId), idSchema.parse(name));
  });

  handle(desktopIpc.openExternal, async (_event, url: unknown) => {
    await shell.openExternal(externalUrlSchema.parse(url));
  });

  handle(desktopIpc.openSystemSettings, async (_event, pane: unknown) => {
    const selected = systemSettingsPaneSchema.parse(pane) as DesktopSystemSettingsPane;
    if (process.platform !== "darwin") return;
    const urls: Record<DesktopSystemSettingsPane, string> = {
      "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    };
    await shell.openExternal(urls[selected]);
  });

  handle(desktopIpc.setSidebarWidth, async (_event, width: unknown) => {
    await context.state.setSidebarWidth(z.number().finite().parse(width));
  });

  handle(desktopIpc.setFilePanelWidth, async (_event, width: unknown) => {
    await context.state.setFilePanelWidth(z.number().finite().parse(width));
  });

  handleRecoveryGated(desktopIpc.setThemePreference, async (_event, theme: unknown) => {
    const preference = themePreferenceSchema.parse(theme);
    await context.state.setThemePreference(preference);
    applyNativeThemePreference(preference);
    const window = context.getWindow();
    if (window && !window.isDestroyed()) {
      window.setBackgroundColor(themeBackgroundColor(preference));
    }
    return preference;
  });

  handleRecoveryGated(desktopIpc.setFontPreference, async (_event, font: unknown) => {
    const parsed = fontPreferenceSchema.parse(font);
    const preference = { family: parsed.family, size: clampFontSize(parsed.size) };
    await context.state.setFontPreference(preference);
    return preference;
  });

  // —— QuickChat 悬浮窗：显隐切换、前台上下文、点击穿透和偏好 ——
  // 窗口控制不走 recovery gate（设置恢复待处理时也应能收起小窗）。
  handle(desktopIpc.quickChatToggle, async () => await context.toggleQuickChat());

  handle(desktopIpc.quickChatHide, async () => {
    context.getQuickChatWindow()?.hide();
  });

  handle(desktopIpc.quickChatClose, async () => {
    context.getQuickChatWindow()?.close();
  });

  handle(desktopIpc.quickChatSettings, async () => context.state.quickChatSettings());

  handle(desktopIpc.setQuickChatSettings, async (_event, value: unknown) => {
    const settings: DesktopQuickChatSettings = quickChatSettingsSchema.parse(value);
    await context.state.setQuickChatSettings(settings);
    // 立即对现存窗口应用穿透/失焦隐藏；窗口未创建时下次创建读最新设置。
    context.getQuickChatWindow()?.applySettings(settings);
    return settings;
  });

  // 屏幕上下文是独立的按需查询链路，不读取 Activity 缓存、不触发截图采集。
  handle(desktopIpc.quickChatScreenContext, async () => context.quickChatContext.cachedContext());
  handle(desktopIpc.quickChatRecaptureContext, async () => await context.quickChatContext.recapture());
  handle(desktopIpc.quickChatTraverseApp, async (_event, pid: unknown) => {
    const parsedPid = z.number().int().positive().max(10_000_000).parse(pid);
    return await context.quickChatContext.traverseApp(parsedPid);
  });
  handle(desktopIpc.quickChatGetClickThrough, async () => context.getQuickChatWindow()?.isClickThrough() ?? context.state.quickChatSettings().clickThrough);
  handle(desktopIpc.quickChatSetClickThrough, async (_event, enabled: unknown) => {
    const parsed = z.boolean().parse(enabled);
    const window = context.ensureQuickChatWindow();
    window.setClickThrough(parsed);
    window.send(desktopIpc.quickChatClickThroughChanged, parsed);
    return parsed;
  });
}

function applyNativeThemePreference(preference: DesktopThemePreference): void {
  nativeTheme.themeSource = preference;
}

function themeBackgroundColor(preference: DesktopThemePreference): string {
  const dark = preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#1c1c1c" : "#ffffff";
}

/** 先移除同名 handler 再注册：重复注册会被 Electron 直接拒绝（开发期热重载会遇到）。 */
function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}
