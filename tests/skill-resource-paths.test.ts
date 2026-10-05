import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { mock } from "node:test";
import os from "node:os";
import path from "node:path";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { readSkillCatalogFile, scanSkillCatalog } from "../src/extensions/skillCatalog.js";
import { createSkillResourceTool, createSkillTool, loadSkills, skillPromptForSelection } from "../src/extensions/skills.js";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-skill-resource-paths-")));
const homeDir = path.join(root, "home");
const workspaceRoot = path.join(root, "workspace");
const globalRoot = path.join(homeDir, ".config", "biny", "skills");
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const recorders: SessionRecorder[] = [];
const resources = [
  ["references/guide.md ", "reference"],
  [" template.txt", "file"],
  ["assets/template.txt\u00a0", "asset"]
] as const;

class AskResourcePermission extends PermissionManager {
  override evaluate(request: PermissionRequestContext) {
    const result = super.evaluate(request);
    return result.decision === "deny" ? result : { decision: "ask" as const, reason: "Review this exact fixture resource." };
  }
}

try {
  await mkdir(workspaceRoot);
  await ensureAgentDirs(workspaceRoot);
  for (const scope of ["project", "global"] as const) {
    for (const filename of ["SKILL.md", "skill.md"]) {
      const name = `${scope}-${filename === "SKILL.md" ? "upper" : "lower"}`;
      const directory = path.join(scope === "project" ? path.join(workspaceRoot, ".biny", "skills") : globalRoot, name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, filename), `---\nname: ${name}\ndescription: Exact resource path fixture\n---\nRead the listed resource.\n`);
      for (const [relative] of resources) {
        const target = path.join(directory, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `Exact resource ${JSON.stringify(relative)}`);
        await writeFile(path.join(directory, relative.trim()), `Different resource ${JSON.stringify(relative.trim())}`);
      }
    }
  }
  const bundle = await loadSkills({ workspaceRoot, projectPaths: [], globalRoot });
  assert.deepEqual(bundle.errors, []);
  const catalog = await scanSkillCatalog({ homeDir, projectRoots: [workspaceRoot] });
  const resourceTool = createSkillResourceTool(bundle);

  for (const scope of ["project", "global"] as const) {
    for (const casing of ["upper", "lower"]) {
      const name = `${scope}-${casing}`;
      const skill = bundle.skills.find((candidate) => candidate.name === name);
      const catalogEntry = catalog.skills.find((candidate) => candidate.name === name);
      assert.ok(skill);
      assert.ok(catalogEntry);
      const invocation = await createSkillTool(bundle).resolveExecution({ skill: name });
      assert.ok(!("isError" in invocation));
      const instructions = await invocation.execute({ toolCallId: name, operationId: name }) as string;
      const selected = await skillPromptForSelection(bundle, [skill.ref]);

      for (const [relative, kind] of resources) {
        const content = `Exact resource ${JSON.stringify(relative)}`;
        for (const output of [instructions, selected]) {
          assert.ok(output.includes(`- ${path.normalize(relative)} (${kind})`), "Both instruction entry points must list the exact filename");
          assert.ok(!output.includes(content), "Resource contents must stay lazy");
        }
        assert.equal((await readSkillCatalogFile(catalogEntry, relative)).content, content, "The editor already reads the exact listed path");
        const execution = await resourceTool.resolveExecution({ skill: ` ${name} `, path: relative });
        assert.ok(!("isError" in execution));
        const result = await execution.execute({ toolCallId: relative, operationId: relative }) as { content: string; path: string };
        assert.equal(result.content, content, "Reading a listed path must not return the contents of its trimmed sibling");
        assert.equal(result.path, relative);
        assert.deepEqual(execution.accesses, [{ kind: "file", operation: "read", path: path.join(path.dirname(skill.filePath), relative), recursive: false }]);
        assert.equal(execution.approvalRule, `read_skill_resource:${name}:${relative}`);

        const trimmed = await resourceTool.resolveExecution({ skill: name, path: relative.trim() });
        assert.ok(!("isError" in trimmed));
        assert.equal((await trimmed.execute({ toolCallId: "ordinary", operationId: "ordinary" }) as { content: string }).content,
          `Different resource ${JSON.stringify(relative.trim())}`, "Ordinary sibling paths remain distinct and readable");
      }

      const padded = await resourceTool.resolveExecution({ skill: name, path: " \treferences/guide.md\n " });
      assert.ok(!("isError" in padded));
      const paddedResult = await padded.execute({ toolCallId: "padded", operationId: "padded" }) as { content: string; path: string };
      assert.equal(paddedResult.content, "Different resource \"references/guide.md\"");
      assert.equal(paddedResult.path, "references/guide.md", "Absent padded paths keep the previous normalization convenience");
      assert.equal(padded.approvalRule, `read_skill_resource:${name}:references/guide.md`);
      assert.deepEqual(padded.accesses, [{ kind: "file", operation: "read", path: path.join(path.dirname(skill.filePath), "references", "guide.md"), recursive: false }]);

      const skillDirectory = path.dirname(skill.filePath);
      const outsidePath = path.join(root, "outside.txt");
      await writeFile(outsidePath, "Outside fixture");
      await symlink(outsidePath, path.join(skillDirectory, "linked.txt "));
      await writeFile(path.join(skillDirectory, "linked.txt"), "Safe trimmed sibling");
      await writeFile(path.join(skillDirectory, "hardlinked.txt "), "Hardlink fixture");
      await link(path.join(skillDirectory, "hardlinked.txt "), path.join(skillDirectory, "extra-hardlink.txt"));
      await writeFile(path.join(skillDirectory, "hardlinked.txt"), "Safe trimmed sibling");
      await mkdir(path.join(skillDirectory, "directory.txt "));
      await writeFile(path.join(skillDirectory, "directory.txt"), "Safe trimmed sibling");
      await writeFile(path.join(skillDirectory, "oversized.txt "), "x".repeat(512 * 1024 + 1));
      await writeFile(path.join(skillDirectory, "oversized.txt"), "Safe trimmed sibling");
      for (const unsafe of ["linked.txt ", "hardlinked.txt ", "directory.txt ", "oversized.txt "]) {
        const rejected = await resourceTool.resolveExecution({ skill: name, path: unsafe });
        assert.ok("isError" in rejected, "An existing unsafe exact entry must never fall back to its trimmed sibling");
        assert.ok(rejected.errorMessage.endsWith(unsafe), "The error must identify the rejected exact entry");
      }

      for (const invalid of ["", " \t\n ", "../outside.txt", " ../outside.txt ", outsidePath, ` ${outsidePath} `]) {
        assert.ok("isError" in await resourceTool.resolveExecution({ skill: name, path: invalid }), "Empty, blank, escaping, and absolute paths must still be rejected");
      }
      const missing = await resourceTool.resolveExecution({ skill: name, path: "references/missing.txt " });
      assert.ok("isError" in missing);
      assert.match(missing.errorMessage, /ENOENT/u);
    }
  }

  // Non-ENOENT lookup errors must retain their provenance, never select a safe sibling.
  const exactSkill = bundle.skills.find((skill) => skill.name === "project-upper");
  assert.ok(exactSkill);
  const skillDirectory = path.dirname(exactSkill.filePath);
  await writeFile(path.join(skillDirectory, " nested"), "Not a directory");
  await mkdir(path.join(skillDirectory, "nested"));
  await writeFile(path.join(skillDirectory, "nested", "guide.txt"), "Safe trimmed sibling");
  const notDirectory = await resourceTool.resolveExecution({ skill: exactSkill.name, path: " nested/guide.txt " });
  assert.ok("isError" in notDirectory);
  assert.match(notDirectory.errorMessage, /ENOTDIR/u);
  const inaccessiblePath = path.join(skillDirectory, " denied.txt ");
  await writeFile(path.join(skillDirectory, "denied.txt"), "Safe trimmed sibling");
  const realLstat = fs.lstat;
  mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === inaccessiblePath) throw Object.assign(new Error("Exact target permission denied"), { code: "EACCES" });
    return await realLstat(...args);
  });
  try {
    const inaccessible = await resourceTool.resolveExecution({ skill: exactSkill.name, path: " denied.txt " });
    assert.ok("isError" in inaccessible);
    assert.equal(inaccessible.errorMessage, "Exact target permission denied");
  } finally {
    mock.restoreAll();
  }

  // Exercise the runtime's schema -> resolve -> permission -> execute chain.
  const registry = new ToolRegistry();
  registry.registerHostReadQuery(resourceTool, "read_skill_resource");
  function coordinator(denyPaths: string[] = [], confirmPermission?: (request: { targetPath?: string }) => Promise<{ approved: boolean; scope: "once" }>) {
    const config = structuredClone(defaultConfig);
    config.permission = { mode: "full-access", allowTools: [], allowPaths: [], denyPaths, criticalAlwaysAsk: true };
    config.checkpoints.enabled = false;
    config.context.memory.enabled = false;
    const recorder = new SessionRecorder(workspaceRoot, `resource-path-${String(recorders.length)}`);
    recorders.push(recorder);
    const manager = confirmPermission ? new AskResourcePermission(config.permission) : new PermissionManager(config.permission);
    return new ToolExecutionCoordinator({ workspaceRoot, config, recorder, toolRegistry: registry, confirmPermission }, manager, () => undefined, () => ({}));
  }
  const exactRelative = resources[0][0];
  const exactPath = path.join(skillDirectory, exactRelative);
  const trimmedPath = path.join(skillDirectory, exactRelative.trim());
  const args = { skill: exactSkill.name, path: exactRelative };
  const approved = coordinator([], async (request) => {
    assert.equal(request.targetPath, exactPath);
    return { approved: true, scope: "once" };
  });
  const approvedResult = await approved.createAgentTools()[0]!.execute("exact-approved", args);
  assert.equal(approvedResult.isError, false);
  assert.equal((approvedResult.details as { content: string }).content, `Exact resource ${JSON.stringify(exactRelative)}`);
  const deniedResult = await coordinator([exactPath]).createAgentTools()[0]!.execute("exact-denied", args);
  assert.equal((deniedResult.details as { status: string }).status, "denied", "A denied exact resource must never select its allowed trimmed sibling");
  const deniedSibling = await coordinator([trimmedPath]).createAgentTools()[0]!.execute("sibling-denied", args);
  assert.equal(deniedSibling.isError, false, "Denying a different sibling must not change the chosen exact identity");
  const paddedArgs = { skill: exactSkill.name, path: " \treferences/guide.md\n " };
  const paddedDenied = await coordinator([trimmedPath]).createAgentTools()[0]!.execute("fallback-denied", paddedArgs);
  assert.equal((paddedDenied.details as { status: string }).status, "denied", "Legacy fallback permissions must see the actual normalized target");
  const changed = coordinator([], async (request) => {
    assert.equal(request.targetPath, exactPath);
    await writeFile(exactPath, "Changed during approval");
    return { approved: true, scope: "once" };
  });
  const changedResult = await changed.createAgentTools()[0]!.execute("exact-changed", args);
  assert.equal(changedResult.isError, true);
  assert.match(JSON.stringify(changedResult.details), /changed after the tool call was prepared/u);
  const removed = coordinator([], async (request) => {
    assert.equal(request.targetPath, exactPath);
    await rm(exactPath);
    return { approved: true, scope: "once" };
  });
  const removedResult = await removed.createAgentTools()[0]!.execute("exact-removed", args);
  assert.equal(removedResult.isError, true);
  assert.match(JSON.stringify(removedResult.details), /ENOENT/u, "Removal after permission preparation must not switch to the trimmed sibling");
  const newlyPresentRelative = " template.txt ";
  const fallback = coordinator([], async (request) => {
    assert.equal(request.targetPath, path.join(skillDirectory, newlyPresentRelative.trim()));
    await writeFile(path.join(skillDirectory, newlyPresentRelative), "New exact file during approval");
    return { approved: true, scope: "once" };
  });
  const fallbackResult = await fallback.createAgentTools()[0]!.execute("fallback-stays-selected", { skill: exactSkill.name, path: newlyPresentRelative });
  assert.equal(fallbackResult.isError, false);
  assert.equal((fallbackResult.details as { content: string }).content, "Different resource \"template.txt\"", "An approved fallback identity must not switch to a newly created exact entry");
} finally {
  mock.restoreAll();
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

console.log("skill resource path tests passed");
