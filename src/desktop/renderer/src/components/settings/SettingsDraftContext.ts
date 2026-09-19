/** 设置草稿 Provider 与各分页共享的纯上下文契约。 */
import { createContext, useContext } from "react";
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
  dirtyCount: number;
  preferencesOnly: boolean;
  invalid: boolean;
  saveState: SettingsSaveState;
  setThemePreference(value: DesktopThemePreference): void;
  setFontPreference(value: DesktopFontPreference): void;
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
  /**
   * 只提交 models 段的即时保存（复刻「零保存按钮」的服务商配置体验）。入参是完整的
   * models 段（草稿待提交项 + 本次变更），提交成功后 models 草稿清零，其余分页草稿不动。
   */
  saveModels(models: DesktopSettingsModelsInput): Promise<DesktopSettingsSaveResult | undefined>;
  setModelProfile(providerAlias: string, modelId: string, profile: ModelProfile | undefined): void;
  stageCredential(secret: string, scope: DesktopSettingsCredentialScope): Promise<DesktopStagedSettingsCredential>;
  addOauthCredentialHandle(handle: string): void;
  releaseCredential(handle: string): Promise<void>;
  discard(): Promise<void>;
  saveAll(): Promise<DesktopSettingsSaveResult | undefined>;
}

export const SettingsDraftContext = createContext<SettingsDraftContextValue | undefined>(undefined);

export function useSettingsDraft(): SettingsDraftContextValue {
  const value = useContext(SettingsDraftContext);
  if (!value) throw new Error("useSettingsDraft must be used inside SettingsDraftProvider.");
  return value;
}
