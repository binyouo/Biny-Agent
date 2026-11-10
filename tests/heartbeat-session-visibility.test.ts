import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopThreadBriefService } from "../src/desktop/electron/main/DesktopThreadBriefService.js";
import { ThreadBriefStore } from "../src/session/threadBriefStore.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { refreshSessionIndex, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { createSessionFile, resolveSessionFile, sessionIdFromFile } from "../src/session/store.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("心跳记录不进入聊天分页、置顶与恢复选择，原始记录保留", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-visible-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const statePath = path.join(root, "desktop.json");
  const state = new DesktopStateStore(statePath);
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  let projectPath: string | undefined;
  try {
    await state.load();
    await storage.initialize();
    const projects = new DesktopProjectService(state, storage, { load: async () => defaultConfig, save: async () => {} });
    const project = await projects.createEmptyProject(path.join(root, "workspace"));
    projectPath = project.path;
    const originals = new Map<string, string>();
    for (const id of ["normal", "heartbeat-discussion", "heartbeat-00000000-0000-4000-8000-000000000002", ...Array.from({ length: 40 }, () => `heartbeat-${randomUUID()}`)]) {
      const content = JSON.stringify({ type: "user_message", content: "HEARTBEAT.md discussion", time: "2026-11-10T00:00:00Z" }) + "\n";
      originals.set(await createSessionFile(project.path, id, Buffer.from(content)), content);
    }
    await updateSessionCatalogMetadata(project.path, "heartbeat-00000000-0000-4000-8000-000000000002", { pinned: true });
    await state.setSelectedSession(project.id, "heartbeat-00000000-0000-4000-8000-000000000002");
    assert.ok(["normal", "heartbeat-discussion"].includes(sessionIdFromFile(await resolveSessionFile(project.path, "latest"))), "latest resumes a user conversation");
    assert.equal(sessionIdFromFile(await resolveSessionFile(project.path, "heartbeat-00000000-0000-4000-8000-000000000002")), "heartbeat-00000000-0000-4000-8000-000000000002", "explicit diagnostic reads remain available");
    const workspace = await projects.listWorkspaceSessions(project, undefined, new Map());
    for (const sessions of [workspace.sessions, workspace.sessionPage.sessions,
      await projects.listSidebarSessions(project, undefined, new Map()),
      await projects.listSessions(project, undefined, new Map())]) {
      assert.deepEqual(sessions.map(item => item.id).sort(), ["heartbeat-discussion", "normal"]);
    }
    assert.equal(workspace.sessionPage.nextCursor, undefined, "hidden sessions must not consume page slots");
    const page = await projects.listSessionTreePage(project, undefined, new Map(), { includePinnedSessions: true, sessionIds: ["heartbeat-00000000-0000-4000-8000-000000000002"] });
    assert.deepEqual(page.pinnedSessions, []);
    assert.deepEqual(page.supplementalSessions, []);
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.equal(restored.selectedSessionId(project.id), undefined, "a previously selected heartbeat must not reopen on startup");
    const briefs = new DesktopThreadBriefService({ state, projects,
      configStore: { load: async () => defaultConfig, save: async () => {} },
      store: new ThreadBriefStore(path.join(root, "briefs")), chooseProjectDirectory: async () => undefined });
    try {
      await briefs.initialize();
      const history = await briefs.request({ action: "history" });
      assert.deepEqual(history.history?.map(item => item.sessionId).sort(), ["heartbeat-discussion", "normal"]);
      await assert.rejects(briefs.request({ action: "backfill", sessionId: "heartbeat-00000000-0000-4000-8000-000000000002" }), /找不到对话/u);
    } finally { await briefs.close(); }
    for (const [file, content] of originals) assert.equal(await readFile(file, "utf8"), content);
  } finally {
    if (projectPath) await refreshSessionIndex(projectPath);
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
