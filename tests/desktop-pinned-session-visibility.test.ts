import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { sessionsCommand } from "../src/cli/commands/sessions.js";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { replaceProjectSessionRoots } from "../src/desktop/renderer/src/app/desktopState.js";
import { readSessionCatalogRecord, refreshSessionIndex, type SessionCatalogPage } from "../src/session/catalog.js";
import { SessionRunLedger } from "../src/session/runLedger.js";
import { createSessionFile } from "../src/session/store.js";

async function fixture(context: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-pinned-visibility-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const configStore = createFileConfigStore(root, {
    globalDir: path.join(root, "config"),
    credentialStore: new EnvironmentCredentialStore()
  });
  await configStore.save({
    ...structuredClone(defaultConfig),
    defaultModel: "pin-fixture",
    providers: { "pin-fixture": { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "pin-fixture": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "pin-fixture", model: "pin-fixture" } }
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  context.after(async () => {
    await manager.closeAll();
    await Promise.all(state.projects().map((current) => refreshSessionIndex(current.path)));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const create = async (id: string, minute: number) => await createSessionFile(project.path, id, Buffer.from(`${JSON.stringify({
    type: "user_message", content: id, time: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString()
  })}\n`));
  const pinnedFile = await create("older-pin", 0);
  const original = await readFile(pinnedFile, "utf8");
  const initial = await manager.pinSession(project.id, "older-pin", true);
  assert.equal(initial.sessions.find((session) => session.id === "older-pin")?.pinned, true);
  for (let index = 1; index <= 32; index += 1) await create(`recent-${index}`, index);
  return { root, project, projects, manager, initial, pinnedFile, original };
}

// A pin can age out of the recent page without losing its separate pinned-section entry.
// Existing sidebar tests use fewer than a page of synthetic rows and cannot catch this loss.
for (const surface of ["refresh", "selected-project bootstrap", "other-project bootstrap"] as const) {
  test(`persisted pins remain visible beyond the first catalog page during ${surface}`, async (context) => {
    const { project, manager, initial, pinnedFile, original } = await fixture(context);
    const snapshot = await manager.workspaceSnapshot(project.id, false);
    assert.equal(snapshot.sessions.length, 33);
    assert.equal(snapshot.sessionPage?.sessions.length, 32);
    assert.ok(snapshot.sessionPage?.nextCursor);
    assert.equal(snapshot.sessionPage.sessions.some((session) => session.id === "older-pin"), false,
      "chronological catalog pagination must remain unchanged");
    assert.equal((await readSessionCatalogRecord(project.path, "older-pin"))?.pinned, true);
    const sidebar = surface === "refresh"
      ? replaceProjectSessionRoots(initial.sessionPage!.sessions, project.id, snapshot.sessionPage.sessions, snapshot.sessions)
      : await manager.sidebarSessions(surface === "selected-project bootstrap" ? snapshot : undefined);
    assert.equal(sidebar.find((session) => session.id === "older-pin")?.pinned, true,
      "the persisted pin must be available to the sidebar pinned section");
    assert.equal(sidebar.length, 33);
    assert.equal(new Set(sidebar.map((session) => `${session.projectId}:${session.id}`)).size, sidebar.length);
    assert.equal(await readFile(pinnedFile, "utf8"), original, "pinning and refreshing must not rewrite conversation events");
    assert.equal(snapshot.runtime, undefined, "listing pins must not initialize a runtime");
  });
}

// Metadata actions keep their exact target and CAS boundary while the independent pin list changes.
test("older pin feedback follows archive, rejected stale writes, unpin, repin and deletion", async (context) => {
  const { project, manager, initial, pinnedFile, original } = await fixture(context);
  const oldRevision = initial.sessions.find((session) => session.id === "older-pin")!.metadataRevision;
  const archived = await manager.archiveSession(project.id, "older-pin", true, oldRevision);
  const archivedSession = archived.sessions.find((session) => session.id === "older-pin")!;
  assert.equal(archivedSession.archived, true);
  assert.equal((await manager.sidebarSessions(archived)).find((session) => session.id === "older-pin")?.archived, true,
    "archiving must retain the existing independent pinned flag");
  const saved = await readSessionCatalogRecord(project.path, "older-pin");
  await assert.rejects(manager.pinSession(project.id, "older-pin", false, oldRevision), /revision conflict/);
  assert.deepEqual(await readSessionCatalogRecord(project.path, "older-pin"), saved,
    "a rejected stale action must not alter persisted metadata or retry automatically");
  const output: unknown[][] = [];
  const log = context.mock.method(console, "log", (...args: unknown[]) => { output.push(args); });
  try {
    await sessionsCommand(project.path, { limit: 50, json: true });
  } finally { log.mock.restore(); }
  const cli = JSON.parse(String(output[0]![0])) as SessionCatalogPage;
  const cliPin = cli.items.find((session) => session.id === "older-pin");
  assert.equal(cliPin?.pinned, true);
  assert.equal(cliPin?.archived, true);
  assert.equal(cliPin?.metadataRevision, archivedSession.metadataRevision);

  const unarchived = await manager.archiveSession(project.id, "older-pin", false, archivedSession.metadataRevision);
  const unpinned = await manager.pinSession(project.id, "older-pin", false,
    unarchived.sessions.find((session) => session.id === "older-pin")!.metadataRevision);
  let sidebar = replaceProjectSessionRoots(archived.sessions, project.id, unpinned.sessionPage!.sessions, unpinned.sessions);
  assert.equal(sidebar.some((session) => session.id === "older-pin"), false,
    "unpinning must remove the out-of-page shortcut rather than retain its stale flag");
  assert.equal((await manager.sidebarSessions()).some((session) => session.id === "older-pin"), false);
  const repinned = await manager.pinSession(project.id, "older-pin", true,
    unpinned.sessions.find((session) => session.id === "older-pin")!.metadataRevision);
  sidebar = replaceProjectSessionRoots(sidebar, project.id, repinned.sessionPage!.sessions, repinned.sessions);
  assert.equal(sidebar.find((session) => session.id === "older-pin")?.pinned, true,
    "pinning an older session from search must add it without needing a preloaded sidebar entry");
  assert.equal(sidebar.find((session) => session.id === "older-pin")?.archived, false);
  assert.equal(await readFile(pinnedFile, "utf8"), original);
  const deleted = await manager.deleteSession(project.id, "older-pin");
  sidebar = replaceProjectSessionRoots(sidebar, project.id, deleted.sessionPage!.sessions, deleted.sessions);
  assert.equal(sidebar.some((session) => session.id === "older-pin"), false);
  assert.equal((await manager.sidebarSessions()).some((session) => session.id === "older-pin"), false);
});

test("pin summaries do not replace same-ID sessions in another project or duplicate recent pins", async (context) => {
  const { root, project, projects, manager } = await fixture(context);
  const other = await projects.createEmptyProject(path.join(root, "other-workspace"));
  await createSessionFile(other.path, "older-pin", Buffer.from(`${JSON.stringify({
    type: "user_message", content: "other project conversation", time: "2026-01-02T00:00:00.000Z"
  })}\n`));
  let snapshot = await manager.workspaceSnapshot(project.id, false);
  let sidebar = await manager.sidebarSessions(snapshot);
  assert.equal(sidebar.find((session) => session.id === "older-pin" && session.projectId === project.id)?.pinned, true);
  assert.equal(sidebar.find((session) => session.id === "older-pin" && session.projectId === other.id)?.pinned, false);
  const otherRow = sidebar.find((session) => session.projectId === other.id)!;
  snapshot = await manager.pinSession(project.id, "recent-32", true);
  sidebar = replaceProjectSessionRoots(sidebar, project.id, snapshot.sessionPage!.sessions, snapshot.sessions);
  assert.equal(sidebar.filter((session) => session.id === "recent-32").length, 1);
  assert.strictEqual(sidebar.find((session) => session.projectId === other.id), otherRow);
  const otherPinned = await manager.pinSession(other.id, "older-pin", true, otherRow.metadataRevision);
  sidebar = await manager.sidebarSessions(otherPinned);
  assert.equal(sidebar.filter((session) => session.id === "older-pin" && session.pinned).length, 2);
});

// Selecting page + pins must happen before ledger projection: hidden unpinned runs are unrelated.
test("cold sidebar refresh does not reconcile a hidden unpinned session ledger", async (context) => {
  const { project, manager } = await fixture(context);
  await createSessionFile(project.path, "hidden-unpinned", Buffer.from(`${JSON.stringify({
    type: "user_message", content: "hidden history", time: "2025-12-31T00:00:00.000Z"
  })}\n`));
  const ledger = new SessionRunLedger(project.path);
  await ledger.start({ runId: "hidden-stale-run", sessionId: "hidden-unpinned", pid: 2_147_483_647 });
  const before = await ledger.read("hidden-stale-run");
  assert.equal(before?.status, "running");
  const sidebar = await manager.sidebarSessions();
  assert.equal(sidebar.some((session) => session.id === "hidden-unpinned"), false);
  assert.equal(sidebar.find((session) => session.id === "older-pin")?.pinned, true);
  assert.deepEqual(await ledger.read("hidden-stale-run"), before,
    "showing an older pin must not reconcile an unrelated hidden run");
});
