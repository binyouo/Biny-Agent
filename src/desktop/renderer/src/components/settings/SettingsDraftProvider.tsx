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
  DesktopWebSearchSettingsInput,
  DesktopRedactionSettings,
  DesktopRedactionSettingsInput
} from "../../../../protocol.js";
import { canReuseSettingsSnapshot, SettingsDraftContext, type DesktopSettingsDraft, type SettingsDraftContextValue, type SettingsSaveState } from "./SettingsDraftContext.js";

// 请求与 adoption 分开缓存：打开设置要在 shell 生命周期结束前预热同一 IPC，
// 但之前的快照/draft 绝不能跨项目 scope 沿用，否则旧界面会闪别的项目的内容。
// in-flight 与快照各自独立缓存 —— pending 时订阅同一 promise，resolve 后写 persisted
// 并从 in-flight 移除；bridge 换主时一并失效。
const persistedSnapshots = { owner: undefined as object | undefined, map: new Map<string, DesktopSettingsSnapshot>() };
const inFlightRequests = { owner: undefined as object | undefined, map: new Map<string, Promise<DesktopSettingsSnapshot>>() };

function bucket<T>(store: { owner: object | undefined; map: Map<string, T> }, owner: object): Map<string, T> {
  if (store.owner !== owner) {
    store.map.clear();
    store.owner = owner;
  }
  return store.map;
}

function readPersistedSnapshot(owner: object, key: string): DesktopSettingsSnapshot | undefined {
  return persistedSnapshots.owner === owner ? persistedSnapshots.map.get(key) : undefined;
}

function writePersistedSnapshot(owner: object, key: string, next: DesktopSettingsSnapshot): void {
  bucket(persistedSnapshots, owner).set(key, next);
}

/** 应用层在用户点设置前调用：同一 project+session 只预热一次。resolve 后写 persisted 缓存并释放 in-flight。 */
export function warmSettingsSnapshot(projectId: string | undefined, sessionId: string | undefined): void {
  // 无项目时 provider 走的是 activitySettings（纯内存读，不需要预热）。
  if (projectId === undefined) return;
  const key = `${projectId}::${sessionId ?? ""}`;
  const requests = bucket(inFlightRequests, window.biny);
  if (requests.has(key)) return;
  const request = window.biny.settingsSnapshot(projectId, sessionId);
  requests.set(key, request);
  const drop = (): void => {
    if (requests.get(key) === request) requests.delete(key);
  };
  // resolve 时顺手把快照写进模块缓存：预热完成但用户没打开设置时，下次 mount
  // 用 persisted 直接渲染；reject 时立即释放，下次打开走正常加载。
  void request.then(next => {
    writePersistedSnapshot(window.biny, key, next);
    drop();
  }, () => drop());
}

export function SettingsDraftProvider({
  active,
  loadSnapshot = true,
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
  loadSnapshot?: boolean;
  children: React.ReactNode;
  onCommitted(snapshot: DesktopSettingsSnapshot, scope?: "models" | "model-config" | "preferences" | "settings", appliedFields?: string[]): void;
  onFontPreview(value: DesktopFontPreference): void;
  onNotify(message: string): void;
  onThemePreview(value: DesktopThemePreference): void;
  projectId?: string;
  sessionId?: string;
  sessionRunning: boolean;
}): React.JSX.Element {
  // 关掉设置窗口不销毁缓存：下次打开先用它渲染，后台再校验一次，
  // 避免每次都从零走一趟 IPC（这正是"进设置先看到正在加载"的来源）。
  const cacheKey = `${projectId ?? ""}::${sessionId ?? ""}`;
  const initialCached = readPersistedSnapshot(window.biny, cacheKey);
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot | undefined>(initialCached);
  const cacheKeyRef = useRef(cacheKey);
  const reusableCacheRef = useRef<{ key: string } | undefined>(
    initialCached === undefined ? undefined : { key: cacheKey }
  );
  const lastLoadAttemptRef = useRef(0);
  useEffect(() => () => { void window.biny.previewAppearance(null).catch((error: unknown) => onNotify(`恢复外观失败：${error instanceof Error ? error.message : String(error)}`)); }, [onNotify]);
  const [draft, setDraft] = useState<DesktopSettingsDraft | undefined>(() =>
    initialCached === undefined ? undefined : draftFromSnapshot(initialCached)
  );
  const [globalActivity, setGlobalActivity] = useState<DesktopActivitySettingsUpdate>();
  const globalActivityRef = useRef<DesktopActivitySettingsUpdate | undefined>(undefined);
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(active && loadSnapshot && initialCached === undefined);
  const [revalidating, setRevalidating] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string>();
  const [manualSaving, setManualSaving] = useState(false);
  const manualSaveRequestRef = useRef(0);
  const [modelSelectionSaving, setModelSelectionSaving] = useState(false);
  const [pendingModelEdits, reportModelEditState] = useState(false);
  const [saveState, setSaveState] = useState<SettingsSaveState>("clean");
  const credentialHandlesRef = useRef(new Set<string>());
  const snapshotRef = useRef<DesktopSettingsSnapshot | undefined>(initialCached);
  useLayoutEffect(() => { cacheKeyRef.current = cacheKey; }, [cacheKey]);
  const loadGenerationRef = useRef(0);
  const loadedGenerationRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    loadGenerationRef.current += 1;
    return () => { loadGenerationRef.current += 1; };
  }, [active, cacheKey]);
  const [importRevision, setImportRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    return window.biny.onApplicationImportsChanged?.(change => {
      if (!change.settingsChanged) return;
      loadedGenerationRef.current = undefined;
      bucket(inFlightRequests, window.biny).delete(cacheKey);
      setImportRevision(revision => revision + 1);
    });
  }, [active, cacheKey]);
  const activityUpdateTailRef = useRef(Promise.resolve());

  const adoptSnapshot = useCallback((next: DesktopSettingsSnapshot, submittedDraft?: DesktopSettingsDraft, refreshing = false): void => {
    snapshotRef.current = next;
    setSnapshot(next);
    writePersistedSnapshot(window.biny, cacheKeyRef.current, next);
    // 记下这份快照属于哪个项目；下次打开同一项目时可以先拿它渲染。
    // 这里必须用 cacheKeyRef 而不是闭包里的 projectId/sessionId —— adoptSnapshot 的
    // 依赖数组不含它们，闭包里读到的是旧值，会给快照挂错 key。
    reusableCacheRef.current = { key: cacheKeyRef.current };
    const nextDraft = draftFromSnapshot(next);
    // 保存期间其它分页仍可编辑；仅提交时未再修改的字段跟随服务端快照。
    setDraft((current) => current && submittedDraft ? {
      ...rebaseUneditedFields(current, submittedDraft, nextDraft),
      models: refreshing && !sameJson(current.models, submittedDraft.models) ? current.models : nextDraft.models
    } : nextDraft);
    setSaveError(undefined);
    setSaveState(next.pendingRecovery ? "recovery_required" : "clean");
  }, []);

  const { themePreference: draftTheme, fontPreference: draftFont } = draft ?? {};
  useEffect(() => {
    if (!active || !draftTheme || !draftFont) return;
    onThemePreview(draftTheme);
    onFontPreview(draftFont);
  }, [active, draftTheme, draftFont, onFontPreview, onThemePreview]);

  useEffect(() => {
    if (!active || !loadSnapshot) return;
    const generation = loadGenerationRef.current;
    if (loadedGenerationRef.current === generation && lastLoadAttemptRef.current === loadAttempt) return;
    let cancelled = false;
    // 之前读过同一个项目：先沿用缓存渲染（壳先出），后台再静默校验一次。
    // 首次读取、或项目变了、或用户主动 retry 时才清空并显示加载态。
    const reusable = canReuseSettingsSnapshot({
      cachedKey: reusableCacheRef.current?.key,
      currentKey: cacheKey,
      loadAttempt,
      lastLoadAttempt: lastLoadAttemptRef.current,
      hasSnapshot: snapshotRef.current !== undefined
    });
    if (reusable) {
      setRevalidating(true);
      setLoadError(undefined);
    } else {
      // 无缓存可走 stale-while-revalidate：初始 state 已是空，只需点亮加载态。
      // 模块级缓存保证 scope 唯一，跨项目/会话 remount 时新实例从 initialCached 起步，
      // 不可能出现"同实例换 cacheKey"的场景（key={scope} 会让 React 重建整个 Provider）。
      setGlobalActivity(undefined);
      globalActivityRef.current = undefined;
      setLoadError(undefined);
      setLoading(true);
      setRevalidating(false);
      setSaveError(undefined);
      setSaveState("clean");
    }
    // 没有项目时只读取全局 Activity 快照，不伪造项目 ID，也不加载项目模型或会话。
    const refreshBase = snapshotRef.current;
    // 预热请求（warmSettingsSnapshot）与正常读取共用同一个 promise：打开设置时
    // 数据可能已经在路上甚至已到达，只订阅一次，不重复 IPC。
    const warmed = bucket(inFlightRequests, window.biny);
    const pending = warmed.get(cacheKey);
    warmed.delete(cacheKey);
    const request = projectId
      ? (pending ?? window.biny.settingsSnapshot(projectId, sessionId)).then((next) => {
        if (!cancelled && snapshotRef.current === refreshBase) adoptSnapshot(next, refreshBase ? draftFromSnapshot(refreshBase) : undefined, reusable);
      })
      : window.biny.activitySettings().then((next) => {
        if (cancelled) return;
        globalActivityRef.current = next;
        setGlobalActivity(next);
      });
    request
      .then(() => { if (!cancelled) loadedGenerationRef.current = generation; })
      .catch((error: unknown) => {
        // 后台校验失败不该把已经能用的缓存内容换成一屏错误。
        if (!cancelled && !reusable) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRevalidating(false);
        if (loadGenerationRef.current === generation) {
          lastLoadAttemptRef.current = loadAttempt;
        }
      });
    return () => { cancelled = true; };
  }, [active, loadSnapshot, adoptSnapshot, cacheKey, importRevision, loadAttempt, projectId, sessionId]);

  const retryLoad = useCallback((): void => {
    // 重试只用于初次读取失败；已存在的跨页草稿不能被刷新覆盖。
    if (!loading && !snapshotRef.current) setLoadAttempt((attempt) => attempt + 1);
  }, [loading]);

  const saveGlobalPreference = useCallback(async (save: () => Promise<void>): Promise<boolean> => {
    setSaveState("saving");
    try { await save(); return true; }
    catch (error) { onNotify(error instanceof Error ? error.message : String(error)); return false; }
    finally { setSaveState("clean"); }
  }, [onNotify]);

  const setThemePreference = useCallback((value: DesktopThemePreference): void => {
    if (!projectId) {
      void saveGlobalPreference(async () => onThemePreview(await window.biny.setThemePreference(value)));
      return;
    }
    setDraft((current) => current ? { ...current, themePreference: value } : current);
  }, [onThemePreview, projectId, saveGlobalPreference]);

  const setFontPreference = useCallback((value: DesktopFontPreference): void => {
    if (!projectId) {
      void saveGlobalPreference(async () => onFontPreview(await window.biny.setFontPreference(value)));
      return;
    }
    setDraft((current) => current ? { ...current, fontPreference: value } : current);
  }, [onFontPreview, projectId, saveGlobalPreference]);

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

  const setSubagent = useCallback((value: DesktopSettingsSnapshot["subagent"]): void => {
    setDraft((current) => current ? { ...current, subagent: value } : current);
  }, []);



  const setPermission = useCallback((value: DesktopPermissionSettings): void => {
    setDraft((current) => current ? { ...current, permission: value } : current);
  }, []);

  const setWebSearch = useCallback((value: DesktopWebSearchSettingsInput): void => {
    setDraft((current) => current ? { ...current, webSearch: value } : current);
  }, []);

  const setRedaction = useCallback((value: DesktopRedactionSettingsInput): void => {
    setDraft((current) => current ? { ...current, redaction: value } : current);
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

  const { dirtyCount, nonPreferenceDirtyCount } = useMemo(() => {
    if (!snapshot || !draft) return { dirtyCount: 0, nonPreferenceDirtyCount: 0 };
    const nonPreferenceDirtyCount = countNonPreferenceDirtyFields(snapshot, draft);
    return { dirtyCount: countPreferenceDirtyFields(snapshot, draft) + nonPreferenceDirtyCount, nonPreferenceDirtyCount };
  }, [snapshot, draft]);
  // 主题和字体只影响 DesktopStateStore，不会改变运行中的 Agent 配置。
  const preferencesOnly = dirtyCount > 0 && nonPreferenceDirtyCount === 0;
  const invalid = draft ? !validDraft(draft) : false;
  const projectSkillsOnly = nonPreferenceDirtyCount === 1 && snapshot && draft
    && sameJson(draft.skills.globalDefaults, snapshot.skills.globalDefaults)
    && !sameJson(draft.skills.projectOverrides, snapshot.skills.projectOverrides);
  // 全局忙态不能推断目标项目忙；项目范围写入仍由后端即时复核准入。
  const runtimeBlocked = !preferencesOnly && (sessionRunning || (snapshot?.hasRunningTasks === true && !projectSkillsOnly));
  const canSave = active
    && dirtyCount > 0
    && draft !== undefined
    && !runtimeBlocked
    && !invalid
    && saveState !== "saving"
    && saveState !== "rolling_back"
    && saveState !== "recovery_required";

  const dirty = dirtyCount > 0 || pendingModelEdits || saveState === "saving";
  useLayoutEffect(() => {
    void window.biny.updateSettingsDraftState({
      dirty,
      canSave,
      open: active
    }).catch(() => undefined);
  }, [active, canSave, dirty]);

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
    if (snapshot) {
      adoptSnapshot(snapshot);
      onThemePreview(snapshot.themePreference);
      onFontPreview(snapshot.fontPreference);
    }
    await window.biny.updateSettingsDraftState({ dirty: false, canSave: false, open: active }).catch(() => undefined);
  }, [active, adoptSnapshot, onFontPreview, onThemePreview, releaseAllCredentials, snapshot]);

  // 即时保存只携带本次增量；依赖模型偏好的更新在队列内根据最新快照计算。
  const modelsSaveTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const modelSaveFailuresRef = useRef(0);
  const pendingModelSavesRef = useRef(0);
  const pendingModelSelectionSavesRef = useRef(0);
  const modelEditorsRef = useRef(new Set<() => Promise<boolean>>());
  const registerModelEditor = useCallback((flush: () => Promise<boolean>): (() => void) => {
    modelEditorsRef.current.add(flush);
    return () => { modelEditorsRef.current.delete(flush); };
  }, []);
  const flushModelEdits = useCallback(async (): Promise<boolean> => {
    const failures = modelSaveFailuresRef.current;
    for (const flush of modelEditorsRef.current) if (!await flush()) return false;
    let tail: Promise<unknown>;
    do {
      tail = modelsSaveTailRef.current;
      await tail;
    } while (tail !== modelsSaveTailRef.current);
    // 只阻止本轮等待期间的失败；用户看见错误后仍可再次主动关闭。
    return failures === modelSaveFailuresRef.current;
  }, []);

  const saveModels = useCallback(async (update: DesktopSettingsModelsInput | ((snapshot: DesktopSettingsSnapshot) => DesktopSettingsModelsInput)): Promise<DesktopSettingsSaveResult | undefined> => {
    const base = snapshotRef.current;
    if (!base) throw new Error("设置尚未加载完成。");
    if (saveState === "recovery_required") {
      onNotify("存在未恢复的保存事务，请先处理再修改模型配置。");
      return undefined;
    }
    const generation = loadGenerationRef.current;
    const selectionOnly = typeof update !== "function" && isModelSelectionUpdate(update);
    pendingModelSavesRef.current += 1;
    if (selectionOnly) pendingModelSelectionSavesRef.current += 1;
    setModelSelectionSaving(pendingModelSelectionSavesRef.current === pendingModelSavesRef.current);
    setSaveState("saving");
    const operation = modelsSaveTailRef.current.then(async (): Promise<DesktopSettingsSaveResult | undefined> => {
      // 队列执行时取最新基线：前一笔即时保存可能已经推进了 configRevision。
      const snapshotNow = snapshotRef.current;
      if (!snapshotNow || generation !== loadGenerationRef.current) throw new Error("设置页面已切换，请重新操作。");
      if (snapshotNow.pendingRecovery) throw new Error("存在未恢复的保存事务，请先处理再修改模型配置。");
      const models = typeof update === "function" ? update(snapshotNow) : update;
      const modelSelectionOnly = isModelSelectionUpdate(models);
      const result = await window.biny.saveSettings(snapshotNow.projectId, {
        expectedPreferenceRevision: snapshotNow.preferenceRevision,
        expectedConfigRevision: snapshotNow.configRevision,
        models
      });
      if (generation !== loadGenerationRef.current) return undefined;
      if (result.status === "committed") {
        const nextSnapshot = committedSettingsSnapshot(snapshotRef.current ?? snapshotNow, result);
        writePersistedSnapshot(window.biny, cacheKeyRef.current, nextSnapshot);
        // 模型变更可能同时改变后端派生的默认设置。未编辑字段跟随新快照，
        // 只有真正偏离旧基线的字段才保留，避免旧默认值造成幽灵 dirty 状态。
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        setSaveState(nextSnapshot.pendingRecovery ? "recovery_required" : pendingModelSavesRef.current > 1 ? "saving" : "clean");
        if (!result.modelSelection) setDraft((current) => current ? {
          ...rebaseUneditedFields(current, draftFromSnapshot(snapshotNow), draftFromSnapshot(nextSnapshot)),
          models: modelSelectionOnly ? current.models : {
            upserts: [],
            removeAliases: [],
            defaultModel: undefined,
            oauthCredentialHandles: current.models.oauthCredentialHandles.filter((handle) => !models.oauthCredentialHandles?.includes(handle)),
            modelProfiles: structuredClone(nextSnapshot.models.modelProfiles ?? {})
          }
        } : current);
        onCommitted(nextSnapshot, modelSelectionOnly ? "models" : "model-config");
      } else if (result.status === "rolled_back") {
        const nextSnapshot = result.snapshot ?? { ...(snapshotRef.current ?? snapshotNow), ...(result.settings ?? result.preferences) };
        setSnapshot(nextSnapshot);
        snapshotRef.current = nextSnapshot;
        setSaveState(pendingModelSavesRef.current > 1 ? "saving" : dirtyCount > 0 ? "dirty" : "clean");
        if (!modelSelectionOnly) onNotify(result.message ?? (result.conflicts?.length ? "模型设置已在其他位置更改，请重试" : "模型设置保存失败，已恢复原设置"));
      } else {
        setSaveState("recovery_required");
        setSaveError(result.message);
        onNotify(result.message);
      }
      return result;
    });
    modelsSaveTailRef.current = operation.then(
      result => { if (result?.status !== "committed") modelSaveFailuresRef.current += 1; },
      () => { modelSaveFailuresRef.current += 1; }
    );
    try {
      return await operation;
    } catch (error) {
      if (generation !== loadGenerationRef.current) return undefined;
      setSaveState(pendingModelSavesRef.current > 1 ? "saving" : dirtyCount > 0 ? "dirty" : "clean");
      throw error;
    } finally {
      pendingModelSavesRef.current -= 1;
      if (selectionOnly) pendingModelSelectionSavesRef.current -= 1;
      setModelSelectionSaving(pendingModelSavesRef.current > 0 && pendingModelSelectionSavesRef.current === pendingModelSavesRef.current);
    }
  }, [dirtyCount, onCommitted, onNotify, saveState]);

  const saveAll = useCallback(async (): Promise<DesktopSettingsSaveResult | undefined> => {
    if (!snapshot || !draft || runtimeBlocked || invalid || dirtyCount === 0 || saveState === "recovery_required" || saveState === "saving" || saveState === "rolling_back") return undefined;
    const loadGeneration = loadGenerationRef.current;
    const manualSaveRequest = ++manualSaveRequestRef.current;
    setManualSaving(true);
    setSaveError(undefined);
    setSaveState("saving");
    // 看门狗：保存走单互斥事务，前序操作若撞上 Keychain security 超时可能长时间占用；
    // 超时不取消后端事务（它最终会自行落盘并清理），只把 UI 从「保存中」复位，避免死锁观感。
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const watchdogTrip = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("保存超时，可能仍在后台完成；如状态未更新请重试。")), 20_000);
    });
    try {
      const result = await Promise.race([window.biny.saveSettings(snapshot.projectId, saveInput(snapshot, draft)), watchdogTrip]);
      // 关闭或切换项目/会话后，旧事务仍可完成，但不能覆盖新页面的草稿或保存状态。
      if (loadGenerationRef.current !== loadGeneration) return result;
      if (result.status === "committed") {
        const nextSnapshot = committedSettingsSnapshot(snapshotRef.current ?? snapshot, result);
        credentialHandlesRef.current.clear();
        adoptSnapshot(nextSnapshot, draft);
        // 关闭握手由 layout effect 投影实际剩余草稿，不把保存期间的新编辑标记为已保存。
        onCommitted(nextSnapshot, result.preferences ? "preferences" : result.settings ? "settings" : undefined, result.appliedFields);
      } else if (result.status === "rolled_back") {
        // 后端已验证补偿完成；只更新 CAS 基线，用户的草稿值继续保留以便处理冲突后重试。
        const nextSnapshot = result.snapshot ?? { ...(snapshotRef.current ?? snapshot), ...(result.settings ?? result.preferences) };
        setSnapshot(nextSnapshot);
        snapshotRef.current = nextSnapshot;
        // 主题和字体是未落盘的即时预览。补偿完成后 UI 必须先恢复权威值，
        // 但不能丢掉草稿本身，用户仍可修正冲突后再次保存。
        onThemePreview(nextSnapshot.themePreference);
        onFontPreview(nextSnapshot.fontPreference);
        setSaveState("dirty");
        const message = result.message ?? (result.conflicts?.length ? "设置已在其他位置更改，请检查冲突后重试" : "保存失败，已恢复原设置");
        setSaveError(message);
        onNotify(message);
      } else {
        setSaveState("recovery_required");
        setSaveError(result.message);
        onNotify(result.message);
      }
      return result;
    } catch (error) {
      if (loadGenerationRef.current !== loadGeneration) return undefined;
      setSaveState("dirty");
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(message);
      onNotify(message);
      return undefined;
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (manualSaveRequestRef.current === manualSaveRequest) setManualSaving(false);
    }
  }, [adoptSnapshot, dirtyCount, draft, invalid, onCommitted, onFontPreview, onNotify, onThemePreview, runtimeBlocked, saveState, snapshot]);

  const value = useMemo<SettingsDraftContextValue>(() => ({
    snapshot,
    draft,
    activity: draft?.activity ?? globalActivity?.activity,
    loadError,
    loading,
    revalidating,
    retryLoad,
    saveError,
    dirtyCount,
    preferencesOnly,
    runtimeBlocked,
    invalid,
    saveState,
    manualSaving,
    modelSelectionSaving,
    pendingModelEdits,
    reportModelEditState,
    setThemePreference,
    setFontPreference,
    updateActivityImmediately,
    setIdentity,
    setMemory,
    setCompaction,
    setChatParams,
    setSubagent,
    setPermission,
    setWebSearch,
    setRedaction,
    setChat,
    setSkills,
    upsertModel,
    removeModel,
    saveModels,
    registerModelEditor,
    flushModelEdits,
    setModelProfile,
    stageCredential,
    addOauthCredentialHandle,
    releaseCredential,
    discard,
    saveAll
  }), [
    registerModelEditor,
    flushModelEdits,
    addOauthCredentialHandle,
    modelSelectionSaving,
    pendingModelEdits,
    dirtyCount,
    discard,
    draft,
    globalActivity,
    invalid,
    loadError,
    loading,
    revalidating,
    retryLoad,
    saveError,
    releaseCredential,
    removeModel,
    saveAll,
    saveModels,
    saveState,
    manualSaving,
    preferencesOnly,
    runtimeBlocked,
    setChat,
    setChatParams,
    setSubagent,
    setCompaction,
    setModelProfile,
    setFontPreference,
    setMemory,
    setPermission,
    updateActivityImmediately,
    setIdentity,
    setThemePreference,
    setWebSearch,
    setRedaction,
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
    subagent: structuredClone(snapshot.subagent),
    permission: structuredClone(snapshot.permission),
    webSearch: webSearchInput(snapshot.webSearch),
    redaction: redactionInput(snapshot.redaction),
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

/** 只推进相对提交基线未修改的字段；保存期间新增的其它分页编辑也不能被覆盖。 */
function rebaseUneditedFields(current: DesktopSettingsDraft, before: DesktopSettingsDraft, after: DesktopSettingsDraft): DesktopSettingsDraft {
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

function countPreferenceDirtyFields(snapshot: DesktopSettingsSnapshot, draft: DesktopSettingsDraft): number {
  let count = 0;
  if (draft.themePreference !== snapshot.themePreference) count += 1;
  if (!sameJson(draft.fontPreference, snapshot.fontPreference)) count += 1;
  return count;
}

function countNonPreferenceDirtyFields(snapshot: DesktopSettingsSnapshot, draft: DesktopSettingsDraft): number {
  let count = 0;
  if (!sameJson(draft.activity, activityInputFromSnapshot(snapshot.activity))) count += 1;
  if (!sameJson(draft.identity, snapshot.identity)) count += 1;
  if (!sameJson(draft.memory, snapshot.memory)) count += 1;
  if (!sameJson(draft.compaction, snapshot.compaction)) count += 1;
  if (!sameJson(draft.chatParams, snapshot.chatParams)) count += 1;
  if (!sameJson(draft.subagent, snapshot.subagent)) count += 1;
  if (!sameJson(draft.permission, snapshot.permission)) count += 1;
  if (!sameWebSearch(draft.webSearch, snapshot.webSearch)) count += 1;
  if (!sameRedaction(draft.redaction, snapshot.redaction)) count += 1;
  if (draft.models.upserts.length || draft.models.removeAliases.length || draft.models.defaultModel || draft.models.oauthCredentialHandles.length
    || !sameJson(draft.models.modelProfiles, snapshot.models.modelProfiles ?? {})) count += 1;
  if (snapshot.chat && draft.chat && !sameJson(draft.chat, snapshot.chat.personalization)) count += 1;
  if (!sameJson(draft.skills, skillInputFromSnapshot(snapshot.skills))) count += 1;
  return count;
}

function validDraft(draft: DesktopSettingsDraft): boolean {
  if (draft.subagent.enabled && draft.subagent.runtime === "acp" && !draft.subagent.providerAlias?.trim() && !draft.subagent.model?.trim()) return false;
  if (draft.subagent.enabled && draft.subagent.runtime === "codex" && !draft.subagent.model?.trim()) return false;
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
    subagent: sameJson(draft.subagent, snapshot.subagent) ? undefined : draft.subagent,
    permission: sameJson(draft.permission, snapshot.permission) ? undefined : draft.permission,
    webSearch: sameWebSearch(draft.webSearch, snapshot.webSearch) ? undefined : draft.webSearch,
    redaction: sameRedaction(draft.redaction, snapshot.redaction) ? undefined : draft.redaction,
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

function redactionInput(value: DesktopRedactionSettings | undefined): DesktopRedactionSettingsInput {
  return { enabled: value?.enabled ?? false };
}

function sameRedaction(draft: DesktopRedactionSettingsInput, snapshot: DesktopRedactionSettings | undefined): boolean {
  return draft.enabled === (snapshot?.enabled ?? false);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isModelSelectionUpdate(models: DesktopSettingsModelsInput): boolean {
  return (models.toolModel !== undefined || models.visionModel !== undefined || models.visionModelEnabled !== undefined)
    && models.upserts.length === 0 && models.removeAliases.length === 0
    && Object.keys(models).every((key) => key === "upserts" || key === "removeAliases" || key === "toolModel" || key === "visionModel" || key === "visionModelEnabled");
}

function committedSettingsSnapshot(base: DesktopSettingsSnapshot, result: Extract<DesktopSettingsSaveResult, { status: "committed" }>): DesktopSettingsSnapshot {
  if (result.snapshot) return result.snapshot;
  if (result.settings) return { ...base, ...result.settings };
  if (result.preferences) return { ...base, ...result.preferences };
  return { ...base, ...result.modelSelection, models: { ...base.models, ...result.modelSelection.models } };
}
