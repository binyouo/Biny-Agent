/**
 * 设置中心的跨分页草稿。
 *
 * 打开时只读取一次脱敏快照；普通分页改这里的内存状态。主题和字体通过 preview 回调即时
 * 预览，Activity 则通过独立 CAS 通道即时落盘，其余设置仍由 saveAll 进入主进程事务。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ModelProfile } from "../../../../../config/schema.js";
import type {
  DesktopActivitySettingsInput,
  DesktopActivitySettingsPatch,
  DesktopActivitySettingsUpdate,
  DesktopChatParamsSettings,
  DesktopChatPersonalizationOverride,
  DesktopCompactionSettings,
  DesktopFontPreference,
  DesktopIdentitySettings,
  DesktopMemorySettings,
  DesktopModelConfigurationInput,
  DesktopPermissionSettings,
  DesktopSettingsModelsInput,
  DesktopSettingsSaveInput,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot,
  DesktopSettingsCredentialScope,
  DesktopSkillSettingsInput,
  DesktopStagedSettingsCredential,
  DesktopThemePreference,
  DesktopWebSearchSettings,
  DesktopWebSearchSettingsInput
} from "../../../../protocol.js";
import { SettingsDraftContext, type DesktopSettingsDraft, type SettingsDraftContextValue, type SettingsSaveState } from "./SettingsDraftContext.js";

export function SettingsDraftProvider({
  active,
  children,
  onCommitted,
  onFontPreview,
  onNotify,
  onThemePreview,
  projectId,
  sessionId,
  sessionRunning
}: {
  active: boolean;
  children: React.ReactNode;
  onCommitted(snapshot: DesktopSettingsSnapshot): void;
  onFontPreview(value: DesktopFontPreference): void;
  onNotify(message: string): void;
  onThemePreview(value: DesktopThemePreference): void;
  projectId?: string;
  sessionId?: string;
  sessionRunning: boolean;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot>();
  const [draft, setDraft] = useState<DesktopSettingsDraft>();
  const [globalActivity, setGlobalActivity] = useState<DesktopActivitySettingsUpdate>();
  const globalActivityRef = useRef<DesktopActivitySettingsUpdate | undefined>(undefined);
  const [loadError, setLoadError] = useState<string>();
  const [saveState, setSaveState] = useState<SettingsSaveState>("clean");
  const credentialHandlesRef = useRef(new Set<string>());
  const snapshotRef = useRef<DesktopSettingsSnapshot | undefined>(undefined);
  const activityUpdateTailRef = useRef(Promise.resolve());

  const adoptSnapshot = useCallback((next: DesktopSettingsSnapshot): void => {
    snapshotRef.current = next;
    setSnapshot(next);
    setDraft(draftFromSnapshot(next));
    setSaveState(next.pendingRecovery ? "recovery_required" : "clean");
    onThemePreview(next.themePreference);
    onFontPreview(next.fontPreference);
  }, [onFontPreview, onThemePreview]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setSnapshot(undefined);
    snapshotRef.current = undefined;
    setDraft(undefined);
    setGlobalActivity(undefined);
    globalActivityRef.current = undefined;
    setLoadError(undefined);
    setSaveState("clean");
    // 没有项目时只读取全局 Activity 快照，不伪造项目 ID，也不加载项目模型或会话。
    const request = projectId
      ? window.biny.settingsSnapshot(projectId, sessionId).then((next) => { if (!cancelled) adoptSnapshot(next); })
      : window.biny.activitySettings().then((next) => {
        if (cancelled) return;
        globalActivityRef.current = next;
        setGlobalActivity(next);
      });
    request
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [active, adoptSnapshot, projectId, sessionId]);

  const setThemePreference = useCallback((value: DesktopThemePreference): void => {
    setDraft((current) => current ? { ...current, themePreference: value } : current);
    onThemePreview(value);
  }, [onThemePreview]);

  const setFontPreference = useCallback((value: DesktopFontPreference): void => {
    setDraft((current) => current ? { ...current, fontPreference: value } : current);
    onFontPreview(value);
  }, [onFontPreview]);


  const updateActivityImmediately = useCallback((patch: DesktopActivitySettingsPatch): Promise<void> => {
    const operation = activityUpdateTailRef.current.then(async () => {
      const current = snapshotRef.current ?? globalActivityRef.current;
      if (!current) throw new Error("Activity 设置尚未加载完成。");
      const result = await window.biny.updateActivitySettings(patch, current.configRevision);
      const projectSnapshot = snapshotRef.current;
      if (projectSnapshot && projectSnapshot === current) {
        const nextSnapshot = { ...projectSnapshot, ...result };
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
      } else if (globalActivityRef.current === current) {
        globalActivityRef.current = result;
        setGlobalActivity(result);
      } else return;
      setDraft((draftCurrent) => draftCurrent ? {
        ...draftCurrent,
        activity: activityInputFromSnapshot(result.activity)
      } : draftCurrent);
    });
    activityUpdateTailRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, []);

  const setIdentity = useCallback((value: DesktopIdentitySettings): void => {
    setDraft((current) => current ? { ...current, identity: value } : current);
  }, []);

  const setMemory = useCallback((value: DesktopMemorySettings): void => {
    setDraft((current) => current ? { ...current, memory: value } : current);
  }, []);

  const setCompaction = useCallback((value: DesktopCompactionSettings): void => {
    setDraft((current) => current ? { ...current, compaction: value } : current);
  }, []);

  const setChatParams = useCallback((value: DesktopChatParamsSettings): void => {
    setDraft((current) => current ? { ...current, chatParams: value } : current);
  }, []);

  const setPermission = useCallback((value: DesktopPermissionSettings): void => {
    setDraft((current) => current ? { ...current, permission: value } : current);
  }, []);

  const setWebSearch = useCallback((value: DesktopWebSearchSettingsInput): void => {
    setDraft((current) => current ? { ...current, webSearch: value } : current);
  }, []);

  const setChat = useCallback((value: DesktopChatPersonalizationOverride): void => {
    setDraft((current) => current ? { ...current, chat: value } : current);
  }, []);

  const setSkills = useCallback((value: DesktopSkillSettingsInput): void => {
    setDraft((current) => current ? { ...current, skills: value } : current);
  }, []);

  const upsertModel = useCallback((value: DesktopModelConfigurationInput): void => {
    setDraft((current) => {
      if (!current) return current;
      const upserts = [...current.models.upserts.filter((item) => item.alias !== value.alias), value];
      const defaultModel = value.makeDefault
        ? { alias: value.alias, thinking: "off" as const }
        : current.models.defaultModel;
      return {
        ...current,
        models: {
          ...current.models,
          upserts,
          removeAliases: current.models.removeAliases.filter((alias) => alias !== value.alias),
          defaultModel
        }
      };
    });
  }, []);

  const removeModel = useCallback((alias: string): void => {
    setDraft((current) => {
      if (!current) return current;
      const hadPendingUpsert = current.models.upserts.some((item) => item.alias === alias);
      return {
        ...current,
        models: {
          ...current.models,
          upserts: current.models.upserts.filter((item) => item.alias !== alias),
          removeAliases: hadPendingUpsert || current.models.removeAliases.includes(alias)
            ? current.models.removeAliases
            : [...current.models.removeAliases, alias],
          defaultModel: current.models.defaultModel?.alias === alias ? undefined : current.models.defaultModel
        }
      };
    });
  }, []);

  const setModelProfile = useCallback((providerAlias: string, modelId: string, profile: ModelProfile | undefined): void => {
    setDraft((current) => {
      if (!current) return current;
      const providerProfiles = { ...(current.models.modelProfiles[providerAlias] ?? {}) };
      if (profile === undefined) delete providerProfiles[modelId];
      else providerProfiles[modelId] = profile;
      const modelProfiles = { ...current.models.modelProfiles };
      // 空对象是「清空该连接全部 profile」的显式值；如果删掉 provider 键，后端会按
      // 未列出的 provider 保持现状，最后一个 profile 就无法真正删除。
      modelProfiles[providerAlias] = providerProfiles;
      return {
        ...current,
        models: { ...current.models, modelProfiles }
      };
    });
  }, []);

  const stageCredential = useCallback(async (secret: string, scope: DesktopSettingsCredentialScope): Promise<DesktopStagedSettingsCredential> => {
    const staged = await window.biny.stageSettingsCredential(secret, scope);
    credentialHandlesRef.current.add(staged.handle);
    return staged;
  }, []);

  const addOauthCredentialHandle = useCallback((handle: string): void => {
    credentialHandlesRef.current.add(handle);
    setDraft((current) => !current || current.models.oauthCredentialHandles.includes(handle) ? current : {
      ...current,
      models: {
        ...current.models,
        oauthCredentialHandles: [...current.models.oauthCredentialHandles, handle]
      }
    });
  }, []);

  const releaseCredential = useCallback(async (handle: string): Promise<void> => {
    credentialHandlesRef.current.delete(handle);
    setDraft((current) => current ? {
      ...current,
      models: {
        ...current.models,
        oauthCredentialHandles: current.models.oauthCredentialHandles.filter((candidate) => candidate !== handle)
      }
    } : current);
    await window.biny.releaseSettingsCredentials([handle]);
  }, []);

  const dirtyCount = snapshot && draft ? countDirtyFields(snapshot, draft) : 0;
  const nonPreferenceDirtyCount = snapshot && draft ? countNonPreferenceDirtyFields(snapshot, draft) : 0;
  // 主题和字体只影响 DesktopStateStore，不会改变运行中的 Agent 配置。
  const preferencesOnly = dirtyCount > 0 && nonPreferenceDirtyCount === 0;
  const invalid = draft ? !validDraft(draft) : false;
  const runtimeBusy = sessionRunning || snapshot?.hasRunningTasks === true;
  const runtimeBlocked = runtimeBusy && !preferencesOnly;
  const canSave = active
    && dirtyCount > 0
    && draft !== undefined
    && !runtimeBlocked
    && !invalid
    && saveState !== "saving"
    && saveState !== "rolling_back"
    && saveState !== "recovery_required";

  useLayoutEffect(() => {
    void window.biny.updateSettingsDraftState({
      dirty: dirtyCount > 0,
      canSave,
      open: active
    }).catch(() => undefined);
  }, [active, canSave, dirtyCount]);

  useEffect(() => {
    if (saveState === "saving" || saveState === "rolling_back" || saveState === "recovery_required") return;
    setSaveState(invalid ? "invalid" : dirtyCount > 0 ? "dirty" : "clean");
  }, [dirtyCount, invalid, saveState]);

  const releaseAllCredentials = useCallback(async (): Promise<void> => {
    const handles = [...credentialHandlesRef.current];
    credentialHandlesRef.current.clear();
    if (handles.length) await window.biny.releaseSettingsCredentials(handles);
  }, []);

  useEffect(() => () => {
    // 窗口被系统关闭或渲染进程卸载时也释放尚未提交的安全句柄；已提交句柄会先从集合清除。
    void releaseAllCredentials();
    // Provider 已卸载后草稿已不存在；同步清除主进程的关闭握手投影，避免留下幽灵 dirty 状态。
    void window.biny.updateSettingsDraftState({ dirty: false, canSave: false, open: false }).catch(() => undefined);
  }, [releaseAllCredentials]);

  const discard = useCallback(async (): Promise<void> => {
    await releaseAllCredentials();
    if (snapshot) adoptSnapshot(snapshot);
    await window.biny.updateSettingsDraftState({ dirty: false, canSave: false, open: active }).catch(() => undefined);
  }, [active, adoptSnapshot, releaseAllCredentials, snapshot]);

  // 模型页的即时保存串行化：连续动作（连接、开关模型、改密钥）各自带着「当前草稿 +
  // 本次变更」的完整 models 段进入同一互斥队列，后一笔基于前一笔提交后的快照继续。
  const modelsSaveTailRef = useRef<Promise<unknown>>(Promise.resolve());

  const saveModels = useCallback(async (models: DesktopSettingsModelsInput): Promise<DesktopSettingsSaveResult | undefined> => {
    const base = snapshotRef.current;
    if (!base) throw new Error("设置尚未加载完成。");
    if (saveState === "recovery_required") {
      onNotify("存在未恢复的保存事务，请先处理再修改模型配置。");
      return undefined;
    }
    const operation = modelsSaveTailRef.current.then(async (): Promise<DesktopSettingsSaveResult | undefined> => {
      // 队列执行时取最新基线：前一笔即时保存可能已经推进了 configRevision。
      const snapshotNow = snapshotRef.current;
      if (!snapshotNow) throw new Error("设置尚未加载完成。");
      const result = await window.biny.saveSettings(snapshotNow.projectId, {
        expectedPreferenceRevision: snapshotNow.preferenceRevision,
        expectedConfigRevision: snapshotNow.configRevision,
        models
      });
      if (result.status === "committed") {
        // 模型变更可能同时改变后端派生的默认设置。未编辑字段跟随新快照，
        // 只有真正偏离旧基线的字段才保留，避免旧默认值造成幽灵 dirty 状态。
        snapshotRef.current = result.snapshot;
        setSnapshot(result.snapshot);
        setSaveState(result.snapshot.pendingRecovery ? "recovery_required" : "clean");
        setDraft((current) => current ? {
          ...rebaseUneditedFields(current, snapshotNow, result.snapshot),
          models: {
            upserts: [],
            removeAliases: [],
            defaultModel: undefined,
            oauthCredentialHandles: current.models.oauthCredentialHandles.filter((handle) => !models.oauthCredentialHandles?.includes(handle)),
            modelProfiles: structuredClone(result.snapshot.models.modelProfiles ?? {})
          }
        } : current);
        onCommitted(result.snapshot);
      } else if (result.status === "rolled_back") {
        setSnapshot(result.snapshot);
        snapshotRef.current = result.snapshot;
        setSaveState("dirty");
        onNotify(result.message ?? (result.conflicts?.length ? "模型设置已在其他位置更改，请重试" : "模型设置保存失败，已恢复原设置"));
      } else {
        setSaveState("recovery_required");
        onNotify(result.message);
      }
      return result;
    });
    modelsSaveTailRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [onCommitted, onNotify, saveState]);

  const saveAll = useCallback(async (): Promise<DesktopSettingsSaveResult | undefined> => {
    if (!snapshot || !draft || runtimeBlocked || invalid || dirtyCount === 0 || saveState === "recovery_required") return undefined;
    setSaveState("saving");
    // 看门狗：保存走单互斥事务，前序操作若撞上 Keychain security 超时可能长时间占用；
    // 超时不取消后端事务（它最终会自行落盘并清理），只把 UI 从「保存中」复位，避免死锁观感。
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const watchdogTrip = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("保存超时，可能仍在后台完成；如状态未更新请重试。")), 20_000);
    });
    try {
      const result = await Promise.race([window.biny.saveSettings(snapshot.projectId, saveInput(snapshot, draft)), watchdogTrip]);
      if (result.status === "committed") {
        credentialHandlesRef.current.clear();
        adoptSnapshot(result.snapshot);
        // 保存事务已经返回 committed；关闭握手的清理是非关键 IPC，不再让 UI 额外等待一轮。
        void window.biny.updateSettingsDraftState({ dirty: false, canSave: false, open: active }).catch(() => undefined);
        onCommitted(result.snapshot);
      } else if (result.status === "rolled_back") {
        // 后端已验证补偿完成；只更新 CAS 基线，用户的草稿值继续保留以便处理冲突后重试。
        setSnapshot(result.snapshot);
        snapshotRef.current = result.snapshot;
        // 主题和字体是未落盘的即时预览。补偿完成后 UI 必须先恢复权威值，
        // 但不能丢掉草稿本身，用户仍可修正冲突后再次保存。
        onThemePreview(result.snapshot.themePreference);
        onFontPreview(result.snapshot.fontPreference);
        setSaveState("dirty");
        onNotify(result.message ?? (result.conflicts?.length ? "设置已在其他位置更改，请检查冲突后重试" : "保存失败，已恢复原设置"));
      } else {
        setSaveState("recovery_required");
        onNotify(result.message);
      }
      return result;
    } catch (error) {
      setSaveState("dirty");
      onNotify(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
  }, [active, adoptSnapshot, dirtyCount, draft, invalid, onCommitted, onFontPreview, onNotify, onThemePreview, runtimeBlocked, saveState, snapshot]);

  const value = useMemo<SettingsDraftContextValue>(() => ({
    snapshot,
    draft,
    activity: draft?.activity ?? globalActivity?.activity,
    loadError,
    dirtyCount,
    preferencesOnly,
    invalid,
    saveState,
    setThemePreference,
    setFontPreference,
    updateActivityImmediately,
    setIdentity,
    setMemory,
    setCompaction,
    setChatParams,
    setPermission,
    setWebSearch,
    setChat,
    setSkills,
    upsertModel,
    removeModel,
    saveModels,
    setModelProfile,
    stageCredential,
    addOauthCredentialHandle,
    releaseCredential,
    discard,
    saveAll
  }), [
    addOauthCredentialHandle,
    dirtyCount,
    discard,
    draft,
    globalActivity,
    invalid,
    loadError,
    releaseCredential,
    removeModel,
    saveAll,
    saveModels,
    saveState,
    preferencesOnly,
    setChat,
    setChatParams,
    setCompaction,
    setModelProfile,
    setFontPreference,
    setMemory,
    setPermission,
    updateActivityImmediately,
    setIdentity,
    setThemePreference,
    setWebSearch,
    setSkills,
    snapshot,
    stageCredential,
    upsertModel
  ]);

  return <SettingsDraftContext.Provider value={value}>{children}</SettingsDraftContext.Provider>;
}

function draftFromSnapshot(snapshot: DesktopSettingsSnapshot): DesktopSettingsDraft {
  return {
    themePreference: snapshot.themePreference,
    fontPreference: { ...snapshot.fontPreference },
    activity: activityInputFromSnapshot(snapshot.activity),
    identity: structuredClone(snapshot.identity),
    memory: structuredClone(snapshot.memory),
    compaction: structuredClone(snapshot.compaction),
    chatParams: structuredClone(snapshot.chatParams),
    permission: structuredClone(snapshot.permission),
    webSearch: webSearchInput(snapshot.webSearch),
    chat: snapshot.chat ? structuredClone(snapshot.chat.personalization) : undefined,
    models: {
      upserts: [],
      removeAliases: [],
      defaultModel: undefined,
      oauthCredentialHandles: [],
      modelProfiles: structuredClone(snapshot.models.modelProfiles ?? {})
    },
    skills: skillInputFromSnapshot(snapshot.skills)
  };
}

/** 即时保存只推进未编辑字段；保存期间新增的其他分页编辑也不能被覆盖。 */
function rebaseUneditedFields(current: DesktopSettingsDraft, previous: DesktopSettingsSnapshot, next: DesktopSettingsSnapshot): DesktopSettingsDraft {
  const before = draftFromSnapshot(previous);
  const after = draftFromSnapshot(next);
  const rebased = { ...current };
  const rebaseField = <K extends keyof DesktopSettingsDraft>(key: K): void => {
    if (key !== "models" && sameJson(current[key], before[key])) rebased[key] = after[key];
  };
  for (const key of Object.keys(before) as (keyof DesktopSettingsDraft)[]) rebaseField(key);
  return rebased;
}

function webSearchInput(value: DesktopWebSearchSettings): DesktopWebSearchSettingsInput {
  return {
    provider: value.provider,
    visibleBrowsing: value.visibleBrowsing,
    timeoutMs: value.timeoutMs,
    maxResults: value.maxResults
  };
}

function countDirtyFields(snapshot: DesktopSettingsSnapshot, draft: DesktopSettingsDraft): number {
  let count = 0;
  if (draft.themePreference !== snapshot.themePreference) count += 1;
  if (!sameJson(draft.fontPreference, snapshot.fontPreference)) count += 1;
  return count + countNonPreferenceDirtyFields(snapshot, draft);
}

function countNonPreferenceDirtyFields(snapshot: DesktopSettingsSnapshot, draft: DesktopSettingsDraft): number {
  let count = 0;
  if (!sameJson(draft.activity, activityInputFromSnapshot(snapshot.activity))) count += 1;
  if (!sameJson(draft.identity, snapshot.identity)) count += 1;
  if (!sameJson(draft.memory, snapshot.memory)) count += 1;
  if (!sameJson(draft.compaction, snapshot.compaction)) count += 1;
  if (!sameJson(draft.chatParams, snapshot.chatParams)) count += 1;
  if (!sameJson(draft.permission, snapshot.permission)) count += 1;
  if (!sameWebSearch(draft.webSearch, snapshot.webSearch)) count += 1;
  if (draft.models.upserts.length || draft.models.removeAliases.length || draft.models.defaultModel || draft.models.oauthCredentialHandles.length
    || !sameJson(draft.models.modelProfiles, snapshot.models.modelProfiles ?? {})) count += 1;
  if (snapshot.chat && draft.chat && !sameJson(draft.chat, snapshot.chat.personalization)) count += 1;
  if (!sameJson(draft.skills, skillInputFromSnapshot(snapshot.skills))) count += 1;
  return count;
}

function validDraft(draft: DesktopSettingsDraft): boolean {
  const compaction = draft.compaction;
  if (compaction.triggerPercent !== undefined && (compaction.triggerPercent < 0.5 || compaction.triggerPercent > 0.95)) return false;
  if (compaction.keepRecentMessages !== undefined && (!Number.isInteger(compaction.keepRecentMessages) || compaction.keepRecentMessages < 1 || compaction.keepRecentMessages > 500)) return false;
  if (compaction.reserveTokens !== undefined && (!Number.isInteger(compaction.reserveTokens) || compaction.reserveTokens < 256 || compaction.reserveTokens > 262_144)) return false;
  if (compaction.keepRecentTokens !== undefined && (!Number.isInteger(compaction.keepRecentTokens) || compaction.keepRecentTokens < 256 || compaction.keepRecentTokens > 1_000_000)) return false;
  if (compaction.maxSummaryTokens !== undefined && (!Number.isInteger(compaction.maxSummaryTokens) || compaction.maxSummaryTokens < 256 || compaction.maxSummaryTokens > 32_768)) return false;
  const chatParams = draft.chatParams;
  if (chatParams.temperature !== undefined && (chatParams.temperature < 0 || chatParams.temperature > 2)) return false;
  if (chatParams.maxOutputTokens !== undefined && (!Number.isInteger(chatParams.maxOutputTokens) || chatParams.maxOutputTokens < 256 || chatParams.maxOutputTokens > 131_072)) return false;
  const activity = draft.activity;
  if (activity.captureDebounceMs < 0 || activity.captureDebounceMs > 30_000
    || activity.heartbeatMs < 0 || activity.heartbeatMs > 300_000
    || activity.idleTimeoutMs < 0 || activity.idleTimeoutMs > 600_000
    || activity.inputPauseMs < 0 || activity.inputPauseMs > 5_000
    || activity.visualPollMs < 0 || activity.visualPollMs > 30_000
    || activity.browserPollIntervalMs < 0 || activity.browserPollIntervalMs > 30_000
    || activity.jpegQuality < 0 || activity.jpegQuality > 100
    || activity.ocrEveryNFrames < 0 || activity.ocrEveryNFrames > 20
    || activity.ocrLanguages.length === 0 || activity.maxStorageMb < 256
    || activity.outputDirectory.trim() === "") return false;
  return true;
}

function saveInput(snapshot: DesktopSettingsSnapshot, draft: DesktopSettingsDraft): DesktopSettingsSaveInput {
  const modelsDirty = draft.models.upserts.length > 0
    || draft.models.removeAliases.length > 0
    || draft.models.defaultModel !== undefined
    || draft.models.oauthCredentialHandles.length > 0
    || !sameJson(draft.models.modelProfiles, snapshot.models.modelProfiles ?? {});
  return {
    expectedPreferenceRevision: snapshot.preferenceRevision,
    expectedConfigRevision: snapshot.configRevision,
    themePreference: draft.themePreference === snapshot.themePreference ? undefined : draft.themePreference,
    fontPreference: sameJson(draft.fontPreference, snapshot.fontPreference) ? undefined : draft.fontPreference,
    activity: sameJson(draft.activity, activityInputFromSnapshot(snapshot.activity)) ? undefined : draft.activity,
    identity: sameJson(draft.identity, snapshot.identity) ? undefined : draft.identity,
    memory: sameJson(draft.memory, snapshot.memory) ? undefined : draft.memory,
    compaction: sameJson(draft.compaction, snapshot.compaction) ? undefined : draft.compaction,
    chatParams: sameJson(draft.chatParams, snapshot.chatParams) ? undefined : draft.chatParams,
    permission: sameJson(draft.permission, snapshot.permission) ? undefined : draft.permission,
    webSearch: sameWebSearch(draft.webSearch, snapshot.webSearch) ? undefined : draft.webSearch,
    skills: sameJson(draft.skills, skillInputFromSnapshot(snapshot.skills)) ? undefined : draft.skills,
    models: modelsDirty ? {
      upserts: draft.models.upserts,
      removeAliases: draft.models.removeAliases,
      defaultModel: draft.models.defaultModel,
      oauthCredentialHandles: draft.models.oauthCredentialHandles,
      modelProfiles: draft.models.modelProfiles
    } : undefined,
    chat: snapshot.chat && draft.chat && !sameJson(draft.chat, snapshot.chat.personalization) ? {
      sessionId: snapshot.chat.sessionId,
      expectedMetadataRevision: snapshot.chat.metadataRevision,
      personalization: draft.chat
    } : undefined
  };
}

function activityInputFromSnapshot(value: DesktopSettingsSnapshot["activity"]): DesktopActivitySettingsInput {
  return structuredClone(value);
}

function skillInputFromSnapshot(value: DesktopSettingsSnapshot["skills"] | undefined): DesktopSkillSettingsInput {
  const skills = value ?? {
    globalDefaults: {},
    projectOverrides: {}
  };
  return {
    globalDefaults: { ...skills.globalDefaults },
    projectOverrides: { ...skills.projectOverrides }
  };
}

function sameWebSearch(draft: DesktopWebSearchSettingsInput, snapshot: DesktopWebSearchSettings): boolean {
  return draft.provider === snapshot.provider
    && draft.visibleBrowsing === snapshot.visibleBrowsing
    && draft.timeoutMs === snapshot.timeoutMs
    && draft.maxResults === snapshot.maxResults;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
