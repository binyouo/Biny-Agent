/** 设置草稿 Provider 与各分页共享的纯上下文契约。 */
import { createContext, useContext } from "react";
import type { AppearancePreference } from "../../../../../appearance/types.js";
import type { ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type { ModelProfile } from "../../../../../config/schema.js";
import type {
  DesktopChatParamsSettings,
  DesktopChatPersonalizationOverride,
  DesktopCompactionSettings,
  DesktopActivitySettingsInput,
  DesktopActivitySettingsPatch,
  DesktopFontPreference,
  DesktopIdentitySettings,
  DesktopMemorySettings,
  DesktopModelConfigurationInput,
  DesktopSettingsModelsInput,
  DesktopPermissionSettings,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot,
  DesktopSettingsCredentialScope,
  DesktopSkillSettingsInput,
  DesktopStagedSettingsCredential,
  DesktopThemePreference,
  DesktopWebSearchSettingsInput
} from "../../../../protocol.js";

export type SettingsSaveState = "clean" | "dirty" | "invalid" | "saving" | "rolling_back" | "recovery_required";

export interface SettingsModelDraft {
  upserts: DesktopModelConfigurationInput[];
  removeAliases: string[];
  defaultModel?: { alias: string; thinking: ThinkingSelection };
  oauthCredentialHandles: string[];
  modelProfiles: Record<string, Record<string, ModelProfile>>;
}

export interface DesktopSettingsDraft {
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
  appearancePreference: AppearancePreference;
  activity: DesktopActivitySettingsInput;
  identity: DesktopIdentitySettings;
  memory: DesktopMemorySettings;
  compaction: DesktopCompactionSettings;
  chatParams: DesktopChatParamsSettings;
  permission: DesktopPermissionSettings;
  webSearch: DesktopWebSearchSettingsInput;
  chat?: DesktopChatPersonalizationOverride;
  models: SettingsModelDraft;
  skills: DesktopSkillSettingsInput;
}

export interface SettingsDraftContextValue {
  snapshot?: DesktopSettingsSnapshot;
  draft?: DesktopSettingsDraft;
  /** Activity 是全局即时配置，无项目时也可读取和更新。 */
  activity?: DesktopActivitySettingsInput;
  loadError?: string;
  loading: boolean;
  /**
   * 为真表示当前渲染的是上一次读取的缓存快照，后台仍在重新校验。
   * 用于"壳先出"：不要因为这次刷新还没回来就把整个设置页遮住。
   */
  revalidating: boolean;
  retryLoad(): void;
  saveError?: string;
  dirtyCount: number;
  preferencesOnly: boolean;
  invalid: boolean;
  saveState: SettingsSaveState;
  pendingModelEdits?: boolean;
  reportModelEditState?(pending: boolean): void;
  setThemePreference(value: DesktopThemePreference): void;
  setFontPreference(value: DesktopFontPreference): void;
  setAppearancePreference(value: AppearancePreference): Promise<boolean>;
  updateActivityImmediately(patch: DesktopActivitySettingsPatch): Promise<void>;
  setIdentity(value: DesktopIdentitySettings): void;
  setMemory(value: DesktopMemorySettings): void;
  setCompaction(value: DesktopCompactionSettings): void;
  setChatParams(value: DesktopChatParamsSettings): void;
  setPermission(value: DesktopPermissionSettings): void;
  setWebSearch(value: DesktopWebSearchSettingsInput): void;
  setChat(value: DesktopChatPersonalizationOverride): void;
  setSkills(value: DesktopSkillSettingsInput): void;
  upsertModel(value: DesktopModelConfigurationInput): void;
  removeModel(alias: string): void;
  /** 即时保存只提交本次模型变更；计算型更新在队列执行时读取最新快照。 */
  saveModels(models: DesktopSettingsModelsInput | ((snapshot: DesktopSettingsSnapshot) => DesktopSettingsModelsInput)): Promise<DesktopSettingsSaveResult | undefined>;
  registerModelEditor?(flush: () => Promise<boolean>): () => void;
  flushModelEdits?(): Promise<boolean>;
  setModelProfile(providerAlias: string, modelId: string, profile: ModelProfile | undefined): void;
  stageCredential(secret: string, scope: DesktopSettingsCredentialScope): Promise<DesktopStagedSettingsCredential>;
  addOauthCredentialHandle(handle: string): void;
  releaseCredential(handle: string): Promise<void>;
  discard(): Promise<void>;
  saveAll(): Promise<DesktopSettingsSaveResult | undefined>;
}

export const SettingsDraftContext = createContext<SettingsDraftContextValue | undefined>(undefined);

/**
 * 打开设置时能否复用上一次读到的快照。
 *
 * 可以复用 → 先拿缓存把界面渲染出来，后台再静默校验一次；
 * 不可以复用 → 老老实实显示加载态（首次打开、切了项目、用户主动重试后）。
 *
 * 抽成纯函数是为了能直接测：这个判断错了会让用户看到别的项目的设置。
 */
export function canReuseSettingsSnapshot(input: {
  cachedKey: string | undefined;
  currentKey: string;
  loadAttempt: number;
  lastLoadAttempt: number;
  hasSnapshot: boolean;
}): boolean {
  return input.cachedKey !== undefined
    && input.cachedKey === input.currentKey
    && input.loadAttempt === input.lastLoadAttempt
    && input.hasSnapshot;
}

export function useSettingsDraft(): SettingsDraftContextValue {
  const value = useContext(SettingsDraftContext);
  if (!value) throw new Error("useSettingsDraft must be used inside SettingsDraftProvider.");
  return value;
}
