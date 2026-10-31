import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkerSession } from '../src/runtime/WorkerSession.js';
import type { AgentUsage, AgentAssistantMessage } from '../src/agent/core/types.js';
const billed = { inputTokens: 100000, outputTokens: 10, totalTokens: 100010 };
const other = { inputTokens: 200, outputTokens: 5, totalTokens: 205 };
async function fixture(run: (get: () => WorkerSession, reopen: (rewrite?: (session: WorkerSession) => Promise<void>) => Promise<void>) => Promise<void>) {
    const root = await mkdtemp(path.join(tmpdir(), 'biny-worker-usage-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const execution = { taskId: 'usage-recovery', persistenceRoot: workspace };
    let session: WorkerSession | undefined;
    try {
        session = await WorkerSession.open(execution, 'task', workspace, {}, 'system');
        const reopen = async (rewrite?: (session: WorkerSession) => Promise<void>) => { await session!.close(); await rewrite?.(session!); session = await WorkerSession.open({ ...execution, resume: true }, 'task', workspace, {}, 'system'); };
        await run(() => session!, reopen);
    }
    finally {
        await session?.close();
        await rm(root, { recursive: true, force: true });
    }
}
async function request(s: WorkerSession, id: string, usage?: AgentUsage) {
    await s.beforeRequest(20);
    await s.recordModelRequest({ requestId: id, provider: 'test', modelId: 'test', startedAt: new Date().toISOString(), durationMs: 1, attempts: [], eventCount: 1, usage });
}
async function step(s: WorkerSession, id: string, usage?: AgentUsage) {
    const message: AgentAssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage };
    await s.persistStep({ requestId: id, message, toolResults: [], context: { messages: [...s.messages, message], tools: [] }, newMessages: [message] });
}
test('resume retains durable request usage before the assistant step commit', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await reopen();
    assert.equal(get().startedSteps, 1);
    assert.deepEqual(get().usages, [billed]);
    const replay: AgentUsage[] = [];
    await get().replayModelRequestUsage(m => { if (m.usage)
        replay.push(m.usage); });
    assert.deepEqual(replay, [billed]);
    await reopen();
    assert.deepEqual(get().usages, [billed]);
}));
test('a request and its committed assistant usage are counted once', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await step(get(), 'one', billed);
    await reopen();
    assert.deepEqual(get().usages, [billed]);
}));
test('durable request usage is authoritative over assistant summary usage', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await step(get(), 'one', other);
    await reopen();
    assert.deepEqual(get().usages, [billed]);
}));
test('assistant usage remains a fallback when no request metrics exist', async () => fixture(async (get, reopen) => {
    await get().beforeRequest(20);
    await step(get(), 'one', other);
    await reopen();
    assert.deepEqual(get().usages, [other]);
}));
test('request metrics without usage do not erase the assistant fallback', async () => fixture(async (get, reopen) => {
    await request(get(), 'one');
    await step(get(), 'one', other);
    await reopen();
    assert.deepEqual(get().usages, [other]);
}));
test('usage from interrupted invocation and later fallback step both survive', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await reopen();
    await get().beforeRequest(20);
    await step(get(), 'two', other);
    await reopen();
    assert.deepEqual(get().usages, [billed, other]);
}));
test('earlier assistant-only history is retained beside later request usage', async () => fixture(async (get, reopen) => {
    await get().beforeRequest(20);
    await step(get(), 'one', other);
    await request(get(), 'two', billed);
    await reopen();
    assert.deepEqual(get().usages, [other, billed]);
}));
async function legacyAssistantMetadata(session: WorkerSession) {
    const text = await readFile(session.recorder.filePath, 'utf8');
    const lines = text.trimEnd().split('\n').map(line => {
        const event = JSON.parse(line);
        if (event.type === 'agent_message' && event.metadata)
            delete event.metadata.workerRequestId;
        return JSON.stringify(event);
    });
    await writeFile(session.recorder.filePath, lines.join('\n') + '\n');
}
test('legacy same-run request and assistant summaries are not double billed', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await step(get(), 'one', billed);
    await reopen(legacyAssistantMetadata);
    assert.deepEqual(get().usages, [billed]);
}));
test('legacy same-run consecutive steps retain request cost and missing-metrics fallback', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await step(get(), 'one', other);
    await get().beforeRequest(20);
    await step(get(), 'two', other);
    await reopen(legacyAssistantMetadata);
    assert.deepEqual(get().usages, [billed, other]);
}));
test('legacy orphan usage does not suppress a new invocation fallback', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await reopen();
    await get().beforeRequest(20);
    await step(get(), 'two', other);
    await reopen(legacyAssistantMetadata);
    assert.deepEqual(get().usages, [billed, other]);
}));
test('legacy usage-less metrics do not suppress a later fallback step', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await step(get(), 'one', billed);
    await request(get(), 'two');
    await step(get(), 'two', other);
    await reopen(legacyAssistantMetadata);
    assert.deepEqual(get().usages, [billed, other]);
}));
test('explicit request identity preserves an unmatched assistant fallback', async () => fixture(async (get, reopen) => {
    await request(get(), 'one', billed);
    await step(get(), 'different', other);
    await reopen();
    assert.deepEqual(get().usages, [billed, other]);
}));
test('zero-token request usage remains authoritative without duplicate fallback', async () => fixture(async (get, reopen) => {
    const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    await request(get(), 'one', zero);
    await step(get(), 'one', other);
    await reopen();
    assert.deepEqual(get().usages, [zero]);
}));

test("committed assistant facts retain the provider request identity", async () => fixture(async (get) => {
    await request(get(), "request-identity", billed);
    await step(get(), "request-identity", billed);
    const events = (await readFile(get().recorder.filePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    const assistant = events.find(event => event.type === "agent_message" && event.message.role === "assistant");
    assert.equal(assistant?.metadata?.workerRequestId, "request-identity");
}));
test("legacy usage facts without run identity are conservatively retained, not inferred duplicates", async () => fixture(async (get, reopen) => {
    await request(get(), "one", billed);
    await step(get(), "one", billed);
    await get().complete("done");
    await reopen(async session => {
        await legacyAssistantMetadata(session);
        const events = (await readFile(session.recorder.filePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
        for (const event of events) {
            if (event.type === "model_request" || event.type === "agent_message") delete event.runtime.runId;
        }
        await writeFile(session.recorder.filePath, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    });
    assert.equal(get().output, "done");
    assert.deepEqual(get().usages, [billed, billed]);
}));
