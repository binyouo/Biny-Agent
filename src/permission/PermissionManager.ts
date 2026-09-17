/**
 * 统一权限管理模块。
 *
 * PermissionManager 是所有工具调用前的 gate：它根据项目策略、当前会话 allowlist、
 * 工具动作类型和风险等级决定放行、询问或拒绝。工具本身不做 UI 确认。
 */
import path from "node:path";
import { permissionScopeForAlways } from "./permissionScope.js";

export type ActionType = "read" | "write" | "delete" | "shell" | "network" | "git" | "install" | "unknown";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type PermissionMode = "ask" | "read-only" | "auto" | "full-access";
export type PermissionGrantScope = "once" | "command" | "session" | "tool" | "path";
export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionAction = "allow_once" | "allow_always" | "deny" | "deny_with_reason";

export interface ProjectPermissionPolicy {
  mode: PermissionMode;
  allowTools: string[];
  allowPaths: string[];
  denyPaths: string[];
  criticalAlwaysAsk: boolean;
  source?: string;
}

export interface PermissionRequestContext {
  toolName: string;
  actionType: ActionType;
  riskLevel: RiskLevel;
  targetPath?: string;
  /** 移动等双路径变更的第二个目标路径，与 targetPath 一样参与 denyPaths 判定。 */
  secondaryTargetPath?: string;
  command?: string;
  reason?: string;
  diffPreview?: string;
  changeSummary?: string;
  /** Opaque exact-call fingerprint used for command-scoped grants. */
  approvalRule?: string;
  sessionId: string;
  projectRoot: string;
}

export interface PermissionPrompt extends PermissionRequestContext {
  /** 关键操作要求逐次批准时，界面不提供会话授权。 */
  canRemember?: boolean;
  toolCallId: string;
  tool: string;
  title: string;
  details: string;
  requireFullYes: boolean;
  diff?: string;
  preview?: string;
}

export interface PermissionEvaluation {
  canRemember?: boolean;
  decision: PermissionDecision;
  reason: string;
}

export interface PermissionApplyResult {
  approved: boolean;
  action?: PermissionAction;
  scope?: PermissionGrantScope;
  nextMode?: PermissionMode;
  message?: string;
}

/** UI transport response. `confirmation` is validated before grants are applied. */
export interface PermissionResult extends PermissionApplyResult {
  confirmation?: string;
}

export interface DeniedOperation {
  toolName: string;
  actionType: ActionType;
  riskLevel: RiskLevel;
  target?: string;
  reason: string;
  at: string;
}

export interface PermissionStatus {
  mode: PermissionMode;
  allowTools: string[];
  allowPaths: string[];
  projectAllowTools: string[];
  projectAllowPaths: string[];
  sessionAllowTools: string[];
  sessionAllowPaths: string[];
  allowedCommands: string[];
  allowedActions: string[];
  deniedOperations: DeniedOperation[];
  projectPolicySource?: string;
}

const defaultPolicy: ProjectPermissionPolicy = {
  mode: "full-access",
  allowTools: ["Read", "Glob", "Grep", "WebSearch", "save_memory"],
  allowPaths: [],
  denyPaths: [".env", ".ssh/", "node_modules/"],
  criticalAlwaysAsk: true
};

export class PermissionManager {
  private mode: PermissionMode;
  private readonly policy: ProjectPermissionPolicy;
  private readonly sessionAllowedTools = new Set<string>();
  private readonly sessionAllowedPaths = new Set<string>();
  private readonly sessionAllowedCommands = new Set<string>();
  private readonly sessionAllowedActions = new Set<string>();
  private readonly deniedOperations: DeniedOperation[] = [];

  constructor(policy: Partial<ProjectPermissionPolicy> = {}) {
    this.policy = {
      ...defaultPolicy,
      ...policy,
      allowTools: policy.allowTools ?? defaultPolicy.allowTools,
      allowPaths: policy.allowPaths ?? defaultPolicy.allowPaths,
      denyPaths: policy.denyPaths ?? defaultPolicy.denyPaths,
      criticalAlwaysAsk: policy.criticalAlwaysAsk ?? defaultPolicy.criticalAlwaysAsk
    };
    this.mode = this.policy.mode;
  }

  evaluate(request: PermissionRequestContext): PermissionEvaluation {
    const deniedPath =
      (request.targetPath ? matchingPathRule(request.targetPath, this.policy.denyPaths) : undefined)
      ?? (request.secondaryTargetPath ? matchingPathRule(request.secondaryTargetPath, this.policy.denyPaths) : undefined);
    if (deniedPath) {
      return { decision: "deny", reason: `Target path is denied by project policy: ${deniedPath}` };
    }

    if (this.mode === "read-only" && request.actionType !== "read") {
      return { decision: "deny", reason: "Permission mode is read only." };
    }

    // 完全访问明确跳过交互批准；显式拒绝路径仍由上方规则拦截。
    if (this.mode === "full-access") {
      return { decision: "allow", reason: "Allowed by full access mode." };
    }

    if (request.riskLevel === "critical" && this.policy.criticalAlwaysAsk) {
      return { decision: "ask", canRemember: false, reason: request.reason ? `Critical operation: ${request.reason}` : "Critical operation requires confirmation." };
    }

    if (isAllowedBySession(request, this.sessionAllowedTools, this.sessionAllowedPaths, this.sessionAllowedCommands, this.sessionAllowedActions)) {
      return { decision: "allow", reason: "Allowed by current session permission." };
    }

    if (this.policy.allowTools.includes(request.toolName)) {
      return { decision: "allow", reason: `Allowed by project tool policy: ${request.toolName}` };
    }

    if (request.targetPath && matchingPathRule(request.targetPath, this.policy.allowPaths)) {
      return { decision: "allow", reason: `Allowed by project path policy: ${request.targetPath}` };
    }

    if (request.actionType === "read" && request.riskLevel === "low") {
      return { decision: "allow", reason: "Low risk read operation." };
    }

    if (request.actionType === "git" && request.riskLevel === "low") {
      return { decision: "allow", reason: "Low risk git inspection." };
    }

    if (this.mode === "auto" && request.riskLevel === "low") {
      return { decision: "allow", reason: "Allowed by auto mode for low risk operation." };
    }

    return { decision: "ask", reason: request.reason ?? "Operation requires permission." };
  }

  applyResult(request: PermissionRequestContext, result: PermissionApplyResult): void {
    if (result.approved && result.nextMode) this.mode = result.nextMode;

    if (!result.approved) {
      this.deniedOperations.push({
        toolName: request.toolName,
        actionType: request.actionType,
        riskLevel: request.riskLevel,
        target: request.targetPath ?? request.command,
        reason: result.message ?? "Denied by user.",
        at: new Date().toISOString()
      });
      return;
    }

    const scope = permissionScopeForResult(request, result);
    if (scope === "tool") {
      this.sessionAllowedTools.add(request.toolName);
      return;
    }

    if (scope === "path" && request.targetPath) {
      this.sessionAllowedPaths.add(normalizeRulePath(request.targetPath));
      return;
    }

    if (scope === "command") {
      this.sessionAllowedCommands.add(requestKey(request));
      return;
    }

    if (scope === "session") {
      this.sessionAllowedActions.add(actionKey(request));
    }
  }

  revokeResult(request: PermissionRequestContext, result: PermissionApplyResult | undefined): void {
    if (!result?.approved) return;
    const scope = permissionScopeForResult(request, result);
    if (scope === "tool") this.sessionAllowedTools.delete(request.toolName);
    else if (scope === "path" && request.targetPath) this.sessionAllowedPaths.delete(normalizeRulePath(request.targetPath));
    else if (scope === "command") this.sessionAllowedCommands.delete(requestKey(request));
    else if (scope === "session") this.sessionAllowedActions.delete(actionKey(request));
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  resetSession(): void {
    this.sessionAllowedTools.clear();
    this.sessionAllowedPaths.clear();
    this.sessionAllowedCommands.clear();
    this.sessionAllowedActions.clear();
    this.deniedOperations.length = 0;
  }

  getStatus(): PermissionStatus {
    return {
      mode: this.mode,
      allowTools: [...new Set([...this.policy.allowTools, ...this.sessionAllowedTools])].sort(),
      allowPaths: [...new Set([...this.policy.allowPaths.map(normalizeRulePath), ...this.sessionAllowedPaths])].sort(),
      projectAllowTools: [...this.policy.allowTools].sort(),
      projectAllowPaths: this.policy.allowPaths.map(normalizeRulePath).sort(),
      sessionAllowTools: [...this.sessionAllowedTools].sort(),
      sessionAllowPaths: [...this.sessionAllowedPaths].sort(),
      allowedCommands: [...this.sessionAllowedCommands].sort(),
      allowedActions: [...this.sessionAllowedActions].sort(),
      deniedOperations: [...this.deniedOperations],
      projectPolicySource: this.policy.source
    };
  }
}

function permissionScopeForResult(
  request: PermissionRequestContext,
  result: PermissionApplyResult
): PermissionGrantScope | undefined {
  if (result.action === "allow_once") return "once";
  if (result.action === "allow_always") return permissionScopeForAlways(request);
  return result.scope;
}

function isAllowedBySession(
  request: PermissionRequestContext,
  tools: Set<string>,
  paths: Set<string>,
  commands: Set<string>,
  actions: Set<string>
): boolean {
  if (tools.has(request.toolName)) return true;
  if (commands.has(requestKey(request))) return true;
  if (actions.has(actionKey(request))) return true;
  // 会话里的具体文件授权是一次用户选择，必须精确匹配；只有项目配置规则才支持 basename/目录模式。
  return request.targetPath ? paths.has(normalizeRulePath(request.targetPath)) : false;
}

function requestKey(request: PermissionRequestContext): string {
  if (request.approvalRule) {
    return JSON.stringify([request.toolName, request.actionType, request.approvalRule]);
  }
  return JSON.stringify([
    request.toolName,
    request.actionType,
    request.command ?? "",
    request.targetPath ? normalizeRulePath(request.targetPath) : "",
    request.changeSummary ?? "",
    request.diffPreview ?? ""
  ]);
}

function actionKey(request: PermissionRequestContext): string {
  return `${request.toolName}:${request.actionType}`;
}

function matchingPathRule(targetPath: string, rules: string[]): string | undefined {
  const target = normalizeRulePath(targetPath);
  return rules.find((rule) => pathRuleMatches(target, normalizeRulePath(rule)));
}

function pathRuleMatches(target: string, rule: string): boolean {
  if (!rule) return false;
  if (rule.endsWith("/")) {
    const directory = rule.slice(0, -1);
    if (target === directory || target.startsWith(rule)) return true;
    // 无路径前缀的目录规则匹配任意层级的同名目录,如 "secrets/" 命中 "packages/api/secrets/x"。
    return !directory.includes("/") && (target.endsWith(`/${directory}`) || target.includes(`/${directory}/`));
  }
  if (target === rule) return true;
  if (rule === ".env" && target.startsWith(".env.")) return true;
  // 无斜杠规则按 basename 匹配任意层级,如 ".env" 命中 "packages/api/.env"。
  return !rule.includes("/") && target.endsWith(`/${rule}`);
}

function normalizeRulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) return normalized;
  if (path.isAbsolute(normalized)) return normalized;
  return normalized.replace(/\/+/g, "/");
}
