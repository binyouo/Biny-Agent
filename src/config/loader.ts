/**
 * Configuration loading and persistence.
 *
 * 全局 config.json 可能包含旧版本遗留的 API 凭据，因此每次读写都固定到全局配置目录下的
 * 单链接普通文件并强制 0600。新写入由配置存储层先把凭据移出配置文件。
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { configSchema, defaultConfig, type AgentConfig } from "./schema.js";
import { migrateGlobalConfigDocument } from "./migrations.js";
import { migrateLegacyGlobalState } from "./globalStateMigration.js";
import { globalConfigDir } from "./paths.js";
import { loadProjectSettings, type ProjectSettings } from "./projectSettings.js";

export const CONFIG_FILE = "config.json";
export const maxConfigFileBytes = 1024 * 1024;

interface ConfigLocation {
  root: string;
  filePath: string;
  device: number;
  inode: number;
}

export interface ConfigPathOptions {
  /** 测试或嵌入宿主可显式指定全局根目录；正常 CLI/TUI/Desktop 使用 BINY_AGENT_DIR 或默认路径。 */
  globalDir?: string;
}

/** 加载全局配置，再叠加当前项目的运行参数覆盖。 */
export async function loadConfig(workspaceRoot: string, options: ConfigPathOptions = {}): Promise<AgentConfig> {
  const globalConfig = await loadGlobalConfig(options);
  const projectSettings = await loadProjectSettings(workspaceRoot);
  if (projectSettings.defaultModel && !globalConfig.models[projectSettings.defaultModel]) {
    throw new Error(
      `Project defaultModel "${projectSettings.defaultModel}" is not configured in global ${CONFIG_FILE}.`
    );
  }
  return configSchema.parse(deepMerge(globalConfig, projectSettings));
}

/** 只读取全局配置，不读取项目覆盖；供保存配置时保持全局字段的原始值。 */
export async function loadGlobalConfig(options: ConfigPathOptions = {}): Promise<AgentConfig> {
  if (options.globalDir === undefined) await migrateLegacyGlobalState();
  try {
    return await loadConfigFile(options.globalDir ?? globalConfigDir());
  } catch (error) {
    if (isNotFound(error)) return configSchema.parse(defaultConfig);
    throw error;
  }
}

/** 从指定的全局配置目录读取当前格式，测试和桌面端可显式传入隔离目录。 */
export async function loadConfigFile(root: string): Promise<AgentConfig> {
  let location: ConfigLocation;
  try {
    location = await resolveConfigLocation(root);
  } catch (error) {
    if (isNotFound(error)) return configSchema.parse(defaultConfig);
    throw error;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await openExistingConfig(location);
    await tightenConfigMode(handle);
    const raw = await readBoundedConfig(location, handle);
    const migration = migrateGlobalConfigDocument(JSON.parse(raw));
    return configSchema.parse(migration.document);
  } catch (error) {
    if (isNotFound(error)) return configSchema.parse(defaultConfig);
    throw new Error(`Failed to load ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close();
  }
}

export async function saveConfig(workspaceRoot: string, config: AgentConfig, options: ConfigPathOptions = {}): Promise<void> {
  const parsed = configSchema.parse(config);
  const projectSettings = await loadProjectSettings(workspaceRoot);
  const globalConfig = Object.keys(projectSettings).length
    ? await loadGlobalConfigOrDefault(options)
    : configSchema.parse(defaultConfig);
  const toPersist = preserveGlobalValuesForProjectOverrides(globalConfig, parsed, projectSettings);
  await saveConfigFile(options.globalDir ?? globalConfigDir(), toPersist);
}

/** 保存指定目录下的完整配置文件；凭据字段会被显式清空，不会写入 JSON。 */
export async function saveConfigFile(root: string, config: AgentConfig): Promise<void> {
  const parsed = configSchema.parse(config);
  await writeConfigDocumentFile(root, withoutCredentials(parsed));
}

async function writeConfigDocumentFile(root: string, settings: AgentConfig): Promise<void> {
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxConfigFileBytes) {
    throw new Error(`${CONFIG_FILE} exceeds the ${String(maxConfigFileBytes)}-byte size limit.`);
  }
  await ensureConfigDirectory(root);
  const location = await resolveConfigLocation(root);
  await validateOptionalExistingConfig(location, true);
  const temporaryPath = path.join(
    location.root,
    `${CONFIG_FILE}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle: FileHandle | undefined;
  let temporaryIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  try {
    handle = await fs.open(temporaryPath, writeNewFlags(), 0o600);
    const temporaryStat = await assertTemporaryConfigBinding(location, temporaryPath, handle);
    temporaryIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    await handle.writeFile(serialized, "utf8");
    await tightenConfigMode(handle);
    await handle.sync();
    await assertTemporaryConfigBinding(location, temporaryPath, handle);
    await assertConfigRoot(location);
    await validateOptionalExistingConfig(location, false);
    await fs.rename(temporaryPath, location.filePath);
    await assertConfigBinding(location, handle);
    await tightenConfigMode(handle);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryIdentity) await removeBoundTemporaryConfig(location, temporaryPath, temporaryIdentity);
  }
}

export async function ensureConfig(workspaceRoot: string, options: ConfigPathOptions = {}): Promise<void> {
  void workspaceRoot;
  if (options.globalDir === undefined) await migrateLegacyGlobalState();
  const root = options.globalDir ?? globalConfigDir();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const location = await resolveConfigLocation(root);
  let existing: FileHandle | undefined;
  try {
    existing = await openExistingConfig(location);
    await tightenConfigMode(existing);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  } finally {
    await existing?.close();
  }

  let created: FileHandle | undefined;
  try {
    await assertConfigRoot(location);
    created = await fs.open(location.filePath, writeNewFlags(), 0o600);
    await assertConfigBinding(location, created);
    await created.writeFile(`${JSON.stringify(withoutCredentials(configSchema.parse(defaultConfig)), null, 2)}\n`, "utf8");
    await tightenConfigMode(created);
    await created.sync();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const raced = await openExistingConfig(location);
    try {
      await tightenConfigMode(raced);
    } finally {
      await raced.close();
    }
  } finally {
    await created?.close();
  }
}

async function resolveConfigLocation(workspaceRoot: string): Promise<ConfigLocation> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Configuration root must be a real directory.");
  }
  return { root, filePath: path.join(root, CONFIG_FILE), device: stat.dev, inode: stat.ino };
}

async function openExistingConfig(location: ConfigLocation): Promise<FileHandle> {
  await assertConfigRoot(location);
  await assertSafeConfigLeaf(location.filePath);
  let handle: FileHandle;
  try {
    handle = await fs.open(location.filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw unsafeConfigError();
    throw error;
  }
  try {
    await assertConfigBinding(location, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validateOptionalExistingConfig(location: ConfigLocation, tightenMode: boolean): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await openExistingConfig(location);
    if (tightenMode) await tightenConfigMode(handle);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function assertConfigRoot(location: ConfigLocation): Promise<void> {
  const stat = await fs.lstat(location.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== location.device || stat.ino !== location.inode) {
    throw new Error("Configuration root changed during access.");
  }
}

/** 已经是 0600 时不触碰 ctime，避免多个只读 Host 互相制造“读取中发生变化”的假冲突。 */
async function tightenConfigMode(handle: FileHandle): Promise<void> {
  if (((await handle.stat()).mode & 0o777) !== 0o600) await handle.chmod(0o600);
}

async function assertSafeConfigLeaf(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw unsafeConfigError();
}

async function assertConfigBinding(location: ConfigLocation, handle: FileHandle): Promise<Stats> {
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) throw unsafeConfigError();
  await assertConfigRoot(location);
  const pathStat = await fs.lstat(location.filePath);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw unsafeConfigError();
  }
  return descriptorStat;
}

async function readBoundedConfig(location: ConfigLocation, handle: FileHandle): Promise<string> {
  const initial = await assertConfigBinding(location, handle);
  if (initial.size > maxConfigFileBytes) throw configSizeError(initial.size);

  const chunks: Buffer[] = [];
  const readLimit = maxConfigFileBytes + 1;
  let bytesRead = 0;
  while (bytesRead < readLimit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - bytesRead));
    const result = await handle.read(chunk, 0, chunk.length, bytesRead);
    if (result.bytesRead === 0) break;
    chunks.push(chunk.subarray(0, result.bytesRead));
    bytesRead += result.bytesRead;
  }

  const current = await assertConfigBinding(location, handle);
  if (!sameConfigSnapshot(initial, current)) {
    throw new Error(`${CONFIG_FILE} changed while it was being read.`);
  }
  if (bytesRead > maxConfigFileBytes || current.size > maxConfigFileBytes) {
    throw configSizeError(Math.max(bytesRead, current.size));
  }
  return Buffer.concat(chunks, bytesRead).toString("utf8");
}

function sameConfigSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function configSizeError(actualBytes: number): Error {
  return new Error(`${CONFIG_FILE} is ${String(actualBytes)} bytes, exceeding the ${String(maxConfigFileBytes)}-byte size limit.`);
}

async function assertTemporaryConfigBinding(
  location: ConfigLocation,
  temporaryPath: string,
  handle: FileHandle
): Promise<Stats> {
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) throw unsafeConfigError();
  await assertConfigRoot(location);
  const pathStat = await fs.lstat(temporaryPath);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw unsafeConfigError();
  }
  return descriptorStat;
}

async function removeBoundTemporaryConfig(
  location: ConfigLocation,
  temporaryPath: string,
  identity: Pick<Stats, "dev" | "ino">
): Promise<void> {
  try {
    await assertConfigRoot(location);
    const stat = await fs.lstat(temporaryPath);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && stat.dev === identity.dev && stat.ino === identity.ino) {
      await fs.unlink(temporaryPath);
    }
  } catch {
    // Missing, renamed, or replaced temporary files are never cleanup targets.
  }
}

function writeNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag();
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function unsafeConfigError(): Error {
  return new Error(`${CONFIG_FILE} must be a single-link regular file, not a symbolic link or hardlink.`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

async function ensureConfigDirectory(root: string): Promise<void> {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Configuration root must be a real directory.");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Configuration root must be a real directory.");
  }
  await fs.chmod(root, 0o700);
}

async function loadGlobalConfigOrDefault(options: ConfigPathOptions): Promise<AgentConfig> {
  return await loadGlobalConfig(options);
}

function deepMerge<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result as T;
}

/**
 * 保存合并配置时，项目覆盖保持在项目文件中。只有调用方明确改变了某个覆盖字段，才把该字段
 * 当作新的全局值保存；否则恢复它原本的全局值，避免一次权限保存把项目默认模型复制进全局配置。
 */
function preserveGlobalValuesForProjectOverrides(
  globalConfig: AgentConfig,
  submitted: AgentConfig,
  projectSettings: ProjectSettings
): AgentConfig {
  const currentEffective = deepMerge(globalConfig, projectSettings);
  const next = structuredClone(submitted);
  preserveOverrideLeaves(next as unknown as Record<string, unknown>, globalConfig as unknown as Record<string, unknown>, currentEffective as unknown as Record<string, unknown>, projectSettings as unknown as Record<string, unknown>);
  return configSchema.parse(next);
}

function preserveOverrideLeaves(
  submitted: Record<string, unknown>,
  globalConfig: Record<string, unknown>,
  effective: Record<string, unknown>,
  overrides: Record<string, unknown>
): void {
  for (const [key, override] of Object.entries(overrides)) {
    if (isRecord(override)) {
      const submittedChild = isRecord(submitted[key]) ? submitted[key] : {};
      const globalChild = isRecord(globalConfig[key]) ? globalConfig[key] : {};
      const effectiveChild = isRecord(effective[key]) ? effective[key] : {};
      preserveOverrideLeaves(submittedChild, globalChild, effectiveChild, override);
      submitted[key] = submittedChild;
    } else if (deepEqual(submitted[key], effective[key])) {
      submitted[key] = structuredClone(globalConfig[key]);
    }
  }
}

function withoutCredentials(config: AgentConfig): AgentConfig {
  const safe = structuredClone(config);
  for (const provider of Object.values(safe.providers)) {
    provider.apiKey = undefined;
    if (provider.oauth) provider.oauth.refreshToken = undefined;
  }
  for (const server of Object.values(safe.extensions.mcp)) {
    for (const key of Object.keys(server.credentialRefs?.env ?? {})) delete server.env?.[key];
    for (const key of Object.keys(server.credentialRefs?.headers ?? {})) delete server.headers?.[key];
  }
  return safe;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
