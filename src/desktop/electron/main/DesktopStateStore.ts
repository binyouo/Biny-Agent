/**
 * 桌面端界面状态的持久化：项目列表、当前项目与会话、当前主界面、
 * 侧栏与面板宽度、主题偏好、窗口位置。
 *
 * 读取时逐字段校验并夹到合法范围，文件损坏则改名备份后回退默认值——界面状态不值得让应用
 * 起不来。写入串行化，避免高频改动（拖动侧栏等）互相覆盖。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "../../sidebarSizing.js";
import { clampStoredFilePanelWidth, DEFAULT_FILE_PANEL_WIDTH } from "../../filePanelSizing.js";
import { DEFAULT_FONT_PREFERENCE, normalizeFontPreference } from "../../fontPreference.js";
import { DEFAULT_APPEARANCE, appearancePreferenceSchema, normalizeAppearancePreference } from "../../../appearance/preferences.js";
import type { AppearancePreference } from "../../../appearance/types.js";
import type { DesktopActiveView, DesktopFontPreference, DesktopProject, DesktopQuickChatSettings, DesktopThemePreference } from "../../protocol.js";

export interface DesktopWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

interface PersistedDesktopState {
  version: 2;
  projects: DesktopProject[];
  activeProjectId?: string;
  selectedSessionIds: Record<string, string>;
  activeView: DesktopActiveView;
  sidebarWidth: number;
  filePanelWidth: number;
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
  appearancePreference: AppearancePreference;
  quickChat: DesktopQuickChatSettings;
  quickChatBounds?: DesktopWindowBounds;
  /** 只覆盖设置页偏好字段，供统一设置保存执行进程内 CAS。 */
  preferenceRevision: number;
  windowBounds?: DesktopWindowBounds;
}

/** 快速对话默认：注入屏幕上下文默认开，失焦自动隐藏与点击穿透默认关。 */
const DEFAULT_QUICKCHAT_SETTINGS: DesktopQuickChatSettings = {
  autoHideOnBlur: false,
  injectScreenContext: true,
  clickThrough: false
};

const defaultState: PersistedDesktopState = {
  version: 2,
  projects: [],
  activeProjectId: undefined,
  selectedSessionIds: {},
  activeView: "chat",
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  filePanelWidth: DEFAULT_FILE_PANEL_WIDTH,
  themePreference: "system",
  fontPreference: { ...DEFAULT_FONT_PREFERENCE },
  appearancePreference: structuredClone(DEFAULT_APPEARANCE),
  quickChat: { ...DEFAULT_QUICKCHAT_SETTINGS },
  quickChatBounds: undefined,
  preferenceRevision: 0,
  windowBounds: undefined
};

export class DesktopStateStore {
  private state: PersistedDesktopState = structuredClone(defaultState);
  private writeTail = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<PersistedDesktopState>;
      this.state = {
        version: 2,
        projects: Array.isArray(raw.projects) ? raw.projects.map((project) => ({ ...project, pinned: project.pinned === true })) : [],
        activeProjectId: typeof raw.activeProjectId === "string" ? raw.activeProjectId : undefined,
        selectedSessionIds: isRecord(raw.selectedSessionIds) ? stringRecord(raw.selectedSessionIds) : {},
        activeView: validActiveView(raw.activeView) ? raw.activeView : "chat",
        sidebarWidth: typeof raw.sidebarWidth === "number" ? clampSidebarWidth(raw.sidebarWidth) : DEFAULT_SIDEBAR_WIDTH,
        filePanelWidth: typeof raw.filePanelWidth === "number" ? clampStoredFilePanelWidth(raw.filePanelWidth) : DEFAULT_FILE_PANEL_WIDTH,
        themePreference: validThemePreference(raw.themePreference) ? raw.themePreference : "system",
        fontPreference: normalizeFontPreference(raw.fontPreference),
        appearancePreference: normalizeAppearancePreference(raw.appearancePreference),
        quickChat: normalizeQuickChatSettings(raw.quickChat),
        quickChatBounds: validWindowBounds(raw.quickChatBounds) ? raw.quickChatBounds : undefined,
        preferenceRevision: validPreferenceRevision(raw.preferenceRevision) ? raw.preferenceRevision : 0,
        windowBounds: validWindowBounds(raw.windowBounds) ? raw.windowBounds : undefined
      };
    } catch (error) {
      // 文件不存在是首次启动，保留默认状态即可。
      if (isNotFound(error)) return;
      // 解析失败则把坏文件留档（便于事后排查），然后从默认状态重新开始。
      const corruptPath = `${this.filePath}.corrupt-${String(Date.now())}`;
      await fs.rename(this.filePath, corruptPath).catch(() => undefined);
      this.state = structuredClone(defaultState);
    }
  }

  projects(): DesktopProject[] {
    return this.state.projects.map((project) => ({ ...project }));
  }

  project(projectId: string): DesktopProject | undefined {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    return project ? { ...project } : undefined;
  }

  async upsertProject(project: DesktopProject): Promise<void> {
    const index = this.state.projects.findIndex((candidate) => candidate.id === project.id);
    if (index === -1) this.state.projects.push({ ...project });
    else this.state.projects[index] = { ...project };
    await this.save();
  }

  async removeProject(projectId: string): Promise<void> {
    this.state.projects = this.state.projects.filter((project) => project.id !== projectId);
    delete this.state.selectedSessionIds[projectId];
    if (this.state.activeProjectId === projectId) this.state.activeProjectId = this.state.projects.at(0)?.id;
    await this.save();
  }

  activeProjectId(): string | undefined {
    return this.state.activeProjectId;
  }

  async setActiveProject(projectId: string | undefined): Promise<void> {
    this.state.activeProjectId = projectId;
    await this.save();
  }

  /** Renderer 确认导航成功后，一次提交当前项目、该项目的会话选择和主界面。 */
  async commitSelection(projectId: string, sessionId: string | undefined, activeView: DesktopActiveView): Promise<void> {
    if (!this.state.projects.some((project) => project.id === projectId)) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    this.state.activeProjectId = projectId;
    if (sessionId === undefined) delete this.state.selectedSessionIds[projectId];
    else this.state.selectedSessionIds[projectId] = sessionId;
    this.state.activeView = activeView;
    await this.save();
  }

  activeView(): DesktopActiveView {
    return this.state.activeView;
  }

  async setActiveView(activeView: DesktopActiveView): Promise<void> {
    this.state.activeView = activeView;
    await this.save();
  }

  async setProjectPinned(projectId: string, pinned: boolean): Promise<void> {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    project.pinned = pinned;
    await this.save();
  }

  async reorderProjects(projectIds: string[]): Promise<void> {
    const byId = new Map(this.state.projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const ordered: DesktopProject[] = [];
    for (const projectId of projectIds) {
      const project = byId.get(projectId);
      if (!project || seen.has(projectId)) continue;
      ordered.push(project);
      seen.add(projectId);
    }
    for (const project of this.state.projects) {
      if (!seen.has(project.id)) ordered.push(project);
    }
    this.state.projects = ordered;
    await this.save();
  }

  async setProjectName(projectId: string, name: string): Promise<void> {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    project.name = name;
    await this.save();
  }

  selectedSessionId(projectId: string): string | undefined {
    return this.state.selectedSessionIds[projectId];
  }

  async setSelectedSession(projectId: string, sessionId: string | undefined): Promise<void> {
    if (sessionId === undefined) delete this.state.selectedSessionIds[projectId];
    else this.state.selectedSessionIds[projectId] = sessionId;
    await this.save();
  }

  sidebarWidth(): number {
    return this.state.sidebarWidth;
  }

  async setSidebarWidth(width: number): Promise<void> {
    this.state.sidebarWidth = clampSidebarWidth(width);
    await this.save();
  }

  filePanelWidth(): number {
    return this.state.filePanelWidth;
  }

  async setFilePanelWidth(width: number): Promise<void> {
    this.state.filePanelWidth = clampStoredFilePanelWidth(width);
    await this.save();
  }

  themePreference(): DesktopThemePreference {
    return this.state.themePreference;
  }

  async setThemePreference(theme: DesktopThemePreference): Promise<void> {
    await this.applySettingsPreferences({ themePreference: theme }, this.state.preferenceRevision);
  }

  fontPreference(): DesktopFontPreference {
    return { ...this.state.fontPreference };
  }

  appearancePreference(): AppearancePreference {
    return structuredClone(this.state.appearancePreference);
  }

  async setAppearancePreference(preference: AppearancePreference): Promise<void> {
    await this.applySettingsPreferences({ appearancePreference: preference }, this.state.preferenceRevision);
  }

  async setFontPreference(font: DesktopFontPreference): Promise<void> {
    await this.applySettingsPreferences({ fontPreference: font }, this.state.preferenceRevision);
  }

  quickChatSettings(): DesktopQuickChatSettings {
    return { ...this.state.quickChat };
  }

  /** QuickChat 偏好是纯 UI 开关，逐字段直达落盘，不走设置事务的 CAS/revision。 */
  async setQuickChatSettings(settings: DesktopQuickChatSettings): Promise<void> {
    this.state.quickChat = normalizeQuickChatSettings(settings);
    await this.save();
  }

  quickChatBounds(): DesktopWindowBounds | undefined {
    return this.state.quickChatBounds ? { ...this.state.quickChatBounds } : undefined;
  }

  async setQuickChatBounds(bounds: DesktopWindowBounds): Promise<void> {
    this.state.quickChatBounds = { ...bounds };
    await this.save();
  }

  settingsPreferences(): DesktopPreferenceSnapshot {
    return {
      revision: this.state.preferenceRevision,
      themePreference: this.state.themePreference,
      fontPreference: { ...this.state.fontPreference },
      appearancePreference: this.appearancePreference()
    };
  }

  /** 设置事务只通过此入口改主题/字体；revision 不匹配时保证零写入。 */
  async applySettingsPreferences(
    patch: DesktopPreferencePatch,
    expectedRevision: number
  ): Promise<DesktopPreferenceSnapshot> {
    if (this.state.preferenceRevision !== expectedRevision) {
      throw new DesktopPreferenceRevisionConflictError(expectedRevision, this.state.preferenceRevision);
    }
    const themePreference = patch.themePreference ?? this.state.themePreference;
    const fontPreference = patch.fontPreference === undefined
      ? this.state.fontPreference
      : normalizeFontPreference(patch.fontPreference);
    const appearancePreference = patch.appearancePreference === undefined
      ? this.state.appearancePreference
      : appearancePreferenceSchema.parse(patch.appearancePreference) as AppearancePreference;
    if (themePreference === this.state.themePreference && sameFont(fontPreference, this.state.fontPreference)
      && JSON.stringify(appearancePreference) === JSON.stringify(this.state.appearancePreference)) {
      return this.settingsPreferences();
    }
    const previous = this.settingsPreferences();
    this.state.themePreference = themePreference;
    this.state.fontPreference = { ...fontPreference };
    this.state.appearancePreference = structuredClone(appearancePreference);
    this.state.preferenceRevision += 1;
    try {
      await this.save();
      return this.settingsPreferences();
    } catch (error) {
      if (this.state.preferenceRevision === previous.revision + 1) {
        this.state.themePreference = previous.themePreference;
        this.state.fontPreference = { ...previous.fontPreference };
        this.state.appearancePreference = structuredClone(previous.appearancePreference);
        this.state.preferenceRevision = previous.revision;
      }
      throw error;
    }
  }

  /** 补偿也推进 revision，避免回滚后旧 Renderer 草稿重新变成可提交状态。 */
  async restoreSettingsPreferences(
    snapshot: DesktopPreferenceSnapshot,
    expectedRevision: number
  ): Promise<DesktopPreferenceSnapshot> {
    return await this.applySettingsPreferences({
      themePreference: snapshot.themePreference,
      fontPreference: snapshot.fontPreference,
      appearancePreference: normalizeAppearancePreference(snapshot.appearancePreference)
    }, expectedRevision);
  }

  settingsTransactionJournalPath(): string {
    return `${this.filePath}.settings-journal.json`;
  }

  windowBounds(): DesktopWindowBounds | undefined {
    return this.state.windowBounds ? { ...this.state.windowBounds } : undefined;
  }

  async setWindowBounds(bounds: DesktopWindowBounds): Promise<void> {
    this.state.windowBounds = { ...bounds };
    await this.save();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const run = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, `${snapshot}\n`, "utf8");
      await fs.rename(temporaryPath, this.filePath);
    });
    this.writeTail = run.catch(() => undefined);
    return run;
  }
}

export interface DesktopPreferenceSnapshot {
  revision: number;
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
  appearancePreference: AppearancePreference;
}

export interface DesktopPreferencePatch {
  themePreference?: DesktopThemePreference;
  fontPreference?: DesktopFontPreference;
  appearancePreference?: AppearancePreference;
}

export class DesktopPreferenceRevisionConflictError extends Error {
  readonly name = "DesktopPreferenceRevisionConflictError";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Desktop preference revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}.`);
  }
}

function validPreferenceRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sameFont(left: DesktopFontPreference, right: DesktopFontPreference): boolean {
  return left.family === right.family && left.size === right.size;
}

/** 逐字段归一化：任一字段缺失/类型不对都回退到该项默认，旧版本状态文件没有 quickChat 时整体回默认。 */
function normalizeQuickChatSettings(value: unknown): DesktopQuickChatSettings {
  if (!isRecord(value)) return { ...DEFAULT_QUICKCHAT_SETTINGS };
  return {
    autoHideOnBlur: typeof value.autoHideOnBlur === "boolean" ? value.autoHideOnBlur : DEFAULT_QUICKCHAT_SETTINGS.autoHideOnBlur,
    injectScreenContext: typeof value.injectScreenContext === "boolean" ? value.injectScreenContext : DEFAULT_QUICKCHAT_SETTINGS.injectScreenContext,
    clickThrough: typeof value.clickThrough === "boolean" ? value.clickThrough : DEFAULT_QUICKCHAT_SETTINGS.clickThrough
  };
}

function validThemePreference(value: unknown): value is DesktopThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function validActiveView(value: unknown): value is DesktopActiveView {
  return value === "chat" || value === "runtime" || value === "extensions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function validWindowBounds(value: unknown): value is DesktopWindowBounds {
  if (!isRecord(value)) return false;
  return typeof value.width === "number" && typeof value.height === "number";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
