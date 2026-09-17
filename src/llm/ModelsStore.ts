/**
 * Provider 模型目录存储。
 *
 * 文件只保存可公开的模型元数据和 HTTP 校验信息，不保存 API key、OAuth token、Cookie 或
 * Authorization header。写入使用进程内串行、跨进程锁和同目录原子替换。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ModelCatalogEntry } from "../ai/types.js";
import type { ProviderConfig } from "../config/schema.js";
import { migrateLegacyGlobalState } from "../config/globalStateMigration.js";
import { globalModelsStorePath } from "../config/paths.js";

export interface ModelsStoreEntry {
  models: ModelCatalogEntry[];
  checkedAt?: number;
  lastModified?: number;
  etag?: string;
}

export interface ModelsStore {
  read(providerId: string): Promise<ModelsStoreEntry | undefined>;
  readMany?(providerIds: readonly string[]): Promise<Map<string, ModelsStoreEntry>>;
  write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
  delete(providerId: string): Promise<void>;
}

/**
 * 同一主机可以挂多个不同网关路径，缓存必须按实际目录地址隔离；否则一个连接刷新后会
 * 把另一个连接的模型列表覆盖掉。哈希只用于文件键，不保存地址或凭据本身。
 */
export function modelCatalogCacheKey(providerId: string, config: ProviderConfig): string {
  const endpoint = (config.modelsEndpoint ?? config.baseUrl ?? "").trim().replace(/\/+$/u, "").toLowerCase();
  if (!endpoint) return providerId;
  let hash = 2166136261;
  for (const character of `${config.type}\u0000${endpoint}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${providerId}::${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function readProviderCatalog(
  providerId: string,
  config: ProviderConfig,
  store: ModelsStore
): Promise<ModelsStoreEntry | undefined> {
  const scoped = await store.read(modelCatalogCacheKey(providerId, config)).catch(() => undefined);
  if (scoped) return scoped;
  // 仅兼容旧版无 endpoint scope 的缓存；成功刷新后会写入新的隔离键。
  return await store.read(providerId).catch(() => undefined);
}

const modelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string(),
  showInPicker: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  limits: z.object({
    maxInputTokens: z.number().int().positive().optional(),
    reasoningReserveTokens: z.number().int().nonnegative().optional(),
    toolSchemaReserveTokens: z.number().int().nonnegative().optional(),
    systemPromptReserveTokens: z.number().int().nonnegative().optional(),
    protocolSafetyMarginTokens: z.number().int().nonnegative().optional()
  }).optional(),
  capabilities: z.object({
    tools: z.boolean().optional(),
    parallelToolCalls: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    reasoningStream: z.boolean().optional(),
    reasoningSummary: z.boolean().optional(),
    vision: z.boolean().optional(),
    audio: z.boolean().optional(),
    streaming: z.boolean().optional()
  }),
  reasoningEfforts: z.array(z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])),
  reasoningEffortsSource: z.enum(["declared", "inferred"]).optional(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  apiBackend: z.string().optional(),
  baseUrl: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  compatibility: z.object({
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional()
  }).optional()
});

const entrySchema = z.object({
  models: z.array(modelSchema),
  checkedAt: z.number().int().nonnegative().optional(),
  lastModified: z.number().int().nonnegative().optional(),
  etag: z.string().max(1_024).optional()
});

const fileSchema = z.object({
  // v1 没有档位来源，曾把 ID 推断持久化成权威 map；直接失效可避免旧缓存继续覆盖模型事实。
  version: z.literal(2),
  providers: z.record(entrySchema)
});

type ModelsStoreFile = z.infer<typeof fileSchema>;

export class InMemoryModelsStore implements ModelsStore {
  private readonly entries = new Map<string, ModelsStoreEntry>();

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const entry = this.entries.get(providerId);
    return entry ? structuredClone(entry) : undefined;
  }

  async readMany(providerIds: readonly string[]): Promise<Map<string, ModelsStoreEntry>> {
    return new Map(providerIds.flatMap((providerId) => {
      const entry = this.entries.get(providerId);
      return entry ? [[providerId, structuredClone(entry)] as const] : [];
    }));
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    this.entries.set(providerId, sanitizeEntry(entry));
  }

  async delete(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
}

export class FileModelsStore implements ModelsStore {
  readonly filePath: string;
  private readonly migrateDefaultState: boolean;
  private pending: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    this.migrateDefaultState = filePath === undefined;
    this.filePath = path.resolve(filePath ?? globalModelsStorePath());
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    await this.migrateIfDefault();
    const data = await readStoreFile(this.filePath);
    const entry = data.providers[providerId];
    return entry ? structuredClone(entry) as ModelsStoreEntry : undefined;
  }

  async readMany(providerIds: readonly string[]): Promise<Map<string, ModelsStoreEntry>> {
    await this.migrateIfDefault();
    // 一个设置快照会读取所有 provider；批量读避免对同一文件重复 JSON.parse + Zod 校验。
    const data = await readStoreFile(this.filePath);
    return new Map(providerIds.flatMap((providerId) => {
      const entry = data.providers[providerId];
      return entry ? [[providerId, structuredClone(entry) as ModelsStoreEntry] as const] : [];
    }));
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.migrateIfDefault();
    await this.serialize(async () => {
      await withStoreLock(this.filePath, async () => {
        const data = await readStoreFile(this.filePath);
        data.providers[providerId] = sanitizeEntry(entry);
        await writeStoreFile(this.filePath, data);
      });
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.migrateIfDefault();
    await this.serialize(async () => {
      await withStoreLock(this.filePath, async () => {
        const data = await readStoreFile(this.filePath);
        delete data.providers[providerId];
        await writeStoreFile(this.filePath, data);
      });
    });
  }

  private async serialize(operation: () => Promise<void>): Promise<void> {
    const running = this.pending.then(operation, operation);
    this.pending = running.catch(() => undefined);
    await running;
  }

  private async migrateIfDefault(): Promise<void> {
    if (this.migrateDefaultState) await migrateLegacyGlobalState();
  }
}

export async function restoreProviderCatalogs(
  providerIds: readonly string[],
  store: ModelsStore,
  providers?: Readonly<Record<string, ProviderConfig>>
): Promise<Array<[string, ModelCatalogEntry[]]>> {
  if (store.readMany) {
    const cacheKeys = providerIds.flatMap((providerId) => {
      const provider = providers?.[providerId];
      const scoped = provider ? modelCatalogCacheKey(providerId, provider) : providerId;
      return scoped === providerId ? [providerId] : [scoped, providerId];
    });
    const entries = await store.readMany([...new Set(cacheKeys)]).catch(() => new Map<string, ModelsStoreEntry>());
    return providerIds.flatMap((providerId) => {
      const provider = providers?.[providerId];
      const scoped = provider ? modelCatalogCacheKey(providerId, provider) : providerId;
      const entry = entries.get(scoped) ?? entries.get(providerId);
      return entry?.models.length ? [[providerId, entry.models] as [string, ModelCatalogEntry[]]] : [];
    });
  }
  const restored = await Promise.all(providerIds.map(async (providerId) => {
    const provider = providers?.[providerId];
    const entry = provider
      ? await readProviderCatalog(providerId, provider, store)
      : await store.read(providerId).catch(() => undefined);
    return entry?.models.length ? [providerId, entry.models] as [string, ModelCatalogEntry[]] : undefined;
  }));
  return restored.filter((item): item is [string, ModelCatalogEntry[]] => item !== undefined);
}

function sanitizeEntry(entry: ModelsStoreEntry): ModelsStoreEntry {
  return {
    models: entry.models.map((model) => ({
      ...model,
      headers: sanitizeHeaders(model.headers)
    })),
    checkedAt: entry.checkedAt,
    lastModified: entry.lastModified,
    etag: entry.etag
  };
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const safe = Object.fromEntries(Object.entries(headers).filter(([name]) => (
    !/authorization|api[-_]?key|token|cookie|secret|credential/iu.test(name)
  )));
  return Object.keys(safe).length ? safe : undefined;
}

async function readStoreFile(filePath: string): Promise<ModelsStoreFile> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(await fs.readFile(filePath, "utf8")));
    return parsed.success ? parsed.data : emptyStore();
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return emptyStore();
    throw error;
  }
}

async function writeStoreFile(filePath: string, data: ModelsStoreFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function withStoreLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.unlink(lockPath).catch(() => undefined);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for model store lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

function emptyStore(): ModelsStoreFile {
  return { version: 2, providers: {} };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
