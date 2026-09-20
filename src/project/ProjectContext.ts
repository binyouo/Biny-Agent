/**
 * 项目上下文摘要模块。
 *
 * 运行时启动时会从这里收集轻量项目信息：包管理器、package 脚本和依赖名、tsconfig、README、
 * `src` 目录轮廓以及 git 状态。它刻意不读取完整源码，目的是给模型足够方向而不撑大上下文。
 */
import { execFile } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isIgnoredPath } from "../workspace/ignore.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath } from "../workspace/resolvePath.js";
import { gitInspectionEnvironment } from "../tools/git/environment.js";
import { pathExists } from "../utils/fs.js";

const execFileAsync = promisify(execFile);

export interface ProjectContext {
  // ProjectContext 是发送给模型的轻量项目摘要，不应包含完整源码。
  cwd: string;
  packageManager: string;
  packageJson?: PackageJsonSummary;
  tsconfig?: TsconfigSummary;
  readme?: string;
  srcTree: string[];
  gitStatus: string;
}

export interface PackageJsonSummary {
  name?: string;
  version?: string;
  type?: string;
  scripts: string[];
  dependencies: string[];
  devDependencies: string[];
}

export interface TsconfigSummary {
  compilerOptions: Record<string, unknown>;
  include?: unknown;
  exclude?: unknown;
}

export async function collectProjectContext(workspaceRoot: string, ignore: string[], signal?: AbortSignal): Promise<ProjectContext> {
  // ProjectContext 只收集摘要，不读取整个项目。这样启动 chat/run 时足够快，
  // 也避免把大量源码直接塞进上下文。
  signal?.throwIfAborted();
  const [packageManager, packageJson, tsconfig, readme, srcTree, gitStatus] = await Promise.all([
    detectPackageManager(workspaceRoot, ignore, signal),
    readPackageJsonSummary(workspaceRoot, ignore, signal),
    readTsconfigSummary(workspaceRoot, ignore, signal),
    readTextSummary(workspaceRoot, "README.md", ignore, 3000, signal),
    readSrcTree(workspaceRoot, ignore, 120, signal),
    readGitStatus(workspaceRoot, signal)
  ]);
  signal?.throwIfAborted();

  return {
    cwd: workspaceRoot,
    packageManager,
    packageJson,
    tsconfig,
    readme,
    srcTree,
    gitStatus
  };
}

export function formatProjectContext(context: ProjectContext): string {
  // 格式化输出保持纯文本，便于直接拼进 prompt，也方便调试时阅读。
  return [
    `cwd: ${context.cwd}`,
    `packageManager: ${context.packageManager}`,
    context.packageJson ? `package.json: ${JSON.stringify(context.packageJson, null, 2)}` : "package.json: (missing)",
    context.tsconfig ? `tsconfig.json: ${JSON.stringify(context.tsconfig, null, 2)}` : "tsconfig.json: (missing)",
    `README.md:\n${context.readme ?? "(missing)"}`,
    `src tree:\n${context.srcTree.length ? context.srcTree.join("\n") : "(missing or empty)"}`,
    `git status:\n${context.gitStatus || "(clean)"}`
  ].join("\n\n");
}

async function detectPackageManager(workspaceRoot: string, ignore: string[], signal?: AbortSignal): Promise<string> {
  // 通过 lockfile 推断包管理器，优先级按项目中常见的显式锁文件排列。
  signal?.throwIfAborted();
  if (await hasWorkspaceFile(workspaceRoot, "pnpm-lock.yaml", ignore)) return "pnpm";
  signal?.throwIfAborted();
  if (await hasWorkspaceFile(workspaceRoot, "yarn.lock", ignore)) return "yarn";
  signal?.throwIfAborted();
  if (await hasWorkspaceFile(workspaceRoot, "package-lock.json", ignore)) return "npm";
  signal?.throwIfAborted();
  if (await hasWorkspaceFile(workspaceRoot, "bun.lockb", ignore)) return "bun";
  signal?.throwIfAborted();
  return "unknown";
}

async function readPackageJsonSummary(workspaceRoot: string, ignore: string[], signal?: AbortSignal): Promise<PackageJsonSummary | undefined> {
  // package.json 只提取脚本和依赖名，不把完整版本约束放进上下文。
  signal?.throwIfAborted();
  const filePath = resolveProjectFile(workspaceRoot, "package.json", ignore);
  if (!filePath || !(await pathExists(filePath))) return undefined;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(await fs.readFile(filePath, { encoding: "utf8", signal })) as Record<string, unknown>;
  } catch {
    // 摘要收集不能因单个文件损坏或不可读而失败;按缺失降级(同 readGitStatus 的容错风格)。
    signal?.throwIfAborted();
    return undefined;
  }
  signal?.throwIfAborted();
  return {
    name: stringValue(value.name),
    version: stringValue(value.version),
    type: stringValue(value.type),
    scripts: objectKeys(value.scripts),
    dependencies: objectKeys(value.dependencies),
    devDependencies: objectKeys(value.devDependencies)
  };
}

async function readTsconfigSummary(workspaceRoot: string, ignore: string[], signal?: AbortSignal): Promise<TsconfigSummary | undefined> {
  // tsconfig 摘要保留 compilerOptions，帮助模型判断模块系统和 JSX 配置。
  signal?.throwIfAborted();
  const filePath = resolveProjectFile(workspaceRoot, "tsconfig.json", ignore);
  if (!filePath || !(await pathExists(filePath))) return undefined;
  let value: Record<string, unknown>;
  try {
    // tsconfig.json 官方是 JSONC(`tsc --init` 生成的文件满是注释),先做最小清洗再解析。
    value = parseJsonc(await fs.readFile(filePath, { encoding: "utf8", signal })) as Record<string, unknown>;
  } catch {
    // 清洗后仍不是合法 JSON 时按缺失降级,不能让摘要收集拖垮整个 turn。
    signal?.throwIfAborted();
    return undefined;
  }
  signal?.throwIfAborted();
  const compilerOptions = isRecord(value.compilerOptions) ? value.compilerOptions : {};
  return {
    compilerOptions,
    include: value.include,
    exclude: value.exclude
  };
}

async function readTextSummary(workspaceRoot: string, requestedPath: string, ignore: string[], maxChars: number, signal?: AbortSignal): Promise<string | undefined> {
  // 文本文档摘要只截断，不做解析；README 内容通常足够说明项目用途。
  signal?.throwIfAborted();
  const filePath = resolveProjectFile(workspaceRoot, requestedPath, ignore);
  if (!filePath || !(await pathExists(filePath))) return undefined;
  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf8", signal });
  } catch {
    // README 只是可选摘要。外置卷或 Downloads 被 macOS TCC 拒绝时按缺失降级，
    // 不能让普通聊天在首轮 workspace 准备阶段直接失败。
    signal?.throwIfAborted();
    return undefined;
  }
  signal?.throwIfAborted();
  return content.slice(0, maxChars);
}

async function readSrcTree(workspaceRoot: string, ignore: string[], limit: number, signal?: AbortSignal): Promise<string[]> {
  // src tree 用来提供目录轮廓，限制深度和数量以保护大型仓库。
  signal?.throwIfAborted();
  const srcRoot = resolveProjectDirectory(workspaceRoot, "src", ignore);
  if (!srcRoot || !(await pathExists(srcRoot))) return [];
  const entries: string[] = [];
  await walk(srcRoot, "src", 0);
  return entries;

  async function walk(currentDir: string, relativeDir: string, depth: number): Promise<void> {
    // 目录树只保留有限深度和数量，避免大型仓库启动时扫描过多文件。
    signal?.throwIfAborted();
    if (entries.length >= limit || depth > 6) return;
    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      // 单个目录不可读(如 EACCES)时跳过该子树,其余目录继续收集。
      signal?.throwIfAborted();
      return;
    }
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirEntries) {
      signal?.throwIfAborted();
      if (entries.length >= limit) return;
      const relativePath = path.join(relativeDir, entry.name);
      if (isIgnoredPath(relativePath, ignore)) continue;
      if (entry.isSymbolicLink()) continue;
      entries.push(`${"  ".repeat(depth)}${entry.isDirectory() ? "[d] " : "[f] "}${relativePath}`);
      if (entry.isDirectory()) {
        const childDirectory = resolveProjectDirectory(workspaceRoot, relativePath, ignore);
        if (childDirectory) await walk(childDirectory, relativePath, depth + 1);
      }
    }
  }
}

async function readGitStatus(workspaceRoot: string, signal?: AbortSignal): Promise<string> {
  // git status 失败时不阻断启动；非仓库目录仍可使用文件和命令工具。
  try {
    signal?.throwIfAborted();
    const result = await execFileAsync("git", [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--short",
      "--ignore-submodules=all"
    ], { cwd: workspaceRoot, env: gitInspectionEnvironment(), timeout: 10_000, signal });
    signal?.throwIfAborted();
    return result.stdout.trim();
  } catch {
    signal?.throwIfAborted();
    return "(not a git repository)";
  }
}

async function hasWorkspaceFile(workspaceRoot: string, requestedPath: string, ignore: string[]): Promise<boolean> {
  const filePath = resolveProjectFile(workspaceRoot, requestedPath, ignore);
  return filePath ? await pathExists(filePath) : false;
}

function resolveProjectFile(workspaceRoot: string, requestedPath: string, ignore: string[]): string | undefined {
  try {
    return resolveWorkspacePath(workspaceRoot, requestedPath, ignore);
  } catch {
    return undefined;
  }
}

function resolveProjectDirectory(workspaceRoot: string, requestedPath: string, ignore: string[]): string | undefined {
  try {
    return resolveWorkspaceDirectory(workspaceRoot, requestedPath, ignore);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  // JSON 字段类型不可信，所有摘要字段都先做类型收窄。
  return typeof value === "string" ? value : undefined;
}

/**
 * 最小 JSONC 解析:单遍扫描剔除字符串外的 `//`、`/* *\/` 注释,并在 `}`/`]` 前回收尾逗号。
 * 只覆盖 tsconfig 的官方语法子集,不追求完整 JSONC 规范。
 */
function parseJsonc(text: string): unknown {
  let output = "";
  let inString = false;
  // output 中最近一次字符串外逗号的下标;遇到闭合括号且其间只有空白时回收该逗号。
  let pendingComma = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      output += char;
      if (char === "\\" && index + 1 < text.length) {
        // 转义序列整体保留,避免 \" 被误判为字符串结束。
        index += 1;
        output += text[index]!;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      pendingComma = -1;
      output += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    if (char === ",") {
      pendingComma = output.length;
      output += char;
      continue;
    }
    if ((char === "}" || char === "]") && pendingComma >= 0 && !/\S/.test(output.slice(pendingComma + 1))) {
      output = output.slice(0, pendingComma);
    }
    if (!/\s/.test(char)) pendingComma = -1;
    output += char;
  }
  return JSON.parse(output);
}

function objectKeys(value: unknown): string[] {
  // 依赖和脚本只需要键名，并排序保证 prompt 稳定。
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 排除数组，避免把数组下标当成对象键名。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
