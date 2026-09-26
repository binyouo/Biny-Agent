/**
 * 全局配置的跨进程写锁与内容 revision。
 *
 * Runtime Host 可能按项目各自运行，但它们最终共享同一个全局 config.json。这里用
 * 单链接锁文件串行化 read-modify-write，并用不含凭据正文的稳定哈希做 CAS。
 */
import { createHash } from "node:crypto";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";
import type { AgentConfig } from "./schema.js";

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
