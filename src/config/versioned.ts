/**
 * 全局配置的跨进程写锁与内容 revision。
 *
 * Runtime Host 可能按项目各自运行，但它们最终共享同一个全局 config.json。这里用
 * 单链接锁文件串行化 read-modify-write，并用不含凭据正文的稳定哈希做 CAS。
 */
import { createHash } from "node:crypto";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";
import type { AgentConfig } from "./schema.js";
import { assertTestStatePathIsolated } from "./paths.js";

export interface VersionedConfigSnapshot {
  config: AgentConfig;
  revision: string;
}

export class ConfigRevisionConflictError extends Error {
  readonly name = "ConfigRevisionConflictError";

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string
  ) {
    super(`Global config revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`);
  }
}

/** revision 覆盖非凭据配置和凭据槽位的非机密版本；Keychain/token 正文既不进入 IPC，也不进入哈希。 */
export function configDocumentRevision(config: AgentConfig): string {
  const publicConfig = structuredClone(config) as AgentConfig;
  // Provider 凭据保存在凭据存储中，不属于 config.json 文档内容。
  // 凭据正文仍不参与 revision；只对外持久化随机版本 nonce，避免把密钥正文混入哈希。
  for (const provider of Object.values(publicConfig.providers)) {
    delete provider.apiKey;
    if (provider.oauth) delete provider.oauth.refreshToken;
  }
  for (const server of Object.values(publicConfig.extensions.mcp)) {
    for (const key of Object.keys(server.credentialRefs?.env ?? {})) delete server.env?.[key];
    for (const key of Object.keys(server.credentialRefs?.headers ?? {})) delete server.headers?.[key];
  }
  return `sha256:${createHash("sha256").update(stableJson(publicConfig)).digest("hex")}`;
}

export function assertConfigRevision(expectedRevision: string, config: AgentConfig): void {
  const actualRevision = configDocumentRevision(config);
  if (actualRevision !== expectedRevision) {
    throw new ConfigRevisionConflictError(expectedRevision, actualRevision);
  }
}

export async function withGlobalConfigWriteLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  assertTestStatePathIsolated(root);
  return await withLocalFileWriteLock(root, ".config.write.lock", operation);
}

function stableJson(value: unknown): string {
  // 与 JSON.stringify 的持久化语义保持一致：对象里的 undefined 键会消失，数组槽位则为
  // null。否则构造候选时显式传入可选 undefined 会产生一个永远无法从磁盘复读的 revision。
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 哪些顶层配置字段变化后**必须重建 Runtime 进程**才生效。
 *
 * 反过来记更容易：不在这个清单里的字段，是 main 侧即时读取的交互偏好
 * （appshots 热键、computer 显示偏好、活动记录等），改它们不用碰 Runtime。
 *
 * ⚠️ **`context` 必须在清单里**，尽管 AgentSession 是每轮现读 `activeConfig`：
 * 桌面端保存设置时，只有**当前项目**的 Runtime 会被推送新配置
 * （见 DesktopAgentManager.updateGlobalPersonalization），其它驻留项目拿不到，
 * 而它自己在推送之后仍然调 `scheduleIdleManagedRuntimeRebuild()`
 * —— 那一步就是为了让其它项目的 Runtime 也跟上。
 * 所以把 `context` 排除出去，会让别的项目静默保留旧的记忆/压缩策略。
 *
 * 同理，任何"某个 Runtime 里被热更新、但别的 Runtime 没有"的字段都必须留在这里。
 * 往清单外挪字段之前，先确认**所有**驻留 Runtime 都能拿到新值。
 */
const RESTART_RELEVANT_CONFIG_FIELDS: readonly string[] = [
  "format",
  "configVersion",
  "defaultModel",
  "toolModel",
  "providers",
  "credentialRevisions",
  "models",
  "thinking",
  "agent",
  "heartbeat",
  "permission",
  "workspace",
  "context",
  "crystal",
  "sandbox",
  "hooks",
  "diagnostics",
  "checkpoints",
  "web",
  "telemetry",
  "extensions"
];

/** 只保留"变了就必须重建 Runtime"的字段，其余键被剔除，使 revision 比较忽略它们。 */
export function restartRelevantConfig(config: AgentConfig): AgentConfig {
  const projection = structuredClone(config) as unknown as Record<string, unknown>;
  for (const key of Object.keys(projection)) {
    if (!RESTART_RELEVANT_CONFIG_FIELDS.includes(key)) delete projection[key];
  }
  return projection as unknown as AgentConfig;
}

/**
 * 这次配置变更是否需要重启驻留的 Runtime Host。
 *
 * 判据不能用"revision 变了"——那等于把所有设置都当成需要重启。
 * 用一个记忆开关把所有项目的 Host 拖去重启，正是"开关要等很久"的来源。
 */
export function configChangeRequiresRuntimeRestart(before: AgentConfig, after: AgentConfig): boolean {
  return configDocumentRevision(restartRelevantConfig(after)) !== configDocumentRevision(restartRelevantConfig(before));
}
