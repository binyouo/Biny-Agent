/** Real observed-recovery/read ordering contracts; private scheduling adapter never starts a Host. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFileConfigStore } from '../src/config/store.js';
import { DesktopAgentManager } from '../src/desktop/electron/main/DesktopAgentManager.js';
import { DesktopProjectService } from '../src/desktop/electron/main/DesktopProjectService.js';
import { DesktopStateStore } from '../src/desktop/electron/main/DesktopStateStore.js';
import { DesktopUserDataStore } from '../src/desktop/electron/main/DesktopUserDataStore.js';
import type { DesktopProject } from '../src/desktop/protocol.js';
import { readSessionCatalogRecord, sessionCatalogRecordRevision } from '../src/session/catalog.js';
import type { AgentRuntimeUpdate } from '../src/runtime/agentEvents.js';
import type { RuntimeHostClient } from '../src/runtime/host/client.js';
import { SessionRecorder } from '../src/session/recorder.js';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
for (const mode of ['new-run', 'terminal', 'unsubscribe', 'dispose', 'recreate', 'write-failure', 'close-drain'] as const) {
    test(`observed recovery lifecycle: ${mode}`, { timeout: 10000 }, async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'biny-read-dedupe-'));
        const old = process.env.BINY_AGENT_DIR;
        process.env.BINY_AGENT_DIR = path.join(root, 'agent');
        const resources: {
            manager?: DesktopAgentManager;
            recorder?: SessionRecorder;
            recovery?: Promise<unknown>;
        } = {};
        const gate = deferred();
        const admitted = deferred();
        const readReady = deferred();
        const finishRead = deferred();
        const falseReached = deferred();
        const finishFalse = deferred();
        t.after(async () => { gate.resolve(); finishRead.resolve(); finishFalse.resolve(); await resources.recovery?.catch(() => undefined); await resources.recorder?.close(); await resources.manager?.closeAll(); t.mock.restoreAll(); if (old === undefined)
            delete process.env.BINY_AGENT_DIR;
        else
            process.env.BINY_AGENT_DIR = old; await fs.rm(root, { recursive: true, force: true }); });
        const state = new DesktopStateStore(path.join(root, 'state.json'));
        await state.load();
        const storage = new DesktopUserDataStore(path.join(root, 'data'));
        await storage.initialize();
        const config = createFileConfigStore(root, { globalDir: path.join(root, 'config') });
        const projects = new DesktopProjectService(state, storage, config);
        const project = await projects.createEmptyProject(path.join(root, 'project'));
        const dataRoot = await projects.dataRoot(project);
        const recorder = resources.recorder = new SessionRecorder(dataRoot, 'session');
        recorder.record({ type: 'user_message', content: 'Synthetic' });
        recorder.recordWithRuntimeContext({ type: 'turn_status', status: 'completed', stopReason: 'completed', steps: 1, resumable: false }, { runId: 'observed-run', turnId: 'observed-turn' });
        await recorder.close();
        resources.recorder = undefined;
        await projects.updateSessionMetadata(project, recorder.sessionId, { unread: false });
        const initial = await readSessionCatalogRecord(dataRoot, recorder.sessionId);
        assert.ok(initial);
        const revision = sessionCatalogRecordRevision(initial);
        const reads: ReturnType<DesktopProjectService['markSessionRead']>[] = [];
        const mark = projects.markSessionRead.bind(projects);
        t.mock.method(projects, 'markSessionRead', (...args: Parameters<typeof mark>) => { const pending = mark(...args); reads.push(pending); return pending; });
        const manager = resources.manager = new DesktopAgentManager(state, projects, config, () => { });
        const adapter = manager as unknown as {
            scheduleSessionRead(project: DesktopProject, sessionId: string, revision: string): void;
            wireRuntimeEvents(projectId: string, runtime: RuntimeHostClient): () => void;
            sessionUnreadRecoveries: Set<Promise<void>>;
            sessionMetadataTails: Map<string, Promise<unknown>>;
        };
        adapter.scheduleSessionRead(project, recorder.sessionId, revision);
        await Promise.all(reads);
        assert.equal(reads.length, 1);
        const open = projects.openSession.bind(projects);
        t.mock.method(projects, 'openSession', async (...args: Parameters<typeof open>) => {
            const document = await open(...args);
            if (mode !== 'write-failure' && mode !== 'close-drain') {
                readReady.resolve();
                await finishRead.promise;
            }
            return document;
        });
        let guarded = false;
        let trueWrites = 0;
        const rename = fs.rename.bind(fs);
        t.mock.method(fs, 'rename', async (source: Parameters<typeof rename>[0], target: Parameters<typeof rename>[1]) => {
            const raw = await fs.readFile(source, 'utf8');
            let payload: {
                sessionId?: string;
                unread?: boolean;
            };
            try {
                payload = JSON.parse(raw);
            }
            catch {
                return rename(source, target);
            }
            if (payload.sessionId === recorder.sessionId && payload.unread === true) {
                trueWrites++;
                if (!guarded && (mode === 'write-failure' || mode === 'close-drain')) {
                    guarded = true;
                    admitted.resolve();
                    await gate.promise;
                    if (mode === 'write-failure')
                        throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
                }
            }
            if (payload.sessionId === recorder.sessionId && payload.unread === false && mode === 'close-drain') {
                falseReached.resolve();
                await finishFalse.promise;
            }
            return rename(source, target);
        });
        let receive!: (update: AgentRuntimeUpdate) => void;
        const stop = adapter.wireRuntimeEvents(project.id, {
            subscribeAllRuntimeEvents(callback: typeof receive) { receive = callback; return () => { }; },
            runtimeSnapshots: () => [], releaseSessionClaim: async () => { }
        } as unknown as RuntimeHostClient);
        t.after(stop);
        const snapshot: AgentRuntimeUpdate['snapshot'] = { revision: 1, permissionMode: 'ask', state: { kind: 'runs', activeRun: { sessionId: recorder.sessionId, runId: 'observed-run', messageId: 'user', input: 'Synthetic', status: 'running', startedAt: '2026-11-13T00:00:00Z' } }, info: { sessionId: recorder.sessionId, workspaceRoot: project.path, sessionFile: recorder.filePath, provider: 'synthetic', modelLabel: 'Synthetic', reasoningLabel: 'Off', modelAlias: 'synthetic', thinking: 'off' } };
        const other = await projects.createEmptyProject(path.join(root, 'other'));
        await state.commitSelection(other.id, undefined, 'chat');
        receive({ snapshot });
        receive({ snapshot: { ...snapshot, revision: 2, state: { kind: 'idle' } } });
        resources.recovery = Promise.all([...adapter.sessionUnreadRecoveries]);
        if (mode !== 'write-failure' && mode !== 'close-drain') {
            await readReady.promise;
            if (mode === 'new-run')
                receive({ snapshot: { ...snapshot, revision: 3, state: { kind: 'runs', activeRun: { sessionId: recorder.sessionId, runId: 'new-run', messageId: 'next', input: 'Next', status: 'running', startedAt: '2026-11-13T00:01:00Z' } } } });
            else if (mode === 'terminal')
                receive({ snapshot: { ...snapshot, revision: 3, state: { kind: 'idle' } }, event: { type: 'run.completed', sessionId: recorder.sessionId, runId: 'observed-run', timestamp: '2026-11-13T00:01:00Z', durationMs: 1 } });
            else if (mode === 'unsubscribe')
                stop();
            else {
                await manager.disposeProject(project.id);
                if (mode === 'recreate') {
                    const stopReplacement = adapter.wireRuntimeEvents(project.id, {
                        subscribeAllRuntimeEvents() { return () => { }; }, runtimeSnapshots: () => [], releaseSessionClaim: async () => { }
                    } as unknown as RuntimeHostClient);
                    t.after(stopReplacement);
                }
            }
            finishRead.resolve();
            await resources.recovery;
            await Promise.all([...adapter.sessionMetadataTails.values()]);
            assert.equal(trueWrites, mode === 'terminal' ? 1 : 0, 'only an actual terminal may publish, never the retired recovery');
            assert.equal((await readSessionCatalogRecord(dataRoot, recorder.sessionId))?.unread === true, mode === 'terminal');
        }
        else {
            await admitted.promise;
            adapter.scheduleSessionRead(project, recorder.sessionId, revision);
            gate.resolve();
            await resources.recovery;
            if (mode === 'close-drain') {
                await falseReached.promise;
                let closed = false;
                const closing = manager.closeAll().then(() => { closed = true; });
                await Promise.resolve();
                await Promise.resolve();
                assert.equal(closed, false, 'close must await admitted read publication');
                finishFalse.resolve();
                await closing;
                assert.equal(closed, true);
            }
            else {
                await Promise.all([...adapter.sessionMetadataTails.values()]);
            }
            await Promise.all(reads);
            assert.equal(reads.length, 2, 'recovery failure or completion cannot prevent the subsequent read');
            assert.equal((await readSessionCatalogRecord(dataRoot, recorder.sessionId))?.unread === true, false);
        }
    });
}

for (const stage of ["terminal-queued", "recovery-queued", "recovery-reading"] as const) {
    test(`close drains admitted unread publication: ${stage}`, { timeout: 10_000 }, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-unread-close-"));
        const old = process.env.BINY_AGENT_DIR;
        process.env.BINY_AGENT_DIR = path.join(root, "agent");
        const releaseWrite = deferred();
        const writeReached = deferred();
        const releaseRead = deferred();
        const readReached = deferred();
        const queued = deferred();
        const resources: { manager?: DesktopAgentManager; recorder?: SessionRecorder; stop?: () => void } = {};
        t.after(async () => {
            releaseWrite.resolve(); releaseRead.resolve();
            await resources.recorder?.close();
            await resources.manager?.closeAll();
            resources.stop?.(); t.mock.restoreAll();
            if (old === undefined) delete process.env.BINY_AGENT_DIR;
            else process.env.BINY_AGENT_DIR = old;
            await fs.rm(root, { recursive: true, force: true });
        });
        const state = new DesktopStateStore(path.join(root, "state.json"));
        await state.load();
        const storage = new DesktopUserDataStore(path.join(root, "data"));
        await storage.initialize();
        const config = createFileConfigStore(root, { globalDir: path.join(root, "config") });
        const projects = new DesktopProjectService(state, storage, config);
        const project = await projects.createEmptyProject(path.join(root, "project"));
        const other = await projects.createEmptyProject(path.join(root, "other"));
        await state.commitSelection(other.id, undefined, "chat");
        const dataRoot = await projects.dataRoot(project);
        const recorder = resources.recorder = new SessionRecorder(dataRoot, "session");
        recorder.record({ type: "user_message", content: "Synthetic" });
        recorder.recordWithRuntimeContext({ type: "turn_status", status: "completed", stopReason: "completed", steps: 1, resumable: false }, { runId: "observed", turnId: "turn" });
        await recorder.close(); resources.recorder = undefined;
        await projects.updateSessionMetadata(project, recorder.sessionId, { unread: false });
        const manager = resources.manager = new DesktopAgentManager(state, projects, config, () => {});
        const adapter = manager as unknown as {
            wireRuntimeEvents(projectId: string, runtime: RuntimeHostClient): () => void;
            queueSessionMetadata<T>(key: string, operation: () => Promise<T>): Promise<T>;
        };
        const originalQueue = adapter.queueSessionMetadata.bind(adapter);
        let queueCalls = 0;
        t.mock.method(adapter, "queueSessionMetadata", <T>(key: string, operation: () => Promise<T>): Promise<T> => {
            const result = originalQueue(key, operation);
            if (++queueCalls === 2) queued.resolve();
            return result;
        });
        const rename = fs.rename.bind(fs);
        let held = false;
        t.mock.method(fs, "rename", async (source: Parameters<typeof rename>[0], target: Parameters<typeof rename>[1]) => {
            const raw = await fs.readFile(source, "utf8");
            let payload: { sessionId?: string; title?: string };
            try { payload = JSON.parse(raw); } catch { return rename(source, target); }
            if (!held && payload.sessionId === recorder.sessionId && payload.title === "Held predecessor") {
                held = true; writeReached.resolve(); await releaseWrite.promise;
            }
            return rename(source, target);
        });
        const open = projects.openSession.bind(projects);
        t.mock.method(projects, "openSession", async (...args: Parameters<typeof open>) => {
            const document = await open(...args);
            if (stage === "recovery-reading") { readReached.resolve(); await releaseRead.promise; }
            return document;
        });
        let receive!: (update: AgentRuntimeUpdate) => void;
        resources.stop = adapter.wireRuntimeEvents(project.id, {
            subscribeAllRuntimeEvents(callback: typeof receive) { receive = callback; return () => {}; },
            runtimeSnapshots: () => [], releaseSessionClaim: async () => {}
        } as unknown as RuntimeHostClient);
        const snapshot: AgentRuntimeUpdate["snapshot"] = {
            revision: 1, permissionMode: "ask", state: { kind: "runs", activeRun: { sessionId: recorder.sessionId, runId: "observed", messageId: "user", input: "Synthetic", status: "running", startedAt: "2026-11-13T00:00:00Z" } },
            info: { sessionId: recorder.sessionId, workspaceRoot: project.path, sessionFile: recorder.filePath, provider: "synthetic", modelLabel: "Synthetic", reasoningLabel: "Off", modelAlias: "synthetic", thinking: "off" }
        };
        const predecessor = adapter.queueSessionMetadata(`${project.id}\0${recorder.sessionId}`, async () =>
            await projects.updateSessionMetadata(project, recorder.sessionId, { title: "Held predecessor" }));
        await writeReached.promise;
        receive({ snapshot });
        receive({ snapshot: { ...snapshot, revision: 2, state: { kind: "idle" } },
            ...(stage === "terminal-queued" ? { event: { type: "run.completed" as const, sessionId: recorder.sessionId, runId: "observed", timestamp: "2026-11-13T00:01:00Z", durationMs: 1 } } : {}) });
        await (stage === "recovery-reading" ? readReached.promise : queued.promise);
        let closed = false;
        const closing = manager.closeAll().then(() => { closed = true; });
        await Promise.resolve(); await Promise.resolve();
        assert.equal(closed, false, "close cannot finish while admitted metadata is pending");
        releaseRead.resolve(); releaseWrite.resolve();
        await predecessor; await closing;
        const record = await readSessionCatalogRecord(dataRoot, recorder.sessionId);
        assert.equal(record?.title, "Held predecessor");
        assert.equal(record?.unread === true, stage !== "recovery-reading",
            "queued work drains; evidence still being read at shutdown cannot admit new publication");
        assert.equal(queueCalls, stage === "recovery-reading" ? 1 : 2);
    });
}
