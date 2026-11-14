/** Real selection/catalog persistence; only Runtime transport is inert. No Host, sockets or model. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { AgentHostEvent, AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";
import { readSessionCatalogRecord } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";

const modes = ["current-session", "same-project-other-session", "other-project"] as const;
type Selection = typeof modes[number];
type Terminal = "run.completed" | "run.failed" | "run.cancelled" | "run.blocked" | "run.incomplete" | "run.aborted";

function eventFor(type: Terminal | "message.user", sessionId: string): AgentHostEvent {
  const base = { sessionId, runId: "synthetic-run", timestamp: "2026-11-13T00:00:00.000Z" };
  switch (type) {
    case "run.completed": return { ...base, type, durationMs: 1 };
    case "run.incomplete": return { ...base, type, durationMs: 1, reason: "synthetic incomplete", stopReason: "missing_terminal_event", steps: 1 };
    case "run.aborted": return { ...base, type, durationMs: 1, reason: "synthetic legacy abort" };
    case "run.failed": return { ...base, type, durationMs: 1, error: "synthetic failure" };
    case "run.cancelled": return { ...base, type, durationMs: 1, reason: "synthetic cancellation" };
    case "run.blocked": return { ...base, type, durationMs: 1, reason: "permission_denied", summary: "synthetic block" };
    case "message.user": return { ...base, type, messageId: "synthetic-message", content: "synthetic input" };
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-background-unread-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const resources: { manager?: DesktopAgentManager; recorder?: SessionRecorder; unsubscribe?: () => void } = {};
  const writes: Array<ReturnType<DesktopProjectService["updateSessionMetadata"]>> = [];
  t.after(async () => {
    resources.unsubscribe?.();
    try {
      await Promise.allSettled(writes);
      await resources.recorder?.close();
      await resources.manager?.closeAll();
    } finally {
      t.mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await storage.initialize();
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  const projects = new DesktopProjectService(state, storage, configStore);
  const a = await projects.createEmptyProject(path.join(root, "a"));
  const b = await projects.createEmptyProject(path.join(root, "b"));
  const recorder = resources.recorder = new SessionRecorder(a.path, "session-a");
  recorder.record({ type: "user_message", content: "Synthetic task in project A" });
  await recorder.close();
  resources.recorder = undefined;
  const sessionId = recorder.sessionId;
  await projects.updateSessionMetadata(a, sessionId, { unread: false, pinned: true, title: "Keep title" });
  const before = await readSessionCatalogRecord(a.path, sessionId);
  assert.ok(before);
  const originalUpdate = projects.updateSessionMetadata.bind(projects);
  t.mock.method(projects, "updateSessionMetadata", (...args: Parameters<DesktopProjectService["updateSessionMetadata"]>) => {
    const completion = originalUpdate(...args);
    writes.push(completion);
    return completion;
  });
  let listener: ((update: AgentRuntimeUpdate) => void) | undefined;
  const released: string[] = [];
  const emitted: AgentRuntimeUpdate[] = [];
  // Register through the production wire method. Do not install a fake resident runtime
  // or initialize one: these three methods are precisely the event transport boundary.
  const transport = {
    subscribeAllRuntimeEvents(callback: (update: AgentRuntimeUpdate) => void) {
      listener = callback;
      return () => { listener = undefined; };
    },
    runtimeSnapshots: () => [],
    async releaseSessionClaim(id: string) { released.push(id); }
  };
  const manager = resources.manager = new DesktopAgentManager(state, projects, configStore, (_projectId, update) => emitted.push(update));
  const registration = manager as unknown as { wireRuntimeEvents(projectId: string, runtime: RuntimeHostClient): () => void };
  resources.unsubscribe = registration.wireRuntimeEvents(a.id, transport as unknown as RuntimeHostClient);
  return {
    async select(mode: Selection) {
      // Same public persistence operation used by desktop:selection:commit after navigation.
      await state.commitSelection(a.id, sessionId, "chat");
      if (mode === "same-project-other-session") await state.commitSelection(a.id, "other-session", "chat");
      if (mode === "other-project") await state.commitSelection(b.id, "session-b", "chat");
      assert.equal(state.activeProjectId(), mode === "other-project" ? b.id : a.id);
      assert.equal(state.selectedSessionId(a.id), mode === "same-project-other-session" ? "other-session" : sessionId);
    },
    async deliver(type: Terminal | "message.user") {
      assert.ok(listener);
      const update: AgentRuntimeUpdate = {
        event: eventFor(type, sessionId),
        snapshot: {
          revision: 1, permissionMode: "ask", state: { kind: "idle" },
          info: {
            sessionId, workspaceRoot: a.path, sessionFile: path.join(a.path, "synthetic-session.jsonl"),
            provider: "synthetic", modelLabel: "Synthetic", reasoningLabel: "Off", modelAlias: "synthetic",
            thinking: "off"
          }
        }
      };
      listener(update);
      await Promise.all(writes);
      assert.deepEqual(emitted, [update], "event broadcasting must remain unchanged");
      return await readSessionCatalogRecord(a.path, sessionId);
    },
    before, released, writes, sessionId
  };
}

for (const terminal of ["run.completed", "run.failed", "run.cancelled", "run.blocked", "run.incomplete", "run.aborted"] as const) {
  for (const mode of modes) {
    test(`${terminal}: ${mode} keeps unread ownership separate from claim release`, async t => {
      const f = await fixture(t);
      await f.select(mode);
      const record = await f.deliver(terminal);
      assert.ok(record);
      assert.equal(record.unread === true, mode !== "current-session", "background project completion must remain unread even when its session is remembered");
      assert.equal(f.writes.length, mode === "current-session" ? 0 : 1);
      assert.deepEqual(f.released, mode === "same-project-other-session" ? [f.sessionId] : [], "preserve the existing remembered-session claim policy");
      assert.equal(record.pinned, f.before.pinned);
      assert.equal(record.title, f.before.title);
    });
  }
}

for (const mode of modes) {
  test(`nonterminal input: ${mode} does not mark unread or release claims`, async t => {
    const f = await fixture(t);
    await f.select(mode);
    const record = await f.deliver("message.user");
    assert.deepEqual(record, f.before);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.released, []);
  });
}
