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
for (const mode of ['explicit-cas', 'explicit-unconditional', 'scheduled-before-admission', 'scheduled-after-admission'] as const) {
    test(`observed recovery read contract: ${mode}`, { timeout: 10000 }, async (t) => {
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
        t.after(async () => { gate.resolve(); finishRead.resolve(); await resources.recovery?.catch(() => undefined); await resources.recorder?.close(); await resources.manager?.closeAll(); t.mock.restoreAll(); if (old === undefined)
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
            if (mode === 'scheduled-before-admission') {
                readReady.resolve();
                await finishRead.promise;
            }
            return document;
        });
        let guarded = false;
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
            if (payload.sessionId === recorder.sessionId && payload.unread === true && !guarded) {
                guarded = true;
                admitted.resolve();
                await gate.promise;
            }
            return rename(source, target);
        });
        let receive!: (update: AgentRuntimeUpdate) => void;
        const stop = adapter.wireRuntimeEvents(project.id, {
            subscribeAllRuntimeEvents(callback: typeof receive) { receive = callback; return () => { }; },
            runtimeSnapshots: () => [], releaseSessionClaim: async () => { throw new Error('No terminal delivered'); }
        } as unknown as RuntimeHostClient);
        t.after(stop);
        const snapshot: AgentRuntimeUpdate['snapshot'] = { revision: 1, permissionMode: 'ask', state: { kind: 'runs', activeRun: { sessionId: recorder.sessionId, runId: 'observed-run', messageId: 'user', input: 'Synthetic', status: 'running', startedAt: '2026-11-13T00:00:00Z' } }, info: { sessionId: recorder.sessionId, workspaceRoot: project.path, sessionFile: recorder.filePath, provider: 'synthetic', modelLabel: 'Synthetic', reasoningLabel: 'Off', modelAlias: 'synthetic', thinking: 'off' } };
        const other = await projects.createEmptyProject(path.join(root, 'other'));
        await state.commitSelection(other.id, undefined, 'chat');
        receive({ snapshot });
        receive({ snapshot: { ...snapshot, revision: 2, state: { kind: 'idle' } } });
        resources.recovery = Promise.all([...adapter.sessionUnreadRecoveries]);
        if (mode === 'scheduled-before-admission') {
            await readReady.promise;
            adapter.scheduleSessionRead(project, recorder.sessionId, revision);
            finishRead.resolve();
            await resources.recovery;
            assert.equal(guarded, false, 'read admission retires recovery before any true write');
            assert.equal(reads.length, 1, 'same-generation cached false remains sufficient');
        }
        else {
            await admitted.promise;
            if (mode === 'scheduled-after-admission') {
                adapter.scheduleSessionRead(project, recorder.sessionId, revision);
                gate.resolve();
                await resources.recovery;
                await Promise.all([...adapter.sessionMetadataTails.values()]);
                await Promise.all(reads);
                assert.equal(reads.length, 2, 'new publication generation retires the old 30-second false cache');
                const pinned = await manager.pinSession(project.id, recorder.sessionId, true, revision);
                assert.equal(pinned.metadata.pinned, true, 'the read receipt still rebases an immediate metadata edit');
            }
            else {
                const result = manager.markSessionRead(project.id, recorder.sessionId, mode === 'explicit-cas' ? revision : undefined)
                    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
                gate.resolve();
                await resources.recovery;
                const outcome = await result;
                if (mode === 'explicit-cas') {
                    assert.equal(outcome.ok, false, 'stale CAS reports failure instead of claiming an applied read');
                    if (outcome.ok)
                        throw new Error('Expected conflict');
                    assert.equal(outcome.error.name, 'SessionCatalogConflictError');
                    const current = await readSessionCatalogRecord(dataRoot, recorder.sessionId);
                    assert.ok(current);
                    assert.equal(current.unread, true);
                    const retry = await manager.markSessionRead(project.id, recorder.sessionId, sessionCatalogRecordRevision(current));
                    assert.equal(retry.metadata.unread, false, 'fresh-revision retry succeeds without weakening CAS');
                    assert.equal(reads.length, 3);
                }
                else {
                    assert.equal(outcome.ok, true, 'unconditional explicit read follows the admitted recovery');
                    assert.equal(outcome.value.metadata.unread, false);
                    assert.equal(reads.length, 2);
                }
            }
        }
        assert.equal((await readSessionCatalogRecord(dataRoot, recorder.sessionId))?.unread === true, false);
    });
}
