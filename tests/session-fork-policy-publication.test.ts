import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { forkSession } from "../src/session/fork.js";
import { createSessionFile, ensureAgentDirs, listSessionFiles } from "../src/session/store.js";
import { writeSessionCatalogRecord, readSessionCatalogRecord, sessionCatalogDirectory } from "../src/session/catalog.js";

for (const code of ["EIO", "ENOSPC"]) {
  test(`fork must not publish private transcript before policy commit (${code})`, async (t) => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "biny-fork-policy-"));
    const prior = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    t.after(async () => { t.mock.restoreAll(); if (prior === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = prior; await fs.rm(root, { recursive: true, force: true }); });
    const workspace = path.join(root, "workspace"); await fs.mkdir(workspace); await ensureAgentDirs(workspace);
    const id = "private-parent";
    const bytes = Buffer.from(`${JSON.stringify({ type: "user_message", content: "synthetic private history" })}\n`);
    const source = await createSessionFile(workspace, id, bytes);
    await writeSessionCatalogRecord(workspace, { version: 1, sessionId: id, rootSessionId: id, personalization: { useMemories: false, contributeMemories: false }, createdAt: "2026-11-17", updatedAt: "2026-11-17" });
    const rename = fs.rename.bind(fs);
    const hook = t.mock.method(fs, "rename", async (from, to) => {
      if (path.dirname(String(to)) === sessionCatalogDirectory(workspace) && path.basename(String(to)) !== `${id}.json`) throw Object.assign(new Error(code), { code });
      return rename(from, to);
    });
    await assert.rejects(forkSession(workspace, id), new RegExp(code));
    assert.deepEqual(await fs.readFile(source), bytes);
    assert.equal((await listSessionFiles(workspace)).length, 1, "failed fork must not publish unprotected history");
    hook.mock.restore();
    const fork = await forkSession(workspace, id);
    assert.deepEqual((await readSessionCatalogRecord(workspace, fork.sessionId))?.personalization, { useMemories: false, contributeMemories: false });
    assert.deepEqual(await fs.readFile(fork.filePath), bytes);
  });
}

for (const mode of ["fork", "desktop"] as const) {
  for (const failure of ["policy", "metadata", "transcript", "none"] as const) {
    if (mode === "fork" && failure === "metadata") continue;
    test(`${mode} publication preserves opt-out ordering under ${failure} failure`, async (t) => {
      const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "biny-fork-publication-"));
      const prior = process.env.BINY_AGENT_DIR;
      process.env.BINY_AGENT_DIR = path.join(root, "agent");
      const { refreshSessionIndex } = await import("../src/session/catalog.js");
      let workspace = path.join(root, "workspace");
      t.after(async () => { t.mock.restoreAll(); await refreshSessionIndex(workspace); if (prior === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = prior; await fs.rm(root, { recursive: true, force: true }); });
      const { createFileConfigStore } = await import("../src/config/store.js");
      const { DesktopProjectService } = await import("../src/desktop/electron/main/DesktopProjectService.js");
      const { DesktopStateStore } = await import("../src/desktop/electron/main/DesktopStateStore.js");
      const { DesktopUserDataStore } = await import("../src/desktop/electron/main/DesktopUserDataStore.js");
      const state = new DesktopStateStore(path.join(root, "state.json")); await state.load();
      const config = createFileConfigStore(root, { globalDir: path.join(root, "config") });
      config.supportsDetachedRuntimeHost = false;
      const projects = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "data")), config);
      const project = await projects.createEmptyProject(workspace);
      if (mode === "desktop") workspace = await projects.dataRoot(project);
      await ensureAgentDirs(workspace);
      const id = "private-parent";
      const bytes = Buffer.from(`${JSON.stringify({ type: "user_message", content: "private synthetic conversation" })}\n`);
      const source = await createSessionFile(workspace, id, bytes);
      await writeSessionCatalogRecord(workspace, { version: 1, sessionId: id, rootSessionId: id, personalization: { useMemories: false, contributeMemories: false }, createdAt: "2026-11-17", updatedAt: "2026-11-17" });
      const open = fs.open.bind(fs); const rename = fs.rename.bind(fs);
      let childPath: string | undefined;
      let metadataWrites = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith(".jsonl") && args[0] !== source && typeof args[1] === "number" && (args[1] & constants.O_EXCL) !== 0) {
          childPath = String(args[0]);
          const write = handle.writeFile.bind(handle);
          t.mock.method(handle, "writeFile", async (...writeArgs: Parameters<typeof handle.writeFile>) => {
            const childId = path.basename(childPath!, ".jsonl");
            assert.equal((await fs.readFile(childPath!)).length, 0, "reservation has no history before policy");
            assert.deepEqual((await readSessionCatalogRecord(workspace, childId))?.personalization, { useMemories: false, contributeMemories: false });
            if (failure === "transcript") throw Object.assign(new Error("transcript EIO"), { code: "EIO" });
            return write(...writeArgs);
          });
        }
        return handle;
      });
      t.mock.method(fs, "rename", async (from, to) => {
        if (path.dirname(String(to)) === sessionCatalogDirectory(workspace) && path.basename(String(to)) !== `${id}.json`) {
          metadataWrites += 1;
          if (failure === "policy" || (failure === "metadata" && metadataWrites === 2)) throw Object.assign(new Error("policy EIO"), { code: "EIO" });
        }
        return rename(from, to);
      });
      const operation = mode === "fork" ? forkSession(workspace, id) : projects.duplicateSession(project, id);
      if (failure === "none") await operation; else await assert.rejects(operation, /EIO/u);
      assert.ok(childPath, "real new-file reservation observed");
      assert.deepEqual(await fs.readFile(source), bytes);
      if (failure !== "none") {
        await assert.rejects(fs.access(childPath), { code: "ENOENT" });
        assert.equal((await listSessionFiles(workspace)).length, 1);
      } else {
        const { AgentSession } = await import("../src/agent/AgentSession.js");
        const { defaultConfig } = await import("../src/config/schema.js");
        const { PermissionManager } = await import("../src/permission/PermissionManager.js");
        const { SessionRecorder } = await import("../src/session/recorder.js");
        const { ToolRegistry } = await import("../src/tools/registry.js");
        const configuration = structuredClone(defaultConfig);
        const agent = new AgentSession({ workspaceRoot: workspace, config: configuration, recorder: new SessionRecorder(workspace, path.basename(childPath, ".jsonl")), toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...configuration.permission, source: "test" }) });
        try { const policy = await agent.getPersonalizationState(); assert.equal(policy.resolved.useMemories, false); assert.equal(policy.resolved.contributeMemories, false); } finally { await agent.close(); }
      }
    });
  }
}
