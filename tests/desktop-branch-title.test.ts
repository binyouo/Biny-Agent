import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { listSessionCatalog, readSessionCatalogRecord, refreshSessionIndex } from "../src/session/catalog.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { createSessionFile, listSessionFiles, sessionFilePath } from "../src/session/store.js";

const sourceId = "title-source";
const sourceEvents: SessionEvent[] = [
  { type: "user_message", messageId: "first", content: "First question", time: "2026-10-01T00:00:00.000Z" },
  { type: "assistant_message", messageId: "answer", parentMessageId: "first", content: "First answer", time: "2026-10-01T00:00:01.000Z" },
  { type: "user_message", messageId: "second", parentMessageId: "answer", content: "Second question", time: "2026-10-01T00:00:02.000Z" }
];

async function fixture(context: TestContext, title: string | undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-branch-title-"));
  const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
  let manager: DesktopAgentManager | undefined;
  let dataRoot: string | undefined;
  context.after(async () => {
    try {
      await manager?.closeAll();
      // Join this fixture's catalog publications before removing its isolated data.
      if (dataRoot) await refreshSessionIndex(dataRoot);
      await rm(root, { recursive: true, force: true });
    } finally {
      if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
    }
  });
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save({
    ...structuredClone(defaultConfig),
    defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  dataRoot = await projects.dataRoot(project);
  await createSessionFile(dataRoot, sourceId, Buffer.from(sourceEvents.map(event => JSON.stringify(event)).join("\n") + "\n"));
  await projects.updateSessionMetadata(project, sourceId, {
    title, pinned: true, archived: true, unread: true, labels: ["keep-label"]
  });
  await state.setSelectedSession(project.id, sourceId);
  manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  const sourceBytes = await readFile(sessionFilePath(dataRoot, sourceId));
  const sourceRecord = await readSessionCatalogRecord(dataRoot, sourceId);
  return { projects, project, dataRoot, manager, sourceBytes, sourceRecord };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertSourceUnchanged(f: Fixture): Promise<void> {
  assert.deepEqual(await readFile(sessionFilePath(f.dataRoot, sourceId)), f.sourceBytes);
  assert.deepEqual(await readSessionCatalogRecord(f.dataRoot, sourceId), f.sourceRecord);
}

async function assertChild(f: Fixture, childId: string, title: string | undefined, parentId = sourceId): Promise<void> {
  assert.notEqual(childId, parentId);
  const child = await readSessionCatalogRecord(f.dataRoot, childId);
  assert.ok(child);
  assert.equal(child.title, title);
  assert.ok(child.title === undefined || child.title.length <= 120);
  assert.equal(child.rootSessionId, sourceId);
  assert.equal(child.parentSessionId, parentId);
  assert.equal(child.pinned, false);
  assert.equal(child.archived, false);
  assert.equal(child.unread ?? false, false);
  assert.deepEqual(child.labels, ["keep-label"]);
}

const titleCases: Array<{ name: string; title: string | undefined; expected: string | undefined }> = [
  ...[118, 119, 120].map(length => ({ name: `ASCII ${length}`, title: "x".repeat(length), expected: "x".repeat(117) + " 分支" })),
  { name: "117-unit boundary", title: "x".repeat(117), expected: "x".repeat(117) + " 分支" },
  { name: "short mixed Unicode", title: "计划😀e\u0301", expected: "计划😀e\u0301 分支" },
  { name: "absent title", title: undefined, expected: undefined },
  { name: "120 Chinese units", title: "题".repeat(120), expected: "题".repeat(117) + " 分支" },
  { name: "60 emoji", title: "😀".repeat(60), expected: "😀".repeat(58) + " 分支" },
  { name: "pair crosses cut", title: "x".repeat(116) + "😀yz", expected: "x".repeat(116) + " 分支" },
  { name: "pair fits cut", title: "x".repeat(115) + "😀y", expected: "x".repeat(115) + "😀 分支" }
];

for (const { name, title, expected } of titleCases) {
  test(`duplicate preserves content and lineage with ${name}`, { timeout: 10_000 }, async context => {
    const f = await fixture(context, title);
    const childId = await f.projects.duplicateSession(f.project, sourceId);
    await assertChild(f, childId, expected);
    assert.deepEqual((await readStoredSessionEvents(f.dataRoot, childId)).events, sourceEvents);
    assert.deepEqual((await readSessionCatalogRecord(f.dataRoot, childId))?.branchPoint, { kind: "event", index: 3 });
    assert.deepEqual((await listSessionFiles(f.dataRoot)).sort(), [sourceId + ".jsonl", childId + ".jsonl"].sort());
    assert.equal((await listSessionCatalog(f.dataRoot)).length, 2);
    await assertSourceUnchanged(f);
  });
}

test("a generated maximum-length title can be duplicated again", { timeout: 10_000 }, async context => {
  const f = await fixture(context, "x".repeat(120));
  const first = await f.projects.duplicateSession(f.project, sourceId);
  const firstRecord = await readSessionCatalogRecord(f.dataRoot, first);
  const second = await f.projects.duplicateSession(f.project, first);
  await assertChild(f, first, "x".repeat(117) + " 分支");
  await assertChild(f, second, "x".repeat(117) + " 分支", first);
  assert.deepEqual(await readSessionCatalogRecord(f.dataRoot, first), firstRecord);
  assert.deepEqual((await readStoredSessionEvents(f.dataRoot, second)).events, sourceEvents);
  assert.deepEqual((await readSessionCatalogRecord(f.dataRoot, second))?.branchPoint, { kind: "event", index: 3 });
  assert.equal((await listSessionFiles(f.dataRoot)).length, 3);
  await assertSourceUnchanged(f);
});

test("user-message fork uses the bounded title without changing its prefix or source", { timeout: 10_000 }, async context => {
  const f = await fixture(context, "x".repeat(120));
  const childId = await f.projects.forkSessionAtUserMessage(f.project, sourceId, 1);
  await assertChild(f, childId, "x".repeat(117) + " 分支");
  assert.deepEqual((await readStoredSessionEvents(f.dataRoot, childId)).events, sourceEvents.slice(0, 2));
  assert.deepEqual((await readSessionCatalogRecord(f.dataRoot, childId))?.branchPoint, {
    kind: "user_message", index: 1, messageId: "second"
  });
  assert.equal((await listSessionFiles(f.dataRoot)).length, 2);
  await assertSourceUnchanged(f);
});

test("manager keeps 120-unit rename validation and selects the completed duplicate", { timeout: 10_000 }, async context => {
  const f = await fixture(context, "Before rename");
  const title = "x".repeat(120);
  await f.manager.renameSession(f.project.id, sourceId, title);
  f.sourceRecord = await readSessionCatalogRecord(f.dataRoot, sourceId);
  assert.equal(f.sourceRecord?.title, title);
  await assert.rejects(f.manager.renameSession(f.project.id, sourceId, "x".repeat(121)), /Invalid session catalog title/);
  await assert.rejects(f.manager.renameSession(f.project.id, sourceId, "   "), /Invalid session catalog title/);
  await assertSourceUnchanged(f);
  const snapshot = await f.manager.duplicateSession(f.project.id, sourceId);
  const childId = snapshot.selectedSessionId;
  assert.ok(childId);
  await assertChild(f, childId, "x".repeat(117) + " 分支");
  assert.equal(snapshot.sessions.find(session => session.id === childId)?.title, "x".repeat(117) + " 分支");
  assert.deepEqual((await readStoredSessionEvents(f.dataRoot, childId)).events, sourceEvents);
  assert.equal((await listSessionFiles(f.dataRoot)).length, 2);
  await assertSourceUnchanged(f);
});
