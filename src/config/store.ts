/**
 * 配置读写边界。
 *
 * 运行时只依赖这个接口，不直接读文件：CLI/TUI 与 Electron 都通过全局配置和统一凭据存储
 * 获取模型设置，项目覆盖由 workspaceRoot 决定。
 */
import path from "node:path";
import { CONFIG_FILE, applyProjectSettings, loadConfig, saveConfig, type ConfigPathOptions } from "./loader.js";
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
import { loadProjectSettings } from "./projectSettings.js";
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
  return new FileConfigStore(workspaceRoot, options);
}

/** CLI 与 Desktop 共用的配置事务；平台差异只在凭据 adapter 和 Host 能力。 */
export class FileConfigStore implements AgentConfigStore {
  readonly supportsDetachedRuntimeHost: boolean;
  private currentRevision = 0;
  private writeTail = Promise.resolve();
  private readonly credentials: CredentialStore;
  private readonly configRoot: string;
  private readonly pathOptions: ConfigPathOptions;
  private readonly journalPath: string;

  constructor(private readonly workspaceRoot: string, options: FileConfigStoreOptions = {}) {
    this.credentials = options.credentialStore ?? createCredentialStore();
    this.configRoot = options.globalDir ?? globalConfigDir();
    // 默认根目录的配置解析归 loader 所有，两种入口走同一读取规则。
    this.pathOptions = { globalDir: path.resolve(this.configRoot) === path.resolve(globalConfigDir()) ? undefined : this.configRoot };
    this.journalPath = path.join(this.configRoot, CREDENTIAL_TRANSACTION_JOURNAL);
    this.supportsDetachedRuntimeHost = options.credentialStore === undefined;
  }

  // 保留 File store 的闭包调用约定：方法解构后仍绑定同一个事务实例。
  configPath = (): string => path.join(this.configRoot, CONFIG_FILE);
  revision = (): number => this.currentRevision;

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(() => withGlobalConfigWriteLock(this.configRoot, operation));
    this.writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async loadUnlocked(workspaceRoot: string): Promise<AgentConfig> {
    const loadDocument = () => loadConfig(workspaceRoot, this.pathOptions);
    await recoverStoredCredentialTransaction(this.credentials, this.journalPath, loadDocument);
    let document = await loadDocument();
    if (Object.values(document.providers).some(provider => Boolean(provider.apiKey || provider.oauth?.refreshToken))) {
      if (!this.credentials.persistent) {
        throw new Error("配置文件包含明文凭据，但当前平台没有持久凭据存储；请改用 providers.<alias>.apiKeyEnv。");
      }
      const target = structuredClone(document);
      await saveConfigAndStoredCredentials(
        target, document, this.credentials, this.journalPath,
        () => saveConfig(workspaceRoot, target, this.pathOptions), loadDocument
      );
      document = await loadDocument();
      this.currentRevision += 1;
    }
    return await applyStoredCredentials(document, this.credentials);
  }

  private async saveUnlocked(config: AgentConfig, workspaceRoot: string, deferredFor?: string): Promise<void> {
    const previous = await this.loadUnlocked(workspaceRoot);
    if (deferredFor !== undefined) {
      const effective = applyProjectSettings(config, await loadProjectSettings(workspaceRoot));
      // 外层恢复只持有有效 before 快照，无法还原被项目遮住的全局旧值；在写入前拒绝。
      if (configDocumentRevision(effective) !== configDocumentRevision(config)) {
        throw new Error("延迟配置事务不能修改被项目设置覆盖的字段；请使用全局配置视图修改。");
      }
    }
    await saveConfigAndStoredCredentials(
      config, previous, this.credentials, this.journalPath,
      () => saveConfig(workspaceRoot, config, this.pathOptions),
      () => loadConfig(workspaceRoot, this.pathOptions), { deferredFor }
    );
    this.currentRevision += 1;
  }

  load = (workspaceRoot = this.workspaceRoot): Promise<AgentConfig> => {
    return this.transaction(() => this.loadUnlocked(workspaceRoot));
  }

  save = (config: AgentConfig, workspaceRoot = this.workspaceRoot): Promise<void> => {
    return this.transaction(() => this.saveUnlocked(config, workspaceRoot));
  }

  loadVersioned = async (workspaceRoot = this.workspaceRoot): Promise<VersionedConfigSnapshot> => {
    const config = await this.load(workspaceRoot);
    return { config, revision: configDocumentRevision(config) };
  }

  saveVersioned = (config: AgentConfig, expectedRevision: string, workspaceRoot = this.workspaceRoot): Promise<VersionedConfigSnapshot> => {
    return this.saveVersionedTransaction(config, expectedRevision, workspaceRoot);
  }

  saveVersionedDeferred = (config: AgentConfig, expectedRevision: string, deferredFor: string, workspaceRoot = this.workspaceRoot): Promise<VersionedConfigSnapshot> => {
    return this.saveVersionedTransaction(config, expectedRevision, workspaceRoot, deferredFor);
  }

  private saveVersionedTransaction(config: AgentConfig, expectedRevision: string, workspaceRoot: string, deferredFor?: string): Promise<VersionedConfigSnapshot> {
    return this.transaction(async () => {
      assertConfigRevision(expectedRevision, await this.loadUnlocked(workspaceRoot));
      await this.saveUnlocked(config, workspaceRoot, deferredFor);
      // 项目覆盖可能遮住刚保存的全局值；普通及 deferred 保存都返回锁内重读的有效快照。
      const saved = await this.loadUnlocked(workspaceRoot);
      return { config: saved, revision: configDocumentRevision(saved) };
    });
  }

  deferredCredentialStatus = (deferredFor: string, workspaceRoot = this.workspaceRoot): Promise<DeferredCredentialTransactionStatus> => {
    return this.transaction(() => deferredCredentialTransactionStatus(
      this.credentials, this.journalPath, () => loadConfig(workspaceRoot, this.pathOptions), deferredFor
    ));
  }

  finalizeDeferredCredentials = (deferredFor: string, workspaceRoot = this.workspaceRoot): Promise<void> => {
    return this.transaction(() => finalizeDeferredCredentialTransaction(
      this.credentials, this.journalPath, () => loadConfig(workspaceRoot, this.pathOptions), deferredFor
    ));
  }

  rollbackVersionedDeferred = async (before: AgentConfig, targetRevision: string, deferredFor: string, workspaceRoot = this.workspaceRoot): Promise<"not_needed" | "completed" | "failed"> => {
    try {
      return await this.transaction(async () => {
        const loadDocument = () => loadConfig(workspaceRoot, this.pathOptions);
        await recoverStoredCredentialTransaction(this.credentials, this.journalPath, loadDocument);
        const currentRevision = configDocumentRevision(await loadDocument());
        const beforeRevision = configDocumentRevision(before);
        const configNeedsRollback = currentRevision === targetRevision && targetRevision !== beforeRevision;
        if (!configNeedsRollback && currentRevision !== beforeRevision) return "failed";
        const credentialSide = await rollbackDeferredCredentialTransaction(
          this.credentials, this.journalPath, loadDocument, deferredFor,
          configNeedsRollback ? async () => {
            await saveConfig(workspaceRoot, before, this.pathOptions);
            assertConfigRevision(beforeRevision, await loadDocument());
          } : undefined
        );
        if (configNeedsRollback) this.currentRevision += 1;
        return configNeedsRollback || credentialSide === "target" ? "completed" : "not_needed";
      });
    } catch { return "failed"; }
  }

  rollbackDeferredCredentials = async (deferredFor: string, workspaceRoot = this.workspaceRoot): Promise<"not_needed" | "completed" | "failed"> => {
    try {
      return await this.transaction(async () => {
        const side = await rollbackDeferredCredentialTransaction(
          this.credentials, this.journalPath, () => loadConfig(workspaceRoot, this.pathOptions), deferredFor
        );
        return side === "target" ? "completed" : "not_needed";
      });
    } catch { return "failed"; }
  }
}
