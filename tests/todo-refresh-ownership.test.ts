import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { agentDir } from "../src/session/store.js";
import { TodoStore, type TodoItem } from "../src/session/todoStore.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const cases = [
  "switch", "aba", "same-session-write", "failed-read-switch",
  "settled-before-switch", "unchanged-session", "overlapping-read", "current-failed-read"
] as const;

for (const mode of cases) {
  test(`Todo refresh keeps its publication ownership: ${mode}`, { timeout: 30_000 }, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-todo-refresh-owner-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    const cleanup: { runtime?: CommandRuntime; interactive?: InteractiveAgentRuntime; heartbeat?: Promise<boolean> } = {};
    const entered = deferred();
    const release = deferred();
    const readFile = fs.readFile;
    let reads = 0;
    let requests = 0;
    context.after(async () => {
      release.resolve();
      try {
        await cleanup.heartbeat;
      } finally {
        try {
          if (cleanup.interactive) await cleanup.interactive.close();
          else await cleanup.runtime?.close();
        } finally {
          context.mock.restoreAll();
          if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
          else process.env.BINY_AGENT_DIR = previousAgentDir;
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    });
    // Fully inert provider boundary: no HTTP server, credential, or model tool call.
    context.mock.method(globalThis, "fetch", async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(url, "http://todo-fixture.invalid/v1/chat/completions");
      requests++;
      const chunks = [
        { choices: [{ index: 0, delta: { content: "HEARTBEAT_OK" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        "[DONE]"
      ];
      return new Response(chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), {
        status: 200, headers: { "content-type": "text/event-stream" }
      });
    });
    const config = configSchema.parse({
      ...defaultConfig, defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://todo-fixture.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "inert-fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      checkpoints: { enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      context: { ...defaultConfig.context, identity: { enabled: false, userEnabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const runtime = await createCommandRuntime(root, { configStore: { load: async () => config, save: async () => undefined } });
    cleanup.runtime = runtime;
    const interactive = new InteractiveAgentRuntime(runtime);
    cleanup.interactive = interactive;
    const sessionA = runtime.agent.getInfo().sessionId;
    const itemsA: TodoItem[] = [{ content: "A owned plan", status: "pending" }];
    const itemsB: TodoItem[] = [{ content: "B owned plan", status: "in_progress" }];
    const newerA: TodoItem[] = [{ content: "A newer plan", status: "completed" }];
    await runtime.sessionCommand("TodoWrite", { todos: itemsA });
    const targetA = path.join(agentDir(root), "todos", `${sessionA}.json`);
    context.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const value = await readFile(args[0], args[1]);
      // First A read belongs to the independent task-review store. The second
      // is the shared foreground/heartbeat store's extension-prompt refresh.
      if (String(args[0]) === targetA && ++reads === 2) {
        entered.resolve();
        await release.promise;
        if (mode === "failed-read-switch" || mode === "current-failed-read") {
          throw Object.assign(new Error("Injected owned Todo read failure"), { code: "EIO" });
        }
      }
      return value;
    });
    const heartbeat = runtime.heartbeat.triggerNow();
    cleanup.heartbeat = heartbeat;
    await entered.promise;
    assert.equal(runtime.heartbeat.status().running, true);
    let sessionB: string | undefined;
    let currentId = sessionA;
    let expectedItems = itemsA;
    let expectedDiskA = itemsA;
    if (mode === "settled-before-switch") {
      release.resolve();
      assert.equal(await heartbeat, true, runtime.heartbeat.status().lastError);
    }
    if (["switch", "aba", "failed-read-switch", "settled-before-switch"].includes(mode)) {
      sessionB = (await interactive.startDraft()).sessionId;
      assert.notEqual(sessionB, sessionA);
      assert.deepEqual(await runtime.sessionCommand("TodoShow", {}), { sessionId: sessionB, todos: [] });
      await runtime.sessionCommand("TodoWrite", { todos: itemsB });
      currentId = sessionB;
      expectedItems = itemsB;
    }
    if (mode === "aba") {
      await interactive.resumeSession(sessionA);
      currentId = sessionA;
    }
    if (mode === "aba" || mode === "same-session-write") {
      await runtime.sessionCommand("TodoWrite", { todos: newerA });
      expectedItems = newerA;
      expectedDiskA = newerA;
    }
    if (mode === "overlapping-read") {
      // An independent writer changes disk, not the shared store's revision.
      await new TodoStore(root, sessionA).replace(newerA);
      const run = interactive.submitPrompt("Return the inert fixture answer", [], undefined, undefined, { tools: "none", skills: "none" });
      const outcome = await run.completion;
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      assert.deepEqual(await runtime.sessionCommand("TodoShow", {}), { sessionId: sessionA, todos: newerA });
      expectedItems = newerA;
      expectedDiskA = newerA;
    }
    if (mode === "current-failed-read") expectedItems = [];
    release.resolve();
    assert.equal(await heartbeat, true, runtime.heartbeat.status().lastError);
    assert.ok(requests > 0);
    assert.equal(reads, mode === "aba" || mode === "overlapping-read" ? 3 : 2);
    // Check persistence before the failing baseline projection assertion. These
    // races lose in-memory ownership, not either session's persisted plan.
    assert.deepEqual(JSON.parse(await readFile(targetA, "utf8")).items, expectedDiskA);
    if (sessionB) {
      const targetB = path.join(agentDir(root), "todos", `${sessionB}.json`);
      assert.deepEqual(JSON.parse(await readFile(targetB, "utf8")).items, itemsB);
    }
    assert.deepEqual(await runtime.sessionCommand("TodoShow", {}), { sessionId: currentId, todos: expectedItems },
      "An older read must not overwrite a newer session, read, or committed plan");
  });
}
