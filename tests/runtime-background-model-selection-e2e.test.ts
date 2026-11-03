import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { markReflectionDate } from "../src/agent/context/reflectionDates.js";
import { readSessionEvents } from "../src/session/events.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

function respond(response: ServerResponse, delta: Record<string, unknown>, finishReason: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}

for (const route of ["heartbeat", "tool"] as const) {
  test(`${route} reads the saved model for each new run and pins it within that run`, { timeout: 20_000 }, async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-background-model-selection-"));
    const previousRoot = process.env.BINY_AGENT_DIR;
    const previousPrimaryKey = process.env.BINY_TEST_PRIMARY_MODEL_KEY;
    process.env.BINY_AGENT_DIR = path.join(root, "global");
    process.env.BINY_TEST_PRIMARY_MODEL_KEY = "isolated-fixture-key";
    const firstRequest = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const models: string[] = [];
    const server = createServer((request, response) => { void (async () => {
      let content = "";
      for await (const chunk of request) content += String(chunk);
      const body = JSON.parse(content) as { model: string; messages: Array<{ role: string }> };
      if (request.headers["x-biny-operation"] !== "agent") {
        respond(response, { content: JSON.stringify({ tools: ["Read"], skillIds: [] }) }, "stop");
        return;
      }
      models.push(body.model);
      if (models.length === 1) { firstRequest.resolve(); await release.promise; }
      if (body.messages.at(-1)?.role === "tool") {
        respond(response, { content: "HEARTBEAT_OK" }, "stop");
      } else {
        respond(response, { tool_calls: [{ index: 0, id: `read-${models.length}`, type: "function", function: {
          name: "Read", arguments: JSON.stringify({ path: "note.txt" })
        } }] }, "tool_calls");
      }
    })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let commands: CommandRuntime | undefined;
    let interactive: InteractiveAgentRuntime | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      await writeFile(path.join(workspace, "note.txt"), "model selection fixture");
      await mkdir(process.env.BINY_AGENT_DIR!, { recursive: true });
      for (let offset = -1; offset <= 4; offset++) {
        await markReflectionDate(new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10));
      }
      const store = () => createFileConfigStore(workspace, { globalDir: path.join(root, "config"), credentialStore: {
        persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {}
      } });
      const writer = store();
      await writer.save(configSchema.parse({ ...defaultConfig, defaultModel: "main-old", toolModel: "tool-old",
        agent: { ...defaultConfig.agent, toolExecutionMode: "direct" },
        providers: {
          local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } },
          primary: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "BINY_TEST_PRIMARY_MODEL_KEY", retry: { maxAttempts: 1 } }
        },
        models: Object.fromEntries(["main-old", "main-new", "tool-old", "tool-new"].map(model => [model, {
          provider: model.startsWith("main-") ? "primary" : "local", model, contextWindow: 128_000, capabilities: { tools: true, reasoning: false, streaming: true }
        }])),
        thinking: { ...defaultConfig.thinking, enabled: false },
        permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
        checkpoints: { enabled: false },
        chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
        extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
        context: { ...defaultConfig.context, identity: { enabled: false, userEnabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
        activity: { ...defaultConfig.activity, enabled: false },
        heartbeat: { ...defaultConfig.heartbeat, enabled: false, timezone: "UTC" }
      }));
      const reader = store();
      commands = await createCommandRuntime(workspace, { configStore: reader });
      if (route === "tool") interactive = new InteractiveAgentRuntime(commands);
      const run = async () => route === "heartbeat" ? await commands!.heartbeat.triggerNow()
        : (await interactive!.submitPrompt("Read the note", [], undefined, undefined, { tools: ["Read"], skills: "none" }, "tool").completion).status === "completed";
      timer = setTimeout(() => {
        firstRequest.reject(new Error("The first model request did not arrive before the test deadline."));
        release.resolve();
      }, 15_000);
      const first = run();
      await Promise.race([firstRequest.promise, first.then(() => { throw new Error("The first run ended before its model request."); })]);
      await updateConfig(writer, workspace, config => ({ ...config, toolModel: "tool-new", defaultModel: "main-new" }));
      delete process.env.BINY_TEST_PRIMARY_MODEL_KEY;
      release.resolve();
      assert.equal(await first, true, "tool continuation does not prepare an unrelated primary connection");
      assert.deepEqual(models, ["tool-old", "tool-old"], "a saved selection cannot alter a running tool step");
      assert.equal(await run(), true);
      assert.deepEqual(models, ["tool-old", "tool-old", "tool-new", "tool-new"], "the next run must use the saved tool model without recreating Runtime");
      process.env.BINY_TEST_PRIMARY_MODEL_KEY = "isolated-fixture-key";
      if (route === "heartbeat") {
        await writeFile(path.join(process.env.BINY_AGENT_DIR!, "HEARTBEAT.md"), "DAILY DIARY TIME: review the note.");
        assert.equal(await run(), true);
        assert.deepEqual(models.slice(-2), ["main-new", "main-new"], "diary runs also resolve the latest primary selection");
      } else {
        const configFile = path.join(root, "config", "config.json");
        const savedDocument = await readFile(configFile, "utf8");
        try {
          await writeFile(configFile, "{invalid configuration");
          const failed = await interactive!.submitPrompt("configuration read failure", [], undefined, undefined,
            { tools: "none", skills: "none" }, "tool").completion;
          assert.equal(failed.status, "failed");
          assert.match(failed.error ?? "", /Failed to load config.json/u);
        } finally { await writeFile(configFile, savedDocument); }

        const entered = Promise.withResolvers<void>();
        const continueLoad = Promise.withResolvers<void>();
        const load = reader.load.bind(reader);
        const pausedLoad = context.mock.method(reader, "load", async workspaceRoot => {
          entered.resolve();
          await continueLoad.promise;
          return await load(workspaceRoot);
        });
        const deadline = setTimeout(() => {
          entered.reject(new Error("The model configuration read did not start before the test deadline."));
          continueLoad.resolve();
        }, 5_000);
        try {
          const cancelled = interactive!.submitPrompt("cancel during configuration read", [], undefined, undefined,
            { tools: "none", skills: "none" }, "tool");
          await Promise.race([entered.promise, cancelled.completion.then(() => { throw new Error("The run ended before configuration read."); })]);
          assert.equal(interactive!.cancelRun(cancelled.runId, "cancelled"), true);
          continueLoad.resolve();
          assert.equal((await cancelled.completion).status, "cancelled");
        } finally {
          clearTimeout(deadline);
          continueLoad.resolve();
          pausedLoad.mock.restore();
        }
        assert.equal(models.length, 4, "failed or cancelled preparation cannot send a model request");
        const events = await readSessionEvents(commands.agent.getSessionRecorder().filePath);
        assert.ok(events.some(event => event.type === "user_message" && event.content === "configuration read failure"));
        assert.ok(events.some(event => event.type === "user_message" && event.content === "cancel during configuration read"));
        assert.equal(interactive!.getSnapshot().state.kind, "idle");
      }
    } finally {
      clearTimeout(timer);
      release.resolve();
      if (interactive) await interactive.close(); else await commands?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousRoot;
      if (previousPrimaryKey === undefined) delete process.env.BINY_TEST_PRIMARY_MODEL_KEY; else process.env.BINY_TEST_PRIMARY_MODEL_KEY = previousPrimaryKey;
      await removeTestRoot(root, { recursive: true, force: true });
    }
  });
}
