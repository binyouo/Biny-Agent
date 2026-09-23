/**
 * macOS 命令沙箱模块。
 *
 * 在此之前，命令执行的全部防线是 `policy.ts` 里那套对命令字符串的正则判定。正则判定天然
 * 可绕（`eval`、`$(...)`、base64、换个等价命令），而它一旦判错就没有第二道 —— 用户点了
 * 同意，命令就以完整用户权限运行。
 *
 * 这里加的是那道独立于判定的边界：内核级地限制写入范围，可选禁网。它不依赖"命令看起来
 * 像什么"，所以判定错了也还有兜底。
 *
 * 范围与限制（不夸大）：
 * - 只在 macOS 生效。请求任何限制而平台不支持时拒绝启动，不降级为无保护执行。
 * - `sandbox-exec` 被 Apple 标记为 deprecated，但至今仍是唯一无需额外安装的用户态方案。
 * - 普通读取放行，显式 denyPaths 同时禁止读取和写入，独立于写入范围模式和交互审批。
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { compileDeniedPaths } from "../../permission/pathPolicy.js";

export type SandboxMode = "off" | "workspace-write";

export interface SandboxOptions {
  mode: SandboxMode;
  allowNetwork: boolean;
  denyPaths?: readonly string[];
}

export interface SandboxedCommand {
  command: string;
  applied: boolean;
  /** 未生效的原因，用于如实告知而不是假装有沙箱。 */
  reason?: string;
}

/** 构建产物、包管理器缓存等必须可写，否则常规命令会大面积失败。 */
function writableRoots(workspaceRoot: string, homeDirectory: string, temporaryDirectory: string): string[] {
  return [
    workspaceRoot,
    temporaryDirectory,
    "/private/tmp",
    "/private/var/tmp",
    "/dev",
    path.join(homeDirectory, ".npm"),
    path.join(homeDirectory, ".cache"),
    path.join(homeDirectory, "Library", "Caches"),
    path.join(homeDirectory, ".pnpm-store")
  ];
}

export function buildSeatbeltProfile(workspaceRoot: string, options: SandboxOptions, environment: {
  home: string;
  temporaryDirectory: string;
}): string {
  // seatbelt 匹配的是解析后的真实路径。macOS 上 /tmp、/var 都是符号链接，直接用原路径写
  // 规则会让工作区自己也被挡在外面 —— 两条都写，才能覆盖调用方传进来的那种写法。
  const roots = writableRoots(path.resolve(workspaceRoot), environment.home, environment.temporaryDirectory);
  const writable = [...new Set(roots.flatMap((entry) => [entry, realPath(entry)]))]
    .map((entry) => `  (subpath ${quoteScheme(entry)})`)
    .join("\n");
  const denied = compileDeniedPaths(options.denyPaths ?? [], workspaceRoot);
  return [
    "(version 1)",
    "(allow default)",
    ...(options.mode === "workspace-write" ? ["(deny file-write*)", "(allow file-write*", writable, ")"] : []),
    // 写入 /dev/null、tty 是命令的日常行为，单独放行避免误伤。
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
    ...(options.allowNetwork ? [] : ["(deny network*)"]),
    // 放在允许规则之后，显式拒绝优先于工作区、缓存和临时目录的写入授权。
    ...denied.patterns
      // 使用普通 Scheme 字符串传入正则，避免 #"..." 字面量对引号与反斜杠的不同解释。
      .map((pattern) => `(deny file-read* file-write* (regex ${quoteScheme(pattern)}))`),
    ...denied.ancestors.map((entry) => `(deny file-write-unlink (literal ${quoteScheme(entry)}))`),
    ""
  ].join("\n");
}

/**
 * 把命令包进沙箱。返回值里的 `applied` 表示这次是否真的有边界 —— 调用方据此如实告知用户，
 * 而不是让"沙箱模式"这个名字自己去暗示一个不存在的保护。
 */
export function sandboxCommand(
  command: string,
  workspaceRoot: string,
  options: SandboxOptions,
  environment: { platform: NodeJS.Platform; home: string; temporaryDirectory: string }
): SandboxedCommand {
  if (options.mode === "off" && options.allowNetwork && !options.denyPaths?.length) {
    return { command, applied: false, reason: "sandbox is disabled and no path or network restrictions are configured" };
  }
  if (environment.platform !== "darwin") {
    throw new Error(`Cannot enforce command sandbox restrictions on ${environment.platform}; command was not started.`);
  }
  const profile = buildSeatbeltProfile(workspaceRoot, options, environment);
  return {
    command: `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/sh -c ${shellQuote(command)}`,
    applied: true
  };
}

export function describeSandbox(options: SandboxOptions, platform: NodeJS.Platform): string {
  if (options.mode === "off" && options.allowNetwork && !options.denyPaths?.length) return "off";
  if (platform !== "darwin") return `requested but unavailable on ${platform}`;
  return [
    options.mode === "workspace-write" ? "workspace-write" : "unrestricted writes",
    options.denyPaths?.length ? "denied paths enforced" : undefined,
    options.allowNetwork ? undefined : "no network"
  ].filter(Boolean).join(", ");
}

/** seatbelt 的路径字面量走 scheme 字符串，内部的引号和反斜杠必须转义。 */
function quoteScheme(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function realPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    // 目录还不存在（比如缓存目录首次使用）时按原样写规则即可。
    return value;
  }
}
