/**
 * 项目级配置覆盖。
 *
 * 这里故意不复用完整 AgentConfig schema：项目文件只能表达运行参数，不能借此引入 provider、
 * model alias、API key、OAuth 或其他全局凭据。解析后再和全局配置做深度合并。
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  PROJECT_SETTINGS_FORMAT,
  PROJECT_SETTINGS_VERSION
} from "./format.js";
import { projectBinyDir, projectSettingsPath } from "./paths.js";
import { reasoningEffortSchema } from "./schema.js";
import { withGlobalConfigWriteLock } from "./versioned.js";

const maxConfigFileBytes = 1024 * 1024;

const thinkingOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  effort: reasoningEffortSchema.optional()
}).strict();

const agentOverrideSchema = z.object({
  softStepLimit: z.number().int().min(1).max(1_024).optional(),
  hardStepLimit: z.number().int().min(1).max(1_024).optional(),
  /** 接受旧项目配置，但不再限制运行中的工具调用总数。 */
  maxToolCalls: z.number().int().min(1).max(65_536).optional(),
  /** 接受旧项目配置，但不再限制重复工具调用。 */
  maxRepeatedActions: z.number().int().min(1).max(32).optional(),
  maxConcurrentTools: z.number().int().min(1).max(32).optional(),
  maxQueuedToolCalls: z.number().int().min(1).max(1_024).optional()
}).strict();

const compactionOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  reserveTokens: z.number().int().min(256).max(262_144).optional(),
  /** 触发阈值 = 当前输入预算 × 该百分比；显式 reserveTokens 优先。 */
  triggerPercent: z.number().min(0.5).max(0.95).optional(),
  keepRecentTokens: z.number().int().min(256).max(1_000_000).optional(),
  /** 与 keepRecentTokens 双上限，取更保守（保留更少）的切分点。 */
  keepRecentMessages: z.number().int().min(1).max(500).optional(),
  maxSummaryTokens: z.number().int().min(256).max(32_768).optional(),
  /** 引用全局 config 已定义的模型别名；缺省跟随当前对话模型。 */
  summaryModel: z.string().trim().min(1).max(128).optional()
}).strict();

const contextOverrideSchema = z.object({
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  maxTurnToolResultBytes: z.number().int().min(1_024).max(16 * 1024 * 1024).optional(),
  instructionsMaxBytes: z.number().int().min(1_024).max(131_072).optional(),
  compaction: compactionOverrideSchema.optional()
}).strict();

const sandboxOverrideSchema = z.object({
  mode: z.enum(["off", "workspace-write"]).optional(),
  allowNetwork: z.boolean().optional()
}).strict();

const checkpointsOverrideSchema = z.object({ enabled: z.boolean().optional() }).strict();

const diagnosticsOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  autoDetect: z.boolean().optional(),
  autoDetectTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  maxOutputBytes: z.number().int().min(256).max(1024 * 1024).optional(),
  commands: z.array(z.object({
    extensions: z.array(z.string().min(1).startsWith(".")).min(1).max(16),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional()
  }).strict()).max(8).optional()
}).strict();

export const projectSettingsSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  thinking: thinkingOverrideSchema.optional(),
  agent: agentOverrideSchema.optional(),
  context: contextOverrideSchema.optional(),
  sandbox: sandboxOverrideSchema.optional(),
  checkpoints: checkpointsOverrideSchema.optional(),
  diagnostics: diagnosticsOverrideSchema.optional()
}).strict();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const projectSettingsDocumentSchema = projectSettingsSchema.extend({
  format: z.literal(PROJECT_SETTINGS_FORMAT),
  configVersion: z.literal(PROJECT_SETTINGS_VERSION)
}).strict();

export type ProjectSettingsDocument = z.infer<typeof projectSettingsDocumentSchema>;

export async function loadProjectSettings(workspaceRoot: string): Promise<ProjectSettings> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const settingsPath = projectSettingsPath(canonicalWorkspace);
  let raw: string;
  try {
    const binyStat = await fs.lstat(projectBinyDir(canonicalWorkspace));
    if (binyStat.isSymbolicLink() || !binyStat.isDirectory()) throw new Error("Project .biny must be a real directory.");
    const settingsStat = await fs.lstat(settingsPath);
    if (settingsStat.isSymbolicLink() || !settingsStat.isFile() || settingsStat.nlink !== 1) {
      throw new Error("Project .biny/settings.json must be a single-link regular file, not a symbolic link or hardlink.");
    }
    if (settingsStat.size > maxConfigFileBytes) {
      throw new Error(`Project .biny/settings.json exceeds the ${String(maxConfigFileBytes)}-byte size limit.`);
    }
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    throw new Error(`Failed to load project .biny/settings.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const document = projectSettingsDocumentSchema.parse(JSON.parse(raw));
    return projectSettingsFromDocument(document);
  } catch (error) {
    throw new Error(`Invalid project .biny/settings.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 保存稀疏的项目覆盖；format/configVersion 由这里统一维护，不参与全局配置 merge。 */
export async function saveProjectSettings(
  workspaceRoot: string,
  settings: ProjectSettings
): Promise<ProjectSettings> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  return await withGlobalConfigWriteLock(projectBinyDir(canonicalWorkspace), async () => (
    await saveProjectSettingsUnlocked(canonicalWorkspace, settings)
  ));
}

async function saveProjectSettingsUnlocked(
  canonicalWorkspace: string,
  settings: ProjectSettings
): Promise<ProjectSettings> {
  const parsed = projectSettingsSchema.parse(settings);
  const document = projectSettingsDocumentSchema.parse({
    ...parsed,
    format: PROJECT_SETTINGS_FORMAT,
    configVersion: PROJECT_SETTINGS_VERSION
  });
  await writeProjectSettingsDocument(canonicalWorkspace, document);
  return projectSettingsFromDocument(document);
}

export async function updateProjectSettings(
  workspaceRoot: string,
  update: (current: ProjectSettings) => ProjectSettings | Promise<ProjectSettings>
): Promise<ProjectSettings> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  return await withGlobalConfigWriteLock(projectBinyDir(canonicalWorkspace), async () => {
    const current = await loadProjectSettings(canonicalWorkspace);
    return await saveProjectSettingsUnlocked(canonicalWorkspace, await update(structuredClone(current)));
  });
}

function projectSettingsFromDocument(document: ProjectSettingsDocument): ProjectSettings {
  const { format: _format, configVersion: _configVersion, ...settings } = document;
  return projectSettingsSchema.parse(settings);
}

async function writeProjectSettingsDocument(
  canonicalWorkspace: string,
  document: ProjectSettingsDocument
): Promise<void> {
  const directory = projectBinyDir(canonicalWorkspace);
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) {
      throw new Error("Project .biny must be a real directory.");
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  }
  await fs.chmod(directory, 0o700);
  const target = projectSettingsPath(canonicalWorkspace);
  await assertOptionalSettingsFile(target);
  const temporaryPath = path.join(
    directory,
    `settings.json.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`
  );
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await assertOptionalSettingsFile(target);
    await fs.rename(temporaryPath, target);
    await fs.chmod(target, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function assertOptionalSettingsFile(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || await fs.realpath(filePath) !== filePath) {
      throw new Error("Project .biny/settings.json must be a single-link regular file.");
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
