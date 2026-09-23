/**
 * 配置读写边界。
 *
 * 运行时只依赖这个接口，不直接读文件：CLI/TUI 与 Electron 都通过全局配置和统一凭据存储
 * 获取模型设置，项目覆盖由 workspaceRoot 决定。
 */
import path from "node:path";
import { CONFIG_FILE, loadConfig, saveConfig, type ConfigPathOptions } from "./loader.js";
import {
  applyStoredCredentials,
  CREDENTIAL_TRANSACTION_JOURNAL,
  createCredentialStore,
  deferredCredentialTransactionStatus,
  finalizeDeferredCredentialTransaction,
  recoverStoredCredentialTransaction,
  rollbackDeferredCredentialTransaction,
  saveConfigAndStoredCredentials,
  type DeferredCredentialTransactionStatus,
  type CredentialStore
} from "./credentials.js";
import type { AgentConfig } from "./schema.js";
import {
  assertConfigRevision,
  ConfigRevisionConflictError,
  configDocumentRevision,
  withGlobalConfigWriteLock,
  type VersionedConfigSnapshot
} from "./versioned.js";
import { globalConfigDir } from "./paths.js";

const configUpdateMaxAttempts = 3;

/** 运行时面向的配置存储接口。 */
export interface AgentConfigStore {
  /** 文件型配置的监听入口；内存实现无需提供。 */
  configPath?(): string;
  load(workspaceRoot?: string): Promise<AgentConfig>;
  save(config: AgentConfig, workspaceRoot?: string): Promise<void>;
  /** 凭据是否能被独立 Runtime Host 进程读取；Desktop safeStorage 只在主进程可用。 */
  supportsDetachedRuntimeHost?: boolean;
  /** 当前进程内成功写入配置的版本号；runtime 用它避免每次 prompt 都重新读盘。 */
  revision?(): number;
  /** 跨进程配置 CAS；个性化和记忆策略的 UI/RPC 写入必须使用这组接口。 */
  loadVersioned?(workspaceRoot?: string): Promise<VersionedConfigSnapshot>;
  saveVersioned?(config: AgentConfig, expectedRevision: string, workspaceRoot?: string): Promise<VersionedConfigSnapshot>;
  /** Desktop 外层设置事务使用：保存后保留 Keychain before/target，直到显式 finalize/rollback。 */
  saveVersionedDeferred?(
    config: AgentConfig,
    expectedRevision: string,
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<VersionedConfigSnapshot>;
  deferredCredentialStatus?(
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<DeferredCredentialTransactionStatus>;
  finalizeDeferredCredentials?(deferredFor: string, workspaceRoot?: string): Promise<void>;
  rollbackVersionedDeferred?(
    before: AgentConfig,
    targetRevision: string,
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<"not_needed" | "completed" | "failed">;
  rollbackDeferredCredentials?(
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<"not_needed" | "completed" | "failed">;
}

export interface FileConfigStoreOptions {
  credentialStore?: CredentialStore;
  globalDir?: string;
}

/**
 * 在共享全局配置上执行一个只改自己字段的更新。
 *
 * Desktop、TUI 和 Runtime Host 可能各自持有不同的配置快照。普通的 load + save
 * 只能保证单次写入不互相覆盖，不能保证两次读改写之间没有第三方更新；带版本存储
 * 的实现用 CAS 检测冲突，重读后重新计算候选配置，避免模型切换和权限更新互相回滚。
 */
export async function updateConfig(
  store: AgentConfigStore,
  workspaceRoot: string | undefined,
  update: (config: AgentConfig) => AgentConfig
): Promise<AgentConfig> {
  // AgentConfigStore 同时支持闭包实现和 class 实现；绑定实例后统一调用，避免桌面端的
  // DesktopConfigStore 在取出方法后丢失 this，导致权限等即时设置只改了内存而没有落盘。
  const loadVersioned = store.loadVersioned?.bind(store);
  const saveVersioned = store.saveVersioned?.bind(store);
  if (loadVersioned === undefined || saveVersioned === undefined) {
    throw new Error("Configuration updates require a versioned config store.");
  }

  for (let attempt = 0; attempt < configUpdateMaxAttempts; attempt += 1) {
    const current = await loadVersioned(workspaceRoot);
    const next = update(current.config);
    try {
      return (await saveVersioned(next, current.revision, workspaceRoot)).config;
    } catch (error) {
      if (!(error instanceof ConfigRevisionConflictError) || attempt === configUpdateMaxAttempts - 1) throw error;
    }
  }

  throw new Error("Configuration update retry limit was reached.");
}

export function createFileConfigStore(workspaceRoot: string, options: FileConfigStoreOptions = {}): AgentConfigStore {
  const credentials = options.credentialStore ?? createCredentialStore();
  const pathOptions: ConfigPathOptions = { globalDir: options.globalDir };
  const configRoot = options.globalDir ?? globalConfigDir();
  let revision = 0;
  let writeTail = Promise.resolve();
  const journalPath = path.join(configRoot, CREDENTIAL_TRANSACTION_JOURNAL);
  const loadUnlocked = async (requestedWorkspaceRoot?: string): Promise<AgentConfig> => {
    const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
    const loadDocument = async (): Promise<AgentConfig> => await loadConfig(targetRoot, pathOptions);
    await recoverStoredCredentialTransaction(credentials, journalPath, loadDocument);
    let document = await loadDocument();
    if (hasInlineCredentials(document)) {
      if (!credentials.persistent) {
        throw new Error(
          "配置文件包含明文凭据，但当前平台没有持久凭据存储；请改用 providers.<alias>.apiKeyEnv。"
        );
      }
      const previous = structuredClone(document);
      const target = structuredClone(document);
      await saveConfigAndStoredCredentials(
        target,
        previous,
        credentials,
        journalPath,
        async () => await saveConfig(targetRoot, target, pathOptions),
        loadDocument
      );
      document = await loadDocument();
      revision += 1;
    }
    return await applyStoredCredentials(document, credentials);
  };
  const load = async (requestedWorkspaceRoot?: string): Promise<AgentConfig> => {
    const run = writeTail.then(async () => await withGlobalConfigWriteLock(
      configRoot,
      async () => await loadUnlocked(requestedWorkspaceRoot)
    ));
    writeTail = run.then(() => undefined, () => undefined);
    return await run;
  };
  const saveUnlocked = async (
    config: AgentConfig,
    requestedWorkspaceRoot?: string,
    deferredFor?: string
  ): Promise<void> => {
    const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
    const previous = await loadUnlocked(targetRoot);
    await saveConfigAndStoredCredentials(
      config,
      previous,
      credentials,
      journalPath,
      async () => await saveConfig(targetRoot, config, pathOptions),
      async () => await loadConfig(targetRoot, pathOptions),
      { deferredFor }
    );
    revision += 1;
  };
  return {
    configPath: () => path.join(configRoot, CONFIG_FILE),
    // 注入的凭据实现不一定能被子进程重新构建；不能先 spawn 失败再靠吞错回到同进程。
    supportsDetachedRuntimeHost: options.credentialStore === undefined,
    load,
    save: async (config, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(
        configRoot,
        async () => await saveUnlocked(config, requestedWorkspaceRoot)
      ));
      writeTail = run.then(() => undefined, () => undefined);
      await run;
    },
    revision: () => revision,
    loadVersioned: async (requestedWorkspaceRoot) => {
      const config = await load(requestedWorkspaceRoot);
      return { config, revision: configDocumentRevision(config) };
    },
    saveVersioned: async (config, expectedRevision, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        assertConfigRevision(expectedRevision, await loadUnlocked(requestedWorkspaceRoot));
        await saveUnlocked(config, requestedWorkspaceRoot);
        // revision 只覆盖非凭据文档；刚写入的就是 `config`，直接算哈希即可，省掉一次
        // 完整读盘 + 凭据水合（保存路径的第三次 loadUnlocked 是切换模型卡顿的来源之一）。
        return { config, revision: configDocumentRevision(config) };
      }));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    saveVersionedDeferred: async (config, expectedRevision, deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        assertConfigRevision(expectedRevision, await loadUnlocked(requestedWorkspaceRoot));
        await saveUnlocked(config, requestedWorkspaceRoot, deferredFor);
        return { config, revision: configDocumentRevision(config) };
      }));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    deferredCredentialStatus: async (deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        return await deferredCredentialTransactionStatus(
          credentials,
          journalPath,
          async () => await loadConfig(targetRoot, pathOptions),
          deferredFor
        );
      }));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    finalizeDeferredCredentials: async (deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        await finalizeDeferredCredentialTransaction(
          credentials,
          journalPath,
          async () => await loadConfig(targetRoot, pathOptions),
          deferredFor
        );
      }));
      writeTail = run.then(() => undefined, () => undefined);
      await run;
    },
    rollbackVersionedDeferred: async (before, targetRevision, deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        const loadDocument = async (): Promise<AgentConfig> => await loadConfig(targetRoot, pathOptions);
        await recoverStoredCredentialTransaction(credentials, journalPath, loadDocument);
        const currentRevision = configDocumentRevision(await loadDocument());
        const beforeRevision = configDocumentRevision(before);
        const configNeedsRollback = currentRevision === targetRevision && targetRevision !== beforeRevision;
        if (!configNeedsRollback && currentRevision !== beforeRevision) return "failed" as const;
        const credentialSide = await rollbackDeferredCredentialTransaction(
          credentials,
          journalPath,
          loadDocument,
          deferredFor,
          configNeedsRollback
            ? async () => {
                await saveConfig(targetRoot, before, pathOptions);
                assertConfigRevision(beforeRevision, await loadDocument());
              }
            : undefined
        );
        if (configNeedsRollback) revision += 1;
        return configNeedsRollback || credentialSide === "target" ? "completed" as const : "not_needed" as const;
      }).catch(() => "failed" as const));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    rollbackDeferredCredentials: async (deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        const side = await rollbackDeferredCredentialTransaction(
          credentials,
          journalPath,
          async () => await loadConfig(targetRoot, pathOptions),
          deferredFor
        );
        return side === "target" ? "completed" as const : "not_needed" as const;
      }).catch(() => "failed" as const));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    }
  };
}

function hasInlineCredentials(config: AgentConfig): boolean {
  return Boolean(config.web.search.apiKey)
    || Object.values(config.providers).some((provider) => Boolean(provider.apiKey || provider.oauth?.refreshToken));
}
