/** Completed turns retain an ephemeral Host until their asynchronous memory writes settle. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { BINY_AGENT_DIR_ENV, globalAgentDir, globalConfigDir } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import { AgentMemoryOwner } from "../src/runtime/memory/owner.js";
import { canonicalMemoryRoot, serveMemoryOwner } from "../src/runtime/memory/transport.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionMessageMetadata } from "../src/session/messageTree.js";

const fact = "The user prefers concise release notes with explicit verification results.";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function textResponse(content: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
    "data: [DONE]\n\n"
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Memory retirement fixture did not settle.")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Memory background work did not settle.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-retirement-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  const originalFetch = globalThis.fetch;
  const entered = deferred();
  const release = deferred();
  const calls = { conversation: 0, extraction: 0, reconciliation: 0 };
  const transportFailures: unknown[] = [];
  const resources: { local?: InteractiveAgentHost; host?: RuntimeHostServer; memoryOwner?: Awaited<ReturnType<typeof serveMemoryOwner>> } = {};
  const close = async () => {
    release.resolve();
    try {
      if (resources.host) await resources.host.close();
      else await resources.local?.runtime.close();
    } finally {
      await resources.memoryOwner?.close();
      globalThis.fetch = originalFetch;
      if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
    globalThis.fetch = async (url, init) => {
      try {
        const endpoint = String(url);
        assert.match(endpoint, /^https:\/\/memory-retirement\.invalid\/v1\/(chat\/completions|embeddings)$/u);
        const body = JSON.parse(String(init?.body)) as { model: string; input?: string[]; messages?: unknown[] };
        if (endpoint.endsWith("/embeddings")) {
          assert.equal(body.model, "fixture-embed");
          assert.ok(Array.isArray(body.input));
          return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
        }
        if (body.model === "conversation") {
          calls.conversation += 1;
          return textResponse("I will remember that preference.");
        }
        assert.equal(body.model, "memory");
        const prompt = JSON.stringify(body.messages);
        // If the optional emotion debounce fires on a slow runner, a non-decision produces no update.
        if (prompt.includes("You analyze chat conversation sentiment")) return textResponse("No emotion update.");
        if (prompt.includes("Extract memories from this conversation:")) {
          calls.extraction += 1;
          return textResponse(JSON.stringify([{ operation: "add", content: fact, durability: "permanent" }]));
        }
        assert.ok(prompt.includes("Reconcile proposed memory:"), "only the real extraction/reconciliation requests are expected");
        calls.reconciliation += 1;
        entered.resolve();
        // This is a normal second auxiliary request, still within its own 30-second timeout.
        await bounded(release.promise);
        init?.signal?.throwIfAborted();
        return textResponse(JSON.stringify({ operation: "ADD" }));
      } catch (error) { transportFailures.push(error); throw error; }
    };
    const config = configSchema.parse({
      ...structuredClone(defaultConfig),
      defaultModel: "conversation",
      toolModel: "conversation",
      providers: { fixture: {
        type: "openai-compatible", baseUrl: "https://memory-retirement.invalid/v1", requiresApiKey: false,
        retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
        embeddingModels: [{ id: "fixture-embed", displayName: "Fixture embedding", dimensions: 3 }]
      } },
      models: {
        conversation: { provider: "fixture", model: "conversation", capabilities: { tools: true, reasoning: false, streaming: true } },
        memory: { provider: "fixture", model: "memory", capabilities: { tools: false, reasoning: false, streaming: true } }
      },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false },
      checkpoints: { ...defaultConfig.checkpoints, enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "none", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      context: {
        ...defaultConfig.context,
        identity: { ...defaultConfig.context.identity, enabled: false },
        compaction: { ...defaultConfig.context.compaction, enabled: false },
        memory: {
          ...defaultConfig.context.memory, enabled: true, generateMemories: true, useMemories: false, queryRewrite: false,
          extractModel: "memory", memoryModel: "memory",
          embeddingModel: { kind: "provider", provider: "fixture", model: "fixture-embed" }
        }
      }
    });
    const memoryRoot = await canonicalMemoryRoot(globalAgentDir());
    const configStore = { configPath: () => path.join(globalConfigDir(), "config.json"), load: async () => structuredClone(config), save: async () => undefined };
    resources.memoryOwner = await serveMemoryOwner(memoryRoot, globalConfigDir(), new AgentMemoryOwner(memoryRoot, configStore));
    const local = await createInteractiveAgentHost(root, {
      sessionId: "memory-retirement",
      configStore
    });
    resources.local = local;
    // The public callback controls title generation; omit unrelated title notifications in this fixture.
    local.commands.agent.setOnTitleGenerated(undefined);
    const host = new RuntimeHostServer(local.runtime, local.commands, {
      protocolVersion: runtimeHostProtocolVersion, endpoint: path.join(root, "unused.sock"),
      registrationPath: path.join(root, "registration.json"), lockPath: path.join(root, "host.lock"),
      rootHash: "memory-retirement-test", persistenceRoot: root, agentRoot: process.env[BINY_AGENT_DIR_ENV],
      hostEpoch: randomUUID(), token: "unused", pid: process.pid, createdAt: new Date().toISOString()
    }, { close: async () => undefined });
    resources.host = host;
    await host.initialize();
    const memory = local.commands.agent.getLocalMemory();
    await memory.writeEntry({ content: "The user writes release notes for a software project.", source: "manual", durability: "permanent" });
    assert.equal(local.commands.sessionGoals.list({ status: "active" }).length, 0);
    return { root, local, host, memory, entered, release, calls, transportFailures, close };
  } catch (error) { await close(); throw error; }
}

async function completedTurn(f: Awaited<ReturnType<typeof fixture>>) {
  const submitted = f.local.runtime.submitPrompt("I prefer concise release notes with explicit verification results.");
  assert.equal((await bounded(submitted.completion)).status, "completed");
  await bounded(f.entered.promise);
  assert.equal(f.local.runtime.getSnapshot().state.kind, "idle");
  assert.deepEqual(f.calls, { conversation: 1, extraction: 1, reconciliation: 1 });
  assert.deepEqual(f.transportFailures, []);
  assert.equal((await f.memory.listMemoryEntries()).entries.some((entry) => entry.content === fact), false);
  const events = await readSessionEvents(f.local.commands.agent.getInfo().sessionFile);
  const answer = events.findLast((event) => event.type === "agent_message" && event.message.role === "assistant");
  assert.ok(answer?.type === "agent_message" && answer.messageId, "the completed public turn has a canonical assistant message");
  // submitted.messageId is the admitted user message; automatic memory belongs to the final assistant.
  assert.notEqual(answer.messageId, submitted.messageId);
  return { assistantMessageId: answer.messageId };
}

async function assertPersisted(root: string, sessionFile: string, messageId: string): Promise<void> {
  const reopened = new LocalMemory(root, () => { throw new Error("Readback must not call a model."); });
  try {
    const entry = (await reopened.listMemoryEntries()).entries.find((candidate) => candidate.content === fact);
    assert.ok(entry, "the real automatic fact survives closing and reopening the store");
    assert.equal(entry.source, "auto");
    assert.equal(entry.durability, "permanent");
    assert.equal(entry.messageId, messageId);
    const metadata = sessionMessageMetadata(await readSessionEvents(sessionFile), messageId);
    assert.equal(metadata.memoryExtracted, true);
    assert.deepEqual(metadata.createdMemories, [{ id: entry.id, content: fact, type: "created" }]);
  } finally { reopened.close(); }
}

test("a completed turn retains the Host while its memory reconciliation is pending", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const submitted = await completedTurn(f);
    const sessionFile = f.local.commands.agent.getInfo().sessionFile;
    // First assertion gives the old code a direct business failure without starting shutdown on a held model.
    assert.equal(f.local.commands.hasBackgroundWork(), true, "post-turn memory is still active background work");
    assert.equal(await f.host.retireIfIdle(0), false, "natural idle retirement must not enter bounded shutdown yet");
    f.release.resolve();
    await waitFor(() => !f.local.commands.hasBackgroundWork());
    assert.equal(f.local.commands.hasBackgroundWork(), false, "settled memory must not keep the Host resident forever");
    assert.equal(await f.host.retireIfIdle(0), true);
    await assertPersisted(f.root, sessionFile, submitted.assistantMessageId);
    assert.deepEqual(f.transportFailures, [], "background error handling must not hide fixture transport failures");
  } finally { await f.close(); }
});

test("ordinary runtime close still drains post-turn memory before closing its store", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const closing: { promise?: Promise<void>; settled: boolean } = { settled: false };
  try {
    const submitted = await completedTurn(f);
    const sessionFile = f.local.commands.agent.getInfo().sessionFile;
    closing.promise = f.local.runtime.close().then(() => { closing.settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closing.settled, false, "ordinary close keeps the memory store open until its writer settles");
    f.release.resolve();
    await bounded(closing.promise);
    assert.equal(f.local.commands.hasBackgroundWork(), false);
    await assertPersisted(f.root, sessionFile, submitted.assistantMessageId);
    assert.deepEqual(f.transportFailures, [], "background error handling must not hide fixture transport failures");
  } finally {
    f.release.resolve();
    try { await closing.promise; } finally { await f.close(); }
  }
});
