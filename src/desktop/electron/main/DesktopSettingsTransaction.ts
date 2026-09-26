/**
 * Desktop 设置页的跨存储事务协调器。
 *
 * Desktop 偏好、全局 config 与聊天 catalog 各自已有原子写和 CAS，但没有共同的数据库事务。
 * 这里用单进程 mutex 做 prepare/commit 串行化，用不含凭据正文和自定义指令的 journal 记录
 * 分段进度；受限恢复 payload 保存脱敏的临时版本，即时失败和崩溃恢复都按
 * chat -> config -> preferences 补偿。任何 revision 或文件绑定无法证明时必须返回
 * recovery_required，绝不猜测覆盖。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { DeferredCredentialTransactionStatus } from "../../../config/credentials.js";
import { configSchema, type AgentConfig } from "../../../config/schema.js";
import { configDocumentRevision } from "../../../config/versioned.js";
import { ConfigRevisionConflictError } from "../../../config/versioned.js";
import {
  SESSION_CATALOG_MISSING_REVISION,
  SessionCatalogConflictError,
  sessionCatalogRecordRevision,
  type SessionCatalogRecord
} from "../../../session/catalog.js";
import { normalizeFontPreference } from "../../fontPreference.js";
import type {
  DesktopSettingsConflict,
  DesktopSettingsChatSnapshot,
  DesktopSettingsSaveInput,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot,
  DesktopSettingsPendingRecovery
} from "../../protocol.js";
import {
  DesktopPreferenceRevisionConflictError,
  type DesktopPreferenceSnapshot,
  type DesktopStateStore
} from "./DesktopStateStore.js";
import {
  type DesktopSettingsConfigSnapshot,
  type PreparedDesktopSettingsChat,
  type PreparedDesktopSettingsConfig
} from "./DesktopAgentManager.js";

const journalVersion = 1 as const;
const recoveryPayloadVersion = 1 as const;
const maxRecoveryPayloadBytes = 8 * 1024 * 1024;

type SegmentState = "pending" | "committed" | "rolling_back" | "rolled_back";

interface DesktopSettingsRecoveryPayloadReference {
  fileName: string;
  sha256: string;
}

interface DesktopSettingsRecoveryPayload {
  version: typeof recoveryPayloadVersion;
  id: string;
  config?: {
    projectId: string;
    workspaceRoot: string;
    before: AgentConfig;
    after: AgentConfig;
    beforeRevision: string;
    targetRevision: string;
  };
  chatMetadata?: {
    projectId: string;
    persistenceRoot: string;
    sessionId: string;
    before?: SessionCatalogRecord;
    after: SessionCatalogRecord;
    beforeRevision: string;
    targetRevision: string;
  };
}

export interface DesktopSettingsJournal {
  version: typeof journalVersion;
  id: string;
  projectId: string;
  createdAt: string;
  /** 敏感设置正文放在单独的 0600 临时版本；journal 只绑定文件名和内容哈希。 */
  recoveryPayload?: DesktopSettingsRecoveryPayloadReference;
  segments: {
    preferences: {
      included: boolean;
      state: SegmentState;
      before: DesktopPreferenceSnapshot;
      after: DesktopPreferenceSnapshot;
      /** 补偿会推进 revision；记录复读快照才能在清 journal 前崩溃后确认回滚已完成。 */
      rollback?: DesktopPreferenceSnapshot;
    };
    config: {
      included: boolean;
      state: SegmentState;
      beforeRevision: string;
      targetRevision: string;
      rollbackRevision?: string;
      credentialHandles: string[];
    };
    chatMetadata: {
      included: boolean;
      state: SegmentState;
      sessionId?: string;
      beforeRevision?: string;
      targetRevision?: string;
      rollbackRevision?: string;
    };
  };
}

/**
 * 事务只依赖设置读写契约，不依赖 DesktopAgentManager 的运行时实现细节。
 * 这个窄接口也让逐段故障注入可以覆盖状态机，而无需启动 Electron/Runtime Host。
 */
export interface DesktopSettingsTransactionAgents {
  hasRunningTasks(): boolean;
  settingsConfigSnapshot(projectId: string): Promise<DesktopSettingsConfigSnapshot>;
  settingsChatSnapshot(projectId: string, sessionId: string): Promise<DesktopSettingsChatSnapshot>;
  prepareSettingsConfig(projectId: string, input: DesktopSettingsSaveInput): Promise<PreparedDesktopSettingsConfig>;
  prepareSettingsChat(
    projectId: string,
    input: NonNullable<DesktopSettingsSaveInput["chat"]>
  ): Promise<PreparedDesktopSettingsChat>;
  commitSettingsConfig(prepared: PreparedDesktopSettingsConfig, transactionId: string): Promise<void>;
  commitSettingsChat(prepared: PreparedDesktopSettingsChat): Promise<void>;
  settingsConfigTransactionStatus(
    projectId: string,
    transactionId: string
  ): Promise<DeferredCredentialTransactionStatus>;
  finalizeSettingsConfig(projectId: string, transactionId: string): Promise<void>;
  rollbackSettingsConfig(
    prepared: PreparedDesktopSettingsConfig,
    transactionId: string
  ): Promise<"not_needed" | "completed" | "failed">;
  rollbackPendingSettingsConfig(
    projectId: string,
    transactionId: string
  ): Promise<"not_needed" | "completed" | "failed">;
  rollbackSettingsChat(prepared: PreparedDesktopSettingsChat): Promise<"not_needed" | "completed" | "failed">;
  consumeSettingsCredentials(handles: string[]): void;
  /** 仅在复读验证和 journal 清理完成后触发；实现方不得让派生任务失败反向影响事务。 */
  settingsCommitted?(prepared: PreparedDesktopSettingsConfig): void;
}

export class DesktopSettingsTransaction {
  private operationTail = Promise.resolve();

  constructor(
    private readonly state: DesktopStateStore,
    private readonly agents: DesktopSettingsTransactionAgents
  ) {}

  /**
   * 主进程开放窗口和 IPC 前先跑一次恢复。这里返回状态而不是抛错：无法自动判定时仍要让
   * 用户进入设置页查看恢复提示，但后续所有工作入口会由 assertRuntimeReady 拒绝。
   */
  async recoverAtStartup(): Promise<DesktopSettingsPendingRecovery | undefined> {
    return await this.runExclusive(async () => await this.recoverPendingJournal());
  }

  async snapshot(projectId: string, sessionId?: string): Promise<DesktopSettingsSnapshot> {
    return await this.runExclusive(async () => {
      const pendingRecovery = await this.recoverPendingJournal();
      return await this.buildSnapshot(projectId, sessionId, pendingRecovery);
    });
  }

  /** recovery_required 是全局配置状态，不允许在一致性恢复前启动任何新工作。 */
  async assertRuntimeReady(): Promise<void> {
    await this.runExclusive(async () => {
      const pendingRecovery = await this.recoverPendingJournal();
      if (pendingRecovery) {
        throw new Error(`设置事务尚未恢复，暂时不能启动新任务：${pendingRecovery.message}`);
      }
    });
  }

  async save(projectId: string, input: DesktopSettingsSaveInput): Promise<DesktopSettingsSaveResult> {
    return await this.runExclusive(async () => {
      const pendingRecovery = await this.recoverPendingJournal();
      if (pendingRecovery) {
        return {
          status: "recovery_required",
          journalId: pendingRecovery.journalId,
          message: pendingRecovery.message,
          snapshot: await this.safeSnapshot(projectId, input.chat?.sessionId, pendingRecovery)
        };
      }

      const preferences = this.state.settingsPreferences();
      const [configSnapshot, chatSnapshot] = await Promise.all([
        this.agents.settingsConfigSnapshot(projectId),
        input.chat === undefined
          ? undefined
          : this.agents.settingsChatSnapshot(projectId, input.chat.sessionId)
      ]);
      const preflightConflicts = inputConflicts(preferences, configSnapshot, chatSnapshot, input);
      if (preflightConflicts.length) {
        return {
          status: "rolled_back",
          conflicts: preflightConflicts,
          draftRetained: true,
          snapshot: await this.buildSnapshot(projectId, input.chat?.sessionId)
        };
      }

      let preparedConfig: PreparedDesktopSettingsConfig;
      let preparedChat: PreparedDesktopSettingsChat | undefined;
      try {
        preparedConfig = await this.agents.prepareSettingsConfig(projectId, input);
        preparedChat = input.chat === undefined
          ? undefined
          : await this.agents.prepareSettingsChat(projectId, input.chat);
      } catch (error) {
        return {
          status: "rolled_back",
          message: safeMessage(error),
          draftRetained: true,
          snapshot: await this.buildSnapshot(projectId, input.chat?.sessionId)
        };
      }

      const conflicts = settingsConflicts(preferences, preparedConfig, preparedChat, input);
      if (conflicts.length) {
        return {
          status: "rolled_back",
          conflicts,
          draftRetained: true,
          snapshot: await this.buildSnapshot(projectId, input.chat?.sessionId)
        };
      }

      const journal = createJournal(projectId, preferences, preparedConfig, preparedChat, input);
      const appliedFields = listAppliedFields(input);
      if (!appliedFields.length) {
        return {
          status: "committed",
          journalId: journal.id,
          appliedFields,
          snapshot: await this.buildSnapshot(projectId, input.chat?.sessionId)
        };
      }

      let preferencesCommitted = false;
      let configAttempted = false;
      let chatAttempted = false;
      let journalPersisted = false;
      try {
        const recoveryPayload = createRecoveryPayload(journal.id, preparedConfig, preparedChat, journal);
        if (recoveryPayload) {
          journal.recoveryPayload = await this.writeRecoveryPayload(recoveryPayload);
        }
        await this.writeJournal(journal);
        journalPersisted = true;
        if (journal.segments.preferences.included) {
          await this.state.applySettingsPreferences({
            themePreference: input.themePreference,
            fontPreference: input.fontPreference
          }, preferences.revision);
          preferencesCommitted = true;
          journal.segments.preferences.state = "committed";
          await this.writeJournal(journal);
        }
        if (journal.segments.config.included) {
          configAttempted = true;
          await this.agents.commitSettingsConfig(preparedConfig, journal.id);
          journal.segments.config.state = "committed";
          await this.writeJournal(journal);
        }
        if (preparedChat !== undefined) {
          chatAttempted = true;
          await this.agents.commitSettingsChat(preparedChat);
          journal.segments.chatMetadata.state = "committed";
          await this.writeJournal(journal);
        }
        const snapshot = await this.buildSnapshot(projectId, input.chat?.sessionId);
        assertCommittedSnapshot(journal, snapshot);
        try {
          if (journal.segments.config.included) {
            await this.agents.finalizeSettingsConfig(projectId, journal.id);
          }
          await this.deleteTransactionArtifacts(journal);
        } catch (error) {
          const message = `设置已提交并复读确认，但事务收尾尚未完成：${safeMessage(error)}`;
          return {
            status: "recovery_required",
            journalId: journal.id,
            message,
            snapshot: await this.safeSnapshot(projectId, input.chat?.sessionId, {
              journalId: journal.id,
              message
            })
          };
        }
        this.agents.consumeSettingsCredentials(preparedConfig.credentialHandles);
        try {
          this.agents.settingsCommitted?.(preparedConfig);
        } catch {
          // 索引重建等派生任务不属于设置事务；提交已验证成功，不能再伪装成保存失败。
        }
        return {
          status: "committed",
          journalId: journal.id,
          appliedFields,
          snapshot
        };
      } catch (error) {
        // 初始 journal 都没落下且任何分段都未触碰时，没有需要恢复的外部状态。
        if (!journalPersisted && !preferencesCommitted && !configAttempted && !chatAttempted) {
          await this.deleteRecoveryPayload(journal).catch(() => undefined);
          return {
            status: "rolled_back",
            journalId: journal.id,
            message: safeMessage(error),
            draftRetained: true,
            snapshot: await this.buildSnapshot(projectId, input.chat?.sessionId)
          };
        }
        const rollback = await this.rollback({
          journal,
          preparedConfig,
          preparedChat,
          preferencesCommitted,
          configAttempted,
          chatAttempted,
          failure: error
        });
        if (!rollback) {
          const message = `设置保存失败，且至少一个分段无法确认已回滚：${safeMessage(error)}`;
          return {
            status: "recovery_required",
            journalId: journal.id,
            message,
            snapshot: await this.safeSnapshot(projectId, input.chat?.sessionId, {
              journalId: journal.id,
              message
            })
          };
        }
        try {
          await this.deleteTransactionArtifacts(journal);
        } catch (deleteError) {
          const message = `设置已补偿，但事务 journal 无法清理：${safeMessage(deleteError)}`;
          return {
            status: "recovery_required",
            journalId: journal.id,
            message,
            snapshot: await this.safeSnapshot(projectId, input.chat?.sessionId, {
              journalId: journal.id,
              message
            })
          };
        }
        const conflict = conflictFromError(error);
        return {
          status: "rolled_back",
          journalId: journal.id,
          conflicts: conflict === undefined ? undefined : [conflict],
          message: safeMessage(error),
          draftRetained: true,
          snapshot: await this.buildSnapshot(projectId, input.chat?.sessionId)
        };
      }
    });
  }

  private async rollback(options: {
    journal: DesktopSettingsJournal;
    preparedConfig: PreparedDesktopSettingsConfig;
    preparedChat?: PreparedDesktopSettingsChat;
    preferencesCommitted: boolean;
    configAttempted: boolean;
    chatAttempted: boolean;
    failure: unknown;
  }): Promise<boolean> {
    let complete = true;
    if (options.chatAttempted && options.preparedChat) {
      // CAS 在写入前失败，当前聊天元数据不属于本事务，不能拿候选 revision 去覆盖它。
      if (options.failure instanceof SessionCatalogConflictError) {
        options.journal.segments.chatMetadata.state = "rolled_back";
        options.journal.segments.chatMetadata.rollbackRevision = options.failure.actualRevision
          ?? options.preparedChat.beforeRevision;
      } else {
        const result = await this.agents.rollbackSettingsChat(options.preparedChat);
        complete &&= result !== "failed";
        if (result !== "failed") {
          options.journal.segments.chatMetadata.state = "rolled_back";
          options.journal.segments.chatMetadata.rollbackRevision = options.preparedChat.beforeRevision;
        }
      }
    }
    if (options.configAttempted) {
      // saveVersioned 的 CAS 预检失败意味着候选配置从未写入；外部 revision 必须原样保留。
      if (options.failure instanceof ConfigRevisionConflictError) {
        options.journal.segments.config.state = "rolled_back";
        options.journal.segments.config.rollbackRevision = options.failure.actualRevision;
      } else {
        const result = await this.agents.rollbackSettingsConfig(options.preparedConfig, options.journal.id);
        complete &&= result !== "failed";
        if (result !== "failed") {
          options.journal.segments.config.state = "rolled_back";
          options.journal.segments.config.rollbackRevision = options.preparedConfig.beforeRevision;
        }
      }
    }
    if (options.preferencesCommitted) {
      try {
        const current = this.state.settingsPreferences();
        const restored = await this.state.restoreSettingsPreferences(
          options.journal.segments.preferences.before,
          current.revision
        );
        options.journal.segments.preferences.state = "rolled_back";
        options.journal.segments.preferences.rollback = restored;
      } catch {
        complete = false;
      }
    } else if (options.failure instanceof DesktopPreferenceRevisionConflictError
      && options.journal.segments.preferences.included) {
      options.journal.segments.preferences.state = "rolled_back";
      options.journal.segments.preferences.rollback = this.state.settingsPreferences();
    }
    await this.writeJournal(options.journal).catch(() => {
      complete = false;
    });
    return complete;
  }

  private async recoverPendingJournal(): Promise<DesktopSettingsPendingRecovery | undefined> {
    let journal: DesktopSettingsJournal | undefined;
    try {
      journal = await this.readJournal();
    } catch (error) {
      return recoveryRequired("unreadable", `设置事务 journal 无法读取：${safeMessage(error)}`);
    }
    if (!journal) {
      try {
        await this.cleanupOrphanRecoveryPayloads();
        return undefined;
      } catch (error) {
        return recoveryRequired("orphaned-payload", `设置事务临时版本无法安全清理：${safeMessage(error)}`);
      }
    }
    try {
      const preferences = this.state.settingsPreferences();
      const config = await this.agents.settingsConfigSnapshot(journal.projectId);
      const credentialStatus = journal.segments.config.included
        ? await this.agents.settingsConfigTransactionStatus(journal.projectId, journal.id)
        : "missing";
      const chat = journal.segments.chatMetadata.included && journal.segments.chatMetadata.sessionId
        ? await this.agents.settingsChatSnapshot(journal.projectId, journal.segments.chatMetadata.sessionId)
        : undefined;
      const preferencesAtTarget = !journal.segments.preferences.included
        || samePreferences(preferences, journal.segments.preferences.after);
      const configAtTarget = !journal.segments.config.included
        || config.revision === journal.segments.config.targetRevision
          && (journal.segments.config.targetRevision !== journal.segments.config.beforeRevision
            || journal.segments.config.state === "committed"
            || journal.segments.config.state === "pending" && credentialStatus === "target");
      const chatAtTarget = !journal.segments.chatMetadata.included
        || chat?.metadataRevision === journal.segments.chatMetadata.targetRevision
          && (journal.segments.chatMetadata.targetRevision !== journal.segments.chatMetadata.beforeRevision
            || journal.segments.chatMetadata.state === "committed");
      if (preferencesAtTarget && configAtTarget && chatAtTarget) {
        let journalChanged = false;
        if (journal.segments.preferences.included && journal.segments.preferences.state === "pending") {
          journal.segments.preferences.state = "committed";
          journalChanged = true;
        }
        if (journal.segments.config.included && journal.segments.config.state === "pending") {
          journal.segments.config.state = "committed";
          journalChanged = true;
        }
        if (journal.segments.chatMetadata.included && journal.segments.chatMetadata.state === "pending") {
          journal.segments.chatMetadata.state = "committed";
          journalChanged = true;
        }
        // 先把由内层 marker 推断出的提交状态写回外层，再清 Keychain 备份；两步之间崩溃仍可复读。
        if (journalChanged) await this.writeJournal(journal);
        if (journal.segments.config.included) {
          await this.agents.finalizeSettingsConfig(journal.projectId, journal.id);
        }
        await this.deleteTransactionArtifacts(journal);
        this.agents.consumeSettingsCredentials(journal.segments.config.credentialHandles);
        return undefined;
      }

      const preferencesRolledBack = !journal.segments.preferences.included
        || journal.segments.preferences.state === "rolled_back"
          && journal.segments.preferences.rollback !== undefined
          && samePreferences(preferences, journal.segments.preferences.rollback);
      const configRolledBack = !journal.segments.config.included
        || journal.segments.config.state === "rolled_back"
          && config.revision === journal.segments.config.rollbackRevision
          && credentialStatus !== "target";
      const chatRolledBack = !journal.segments.chatMetadata.included
        || journal.segments.chatMetadata.state === "rolled_back"
          && chat?.metadataRevision === journal.segments.chatMetadata.rollbackRevision;
      if (preferencesRolledBack && configRolledBack && chatRolledBack) {
        if (journal.segments.config.included) {
          const result = await this.agents.rollbackPendingSettingsConfig(journal.projectId, journal.id);
          if (result === "failed") {
            return recoveryRequired(journal.id, "设置事务的 Keychain 补偿无法完成。");
          }
        }
        await this.deleteTransactionArtifacts(journal);
        return undefined;
      }

      const payloadRecovery = await this.tryRecoverWithPayload({
        journal,
        preferences,
        config,
        credentialStatus,
        chat
      });
      if (payloadRecovery !== "not_applicable") return payloadRecovery;

      // before==target 时 revision 本身没有方向；内层延迟 journal 的 status 提供提交/补偿证据。
      const preferencesAtBefore = samePreferences(preferences, journal.segments.preferences.before);
      const configSafelyAtBefore = !journal.segments.config.included
        || journal.segments.config.state === "pending"
          && config.revision === journal.segments.config.beforeRevision
          && (journal.segments.config.targetRevision !== journal.segments.config.beforeRevision
            || credentialStatus === "before"
            || credentialStatus === "missing" && journal.segments.config.credentialHandles.length === 0);
      const sameRevisionConfigCanCompensate = journal.segments.config.included
        && journal.segments.config.state === "pending"
        && journal.segments.config.targetRevision === journal.segments.config.beforeRevision
        && config.revision === journal.segments.config.beforeRevision
        && credentialStatus === "target";
      const chatSafelyAtBefore = !journal.segments.chatMetadata.included
        || journal.segments.chatMetadata.state === "pending"
          && journal.segments.chatMetadata.targetRevision !== journal.segments.chatMetadata.beforeRevision
          && chat?.metadataRevision === journal.segments.chatMetadata.beforeRevision;
      const preferencesCanRestore = !journal.segments.preferences.included
        || preferencesAtBefore
        || preferencesAtTarget
        || preferencesRolledBack;
      if ((configSafelyAtBefore || sameRevisionConfigCanCompensate) && chatSafelyAtBefore && preferencesCanRestore) {
        if (journal.segments.config.included) {
          // 先持久化补偿方向，再让内层恢复 before；内层清理后崩溃也不会重新落入同 revision 歧义。
          journal.segments.config.state = "rolled_back";
          journal.segments.config.rollbackRevision = config.revision;
          await this.writeJournal(journal);
          const result = await this.agents.rollbackPendingSettingsConfig(journal.projectId, journal.id);
          if (result === "failed") {
            return recoveryRequired(journal.id, "设置事务的 Keychain 补偿无法完成。");
          }
        }
        if (journal.segments.preferences.included && preferencesAtTarget && !preferencesAtBefore) {
          journal.segments.preferences.rollback = await this.state.restoreSettingsPreferences(
            journal.segments.preferences.before,
            preferences.revision
          );
        } else if (journal.segments.preferences.included) {
          journal.segments.preferences.rollback = preferences;
        }
        journal.segments.preferences.state = journal.segments.preferences.included ? "rolled_back" : "pending";
        if (journal.segments.chatMetadata.included) {
          journal.segments.chatMetadata.state = "rolled_back";
          journal.segments.chatMetadata.rollbackRevision = chat?.metadataRevision;
        }
        // 先把补偿证据持久化，再清理 journal；两步之间崩溃也能在下次启动确认。
        await this.writeJournal(journal);
        await this.deleteTransactionArtifacts(journal);
        return undefined;
      }
      return recoveryRequired(journal.id, "检测到未完成的设置事务，现有 revision 无法证明应提交还是回滚。");
    } catch (error) {
      return recoveryRequired(journal.id, `设置事务自动恢复失败：${safeMessage(error)}`);
    }
  }

  /**
   * 新事务的脱敏 payload 让跨段崩溃可以确定性补偿。先按实际 revision 判断每段仍在
   * before/target，再逐段记录 rolling_back；任何外部第三方 revision 都立即 fail closed。
   */
  private async tryRecoverWithPayload(options: {
    journal: DesktopSettingsJournal;
    preferences: DesktopPreferenceSnapshot;
    config: DesktopSettingsConfigSnapshot;
    credentialStatus: DeferredCredentialTransactionStatus;
    chat?: DesktopSettingsChatSnapshot;
  }): Promise<"not_applicable" | DesktopSettingsPendingRecovery | undefined> {
    const { journal } = options;
    if (!journal.recoveryPayload) return "not_applicable";

    let payload: DesktopSettingsRecoveryPayload;
    try {
      payload = await this.readRecoveryPayload(journal);
    } catch (error) {
      return recoveryRequired(journal.id, `设置事务临时版本无法验证：${safeMessage(error)}`);
    }

    const preferencesSide = !journal.segments.preferences.included
      ? "before"
      : samePreferences(options.preferences, journal.segments.preferences.before)
        ? "before"
        : journal.segments.preferences.state === "rolling_back"
            && options.preferences.revision === journal.segments.preferences.after.revision + 1
            && samePreferenceValues(options.preferences, journal.segments.preferences.before)
          ? "before"
        : samePreferences(options.preferences, journal.segments.preferences.after)
          ? "target"
          : journal.segments.preferences.rollback !== undefined
              && samePreferences(options.preferences, journal.segments.preferences.rollback)
            ? "before"
            : "unknown";
    const configSide = settingsConfigSide(journal, options.config.revision, options.credentialStatus);
    const chatSide = !journal.segments.chatMetadata.included
      ? "before"
      : options.chat?.metadataRevision === journal.segments.chatMetadata.beforeRevision
        ? "before"
        : options.chat?.metadataRevision === journal.segments.chatMetadata.targetRevision
          ? "target"
          : "unknown";
    if (preferencesSide === "unknown" || configSide === "unknown" || chatSide === "unknown") {
      return recoveryRequired(journal.id, "设置事务恢复时检测到外部 revision，未自动覆盖该状态。");
    }
    if (journal.segments.config.included && payload.config === undefined) {
      return recoveryRequired(journal.id, "设置事务临时版本缺少全局配置补偿数据。");
    }
    if (journal.segments.chatMetadata.included && payload.chatMetadata === undefined) {
      return recoveryRequired(journal.id, "设置事务临时版本缺少聊天设置补偿数据。");
    }

    try {
      if (journal.segments.chatMetadata.included) {
        journal.segments.chatMetadata.state = "rolling_back";
        await this.writeJournal(journal);
        if (chatSide === "target") {
          const result = await this.agents.rollbackSettingsChat(recoveryPreparedChat(payload.chatMetadata!));
          if (result === "failed") throw new Error("聊天设置补偿失败。");
        }
        const restored = await this.agents.settingsChatSnapshot(
          journal.projectId,
          journal.segments.chatMetadata.sessionId!
        );
        if (restored.metadataRevision !== journal.segments.chatMetadata.beforeRevision) {
          throw new Error("聊天设置补偿后的 revision 不匹配。");
        }
        journal.segments.chatMetadata.state = "rolled_back";
        journal.segments.chatMetadata.rollbackRevision = restored.metadataRevision;
        await this.writeJournal(journal);
      }

      if (journal.segments.config.included) {
        journal.segments.config.state = "rolling_back";
        await this.writeJournal(journal);
        if (configSide === "target") {
          const result = await this.agents.rollbackSettingsConfig(
            recoveryPreparedConfig(payload.config!, journal.segments.config.credentialHandles),
            journal.id
          );
          if (result === "failed") throw new Error("全局配置补偿失败。");
        } else {
          const result = await this.agents.rollbackPendingSettingsConfig(journal.projectId, journal.id);
          if (result === "failed") throw new Error("全局配置凭据补偿失败。");
        }
        const restored = await this.agents.settingsConfigSnapshot(journal.projectId);
        const restoredCredentialStatus = await this.agents.settingsConfigTransactionStatus(journal.projectId, journal.id);
        if (restored.revision !== journal.segments.config.beforeRevision || restoredCredentialStatus === "target") {
          throw new Error("全局配置补偿后的 revision 或凭据方向不匹配。");
        }
        journal.segments.config.state = "rolled_back";
        journal.segments.config.rollbackRevision = restored.revision;
        await this.writeJournal(journal);
      }

      if (journal.segments.preferences.included) {
        journal.segments.preferences.state = "rolling_back";
        await this.writeJournal(journal);
        const restored = preferencesSide === "target"
          ? await this.state.restoreSettingsPreferences(
              journal.segments.preferences.before,
              options.preferences.revision
            )
          : options.preferences;
        journal.segments.preferences.state = "rolled_back";
        journal.segments.preferences.rollback = restored;
        await this.writeJournal(journal);
      }

      await this.deleteTransactionArtifacts(journal);
      return undefined;
    } catch (error) {
      return recoveryRequired(journal.id, `设置事务自动补偿未完成：${safeMessage(error)}`);
    }
  }

  private async buildSnapshot(
    projectId: string,
    sessionId?: string,
    pendingRecovery?: DesktopSettingsPendingRecovery
  ): Promise<DesktopSettingsSnapshot> {
    const [config, chat] = await Promise.all([
      this.agents.settingsConfigSnapshot(projectId),
      sessionId === undefined ? undefined : this.agents.settingsChatSnapshot(projectId, sessionId)
    ]);
    const preferences = this.state.settingsPreferences();
    return {
      projectId,
      hasRunningTasks: this.agents.hasRunningTasks(),
      preferenceRevision: preferences.revision,
      configRevision: config.revision,
      themePreference: preferences.themePreference,
      fontPreference: preferences.fontPreference,
      activity: structuredClone(config.activity),
      identity: structuredClone(config.identity),
      memory: config.memory,
      compaction: structuredClone(config.compaction),
      chatParams: structuredClone(config.chatParams),
      permission: structuredClone(config.permission),
      webSearch: config.webSearch,
      models: config.models,
      skills: config.skills ?? {
        projectId,
        projectKey: "",
        globalDefaults: {},
        projectOverrides: {},
        activations: []
      },
      chat,
      pendingRecovery
    };
  }

  private async safeSnapshot(
    projectId: string,
    sessionId: string | undefined,
    pendingRecovery: DesktopSettingsPendingRecovery
  ): Promise<DesktopSettingsSnapshot | undefined> {
    return await this.buildSnapshot(projectId, sessionId, pendingRecovery).catch(() => undefined);
  }

  private async writeRecoveryPayload(
    payload: DesktopSettingsRecoveryPayload
  ): Promise<DesktopSettingsRecoveryPayloadReference> {
    const journalPath = this.state.settingsTransactionJournalPath();
    const directory = await ensureRecoveryDirectory(journalPath);
    const fileName = recoveryPayloadFileName(journalPath, payload.id);
    const target = path.join(directory, fileName);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxRecoveryPayloadBytes) {
      throw new Error(`设置事务临时版本超过 ${String(maxRecoveryPayloadBytes)} 字节限制。`);
    }
    await assertRecoveryTargetMissing(target);
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    let handle: FileHandle | undefined;
    let identity: Pick<Stats, "dev" | "ino"> | undefined;
    try {
      handle = await fs.open(temporary, recoveryWriteFlags(), 0o600);
      const created = await handle.stat();
      if (!created.isFile() || created.nlink !== 1) throw new Error("设置事务临时版本必须是单链接普通文件。");
      identity = { dev: created.dev, ino: created.ino };
      await handle.writeFile(serialized, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      // link 不覆盖既有目标；随后移除临时名字，最终目标仍是单链接文件。
      await fs.link(temporary, target);
      await fs.unlink(temporary);
      await assertRecoveryFileBinding(target, handle, identity);
      await syncDirectory(directory);
    } finally {
      await handle?.close().catch(() => undefined);
      if (identity) await removeRecoveryFileIfBound(temporary, identity).catch(() => undefined);
    }
    return {
      fileName,
      sha256: createHash("sha256").update(serialized).digest("hex")
    };
  }

  private async readRecoveryPayload(journal: DesktopSettingsJournal): Promise<DesktopSettingsRecoveryPayload> {
    const reference = journal.recoveryPayload;
    if (!reference) throw new Error("设置事务未声明临时版本。");
    const journalPath = this.state.settingsTransactionJournalPath();
    const directory = await ensureRecoveryDirectory(journalPath);
    const expectedName = recoveryPayloadFileName(journalPath, journal.id);
    if (reference.fileName !== expectedName || !/^[a-f0-9]{64}$/u.test(reference.sha256)) {
      throw new Error("设置事务临时版本引用无效。");
    }
    const target = path.join(directory, reference.fileName);
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(target, recoveryReadFlags());
      const identity = await assertRecoveryFileBinding(target, handle);
      const stat = await handle.stat();
      if (stat.size > maxRecoveryPayloadBytes) throw new Error("设置事务临时版本过大。");
      const serialized = await handle.readFile("utf8");
      await assertRecoveryFileBinding(target, handle, identity);
      const actualHash = createHash("sha256").update(serialized).digest("hex");
      if (actualHash !== reference.sha256) throw new Error("设置事务临时版本内容哈希不匹配。");
      return parseRecoveryPayload(serialized, journal);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async deleteRecoveryPayload(journal: DesktopSettingsJournal): Promise<void> {
    if (!journal.recoveryPayload) return;
    const journalPath = this.state.settingsTransactionJournalPath();
    const directory = await ensureRecoveryDirectory(journalPath);
    const expectedName = recoveryPayloadFileName(journalPath, journal.id);
    if (journal.recoveryPayload.fileName !== expectedName) throw new Error("设置事务临时版本引用无效。");
    await removeRecoveryFile(path.join(directory, expectedName));
  }

  private async deleteTransactionArtifacts(journal: DesktopSettingsJournal): Promise<void> {
    await this.deleteRecoveryPayload(journal);
    await this.deleteJournal();
  }

  private async cleanupOrphanRecoveryPayloads(): Promise<void> {
    const journalPath = this.state.settingsTransactionJournalPath();
    const directory = await ensureRecoveryDirectory(journalPath);
    const prefix = `${path.basename(journalPath)}.settings-payload-`;
    for (const entry of await fs.readdir(directory)) {
      if (!entry.startsWith(prefix) || !/\.json(?:\.[a-f0-9]{16}\.tmp)?$/u.test(entry)) continue;
      await removeRecoveryFile(path.join(directory, entry));
    }
  }

  private async readJournal(): Promise<DesktopSettingsJournal | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.state.settingsTransactionJournalPath(), "utf8")) as DesktopSettingsJournal;
      if (raw.version !== journalVersion || !validTransactionId(raw.id) || typeof raw.projectId !== "string") {
        throw new Error("设置事务 journal 格式无效。");
      }
      return raw;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  protected async writeJournal(journal: DesktopSettingsJournal): Promise<void> {
    const target = this.state.settingsTransactionJournalPath();
    const temporary = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  }

  protected async deleteJournal(): Promise<void> {
    await fs.unlink(this.state.settingsTransactionJournalPath()).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function createJournal(
  projectId: string,
  preferences: DesktopPreferenceSnapshot,
  config: PreparedDesktopSettingsConfig,
  chat: PreparedDesktopSettingsChat | undefined,
  input: DesktopSettingsSaveInput
): DesktopSettingsJournal {
  const themePreference = input.themePreference ?? preferences.themePreference;
  const fontPreference = input.fontPreference === undefined
    ? preferences.fontPreference
    : normalizeFontPreference(input.fontPreference);
  const preferencesIncluded = input.themePreference !== undefined || input.fontPreference !== undefined;
  const configIncluded = input.activity !== undefined
    || input.identity !== undefined
    || input.memory !== undefined
    || input.compaction !== undefined
    || input.chatParams !== undefined
    || input.permission !== undefined
    || input.webSearch !== undefined
    || input.models !== undefined
    || input.skills !== undefined;
  return {
    version: journalVersion,
    id: randomUUID(),
    projectId,
    createdAt: new Date().toISOString(),
    segments: {
      preferences: {
        included: preferencesIncluded,
        state: "pending",
        before: preferences,
        after: {
          revision: preferences.revision + (preferencesIncluded
            && (themePreference !== preferences.themePreference || !sameFont(fontPreference, preferences.fontPreference)) ? 1 : 0),
          themePreference,
          fontPreference
        },
        rollback: undefined
      },
      config: {
        included: configIncluded,
        state: "pending",
        beforeRevision: config.beforeRevision,
        targetRevision: config.targetRevision,
        rollbackRevision: undefined,
        credentialHandles: [...config.credentialHandles]
      },
      chatMetadata: {
        included: chat !== undefined,
        state: "pending",
        sessionId: chat?.sessionId,
        beforeRevision: chat?.beforeRevision,
        targetRevision: chat?.targetRevision,
        rollbackRevision: undefined
      }
    }
  };
}

function createRecoveryPayload(
  id: string,
  config: PreparedDesktopSettingsConfig,
  chat: PreparedDesktopSettingsChat | undefined,
  journal: DesktopSettingsJournal
): DesktopSettingsRecoveryPayload | undefined {
  if (!journal.segments.config.included && !journal.segments.chatMetadata.included) return undefined;
  return {
    version: recoveryPayloadVersion,
    id,
    config: journal.segments.config.included
      ? {
          projectId: config.projectId,
          workspaceRoot: config.workspaceRoot,
          before: withoutRecoveryCredentials(config.before),
          after: withoutRecoveryCredentials(config.after),
          beforeRevision: config.beforeRevision,
          targetRevision: config.targetRevision
        }
      : undefined,
    chatMetadata: chat === undefined
      ? undefined
      : {
          projectId: chat.projectId,
          persistenceRoot: chat.persistenceRoot,
          sessionId: chat.sessionId,
          before: chat.before === undefined ? undefined : structuredClone(chat.before),
          after: structuredClone(chat.after),
          beforeRevision: chat.beforeRevision,
          targetRevision: chat.targetRevision
        }
  };
}

function withoutRecoveryCredentials(config: AgentConfig): AgentConfig {
  const safe = structuredClone(config);
  for (const provider of Object.values(safe.providers)) {
    provider.apiKey = undefined;
    if (provider.oauth) provider.oauth.refreshToken = undefined;
  }
  return configSchema.parse(safe);
}

function parseRecoveryPayload(serialized: string, journal: DesktopSettingsJournal): DesktopSettingsRecoveryPayload {
  const raw = JSON.parse(serialized) as Partial<DesktopSettingsRecoveryPayload>;
  if (raw.version !== recoveryPayloadVersion || raw.id !== journal.id) {
    throw new Error("设置事务临时版本格式无效。");
  }
  let config: DesktopSettingsRecoveryPayload["config"];
  if (raw.config !== undefined) {
    if (!validRecoveryConfigMetadata(raw.config)) throw new Error("设置事务全局配置临时版本格式无效。");
    const before = configSchema.parse(raw.config.before);
    const after = configSchema.parse(raw.config.after);
    if (hasRecoveryCredential(before) || hasRecoveryCredential(after)) {
      throw new Error("设置事务临时版本不得包含凭据正文。");
    }
    if (!recoveryConfigRevisionMatches(before, raw.config.beforeRevision)
      || !recoveryConfigRevisionMatches(after, raw.config.targetRevision)) {
      throw new Error("设置事务全局配置临时版本 revision 不匹配。");
    }
    if (raw.config.beforeRevision !== journal.segments.config.beforeRevision
      || raw.config.targetRevision !== journal.segments.config.targetRevision) {
      throw new Error("设置事务全局配置临时版本不属于当前 journal。");
    }
    config = { ...raw.config, before, after };
  }
  let chatMetadata: DesktopSettingsRecoveryPayload["chatMetadata"];
  if (raw.chatMetadata !== undefined) {
    if (!validRecoveryChatMetadata(raw.chatMetadata)) throw new Error("设置事务聊天临时版本格式无效。");
    const before = raw.chatMetadata.before === undefined
      ? undefined
      : parseRecoveryChatRecord(raw.chatMetadata.before);
    const after = parseRecoveryChatRecord(raw.chatMetadata.after);
    const beforeRevision = before === undefined ? SESSION_CATALOG_MISSING_REVISION : sessionCatalogRecordRevision(before);
    if (!recoverySessionRevisionMatches(beforeRevision, raw.chatMetadata.beforeRevision)
      || !recoverySessionRevisionMatches(sessionCatalogRecordRevision(after), raw.chatMetadata.targetRevision)
      || raw.chatMetadata.beforeRevision !== journal.segments.chatMetadata.beforeRevision
      || raw.chatMetadata.targetRevision !== journal.segments.chatMetadata.targetRevision
      || raw.chatMetadata.sessionId !== journal.segments.chatMetadata.sessionId) {
      throw new Error("设置事务聊天临时版本 revision 不匹配。");
    }
    chatMetadata = { ...raw.chatMetadata, before, after };
  }
  return { version: recoveryPayloadVersion, id: journal.id, config, chatMetadata };
}

function recoveryPreparedConfig(
  value: NonNullable<DesktopSettingsRecoveryPayload["config"]>,
  credentialHandles: string[]
): PreparedDesktopSettingsConfig {
  return { ...value, credentialHandles: [...credentialHandles] };
}

function recoveryPreparedChat(
  value: NonNullable<DesktopSettingsRecoveryPayload["chatMetadata"]>
): PreparedDesktopSettingsChat {
  return value;
}

function settingsConfigSide(
  journal: DesktopSettingsJournal,
  revision: string,
  credentialStatus: DeferredCredentialTransactionStatus
): "before" | "target" | "unknown" {
  if (!journal.segments.config.included) return "before";
  const segment = journal.segments.config;
  if (segment.state === "rolled_back" && revision === segment.rollbackRevision && credentialStatus !== "target") {
    return "before";
  }
  const markerMayBeMissing = segment.credentialHandles.length === 0;
  if (segment.beforeRevision === segment.targetRevision) {
    if (revision !== segment.beforeRevision) return "unknown";
    if (credentialStatus === "target") return "target";
    if (credentialStatus === "before" || credentialStatus === "missing" && markerMayBeMissing) return "before";
    return "unknown";
  }
  if (revision === segment.targetRevision
    && (credentialStatus === "target" || credentialStatus === "missing" && markerMayBeMissing)) {
    return "target";
  }
  if (revision === segment.beforeRevision
    && (credentialStatus === "before" || credentialStatus === "target"
      || credentialStatus === "missing" && markerMayBeMissing)) {
    return "before";
  }
  return "unknown";
}

function hasRecoveryCredential(config: AgentConfig): boolean {
  return Object.values(config.providers).some((provider) => (
    provider.apiKey !== undefined || provider.oauth?.refreshToken !== undefined
  ));
}

function recoveryConfigRevisionMatches(config: AgentConfig, revision: string): boolean {
  return !revision.startsWith("sha256:") || configDocumentRevision(config) === revision;
}

function recoverySessionRevisionMatches(actual: string, declared: string): boolean {
  if (declared === SESSION_CATALOG_MISSING_REVISION) return actual === declared;
  return !declared.startsWith("sha256:") || actual === declared;
}

function validRecoveryConfigMetadata(
  value: DesktopSettingsRecoveryPayload["config"]
): value is NonNullable<DesktopSettingsRecoveryPayload["config"]> {
  return typeof value === "object" && value !== null
    && typeof value.projectId === "string"
    && typeof value.workspaceRoot === "string"
    && typeof value.beforeRevision === "string"
    && typeof value.targetRevision === "string"
    && typeof value.before === "object" && value.before !== null
    && typeof value.after === "object" && value.after !== null;
}

function validRecoveryChatMetadata(
  value: DesktopSettingsRecoveryPayload["chatMetadata"]
): value is NonNullable<DesktopSettingsRecoveryPayload["chatMetadata"]> {
  return typeof value === "object" && value !== null
    && typeof value.projectId === "string"
    && typeof value.persistenceRoot === "string"
    && typeof value.sessionId === "string"
    && typeof value.beforeRevision === "string"
    && typeof value.targetRevision === "string"
    && typeof value.after === "object" && value.after !== null;
}

function parseRecoveryChatRecord(value: SessionCatalogRecord): SessionCatalogRecord {
  if (typeof value !== "object" || value === null || value.version !== 1
    || typeof value.sessionId !== "string" || typeof value.rootSessionId !== "string"
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("设置事务聊天临时版本条目无效。");
  }
  return structuredClone(value);
}

function assertCommittedSnapshot(
  journal: DesktopSettingsJournal,
  snapshot: DesktopSettingsSnapshot
): void {
  if (journal.segments.preferences.included && !samePreferences({
    revision: snapshot.preferenceRevision,
    themePreference: snapshot.themePreference,
    fontPreference: snapshot.fontPreference
  }, journal.segments.preferences.after)) {
    throw new Error("Desktop 偏好提交后的复读校验失败。");
  }
  if (journal.segments.config.included && snapshot.configRevision !== journal.segments.config.targetRevision) {
    throw new Error("全局配置提交后的复读校验失败。");
  }
  if (journal.segments.chatMetadata.included
    && snapshot.chat?.metadataRevision !== journal.segments.chatMetadata.targetRevision) {
    throw new Error("聊天设置提交后的复读校验失败。");
  }
}

function settingsConflicts(
  preferences: DesktopPreferenceSnapshot,
  config: PreparedDesktopSettingsConfig,
  chat: PreparedDesktopSettingsChat | undefined,
  input: DesktopSettingsSaveInput
): DesktopSettingsConflict[] {
  const conflicts: DesktopSettingsConflict[] = [];
  if (preferences.revision !== input.expectedPreferenceRevision) {
    conflicts.push({
      segment: "preferences",
      expectedRevision: String(input.expectedPreferenceRevision),
      actualRevision: String(preferences.revision)
    });
  }
  if (config.beforeRevision !== input.expectedConfigRevision) {
    conflicts.push({
      segment: "config",
      expectedRevision: input.expectedConfigRevision,
      actualRevision: config.beforeRevision
    });
  }
  if (chat && chat.beforeRevision !== input.chat?.expectedMetadataRevision) {
    conflicts.push({
      segment: "chat_metadata",
      expectedRevision: input.chat?.expectedMetadataRevision ?? "missing",
      actualRevision: chat.beforeRevision
    });
  }
  return conflicts;
}

function inputConflicts(
  preferences: DesktopPreferenceSnapshot,
  config: DesktopSettingsConfigSnapshot,
  chat: DesktopSettingsChatSnapshot | undefined,
  input: DesktopSettingsSaveInput
): DesktopSettingsConflict[] {
  const conflicts: DesktopSettingsConflict[] = [];
  if (preferences.revision !== input.expectedPreferenceRevision) {
    conflicts.push({
      segment: "preferences",
      expectedRevision: String(input.expectedPreferenceRevision),
      actualRevision: String(preferences.revision)
    });
  }
  if (config.revision !== input.expectedConfigRevision) {
    conflicts.push({
      segment: "config",
      expectedRevision: input.expectedConfigRevision,
      actualRevision: config.revision
    });
  }
  if (input.chat !== undefined && chat?.metadataRevision !== input.chat.expectedMetadataRevision) {
    conflicts.push({
      segment: "chat_metadata",
      expectedRevision: input.chat.expectedMetadataRevision,
      actualRevision: chat?.metadataRevision ?? "missing"
    });
  }
  return conflicts;
}

function listAppliedFields(input: DesktopSettingsSaveInput): string[] {
  const fields: string[] = [];
  if (input.themePreference !== undefined) fields.push("themePreference");
  if (input.fontPreference !== undefined) fields.push("fontPreference");
  if (input.activity !== undefined) fields.push("activity");
  if (input.identity !== undefined) fields.push("identity");
  if (input.memory !== undefined) fields.push("memory");
  if (input.compaction !== undefined) fields.push("compaction");
  if (input.chatParams !== undefined) fields.push("chatParams");
  if (input.permission !== undefined) fields.push("permission");
  if (input.webSearch !== undefined) fields.push("webSearch");
  if (input.models !== undefined) fields.push("models");
  if (input.skills !== undefined) fields.push("skills");
  if (input.chat !== undefined) fields.push("chat.personalization");
  return fields;
}

function samePreferences(left: DesktopPreferenceSnapshot, right: DesktopPreferenceSnapshot): boolean {
  return left.revision === right.revision
    && samePreferenceValues(left, right);
}

function samePreferenceValues(left: DesktopPreferenceSnapshot, right: DesktopPreferenceSnapshot): boolean {
  return left.themePreference === right.themePreference && sameFont(left.fontPreference, right.fontPreference);
}

function sameFont(
  left: DesktopPreferenceSnapshot["fontPreference"],
  right: DesktopPreferenceSnapshot["fontPreference"]
): boolean {
  return left.family === right.family && left.size === right.size;
}

function validTransactionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function recoveryPayloadFileName(journalPath: string, transactionId: string): string {
  if (!validTransactionId(transactionId)) throw new Error("设置事务 id 无效。");
  return `${path.basename(journalPath)}.settings-payload-${transactionId}.json`;
}

async function ensureRecoveryDirectory(journalPath: string): Promise<string> {
  const directory = path.resolve(path.dirname(journalPath));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("设置事务目录必须是真实目录。");
  }
  // macOS 的 /var 是系统级 /private/var 别名；统一到 realpath 后再绑定具体文件。
  return await fs.realpath(directory);
}

async function assertRecoveryTargetMissing(target: string): Promise<void> {
  try {
    await fs.lstat(target);
    throw new Error("设置事务临时版本目标已存在。");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function assertRecoveryFileBinding(
  target: string,
  handle: FileHandle,
  expected?: Pick<Stats, "dev" | "ino">
): Promise<Pick<Stats, "dev" | "ino">> {
  const [descriptor, linked] = await Promise.all([handle.stat(), fs.lstat(target)]);
  if (!descriptor.isFile() || !linked.isFile() || linked.isSymbolicLink()
    || descriptor.nlink !== 1 || linked.nlink !== 1 || !sameFileIdentity(descriptor, linked)
    || await fs.realpath(target) !== target) {
    throw new Error("设置事务临时版本文件绑定无效。");
  }
  if (expected && !sameFileIdentity(descriptor, expected)) {
    throw new Error("设置事务临时版本文件在访问期间被替换。");
  }
  return { dev: descriptor.dev, ino: descriptor.ino };
}

async function removeRecoveryFile(target: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(target, recoveryReadFlags());
    const identity = await assertRecoveryFileBinding(target, handle);
    await removeRecoveryFileIfBound(target, identity);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeRecoveryFileIfBound(
  target: string,
  expected: Pick<Stats, "dev" | "ino">
): Promise<void> {
  try {
    const linked = await fs.lstat(target);
    if (linked.isSymbolicLink() || !linked.isFile() || linked.nlink !== 1 || !sameFileIdentity(linked, expected)) {
      throw new Error("设置事务临时版本文件在清理前被替换。");
    }
    await fs.unlink(target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function recoveryWriteFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
}

function recoveryReadFlags(): number {
  return constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
}

function sameFileIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function recoveryRequired(journalId: string, message: string): DesktopSettingsPendingRecovery {
  return { journalId, message };
}

function conflictFromError(error: unknown): DesktopSettingsConflict | undefined {
  if (error instanceof DesktopPreferenceRevisionConflictError) {
    return {
      segment: "preferences",
      expectedRevision: String(error.expectedRevision),
      actualRevision: String(error.actualRevision)
    };
  }
  if (error instanceof ConfigRevisionConflictError) {
    return {
      segment: "config",
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision
    };
  }
  if (error instanceof SessionCatalogConflictError) {
    return {
      segment: "chat_metadata",
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision ?? "missing"
    };
  }
  return undefined;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
