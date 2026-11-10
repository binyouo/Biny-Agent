import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionManager, type PermissionApplyResult, type PermissionMode, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";
import { permissionScopeForAlways } from "../src/permission/permissionScope.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";

function request(targetPath = "source.txt", secondaryTargetPath?: string): PermissionRequestContext {
  return { toolName: secondaryTargetPath ? "Edit" : "Write", actionType: "write", riskLevel: "medium",
    targetPath, secondaryTargetPath, sessionId: "move-scope", projectRoot: os.tmpdir() };
}

function manager(options: { mode?: PermissionMode; paths?: string[]; denied?: string[]; tools?: string[] } = {}): PermissionManager {
  return new PermissionManager({ mode: options.mode ?? "ask", allowTools: options.tools ?? [], allowPaths: options.paths ?? [],
    denyPaths: options.denied ?? [] });
}

function rememberPath(permissions: PermissionManager, target: string): void {
  permissions.applyResult(request(target), { approved: true, action: "allow_always" });
}

async function workspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-move-scope-"));
  try {
    await mkdir(path.join(root, "destination"));
    await writeFile(path.join(root, "source.txt"), "approved contents\n");
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const mode of ["ask", "auto"] as const) {
  for (const grant of ["session", "project"] as const) {
    for (const endpoint of ["source.txt", "destination/new.txt"]) {
      test(`${mode}: ${grant} grant for only ${endpoint} cannot authorize a move`, () => {
        const permissions = manager({ mode, paths: grant === "project" ? [endpoint] : [] });
        if (grant === "session") rememberPath(permissions, endpoint);
        assert.equal(permissions.evaluate(request("source.txt", "destination/new.txt")).decision, "ask");
        assert.equal(permissions.evaluate(request(endpoint)).decision, "allow");
      });
    }
  }
}

for (const grant of ["session", "project", "mixed"] as const) {
  for (const hashline of [false, true]) {
    test(`${grant} grants covering both endpoints allow a real ${hashline ? "hashline" : "default"} Edit move`, async () => {
      await workspace(async (root) => {
        const permissions = manager({ paths: grant === "project" ? ["source.txt", "destination/"] : grant === "mixed" ? ["destination/"] : [] });
        if (grant !== "project") rememberPath(permissions, "source.txt");
        if (grant === "session") rememberPath(permissions, "destination/new.txt");
        const args = { operation: "move" as const, path: "source.txt", to: "destination/new.txt" };
        const tool = createEditFileTool({ workspaceRoot: root, ignore: [] }, hashline);
        const prepared = await tool.resolveExecution(args);
        assert.ok(!("isError" in prepared));
        const permission = analyzePermissionRequest({ toolName: tool.name, args, projectRoot: root, sessionId: "move-scope",
          toolRisk: tool.risk, fileChange: prepared.fileChange });
        assert.equal(permissions.evaluate(permission).decision, "allow");
        const result = await prepared.execute({ toolCallId: "move-scope", operationId: "move-scope" });
        assert.equal(result.change.committed, true);
        assert.equal(result.change.destinationPath, "destination/new.txt");
        assert.equal(await readFile(path.join(root, "destination/new.txt"), "utf8"), "approved contents\n");
        await assert.rejects(stat(path.join(root, "source.txt")), { code: "ENOENT" });
      });
    });
  }
}

for (const result of [
  { approved: true, action: "allow_once", scope: "path" },
  { approved: true, scope: "once" }
] satisfies PermissionApplyResult[]) {
  test(`one-time move approval does not persist (${result.action ?? result.scope})`, () => {
    const permissions = manager();
    const move = request("source.txt", "destination/new.txt");
    permissions.applyResult(move, result);
    assert.equal(permissions.evaluate(move).decision, "ask");
    assert.equal(permissions.evaluate(request("source.txt")).decision, "ask");
    assert.equal(permissions.evaluate(request("destination/new.txt")).decision, "ask");
    assert.deepEqual(permissions.getStatus().sessionAllowPaths, []);
    assert.deepEqual(permissions.getStatus().allowedCommands, []);
  });
}

for (const result of [
  { approved: true, action: "allow_always", scope: "path" },
  { approved: true, scope: "path" }
] satisfies PermissionApplyResult[]) {
  test(`remembered move remains exact and does not grant either endpoint (${result.action ?? result.scope})`, () => {
    const permissions = manager();
    const move = request("source.txt", "destination/new.txt");
    permissions.applyResult(move, result);
    assert.equal(permissions.evaluate(move).decision, "allow");
    assert.equal(permissions.evaluate(request("source.txt", "destination/other.txt")).decision, "ask");
    assert.equal(permissions.evaluate(request("destination/new.txt", "source.txt")).decision, "ask");
    assert.equal(permissions.evaluate(request("source.txt")).decision, "ask");
    assert.equal(permissions.evaluate(request("destination/new.txt")).decision, "ask");
    assert.deepEqual(permissions.getStatus().sessionAllowPaths, []);
    assert.equal(permissions.getStatus().allowedCommands.length, 1);
    permissions.revokeResult(move, result);
    assert.equal(permissions.evaluate(move).decision, "ask");
    assert.deepEqual(permissions.getStatus().allowedCommands, []);
  });
}

test("fallback exact-call grant includes the move destination", () => {
  const permissions = manager();
  const move = request("source.txt", "destination/new.txt");
  permissions.applyResult(move, { approved: true, scope: "command" });
  assert.equal(permissions.evaluate(move).decision, "allow");
  assert.equal(permissions.evaluate(request("source.txt", "destination/other.txt")).decision, "ask");
});

test("fingerprinted grants retain exact-call identity", () => {
  const permissions = manager();
  const move = { ...request("source.txt", "destination/new.txt"), approvalRule: "first-exact-call" };
  permissions.applyResult(move, { approved: true, action: "allow_always" });
  assert.equal(permissions.evaluate(move).decision, "allow");
  assert.equal(permissions.evaluate({ ...move, approvalRule: "different-exact-call" }).decision, "ask");
});

test("move remembrance uses exact-call scope while single-path and tool scopes stay unchanged", () => {
  assert.equal(permissionScopeForAlways(request("source.txt", "destination/new.txt")), "command");
  assert.equal(permissionScopeForAlways({ targetPath: "source.txt" }), "path");
  assert.equal(permissionScopeForAlways({ command: "echo ok" }), "command");
  assert.equal(permissionScopeForAlways({}), "tool");
});

test("revoking a remembered move does not revoke an independently granted source", () => {
  const permissions = manager();
  rememberPath(permissions, "source.txt");
  const move = request("source.txt", "destination/new.txt");
  const result = { approved: true, action: "allow_always" } as const;
  permissions.applyResult(move, result);
  permissions.revokeResult(move, result);
  assert.equal(permissions.evaluate(move).decision, "ask");
  assert.equal(permissions.evaluate(request("source.txt")).decision, "allow");
  assert.equal(permissions.evaluate(request("destination/new.txt")).decision, "ask");
});

for (const mode of ["ask", "auto", "full-access"] as const) {
  for (const denied of ["source.txt", "destination/"]) {
    test(`${mode}: explicit denial of ${denied} precedes every move grant`, () => {
      const permissions = manager({ mode, paths: ["source.txt", "destination/"], denied: [denied], tools: ["Edit"] });
      const move = request("source.txt", "destination/new.txt");
      rememberPath(permissions, "source.txt");
      rememberPath(permissions, "destination/new.txt");
      permissions.applyResult(move, { approved: true, action: "allow_always" });
      assert.equal(permissions.evaluate(move).decision, "deny");
    });
  }
}

test("read-only still blocks a fully authorized move", () => {
  const permissions = manager({ mode: "read-only", paths: ["source.txt", "destination/"] });
  assert.equal(permissions.evaluate(request("source.txt", "destination/new.txt")).decision, "deny");
});

test("full access still allows non-denied moves", () => {
  assert.equal(manager({ mode: "full-access" }).evaluate(request("source.txt", "destination/new.txt")).decision, "allow");
});

test("critical destination still requires an unrememberable approval", () => {
  const permissions = manager({ paths: ["source.txt", ".zshrc"] });
  const move = analyzePermissionRequest({ toolName: "Edit", args: {}, sessionId: "move-scope", projectRoot: os.tmpdir(),
    fileChange: { operation: "move", path: "source.txt", destinationPath: ".zshrc" } });
  assert.equal(move.riskLevel, "critical");
  assert.deepEqual(permissions.evaluate(move), { decision: "ask", canRemember: false, reason: "Critical operation: modifies a shell profile" });
});

test("ordinary single-path grants retain exact path behavior", () => {
  const permissions = manager();
  rememberPath(permissions, "source.txt");
  assert.equal(permissions.evaluate(request("source.txt")).decision, "allow");
  assert.equal(permissions.evaluate({ ...request("source.txt"), toolName: "Edit" }).decision, "allow");
  assert.equal(permissions.evaluate(request("nested/source.txt")).decision, "ask");
});

for (const scope of ["tool", "session"] as const) {
  test(`explicit broad ${scope} authorization remains broad`, () => {
    const permissions = manager();
    const move = request("source.txt", "destination/new.txt");
    permissions.applyResult(move, { approved: true, scope });
    assert.equal(permissions.evaluate(request("source.txt", "destination/other.txt")).decision, "allow");
  });
}

test("project tool authorization remains broad", () => {
  assert.equal(manager({ tools: ["Edit"] }).evaluate(request("source.txt", "destination/new.txt")).decision, "allow");
});

test("an explicitly approved one-time move executes without authorizing the next move", async () => {
  await workspace(async (root) => {
    const permissions = manager();
    rememberPath(permissions, "source.txt");
    const args = { operation: "move" as const, path: "source.txt", to: "destination/new.txt" };
    const tool = createEditFileTool({ workspaceRoot: root, ignore: [] });
    const prepared = await tool.resolveExecution(args);
    assert.ok(!("isError" in prepared));
    const permission = analyzePermissionRequest({ toolName: tool.name, args, projectRoot: root, sessionId: "move-scope", fileChange: prepared.fileChange });
    assert.equal(permissions.evaluate(permission).decision, "ask");
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "approved contents\n");
    await assert.rejects(stat(path.join(root, "destination/new.txt")), { code: "ENOENT" });
    permissions.applyResult(permission, { approved: true, action: "allow_once" });
    await prepared.execute({ toolCallId: "move-scope", operationId: "move-scope" });
    assert.equal(await readFile(path.join(root, "destination/new.txt"), "utf8"), "approved contents\n");
    assert.equal(permissions.evaluate(permission).decision, "ask");
    assert.equal(permissions.evaluate(request("destination/new.txt")).decision, "ask");
  });
});

test("a remembered exact move can execute again without authorizing another destination", async () => {
  await workspace(async (root) => {
    const permissions = manager();
    const args = { operation: "move" as const, path: "source.txt", to: "destination/new.txt" };
    const tool = createEditFileTool({ workspaceRoot: root, ignore: [] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prepared = await tool.resolveExecution(args);
      assert.ok(!("isError" in prepared));
      const permission = analyzePermissionRequest({ toolName: tool.name, args, projectRoot: root, sessionId: "move-scope", fileChange: prepared.fileChange });
      if (attempt === 0) {
        assert.equal(permissions.evaluate(permission).decision, "ask");
        permissions.applyResult(permission, { approved: true, action: "allow_always" });
      }
      assert.equal(permissions.evaluate(permission).decision, "allow");
      await prepared.execute({ toolCallId: `move-${String(attempt)}`, operationId: `move-${String(attempt)}` });
      assert.equal(await readFile(path.join(root, "destination/new.txt"), "utf8"), "approved contents\n");
      assert.equal(permissions.evaluate({ ...permission, secondaryTargetPath: "destination/other.txt" }).decision, "ask");
      if (attempt === 0) {
        await rm(path.join(root, "destination/new.txt"));
        await writeFile(path.join(root, "source.txt"), "approved contents\n");
      }
    }
    assert.equal(permissions.evaluate(request("source.txt")).decision, "ask");
    assert.equal(permissions.evaluate(request("destination/new.txt")).decision, "ask");
  });
});

test("reset clears exact move grants and ordinary session paths", () => {
  const permissions = manager();
  rememberPath(permissions, "source.txt");
  const move = request("source.txt", "destination/new.txt");
  permissions.applyResult(move, { approved: true, action: "allow_always" });
  permissions.resetSession();
  assert.equal(permissions.evaluate(move).decision, "ask");
  assert.equal(permissions.evaluate(request("source.txt")).decision, "ask");
  assert.deepEqual(permissions.getStatus().allowedCommands, []);
  assert.deepEqual(permissions.getStatus().sessionAllowPaths, []);
});

test("move execution still rejects existing destinations without changing source contents", async () => {
  await workspace(async (root) => {
    await writeFile(path.join(root, "destination/new.txt"), "existing contents\n");
    const prepared = await createEditFileTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ operation: "move", path: "source.txt", to: "destination/new.txt" });
    assert.ok(!("isError" in prepared));
    await assert.rejects(prepared.execute({ toolCallId: "move-scope", operationId: "move-scope" }), /destination already exists/u);
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "approved contents\n");
    assert.equal(await readFile(path.join(root, "destination/new.txt"), "utf8"), "existing contents\n");
  });
});

test("move execution still rejects identical source and destination", async () => {
  await workspace(async (root) => {
    const prepared = await createEditFileTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ operation: "move", path: "source.txt", to: "source.txt" });
    assert.ok(!("isError" in prepared));
    await assert.rejects(prepared.execute({ toolCallId: "move-scope", operationId: "move-scope" }), /must differ/u);
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "approved contents\n");
  });
});

test("move policies use the resolved destination behind an internal directory alias", async () => {
  await workspace(async (root) => {
    await symlink(path.join(root, "destination"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const args = { operation: "move" as const, path: "source.txt", to: "alias/new.txt" };
    const tool = createEditFileTool({ workspaceRoot: root, ignore: [] });
    const prepared = await tool.resolveExecution(args);
        assert.ok(!("isError" in prepared));
    const permission = analyzePermissionRequest({ toolName: tool.name, args, projectRoot: root, sessionId: "move-scope", fileChange: prepared.fileChange });
    assert.equal(permission.secondaryTargetPath, "destination/new.txt");
    assert.equal(manager({ paths: ["source.txt", "alias/"] }).evaluate(permission).decision, "ask");
    assert.equal(manager({ paths: ["source.txt", "destination/"] }).evaluate(permission).decision, "allow");
    await prepared.execute({ toolCallId: "move-scope", operationId: "move-scope" });
    assert.equal(await readFile(path.join(root, "destination/new.txt"), "utf8"), "approved contents\n");
  });
});
