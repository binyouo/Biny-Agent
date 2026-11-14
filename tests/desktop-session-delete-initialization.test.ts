/** Real Manager/ProjectService/Recorder; gate only initialization's data-root I/O. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopSessionTarget } from "../src/desktop/protocol.js";
import { createFileConfigStore } from "../src/config/store.js";
import { SessionRecorder } from "../src/session/recorder.js";

async function fixture(t: TestContext, passive = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-delete-initialization-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const config = createFileConfigStore(workspace, { globalDir: path.join(root, "config") });
  config.supportsDetachedRuntimeHost = false;
  const projects = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "data")), config);
  const project = await projects.createProject(workspace);
  const manager = new DesktopAgentManager(state, projects, config, () => {});
  const dataRoot = await projects.dataRoot(project);
  const recorder = new SessionRecorder(dataRoot, "retained-session");
  recorder.record({ type: "user_message", content: "keep existing task history" });
  await recorder.flush();
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let reject!: (error: Error) => void;
  let resolve!: (value: string) => void;
  const gate = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const original = projects.dataRoot.bind(projects);
  const boundary = t.mock.method(projects, "dataRoot", async (target: typeof project) => {
    if (target.id !== project.id) return original(target);
    entered();
    return gate;
  });
  // Public entry creates the real initialization entry; no private maps or fake runtime.
  const pending = (passive ? manager.toolCatalog(project.id) : manager.preparePrompt(project.id)).then(
    () => "completed",
    error => error
  );
  const deletions: Array<ReturnType<DesktopAgentManager["deleteSessions"]>> = [];
  const deleting = (targets: DesktopSessionTarget[]) => {
    const operation = manager.deleteSessions(targets);
    deletions.push(operation);
    return operation;
  };
  let deleteCalls = 0;
  const originalDelete = projects.deleteSession.bind(projects);
  t.mock.method(projects, "deleteSession", async (...args: Parameters<typeof originalDelete>) => {
    deleteCalls++;
    return originalDelete(...args);
  });
  t.after(async () => {
    reject(new Error("synthetic stop before Host startup"));
    try {
      await pending;
      await Promise.allSettled(deletions);
      boundary.mock.restore();
    } finally {
      try { await recorder.close(); }
      finally {
        try { await manager.closeAll(); }
        finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      }
    }
  });
  await enteredPromise;
  return { root, project, projects, recorder, manager, boundary, pending, reject, deleting, resolve: () => resolve(dataRoot),
    deleteCalls: () => deleteCalls };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("initializing runtime is unknown, not permission to delete its session", async t => {
  const h = await fixture(t);
  const before = await readFile(h.recorder.filePath);
  const deletion = h.deleting([{ projectId: h.project.id, sessionId: h.recorder.sessionId }]);
  await nextTurn();
  assert.equal(h.deleteCalls(), 0, "pending initialization must settle before destructive work");
  h.reject(new Error("synthetic failed initialization"));
  const result = await deletion;
  assert.deepEqual(result.deleted, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!.error, /synthetic failed initialization/);
  assert.deepEqual(await readFile(h.recorder.filePath), before);
  h.recorder.record({ type: "assistant_message", content: "later retained output" });
  await h.recorder.flush();
  const contents = await readFile(h.recorder.filePath, "utf8");
  assert.match(contents, /keep existing task history/);
  assert.match(contents, /later retained output/);
});

test("a rejected initialization does not permanently block a later explicit deletion", async t => {
  const h = await fixture(t);
  const target = { projectId: h.project.id, sessionId: h.recorder.sessionId };
  const deletion = h.deleting([target]);
  await nextTurn();
  assert.equal(h.deleteCalls(), 0);
  h.reject(new Error("synthetic failed initialization"));
  assert.equal((await deletion).failures.length, 1);
  await h.pending;
  h.boundary.mock.restore();
  await h.recorder.close();
  const result = await h.deleting([target]);
  assert.deepEqual(result.deleted, [target]);
  assert.deepEqual(result.failures, []);
  await assert.rejects(stat(h.recorder.filePath), { code: "ENOENT" });
});

test("batch deletion preserves pending project's history and still deletes unrelated idle history", async t => {
  const h = await fixture(t);
  const otherRoot = path.join(h.root, "other");
  await mkdir(otherRoot);
  const other = await h.projects.createProject(otherRoot);
  const recorder = new SessionRecorder(await h.projects.dataRoot(other), "idle-history");
  recorder.record({ type: "user_message", content: "explicit deletion target" });
  await recorder.close();
  const blocked = { projectId: h.project.id, sessionId: h.recorder.sessionId };
  const idle = { projectId: other.id, sessionId: recorder.sessionId };
  const deletion = h.deleting([blocked, idle, blocked]);
  await nextTurn();
  assert.equal(h.deleteCalls(), 0);
  h.reject(new Error("synthetic failed initialization"));
  const result = await deletion;
  assert.deepEqual(result.deleted, [idle]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]!.sessionId, blocked.sessionId);
  assert.match(await readFile(h.recorder.filePath, "utf8"), /keep existing task history/);
  await assert.rejects(stat(recorder.filePath), { code: "ENOENT" });
});
test("deletion resumes normally after an existing passive initialization finds no Host", async t => {
  // toolCatalog's allowSpawn=false path does not start a Host or bind a socket.
  const h = await fixture(t, true);
  await h.recorder.close();
  const target = { projectId: h.project.id, sessionId: h.recorder.sessionId };
  const deletion = h.deleting([target]);
  await nextTurn();
  assert.equal(h.deleteCalls(), 0);
  h.resolve();
  assert.equal(await h.pending, "completed");
  const result = await deletion;
  assert.deepEqual(result.deleted, [target]);
  assert.deepEqual(result.failures, []);
  await assert.rejects(stat(h.recorder.filePath), { code: "ENOENT" });
});
