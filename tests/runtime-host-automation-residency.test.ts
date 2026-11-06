import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import type { AutomationPendingFire, AutomationRecord } from "../src/runtime/AutomationScheduler.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readyHostClient } from "./helpers/readyHostClient.js";

const initialTime = Date.parse("2030-01-01T09:00:00.000Z");
const targetPrompt = "residency-target-reminder";
const independentPrompt = "residency-independent-check";
const laterPrompt = "residency-later-poll-witness";

function textResponse(content: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
    "data: [DONE]\n\n"
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(condition: () => boolean | Promise<boolean>, describe: () => string): Promise<void> {
  // Host polling and sockets use real time; only schedule dates are frozen.
  const deadline = performance.now() + 5_000;
  while (!await condition()) {
    assert.ok(performance.now() < deadline, describe());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-automation-residency-")));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  const originalFetch = globalThis.fetch;
  const calls = { target: 0, independent: 0, later: 0 };
  const transportFailures: unknown[] = [];
  const resources: {
    local?: InteractiveAgentHost;
    host?: Awaited<ReturnType<typeof startRuntimeHost>>;
    client?: NonNullable<Awaited<ReturnType<typeof connectRuntimeHost>>>;
  } = {};
  const close = async () => {
    try {
      const closed = await Promise.allSettled([
        resources.host ? resources.host.close() : resources.local?.runtime.close(),
        resources.client?.close()
      ]);
      const failed = closed.filter((result) => result.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Automation residency cleanup failed.");
    } finally {
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
        assert.equal(String(url), "https://automation-residency.invalid/v1/chat/completions");
        const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
        assert.equal(body.model, "fixture");
        const prompt = JSON.stringify(body.messages);
        if (prompt.includes("You analyze chat conversation sentiment")) return textResponse("No emotion update.");
        if (prompt.includes(targetPrompt)) calls.target += 1;
        else if (prompt.includes(independentPrompt)) calls.independent += 1;
        else if (prompt.includes(laterPrompt)) calls.later += 1;
        else throw new Error("Unexpected provider request in automation residency fixture.");
        return textResponse("Automation completed.");
      } catch (error) { transportFailures.push(error); throw error; }
    };
    const config = configSchema.parse({
      ...structuredClone(defaultConfig), defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: {
        type: "openai-compatible", baseUrl: "https://automation-residency.invalid/v1", requiresApiKey: false,
        retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
      } },
      models: { fixture: { provider: "fixture", model: "fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      checkpoints: { ...defaultConfig.checkpoints, enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "none", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      context: {
        ...defaultConfig.context,
        identity: { ...defaultConfig.context.identity, enabled: false },
        compaction: { ...defaultConfig.context.compaction, enabled: false },
        memory: { ...defaultConfig.context.memory, enabled: false, useMemories: false, generateMemories: false }
      }
    });
    const configStore = { load: async () => structuredClone(config), save: async () => undefined };
    const configDir = path.join(root, "config");
    resources.host = await startRuntimeHost(root, async (resourceRegistry) => {
      const local = await createInteractiveAgentHost(root, { sessionId: "residency-primary", configStore, resourceRegistry });
      resources.local = local;
      local.commands.agent.setOnTitleGenerated(undefined);
      return local;
    }, {
      workspaceRoot: root, configDir,
      createRuntime: async (sessionId, options) => {
        const local = await createInteractiveAgentHost(root, { sessionId, configStore, resourceRegistry: options?.resourceRegistry });
        local.commands.agent.setOnTitleGenerated(undefined);
        return local;
      }
    });
    const client = await readyHostClient(await connectRuntimeHost(root, { configDir, clientId: "residency-observer", surface: "cli" }));
    assert.ok(client);
    resources.client = client;
    return { client, calls, transportFailures, close };
  } catch (error) { await close(); throw error; }
}

// Existing scheduler tests use a runtime factory without the Host LRU. This
// public-client flow catches disposal between choosing a target and submitting.
await test("due target survives a concurrent fresh-session fire at default cache capacity", { timeout: 30_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const f = await fixture();
  try {
    const sessions: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      context.mock.timers.setTime(initialTime + index + 1);
      const prepared = await bounded(f.client.ensureSession({ writeIntent: false, focus: false }), "prepare idle cached session");
      sessions.push(prepared.sessionId);
    }
    const targetSession = sessions[0]!;
    assert.equal(f.client.runtimeSnapshots().length, 8, "use the actual default cache capacity");
    const due = initialTime + 60_000;
    for (const definition of [
      { automationId: "target", prompt: targetPrompt, sessionId: targetSession, at: due },
      { automationId: "independent", prompt: independentPrompt, sessionId: undefined, at: due + 1 }
    ]) {
      const created = await bounded(f.client.automationCreate({
        automationId: definition.automationId, name: definition.automationId, triggerType: "once",
        schedule: { at: new Date(definition.at).toISOString() },
        executionTemplate: { prompt: definition.prompt, sessionId: definition.sessionId }
      }), "create future automation");
      assert.equal(created.accepted, true, JSON.stringify(created));
    }
    assert.deepEqual(await bounded(f.client.automationPending(), "confirm no early fire"), []);
    const cached = await bounded(f.client.listRuntimeSessions(), "confirm target is the oldest eviction candidate");
    const secondary = cached.filter(entry => !entry.primary).sort((left, right) => left.lastActiveAt - right.lastActiveAt);
    assert.equal(secondary[0]?.sessionId, targetSession, JSON.stringify(cached.map(entry => ({ sessionId: entry.sessionId, primary: entry.primary, lastActiveAt: entry.lastActiveAt }))));
    assert.equal(secondary[0]?.snapshot.state.kind, "idle");
    assert.equal(secondary[0]?.snapshot.queuedMessages?.length ?? 0, 0);
    // Both become due before the next natural poll; scheduled order selects the
    // existing target first, followed by the independent new runtime.
    context.mock.timers.setTime(due + 1);
    let fires: AutomationPendingFire[] = [];
    await waitFor(async () => {
      fires = await bounded(f.client.automationPending(), "observe both fire outcomes") as AutomationPendingFire[];
      return ["target", "independent"].every(id => fires.some(fire => fire.automationId === id && (fire.status === "completed" || fire.status === "failed")));
    }, () => `No terminal fire result: ${JSON.stringify({ fires, calls: f.calls, failures: f.transportFailures.map(String) })}`);
    assert.equal(fires.find(fire => fire.automationId === "target")?.status, "completed", JSON.stringify(fires));
    assert.equal(fires.find(fire => fire.automationId === "independent")?.status, "completed", JSON.stringify(fires));
    assert.deepEqual(f.calls, { target: 1, independent: 1, later: 0 });
    const definitions = await bounded(f.client.automationList(), "read consumed once schedules") as AutomationRecord[];
    assert.ok(definitions.every(definition => definition.fireCount === 1 && definition.nextFireAt === undefined));

    // A later natural poll is an observable no-replay witness, not a fixed sleep.
    const created = await bounded(f.client.automationCreate({
      automationId: "later", name: "later", triggerType: "once",
      schedule: { at: new Date(due + 1_000).toISOString() }, executionTemplate: { prompt: laterPrompt }
    }), "create later poll witness");
    assert.equal(created.accepted, true, JSON.stringify(created));
    context.mock.timers.setTime(due + 1_000);
    await waitFor(async () => {
      fires = await bounded(f.client.automationPending(), "observe later poll") as AutomationPendingFire[];
      return fires.some(fire => fire.automationId === "later" && fire.status === "completed");
    }, () => `Later poll did not complete: ${JSON.stringify(fires)}`);
    assert.deepEqual(f.calls, { target: 1, independent: 1, later: 1 });
    assert.equal(fires.filter(fire => fire.automationId === "target").length, 1);

    // Successful completion must release the temporary residency, not turn the
    // runtime into a permanently pinned cache entry.
    for (let index = 0; index < 8; index += 1) {
      context.mock.timers.setTime(due + 2_000 + index);
      await bounded(f.client.ensureSession({ writeIntent: false, focus: false }), "exercise post-completion LRU");
    }
    assert.equal(f.client.runtimeSnapshots().some(entry => entry.sessionId === targetSession), false);
    assert.deepEqual(f.transportFailures, []);
  } finally { await f.close(); }
});
