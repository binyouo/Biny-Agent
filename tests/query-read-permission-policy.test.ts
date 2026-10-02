/** Pure permission regression: no resource or log contents are read. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-query-permission-policy-"));
try {
  const targetPath = path.join(root, "blocked-fixture.txt");
  for (const toolName of ["read_skill_resource", "BashOutput"]) {
    const request = analyzePermissionRequest({ toolName, args: { path: targetPath }, sessionId: "fixture", projectRoot: root, toolRisk: "read" });
    assert.equal(request.targetPath, targetPath, `${toolName} must carry its resolved file target to denyPaths`);
    assert.equal(request.actionType, "read");
    assert.equal(request.riskLevel, "low", "hardening keeps the original normal-read classification");
    for (const mode of ["ask", "auto", "read-only", "full-access"] as const) {
      assert.equal(new PermissionManager({ mode, allowTools: [toolName], denyPaths: ["blocked-fixture.txt"] }).evaluate(request).decision, "deny");
      assert.equal(new PermissionManager({ mode, allowTools: [], denyPaths: [] }).evaluate(request).decision, "allow");
    }
  }
  assert.equal(analyzePermissionRequest({ toolName: "BashOutput", args: {}, sessionId: "fixture", projectRoot: root }).targetPath, undefined);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("query read permission policy tests passed");
