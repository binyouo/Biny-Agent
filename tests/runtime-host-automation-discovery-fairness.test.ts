/** Natural Host polling must discover independent work behind a busy session's durable queue. */
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

const initialTime = Date.parse("2030-01-01T00:00:00.000Z");
const heldSession = "automation-discovery-held-session";
const heldPrompt = "automation-discovery-held-request";
const independentPrompt = "automation-discovery-independent-request";
const queuedPrompt = "automation-discovery-queued-request";

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

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(condition: () => boolean | Promise<boolean>, describe: () => string): Promise<void> {
  // Date is frozen to phase the due times; the failure deadline must remain a real clock.
  const deadline = performance.now() + 5_000;
  while (!await condition()) {
    assert.ok(performance.now() < deadline, describe());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-automation-discovery-")));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  const originalFetch = globalThis.fetch;
  const entered = deferred();
  const release = deferred();
  const calls = { held: 0, independent: 0, queued: 0 };
  const transportFailures: unknown[] = [];
  const resources: {
    local?: InteractiveAgentHost;
    host?: Awaited<ReturnType<typeof startRuntimeHost>>;
    client?: NonNullable<Awaited<ReturnType<typeof connectRuntimeHost>>>;
  } = {};
  const close = async () => {
    release.resolve();
    try {
      // close() synchronously stops discovery/dispatch before its first await. The
      // queued fires remain durable, and releasing A cannot dispatch the backlog.
      const closed = await Promise.allSettled([
        resources.host ? resources.host.close() : resources.local?.runtime.close(),
        resources.client?.close()
      ]);
      const failed = closed.filter((result) => result.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Automation fixture cleanup failed.");
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
        assert.equal(String(url), "https://automation-discovery.invalid/v1/chat/completions");
        const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
        assert.equal(body.model, "fixture");
        const prompt = JSON.stringify(body.messages);
        if (prompt.includes("You analyze chat conversation sentiment")) return textResponse("No emotion update.");
        if (prompt.includes(heldPrompt)) {
          calls.held += 1;
          entered.resolve();
          await release.promise;
          return textResponse("Held automation completed.");
        }
        if (prompt.includes(independentPrompt)) {
          calls.independent += 1;
          return textResponse("Independent automation completed.");
        }
        assert.ok(prompt.includes(queuedPrompt), "Only fixture conversation requests are expected.");
        calls.queued += 1;
        return textResponse("Queued automation completed.");
      } catch (error) { transportFailures.push(error); throw error; }
    };
    const config = configSchema.parse({
      ...structuredClone(defaultConfig),
      defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: {
        type: "openai-compatible", baseUrl: "https://automation-discovery.invalid/v1", requiresApiKey: false,
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
      const local = await createInteractiveAgentHost(root, { sessionId: heldSession, configStore, resourceRegistry });
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
    const client = await connectRuntimeHost(root, { configDir, clientId: "automation-discovery-observer", surface: "cli" });
    assert.ok(client);
    resources.client = client;
    return { client, entered, release, calls, transportFailures, close };
  } catch (error) { await close(); throw error; }
}

for (const backlogSize of [31, 32]) {
  test(`natural Host polling discovers independent automation behind ${backlogSize} same-session pending fires`, { timeout: 30_000 }, async (context) => {
    // Mock only Date. Real Host polling, sockets, and timeout guards keep running.
    context.mock.timers.enable({ apis: ["Date"], now: initialTime });
    const f = await fixture();
    try {
      const queueIds = Array.from({ length: backlogSize }, (_, index) => `queued-${index}`);
      const definitions = [
        { id: "held", prompt: heldPrompt, at: initialTime + 1_000, sessionId: heldSession },
        ...queueIds.map((id) => ({ id, prompt: `${queuedPrompt}-${id}`, at: initialTime + 2_000, sessionId: heldSession })),
        { id: "independent", prompt: independentPrompt, at: initialTime + 3_000, sessionId: undefined }
      ];
      // Every once time is still in the future at public creation. A slow runner
      // cannot accidentally make B due before the entire queue is established.
      for (const definition of definitions) {
        const created = await bounded(f.client.automationCreate({
          automationId: definition.id, name: definition.id, triggerType: "once",
          schedule: { at: new Date(definition.at).toISOString() },
          executionTemplate: { prompt: definition.prompt, sessionId: definition.sessionId }
        }), `create ${definition.id}`);
        assert.equal(created.accepted, true, `Automation creation was rejected: ${JSON.stringify(created)}`);
      }
      const listed = await bounded(f.client.automationList(), "list future automations") as AutomationRecord[];
      assert.equal(listed.length, backlogSize + 2);
      assert.ok(listed.every((automation) => Date.parse(automation.nextFireAt!) > initialTime));
      assert.deepEqual(await bounded(f.client.automationPending(), "check no early fires"), []);

      context.mock.timers.setTime(initialTime + 1_000);
      await bounded(f.entered.promise, "held automation reaches the external provider");
      let fires = await bounded(f.client.automationPending(), "read held fire") as AutomationPendingFire[];
      assert.equal(fires.find((fire) => fire.automationId === "held")?.status, "running");
      assert.deepEqual(f.calls, { held: 1, independent: 0, queued: 0 });

      context.mock.timers.setTime(initialTime + 2_000);
      await waitFor(async () => {
        fires = await bounded(f.client.automationPending(), "observe same-session backlog") as AutomationPendingFire[];
        return queueIds.every((id) => fires.some((fire) => fire.automationId === id && fire.status === "pending"));
      }, () => `Expected ${backlogSize} pending fires before B is due: ${JSON.stringify(fires)}`);
      assert.equal(fires.length, backlogSize + 1);
      assert.equal(fires.find((fire) => fire.automationId === "held")?.status, "running");
      assert.equal(fires.some((fire) => fire.automationId === "independent"), false);

      context.mock.timers.setTime(initialTime + 3_000);
      // This assertion must happen before the gate is released. The 31-fire
      // control leaves one discovery slot; 32 used to fill every recovery page.
      await waitFor(async () => {
        fires = await bounded(f.client.automationPending(), "observe independent fire") as AutomationPendingFire[];
        return fires.some((fire) => fire.automationId === "independent" && fire.status === "completed");
      }, () => `Independent automation did not complete while A was held; calls=${JSON.stringify(f.calls)}, fires=${JSON.stringify(fires)}, transportFailures=${JSON.stringify(f.transportFailures.map(String))}`);
      assert.equal(fires.find((fire) => fire.automationId === "held")?.status, "running");
      assert.equal(fires.filter((fire) => queueIds.includes(fire.automationId) && fire.status === "pending").length, backlogSize);
      assert.deepEqual(f.calls, { held: 1, independent: 1, queued: 0 });
      assert.deepEqual(f.transportFailures, [], "Background handling must not hide provider fixture failures.");
    } finally { await f.close(); }
  });
}
