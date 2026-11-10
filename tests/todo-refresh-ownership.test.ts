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
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

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
  test(`Todo refresh keeps its publication ownership: ${mode}`, { timeout: 10_000 }, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-todo-refresh-owner-"));
    const entered = deferred();
    const release = deferred();
    const readFile = fs.readFile;
    const sessionA = "plan-a";
    const store = new TodoStore(root, sessionA);
    const itemsA: TodoItem[] = [{ content: "A owned plan", status: "pending" }];
    const itemsB: TodoItem[] = [{ content: "B owned plan", status: "in_progress" }];
    const newerA: TodoItem[] = [{ content: "A newer plan", status: "completed" }];
    let refresh = Promise.resolve();
    context.after(async () => {
      release.resolve();
      try { await refresh; }
      finally { context.mock.restoreAll(); await removeTestRoot(root, { recursive: true, force: true }); }
    });
    await store.initialize();
    await store.replace(itemsA);
    const targetA = path.join(agentDir(root), "todos", `${sessionA}.json`);
    let blocked = false;
    context.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const value = await readFile(args[0], args[1]);
      if (String(args[0]) === targetA && !blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
        if (mode === "failed-read-switch" || mode === "current-failed-read") {
          throw Object.assign(new Error("Injected owned Todo read failure"), { code: "EIO" });
        }
      }
      return value;
    });
    refresh = store.refresh();
    await Promise.race([entered.promise, refresh.then(() => { throw new Error("Refresh did not reach the read boundary"); })]);
    let sessionB: string | undefined;
    let expectedItems = itemsA;
    let expectedDiskA = itemsA;
    if (mode === "settled-before-switch") { release.resolve(); await refresh; }
    if (["switch", "aba", "failed-read-switch", "settled-before-switch"].includes(mode)) {
      sessionB = "plan-b";
      await store.useSession(sessionB);
      assert.deepEqual(store.list(), []);
      await store.replace(itemsB);
      expectedItems = itemsB;
    }
    if (mode === "aba") await store.useSession(sessionA);
    if (mode === "aba" || mode === "same-session-write") {
      await store.replace(newerA);
      expectedItems = newerA;
      expectedDiskA = newerA;
    }
    if (mode === "overlapping-read") {
      await new TodoStore(root, sessionA).replace(newerA);
      await store.refresh();
      assert.deepEqual(store.list(), newerA);
      expectedItems = newerA;
      expectedDiskA = newerA;
    }
    if (mode === "current-failed-read") expectedItems = [];
    release.resolve();
    await refresh;
    assert.deepEqual(JSON.parse(await readFile(targetA, "utf8")).items, expectedDiskA);
    if (sessionB) {
      const targetB = path.join(agentDir(root), "todos", `${sessionB}.json`);
      assert.deepEqual(JSON.parse(await readFile(targetB, "utf8")).items, itemsB);
    }
    assert.deepEqual(store.list(), expectedItems, "An older read must not overwrite a newer session, read, or committed plan");
  });
}

test("heartbeat Todo refresh stays separate while the foreground session changes", { timeout: 15_000 }, async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-todo-owner-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const cleanup: { runtime?: CommandRuntime; interactive?: InteractiveAgentRuntime; heartbeat?: Promise<boolean> } = {};
  const entered = deferred();
  const release = deferred();
  const readFile = fs.readFile;
  let requests = 0;
  context.after(async () => {
    release.resolve();
    try { await cleanup.heartbeat; }
    finally {
      try {
        if (cleanup.interactive) await cleanup.interactive.close();
        else await cleanup.runtime?.close();
      } finally {
        context.mock.restoreAll();
        if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
        else process.env.BINY_AGENT_DIR = previousAgentDir;
        await removeTestRoot(root, { recursive: true, force: true });
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
  await runtime.sessionCommand("TodoWrite", { todos: itemsA });
  let blocked = false;
  context.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).startsWith(path.join(agentDir(root), "todos", "heartbeat-")) && !blocked) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
    return await readFile(args[0], args[1]);
  });
  const heartbeat = runtime.heartbeat.triggerNow();
  cleanup.heartbeat = heartbeat;
  await Promise.race([entered.promise, heartbeat.then(() => { throw new Error("Heartbeat did not read its own Todo store"); })]);
  assert.equal(runtime.heartbeat.status().running, true);
  const sessionB = (await interactive.startDraft()).sessionId;
  assert.notEqual(sessionB, sessionA);
  assert.deepEqual(await runtime.sessionCommand("TodoShow", {}), { sessionId: sessionB, todos: [] });
  await runtime.sessionCommand("TodoWrite", { todos: itemsB });
  release.resolve();
  assert.equal(await heartbeat, true, runtime.heartbeat.status().lastError);
  assert.ok(requests > 0);
  assert.deepEqual(await runtime.sessionCommand("TodoShow", {}), { sessionId: sessionB, todos: itemsB });
  for (const [id, items] of [[sessionA, itemsA], [sessionB, itemsB]] as const) {
    assert.deepEqual(JSON.parse(await readFile(path.join(agentDir(root), "todos", `${id}.json`), "utf8")).items, items);
  }
});
