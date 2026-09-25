/**
 * Biny 配置与全局 agent 数据的路径解析。
 *
 * 用户配置与持久化上下文放在 `~/.config/biny/`，session/memory 等 Agent 运行数据在
 * `~/.biny/agent/`；BINY_AGENT_DIR 会把两者统一
 * 重定向到指定目录，便于测试隔离和便携部署。每个工作区的运行状态也放在该全局根目录
 * 下的独立分区中，不因启动项目而创建项目目录下的 `.biny`。
 * 项目 `.biny` 只承载设置、扩展覆盖以及明确要求项目本地保存的内容。
 *
 * 项目 session 目录名是 `<basename>-<hash8>`（如 `biny-a1b2c3d4`）：basename 取自工作区
 * 文件夹名（sanitize 后允许中文、≤48 字符），hash8 是工作区路径 sha256 的前 8 位，用来在
 * 同名项目之间消歧。旧版纯 24hex 目录名由 store.ts 在首次访问时惰性迁移过来。
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BINY_AGENT_DIR_ENV = "BINY_AGENT_DIR";
export const DEFAULT_AGENT_DIR = path.join(".biny", "agent");
export const DEFAULT_CONFIG_DIR = path.join(".config", "biny");
export const GLOBAL_CONFIG_FILE = "config.json";
export const PROJECT_SETTINGS_FILE = "settings.json";
export const MODELS_STORE_FILE = "models-store.json";
export const GLOBAL_PLUGIN_DIR = "plugins";
export const AGENT_DATABASE_FILE = "agent.sqlite";

export interface PathEnvironment {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function globalAgentDir(options: PathEnvironment = {}): string {
  const configured = (options.env ?? process.env)[BINY_AGENT_DIR_ENV];
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.resolve(options.homeDir ?? os.homedir(), DEFAULT_AGENT_DIR);
}

export function globalConfigPath(options: PathEnvironment = {}): string {
  return path.join(globalConfigDir(options), GLOBAL_CONFIG_FILE);
}

export function globalConfigDir(options: PathEnvironment = {}): string {
  const configured = (options.env ?? process.env)[BINY_AGENT_DIR_ENV];
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.resolve(options.homeDir ?? os.homedir(), DEFAULT_CONFIG_DIR);
}

/** 动态 Provider 模型目录属于全局模型配置，不按工作区重复保存。 */
export function globalModelsStorePath(options: PathEnvironment = {}): string {
  return path.join(globalConfigDir(options), MODELS_STORE_FILE);
}

export function globalPluginRoot(options: PathEnvironment = {}): string {
  return path.join(globalConfigDir(options), GLOBAL_PLUGIN_DIR);
}

/** 项目会话按规范化绝对路径隔离，避免不同工作区的 latest、id 前缀和锁互相干扰。 */
export function projectSessionsDir(workspaceRoot: string, options: PathEnvironment = {}): string {
  return projectStateDir("sessions", workspaceRoot, options);
}

/** 项目运行状态的全局分区；名称规则与项目 session 一致，避免同名工作区互相覆盖。 */
export function workspaceAgentDir(workspaceRoot: string, options: PathEnvironment = {}): string {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const canonicalWorkspace = existsSync(resolvedWorkspace) ? realpathSync(resolvedWorkspace) : resolvedWorkspace;
  return projectStateDir("workspaces", canonicalWorkspace, options);
}

/**
 * 项目 session 目录名：`<basename>-<hash8>`。
 *
 * basename 取自工作区文件夹名（sanitize 后允许中文、≤48 字符，见下方 sanitize），hash8 是
 * 规范化工作区绝对路径 sha256 的前 8 位，在同名项目之间消歧。旧版纯 24hex 目录名由
 * `legacyProjectStateDirName` 复现，供 session store 在首次访问时找到并迁移旧目录。
 *
 * 这里是纯函数：不做任何 fs 访问，保证 recorder 的同步路径构造和 store 的断言拿到同一个答案。
 */
function projectStateDir(kind: "sessions" | "workspaces", workspaceRoot: string, options: PathEnvironment): string {
  return path.join(projectStateParentDir(kind, options), projectStateDirName(workspaceRoot));
}

function projectStateParentDir(kind: "sessions" | "workspaces", options: PathEnvironment): string {
  const configuredRoot = globalAgentDir(options);
  const canonicalRoot = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
  return path.join(canonicalRoot, kind);
}

/** 新目录名 `<basename>-<hash8>`，供 store.ts 迁移和测试断言使用。 */
export function projectStateDirName(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return `${sanitizeProjectBaseName(path.basename(resolved))}-${projectPathHash(resolved)}`;
}

/** 旧版目录名是纯 24hex（sha256 前 24 位）；只在迁移旧目录时用到。 */
export function legacyProjectStateDirName(workspaceRoot: string): string {
  return projectPathHash(path.resolve(workspaceRoot), 24);
}

function projectPathHash(resolvedWorkspaceRoot: string, length: 8 | 24 = 8): string {
  return createHash("sha256").update(resolvedWorkspaceRoot).digest("hex").slice(0, length);
}

/**
 * 目录名要可读但不能破坏路径语义：只允许字母（含中文等 Unicode 文字）、数字、`.`、`_`、`-`，
 * 其余字符折叠成单个 `-`。去掉前导 `.`/`_`/`-`，避免隐藏目录或 `--` 这类难处理的名字。
 * 上限 48 字符，给 `-<hash8>` 后缀留出空间。
 */
function sanitizeProjectBaseName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "")
    .slice(0, 48)
    .replace(/[._-]+$/, "");
  return cleaned.length > 0 ? cleaned : "project";
}

export function projectBinyDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".biny");
}

export function projectSettingsPath(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), PROJECT_SETTINGS_FILE);
}
