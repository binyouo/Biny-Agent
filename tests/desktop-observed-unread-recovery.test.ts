/** Production subscription/cache and real JSONL; inert transport, never starts a Host. */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
import { readSessionCatalogRecord } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
for (const status of ["completed", "incomplete", "blocked", "cancelled", "failed", "aborted"] as const) {
    for (const mode of ["foreground", "background-remembered", "background-other"] as const) {
        for (const terminal of [false, true]) {
            if (terminal && status !== "completed")
                continue;
            const idle = true;
            test(`observed recovery ${status} ${mode}: terminal ${terminal ? "delivered" : "omitted"} then idle snapshot`, async (t) => {
                const root = await mkdtemp(path.join(os.tmpdir(), "biny-gap-cache-"));
                const old = process.env.BINY_AGENT_DIR;
                process.env.BINY_AGENT_DIR = path.join(root, "global");
                const resources: {
                    manager?: DesktopAgentManager;
                    recorder?: SessionRecorder;
                    unsubscribe?: () => void;
                } = {};
                t.after(async () => {
                    resources.unsubscribe?.();
                    await resources.recorder?.close();
                    await resources.manager?.closeAll();
                    if (old === undefined)
                        delete process.env.BINY_AGENT_DIR;
                    else
                        process.env.BINY_AGENT_DIR = old;
                    await rm(root, { recursive: true, force: true });
                });
                const state = new DesktopStateStore(path.join(root, "state.json"));
                await state.load();
                const storage = new DesktopUserDataStore(path.join(root, "data"));
                await storage.initialize();
                const config = createFileConfigStore(root, { globalDir: path.join(root, "config") });
                const projects = new DesktopProjectService(state, storage, config);
                const project = await projects.createEmptyProject(path.join(root, "project"));
                const other = await projects.createEmptyProject(path.join(root, "other-project"));
                const dataRoot = await projects.dataRoot(project);
                const recorder = resources.recorder = new SessionRecorder(dataRoot, "synthetic-session");
                recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
                const user = recorder.record({ type: "user_message", content: "Synthetic question" });
                assert.equal(user.type, "user_message");
                if (user.type !== "user_message")
                    throw new Error("Expected user message");
                await state.commitSelection(project.id, recorder.sessionId, "chat");
                if (mode === "background-other")
                    await state.commitSelection(project.id, "other-session", "chat");
                if (mode !== "foreground")
                    await state.commitSelection(other.id, "other-project-session", "chat");
                await projects.updateSessionMetadata(project, recorder.sessionId, { unread: false, title: "Retain title", pinned: true });
                const writes: Promise<unknown>[] = [];
                const updateMetadata = projects.updateSessionMetadata.bind(projects);
                t.mock.method(projects, "updateSessionMetadata", (...args: Parameters<typeof updateMetadata>) => {
                    const pending = updateMetadata(...args);
                    writes.push(pending);
                    return pending;
                });
                const released: string[] = [];
                let receive!: (update: AgentRuntimeUpdate) => void;
                const manager = resources.manager = new DesktopAgentManager(state, projects, config, () => { });
                const adapter = manager as unknown as {
                    wireRuntimeEvents(projectId: string, runtime: RuntimeHostClient): () => void;
                    projectEvents(projectId: string): Map<string, AgentHostEvent[]>;
                    sessionUnreadRecoveries: Set<Promise<void>>;
                    sessionMetadataTails: Map<string, Promise<unknown>>;
                };
                const transport = {
                    subscribeAllRuntimeEvents(listener: typeof receive) { receive = listener; return () => { }; },
                    runtimeSnapshots: () => [],
                    releaseSessionClaim: async (id: string) => { released.push(id); }
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
                recorder.record({ type: "turn_status", status, stopReason: status, steps: 1, summary: "Done", resumable: false });
                await recorder.close();
                resources.recorder = undefined;
                const persistedBytes = await readFile(recorder.filePath);
                receive({ snapshot: { ...snapshot, info: { ...snapshot.info, sessionId: "other-session" } },
                    event: { ...base, sessionId: "other-session", type: "assistant.delta", content: "Other session stream" } });
                const otherEvents = adapter.projectEvents(project.id).get("other-session");
                const read = () => projects.openSession(project, recorder.sessionId, undefined, adapter.projectEvents(project.id));
                const before = await read();
                assert.equal(buildSessionTimeline(before.events, before.liveEvents).at(-1)?.assistant, "Partial before disconnect");
                const canonical = await projects.openSession(project, recorder.sessionId, undefined, new Map());
                assert.equal(buildSessionTimeline(canonical.events, []).at(-1)?.assistant, "Complete persisted answer");
                if (terminal)
                    receive({ snapshot: { ...snapshot, revision: 2, state: { kind: "idle" } },
                        event: { ...base, type: "run.completed", durationMs: 1 } });
                receive({ snapshot: { ...snapshot, revision: 3, state: { kind: "idle" } } });
                receive({ snapshot: { ...snapshot, revision: 4, state: { kind: "idle" } } });
                await Promise.allSettled(adapter.sessionUnreadRecoveries ?? []);
                await Promise.allSettled(adapter.sessionMetadataTails?.values() ?? []);
                await Promise.all(writes);
                const catalog = await readSessionCatalogRecord(dataRoot, recorder.sessionId);
                assert.equal(catalog?.unread === true, mode !== "foreground", "matching observed terminal recovers background unread");
                assert.equal(catalog?.title, "Retain title");
                assert.equal(catalog?.pinned, true);
                assert.deepEqual(released, terminal && mode === "background-other" ? [recorder.sessionId] : [], "snapshot-only recovery never releases a claim; delivered terminals retain remembered selection ownership");
                t.diagnostic(JSON.stringify({ mode, terminalDelivered: terminal, unread: catalog?.unread === true, released }));
                const restored = await projects.openSession(project, recorder.sessionId, undefined, new Map());
                assert.equal(buildSessionTimeline(restored.events, restored.liveEvents).at(-1)?.assistant, idle ? "Complete persisted answer" : "Partial before disconnect");
                assert.equal(restored.liveEvents.length, idle ? 0 : 2);
                assert.equal(adapter.projectEvents(project.id).get("other-session"), otherEvents);
                receive({ snapshot: { ...snapshot, revision: 5 }, event: { ...base, runId: "next-run", type: "assistant.delta", content: "Next run output" } });
                assert.equal(adapter.projectEvents(project.id).get(recorder.sessionId)?.at(-1)?.runId, "next-run");
                assert.deepEqual(restored.events, canonical.events, "recovery must never rewrite JSONL history");
                assert.deepEqual(await readFile(recorder.filePath), persistedBytes, "combined recovery leaves persisted JSONL byte-for-byte unchanged");
            });
        }
    }
}
