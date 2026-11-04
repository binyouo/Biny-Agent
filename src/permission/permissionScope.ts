/**
 * 交互式授权动作到最小稳定范围的映射。
 *
 * 该模块只依赖类型，桌面 renderer 可以复用而不会把 Node 权限管理实现带进浏览器 bundle。
 */
import type { PermissionGrantScope, PermissionRequestContext } from "./PermissionManager.js";

export function permissionScopeForAlways(
  request: Pick<PermissionRequestContext, "command" | "targetPath" | "secondaryTargetPath">
): Exclude<PermissionGrantScope, "once"> {
  return request.command || request.secondaryTargetPath ? "command" : request.targetPath ? "path" : "tool";
}
