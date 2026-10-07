/**
 * 子 agent 的权限档位推导。
 *
 * 单独放一个文件，是为了让「派发任务」的各个入口（TUI、桌面端、工具层）都走同一条
 * 判断，不各自拍脑袋决定子 agent 能不能写工作区。
 */
import type { PermissionManager } from "../permission/PermissionManager.js";
import type { SubagentAccessMode } from "./SubagentTaskManager.js";

/**
 * 只读会话收窄工具面；其他模式逐次通过同一权限管理器决定能否执行。
 * 暴露写工具不代表授权，ask 模式中未获授权的操作会作为阻塞交回父代理。
 */
export function subagentAccessMode(permissionManager: PermissionManager): SubagentAccessMode {
  return permissionManager.getStatus().mode === "read-only" ? "read-only" : "workspace";
}
