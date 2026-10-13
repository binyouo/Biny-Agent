import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { ModelStreamEvent } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TodoStore } from "../src/session/todoStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function fixture(context: TestContext, withStore = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-todo-prompt-")));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "state");
  const cleanup: { agent?: AgentSession } = {};
  context.after(async () => {
    try { await cleanup.agent?.close(); }
    finally {
      if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected model network call"); });
  const config = structuredClone(defaultConfig);
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.diagnostics.enabled = false;
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const store = new TodoStore(root, recorder.sessionId);
  const writer = new TodoStore(root, recorder.sessionId);
  await store.initialize();
  const requests: string[] = [];
  let fallback: string | undefined;
  const agent = new AgentSession({
    workspaceRoot: root, config, recorder, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    todoStore: withStore ? store : undefined, todoPrompt: () => fallback,
    model: {
      provider: "fixture", modelId: "todo-prompt", runtime: "builtin-llama.cpp", dataResidency: "local",
      stream: async (request, options) => {
        if (options?.requestContext?.operation === "agent") requests.push(request.systemPrompt ?? "");
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: "Fixture answer" };
          yield { type: "finish", reason: "stop" };
        })();
      }
    }
  });
  cleanup.agent = agent;
  await agent.initialize();
  async function run(stream: AsyncGenerator<AgentSessionEvent>) {
    const before = requests.length;
    let completed = false;
    for await (const event of stream) {
      if (event.type === "done") {
        assert.equal(event.outcome.status, "completed");
        completed = true;
      }
    }
    assert.equal(completed, true);
    assert.equal(requests.length, before + 1);
    return requests.at(-1)!;
  }
  return {
    root, agent, recorder, store, writer, run,
    setFallback(value?: string) { fallback = value; },
    prompt: () => run(agent.prompt("Return the fixture answer", { emotionAnalysis: false }))
  };
}

test("real prompt assembly observes same-session persisted replacements and clear without leaking other sessions", async context => {
  const current = await fixture(context);
  await current.writer.replace([{ content: "Original plan", status: "pending" }]);
  assert.match(await current.prompt(), /1\. \[ \] Original plan/);
  await current.writer.replace([{ content: "CLI replacement", status: "in_progress" }]);
  assert.equal(current.store.list()[0]?.content, "Original plan", "cached projections must not refresh on their own");
  assert.match(await current.prompt(), /1\. \[>\] CLI replacement/);
  const other = new TodoStore(current.root, "other-session");
  await other.replace([{ content: "Other session plan", status: "pending" }]);
  assert.doesNotMatch(await current.prompt(), /Other session plan/);
  await current.writer.replace([]);
  assert.doesNotMatch(await current.prompt(), /## Current plan/);
  assert.deepEqual(current.store.list(), []);
  await current.store.useSession("other-session");
  assert.match(await current.prompt(), /1\. \[ \] Other session plan/);
});

test("retry assembles the newly persisted plan instead of reusing the original request's stale plan", async context => {
  const current = await fixture(context);
  await current.writer.replace([{ content: "Before retry", status: "pending" }]);
  await current.prompt();
  await current.recorder.flush();
  const original = (await readSessionEvents(current.recorder.filePath)).find(event => event.type === "user_message");
  assert.ok(original?.messageId);
  await current.writer.replace([{ content: "Retry replacement", status: "in_progress" }]);
  const prompt = await current.run(current.agent.retry(original.messageId, { emotionAnalysis: false }));
  assert.match(prompt, /1\. \[>\] Retry replacement/);
  assert.doesNotMatch(prompt, /1\. \[ \] Before retry/);
});

test("refresh reads and normalizes real files and clears stale plans for malformed or deleted files", async context => {
  const current = await fixture(context);
  await current.writer.replace([{ content: "Initial", status: "pending" }]);
  const file = path.join(agentDir(current.root), "todos", `${current.recorder.sessionId}.json`);
  await writeFile(file, JSON.stringify({ items: [{ content: "x".repeat(501), status: "pending" }, { content: "invalid", status: "done" }, null] }));
  await current.prompt();
  assert.deepEqual(current.store.list(), [{ content: "x".repeat(500), status: "pending" }]);
  for (const invalid of ["{broken", "{}"]) {
    await current.writer.replace([{ content: "Stale", status: "pending" }]);
    await current.prompt();
    await writeFile(file, invalid);
    assert.doesNotMatch(await current.prompt(), /## Current plan/);
  }
  await current.writer.replace([{ content: "Stale", status: "pending" }]);
  await current.prompt();
  await rm(file);
  assert.doesNotMatch(await current.prompt(), /## Current plan/);
});

test("prompt assembly without a TodoStore preserves an optional fallback", async context => {
  const current = await fixture(context, false);
  current.setFallback("Fallback plan marker");
  assert.match(await current.prompt(), /Fallback plan marker/);
  current.setFallback();
  assert.doesNotMatch(await current.prompt(), /Fallback plan marker/);
});
