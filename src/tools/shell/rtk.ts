import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
export const supportedRtkVersion = "rtk 0.29.0";
export interface RtkReceipt { beforeTokens: number; afterTokens: number; command: string; originalCommand?: string; durationMs?: number }

type RtkShell = "posix" | "pwsh" | "powershell";

const compressibleCommands = new Set(["git", "npm", "pnpm", "cargo", "rg", "grep", "find", "ls", "tree", "cat", "tsc", "eslint", "vitest", "pytest", "curl", "wget", "docker", "pip"]);

/** 只接受单条命令；带引号的字面参数可用，Shell 展开与机器输出保持原样。 */
function splitRtkCommand(command: string, shell: RtkShell): { prefix: string; invocation: string } {
  const prefix = shell === "posix" ? command.match(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"\\]+)+\s+)+/u)?.[0] ?? "" : "";
  return { prefix, invocation: command.slice(prefix.length).trim() };
}

export function rtkCommand(command: string, executable: string, shell: RtkShell = "posix"): string | undefined {
  const { prefix, invocation } = splitRtkCommand(command, shell);
  if (/[*?~[\]]/u.test(prefix.replace(/'[^']*'|"[^"]*"/gu, ""))) return undefined;
  if (/\bRTK_[A-Za-z0-9_]*=/u.test(prefix)) return undefined;
  if (shell !== "posix" && /[#@,%]/u.test(command)) return undefined;
  if (/[\n\r|&;`$(){}<>\\]/u.test(command)) return undefined;
  const tokens = invocation.match(/(?:'[^']*'|"[^"]*"|[^\s'"]+)+/gu);
  if (!tokens || tokens.join(" ").replace(/\s+/gu, " ") !== invocation.replace(/\s+/gu, " ")) return undefined;
  if (tokens.some(token => /['"]/.test(token.replace(/'[^']*'|"[^"]*"/gu, "")) || /[*?~[\]]/u.test(token.replace(/'[^']*'|"[^"]*"/gu, "")))) return undefined;
  if (shell !== "posix" && ["ls", "cat", "curl", "wget", "find"].includes(tokens[0]!)) return undefined;
  if (!compressibleCommands.has(tokens[0]!)) return undefined;
  if (tokens[0] === "pnpm" && !["test", "build", "lint", "typecheck", "run"].includes(tokens[1] ?? "")) return undefined;
  const args = tokens.slice(1).map(token => token.replace(/^['"]|['"]$/gu, ""));
  if (args.some(arg => /^(?:--(?:porcelain|short|format|pretty|numstat|name-only|name-status|raw|binary|output|json|reporter|null|files|count)|-[zsU])/u.test(arg))) return undefined;
  if ((tokens[0] === "rg" || tokens[0] === "grep") && args.some(arg => /^-(?:[clm]|-[a-z-]*(?:count|files|null))/u.test(arg))) return undefined;
  // 已知会改变原命令含义的别名不交给压缩器，例如把 Jest 替换成 Vitest。
  if (tokens[0] === "git" && !["status", "diff", "log", "show"].includes(tokens[1] ?? "")) return undefined;
  const binary = `'${executable.replaceAll("'", "'\\''")}'`;
  return shell === "posix" ? `${prefix}${binary} ${invocation}` : `& '${executable.replaceAll("'", "''")}' ${invocation}`;
}

export async function findRtk(): Promise<{ path?: string; version?: string; reason?: string }> {
  let reason: string | undefined;
  const name = process.platform === "win32" ? "rtk.exe" : "rtk";
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const bundled = resources ? path.join(resources, "rtk") : process.platform === "darwin" && process.versions.electron ? path.resolve(path.dirname(process.execPath), "../Resources/rtk") : undefined;
  const candidates = [bundled ?? "", ...(process.env.PATH ?? "").split(path.delimiter), path.join(homedir(), ".local", "bin"), path.join(homedir(), ".cargo", "bin"), fileURLToPath(new URL(`../../../out/rtk/${process.arch}`, import.meta.url))].filter(directory => path.isAbsolute(directory));
  for (const directory of [...new Set(candidates)]) {
    const file = path.join(directory, name);
    try { await access(file, constants.X_OK); } catch { continue; }
    try {
      const { stdout } = await execFileAsync(file, ["--version"], { timeout: 2_000, maxBuffer: 4_096 });
      if (stdout.trim() === supportedRtkVersion) return { path: file, version: stdout.trim() };
      reason ??= `需要 ${supportedRtkVersion}，检测到 ${stdout.trim().slice(0, 100)}`;
    } catch { reason ??= "RTK 无法启动"; }
  }
  return { reason: reason ?? `未安装 ${supportedRtkVersion}` };
}

/** 每个命令独立统计库，避免并发命令或其他应用的记录混入本次结果。 */
export async function prepareRtk(command: string, shell: RtkShell = "posix"): Promise<{
  command: string;
  env?: Record<string, string>;
  readReceipt(): RtkReceipt | undefined;
  dispose(): Promise<void>;
}> {
  const unchanged = { command, readReceipt: () => undefined, dispose: async () => {} };
  if (!rtkCommand(command, "rtk", shell)) return unchanged;
  const executable = await findRtk();
  if (!executable.path) return unchanged;
  const { prefix, invocation } = splitRtkCommand(command, shell);
  let rewritten: string;
  try {
    const result = await execFileAsync(executable.path, ["rewrite", invocation], { timeout: 2_000, maxBuffer: 16_384 });
    rewritten = result.stdout.trim();
  } catch { return unchanged; }
  if (!rewritten.startsWith("rtk ") || /[\n\r|&;`$(){}<>\\]/u.test(rewritten)) return unchanged;
  if (shell !== "posix" && /[#@,%]/u.test(rewritten)) return unchanged;
  const directory = await mkdtemp(path.join(tmpdir(), "biny-rtk-"));
  const database = path.join(directory, "tracking.db");
  return {
    command: shell === "posix"
      ? `${prefix}'${executable.path.replaceAll("'", "'\\''")}' ${rewritten.slice(4)}`
      : `& '${executable.path.replaceAll("'", "''")}' ${rewritten.slice(4)}`,
    env: { RTK_DB_PATH: database, RTK_TEE: "0" },
    readReceipt() {
      // 只读打开：没有记录就是未取得计量，不能创建空库伪装成零节省。
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const rows = db.prepare("SELECT input_tokens, output_tokens FROM commands").all();
        if (rows.length !== 1) return undefined;
        const beforeTokens = Number(rows[0]!.input_tokens);
        const afterTokens = Number(rows[0]!.output_tokens);
        if (![beforeTokens, afterTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
        return { beforeTokens, afterTokens, command: invocation.split(/\s+/u).slice(0, 2).join(" "), originalCommand: command };
      } finally { db.close(); }
    },
    dispose: async () => { await rm(directory, { recursive: true, force: true }); }
  };
}
