import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-file-entry-")));
  try {
    await mkdir(path.join(root, "settings"));
    await writeFile(path.join(root, "settings", "production.json"), '{"enabled":true}\n');
    await symlink("settings/production.json", path.join(root, "current-settings.json"), "file");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const operation of ["delete", "move"] as const) {
  test(`Edit ${operation} continues to operate on directly named regular files`, async () => fixture(async root => {
    const execution = await createEditFileTool({ workspaceRoot: root, ignore: [] }).resolveExecution(operation === "move"
      ? { operation, path: "settings/production.json", to: "archived.json" }
      : { operation, path: "settings/production.json" });
    assert.ok(!("isError" in execution));
    await execution.execute({ toolCallId: "direct-file" });
    await assert.rejects(lstat(path.join(root, "settings", "production.json")), { code: "ENOENT" });
    if (operation === "move") assert.equal(await readFile(path.join(root, "archived.json"), "utf8"), '{"enabled":true}\n');
  }));
  for (const hashline of [false, true]) {
    test(`Edit ${operation} (${hashline ? "hashline" : "string"}) rejects a file alias without changing its referent`, async () => fixture(async root => {
      const tool = createEditFileTool({ workspaceRoot: root, ignore: [] }, hashline);
      await assert.rejects(async () => tool.resolveExecution(operation === "move"
        ? { operation, path: "current-settings.json", to: "archived.json" }
        : { operation, path: "current-settings.json" }), /symbolic.link/i);
      assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":true}\n');
      assert.equal((await lstat(path.join(root, "current-settings.json"))).isSymbolicLink(), true);
      await assert.rejects(lstat(path.join(root, "archived.json")), { code: "ENOENT" });
    }));
  }

  test(`Edit ${operation} continues to operate on regular files through directory aliases`, async () => fixture(async root => {
    await symlink("settings", path.join(root, "alias-directory"), "dir");
    const tool = createEditFileTool({ workspaceRoot: root, ignore: [] });
    const execution = await tool.resolveExecution(operation === "move"
      ? { operation, path: "alias-directory/production.json", to: "archived.json" }
      : { operation, path: "alias-directory/production.json" });
    assert.ok(!("isError" in execution));
    const result = await execution.execute({ toolCallId: "directory-alias" });
    assert.equal(result.change.operation, operation);
    assert.equal(result.change.path, path.join("settings", "production.json"));
    await assert.rejects(lstat(path.join(root, "settings", "production.json")), { code: "ENOENT" });
    if (operation === "move") assert.equal(await readFile(path.join(root, "archived.json"), "utf8"), '{"enabled":true}\n');
  }));

  test(`Edit ${operation} rechecks the requested entry after preparation even when its canonical target is unchanged`, async () => fixture(async root => {
    await symlink("settings", path.join(root, "alias-directory"), "dir");
    const tool = createEditFileTool({ workspaceRoot: root, ignore: [] });
    const args = operation === "move"
      ? { operation, path: "alias-directory/production.json", to: "archived.json" } as const
      : { operation, path: "alias-directory/production.json" } as const;
    const execution = await tool.resolveExecution(args);
    assert.ok(!("isError" in execution));
    await unlink(path.join(root, "alias-directory"));
    await mkdir(path.join(root, "alias-directory"));
    await symlink("../settings/production.json", path.join(root, "alias-directory", "production.json"), "file");
    assert.equal(resolveWorkspacePath(root, args.path, []), path.join(root, "settings", "production.json"));
    await assert.rejects(execution.execute({ toolCallId: "changed-entry" }), /symbolic.link/i);
    assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":true}\n');
  }));

  test(`Edit ${operation} permission preview refuses to label referent content as the alias`, async () => fixture(async root => {
    await assert.rejects(createToolPermissionRequest({
      id: "entry-preview", name: "Edit",
      args: operation === "move" ? { operation, path: "current-settings.json", to: "archived.json" } : { operation, path: "current-settings.json" }
    }, { workspaceRoot: root, ignore: [] }), /symbolic.link/i);
  }));
}

test("apply_patch delete rejects the file alias before preparing a deletion", async () => fixture(async root => {
  await assert.rejects(async () => createApplyPatchTool({ workspaceRoot: root, ignore: [] }).resolveExecution({
    callId: "patch-delete", operation: { type: "delete_file", path: "current-settings.json" }
  }), /symbolic.link/i);
  assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":true}\n');
}));

test("apply_patch delete preview rejects the file alias", async () => fixture(async root => {
  await assert.rejects(createToolPermissionRequest({
    id: "patch-preview", name: "apply_patch",
    args: { callId: "patch-preview", operation: { type: "delete_file", path: "current-settings.json" } }
  }, { workspaceRoot: root, ignore: [] }), /symbolic.link/i);
}));

test("a terminal file alias is still rejected beneath a directory alias", async () => fixture(async root => {
  await symlink("production.json", path.join(root, "settings", "alias.json"), "file");
  await symlink("settings", path.join(root, "alias-directory"), "dir");
  await assert.rejects(async () => createEditFileTool({ workspaceRoot: root, ignore: [] }).resolveExecution({
    operation: "delete", path: "alias-directory/alias.json"
  }), /symbolic.link/i);
  assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":true}\n');
}));

test("apply_patch deletion of a regular file remains functional", async () => fixture(async root => {
  const execution = await createApplyPatchTool({ workspaceRoot: root, ignore: [] }).resolveExecution({
    callId: "regular-patch", operation: { type: "delete_file", path: "settings/production.json" }
  });
  assert.ok(!("isError" in execution));
  const result = await execution.execute({ toolCallId: "regular-patch" });
  assert.equal(result.change.operation, "delete");
  await assert.rejects(lstat(path.join(root, "settings", "production.json")), { code: "ENOENT" });
}));

test("canonical ignore policy remains enforced before rejecting a terminal alias", async () => fixture(async root => {
  await assert.rejects(async () => createEditFileTool({ workspaceRoot: root, ignore: ["settings"] }).resolveExecution({
    operation: "delete", path: "current-settings.json"
  }), /resolves to a location ignored by workspace policy/);
  assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":true}\n');
}));

test("a chain of file aliases is rejected without deleting its final regular target", async () => fixture(async root => {
  await symlink("current-settings.json", path.join(root, "older-settings.json"), "file");
  await assert.rejects(async () => createEditFileTool({ workspaceRoot: root, ignore: [] }).resolveExecution({
    operation: "delete", path: "older-settings.json"
  }), /symbolic.link/i);
  assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":true}\n');
}));

test("missing and dangling sources fail without changing existing files", async () => fixture(async root => {
  await symlink("missing.json", path.join(root, "dangling.json"), "file");
  const tool = createEditFileTool({ workspaceRoot: root, ignore: [] });
  await assert.rejects(async () => tool.resolveExecution({ operation: "delete", path: "missing.json" }), { code: "ENOENT" });
  await assert.rejects(async () => tool.resolveExecution({ operation: "delete", path: "dangling.json" }), /dangling symbolic link/);
  assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":true}\n');
}));

test("an innocently named alias cannot target a protected credential file", async () => fixture(async root => {
  await writeFile(path.join(root, ".env"), "private");
  await symlink(".env", path.join(root, "settings-backup.txt"), "file");
  await assert.rejects(async () => createEditFileTool({ workspaceRoot: root, ignore: [] }).resolveExecution({
    operation: "delete", path: "settings-backup.txt"
  }), /resolves to a location ignored by workspace policy/);
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "private");
}));

test("ordinary update through a file alias retains its existing behavior", async () => fixture(async root => {
  const execution = await createEditFileTool({ workspaceRoot: root, ignore: [] }).resolveExecution({
    operation: "update", path: "current-settings.json", old_string: "true", new_string: "false", replace_all: false
  });
  assert.ok(!("isError" in execution));
  await execution.execute({ toolCallId: "update-alias" });
  assert.equal(await readFile(path.join(root, "settings", "production.json"), "utf8"), '{"enabled":false}\n');
  assert.equal((await lstat(path.join(root, "current-settings.json"))).isSymbolicLink(), true);
}));

test("a symlinked workspace root still permits direct regular-file deletion", async () => fixture(async root => {
  const rootAlias = root + "-alias";
  await symlink(root, rootAlias, "dir");
  try {
    const execution = await createEditFileTool({ workspaceRoot: rootAlias, ignore: [] }).resolveExecution({ operation: "delete", path: "settings/production.json" });
    assert.ok(!("isError" in execution));
    await execution.execute({ toolCallId: "root-alias" });
    await assert.rejects(lstat(path.join(root, "settings", "production.json")), { code: "ENOENT" });
  } finally { await unlink(rootAlias); }
}));

for (const target of ["../outside-file", "ignored/production.json", ".env"] as const) {
  test(`entry checking retains the workspace and ignore boundary for ${target}`, async () => fixture(async root => {
    await mkdir(path.join(root, "ignored"));
    await writeFile(path.join(root, "ignored", "production.json"), "private");
    await writeFile(path.join(root, ".env"), "private");
    await assert.rejects(async () => createEditFileTool({ workspaceRoot: root, ignore: ["ignored"] }).resolveExecution({ operation: "delete", path: target }), /escapes workspace|ignored by workspace policy/);
  }));
}
