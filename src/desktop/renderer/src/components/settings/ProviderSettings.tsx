/**
 * 模型服务商设置：主从式两栏布局。
 *
 * 左栏是服务商清单（搜索 + 状态圆点，可用连接排最前），右栏是所选服务商的配置面板。
 * 面板是两态设计：未连接只给「启用」出口，连接后原地展开完整表单——把「连接服务商」
 * 从一次性对话框改成常驻面板，用户随时回来改密钥、增删模型、测试连通。
 *
 * 人体工学上对齐零保存按钮的产品惯例：文本字段（密钥/服务地址）防抖 + 失焦提交，模型
 * 开关与全选即点即提交，且一批变更只发一次事务（saveModels 只提交 models 段，与其它
 * 分页的草稿互不影响）；运行中的会话会让主进程拒绝事务，此时变更留在草稿里，等会话
 * 结束由页脚保存兜底。模型选项对话框是例外：编辑只进本地缓冲，关闭时一次落盘。
 */
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { NativeSelect } from "../NativeSelect.js";
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelProfile, ThinkingLevelMap } from "../../../../../config/schema.js";
import type { ModelChoice, ThinkingSelection } from "../../../../../llm/ModelManager.js";
import { useFluidHoverItems } from "../../useFluidHoverItems.js";
import { FluidHoverHighlight } from "../FluidHoverHighlight.js";
import type {
  DesktopModelCatalogResult,
  DesktopModelConfigurationInput,
  DesktopModelConnection,
  DesktopModelConnectionTestResult,
  DesktopModelLoginProvider,
  DesktopModelLoginStartResult,
  DesktopSettingsModelsInput,
  DesktopStagedModelLoginResult
} from "../../../../protocol.js";
import {
  apiFormatForConnection,
  apiFormatOption,
  apiFormatOptions,
  apiFormatOptionsForConnection,
  recommendedApiFormat,
  type ConnectionApiFormat,
  catalogForConnection,
  customCatalogEntry,
  modelAliasFor,
  providerAliasFor,
  providerCatalog,
  type ApiFormatId,
  type ApiFormatOption,
  type CatalogModel,
  type ProviderCatalogItem
} from "../../providerCatalog.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { connectionLabel } from "./providerModelProjection.js";
import { useSettingsDraft, type SettingsModelDraft } from "./SettingsDraftContext.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { providerErrorMessage } from "./providerFeedback.js";

const CatalogErrorContext = createContext<string | undefined>(undefined);

interface ConnectionGroup {
  provider: string;
  providerType: string;
  models: ModelChoice[];
  defaultModel?: ModelChoice;
}

/** 左栏一行：目录条目或一个未匹配目录的自定义端点。 */
interface ProviderListEntry {
  key: string;
  catalog?: ProviderCatalogItem;
  label: string;
  description: string;
  badge?: string;
  iconTone: string;
  group?: ConnectionGroup;
  connection?: DesktopModelConnection;
}

interface LiveCatalogState {
  models: CatalogModel[];
  source: DesktopModelCatalogResult["source"];
}

export interface ProviderSettingsProps {
  active: boolean;
  /** 设置快照尚未返回时为 true：列表显示骨架行而不是闪一下空状态。 */
  loading: boolean;
  models: ModelChoice[];
  connections: DesktopModelConnection[];
  catalogs: Record<string, DesktopModelCatalogResult["models"]>;
  defaultModelAlias?: string;
  projectId?: string;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  onTest(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onFetchCatalog(providerAlias: string, force?: boolean): Promise<DesktopModelCatalogResult>;
  onFetchCatalogCandidate(configuration: DesktopModelConfigurationInput): Promise<DesktopModelCatalogResult>;
  onReadModelApiKey(providerAlias: string): Promise<string | undefined>;
  onStartLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCompleteLogin(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<DesktopStagedModelLoginResult>;
  onCancelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
}

export function ProviderSettings({
  active,
  loading,
  models,
  connections: connectionInfos,
  catalogs: cachedCatalogs,
  defaultModelAlias,
  projectId,
  onDefaultModel,
  onTest,
  onFetchCatalog,
  onFetchCatalogCandidate,
  onReadModelApiKey,
  onStartLogin,
  onCompleteLogin,
  onCancelLogin,
  onOpenExternal
}: ProviderSettingsProps): React.JSX.Element {
  const settingsDraft = useSettingsDraft();
  const infoFor = useCallback((providerAlias: string): DesktopModelConnection | undefined =>
    connectionInfos.find((item) => item.providerAlias === providerAlias), [connectionInfos]);

  // ── 列表行：目录条目 + 未匹配的自定义端点，可用连接置顶 ──
  const groups = useMemo(() => connectionLabel(models, connectionInfos), [models, connectionInfos]);
  const entries = useMemo<ProviderListEntry[]>(() => {
    const groupByCatalogId = new Map<string, ConnectionGroup>();
    const leftover: ConnectionGroup[] = [];
    for (const group of groups) {
      const catalog = catalogForConnection(group, infoFor(group.provider)?.baseUrl);
      if (catalog) groupByCatalogId.set(catalog.id, group);
      else leftover.push(group);
    }
    const rows: ProviderListEntry[] = providerCatalog.map((catalog) => {
      const group = groupByCatalogId.get(catalog.id);
      return {
        key: catalog.id,
        catalog,
        label: catalog.label,
        description: catalog.description,
        badge: catalog.badge,
        iconTone: catalog.iconTone,
        group,
        connection: group ? infoFor(group.provider) : undefined
      };
    });
    for (const group of leftover) {
      const info = infoFor(group.provider);
      const neutral = customCatalogEntry(group, info?.baseUrl);
      rows.push({
        key: `custom:${group.provider}`,
        catalog: neutral,
        label: neutral.label,
        description: neutral.description,
        badge: neutral.badge,
        iconTone: neutral.iconTone,
        group,
        connection: info
      });
    }
    // 健康连接 < 有问题的连接 < 未连接；同档内保持目录顺序，自定义行按名称排在最后。
    const health = (row: ProviderListEntry): number => row.group?.models.some((model) => model.showInPicker !== false) ? 0 : row.group ? 1 : 2;
    return rows
      .map((row, index) => ({ row, index, custom: row.key.startsWith("custom:") }))
      .sort((left, right) =>
        health(left.row) - health(right.row)
        || Number(left.custom) - Number(right.custom)
        || left.index - right.index
        || left.row.label.localeCompare(right.row.label))
      .map((item) => item.row);
  }, [groups, infoFor]);

  const [activeKey, setActiveKey] = useState<string>();
  const activeEntry = entries.find((row) => row.key === activeKey) ?? entries[0];
  const [notices, setNotices] = useState<Record<string, string>>({});
  const onNotify = useCallback((message: string): void => {
    const key = activeEntry?.key ?? "custom";
    setNotices((current) => ({ ...current, [key]: providerErrorMessage(message) }));
  }, [activeEntry?.key]);
  // 已有选中从列表里消失（例如删除自定义端点后）时回退到第一行。
  useEffect(() => {
    if (activeKey !== undefined && !entries.some((row) => row.key === activeKey)) setActiveKey(undefined);
  }, [activeKey, entries]);

  // 切换服务商时详情面板回到顶部：新面板不应继承上一家的滚动位置。
  const detailPaneRef = useRef<HTMLElement>(null);
  useEffect(() => {
    detailPaneRef.current?.scrollTo({ top: 0 });
  }, [activeEntry?.key]);

  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredEntries = normalizedQuery
    ? entries.filter((row) => `${row.label} ${row.description}`.toLocaleLowerCase().includes(normalizedQuery))
    : entries;

  // ── 即时提交：models 段整体计算（草稿待提交项 + 本次变更），交给 provider 串行落盘 ──
  const [saving, setSaving] = useState(false);
  const commitModels = useCallback(async (next: SettingsModelDraft, removeProviderAliases?: string[]): Promise<boolean> => {
    const input: DesktopSettingsModelsInput = {
      upserts: next.upserts,
      removeAliases: next.removeAliases,
      removeProviderAliases,
      defaultModel: next.defaultModel,
      oauthCredentialHandles: next.oauthCredentialHandles,
      modelProfiles: next.modelProfiles
    };
    try {
      const result = await settingsDraft.saveModels(input);
      return result?.status === "committed";
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [onNotify, settingsDraft]);

  /**
   * 一批模型 upsert / 停用共用一次事务：密钥先暂存拿句柄，乐观写入草稿后整体提交
   * models 段。被覆盖或停用的模型先释放草稿里的旧密钥句柄；提交失败（如会话运行中）
   * 时变更留在草稿由页脚保存兜底，UI 不会出现「开关弹回」的假失败。全选/批量启停、
   * 删除连接都走这里，避免逐模型各发一次配置事务。
   *
   * overrides.modelProfiles：setModelProfile 是异步 setState，紧随其后的提交读不到
   * 新值，必须在这里显式带上（与「添加 OAuth 句柄后立即提交」同理）。
   */
  const applyModelBatch = useCallback(async (
    inputs: DesktopModelConfigurationInput[],
    removeAliases: string[] = [],
    overrides: { modelProfiles?: SettingsModelDraft["modelProfiles"] } = {}
  ): Promise<boolean> => {
    const draft = settingsDraft.draft;
    if (!draft) return false;
    if (inputs.some((input) => input.apiKey) && !projectId) {
      onNotify("暂存模型密钥前必须先选择项目。");
      return false;
    }
    setSaving(true);
    try {
      const upserts = [...draft.models.upserts];
      for (const input of inputs) {
        const previous = upserts.find((item) => item.alias === input.alias)?.apiKeyHandle;
        if (previous) await settingsDraft.releaseCredential(previous);
        let stagedHandle: string | undefined;
        if (input.apiKey) {
          const staged = await settingsDraft.stageCredential(input.apiKey, {
            projectId: projectId!,
            purpose: "model",
            providerAlias: input.providerAlias
          });
          stagedHandle = staged.handle;
        }
        const finalInput: DesktopModelConfigurationInput = { ...input, apiKey: undefined, apiKeyHandle: stagedHandle ?? input.apiKeyHandle };
        settingsDraft.upsertModel(finalInput);
        const index = upserts.findIndex((item) => item.alias === finalInput.alias);
        if (index >= 0) upserts[index] = finalInput;
        else upserts.push(finalInput);
      }
      for (const alias of removeAliases) {
        const previous = draft.models.upserts.find((item) => item.alias === alias)?.apiKeyHandle;
        if (previous) await settingsDraft.releaseCredential(previous);
        settingsDraft.removeModel(alias);
      }
      const nextRemoveAliases = draft.models.removeAliases.filter((alias) =>
        !removeAliases.includes(alias) && !inputs.some((input) => input.alias === alias));
      for (const alias of removeAliases) {
        if (!nextRemoveAliases.includes(alias)) nextRemoveAliases.push(alias);
      }
      // 换密钥/改地址这类只更新某个模型的操作不能顺手动默认；只有显式 makeDefault
      // 或默认模型被删除时才动 defaultModel。
      const makeDefaultInput = inputs.find((input) => input.makeDefault);
      const defaultRemoved = removeAliases.includes(draft.models.defaultModel?.alias ?? "");
      return await commitModels({
        ...draft.models,
        modelProfiles: overrides.modelProfiles ?? draft.models.modelProfiles,
        upserts,
        removeAliases: nextRemoveAliases,
        defaultModel: makeDefaultInput
          ? { alias: makeDefaultInput.alias, thinking: "off" as const }
          : defaultRemoved ? undefined : draft.models.defaultModel
      });
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [commitModels, onNotify, projectId, settingsDraft]);

  // ── 实时目录缓存（按 providerAlias），获取按钮与连接后的静默刷新共用 ──
  const [liveCatalog, setLiveCatalog] = useState<Record<string, LiveCatalogState>>({});
  const [fetchingAlias, setFetchingAlias] = useState<string>();
  const [catalogErrors, setCatalogErrors] = useState<Record<string, string | undefined>>({});
  const catalogGenerationRef = useRef(new Map<string, number>());
  const refreshCatalog = useCallback(async (providerAlias: string, options: { force?: boolean; announce?: boolean } = {}): Promise<void> => {
    const generation = (catalogGenerationRef.current.get(providerAlias) ?? 0) + 1;
    catalogGenerationRef.current.set(providerAlias, generation);
    setFetchingAlias(providerAlias);
    setCatalogErrors((current) => ({ ...current, [providerAlias]: undefined }));
    try {
      const result = await onFetchCatalog(providerAlias, options.force ?? false);
      if (catalogGenerationRef.current.get(providerAlias) !== generation) return;
      setLiveCatalog((current) => ({
        ...current,
        [providerAlias]: { models: result.models.map(catalogModelFromEntry), source: result.source }
      }));

    } catch (error) {
      if (catalogGenerationRef.current.get(providerAlias) === generation) {
        setCatalogErrors((current) => ({ ...current, [providerAlias]: providerErrorMessage(error) }));
      }
    } finally {
      if (catalogGenerationRef.current.get(providerAlias) === generation) setFetchingAlias(undefined);
    }
  }, [onFetchCatalog]);

  // ── 当前面板的派生数据 ──
  const group = activeEntry?.group;
  const providerAlias = group?.provider ?? (activeEntry?.catalog ? providerAliasFor(activeEntry.catalog, activeEntry.catalog.baseUrl) : undefined);
  const connection = activeEntry?.connection ?? (providerAlias ? infoFor(providerAlias) : undefined);
  const catalog = activeEntry?.catalog;
  /** 已启用模型（ModelChoice）反推 upsert 输入；换密钥、改地址、切 API 格式共用。 */
  const choiceUpsertInput = useCallback((model: ModelChoice, extra: Partial<DesktopModelConfigurationInput> = {}): DesktopModelConfigurationInput | undefined => {
    if (!group || !catalog) return undefined;
    return {
      alias: model.alias,
      displayName: model.displayName,
      providerAlias: group.provider,
      providerType: catalog.value,
      protocol: connection?.protocol ?? catalog.protocol,
      model: model.model,
      baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
      apiKeyEnv: undefined,
      requiresApiKey: catalog.requiresApiKey,
      modelsRequiresApiKey: catalog.modelsRequiresApiKey,
      supportsTools: model.supportsTools !== false,
      supportsThinking: model.efforts.length > 0,
      parallelToolCalls: model.capabilities?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary,
      supportsVision: model.capabilities?.vision,
      supportsAudio: model.capabilities?.audio,
      contextWindow: model.contextWindow,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      limits: model.limits,
      thinkingLevelMap: model.thinkingLevelMap,
      apiBackend: model.apiBackend,
      ...extra
    };
  }, [catalog, connection, group]);
  const availableModels = useMemo(() => {
    if (!group || !catalog) return [];
    const cached = (cachedCatalogs[group.provider] ?? []).map(catalogModelFromEntry);
    return mergeAvailableModels(catalog.models, group.models, liveCatalog[group.provider]?.models ?? cached);
  }, [cachedCatalogs, catalog, group, liveCatalog]);
  const cancelLoginRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    // 设置面板整体关闭时放弃未完成的登录请求。
    if (active) return;
    cancelLoginRef.current();
  }, [active]);

  // ── 测试连接 ──
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const testTargetAlias = useRef<string | undefined>(undefined);
  const testConfiguration = useCallback((model: ModelChoice): DesktopModelConfigurationInput | undefined => {
    if (!group || !catalog) return undefined;
    return {
      alias: model.alias,
      displayName: model.displayName,
      providerAlias: group.provider,
      providerType: catalog.value,
      protocol: connection?.protocol ?? catalog.protocol,
      model: model.model,
      baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
      apiKeyEnv: undefined,
      supportsTools: model.supportsTools !== false,
      supportsThinking: model.efforts.length > 0,
      parallelToolCalls: model.capabilities?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary,
      supportsVision: model.capabilities?.vision,
      supportsAudio: model.capabilities?.audio,
      contextWindow: model.contextWindow,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      limits: model.limits,
      thinkingLevelMap: model.thinkingLevelMap,
      apiBackend: model.apiBackend
    };
  }, [catalog, connection, group]);
  const runTest = useCallback(async (model: ModelChoice): Promise<void> => {
    const configuration = testConfiguration(model);
    setTestMenuOpen(false);
    if (!configuration) return;
    testTargetAlias.current = group?.provider;
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await onTest(configuration);
      if (testTargetAlias.current === group?.provider) setTestResult(result);
    } finally {
      if (testTargetAlias.current === group?.provider) setTesting(false);
    }
  }, [group?.provider, onTest, testConfiguration]);

  // ── 密钥 / 服务地址：即输即存（防抖 + 失焦立即提交），换服务商时作废未提交的编辑 ──
  const [keyDraft, setKeyDraft] = useState("");
  const [keySaveState, setKeySaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyLoaded, setKeyLoaded] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const keyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const baseUrlTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const baseUrlDirtyRef = useRef(false);
  const activeProviderRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    activeProviderRef.current = providerAlias;
  }, [providerAlias]);
  useEffect(() => {
    // 切换面板时清掉未提交的输入与挂起的防抖，密钥和地址编辑绝不跨服务商残留。
    setTestResult(undefined);
    setTestMenuOpen(false);
    setDeleteArmed(false);
    setKeyDraft("");
    setKeySaveState("idle");
    setKeyLoading(false);
    setKeyLoaded(false);
    baseUrlDirtyRef.current = false;
    if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
    if (baseUrlTimerRef.current) clearTimeout(baseUrlTimerRef.current);
    return () => {
      if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
      if (baseUrlTimerRef.current) clearTimeout(baseUrlTimerRef.current);
    };
  }, [providerAlias]);

  const loadKey = useCallback(async (): Promise<void> => {
    if (!active || !providerAlias || !connection?.hasCredential || connection.authMode === "oauth-bearer" || keyLoaded || keyLoading) return;
    setKeyLoading(true);
    try {
      const value = await onReadModelApiKey(providerAlias);
      if (activeProviderRef.current === providerAlias) {
        setKeyDraft(value ?? "");
        setKeyLoaded(true);
      }
    } finally {
      if (activeProviderRef.current === providerAlias) {
        setKeyLoading(false);
      }
    }
  }, [active, connection?.authMode, connection?.hasCredential, keyLoaded, keyLoading, onReadModelApiKey, providerAlias]);

  const activeModel = group
    ? group.models.find((model) => model.alias === defaultModelAlias) ?? group.defaultModel ?? group.models[0]
    : undefined;

  const commitKey = useCallback(async (value: string): Promise<void> => {
    if (!group || !catalog || !value.trim() || !activeModel) return;
    const input = choiceUpsertInput(activeModel);
    if (!input) return;
    setKeySaveState("saving");
    const result = await applyModelBatch([{ ...input, apiKey: value.trim() }]);
    if (activeProviderRef.current !== group.provider) return;
    if (result) {
      setKeySaveState("saved");
      setKeyDraft(value.trim());
      // 新密钥通常立刻解锁真实模型列表。
      void refreshCatalog(group.provider, { force: true });
    } else {
      setKeySaveState("error");
      onNotify("密钥未能保存，请稍后重试");
    }
  }, [activeModel, applyModelBatch, catalog, choiceUpsertInput, group, onNotify, refreshCatalog]);

  const onKeyDraftChange = (value: string): void => {
    setKeyDraft(value);
    setKeyLoaded(true);
    setKeySaveState("idle");
    setTestResult(undefined);
    if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
    if (!value.trim()) return;
    keyTimerRef.current = setTimeout(() => { void commitKey(value); }, 900);
  };
  const flushKeyDraft = (): void => {
    if (keyTimerRef.current) clearTimeout(keyTimerRef.current);
    if (keyDraft.trim()) void commitKey(keyDraft);
  };

  const savedBaseUrl = connection?.baseUrl ?? catalog?.baseUrl ?? "";
  useEffect(() => {
    // 只回填未在编辑中的字段：防抖提交引发的 savedBaseUrl 变化不能覆盖正在输入的内容。
    if (baseUrlDirtyRef.current) return;
    setBaseUrlDraft(savedBaseUrl);
  }, [savedBaseUrl]);

  const commitBaseUrl = useCallback(async (value: string): Promise<void> => {
    if (!group || !catalog || !activeModel) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === savedBaseUrl) return;
    const input = choiceUpsertInput(activeModel);
    if (!input) return;
    const result = await applyModelBatch([{ ...input, baseUrl: trimmed }]);
    if (result && activeProviderRef.current === group.provider) onNotify("服务地址已保存");
  }, [activeModel, applyModelBatch, catalog, choiceUpsertInput, group, onNotify, savedBaseUrl]);

  const onBaseUrlDraftChange = (value: string): void => {
    setBaseUrlDraft(value);
    baseUrlDirtyRef.current = true;
    if (baseUrlTimerRef.current) clearTimeout(baseUrlTimerRef.current);
    baseUrlTimerRef.current = setTimeout(() => { void commitBaseUrl(value); }, 900);
  };
  const flushBaseUrlDraft = (): void => {
    if (baseUrlTimerRef.current) clearTimeout(baseUrlTimerRef.current);
    void commitBaseUrl(baseUrlDraft);
  };

  // ── 模型开关（单个 toggle 与全选/批量启停共用；一批变更只发一次事务） ──
  const toggleModels = useCallback(async (catalogModels: CatalogModel[], enabled: boolean): Promise<void> => {
    if (!group || !catalog || !catalogModels.length) return;
    const draft = settingsDraft.draft;
    if (!draft) return;
    const configuredModelIds = new Set(group.models.map((model) => model.model));
    const inputs = enabled ? catalogModels
      .filter((model) => !configuredModelIds.has(model.id))
      .map((model) => catalogModelUpsertInput(group.provider, catalog.value, connection?.protocol ?? catalog.protocol, model, {
        baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
        requiresApiKey: catalog.requiresApiKey,
        modelsRequiresApiKey: catalog.modelsRequiresApiKey
      })) : [];
    const providerProfiles = { ...draft.models.modelProfiles[group.provider] };
    for (const model of catalogModels) {
      // 开关只修改用户的显示偏好，不能删除模型或重建已保存的传输配置。
      const profile = { ...providerProfiles[model.id], showInPicker: enabled };
      providerProfiles[model.id] = profile;
    }
    // 开关直接提交，不先写入手动保存草稿，避免底栏短暂变成「未保存」。
    setSaving(true);
    try {
      await commitModels({
        ...draft.models,
        upserts: [...draft.models.upserts, ...inputs],
        modelProfiles: { ...draft.models.modelProfiles, [group.provider]: providerProfiles }
      });
    } finally {
      setSaving(false);
    }
  }, [catalog, commitModels, connection, group, settingsDraft]);

  const toggleModel = useCallback(async (catalogModel: CatalogModel, enabled: boolean): Promise<void> => {
    await toggleModels([catalogModel], enabled);
  }, [toggleModels]);

  // ── 连接默认格式：直接更新连接，保留各模型的单独覆盖 ──
  const changeApiFormat = useCallback(async (id: ConnectionApiFormat): Promise<boolean> => {
    const draft = settingsDraft.draft;
    if (!group || !draft) return false;
    if ((connection?.apiBackend ?? "auto") === id) return true;
    try {
      const result = await settingsDraft.saveModels({
        ...draft.models,
        providerApiFormats: { [group.provider]: id }
      });
      return result?.status === "committed";
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [connection?.apiBackend, group, onNotify, settingsDraft]);

  // ── 手动添加模型（目录滞后时的逃生通道） ──
  const [manualModelId, setManualModelId] = useState("");
  const submitManualModel = useCallback(async (): Promise<void> => {
    const id = manualModelId.trim();
    if (!id || !group || !catalog) return;
    if (group.models.some((model) => model.model === id)) {
      onNotify("该模型已在启用列表中");
      return;
    }
    setManualModelId("");
    await applyModelBatch([{
      alias: modelAliasFor(group.provider, id),
      displayName: id,
      providerAlias: group.provider,
      providerType: catalog.value,
      protocol: connection?.protocol ?? catalog.protocol,
      model: id,
      baseUrl: (connection?.baseUrl ?? catalog.baseUrl) || undefined,
      apiKeyEnv: undefined,
      requiresApiKey: catalog.requiresApiKey,
      modelsRequiresApiKey: catalog.modelsRequiresApiKey,
      supportsTools: true
    }]);
    onNotify(`已添加 ${id}`);
  }, [applyModelBatch, catalog, connection, group, manualModelId, onNotify]);

  // ── 模型元数据覆盖（sliders 弹窗）：能力/headers/profile 在同一个事务里落盘 ──
  const [profileTarget, setProfileTarget] = useState<{ providerAlias: string; model: ModelChoice }>();
  const saveModelOptions = useCallback(async (
    providerAlias: string,
    model: ModelChoice,
    options: {
      profile: ModelProfile | undefined;
      vision: boolean;
      tools: boolean;
      reasoning: boolean;
      headers: Record<string, string>;
      apiFormat: ApiFormatId | undefined;
    }
  ): Promise<void> => {
    const draft = settingsDraft.draft;
    if (!draft) return;
    const providerProfiles = { ...(draft.models.modelProfiles[providerAlias] ?? {}) };
    const profile = { ...options.profile, showInPicker: providerProfiles[model.model]?.showInPicker };
    providerProfiles[model.model] = profile;
    // 重置模型参数也保留显示开关，避免编辑停用模型时意外重新启用。
    const modelProfiles = { ...draft.models.modelProfiles, [providerAlias]: providerProfiles };
    // 乐观写入草稿，失败时由页脚保存兜底。
    settingsDraft.setModelProfile(providerAlias, model.model, profile);
    const format = options.apiFormat === undefined ? undefined : apiFormatOption(options.apiFormat);
    const input = choiceUpsertInput(model, {
      supportsTools: options.tools,
      supportsVision: options.vision,
      supportsThinking: options.reasoning,
      // 空对象明确清空模型级 Header；undefined 在普通更新中表示保留。
      headers: options.headers,
      protocol: format?.protocol ?? connection?.protocol ?? catalog?.protocol,
      apiBackend: format?.apiBackend,
      providerApiBackend: undefined,
      modelProfile: profile
    });
    if (input) await applyModelBatch([input], [], { modelProfiles });
  }, [applyModelBatch, catalog, choiceUpsertInput, connection, settingsDraft]);

  // ── 删除连接（两步确认；全部模型在同一个事务里删除） ──
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current); }, []);
  const deleteConnection = useCallback(async (): Promise<void> => {
    if (!group) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      deleteTimerRef.current = setTimeout(() => setDeleteArmed(false), 4_000);
      return;
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    if (models.length <= group.models.length) {
      onNotify("至少需要保留一个模型连接");
      return;
    }
    setDeleteArmed(false);
    const draft = settingsDraft.draft;
    if (!draft) return;
    setSaving(true);
    try {
      await commitModels(draft.models, [group.provider]);
    } finally {
      setSaving(false);
    }
  }, [commitModels, deleteArmed, group, models.length, onNotify, settingsDraft]);

  // ── 启用服务商（未连接的 API 条目）：用种子模型建连接，密钥随后在表单里补 ──
  const enableProvider = useCallback(async (entryCatalog: ProviderCatalogItem): Promise<void> => {
    const seed = entryCatalog.models[0];
    if (!seed) return;
    const alias = providerAliasFor(entryCatalog, entryCatalog.baseUrl);
    const result = await applyModelBatch([
      catalogModelUpsertInput(alias, entryCatalog.value, entryCatalog.protocol, seed, {
        baseUrl: entryCatalog.baseUrl || undefined,
        requiresApiKey: entryCatalog.requiresApiKey,
        modelsRequiresApiKey: entryCatalog.modelsRequiresApiKey,
        // 只有当前没有默认模型时才接管默认；已有默认时静默不动，避免打断进行中的会话。
        makeDefault: !defaultModelAlias
      })
    ]);
    if (result) void refreshCatalog(alias, { force: true });
  }, [applyModelBatch, defaultModelAlias, refreshCatalog]);

  // ── 自定义端点（未连接的 openai-compatible 条目）：地址 + 格式 + 密钥 → 拉模型 → 勾选 ──
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customFormat, setCustomFormat] = useState<ApiFormatId>("chat_completions");
  const [customModels, setCustomModels] = useState<CatalogModel[]>([]);
  const [customSelected, setCustomSelected] = useState<string[]>([]);
  const [customFetching, setCustomFetching] = useState(false);
  const customGenerationRef = useRef(0);
  useEffect(() => {
    setCustomBaseUrl("");
    setCustomApiKey("");
    setCustomFormat("chat_completions");
    setCustomModels([]);
    setCustomSelected([]);
    setCustomFetching(false);
    customGenerationRef.current += 1;
    setCatalogErrors((current) => ({ ...current, custom: undefined }));
  }, [activeKey]);

  const loadCustomModels = useCallback(async (_announce: boolean): Promise<void> => {
    if (!catalog) return;
    const baseUrl = customBaseUrl.trim();
    if (!baseUrl) {
      setCatalogErrors((current) => ({ ...current, custom: "请先填写服务地址再获取模型。" }));
      return;
    }
    const generation = ++customGenerationRef.current;
    setCustomFetching(true);
    setCatalogErrors((current) => ({ ...current, custom: undefined }));
    try {
      const providerAlias = providerAliasFor(catalog, baseUrl);
      const seed = catalog.models[0];
      const format = apiFormatOption(customFormat);
      const result = await onFetchCatalogCandidate({
        alias: modelAliasFor(providerAlias, seed?.id ?? "probe"),
        displayName: seed?.displayName ?? seed?.id ?? "probe",
        providerAlias,
        providerType: catalog.value,
        protocol: format.protocol,
        model: seed?.id ?? "probe",
        baseUrl,
        apiKey: customApiKey.trim() || undefined,
        requiresApiKey: catalog.requiresApiKey,
        modelsRequiresApiKey: catalog.modelsRequiresApiKey,
        supportsTools: true,
        supportsThinking: seed?.supportsThinking,
        apiBackend: format.apiBackend
      });
      if (generation !== customGenerationRef.current) return;
      const loaded = result.models.map(catalogModelFromEntry);
      setCustomModels(loaded);
      // 实时目录失败后不代替用户勾选，避免把账号未开放的模型自动存为默认。
      setCustomSelected(loaded[0] ? [loaded[0].id] : []);

    } catch (error) {
      if (generation !== customGenerationRef.current) return;
      setCustomModels([]);
      setCustomSelected([]);
      setCatalogErrors((current) => ({ ...current, custom: providerErrorMessage(error) }));
    } finally {
      if (generation === customGenerationRef.current) setCustomFetching(false);
    }
  }, [catalog, customApiKey, customBaseUrl, customFormat, onFetchCatalogCandidate]);

  /** 换格式后旧目录不可信（不同协议的 /models 形状不同），清空候选。 */
  const changeCustomFormat = (id: ApiFormatId): void => {
    setCustomFormat(id);
    setCustomModels([]);
    setCustomSelected([]);
  };

  const connectCustom = useCallback(async (): Promise<void> => {
    if (!catalog) return;
    const baseUrl = customBaseUrl.trim();
    const candidates = customModels.filter((model) => customSelected.includes(model.id));
    if (!baseUrl || !candidates.length) return;
    const providerAlias = providerAliasFor(catalog, baseUrl);
    const format = apiFormatOption(customFormat);
    // 勾选的全部模型在同一个事务里建连接；只有首个模型在无默认时接管默认。
    const result = await applyModelBatch(candidates.map((model, index) =>
      catalogModelUpsertInput(providerAlias, catalog.value, format.protocol, model, {
        baseUrl,
        apiKey: customApiKey.trim() || undefined,
        requiresApiKey: catalog.requiresApiKey,
        modelsRequiresApiKey: catalog.modelsRequiresApiKey,
        apiBackend: model.apiBackend ?? format.apiBackend,
        makeDefault: index === 0 && !defaultModelAlias
      })));
    if (result) {
      setCustomApiKey("");
      onNotify("自定义服务已连接");
      void refreshCatalog(providerAlias, { force: true });
    }
  }, [applyModelBatch, catalog, customApiKey, customBaseUrl, customFormat, customModels, customSelected, defaultModelAlias, onNotify, refreshCatalog]);

  // ── 订阅登录（Claude Code / Codex） ──
  const [loginStage, setLoginStage] = useState<"idle" | "opening" | "waiting" | "submitted">("idle");
  const [loginRequest, setLoginRequest] = useState<DesktopModelLoginStartResult>();
  const [loginError, setLoginError] = useState<string>();
  const [authorizationCode, setAuthorizationCode] = useState("");
  const loginRequestRef = useRef<DesktopModelLoginStartResult | undefined>(undefined);
  const loginProviderRef = useRef<DesktopModelLoginProvider | undefined>(undefined);
  const loginActionRef = useRef(false);
  const loginGenerationRef = useRef(0);
  const onCancelLoginRef = useRef(onCancelLogin);
  useEffect(() => { onCancelLoginRef.current = onCancelLogin; }, [onCancelLogin]);

  /** 放弃进行中的登录：换面板、关设置、卸载组件共用这一个清理路径。 */
  const resetLogin = useCallback((notifyCancel: boolean): void => {
    loginGenerationRef.current += 1;
    const request = loginRequestRef.current;
    const provider = loginProviderRef.current;
    if (notifyCancel && request && provider) void onCancelLoginRef.current(provider, request.authRequestId);
    loginRequestRef.current = undefined;
    loginProviderRef.current = undefined;
    loginActionRef.current = false;
    setLoginRequest(undefined);
    setLoginStage("idle");
    setLoginError(undefined);
    setAuthorizationCode("");
  }, []);
  useEffect(() => {
    cancelLoginRef.current = () => resetLogin(true);
  }, [resetLogin]);

  const completeLoginRequest = useCallback(async (
    entryCatalog: ProviderCatalogItem,
    request: DesktopModelLoginStartResult,
    pastedAuthorization?: string
  ): Promise<void> => {
    if (!entryCatalog.loginProvider) return;
    const generation = loginGenerationRef.current;
    setLoginStage("submitted");
    setLoginError(undefined);
    try {
      const result = await onCompleteLogin(entryCatalog.loginProvider, request.authRequestId,
        request.method === "paste-code" ? pastedAuthorization : undefined);
      if (generation !== loginGenerationRef.current) return;
      // 登录返回的模型与凭据句柄立即成组落盘；句柄正文不进渲染层。
      const draft = settingsDraft.draft;
      const alias = providerAliasFor(entryCatalog, entryCatalog.baseUrl);
      if (draft) {
        // addOauthCredentialHandle 是异步 setState，紧随其后的提交必须显式带上句柄。
        settingsDraft.addOauthCredentialHandle(result.handle);
        const oauthCredentialHandles = draft.models.oauthCredentialHandles.includes(result.handle)
          ? draft.models.oauthCredentialHandles
          : [...draft.models.oauthCredentialHandles, result.handle];
        await commitModels({
          ...draft.models,
          oauthCredentialHandles,
          upserts: [
            ...draft.models.upserts.filter((item) => !result.models.some((model) => item.alias === modelAliasFor(alias, model.id))),
            ...result.models.map((model, index) => ({
              alias: modelAliasFor(alias, model.id),
              displayName: model.displayName,
              providerAlias: alias,
              providerType: entryCatalog.value,
              protocol: entryCatalog.protocol,
              model: model.id,
              baseUrl: entryCatalog.baseUrl || undefined,
              apiKeyEnv: undefined,
              requiresApiKey: entryCatalog.requiresApiKey,
              supportsTools: true,
              supportsThinking: model.supportsThinking,
              makeDefault: index === 0 && !defaultModelAlias
            }))
          ],
          removeAliases: draft.models.removeAliases.filter((candidate) => !result.models.some((model) => candidate === modelAliasFor(alias, model.id)))
        });
      }
      resetLogin(false);
      onNotify(`连接成功 · ${entryCatalog.label}`);
    } catch (error) {
      if (generation !== loginGenerationRef.current) return;
      // 一次性授权请求失败后主进程会清理 authRequestId；保留旧请求只会稳定报“授权会话不存在”。
      const message = error instanceof Error ? error.message : String(error);
      const canRetryPaste = request.method === "paste-code"
        && (message.includes("授权码格式不正确") || message.includes("state 校验失败"));
      setLoginStage(canRetryPaste ? "waiting" : "idle");
      if (!canRetryPaste) resetLogin(false);
      setLoginError(message);
    }
  }, [commitModels, defaultModelAlias, onCompleteLogin, onNotify, resetLogin, settingsDraft]);

  const startLogin = useCallback(async (entryCatalog: ProviderCatalogItem): Promise<void> => {
    if (!entryCatalog.loginProvider || loginActionRef.current) return;
    const generation = loginGenerationRef.current;
    loginActionRef.current = true;
    setLoginStage("opening");
    setLoginError(undefined);
    try {
      const request = await onStartLogin(entryCatalog.loginProvider);
      if (generation !== loginGenerationRef.current) {
        void onCancelLoginRef.current(entryCatalog.loginProvider, request.authRequestId);
        return;
      }
      loginProviderRef.current = entryCatalog.loginProvider;
      loginRequestRef.current = request;
      setLoginRequest(request);
      if (request.method === "browser-callback") {
        // 本地回调由主进程等待；回调到达后自动换 token 和验证模型。
        void completeLoginRequest(entryCatalog, request);
      } else {
        setLoginStage("waiting");
      }
    } catch (error) {
      loginActionRef.current = false;
      setLoginStage("idle");
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  }, [completeLoginRequest, onStartLogin]);

  const submitLogin = useCallback(async (entryCatalog: ProviderCatalogItem): Promise<void> => {
    if (!entryCatalog.loginProvider || !loginRequest) return;
    await completeLoginRequest(entryCatalog, loginRequest, authorizationCode);
  }, [authorizationCode, completeLoginRequest, loginRequest]);

  const relogin = useCallback((entryCatalog: ProviderCatalogItem): void => {
    // 已保存配置记录了 OAuth 来源；重新登录复用同一张卡片。
    if (!entryCatalog.loginProvider) {
      onNotify("该连接没有可用的登录方式。");
      return;
    }
    resetLogin(true);
    void startLogin(entryCatalog);
  }, [onNotify, resetLogin, startLogin]);

  const usesOAuth = connection?.authMode === "oauth-bearer";
  const status = connectionStatus(connection);
  const apiKeyUrl = catalog?.apiKeyUrl;

  return (
    <div className="provider-settings">
      <header className="provider-settings-toolbar">
        <label className="provider-list-search">
          <Icon name="search" size={14} />
          <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务商" value={query} />
        </label>
        <button className="ghost-button" onClick={() => { setQuery(""); setActiveKey("openai-compatible"); }} type="button"><Icon name="add" size={14} />添加自定义服务商</button>
      </header>
      <aside aria-label="服务商列表" className="provider-list-pane">
        <div className="provider-list-rows" role="tablist">
          {loading && !entries.length ? (
            [0, 1, 2, 3].map((index) => (
              <div aria-hidden="true" className="provider-row provider-row-skeleton" key={index}>
                <span className="provider-mark skeleton-pulse" />
                <span className="provider-row-copy">
                  <span className="skeleton-line skeleton-pulse is-wide" />
                  <span className="skeleton-line skeleton-pulse" />
                </span>
              </div>
            ))
          ) : filteredEntries.map((row) => {
            const rowStatus = connectionStatus(row.connection);
            const rowEnabled = row.group?.models.some((model) => model.showInPicker !== false) === true;
            const healthy = rowEnabled && rowStatus === null;
            return (
              <button
                aria-selected={activeEntry?.key === row.key}
                className={`provider-row${activeEntry?.key === row.key ? " is-active" : ""}`}
                key={row.key}
                onClick={() => setActiveKey(row.key)}
                role="tab"
                type="button"
              >
                <span className={`provider-mark is-${row.iconTone}`}><ProviderBrandGlyph type={row.iconTone} /></span>
                <span className="provider-row-copy">
                  <strong>{row.label}</strong>
                  {row.badge ? <small>{row.badge}</small> : null}
                </span>
                <Tooltip
                  content={rowEnabled ? rowStatus?.label ?? "已启用" : "未启用"}
                >
                  <span
                    aria-hidden="true"
                    className={`provider-status-dot${healthy ? " is-ok" : rowEnabled && rowStatus ? ` is-${rowStatus.tone}` : ""}`}
                  />
                </Tooltip>
              </button>
            );
          })}
          {!loading && !filteredEntries.length ? <div className="provider-list-empty">没有匹配的服务商</div> : null}
        </div>
        <footer className="provider-list-footer">
          <Icon name="info" size={13} />
          <span>找不到服务商？用「自定义 OpenAI 兼容接口」接入任意中转站或网关。</span>
        </footer>
      </aside>

      <CatalogErrorContext.Provider value={catalogErrors[group?.provider ?? "custom"]}>
      <section aria-label="服务商配置" className="provider-detail-pane" ref={detailPaneRef}>
        {notices[activeEntry?.key ?? "custom"] ? <div className="provider-inline-notice" role="status"><span>{notices[activeEntry?.key ?? "custom"]}</span><button type="button" aria-label="关闭提示" onClick={() => setNotices((current) => ({ ...current, [activeEntry?.key ?? "custom"]: "" }))}><Icon name="close" size={14} /></button></div> : null}
        {!activeEntry || (loading && !entries.length) ? (
          <div className="provider-detail-skeleton">
            <span className="skeleton-line skeleton-pulse is-wide" />
            <span className="skeleton-line skeleton-pulse" />
            <span className="skeleton-line skeleton-pulse" />
          </div>
        ) : activeEntry.catalog?.connectionMode === "login" || (usesOAuth && activeEntry.catalog) ? (
          <LoginProviderPanel
            catalog={activeEntry.catalog}
            connection={connection}
            group={group}
            stage={loginStage}
            loginRequest={loginRequest}
            error={loginError}
            authorizationCode={authorizationCode}
            availableModels={availableModels}
            defaultModelAlias={defaultModelAlias}
            fetchingCatalog={fetchingAlias === group?.provider}
            onAuthorizationCode={setAuthorizationCode}
            onStart={() => activeEntry.catalog && void startLogin(activeEntry.catalog)}
            onSubmit={() => activeEntry.catalog && void submitLogin(activeEntry.catalog)}
            onRelogin={() => activeEntry.catalog && relogin(activeEntry.catalog)}
            onRefreshCatalog={() => group && void refreshCatalog(group.provider, { force: true, announce: true })}
            onToggleModel={toggleModel}
            onToggleMany={toggleModels}
            manualModelId={manualModelId}
            onManualModelId={setManualModelId}
            onSubmitManualModel={() => void submitManualModel()}
            onOpenModelOptions={(model) => group && setProfileTarget({ providerAlias: group.provider, model })}
            onDefaultModel={onDefaultModel}
            onTest={runTest}
            testing={testing}
            testResult={testResult}
            testConfiguration={testConfiguration}
            testMenuOpen={testMenuOpen}
            setTestMenuOpen={setTestMenuOpen}
          />
        ) : group && catalog ? (
          <ConnectedProviderPanel
            key={group.provider}
            catalog={catalog}
            connection={connection}
            group={group}
            status={status}
            availableModels={availableModels}
            defaultModelAlias={defaultModelAlias}
            keyDraft={keyDraft}
            keySaveState={keySaveState}
            keyLoading={keyLoading}
            keyLoaded={keyLoaded}
            baseUrlDraft={baseUrlDraft}
            savedBaseUrl={savedBaseUrl}
            fetchingCatalog={fetchingAlias === group.provider}
            saving={saving}
            testing={testing}
            testResult={testResult}
            testMenuOpen={testMenuOpen}
            deleteArmed={deleteArmed}
            manualModelId={manualModelId}
            usesOAuth={usesOAuth}
            onApiKeyChange={onKeyDraftChange}
            onApiKeyBlur={flushKeyDraft}
            onLoadApiKey={loadKey}
            onBaseUrlChange={onBaseUrlDraftChange}
            onBaseUrlBlur={flushBaseUrlDraft}
            onChangeApiFormat={changeApiFormat}
            onOpenExternal={onOpenExternal}
            onRefreshCatalog={() => void refreshCatalog(group.provider, { force: true, announce: true })}
            onToggleModel={toggleModel}
            onToggleMany={toggleModels}
            onManualModelId={setManualModelId}
            onSubmitManualModel={() => void submitManualModel()}
            onOpenModelOptions={(model) => setProfileTarget({ providerAlias: group.provider, model })}
            onDefaultModel={onDefaultModel}
            onTest={runTest}
            onTestMenuOpen={setTestMenuOpen}
            testConfiguration={testConfiguration}
            onDeleteConnection={() => void deleteConnection()}
            onRelogin={() => relogin(catalog)}
          />
        ) : catalog && catalog.baseUrl ? (
          <section className="provider-panel">
            <header className="provider-panel-head">
              <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
              <div className="provider-panel-title">
                <h3>{catalog.label}</h3>
                <p>{catalog.description}</p>
              </div>
            </header>
            <div className="provider-enable-card">
              <strong>启用 {catalog.label}</strong>
              <p>先用默认模型建立连接，密钥可以之后再填。{catalog.requiresApiKey ? "正式使用前需要在下方粘贴 API Key。" : "该服务无需密钥。"}</p>
              <button className="settings-primary-button" disabled={saving} onClick={() => void enableProvider(catalog)} type="button">
                {saving ? "启用中…" : "启用服务商"}
              </button>
              {apiKeyUrl ? (
                <a className="settings-link provider-key-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取密钥<Icon name="external" size={11} /></a>
              ) : null}
            </div>
          </section>
        ) : catalog ? (
          <CustomProviderPanel
            catalog={catalog}
            baseUrl={customBaseUrl}
            apiKey={customApiKey}
            format={customFormat}
            models={customModels}
            selected={customSelected}
            fetching={customFetching}
            saving={saving}
            onBaseUrl={setCustomBaseUrl}
            onApiKey={setCustomApiKey}
            onFormat={changeCustomFormat}
            onLoadModels={() => void loadCustomModels(true)}
            onToggleModel={(modelId) => setCustomSelected((current) => current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId])}
            onSelectedChange={setCustomSelected}
            onConnect={() => void connectCustom()}
          />
        ) : null}
      </section>
      </CatalogErrorContext.Provider>

      {profileTarget ? (
        <ModelOptionsDialog
          apiFormat={profileTarget.model.apiBackend !== undefined || connection?.apiBackend !== undefined
            ? apiFormatForConnection(connection?.protocol ?? catalog?.protocol, profileTarget.model.apiBackend ?? connection?.apiBackend)
            : recommendedApiFormat(connection?.providerType ?? catalog?.value ?? "openai-compatible", connection?.protocol ?? catalog?.protocol)}
          apiFormatOptions={catalog?.id === "custom"
            ? apiFormatOptions
            : catalog
              ? apiFormatOptionsForConnection(catalog.value, connection?.protocol ?? catalog.protocol, connection?.baseUrl ?? catalog.baseUrl)
              : apiFormatOptions}
          autoModel={availableModels.find((model) => model.id === profileTarget.model.model)}
          target={profileTarget}
          onClose={() => setProfileTarget(undefined)}
          onSave={(options) => void saveModelOptions(profileTarget.providerAlias, profileTarget.model, options)}
        />
      ) : null}
    </div>
  );
}

/** 订阅账号面板：未登录时是登录卡，登录后是账号状态 + 模型列表。 */
function LoginProviderPanel({
  catalog,
  connection,
  group,
  stage,
  loginRequest,
  error,
  authorizationCode,
  availableModels,
  defaultModelAlias,
  fetchingCatalog,
  onAuthorizationCode,
  onStart,
  onSubmit,
  onRelogin,
  onRefreshCatalog,
  onToggleModel,
  onToggleMany,
  manualModelId,
  onManualModelId,
  onSubmitManualModel,
  onOpenModelOptions,
  onDefaultModel,
  onTest,
  testing,
  testResult,
  testConfiguration,
  testMenuOpen,
  setTestMenuOpen
}: {
  catalog: ProviderCatalogItem;
  connection?: DesktopModelConnection;
  group?: ConnectionGroup;
  stage: "idle" | "opening" | "waiting" | "submitted";
  loginRequest?: DesktopModelLoginStartResult;
  error?: string;
  authorizationCode: string;
  availableModels: CatalogModel[];
  defaultModelAlias?: string;
  fetchingCatalog: boolean;
  onAuthorizationCode(value: string): void;
  onStart(): void;
  onSubmit(): void;
  onRelogin(): void;
  onRefreshCatalog(): void;
  onToggleModel(model: CatalogModel, enabled: boolean): Promise<void>;
  onToggleMany(models: CatalogModel[], enabled: boolean): Promise<void>;
  manualModelId: string;
  onManualModelId(value: string): void;
  onSubmitManualModel(): void;
  onOpenModelOptions(model: ModelChoice): void;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  onTest(model: ModelChoice): Promise<void>;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  testConfiguration(model: ModelChoice): DesktopModelConfigurationInput | undefined;
  testMenuOpen: boolean;
  setTestMenuOpen(open: boolean): void;
}): React.JSX.Element {
  const [modelQuery, setModelQuery] = useState("");
  const waiting = stage !== "idle";
  const usesPasteCode = loginRequest?.method === "paste-code";
  const authenticated = Boolean(group && connection?.hasCredential && !connectionStatus(connection));
  const subscriptionTitle = catalog.id === "claude-code" ? "Claude 订阅 (Pro / Max)" : `${catalog.label} 订阅`;
  const authorizationHost = catalog.id === "claude-code" ? "Claude.ai" : "ChatGPT";
  const normalizedQuery = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = normalizedQuery
    ? availableModels.filter((model) => `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery))
    : availableModels;
  return (
    <section className="provider-panel">
      <header className="provider-panel-head">
        <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
        <div className="provider-panel-title">
          <h3>{catalog.label}{catalog.badge ? <span className="provider-panel-badge">{catalog.badge}</span> : null}</h3>
          <p>{catalog.description}</p>
        </div>
        {group ? (
          <TestConnectionButton
            models={group.models}
            testing={testing}
            open={testMenuOpen}
            onOpen={setTestMenuOpen}
            onTest={onTest}
            testConfiguration={testConfiguration}
          />
        ) : null}
      {group ? <ProviderToggle group={group} /> : null}
      </header>

      {testResult ? <ConnectionTestResult result={testResult} /> : null}

      <div className={`login-subscription-card${authenticated ? " is-ok" : ""}`}>
        <div className="login-subscription-heading">
          <div>
            <strong>{subscriptionTitle}</strong>
            <small>通过官方 OAuth 登录使用订阅配额。</small>
          </div>
          {authenticated
            ? <span className="status-pill is-ok">已登录</span>
            : waiting
              ? <span className="login-status is-waiting">{stage === "submitted" ? "正在验证..." : stage === "opening" ? "正在打开..." : "等待登录..."}</span>
              : <span className="login-status">未登录</span>}
        </div>
        {authenticated ? (
          <>
            <p>{oauthExpiryHint(connection?.oauthExpiresAt)}</p>
            <button className="ghost-button" onClick={onRelogin} type="button">重新登录</button>
          </>
        ) : !waiting ? (
          <>
            <p>使用订阅配额前需要先通过官方 OAuth 登录。</p>
            <button className="settings-primary-button" onClick={onStart} type="button">登录 {catalog.label}</button>
          </>
        ) : (
          <p>{usesPasteCode ? "请在浏览器完成登录后粘贴授权码。" : stage === "submitted" ? "已收到浏览器回调，正在自动验证账号。" : "请在弹出的浏览器窗口完成登录，浏览器会自动返回此应用。"}</p>
        )}
        {waiting && usesPasteCode ? (
          <div className="login-code-panel">
            <p>在 {authorizationHost} 完成登录后，会跳转到控制台显示一段授权码（含 <code>#</code> 分隔符），把它粘贴到下面：</p>
            <small>提示：你的 state 以 <code>{loginRequest?.stateHint}</code> 开头。</small>
            <textarea
              autoFocus
              onChange={(event) => onAuthorizationCode(event.target.value)}
              placeholder="粘贴授权码（格式：xxx#yyy）"
              value={authorizationCode}
            />
            <div className="login-code-actions">
              <button className="settings-primary-button" disabled={!authorizationCode.trim() || stage === "submitted"} onClick={onSubmit} type="button">提交授权码</button>
              <button onClick={onStart} type="button">重新开始登录</button>
            </div>
          </div>
        ) : null}
        {error ? <p className="login-error" role="alert">{error}</p> : null}
      </div>

      {/* key：换服务商即重置面板内的搜索词与展开状态，避免上一家的过滤条件残留。 */}
      {group ? (
        <ModelsSection
          key={catalog.id}
          models={filteredModels}
          enabledModels={group.models}
          defaultModelAlias={defaultModelAlias}
          query={modelQuery}
          onQuery={setModelQuery}
          fetchingCatalog={fetchingCatalog}
          onRefreshCatalog={onRefreshCatalog}
          onToggleModel={onToggleModel}
          onToggleMany={onToggleMany}
          onOpenModelOptions={onOpenModelOptions}
          onDefaultModel={onDefaultModel}
          manualModelId={manualModelId}
          onManualModelId={onManualModelId}
          onSubmitManualModel={onSubmitManualModel}
        />
      ) : null}
    </section>
  );
}

/** 已连接的服务商面板：凭据行 + 模型管理 + 危险区。 */
function ConnectedProviderPanel({
  catalog,
  connection,
  group,
  status,
  availableModels,
  defaultModelAlias,
  keyDraft,
  keySaveState,
  keyLoading,
  keyLoaded,
  baseUrlDraft,
  savedBaseUrl,
  fetchingCatalog,
  saving,
  testing,
  testResult,
  testMenuOpen,
  deleteArmed,
  manualModelId,
  usesOAuth,
  onApiKeyChange,
  onApiKeyBlur,
  onLoadApiKey,
  onBaseUrlChange,
  onBaseUrlBlur,
  onChangeApiFormat,
  onOpenExternal,
  onRefreshCatalog,
  onToggleModel,
  onToggleMany,
  onManualModelId,
  onSubmitManualModel,
  onOpenModelOptions,
  onDefaultModel,
  onTest,
  onTestMenuOpen,
  testConfiguration,
  onDeleteConnection,
  onRelogin
}: {
  catalog: ProviderCatalogItem;
  connection?: DesktopModelConnection;
  group: ConnectionGroup;
  status: { label: string; tone: "warn" | "error" } | null;
  availableModels: CatalogModel[];
  defaultModelAlias?: string;
  keyDraft: string;
  keySaveState: "idle" | "saving" | "saved" | "error";
  keyLoading: boolean;
  keyLoaded: boolean;
  baseUrlDraft: string;
  savedBaseUrl: string;
  fetchingCatalog: boolean;
  saving: boolean;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  testMenuOpen: boolean;
  deleteArmed: boolean;
  manualModelId: string;
  usesOAuth: boolean;
  onApiKeyChange(value: string): void;
  onApiKeyBlur(): void;
  onLoadApiKey(): Promise<void>;
  onBaseUrlChange(value: string): void;
  onBaseUrlBlur(): void;
  onChangeApiFormat(id: ConnectionApiFormat): Promise<boolean>;
  onOpenExternal(url: string): Promise<void>;
  onRefreshCatalog(): void;
  onToggleModel(model: CatalogModel, enabled: boolean): Promise<void>;
  onToggleMany(models: CatalogModel[], enabled: boolean): Promise<void>;
  onManualModelId(value: string): void;
  onSubmitManualModel(): void;
  onOpenModelOptions(model: ModelChoice): void;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  onTest(model: ModelChoice): Promise<void>;
  onTestMenuOpen(open: boolean): void;
  testConfiguration(model: ModelChoice): DesktopModelConfigurationInput | undefined;
  onDeleteConnection(): void;
  onRelogin(): void;
}): React.JSX.Element {
  const [modelQuery, setModelQuery] = useState("");
  const normalizedQuery = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = normalizedQuery
    ? availableModels.filter((model) => `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery))
    : availableModels;
  const apiKeyUrl = catalog.apiKeyUrl;
  const isCustomEndpoint = catalog.id === "custom" || !catalog.baseUrl;
  const [showKey, setShowKey] = useState(false);
  const automaticFormat = recommendedApiFormat(catalog.value, connection?.protocol ?? catalog.protocol);
  const persistedApiFormat = connection?.apiBackend ? apiFormatForConnection(connection.protocol, connection.apiBackend) : isCustomEndpoint ? automaticFormat : "auto";
  const [apiFormat, setApiFormat] = useState<ConnectionApiFormat>(persistedApiFormat);
  const pendingApiFormatRef = useRef<ConnectionApiFormat | undefined>(undefined);
  useEffect(() => {
    const pending = pendingApiFormatRef.current;
    if (pending !== undefined && persistedApiFormat !== pending) return;
    pendingApiFormatRef.current = undefined;
    setApiFormat(persistedApiFormat);
  }, [persistedApiFormat]);
  const formatOptions = catalog.id === "custom"
    ? apiFormatOptions
    : apiFormatOptionsForConnection(
      catalog.value,
      connection?.protocol ?? catalog.protocol,
      connection?.baseUrl ?? catalog.baseUrl
    );
  const fieldPrefix = `provider-${group.provider.replace(/[^a-z0-9_-]/gi, "-")}`;
  // 未被编辑过的已保存地址不提示版本路径问题：DeepSeek / Anthropic 等官方默认地址
  // 本来就不带 /v1，照抄提示会一直吓唬用户。
  const showVersionHint = baseUrlNeedsVersionHint(baseUrlDraft) && baseUrlDraft.trim() !== savedBaseUrl;
  const connectionFields = (
    <div className="provider-connection-fields">
      {isCustomEndpoint ? (
        <div className="provider-row-item">
          <label className="provider-row-label" htmlFor={`${fieldPrefix}-base-url`}>服务地址</label>
          <input
            id={`${fieldPrefix}-base-url`}
            onBlur={onBaseUrlBlur}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onBaseUrlBlur(); } }}
            placeholder="留空使用服务商默认地址"
            value={baseUrlDraft}
          />
          {showVersionHint
            ? <div className="provider-row-warning"><Icon name="info" size={12} />部分服务商要求地址以版本路径结尾（如 /v1），请求失败时可尝试追加。</div>
            : isCustomEndpoint ? <div className="provider-row-hint">填写网关的完整地址。</div> : null}
        </div>
      ) : null}

      {/* 内置服务商使用已知协议；仅自定义连接或已有覆盖需要显示选择入口。 */}
      {catalog.connectionMode === "api" && (isCustomEndpoint || connection?.apiBackend !== undefined) ? (
        <div className="provider-row-item">
          <label className="provider-row-label" htmlFor={`${fieldPrefix}-api-format`}>API 格式</label>
          <NativeSelect
            className="connection-select"
            id={`${fieldPrefix}-api-format`}
            onChange={(event) => {
              const next = event.target.value as ConnectionApiFormat;
              pendingApiFormatRef.current = next;
              setApiFormat(next);
              void onChangeApiFormat(next).then((saved) => {
                if (!saved && pendingApiFormatRef.current === next) {
                  pendingApiFormatRef.current = undefined;
                  setApiFormat(persistedApiFormat);
                }
              });
            }}
            value={apiFormat}
          >
            {!isCustomEndpoint ? <option value="auto">自动（厂商推荐）</option> : null}
            {formatOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </NativeSelect>
          <div className="provider-row-hint">模型默认跟随连接，单个模型可在模型选项中覆盖。</div>
        </div>
      ) : null}
    </div>
  );
  return (
    <section className="provider-panel">
      <header className="provider-panel-head">
        <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
        <div className="provider-panel-title">
          <h3>
            {catalog.label}
            {status
              ? <span className={`status-pill is-${status.tone}`}>{status.label}</span>
              : <span className="status-pill">{group.models.some((model) => model.showInPicker !== false) ? "已启用" : "未启用"}</span>}
          </h3>
        </div>
        <TestConnectionButton
          defaultModelAlias={defaultModelAlias}
          models={group.models}
          testing={testing}
          open={testMenuOpen}
          onOpen={onTestMenuOpen}
          onTest={onTest}
          testConfiguration={testConfiguration}
        />
      {group ? <ProviderToggle group={group} /> : null}
      </header>

      {testResult ? <ConnectionTestResult result={testResult} /> : null}

      {usesOAuth ? (
        <div className={`provider-oauth-card${status ? " is-attention" : ""}`}>
          <div className="login-subscription-heading">
            <div>
              <strong>订阅登录</strong>
              <small>{status ? "该连接的授权已失效，重新登录后即可继续使用。" : oauthExpiryHint(connection?.oauthExpiresAt)}</small>
            </div>
            {status ? <span className={`status-pill is-${status.tone}`}>{status.label}</span> : null}
          </div>
          <button className="ghost-button" onClick={onRelogin} type="button">重新登录</button>
        </div>
      ) : (
        <div className="provider-rows">
          <div className="provider-row-item">
            <div className="provider-row-heading">
              <label className="provider-row-label" htmlFor={`${fieldPrefix}-api-key`}>API Key</label>
              {apiKeyUrl ? (
                <a className="settings-link provider-key-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取密钥<Icon name="external" size={11} /></a>
              ) : null}
            </div>
            <div className="secret-input-row">
              <input
                autoComplete="off"
                id={`${fieldPrefix}-api-key`}
                disabled={keyLoading}
                onBlur={onApiKeyBlur}
                onChange={(event) => onApiKeyChange(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onApiKeyBlur(); } }}
                placeholder={keyLoading
                  ? "正在读取…"
                  : connection?.hasCredential && !keyLoaded
                    ? "已保存；点按右侧图标查看"
                    : connection?.requiresApiKey === false ? "可选" : "粘贴 API Key，自动保存"}
                type={showKey ? "text" : "password"}
                value={keyDraft}
              />
              <button
                className="icon-button"
                type="button"
                aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                onClick={() => {
                  if (showKey) {
                    setShowKey(false);
                    return;
                  }
                  void onLoadApiKey().then(() => setShowKey(true)).catch(() => undefined);
                }}
              ><Icon name={showKey ? "eye-off" : "eye"} size={16} /></button>
            </div>
            <div className="provider-row-hint">
              {keySaveState === "saving" ? <span className="provider-key-state is-busy">正在保存密钥…</span>
                : keySaveState === "saved" ? <span className="provider-key-state is-ok">密钥已保存</span>
                : keySaveState === "error" ? <span className="provider-key-state is-error">密钥保存失败，请重试</span>
                : credentialHint(connection)}
            </div>
          </div>

          {isCustomEndpoint || connection?.apiBackend !== undefined ? connectionFields : null}

        </div>
      )}

      <ModelsSection
        key={group.provider}
        models={filteredModels}
        enabledModels={group.models}
        defaultModelAlias={defaultModelAlias}
        query={modelQuery}
        onQuery={setModelQuery}
        fetchingCatalog={fetchingCatalog}
        onRefreshCatalog={onRefreshCatalog}
        onToggleModel={onToggleModel}
        onToggleMany={onToggleMany}
        onOpenModelOptions={onOpenModelOptions}
        onDefaultModel={onDefaultModel}
        manualModelId={manualModelId}
        onManualModelId={onManualModelId}
        onSubmitManualModel={onSubmitManualModel}
      />

      <section className="provider-danger-zone">
        <div className="provider-danger-copy">
          <strong>删除连接</strong>
          <span>删除此连接的全部模型与本地凭据引用，无法撤销。</span>
        </div>
        <button className="danger-button" disabled={saving} onClick={onDeleteConnection} type="button">
          {deleteArmed ? "确认删除？" : "删除"}
        </button>
      </section>
    </section>
  );
}

/** 自定义端点（未连接）：地址 + 格式 + 密钥 → 拉模型 → 勾选启用。 */
function CustomProviderPanel({
  catalog,
  baseUrl,
  apiKey,
  format,
  models,
  selected,
  fetching,
  saving,
  onBaseUrl,
  onApiKey,
  onFormat,
  onLoadModels,
  onToggleModel,
  onSelectedChange,
  onConnect
}: {
  catalog: ProviderCatalogItem;
  baseUrl: string;
  apiKey: string;
  format: ApiFormatId;
  models: CatalogModel[];
  selected: string[];
  fetching: boolean;
  saving: boolean;
  onBaseUrl(value: string): void;
  onApiKey(value: string): void;
  onFormat(id: ApiFormatId): void;
  onLoadModels(): void;
  onToggleModel(modelId: string): void;
  onSelectedChange(ids: string[]): void;
  onConnect(): void;
}): React.JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const keyMissing = catalog.requiresApiKey && !apiKey.trim();
  const canConnect = !saving && !fetching && !keyMissing && Boolean(baseUrl.trim()) && selected.length > 0;
  return (
    <section className="provider-panel">
      <header className="provider-panel-head">
        <span className={`provider-mark is-${catalog.iconTone} is-large`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
        <div className="provider-panel-title">
          <h3>{catalog.label}<span className="provider-panel-badge">{catalog.badge}</span></h3>
          <p>{catalog.description}</p>
        </div>
      </header>

      <div className="provider-rows">
        <div className="provider-row-item">
          <label className="provider-row-label" htmlFor="custom-provider-base-url">服务地址</label>
          <input
            autoFocus
            id="custom-provider-base-url"
            onChange={(event) => onBaseUrl(event.target.value)}
            placeholder={apiFormatOption(format).baseUrlPlaceholder}
            value={baseUrl}
          />
          {baseUrlNeedsVersionHint(baseUrl)
            ? <div className="provider-row-warning"><Icon name="info" size={12} />部分服务商要求地址以版本路径结尾（如 /v1），请求失败时可尝试追加。</div>
            : null}
        </div>
        <div className="provider-row-item">
          <label className="provider-row-label" htmlFor="custom-provider-api-format">API 格式</label>
          <NativeSelect className="connection-select" id="custom-provider-api-format" onChange={(event) => onFormat(event.target.value as ApiFormatId)} value={format}>
            {apiFormatOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </NativeSelect>
          <div className="provider-row-hint">{apiFormatOption(format).description}</div>
        </div>
        <div className="provider-row-item">
          <label className="provider-row-label" htmlFor="custom-provider-api-key">API Key{catalog.requiresApiKey ? "" : "（可选）"}</label>
          <div className="secret-input-row">
            <input
              autoComplete="off"
              id="custom-provider-api-key"
              onChange={(event) => onApiKey(event.target.value)}
              placeholder="输入或粘贴 API Key"
              type={showKey ? "text" : "password"}
              value={apiKey}
            />
            <button className="icon-button" type="button" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((value) => !value)}><Icon name={showKey ? "eye-off" : "eye"} size={16} /></button>
          </div>
        </div>
      </div>

      <section className="provider-models">
      <CatalogFeedback />
        <div className="provider-models-head">
          <h4>启用模型</h4>
          <div className="provider-models-actions">
            {models.length > 0 ? (
              <button
                className="ghost-button"
                disabled={fetching}
                onClick={() => onSelectedChange(selected.length >= models.length ? [] : models.map((model) => model.id))}
                type="button"
              >
                {selected.length >= models.length ? "清空选择" : "全选"}
              </button>
            ) : null}
            <button className="ghost-button" disabled={fetching || !baseUrl.trim()} onClick={onLoadModels} type="button">
              <Icon name="refresh" size={13} />
              {fetching ? "加载中…" : "加载模型"}
            </button>
          </div>
        </div>
        <p className="provider-models-hint">
          {fetching
            ? "正在从服务商加载模型…"
            : models.length > 0
              ? `已选 ${String(selected.length)} / ${String(models.length)}`
              : keyMissing
                ? "填写服务地址和密钥后，点击“加载模型”获取支持列表"
                : "填写服务地址后，点击“加载模型”获取支持列表"}
        </p>
        <div aria-label="选择要启用的模型" className="provider-model-list" role="group">
          {models.map((model) => {
            const checked = selected.includes(model.id);
            return (
              <button
                aria-checked={checked}
                className={`provider-model-row${checked ? " is-enabled" : ""}`}
                key={model.id}
                onClick={() => onToggleModel(model.id)}
                role="checkbox"
                type="button"
              >
                <span className={`check-dot${checked ? " is-on" : ""}`}><Icon name="check" size={11} /></span>
                <span className="provider-model-copy">
                  <span className="provider-model-name">{model.displayName}</span>
                  {model.id !== model.displayName ? (
                    <Tooltip content={model.id}>
                      <span className="provider-model-id">{model.id}</span>
                    </Tooltip>
                  ) : null}
                </span>
              </button>
            );
          })}
          {!models.length ? <div className="provider-models-empty">{fetching ? "正在加载模型…" : "尚未加载模型列表"}</div> : null}
        </div>
      </section>

      <div className="provider-panel-actions">
        <button className="settings-primary-button" disabled={!canConnect} onClick={onConnect} type="button">
          {saving ? "连接中…" : "连接服务商"}
        </button>
      </div>
    </section>
  );
}

/** 测试连接入口；测试结果由面板独立展示，避免长错误挤占标题。 */
function TestConnectionButton({
  defaultModelAlias,
  models,
  testing,
  open,
  onOpen,
  onTest,
  testConfiguration
}: {
  defaultModelAlias?: string;
  models: ModelChoice[];
  testing: boolean;
  open: boolean;
  onOpen(open: boolean): void;
  onTest(model: ModelChoice): Promise<void>;
  testConfiguration(model: ModelChoice): DesktopModelConfigurationInput | undefined;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  // 流动悬停：测试模型菜单按选择器自动注册。
  const testMenuRef = useRef<HTMLDivElement>(null);
  const testMenuHover = useFluidHoverItems(testMenuRef, ".provider-test-option");
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [onOpen, open]);
  const target = models.find((model) => model.alias === defaultModelAlias) ?? models[0];
  return (
    <div className="provider-test-split" ref={menuRef}>
      <Tooltip content="测试连接">
        <button
          className="ghost-button provider-test-button"
          disabled={testing || !target || !testConfiguration(target)}
          onClick={() => target && void onTest(target)}
          type="button"
        >
          <Icon name={testing ? "refresh" : "spark"} size={13} />
          测试
        </button>
      </Tooltip>
      {models.length > 1 ? (
        <button aria-label="选择要测试的模型" className="ghost-button provider-test-caret" disabled={testing} onClick={() => onOpen(!open)} type="button">
          <Icon name="chevron" size={12} />
        </button>
      ) : null}
      {open && models.length > 1 ? (
        <div className="provider-test-menu" ref={testMenuRef} role="listbox" {...testMenuHover.handlers}>
          <FluidHoverHighlight hover={testMenuHover} className="has-row-radius" />
          {models.map((model) => (
            <button className="provider-test-option" key={model.alias} onClick={() => void onTest(model)} role="option" type="button">
              <span>{model.displayName}</span>
              <small>{model.model}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionTestResult({ result }: { result: DesktopModelConnectionTestResult }): React.JSX.Element {
  return (
    <div className={`connection-test-result${result.ok ? " is-ok" : " is-error"}`}>
      <span role="status">{result.ok
        ? `测试通过${result.latencyMs === undefined ? "" : ` · ${String(result.latencyMs)} ms`}`
        : "测试失败，请检查服务商账户和连接设置。"}</span>
      {!result.ok && result.message ? (
        <details>
          <summary>查看错误详情</summary>
          <pre>{result.message}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** 模型区：搜索 + 全选 + 整行可点的模型列表 + 手动添加。 */
function ModelsSection({
  models,
  enabledModels,
  defaultModelAlias,
  query,
  onQuery,
  fetchingCatalog,
  onRefreshCatalog,
  onToggleModel,
  onToggleMany,
  onOpenModelOptions,
  onDefaultModel,
  manualModelId,
  onManualModelId,
  onSubmitManualModel
}: {
  models: CatalogModel[];
  enabledModels: ModelChoice[];
  defaultModelAlias?: string;
  query: string;
  onQuery(value: string): void;
  fetchingCatalog: boolean;
  onRefreshCatalog(): void;
  onToggleModel(model: CatalogModel, enabled: boolean): Promise<void>;
  onToggleMany(models: CatalogModel[], enabled: boolean): Promise<void>;
  onOpenModelOptions(model: ModelChoice): void;
  onDefaultModel(alias: string, thinking: ThinkingSelection): void;
  manualModelId: string;
  onManualModelId(value: string): void;
  onSubmitManualModel(): void;
}): React.JSX.Element {
  const [manualOpen, setManualOpen] = useState(false);
  const choiceByModel = new Map(enabledModels.map((model) => [model.model, model] as const));
  const enabledChoiceByModel = new Map(enabledModels.filter((model) => model.showInPicker !== false).map((model) => [model.model, model] as const));
  // 已启用模型置顶，同组保持目录顺序；每次切换后重新排序，不重复展示。
  const orderedModels = [...models].sort((left, right) =>
    Number(enabledChoiceByModel.has(right.id)) - Number(enabledChoiceByModel.has(left.id))
  );
  // 全选只作用于当前可见（搜索过滤后）的模型，大批量启用也在一次事务里完成。
  const allVisibleEnabled = models.length > 0 && models.every((model) => enabledChoiceByModel.has(model.id));
  return (
    <section className="provider-models">
      <CatalogFeedback />
      <div className="provider-models-head">
        <h4>模型</h4>
        <div className="provider-models-actions">
          {models.length > 0 ? (
            <button
              className="ghost-button"
              disabled={fetchingCatalog}
              onClick={() => void onToggleMany(models, !allVisibleEnabled)}
              type="button"
            >
              {allVisibleEnabled ? "全部停用" : "全部启用"}
            </button>
          ) : null}
          <button className="ghost-button" disabled={fetchingCatalog} onClick={onRefreshCatalog} type="button">
            <Icon name="refresh" size={13} />
            {fetchingCatalog ? "获取中…" : "获取"}
          </button>
        </div>
      </div>
      <label className="provider-model-search">
        <Icon name="search" size={13} />
        <input aria-label="搜索模型" onChange={(event) => onQuery(event.target.value)} placeholder="搜索模型…" value={query} />
      </label>
      <p className="provider-models-hint">
        {query.trim() ? `${String(models.length)} 个结果 · 全选仅作用于搜索结果` : `${String(models.length)} 个模型 · 已启用 ${String(enabledChoiceByModel.size)}`}
      </p>

      <div className="provider-model-list">
        {orderedModels.map((model) => {
          const choice = choiceByModel.get(model.id);
          const enabled = enabledChoiceByModel.has(model.id);
          const isDefault = choice !== undefined && choice.alias === defaultModelAlias;
          return (
            <div
              className={`provider-model-row${enabled ? " is-enabled" : ""}`}
              key={model.id}

            >
              <div className="provider-model-copy">
                <span className="provider-model-name">{model.displayName}</span>
                <span className="provider-model-meta" id={`${model.id.replace(/[^a-z0-9_-]/gi, "-")}-meta`}>
                  <CapabilityBadges model={model} />
                  {model.contextWindow && !model.contextWindowIsFallback ? (
                    // 徽标只显示 1M/128K 一类缩写；悬停补全精确容量，数字按千分位便于确认量级。
                    <Tooltip content={`${model.contextWindow.toLocaleString()} token 上下文窗口`}>
                      <span>{formatContextWindow(model.contextWindow)}</span>
                    </Tooltip>
                  ) : null}
                  {model.id !== model.displayName ? (
                    <Tooltip content={model.id}>
                      <span className="provider-model-id">{model.id}</span>
                    </Tooltip>
                  ) : null}
                </span>
              </div>
              <div className="provider-model-actions">
                {choice && enabled && !isDefault ? (
                  <button
                    className="text-button"
                    onClick={(event) => { event.stopPropagation(); onDefaultModel(choice.alias, choice.defaultThinking); }}
                    type="button"
                  >设为默认</button>
                ) : null}
                {isDefault ? <span className="default-pill">默认</span> : null}
                {choice ? (
                  <Tooltip content="模型选项">
                    <button
                      aria-label={`${model.displayName} 模型选项`}
                      className="icon-button"
                      onClick={(event) => { event.stopPropagation(); onOpenModelOptions(choice); }}
                      type="button"
                    >
                      <Icon name="sliders" size={13} />
                    </button>
                  </Tooltip>
                ) : null}
                <button
                  aria-checked={enabled}
                  aria-label={`${enabled ? "停用" : "启用"} ${model.displayName}`}
                  aria-describedby={`${model.id.replace(/[^a-z0-9_-]/gi, "-")}-meta`}
                  className={`model-toggle${enabled ? " is-on" : ""}`}
                  onClick={(event) => { event.stopPropagation(); void onToggleModel(model, !enabled); }}
                  role="switch"
                  type="button"
                >
                  <span className="model-toggle-thumb" />
                </button>
              </div>
            </div>
          );
        })}
        {!models.length ? (
          <div className="provider-models-empty">
            <strong>{query.trim() ? "没有匹配的模型" : "暂无可用模型"}</strong>
            <span>{query.trim() ? "试试其他名称或模型 ID。" : "检查密钥后刷新列表，或手动添加模型。"}</span>
          </div>
        ) : null}
      </div>
      {/* 目录滞后时的逃生通道：默认收起不占空间，展开后按原始 ID 直接启用。 */}
      {manualOpen ? (
        <div className="provider-manual-row">
          <input
            autoFocus
            onChange={(event) => onManualModelId(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && manualModelId.trim()) { event.preventDefault(); onSubmitManualModel(); } }}
            placeholder="输入模型 ID，例如 gpt-4o"
            value={manualModelId}
          />
          <button className="ghost-button" disabled={!manualModelId.trim()} onClick={onSubmitManualModel} type="button">添加</button>
        </div>
      ) : (
        <button className="ghost-button provider-manual-toggle" onClick={() => setManualOpen(true)} type="button">
          <Icon name="add" size={13} />
          手动添加模型
        </button>
      )}
    </section>
  );
}

function CapabilityBadges({ model }: { model: CatalogModel }): React.JSX.Element {
  // 图标语义不直观，悬停时用一句能力描述代替只重复图标名的短语。
  const badges: Array<{ icon: "brain-spark" | "eye"; tooltip: string }> = [];
  if (model.supportsThinking) badges.push({ icon: "brain-spark", tooltip: "支持扩展思考/推理" });
  if (model.supportsVision) badges.push({ icon: "eye", tooltip: "支持图片输入" });
  return (
    <>
      {badges.map((badge) => (
        <Tooltip content={badge.tooltip} key={badge.icon}>
          <span className="provider-model-cap">
            <Icon name={badge.icon} size={11} />
          </span>
        </Tooltip>
      ))}
    </>
  );
}

/** 模型设置：默认展示能力，高级覆盖按需展开；所有编辑仍在保存时一次提交。 */
function ModelOptionsDialog({
  apiFormat,
  apiFormatOptions: formatOptions,
  autoModel,
  target,
  onClose,
  onSave
}: {
  apiFormat: ApiFormatId;
  apiFormatOptions: ApiFormatOption[];
  /** 恢复推荐配置时使用目录能力。 */
  autoModel?: CatalogModel;
  target: { providerAlias: string; model: ModelChoice };
  onClose(): void;
  onSave(options: {
    profile: ModelProfile | undefined;
    vision: boolean;
    tools: boolean;
    reasoning: boolean;
    headers: Record<string, string>;
    apiFormat: ApiFormatId | undefined;
  }): void;
}): React.JSX.Element {
  const profiles = useSettingsDraft().draft?.models.modelProfiles[target.providerAlias] ?? {};
  const savedProfile = profiles[target.model.model];
  const [draft, setDraft] = useState<ModelProfileFieldDraft>(() => modelProfileFieldDraftFrom(savedProfile));
  const [formatOverride, setFormatOverride] = useState<ApiFormatId | "provider_default">(
    target.model.apiBackend === undefined ? "provider_default" : apiFormat
  );
  // 能力的「自动」基准来自目录（目录候选默认都按支持工具处理）；开关初值取当前生效值
  // （显式覆盖优先，否则沿用自动推导）。
  const autoCapabilities = {
    vision: autoModel?.supportsVision ?? false,
    tools: true,
    reasoning: autoModel?.supportsThinking ?? false
  };
  const [capabilities, setCapabilities] = useState({
    vision: target.model.capabilities?.vision ?? autoCapabilities.vision,
    tools: target.model.capabilities?.tools ?? target.model.supportsTools ?? true,
    reasoning: target.model.capabilities?.reasoning ?? target.model.efforts.length > 0
  });
  const [headersText, setHeadersText] = useState(() => headersTextFrom(target.model.headers));
  const [headersError, setHeadersError] = useState<string>();
  const hasAdvancedOverrides = [draft.contextWindow, draft.maxInputTokens, draft.maxOutputTokens, ...Object.values(draft.thinkingLevelMap)].some((value) => value.trim().length > 0)
    || formatOverride !== "provider_default"
    || headersText.trim().length > 0;
  const hasOverrides = hasAdvancedOverrides || capabilities.vision !== autoCapabilities.vision
    || capabilities.tools !== autoCapabilities.tools
    || capabilities.reasoning !== autoCapabilities.reasoning;

  /** 重置只回填表单（自动检测值 + 清空覆盖字段），与原产品一致仍需按「保存」落盘。 */
  const resetToDefault = (): void => {
    setDraft(modelProfileFieldDraftFrom(undefined));
    setCapabilities(autoCapabilities);
    setFormatOverride("provider_default");
    setHeadersText("");
    setHeadersError(undefined);
  };

  const save = (): void => {
    let headers: Record<string, string> = {};
    if (headersText.trim()) {
      try {
        const parsed: unknown = JSON.parse(headersText);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setHeadersError("自定义请求头需要填写 JSON 对象，如 {\"X-Custom-Header\": \"value\"}。");
          return;
        }
        headers = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
      } catch {
        setHeadersError("自定义请求头格式有误，请检查 JSON 的引号和逗号。");
        return;
      }
    }
    onSave({
      profile: {
        ...modelProfileFromFieldDraft(draft),
        capabilities: {
          ...savedProfile?.capabilities,
          vision: capabilities.vision === autoCapabilities.vision ? undefined : capabilities.vision,
          tools: capabilities.tools === autoCapabilities.tools ? undefined : capabilities.tools,
          reasoning: capabilities.reasoning === autoCapabilities.reasoning ? undefined : capabilities.reasoning
        }
      },
      vision: capabilities.vision,
      tools: capabilities.tools,
      reasoning: capabilities.reasoning,
      headers,
      apiFormat: formatOverride === "provider_default" ? undefined : formatOverride
    });
    onClose();
  };

  return (
    <SettingsDetailLayer onClose={onClose}>
      <form
        aria-label="模型设置"
        aria-modal="true"
        className="provider-dialog"
        onInvalid={(event) => { if (event.target instanceof HTMLInputElement) event.target.closest("details")?.setAttribute("open", ""); }}
        onSubmit={(event) => { event.preventDefault(); save(); }}
        role="dialog"
      >
        <header>
          <div>
            <strong>模型设置</strong>
            <small>{target.model.displayName}</small>
          </div>
          <button aria-label="关闭模型设置" className="icon-button" onClick={onClose} type="button"><Icon name="close" size={16} /></button>
        </header>

        <div className="provider-dialog-body">
          <p className="provider-dialog-hint">默认使用推荐配置，通常无需修改。</p>
          <section className="provider-dialog-section">
            <div className="provider-dialog-section-head">
              <h5>模型能力</h5>
              <p>按模型实际支持的功能设置，开启不会增加模型本身的能力。</p>
            </div>
            <div className="provider-cap-grid">
              <CapabilityOption icon="eye" label="图片理解" onChange={(value) => setCapabilities((current) => ({ ...current, vision: value }))} value={capabilities.vision} />
              <CapabilityOption icon="wrench" label="工具调用" onChange={(value) => setCapabilities((current) => ({ ...current, tools: value }))} value={capabilities.tools} />
              <CapabilityOption icon="brain-spark" label="深度思考" onChange={(value) => setCapabilities((current) => ({ ...current, reasoning: value }))} value={capabilities.reasoning} />
            </div>
          </section>

          <details className="provider-dialog-advanced">
            <summary tabIndex={0}>高级设置{hasAdvancedOverrides ? <span>已自定义</span> : null}</summary>
            <div className="provider-dialog-advanced-body">
              <p className="provider-dialog-hint">仅在服务商要求时修改，设置只影响当前模型。</p>
              <ModelProfileEditorFields
                apiFormat={apiFormat}
                formatOptions={formatOptions}
                formatOverride={formatOverride}
                draft={draft}
                model={target.model}
                onApiFormat={setFormatOverride}
                onDraft={setDraft}
              />

              <section className="provider-dialog-section">
                <div className="provider-dialog-section-head"><h5>自定义请求头</h5><p>用于服务商要求的额外请求信息，按其文档填写 JSON。</p></div>
                <textarea
                  aria-label="自定义请求头（JSON）"
                  className="provider-json-editor"
                  onChange={(event) => { setHeadersText(event.target.value); setHeadersError(undefined); }}
                  placeholder={'{\n  "X-Custom-Header": "value"\n}'}
                  rows={5}
                  spellCheck={false}
                  value={headersText}
                />
              </section>
            </div>
          </details>
          {headersError ? <p className="provider-json-error" role="alert">{headersError}</p> : null}
        </div>

        <footer>
          {hasOverrides ? (
            <button
              className="text-button provider-reset-button"
              onClick={(event) => {
                resetToDefault();
                // 重置后按钮会消失，把焦点交给保存，避免退回设置页背景。
                event.currentTarget.form?.querySelector<HTMLButtonElement>("button[type='submit']")?.focus();
              }}
              type="button"
            >恢复推荐配置</button>
          ) : null}
          <button className="ghost-button" onClick={onClose} type="button">取消</button>
          <button className="settings-primary-button" type="submit">保存</button>
        </footer>
      </form>
    </SettingsDetailLayer>
  );
}

/** 能力开关仅展示功能名，推荐值由对话框统一恢复。 */
function CapabilityOption({ icon, label, onChange, value }: {
  icon: "brain-spark" | "database" | "eye" | "wand" | "wrench";
  label: string;
  onChange(value: boolean): void;
  value: boolean;
}): React.JSX.Element {
  return (
    <div className="provider-cap-card">
      <span className="provider-cap-label">
        <Icon name={icon} size={13} />
        {label}
      </span>
      <button
        aria-checked={value}
        aria-label={label}
        className={`model-toggle${value ? " is-on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        type="button"
      >
        <span className="model-toggle-thumb" />
      </button>
    </div>
  );
}

function headersTextFrom(headers: Record<string, string> | undefined): string {
  if (headers === undefined || Object.keys(headers).length === 0) return "";
  return JSON.stringify(headers, null, 2);
}

/** 对话框内的字符串缓冲：保留打了一半的输入（如中间态数字），提交时才解析。 */
interface ModelProfileFieldDraft {
  contextWindow: string;
  maxInputTokens: string;
  maxOutputTokens: string;
  thinkingLevelMap: Record<string, string>;
}

function modelProfileFieldDraftFrom(profile: ModelProfile | undefined): ModelProfileFieldDraft {
  return {
    contextWindow: profile?.contextWindow === undefined ? "" : String(profile.contextWindow),
    maxInputTokens: profile?.maxInputTokens === undefined ? "" : String(profile.maxInputTokens),
    maxOutputTokens: profile?.maxOutputTokens === undefined ? "" : String(profile.maxOutputTokens),
    thinkingLevelMap: profile?.thinkingLevelMap === undefined
      ? {}
      : Object.fromEntries(Object.entries(profile.thinkingLevelMap)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  };
}

function modelProfileFromFieldDraft(draft: ModelProfileFieldDraft): ModelProfile | undefined {
  const contextWindow = parseProfileInteger(draft.contextWindow);
  const maxInputTokens = parseProfileInteger(draft.maxInputTokens);
  const maxOutputTokens = parseProfileInteger(draft.maxOutputTokens);
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const [level, value] of Object.entries(draft.thinkingLevelMap)) {
    const trimmed = value.trim();
    if (trimmed) thinkingLevelMap[level] = trimmed;
  }
  const hasThinkingLevelMap = Object.keys(thinkingLevelMap).length > 0;
  return contextWindow !== undefined || maxInputTokens !== undefined || maxOutputTokens !== undefined || hasThinkingLevelMap
    ? { contextWindow, maxInputTokens, maxOutputTokens, thinkingLevelMap: hasThinkingLevelMap ? thinkingLevelMap : undefined }
    : undefined;
}

const modelProfileThinkingLevels: Array<{ level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; label: string }> = [
  { level: "off", label: "关闭思考" },
  { level: "minimal", label: "最少" },
  { level: "low", label: "较少" },
  { level: "medium", label: "适中" },
  { level: "high", label: "较多" },
  { level: "xhigh", label: "很多" },
  { level: "max", label: "最多" }
];

type ModelProfileThinkingLevel = (typeof modelProfileThinkingLevels)[number]["level"];

function ModelProfileEditorFields({ apiFormat, formatOptions, formatOverride, draft, model, onApiFormat, onDraft }: {
  apiFormat: ApiFormatId;
  formatOptions: ApiFormatOption[];
  formatOverride: ApiFormatId | "provider_default";
  draft: ModelProfileFieldDraft;
  model?: ModelChoice;
  onApiFormat(value: ApiFormatId | "provider_default"): void;
  onDraft(next: ModelProfileFieldDraft): void;
}): React.JSX.Element {
  const updateField = (field: "contextWindow" | "maxInputTokens" | "maxOutputTokens", value: string): void => {
    onDraft({ ...draft, [field]: value });
  };
  const updateThinkingLevel = (level: ModelProfileThinkingLevel, value: string): void => {
    onDraft({ ...draft, thinkingLevelMap: { ...draft.thinkingLevelMap, [level]: value } });
  };
  return (
    <>
      <section className="provider-dialog-section">
        <div className="provider-dialog-section-head">
          <h5>文本容量</h5>
          <p>单位为 token（文本片段），留空自动设置。</p>
        </div>
        <div className="provider-cap-fields">
          <label>
            <span>上下文容量</span>
            <input
              min={4096}
              onChange={(event) => updateField("contextWindow", event.target.value)}
              placeholder={!model?.contextWindowIsFallback && model?.contextWindow ? `自动：${model.contextWindow.toLocaleString("zh-CN")}` : "自动"}
              step={1}
              type="number"
              value={draft.contextWindow}
            />
          </label>
          <label>
            <span>单次回复上限</span>
            <input
              min={1}
              onChange={(event) => updateField("maxOutputTokens", event.target.value)}
              placeholder={model?.maxOutputTokens ? `自动：${model.maxOutputTokens.toLocaleString("zh-CN")}` : "自动"}
              step={1}
              type="number"
              value={draft.maxOutputTokens}
            />
          </label>
          <label>
            <span>单次输入上限</span>
            <input
              min={2048}
              onChange={(event) => updateField("maxInputTokens", event.target.value)}
              placeholder="自动"
              step={1}
              type="number"
              value={draft.maxInputTokens}
            />
          </label>
        </div>
      </section>
      <section className="provider-dialog-section">
        <div className="provider-dialog-section-head">
          <h5>请求格式</h5>
          <p>连接当前使用 {apiFormatOption(apiFormat).label}，通常保持跟随即可。</p>
        </div>
        <NativeSelect aria-label="当前模型的请求格式" onChange={(event) => onApiFormat(event.target.value as ApiFormatId | "provider_default")} value={formatOverride}>
          <option value="provider_default">跟随连接设置</option>
          {formatOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </NativeSelect>
      </section>
      <section className="provider-dialog-section">
        <div className="provider-dialog-section-head">
          <h5>思考强度参数</h5>
          <p>将应用中的思考强度对应到服务商的参数值。仅在自动适配有误时，按服务商文档填写；留空保持自动。</p>
        </div>
        <div className="model-profile-thinking-fields">
          {modelProfileThinkingLevels.map(({ level, label }) => (
            <label key={level}>
              <span>{label}</span>
              <input
                onChange={(event) => updateThinkingLevel(level, event.target.value)}
                placeholder={automaticThinkingPlaceholder(model, level)}
                type="text"
                value={draft.thinkingLevelMap[level] ?? ""}
              />
            </label>
          ))}
        </div>
      </section>
    </>
  );
}

function automaticThinkingPlaceholder(model: ModelChoice | undefined, level: ModelProfileThinkingLevel): string {
  if (!model) return level === "off" ? "none 可明确关闭" : "留空使用自动推导";
  const native = model.thinkingLevelMap[level];
  if (native === null) return "自动：不支持";
  if (native !== undefined) return `自动：${native}`;
  return level === "off" ? "自动：不可关闭" : "留空使用自动推导";
}

function parseProfileInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// ── 共享的投影与展示辅助 ──

/** 把目录模型投影成一次 upsert 输入；extra 覆盖地址、密钥、默认标记等连接级字段。 */
function catalogModelUpsertInput(
  providerAlias: string,
  providerType: DesktopModelConfigurationInput["providerType"],
  protocol: DesktopModelConfigurationInput["protocol"],
  model: CatalogModel,
  extra: Partial<DesktopModelConfigurationInput> = {}
): DesktopModelConfigurationInput {
  return {
    alias: modelAliasFor(providerAlias, model.id),
    displayName: model.displayName,
    providerAlias,
    providerType,
    protocol,
    model: model.id,
    baseUrl: undefined,
    apiKeyEnv: undefined,
    supportsTools: true,
    supportsThinking: model.supportsThinking,
    parallelToolCalls: model.parallelToolCalls,
    reasoningStream: model.reasoningStream,
    reasoningSummary: model.reasoningSummary,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    limits: model.limits,
    thinkingLevelMap: model.thinkingLevelMap,
    apiBackend: model.apiBackend,
    ...extra
  };
}

/**
 * 以目录顺序为基准合并已配置模型与目录候选：实时目录优先，其次静态目录；只把目录里
 * 不存在的已配置模型（手动添加、已下线）附加在末尾。启用/停用不改变行序——否则每次
 * 开关模型都会重排，正在点击的行从光标下跳走，滚动位置也随之丢失。
 */
function mergeAvailableModels(
  catalogModels: CatalogModel[],
  configuredModels: ModelChoice[],
  liveModels: CatalogModel[] = []
): CatalogModel[] {
  const configuredByModel = new Map(configuredModels.map((model) => [model.model, model] as const));
  const merged: CatalogModel[] = [];
  const seen = new Set<string>();
  const projectConfigured = (model: ModelChoice, live?: CatalogModel): CatalogModel => {
    const liveContextIsBetter = model.contextWindowIsFallback === true && live?.contextWindow !== undefined;
    return {
      id: model.model,
      displayName: live?.displayName ?? model.displayName,
      supportsThinking: model.efforts.length > 0 || Boolean(live?.supportsThinking),
      parallelToolCalls: model.capabilities?.parallelToolCalls ?? live?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream ?? live?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary ?? live?.reasoningSummary,
      supportsVision: model.capabilities?.vision ?? live?.supportsVision,
      supportsAudio: model.capabilities?.audio ?? live?.supportsAudio,
      contextWindow: liveContextIsBetter ? live.contextWindow : model.contextWindow ?? live?.contextWindow,
      contextWindowIsFallback: liveContextIsBetter ? live.contextWindowIsFallback : model.contextWindowIsFallback ?? live?.contextWindowIsFallback,
      maxInputTokens: liveContextIsBetter ? live.maxInputTokens ?? model.maxInputTokens : model.maxInputTokens ?? live?.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens ?? live?.maxOutputTokens,
      limits: model.limits ?? live?.limits,
      thinkingLevelMap: model.thinkingLevelMap ?? live?.thinkingLevelMap,
      apiBackend: model.apiBackend ?? live?.apiBackend
    };
  };
  for (const model of liveModels.length ? liveModels : catalogModels) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const configured = configuredByModel.get(model.id);
    merged.push(configured ? projectConfigured(configured, model) : model);
  }
  for (const model of configuredModels) {
    if (seen.has(model.model)) continue;
    seen.add(model.model);
    merged.push(projectConfigured(model));
  }
  return merged;
}

/** Maps one live `ModelCatalogEntry` from the provider onto the picker's shape. */
function catalogModelFromEntry(entry: DesktopModelCatalogResult["models"][number]): CatalogModel {
  return {
    id: entry.id,
    displayName: entry.displayName,
    supportsThinking: entry.reasoningEfforts.length > 0 || entry.capabilities.reasoning === true,
    parallelToolCalls: entry.capabilities.parallelToolCalls,
    reasoningStream: entry.capabilities.reasoningStream,
    reasoningSummary: entry.capabilities.reasoningSummary,
    supportsVision: entry.capabilities.vision,
    supportsAudio: entry.capabilities.audio,
    contextWindow: entry.contextWindow,
    contextWindowIsFallback: entry.contextWindow === undefined,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    limits: entry.limits,
    thinkingLevelMap: entry.thinkingLevelMap,
    apiBackend: entry.apiBackend
  };
}

/** Short status line for one connection, or null when nothing needs attention. */
function connectionStatus(connection: DesktopModelConnection | undefined): { label: string; tone: "warn" | "error" } | null {
  if (!connection) return null;
  if (connection.authMode === "oauth-bearer") {
    if (!connection.hasCredential) return { label: "需要登录", tone: "error" };
    if (connection.oauthExpiresAt !== undefined && connection.oauthExpiresAt <= Date.now()) {
      return { label: "登录已过期", tone: "warn" };
    }
    return null;
  }
  if (connection.requiresApiKey && !connection.hasCredential) return { label: "缺少密钥", tone: "error" };
  return null;
}

/** 密钥状态固定在输入框下方，保存反馈替换文案时不改变布局。 */
function credentialHint(connection: DesktopModelConnection | undefined): string {
  if (!connection) return "尚未保存密钥";
  if (connection.credentialSource === "env") return `来自环境变量 ${connection.apiKeyEnv ?? ""}`;
  if (connection.credentialSource === "keychain") return "已存入 macOS 钥匙串 · 修改后自动保存";
  if (connection.hasCredential) return "已保存 · 修改后自动保存";
  return connection.requiresApiKey ? "粘贴密钥后自动保存" : "无需密钥";
}

function oauthExpiryHint(expiresAt: number | undefined): string {
  if (expiresAt === undefined) return "已通过官方 OAuth 登录，使用订阅配额。";
  const remainingMinutes = Math.round((expiresAt - Date.now()) / 60_000);
  if (remainingMinutes <= 0) return "访问令牌已过期，将在下次发送时自动刷新。";
  if (remainingMinutes < 60) return `已登录，访问令牌 ${String(remainingMinutes)} 分钟后自动刷新。`;
  return `已登录，访问令牌 ${String(Math.round(remainingMinutes / 60))} 小时后自动刷新。`;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

/** URL 缺版本段（/v1 等）且路径很浅时提示：这是中转站 404 的最常见原因。 */
function baseUrlNeedsVersionHint(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || !/^https?:\/\//u.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return !/\/v\d+[a-z]*$/iu.test(parsed.pathname) && segments.length < 2;
  } catch {
    return false;
  }
}

/** 整组启停复用模型显示偏好事务，不删除连接或凭据。 */
function ProviderToggle({ group }: { group: ConnectionGroup }): React.JSX.Element {
  const { draft, saveModels } = useSettingsDraft();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const enabled = group.models.some((model) => model.showInPicker !== false);
  const toggle = async (): Promise<void> => {
    if (!draft || saving || !group.models.length) return;
    setSaving(true);
    setError(undefined);
    const profiles = { ...draft.models.modelProfiles[group.provider] };
    for (const model of group.models) profiles[model.model] = { ...profiles[model.model], showInPicker: !enabled };
    try {
      const result = await saveModels({ ...draft.models, modelProfiles: { ...draft.models.modelProfiles, [group.provider]: profiles } });
      if (result?.status !== "committed") setError("服务商状态未保存，请重试");
    } catch {
      setError("服务商状态未保存，请重试");
    } finally {
      setSaving(false);
    }
  };
  return <div className="provider-master-toggle">
    <span className="provider-toggle-status" role="status">{saving ? "保存中…" : enabled ? "已启用" : "未启用"}</span>
    <button type="button" role="switch" aria-checked={enabled} aria-label={enabled ? "停用整个服务商" : "启用整个服务商"} disabled={saving || !draft || !group.models.length} className={`model-toggle${enabled ? " is-on" : ""}`} onClick={() => void toggle()}><span className="model-toggle-thumb" /></button>
    {error ? <small role="alert">{error}</small> : null}
  </div>;
}

/** 获取失败留在模型区，重新获取时清除，不用会消失的通知承载错误。 */
function CatalogFeedback(): React.JSX.Element | null {
  const error = useContext(CatalogErrorContext);
  return error ? <div className="provider-catalog-error" role="alert"><Icon name="warning" size={16} /><div><strong>无法获取模型列表</strong><p>{error}</p><small>已保存的模型配置未更改。检查连接设置后可重新获取。</small></div></div> : null;
}
