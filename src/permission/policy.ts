/**
 * 权限风险识别模块。
 *
 * 这里只负责把工具调用归类为 actionType/riskLevel，并给出人可读 reason。是否允许执行由
 * PermissionManager 统一决定。
 */
import type { ActionType, PermissionRequestContext, RiskLevel } from "./PermissionManager.js";
import type { ToolRisk } from "../tools/types.js";
import { preparedFileChange, type PreparedFileChange } from "../tools/file/fileChange.js";
import { isProtectedCredentialPath } from "../utils/secrets.js";
import path from "node:path";

export type ToolName =
  | "Read"
  | "read_tool_result"
  | "Write"
  | "Edit"
  | "Glob"
  | "Grep"
  | "Bash"
  | "BashOutput"
  | "KillShell"
  | "WebSearch"
  | "WebFetch"
  | "TodoWrite";

export interface AnalyzePermissionInput {
  toolName: string;
  args: unknown;
  sessionId: string;
  projectRoot: string;
  toolRisk?: ToolRisk;
  fileChange?: PreparedFileChange;
}

export function analyzePermissionRequest(input: AnalyzePermissionInput): PermissionRequestContext {
  const targetPath = normalizePermissionPath(getStringField(input.args, "path"));
  const fileChange = input.fileChange ?? preparedFileChange(input.toolName, input.args);
  if (fileChange?.server) {
    return {
      ...base(input), actionType: fileChange.operation === "delete" ? "delete" : "write",
      riskLevel: "high", reason: `Remote file ${fileChange.operation} on ${fileChange.server}: ${fileChange.path}${fileChange.destinationPath ? ` -> ${fileChange.destinationPath}` : ""}`
    };
  }

  if (input.toolName === "Read") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: isSensitivePath(targetPath) ? "critical" : "low",
      targetPath,
      reason: isSensitivePath(targetPath) ? "reads a sensitive file" : "reads a workspace file"
    };
  }

  if (input.toolName === "Glob" || input.toolName === "Grep") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches or lists workspace files"
    };
  }

  if (fileChange) {
    const targetPath = normalizePermissionPath(fileChange.path) ?? "";
    const secondaryTargetPath = fileChange.destinationPath
      ? normalizePermissionPath(fileChange.destinationPath) ?? ""
      : "";
    if (fileChange.operation === "delete") {
      return {
        ...base(input),
        actionType: "delete",
        riskLevel: isSensitivePath(targetPath) ? "critical" : "high",
        targetPath,
        reason: isSensitivePath(targetPath) ? "deletes a sensitive file" : "deletes a workspace file"
      };
    }
    const riskTarget = riskRank(fileWriteRisk(secondaryTargetPath)) > riskRank(fileWriteRisk(targetPath))
      ? secondaryTargetPath
      : targetPath;
    return {
      ...base(input),
      actionType: "write",
      riskLevel: fileWriteRisk(riskTarget),
      targetPath,
      secondaryTargetPath: secondaryTargetPath || undefined,
      reason: fileWriteReason(riskTarget)
    };
  }

  if (input.toolName === "Bash") {
    return analyzeCommand(input, getStringField(input.args, "command"));
  }

  if (input.toolName === "BashOutput") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      targetPath: targetPath || undefined,
      reason: "inspects runtime-owned managed processes"
    };
  }

  if (input.toolName === "KillShell") {
    return {
      ...base(input),
      actionType: "shell",
      riskLevel: "medium",
      reason: "stops a runtime-owned managed process group"
    };
  }

  if (input.toolName === "Task") {
    return {
      ...base(input),
      actionType: input.toolRisk === "execute" ? "shell" : "read",
      riskLevel: input.toolRisk === "execute" ? "medium" : "low",
      reason: input.toolRisk === "execute"
        ? "delegates a bounded workspace task with write and finite validation capabilities"
        : "delegates a bounded read-only repository investigation"
    };
  }

  if (input.toolName === "TodoWrite") {
    // 只写会话自己的计划清单，不碰工作区，也不触发任何外部动作。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "records the assistant's own plan for this session"
    };
  }

  if (input.toolName === "WebFetch") {
    // 目标地址已过私网/环回/云元数据校验，与 WebSearch 同级：只读、不改本地状态。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "fetches a public web page without changing local state"
    };
  }

  if (input.toolName === "WebSearch") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches the public web without changing local state"
    };
  }

  if (input.toolName === "skill_search") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches the public Skill catalog without changing local state"
    };
  }

  if (input.toolName === "skill_install") {
    return {
      ...base(input),
      actionType: "install",
      riskLevel: "medium",
      reason: "downloads and installs a validated Skill into Biny's managed global Skill directory"
    };
  }

  if (input.toolName === "Skill" || input.toolName === "read_skill_resource") {
    // Skill 正文与资源都会在实际读取前重新校验路径、软链和硬链，按内置只读工具放行。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      targetPath: input.toolName === "read_skill_resource" ? targetPath || undefined : undefined,
      reason: "loads validated local skill instructions"
    };
  }

  if (input.toolName === "recall_memory") {
    // 记忆检索只读取经过校验的单一来源感知 SQLite 事实库。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches the source-aware durable memory library"
    };
  }

  if (input.toolName === "save_memory") {
    // audience 明确区分 workspace 与 universal；两者共享同一受校验的 SQLite 事实库。
    return {
      ...base(input),
      actionType: "write",
      riskLevel: "low",
      reason: "saves a redacted note to the source-aware durable memory library"
    };
  }

  if (input.toolName === "read_tool_result") {
    // 归档引用只指向本会话自己产出的工具结果，取回不比原始调用多暴露任何东西。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "reads a tool result this session archived out of context"
    };
  }

  if (input.toolName === "mcp_list_resources" || input.toolName === "mcp_read_resource") {
    // MCP resources 是协议层只读数据，与 WebSearch 同级放行。
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "reads read-only resources exposed by connected MCP servers"
    };
  }

  if (input.toolRisk === "read") {
    return { ...base(input), actionType: "read", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares a read-only action" };
  }
  if (input.toolRisk === "write") {
    return { ...base(input), actionType: "write", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares a workspace-changing action" };
  }
  if (input.toolRisk === "execute") {
    return { ...base(input), actionType: "shell", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares an executable action" };
  }

  return {
    ...base(input),
    actionType: "unknown",
    riskLevel: "medium",
    targetPath: targetPath || undefined,
    reason: "unknown tool action"
  };
}

export function commandSafetyWarnings(command: string): string[] {
  const request = analyzeCommand({ toolName: "Bash", args: { command }, sessionId: "", projectRoot: "" }, command);
  if (request.riskLevel === "low") return [];
  return request.reason ? [request.reason] : ["command requires permission"];
}

function analyzeCommand(input: AnalyzePermissionInput, command: string): PermissionRequestContext {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  const critical = criticalCommandReason(normalized);
  if (critical) {
    return { ...base(input), actionType: commandAction(normalized, "critical"), riskLevel: "critical", command, reason: critical };
  }

  const high = highRiskCommandReason(normalized);
  if (high) {
    return { ...base(input), actionType: commandAction(normalized, "high"), riskLevel: "high", command, reason: high };
  }

  return {
    ...base(input),
    actionType: "shell",
    riskLevel: "medium",
    command,
    reason: testCommandReason(normalized) ?? "executes a shell command"
  };
}

function criticalCommandReason(command: string): string | undefined {
  if (/(^|[;&|]\s*)sudo(\s|$)/.test(command)) return "executes sudo";
  if (/(curl|wget)[^|;&]*\|\s*(sh|bash|zsh)\b/.test(command)) return "pipes a network script into a shell";
  if (/(^|[;&|]\s*)rm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/.test(command)) return "recursively force deletes files";
  if (/(^|[;&|]\s*)git\s+push\b.*\s(--force|-f)(\s|$)/.test(command)) return "force pushes git history";
  return undefined;
}

function highRiskCommandReason(command: string): string | undefined {
  if (/(^|[;&|]\s*)rm(\s|$)/.test(command)) return "deletes files";
  if (/(^|[;&|]\s*)mv(\s|$)/.test(command)) return "moves or overwrites files";
  if (/(^|[;&|]\s*)chmod(\s|$)/.test(command)) return "changes file permissions";
  if (/(^|[;&|]\s*)chown(\s|$)/.test(command)) return "changes file ownership";
  if (/(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(command)) return "changes dependencies";
  if (/(^|[;&|]\s*)git\s+(commit|push|reset|checkout|clean|rebase|merge)\b/.test(command)) return "changes git state";
  if (/(^|[;&|]\s*)(curl|wget)\b/.test(command)) return "accesses the network";
  if (/https?:\/\//.test(command)) return "accesses the network";
  return undefined;
}

function testCommandReason(command: string): string | undefined {
  if (/^(pnpm|npm|yarn|bun)\s+(test|run\s+test|typecheck|run\s+typecheck|lint|run\s+lint)\b/.test(command)) return "runs project checks";
  return undefined;
}

function commandAction(command: string, riskLevel: RiskLevel): ActionType {
  if (/(^|[;&|]\s*)rm(\s|$)/.test(command)) return "delete";
  if (/(^|[;&|]\s*)git\b/.test(command)) return "git";
  if (/(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(command)) return "install";
  if (/(^|[;&|]\s*)(curl|wget)\b/.test(command) || /https?:\/\//.test(command)) return "network";
  return riskLevel === "critical" ? "shell" : "shell";
}

function fileWriteRisk(filePath: string): RiskLevel {
  if (isSensitivePath(filePath)) return "high";
  if (isShellProfile(filePath)) return "critical";
  if (isLockfile(filePath)) return "high";
  return "medium";
}

function riskRank(riskLevel: RiskLevel): number {
  const ranks: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return ranks[riskLevel];
}

function fileWriteReason(filePath: string): string {
  if (isShellProfile(filePath)) return "modifies a shell profile";
  if (isSensitivePath(filePath)) return "modifies a sensitive file";
  if (isLockfile(filePath)) return "modifies a lockfile";
  return "modifies a workspace file";
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return isProtectedCredentialPath(normalized)
    || normalized === ".env"
    || normalized.startsWith(".env.")
    || normalized.startsWith(".ssh/")
    || normalized.endsWith("/.env")
    || normalized.includes("/.ssh/");
}

function isLockfile(filePath: string): boolean {
  return ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].includes(filePath);
}

function isShellProfile(filePath: string): boolean {
  return [".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"].includes(filePath);
}

function base(input: AnalyzePermissionInput): Pick<PermissionRequestContext, "toolName" | "sessionId" | "projectRoot"> {
  return {
    toolName: input.toolName,
    sessionId: input.sessionId,
    projectRoot: input.projectRoot
  };
}

function getStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function normalizePermissionPath(value: string): string {
  if (!value) return "";
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}
