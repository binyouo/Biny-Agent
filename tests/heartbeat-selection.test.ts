import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { TodoStore } from "../src/session/todoStore.js";
import { listAllSessionFiles } from "../src/session/store.js";
import { readSessionEvents } from "../src/session/events.js";
for (const mode of ["unchanged", "draft", "resume", "return-original", "goal-retained"] as const) {
  test(`heartbeat current checklist selection: ${mode}`, { timeout: 30000 }, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-selection-"));
    const old = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    const cleanup: { runtime?: CommandRuntime; interactive?: InteractiveAgentRuntime } = {};
    context.after(async () => {
      try {
        if (cleanup.interactive) await cleanup.interactive.close();
        else await cleanup.runtime?.close();
      } finally {
        context.mock.restoreAll();
        if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      assert.equal(input instanceof Request ? input.url : String(input), "http://todo-fixture.invalid/v1/chat/completions");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response([{ choices: [{ index: 0, delta: { content: "HEARTBEAT_OK" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"].map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
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
    const original = runtime.agent.getInfo().sessionId;
    const originalItems = [{ content: "Original A checklist sentinel", status: "pending" as const }];
    await runtime.sessionCommand("TodoWrite", { todos: originalItems });
    let current = original;
    let expected = originalItems;
    if (mode !== "unchanged") {
      const b = (await interactive.startDraft()).sessionId;
      const itemsB = [{ content: "Current B checklist sentinel", status: "pending" as const }];
      await runtime.sessionCommand("TodoWrite", { todos: itemsB });
      current = b; expected = itemsB;
      if (mode === "resume") {
        await interactive.resumeSession(original);
        await interactive.resumeSession(b);
      }
      if (mode === "return-original") { await interactive.resumeSession(original); current = original; expected = originalItems; }
      if (mode === "goal-retained") runtime.sessionGoals.set(original, "Keep original A durable goal");
    }
    assert.equal(runtime.agent.getInfo().sessionId, current);
    assert.deepEqual(await runtime.sessionCommand("TodoShow", {}), { sessionId: current, todos: expected });
    assert.equal(await runtime.heartbeat.triggerNow(), true, runtime.heartbeat.status().lastError);
    assert.equal(bodies.length, 1);
    const user = bodies[0]!.messages.filter(message => message.role === "user").at(-1);
    assert.ok(user);
    const content = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    const match = content.match(/ACTIVE TASK REVIEW\n[^\n]+\n([^\n]+)/u);
    assert.ok(match, content);
    const records = JSON.parse(match[1]!) as Array<{ label: string; details?: string[] }>;
    const files = await listAllSessionFiles();
    const heartbeatFile = files.find(file => file.endsWith("/heartbeat.jsonl"));
    assert.ok(heartbeatFile, "heartbeat execution remains in its separate session");
    const events = await readSessionEvents(heartbeatFile);
    assert.ok(events.some(event => event.type === "user_message" && event.metadata?.source === "heartbeat"));
    const persistedA = new TodoStore(root, original); await persistedA.initialize();
    assert.deepEqual(persistedA.list(), originalItems);
    assert.deepEqual(await runtime.sessionCommand("TodoShow", {}), { sessionId: current, todos: expected });
    if (mode === "goal-retained") assert.ok(records.some(record => record.label === "Keep original A durable goal" && record.details?.includes("[pending] Original A checklist sentinel")));
    assert.deepEqual(records.find(record => record.label === "Current session checklist")?.details, expected.map(item => `[${item.status}] ${item.content}`), "task review must select the completed foreground session, not its constructor session");
  });
}
