import assert from "node:assert/strict";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
const observe: PermissionRequestContext = { toolName: "ComputerObserve", actionType: "read", riskLevel: "low", sessionId: "desktop-session", projectRoot: "/tmp/workspace" };
const action: PermissionRequestContext = { ...observe, toolName: "ComputerAction", actionType: "shell", riskLevel: "medium" };
for (const mode of ["full-access", "ask", "auto"] as const) {
  for (const request of [observe, action]) assert.equal(new PermissionManager({ mode }).evaluate(request).decision, "allow", "工具审批交给独立应用策略");
}
assert.equal(new PermissionManager({ mode: "read-only" }).evaluate(action).decision, "deny");
assert.equal(new PermissionManager({ mode: "full-access", denyPaths: [".env"] }).evaluate({ ...action, targetPath: "/tmp/workspace/.env" }).decision, "deny");
console.log("computer use permission tests passed");
