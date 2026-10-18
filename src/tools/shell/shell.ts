import { existsSync } from "node:fs";
import path from "node:path";

export interface ShellPlan {
  readonly kind: "posix" | "pwsh" | "powershell" | "cmd";
  readonly executable: string;
}

export function detectShell(
  environment: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; fileExists: (file: string) => boolean }
    = { platform: process.platform, env: process.env, fileExists: existsSync }
): ShellPlan {
  if (environment.platform !== "win32") return { kind: "posix", executable: "/bin/sh" };
  const { env, fileExists } = environment;
  const directories = (env.Path ?? env.PATH ?? env.path ?? "").split(";").filter(Boolean).map((value) => value.replace(/^"(.*)"$/u, "$1"));
  const find = (name: string, fallback?: string): string | undefined => {
    const candidates = directories.map((directory) => path.win32.join(directory, name));
    if (fallback) candidates.push(fallback);
    return candidates.find((candidate) => path.win32.isAbsolute(candidate) && fileExists(candidate));
  };
  const pwsh = find("pwsh.exe", env.ProgramFiles ? path.win32.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe") : undefined);
  if (pwsh) return { kind: "pwsh", executable: pwsh };
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  const powershell = find("powershell.exe", systemRoot ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : undefined);
  if (powershell) return { kind: "powershell", executable: powershell };
  return { kind: "cmd", executable: env.ComSpec ?? env.COMSPEC ?? (systemRoot ? path.win32.join(systemRoot, "System32", "cmd.exe") : "cmd.exe") };
}

let cachedShell: ShellPlan | undefined;
export function defaultShell(): ShellPlan { return cachedShell ??= detectShell(); }

export function shellGuidance(shell: ShellPlan): string {
  if (shell.kind === "posix") return "";
  const name = shell.kind === "pwsh" ? "PowerShell 7" : shell.kind === "powershell" ? "Windows PowerShell 5.1" : "cmd.exe";
  return ` Commands execute in ${name}; use ${shell.kind === "cmd" ? "cmd" : "PowerShell"} syntax.`;
}

export function shellCommandInvocation(shell: ShellPlan, command: string, env: NodeJS.ProcessEnv = process.env): { executable: string; args: string[]; env?: NodeJS.ProcessEnv; shell?: string } {
  if (shell.kind === "posix") return { executable: shell.executable, args: ["-c", command] };
  // cmd 的 /s /c 引用规则由 Node 处理，不能用普通 argv 的反斜杠转义拼接。
  if (shell.kind === "cmd") return { executable: command, args: [], shell: shell.executable };
  // 独立 ScriptBlock 保留 using 等脚本头语法；显式设置 UTF-8 并保留原生命令的退出码。
  const script = [
    "$__binyUtf8 = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = $__binyUtf8",
    "$OutputEncoding = $__binyUtf8",
    "$__binyCommand = [Environment]::GetEnvironmentVariable('BINY_SHELL_COMMAND')",
    "[Environment]::SetEnvironmentVariable('BINY_SHELL_COMMAND', $null)",
    "$__binyOk = $true",
    ". ([ScriptBlock]::Create($__binyCommand + \"`n\" + '$__binyOk = $?'))",
    "$__binyOk = $__binyOk -and $?",
    "if (-not $__binyOk) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }"
  ].join("\n");
  return {
    executable: shell.executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    env: { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "BINY_SHELL_COMMAND")), BINY_SHELL_COMMAND: command }
  };
}

export function interactiveShellInvocation(shell: ShellPlan = defaultShell()): { executable: string; args: string[] } {
  if (shell.kind === "posix") return { executable: process.env.SHELL?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"), args: ["-l"] };
  return { executable: shell.executable, args: shell.kind === "cmd" ? ["/d"] : ["-NoLogo"] };
}
