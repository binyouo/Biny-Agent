/** Production subscription/cache and real JSONL; inert transport, never starts a Host. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { AgentHostEvent, AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";

for (const idle of [true, false]) {
  test(`snapshot-only ${idle ? "idle restores persisted answer" : "running retains live answer"}`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-gap-cache-"));
    const old = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "global");
    const resources: { manager?: DesktopAgentManager; recorder?: SessionRecorder; unsubscribe?: () => void } = {};
    t.after(async () => {
      resources.unsubscribe?.();
      await resources.recorder?.close();
      await resources.manager?.closeAll();
      if (old === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = old;
      await rm(root, { recursive: true, force: true });
    });
    const state = new DesktopStateStore(path.join(root, "state.json"));
    await state.load();
    const storage = new DesktopUserDataStore(path.join(root, "data"));
    await storage.initialize();
    const config = createFileConfigStore(root, { globalDir: path.join(root, "config") });
    const projects = new DesktopProjectService(state, storage, config);
    const project = await projects.createEmptyProject(path.join(root, "project"));
    const dataRoot = await projects.dataRoot(project);
    const recorder = resources.recorder = new SessionRecorder(dataRoot, "synthetic-session");
    const user = recorder.record({ type: "user_message", content: "Synthetic question" });
    assert.equal(user.type, "user_message");
    if (user.type !== "user_message") throw new Error("Expected user message");
    let receive!: (update: AgentRuntimeUpdate) => void;
    const manager = resources.manager = new DesktopAgentManager(state, projects, config, () => {});
    const adapter = manager as unknown as {
      wireRuntimeEvents(projectId: string, runtime: RuntimeHostClient): () => void;
      projectEvents(projectId: string): Map<string, AgentHostEvent[]>;
    };
    const transport = {
      subscribeAllRuntimeEvents(listener: typeof receive) { receive = listener; return () => {}; },
      runtimeSnapshots: () => [],
      releaseSessionClaim: async () => { throw new Error("No terminal event delivered"); }
    };
    resources.unsubscribe = adapter.wireRuntimeEvents(project.id, transport as unknown as RuntimeHostClient);
    const snapshot: AgentRuntimeUpdate["snapshot"] = {
      revision: 1, permissionMode: "ask", state: { kind: "runs", activeRun: { sessionId: recorder.sessionId, runId: "run", messageId: user.messageId!, input: "Synthetic question", status: "running", startedAt: "2026-11-13T00:00:00.000Z" } },
      info: { sessionId: recorder.sessionId, workspaceRoot: project.path, sessionFile: recorder.filePath,
        provider: "synthetic", modelLabel: "Synthetic", reasoningLabel: "Off", modelAlias: "synthetic", thinking: "off" }
    };
    const base = { sessionId: recorder.sessionId, runId: "run", timestamp: "2026-11-13T00:00:00.000Z" };
    receive({ snapshot, event: { ...base, type: "message.user", messageId: user.messageId!, content: "Synthetic question" } });
    receive({ snapshot, event: { ...base, type: "assistant.delta", content: "Partial before disconnect" } });
    recorder.record({ type: "assistant_message", content: "Complete persisted answer" });
    recorder.record({ type: "turn_status", status: "completed", stopReason: "completed", steps: 1, summary: "Done", resumable: false });
    await recorder.close();
    resources.recorder = undefined;
    receive({ snapshot: { ...snapshot, info: { ...snapshot.info, sessionId: "other-session" } },
      event: { ...base, sessionId: "other-session", type: "assistant.delta", content: "Other session stream" } });
    const otherEvents = adapter.projectEvents(project.id).get("other-session");
    const read = () => projects.openSession(project, recorder.sessionId, undefined, adapter.projectEvents(project.id));
    const before = await read();
    assert.equal(buildSessionTimeline(before.events, before.liveEvents).at(-1)?.assistant, "Partial before disconnect");
    const canonical = await projects.openSession(project, recorder.sessionId, undefined, new Map());
    assert.equal(buildSessionTimeline(canonical.events, []).at(-1)?.assistant, "Complete persisted answer");
    receive({ snapshot: { ...snapshot, revision: 2, state: idle ? { kind: "idle" } : snapshot.state } });
    const restored = await read();
    assert.equal(buildSessionTimeline(restored.events, restored.liveEvents).at(-1)?.assistant,
      idle ? "Complete persisted answer" : "Partial before disconnect");
    assert.equal(restored.liveEvents.length, idle ? 0 : 2);
    assert.equal(adapter.projectEvents(project.id).get("other-session"), otherEvents);
    receive({ snapshot: { ...snapshot, revision: 3 }, event: { ...base, runId: "next-run", type: "assistant.delta", content: "Next run output" } });
    assert.equal(adapter.projectEvents(project.id).get(recorder.sessionId)?.at(-1)?.runId, "next-run");
    assert.deepEqual(restored.events, canonical.events, "recovery must never rewrite JSONL history");
  });
}
