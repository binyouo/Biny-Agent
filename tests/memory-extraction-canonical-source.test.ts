import { AgentMemoryClient } from "../src/runtime/memory/client.js";
import { testModel } from "./helpers/model.js";
/** Extraction consumes canonical conversation text, not host-injected reference material. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import type { AgentSession as AgentSessionType } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, AgentUserMessage } from "../src/agent/core/types.js";
import type { LocalMemory as LocalMemoryType } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

// Isolate paths and network before importing any production module.
const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-canonical-source-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
const previousZone = process.env.TZ;
process.env.BINY_AGENT_DIR = path.join(suiteRoot, "bootstrap");
process.env.TZ = "UTC";
const blockedFetch = mock.method(globalThis, "fetch", async () => {
  throw new Error("Memory-source fixtures must not request the network.");
});
const blockedSocket = mock.method(Socket.prototype, "connect", () => {
  throw new Error("Memory-source fixtures must not open network sockets.");
});

try {
  const { AgentSession } = await import("../src/agent/AgentSession.js");
  const { LocalMemory } = await import("../src/agent/context/LocalMemory.js");
  const { FileMemoryStorage } = await import("../src/agent/context/fileMemory.js");
  const { upsertDailyMemorySection } = await import("../src/activity/dailyNotes.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { PermissionManager } = await import("../src/permission/PermissionManager.js");
  const { SessionRecorder } = await import("../src/session/recorder.js");
  const { readSessionEvents } = await import("../src/session/events.js");
  const { ensureAgentDirs } = await import("../src/session/store.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const { LocalEmbeddingManager } = await import("../src/llm/embedding/LocalEmbeddingRuntime.js");

  await test("a completed real session extracts its user text without file-memory or diary references", { timeout: 15_000 }, async (t) => {
    const root = path.join(suiteRoot, "session");
    const agentDir = path.join(root, "agent");
    const workspace = path.join(root, "workspace");
    process.env.BINY_AGENT_DIR = agentDir;
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-19T12:00:00.000Z") });
    let agent: AgentSessionType | undefined;
    let recorder: InstanceType<typeof SessionRecorder> | undefined;
    let pendingRun: Promise<unknown> | undefined;
    let closePromise: Promise<void> | undefined;
    const bodyFinished = deferredVoid();
    const close = (): Promise<void> => closePromise ??= (async () => {
      await Promise.allSettled(pendingRun ? [pendingRun] : []);
      if (agent) await agent.close(); else await recorder?.close();
    })();
    // A timeout must not cache an empty close while async setup is still creating owners.
    const cleanup = async (): Promise<void> => { await bodyFinished.promise; await close(); };
    t.after(cleanup);
    try {
      t.signal.throwIfAborted();
      await mkdir(workspace, { recursive: true });
      t.signal.throwIfAborted();
      await ensureAgentDirs(workspace);
      t.signal.throwIfAborted();
      await new FileMemoryStorage({ configDir: agentDir }).writeLongTerm("# MEMORY.md\n\nLONG_REFERENCE_ONLY_7461");
      t.signal.throwIfAborted();
      await upsertDailyMemorySection("2026-10-19", "聊天摘要", "TODAY_REFERENCE_ONLY_7461", { configDir: agentDir });
      t.signal.throwIfAborted();
      await upsertDailyMemorySection("2026-10-18", "聊天摘要", "YESTERDAY_REFERENCE_ONLY_7461", { configDir: agentDir });
      t.signal.throwIfAborted();
      const config = structuredClone(defaultConfig);
      config.models = { [config.defaultModel]: config.models[config.defaultModel]! };
      config.toolModel = config.defaultModel;
      config.providers.deepseek = { ...config.providers.deepseek!, apiKey: "fixture-key", apiKeyEnv: undefined };
      config.providers.deepseek = { ...config.providers.deepseek!, apiKeyEnv: "BINY_CANONICAL_SOURCE_UNCONFIGURED_KEY" };
      config.agent.toolExecutionMode = "direct";
      config.context.maxInputTokens = 1_000_000;
      config.context.compaction.enabled = false;
      config.context.identity.enabled = false;
      config.context.memory.enabled = true;
      config.context.memory.useMemories = false;
      config.context.memory.generateMemories = true;
      config.context.memory.excludeExternalContext = true;
      config.context.memory.queryRewrite = false;
      config.context.memory.embeddingModel = { kind: "local", model: "multilingual-e5-small" };
      config.activity.enabled = false;
      config.crystal.passiveEnabled = false;
      config.crystal.semanticScanEnabled = false;
      config.chat.skillExtraction.enabled = false;
      const requests: Array<{ operation?: string; text: string; messages: AgentMessage[] }> = [];
      const input = "Tell me a brief joke.";
      const answer = "A short, ordinary answer.";
      const model: AgentModel = testModel({
        provider: "memory-source-fixture", modelId: "memory-source-fixture",
        async stream(context, options) {
          const text = messageTexts(context.messages);
          requests.push({ operation: options?.requestContext?.operation, text, messages: structuredClone(context.messages) });
          const output = options?.requestContext?.operation === "agent" ? answer : '["NO_MEMORY"]';
          return (async function* () {
            options?.signal?.throwIfAborted();
            yield { type: "text-delta" as const, text: output };
            yield { type: "finish" as const, reason: "stop" as const };
          })();
        }
      });
      // Substitute only the model-loading boundary. Both AgentSession availability
      // and the real MemoryEmbeddingService cleanup lookup use this same runtime.
      let embedCalls = 0;
      const runtime = availableEmbedding(() => { embedCalls += 1; });
      const runtimeFactory = t.mock.method(AgentMemoryClient.prototype, "embeddingRuntime", async () => runtime);
      t.mock.method(AgentMemoryClient.prototype, "findSimilarInScope", async () => []);
      t.mock.method(LocalEmbeddingManager.prototype, "createRuntime", async () => runtime);
      recorder = new SessionRecorder(workspace, "canonical-source-session");
      agent = new AgentSession({ workspaceRoot: workspace, config, model, recorder,
        toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }) });
      await agent.initialize();
      t.signal.throwIfAborted();
      const task = agent.runTask(input, { emotionAnalysis: false, abortSignal: t.signal });
      pendingRun = task;
      const outcome = await task;
      t.signal.throwIfAborted();
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      await close();
      const foreground = requests.filter((request) => request.operation === "agent");
      const extraction = requests.filter((request) => request.text.startsWith("Extract memories from this conversation:"));
      assert.equal(foreground.length, 1);
      assert.equal(extraction.length, 1, "the real completed-turn path must request actual LocalMemory extraction");
      assert.equal(runtimeFactory.mock.callCount(), 1, "the session resolves the global embedding runtime");
      assert.equal(embedCalls, 0, "an empty fact store does not need embedding inference");
      for (const sentinel of ["LONG_REFERENCE_ONLY_7461", "TODAY_REFERENCE_ONLY_7461", "YESTERDAY_REFERENCE_ONLY_7461"]) {
        assert.ok(foreground[0]!.text.includes(sentinel), `foreground injection must contain ${sentinel}`);
      }
      const user = foreground[0]!.messages.find((message) => message.role === "user");
      assert.ok(user?.role === "user" && typeof user.content === "string" && user.content.endsWith(input));
      const events = await readSessionEvents(recorder.filePath);
      const source = events.find((event) => event.type === "user_message" && !event.auditOnly);
      assert.ok(source?.type === "user_message" && source.messageId && source.time);
      assert.equal(source.content, input);
      const expected = `Extract memories from this conversation:\n\nuser: ${input}\n\nassistant: ${answer}`
        + `\n\nOriginal user message source anchors:\n- messageId: ${source.messageId}; sentAt: ${source.time}; timeZone: ${String(source.metadata?.sentAtTimeZone ?? "unknown")}`;
      assert.equal(extraction[0]!.text, expected,
        "host references must not be presented as the current user's conversation to the extraction model");
      assert.doesNotMatch(JSON.stringify(events), /LONG_REFERENCE_ONLY_7461|TODAY_REFERENCE_ONLY_7461|YESTERDAY_REFERENCE_ONLY_7461/u);
    } finally { bodyFinished.resolve(); await cleanup(); }
  });

  const injected = "<!-- biny-turn-context:start -->\nHOST_REFERENCE_ONLY_9852\n<!-- biny-turn-context:end -->";
  const genuineMarker = "My literal markers remain user text:\n"
    + "<!-- biny-recalled-memory:start -->\nquoted memory example\n<!-- biny-recalled-memory:end -->\n"
    + "<!-- biny-turn-context:start -->\nquoted context example\n<!-- biny-turn-context:end -->";
  const cases: Array<{ name: string; user: AgentUserMessage; expected: string }> = [
    { name: "string originalContent", user: { role: "user", content: `${injected}\n\nCanonical request.`, originalContent: "Canonical request." }, expected: "Canonical request." },
    { name: "originalContent without host markers", user: { role: "user", content: "Unmarked host reference.\n\nCanonical request.", originalContent: "Canonical request." }, expected: "Canonical request." },
    { name: "media-first originalContent", user: { role: "user", content: [{ type: "text", text: injected }, { type: "image", mimeType: "image/png", data: "fixture-image" }, { type: "text", text: genuineMarker }, { type: "audio", mimeType: "audio/wav", data: "fixture-audio" }, { type: "text", text: "Second user paragraph." }],
      originalContent: [{ type: "image", mimeType: "image/png", data: "fixture-image" }, { type: "text", text: genuineMarker }, { type: "audio", mimeType: "audio/wav", data: "fixture-audio" }, { type: "text", text: "Second user paragraph." }] }, expected: `${genuineMarker}\nSecond user paragraph.` },
    { name: "empty string originalContent", user: { role: "user", content: injected, originalContent: "" }, expected: "" },
    { name: "no originalContent", user: { role: "user", content: genuineMarker }, expected: genuineMarker }
  ];

  for (const [index, item] of cases.entries()) {
    await test(`extraction and cleanup preserve ${item.name}`, { timeout: 10_000 }, async (t) => {
      const root = path.join(suiteRoot, `direct-${index}`);
      process.env.BINY_AGENT_DIR = root;
      const prompts: string[] = [];
      const queries: string[] = [];
      let temporary: MemoryEntry | undefined;
      const model: AgentModel = testModel({
        provider: "memory-source-fixture", modelId: "memory-source-fixture",
        async stream(context, options) {
          const prompt = messageTexts(context.messages);
          prompts.push(prompt);
          const output = prompt.startsWith("Extract memories from this conversation:") ? '["NO_MEMORY"]' : "[]";
          return (async function* () {
            options?.signal?.throwIfAborted();
            yield { type: "text-delta" as const, text: output };
            yield { type: "finish" as const, reason: "stop" as const };
          })();
        }
      });
      let memory: LocalMemoryType | undefined;
      let pending: Promise<unknown> | undefined;
      let closePromise: Promise<void> | undefined;
      const bodyFinished = deferredVoid();
      const close = (): Promise<void> => closePromise ??= (async () => {
        await Promise.allSettled(pending ? [pending] : []);
        memory?.close();
      })();
      const cleanup = async (): Promise<void> => { await bodyFinished.promise; await close(); };
      t.after(cleanup);
      try {
        t.signal.throwIfAborted();
        await mkdir(root, { recursive: true });
        t.signal.throwIfAborted();
        memory = new LocalMemory(root, () => model, undefined, 3, undefined, undefined, undefined,
          async (query) => { queries.push(query); return temporary ? [temporary] : []; });
        temporary = (await memory.writeEntry({ content: "A separately stored temporary candidate.", durability: "temporary" })).entry;
        t.signal.throwIfAborted();
        assert.ok(temporary);
        const messages: AgentMessage[] = [item.user, { role: "assistant", content: [
          { type: "reasoning", text: "REASONING_NOT_CONVERSATION" },
          { type: "text", text: "Visible answer one." },
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "TOOL_ARGS_NOT_CONVERSATION" } },
          { type: "text", text: "Visible answer two." }
        ] }];
        const before = structuredClone(messages);
        const messageIdentities = messages.slice();
        const contentIdentity = item.user.content;
        const originalIdentity = item.user.originalContent;
        t.signal.throwIfAborted();
        const operation = memory.summarizeAndStoreMemories(messages, {
          sessionId: "direct-session", turnId: "direct-turn", runId: "direct-run",
          externalContext: false, excludeExternalContext: false, signal: t.signal,
          now: new Date("2026-10-19T12:00:00.000Z")
        });
        pending = operation;
        const changes = await operation;
        t.signal.throwIfAborted();
        const expected = `user: ${item.expected}\n\nassistant: Visible answer one.\nVisible answer two.`;
        assert.equal(prompts.length, 2, "real extraction and cleanup each call the supplied model once");
        const cleanupConversation = prompts[1]!.split("Current conversation context:\n")[1]
          ?.split(/\n\n(?:Current conversation source:|Temporary memories related to this conversation:)/u)[0];
        assert.deepEqual({ extraction: prompts[0], cleanupQueries: queries, cleanupConversation }, {
          extraction: `Extract memories from this conversation:\n\n${expected}`,
          cleanupQueries: [expected],
          cleanupConversation: expected
        }, "extraction and both cleanup inputs must use the same canonical conversation");
        assert.ok(prompts[1]!.includes("Temporary memories related to this conversation:\n"));
        assert.ok(prompts[1]!.includes(temporary.id), "stored cleanup candidates remain separate from the conversation text");
        assert.deepEqual(messages, before, "formatting must not mutate caller-owned messages or media");
        messages.forEach((message, position) => assert.strictEqual(message, messageIdentities[position], "message identity preserves WeakMap provenance"));
        assert.strictEqual(item.user.content, contentIdentity);
        assert.strictEqual(item.user.originalContent, originalIdentity);
        assert.deepEqual(changes, { created: [], updated: [], deleted: [] });
        assert.equal((await memory.getEntry(temporary.id))?.content, temporary.content);
      } finally { bodyFinished.resolve(); await cleanup(); }
    });
  }

  await test("memory source fixtures made no external network attempts", () => {
    assert.equal(blockedFetch.mock.callCount(), 0);
    assert.equal(blockedSocket.mock.callCount(), 0);
  });
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
  blockedFetch.mock.restore();
  blockedSocket.mock.restore();
  await rm(suiteRoot, { recursive: true, force: true });
}

function messageTexts(messages: readonly AgentMessage[]): string {
  return messages.map((message) => typeof message.content === "string" ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
}

function availableEmbedding(onEmbed: () => void): EmbeddingModelRuntime {
  const ref = { kind: "local", model: "multilingual-e5-small" } as const;
  return {
    descriptor: { ref, fingerprint: "canonical-source-fixture", displayName: "fixture", dimensions: 2, recommendedThreshold: 0.3, source: "local" },
    fingerprint: "canonical-source-fixture",
    async embed({ texts, signal }) {
      onEmbed();
      signal?.throwIfAborted();
      return { embeddings: texts.map(() => new Float32Array([1, 0])), dimensions: 2, fingerprint: "canonical-source-fixture", model: ref };
    }
  };
}

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
