/**
 * 桌面端全局配置存储。
 *
 * 生产环境直接复用 CLI 的全局配置路径；凭据用 `DesktopSafeStorageCredentialStore`
 * （Electron safeStorage 加密落自管文件），不走 `security` CLI，避免 ACL 授权卡死。
 * 测试通过标准 CredentialStore 注入内存实现。
 */
import path from "node:path";
import { loadConfig, saveConfig } from "../../../config/loader.js";
import {
  applyStoredCredentials,
  CREDENTIAL_TRANSACTION_JOURNAL,
  deferredCredentialTransactionStatus,
  finalizeDeferredCredentialTransaction,
  hasPendingCredentialTransaction,
  recoverStoredCredentialTransaction,
  rollbackDeferredCredentialTransaction,
  saveConfigAndStoredCredentials,
  type DeferredCredentialTransactionStatus,
  type CredentialStore
} from "../../../config/credentials.js";
import { DesktopSafeStorageCredentialStore } from "./DesktopSafeStorageCredentialStore.js";
import { migrateLegacyGlobalState } from "../../../config/globalStateMigration.js";
import { globalConfigDir } from "../../../config/paths.js";
import type { AgentConfig } from "../../../config/schema.js";
import type { AgentConfigStore } from "../../../config/store.js";
import {
  assertConfigRevision,
  configDocumentRevision,
  withGlobalConfigWriteLock,
  type VersionedConfigSnapshot
} from "../../../config/versioned.js";

export class DesktopConfigStore implements AgentConfigStore {
  /** safeStorage 解密只在 Electron 主进程可用，不能把这份 store 交给 detached Host。 */
  readonly supportsDetachedRuntimeHost = false;
  private writeTail = Promise.resolve();
  private currentRevision = 0;

  constructor(
    private readonly root: string,
    // 桌面端默认用 safeStorage 凭据存储（系统 Keychain Services 派生密钥、加密落自管文件），
    // 避免 `security` CLI 的 ACL 授权卡死；测试仍可注入内存实现。
    private readonly credentials: CredentialStore = new DesktopSafeStorageCredentialStore(root)
  ) {}

  async load(workspaceRoot = this.root): Promise<AgentConfig> {
    if (path.resolve(this.root) === path.resolve(globalConfigDir())) await migrateLegacyGlobalState();
    // 纯读不获取全局写锁：config.json 经 writeStoreFile 的 tmp+rename 原子替换，读不到半写文件；
    // 真实 Keychain 账号只在 journal 存在期间被改写，所以「锁外确认无待恢复事务」就能安全地
    // 直接读 config + 水合凭据。这是切换模型等纯读路径的常态。
    if (!(await hasPendingCredentialTransaction(this.credentialJournalPath()))) {
      return await this.readAppliedCredentials(workspaceRoot);
    }
    // 见到 journal：进全局写锁重查并完成补偿恢复（两段式的慢路径，语义与原先一致）。
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(
      this.root,
      async () => await this.loadUnlocked(workspaceRoot)
    ));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async save(config: AgentConfig, workspaceRoot = this.root): Promise<void> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(
      this.root,
      async () => await this.saveUnlocked(config, workspaceRoot)
    ));
    this.writeTail = run.catch(() => undefined);
    await run;
  }

  async loadVersioned(workspaceRoot = this.root): Promise<VersionedConfigSnapshot> {
    const config = await this.load(workspaceRoot);
    return { config, revision: configDocumentRevision(config) };
  }

  async saveVersioned(
    config: AgentConfig,
    expectedRevision: string,
    workspaceRoot = this.root
  ): Promise<VersionedConfigSnapshot> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      assertConfigRevision(expectedRevision, await this.loadUnlocked(workspaceRoot));
      await this.saveUnlocked(config, workspaceRoot);
      return { config, revision: configDocumentRevision(config) };
    }));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async saveVersionedDeferred(
    config: AgentConfig,
    expectedRevision: string,
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<VersionedConfigSnapshot> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      assertConfigRevision(expectedRevision, await this.loadUnlocked(workspaceRoot));
      await this.saveUnlocked(config, workspaceRoot, deferredFor);
      return { config, revision: configDocumentRevision(config) };
    }));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async deferredCredentialStatus(
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<DeferredCredentialTransactionStatus> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => (
      await deferredCredentialTransactionStatus(
        this.credentials,
        this.credentialJournalPath(),
        async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
        deferredFor
      )
    )));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async finalizeDeferredCredentials(deferredFor: string, workspaceRoot = this.root): Promise<void> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      await finalizeDeferredCredentialTransaction(
        this.credentials,
        this.credentialJournalPath(),
        async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
        deferredFor
      );
    }));
    this.writeTail = run.then(() => undefined, () => undefined);
    await run;
  }

  async rollbackVersionedDeferred(
    before: AgentConfig,
    targetRevision: string,
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<"not_needed" | "completed" | "failed"> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      const loadDocument = async (): Promise<AgentConfig> => await loadConfig(workspaceRoot, { globalDir: this.root });
      await recoverStoredCredentialTransaction(this.credentials, this.credentialJournalPath(), loadDocument);
      const currentRevision = configDocumentRevision(await loadDocument());
      const beforeRevision = configDocumentRevision(before);
      const configNeedsRollback = currentRevision === targetRevision && targetRevision !== beforeRevision;
      if (!configNeedsRollback && currentRevision !== beforeRevision) return "failed" as const;
      const credentialSide = await rollbackDeferredCredentialTransaction(
        this.credentials,
        this.credentialJournalPath(),
        loadDocument,
        deferredFor,
        configNeedsRollback
          ? async () => {
              await saveConfig(workspaceRoot, before, { globalDir: this.root });
              assertConfigRevision(beforeRevision, await loadDocument());
            }
          : undefined
      );
      if (configNeedsRollback) this.currentRevision += 1;
      return configNeedsRollback || credentialSide === "target" ? "completed" as const : "not_needed" as const;
    }).catch(() => "failed" as const));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async rollbackDeferredCredentials(
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<"not_needed" | "completed" | "failed"> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      const side = await rollbackDeferredCredentialTransaction(
        this.credentials,
        this.credentialJournalPath(),
        async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
        deferredFor
      );
      return side === "target" ? "completed" as const : "not_needed" as const;
    }).catch(() => "failed" as const));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  configPath(): string {
    return path.join(this.root, "config.json");
  }

  revision(): number {
    return this.currentRevision;
  }

  private async saveUnlocked(config: AgentConfig, workspaceRoot: string, deferredFor?: string): Promise<void> {
    const previous = await this.loadUnlocked(workspaceRoot);
    await saveConfigAndStoredCredentials(
      config,
      previous,
      this.credentials,
      this.credentialJournalPath(),
      async () => await saveConfig(workspaceRoot, config, { globalDir: this.root }),
      async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
      { deferredFor }
    );
    this.currentRevision += 1;
  }

  private async loadUnlocked(workspaceRoot: string): Promise<AgentConfig> {
    // 已持有全局写锁：只读一次文档，恢复流程用它计算 revision，恢复返回后继续复用它水合凭据。
    // recoverStoredCredentialTransaction 只改写 Keychain 与 journal、不写 config.json，因此无需
    // 再读第二遍。
    const document = await this.readDocument(workspaceRoot);
    await recoverStoredCredentialTransaction(
      this.credentials,
      this.credentialJournalPath(),
      async () => document
    );
    return await applyStoredCredentials(document, this.credentials);
  }

  /** 纯读路径：不拿锁、不做补偿恢复，直接读 config 并水合凭据。调用方已确认无待恢复 journal。 */
  private async readAppliedCredentials(workspaceRoot: string): Promise<AgentConfig> {
    return await applyStoredCredentials(await this.readDocument(workspaceRoot), this.credentials);
  }

  private async readDocument(workspaceRoot: string): Promise<AgentConfig> {
    return await loadConfig(workspaceRoot, { globalDir: this.root });
  }

  private credentialJournalPath(): string {
    return path.join(this.root, CREDENTIAL_TRANSACTION_JOURNAL);
  }
}
