/** Real canonical session files and SQLite, with a deterministic deferred model; no provider/network. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { projectSessionsDir, workspaceAgentDir } from "../src/config/paths.js";
import { DesktopThreadBriefService } from "../src/desktop/electron/main/DesktopThreadBriefService.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopProject } from "../src/desktop/protocol.js";
import { readSessionEvents } from "../src/session/events.js";
import { activeSessionMessageIds, sessionMessageTree } from "../src/session/messageTree.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs, resolveSessionFile } from "../src/session/store.js";
import { ThreadBriefStore } from "../src/session/threadBriefStore.js";

// Only the model acquisition seam is substituted. readThread, canPersist,
// canonical projection, queueing, generation, and SQLite remain production code.
interface EngineModelSeam { options: { getModel(): Promise<AgentModel | undefined> } }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const quote = "明天我会发布编辑器";
const result = { topic: "Canvas 发布", goal: "上线编辑器", objects: ["Canvas"], conclusions: ["完成检查"],
  followUp: { what: "发布编辑器", quote } };
const time = "2026-09-21T08:00:00.000Z";
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-brief-source-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");

async function fixture(name: string) {
  const directory = path.join(root, name);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await ensureAgentDirs(workspace);
  const state = new DesktopStateStore(path.join(directory, "state.json"));
  await state.load();
  const project: DesktopProject = { id: name, path: workspace, name,
    dirty: false, missing: false, pinned: false, addedAt: time, lastOpenedAt: time };
  await state.upsertProject(project);
  const configStore = { load: async () => defaultConfig, save: async () => undefined };
  const projects = new DesktopProjectService(state, new DesktopUserDataStore(path.join(directory, "desktop")), configStore);
  const store = new ThreadBriefStore(path.join(directory, "briefs"), () => new Date(time));
  const service = new DesktopThreadBriefService({ state, projects, configStore, store, chooseProjectDirectory: async () => undefined });
  await service.initialize();
  service.engine.setConfig({ ...store.config(), enabled: true, autoTodo: true, projectSuggestions: false });
  const recorder = new SessionRecorder(workspace);
  const sessionId = recorder.sessionId;
  try {
    recorder.record({ type: "user_message", messageId: "user", slotId: "user", content: quote, time });
    // Same visible text, distinct canonical identities. An identity-only branch
    // switch must still retire the original generation input.
    for (const messageId of ["answer-a", "answer-b"]) recorder.record({ type: "agent_message", messageId,
      parentMessageId: "user", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "完成检查" }] }, time });
    recorder.record({ type: "message_version_selected", slotId: "answer", messageId: "answer-a", time });
  } finally { await recorder.close(); }
  const file = await resolveSessionFile(workspace, sessionId);
  const gates: Array<{ entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred> }> = [];
  const jobs: Array<Promise<{ error?: unknown }>> = [];
  let calls = 0;
  let acquisitions = 0;
  const prompts: string[] = [];
  const model: AgentModel = { provider: "test", modelId: "deferred-brief", stream: async (context) => {
    const gate = gates[calls++];
    assert.ok(gate, "unexpected extra model invocation");
    prompts.push(JSON.stringify(context.messages));
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      try {
        gate.entered.resolve();
        await gate.release.promise;
        yield { type: "text-delta", text: JSON.stringify(result) };
        yield { type: "finish", reason: "stop" };
      } finally { gate.finished.resolve(); }
    })();
  } };
  (service.engine as unknown as EngineModelSeam).options.getModel = async () => { acquisitions += 1; return model; };
  async function append(...events: SessionEvent[]) {
    const writer = new SessionRecorder(workspace, sessionId, file);
    try { for (const event of events) writer.record({ ...event, time }); }
    finally { await writer.close(); }
  }
  async function activeIds() {
    const events = await readSessionEvents(file);
    return [...activeSessionMessageIds(events, sessionMessageTree(events))].sort();
  }
  function start() {
    const gate = { entered: deferred(), release: deferred(), finished: deferred() };
    gates.push(gate);
    // Observe rejection immediately, including jobs rejected by close().
    const job: Promise<{ error?: unknown }> = service.engine.enqueue(sessionId, true).then(() => ({}), (error: unknown) => ({ error }));
    jobs.push(job);
    return { gate, job };
  }
  async function finish(run: ReturnType<typeof start>) {
    run.gate.release.resolve();
    const outcome = await bounded(run.job, "brief job settlement");
    if (outcome.error !== undefined) throw outcome.error;
    await bounded(run.gate.finished.promise, "fake model settlement");
  }
  async function close() {
    for (const gate of gates) gate.release.resolve();
    await bounded(service.close(), "service close");
    await bounded(Promise.all(jobs), "all queued jobs settle");
    await bounded(Promise.all(gates.slice(0, calls).map((gate) => gate.finished.promise)), "all started fake models settle");
  }
  return { workspace, state, project, store, service, sessionId, file, append, activeIds, start, finish, close,
    calls: () => calls, acquisitions: () => acquisitions, prompts };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function check(name: string, body: (f: Fixture) => Promise<void>) {
  const f = await fixture(name);
  try { await body(f); } finally { await f.close(); }
}
async function entered(run: ReturnType<Fixture["start"]>) { await bounded(run.gate.entered.promise, "model entry"); }

try {
  for (const mutation of ["unchanged", "nonactive"] as const) await check(mutation, async (f) => {
    assert.deepEqual(await f.activeIds(), ["answer-a", "user"]);
    const run = f.start();
    await entered(run);
    if (mutation === "nonactive") await f.append(
      { type: "agent_message", messageId: "answer-c", parentMessageId: "user", slotId: "answer",
        message: { role: "assistant", content: [{ type: "text", text: "非活动版本" }] } },
      { type: "message_metadata", messageId: "answer-a", metadata: { sourceTest: true } },
      { type: "tool_result", tool: "test", result: "diagnostic only" }
    );
    assert.deepEqual(await f.activeIds(), ["answer-a", "user"]);
    await f.finish(run);
    assert.equal(f.calls(), 1);
    assert.equal(f.acquisitions(), 1);
    assert.equal(f.store.brief(f.sessionId)?.brief.topic, result.topic);
    assert.equal(f.store.brief(f.sessionId)?.status, "todo");
    assert.equal(f.store.brief(f.sessionId)?.autoTodo?.quote, quote);
    assert.ok(!f.prompts[0]!.includes("非活动版本"));
    // Existing bounded-material deduplication remains intact.
    await bounded(f.service.engine.enqueue(f.sessionId, true), "unchanged deduplication");
    assert.equal(f.calls(), 1);
  });

  await check("selected-branch", async (f) => {
    const run = f.start();
    await entered(run);
    await f.append({ type: "message_version_selected", slotId: "answer", messageId: "answer-b" });
    assert.deepEqual(await f.activeIds(), ["answer-b", "user"]);
    await f.finish(run);
    assert.equal(f.calls(), 1, "stale generation must not rerun the model");
    assert.equal(f.store.brief(f.sessionId), undefined, "stale generation must not insert a brief or autoTodo");
    assert.equal(f.store.snapshot().lastError, undefined, "freshness rejection is not a model error");
    assert.equal(f.store.suggestions().length, 0);
    // The rejected job has settled and the ordinary queue remains usable.
    const fresh = f.start();
    await entered(fresh);
    await f.finish(fresh);
    assert.equal(f.calls(), 2);
    assert.equal(f.store.brief(f.sessionId)?.brief.topic, result.topic);
  });

  await check("preserve-existing", async (f) => {
    const first = f.start();
    await entered(first);
    await f.finish(first);
    await f.append({ type: "user_message", messageId: "next-user", parentMessageId: "answer-a", slotId: "next-user", content: "继续检查新的发布范围" });
    const run = f.start();
    await entered(run);
    // A real manual status edit while the replacement is in flight.
    await f.service.request({ action: "status", sessionId: f.sessionId, status: "done" });
    const previous = f.store.brief(f.sessionId);
    assert.equal(previous?.statusManual, true);
    assert.ok(previous?.autoTodo);
    await f.append({ type: "message_version_selected", slotId: "answer", messageId: "answer-b" });
    await f.finish(run);
    assert.deepEqual(f.store.brief(f.sessionId), previous, "preserve old brief/hash/timestamps/manual state and existing autoTodo exactly");
    assert.equal(f.calls(), 2);
  });

  for (const mutation of ["delete-session", "remove-project", "mark-missing", "delete-storage", "delete-workspace", "change-project-path"] as const) {
    await check(mutation, async (f) => {
      const run = f.start();
      await entered(run);
      let removedPath: string | undefined;
      if (mutation === "delete-session") { removedPath = f.file; await rm(f.file); }
      else if (mutation === "remove-project") await f.state.removeProject(f.project.id);
      else if (mutation === "mark-missing") await f.state.upsertProject({ ...f.project, missing: true });
      else if (mutation === "change-project-path") {
        const moved = path.join(root, mutation, "replacement");
        await mkdir(moved);
        await f.state.upsertProject({ ...f.project, path: moved });
      } else if (mutation === "delete-workspace") { removedPath = f.workspace; await rm(f.workspace, { recursive: true }); }
      else {
        removedPath = projectSessionsDir(f.workspace);
        await rm(removedPath, { recursive: true });
        await rm(workspaceAgentDir(f.workspace), { recursive: true });
      }
      await f.finish(run);
      assert.equal(f.calls(), 1);
      assert.equal(f.store.brief(f.sessionId), undefined, `${mutation}: no late brief/autoTodo`);
      assert.equal(f.store.snapshot().lastError, undefined);
      if (removedPath) await assert.rejects(stat(removedPath), { code: "ENOENT" }, "freshness check must not recreate removed source storage");
      if (mutation === "delete-storage") await assert.rejects(stat(workspaceAgentDir(f.workspace)), { code: "ENOENT" });
    });
  }

  await check("close-pending", async (f) => {
    const active = f.start();
    await entered(active);
    const queued = f.start();
    // close() aborts the active request and rejects queued work; release the
    // injected producer explicitly so no generator remains suspended.
    const closing = f.service.close();
    active.gate.release.resolve();
    queued.gate.release.resolve();
    await bounded(closing, "close with active and queued jobs");
    assert.ok((await bounded(active.job, "active cancellation")).error);
    assert.ok((await bounded(queued.job, "queued cancellation")).error);
    await bounded(active.gate.finished.promise, "cancelled model settlement");
    assert.equal(f.calls(), 1, "queued job must never invoke model after close");
    await assert.rejects(f.service.engine.enqueue(f.sessionId, true), /已关闭/u);
    const reopened = new ThreadBriefStore(f.store.directory);
    await reopened.open();
    try { assert.equal(reopened.brief(f.sessionId), undefined); }
    finally { reopened.close(); }
  });
  console.log("thread brief source freshness integration tests passed");
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
