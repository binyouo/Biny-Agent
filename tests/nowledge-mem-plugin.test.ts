import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamContext } from "../src/agent/core/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { PluginLifecycleRegistry } from "../src/extensions/pluginLifecycle.js";
import { parsePluginRegistry } from "../src/extensions/pluginRegistry.js";
import { loadPlugins } from "../src/extensions/plugins.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolAccesses } from "../src/tools/access.js";
import type { Tool } from "../src/tools/types.js";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "biny-nowledge-mem-plugin-"));
  const workspaceRoot = path.join(sandbox, "workspace");
  const pluginRoot = path.join(workspaceRoot, "plugins", "nowledge-mem");
  const priorAgentDir = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(sandbox, "global");
  await mkdir(pluginRoot, { recursive: true });
  await ensureAgentDirs(workspaceRoot);

  let agent: AgentSession | undefined;
  try {
    const market = parsePluginRegistry(JSON.parse(await readFile(path.join(repoRoot, "plugins", "registry.json"), "utf8")) as unknown);
    assert.ok(market.plugins.some((plugin) => plugin.id === "nowledge-mem"));
    const lifecycleFailures: string[] = [];
    const failingLifecycle = new PluginLifecycleRegistry((pluginPath, phase) => lifecycleFailures.push(`${pluginPath}:${phase}`));
    failingLifecycle.register({
      beforeTurn: () => { throw new Error("offline"); },
      afterTurn: () => { throw new Error("offline"); }
    }, "fixture/index.mjs");
    assert.deepEqual(await failingLifecycle.beforeTurn({
      workspaceRoot, sessionId: "failure-isolation", userMessage: "hello", useMemories: true, contributeMemories: true
    }), []);
    await failingLifecycle.afterTurn({
      workspaceRoot,
      sessionId: "failure-isolation",
      userMessage: "hello",
      useMemories: true,
      contributeMemories: true,
      outcome: { status: "completed", stopReason: "model_stop", steps: 1, output: "ok" },
      messages: []
    });
    assert.deepEqual(lifecycleFailures, ["fixture/index.mjs:beforeTurn", "fixture/index.mjs:afterTurn"]);

    await copyFile(path.join(repoRoot, "plugins", "nowledge-mem", "index.mjs"), path.join(pluginRoot, "index.mjs"));
    const config = configSchema.parse({
      ...defaultConfig,
      extensions: {
        ...defaultConfig.extensions,
        mcp: {
          "nowledge-mem": {
            type: "http",
            url: "http://127.0.0.1:14242/mcp",
            transportProtocol: "streamable-http",
            enabled: true
          }
        }
      },
      context: {
        ...defaultConfig.context,
        memory: { ...defaultConfig.context.memory, useMemories: true, generateMemories: true }
      },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false }
    });
    const lifecycle = new PluginLifecycleRegistry();
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    const callMcpTool = async (server: string, tool: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ server, tool, args });
      return { content: [{ type: "text", text: tool === "memory_search" ? "Search result: keep build output readable." : "Working note: prefer concise build logs." }] };
    };
    const toolRegistry = new ToolRegistry();
    for (const name of ["read_context_bundle", "memory_search", "sync_thread"]) {
      toolRegistry.registerMcpTool(createFixtureMcpTool(name, (args) => {
        calls.push({ server: "nowledge-mem", tool: name, args });
        if (name === "sync_thread") return { ok: true };
        const text = name === "memory_search"
          ? "Search result: keep build output readable."
          : "Working note: prefer concise build logs.";
        return { content: [{ type: "text", text }] };
      }));
    }
    await loadPlugins(workspaceRoot, ["plugins/nowledge-mem"], config, toolRegistry, new AiRegistry(), lifecycle);
    assert.equal(lifecycle.hasBeforeTurn, true);
    assert.equal(lifecycle.hasAfterTurn, true);
    assert.deepEqual(await lifecycle.beforeTurn({
      workspaceRoot, sessionId: "disabled-memory", userMessage: "Do not retrieve", useMemories: false, contributeMemories: false
    }, callMcpTool), []);
    await lifecycle.afterTurn({
      workspaceRoot,
      sessionId: "disabled-memory",
      userMessage: "Do not sync",
      useMemories: false,
      contributeMemories: false,
      outcome: { status: "completed", stopReason: "model_stop", steps: 1, output: "" },
      messages: []
    }, callMcpTool);
    assert.deepEqual(calls, [], "Biny's memory opt-outs must suppress external retrieval and sync");

    let boundedSearchQuery = "";
    await lifecycle.beforeTurn({
      workspaceRoot,
      sessionId: "bounded-query",
      userMessage: "记忆".repeat(251),
      useMemories: true,
      contributeMemories: false
    }, async (_server, tool, args) => {
      if (tool === "memory_search") boundedSearchQuery = String(args.query ?? "");
      return { content: [] };
    });
    assert.equal([...boundedSearchQuery].length, 500,
      "memory search query must respect Nowledge Mem's 500-character MCP schema limit");

    let retrievedContext: string[] = [];
    const runBeforeTurn = lifecycle.beforeTurn.bind(lifecycle);
    lifecycle.beforeTurn = async (input, runtimeCaller) => {
      retrievedContext = await runBeforeTurn(input, runtimeCaller);
      return retrievedContext;
    };

    const requests: ModelStreamContext[] = [];
    const model: AgentModel = testModel({
      provider: "fixture",
      modelId: "nowledge-mem-fixture",
      async stream(context) {
        requests.push(context);
        return (async function* () {
          yield { type: "text-delta" as const, text: "I will keep the build output readable." };
          yield { type: "finish" as const, reason: "stop" as const };
        })();
      }
    });
    const recorder = new SessionRecorder(workspaceRoot, "stable-nowledge-thread");
    agent = new AgentSession({
      workspaceRoot,
      config,
      model,
      toolRegistry,
      permissionManager: new PermissionManager(config.permission),
      recorder,
      pluginLifecycle: lifecycle
    });
    await agent.initialize();
    const userInput = "How should I format build output?";
    let outcome;
    for await (const event of agent.prompt(userInput)) {
      if (event.type === "done") outcome = event.outcome;
    }
    assert.equal(outcome?.status, "completed");
    assert.equal(requests.length, 1);
    assert.ok(retrievedContext[0]?.includes("Working note: prefer concise build logs."), "plugin should return context to the prompt adapter");
    const promptUserMessage = requests[0]?.messages.at(-1);
    assert.ok(requests[0]?.systemPrompt?.includes("Working note: prefer concise build logs."));
    assert.ok(requests[0]?.systemPrompt?.includes("Search result: keep build output readable."));
    assert.equal(promptUserMessage?.role, "user");
    assert.ok(JSON.stringify(promptUserMessage?.content).includes(userInput), "external memory retains the user input in the model request");

    await agent.close();
    agent = undefined;
    const sync = calls.find((call) => call.tool === "sync_thread");
    assert.ok(sync, "a completed user turn should sync the active Biny thread");
    assert.equal(sync.server, "nowledge-mem");
    assert.equal(sync.args.thread_id, "stable-nowledge-thread");
    assert.equal(sync.args.source, "biny");
    const messages = sync.args.messages as Array<{ id: string; role: string; content: string }>;
    assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: userInput },
      { role: "assistant", content: "I will keep the build output readable." }
    ]);
    assert.ok(messages.every((message) => message.id.length > 0), "sync must use stable session message IDs");
    assert.deepEqual(new Set(calls.map((call) => call.tool)), new Set(["read_context_bundle", "memory_search", "sync_thread"]));
    const contextCall = calls.find((call) => call.tool === "read_context_bundle");
    assert.ok(contextCall);
    assert.equal(contextCall.args.source_app, "biny");
    assert.equal("agent_id" in contextCall.args, false,
      "the plugin must leave Nowledge Mem agent identity at the user's configured default");
    assert.equal("host_agent_id" in contextCall.args, false,
      "the plugin must not invent a host agent identity without a stable Biny identity contract");
    const persisted = await readFile(recorder.filePath, "utf8");
    const events = persisted.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; content?: string });
    assert.equal(events.some((event) => event.type === "user_message" && event.content?.includes("Working note:")), false,
      "retrieved context must not rewrite the saved user message");
    assert.equal(events.some((event) => event.type === "assistant_message" && event.content?.includes("Working note:")), false,
      "retrieved context must not be persisted as conversation text");
    assert.ok(events.filter((event) => event.type === "tool_call").length >= 3,
      "automatic MCP operations must be recorded through Biny's tool execution path");
  } finally {
    await agent?.close();
    if (priorAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = priorAgentDir;
    await rm(sandbox, { recursive: true, force: true });
  }
}

function createFixtureMcpTool(name: string, run: (args: Record<string, unknown>) => unknown): Tool {
  return {
    name: `mcp_nowledge_mem_${name}`,
    description: `Fixture MCP ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    schema: z.record(z.string(), z.unknown()),
    mcpIdentity: { serverName: "nowledge-mem", toolName: name },
    capability: "mcp:nowledge-mem",
    namespace: { name: "nowledge-mem" },
    exposure: "deferred",
    risk: "read",
    resolveExecution(args) {
      return {
        approvalRule: `mcp:nowledge-mem:${name}`,
        accesses: ToolAccesses.none(),
        retrySafety: "safe",
        description: `Fixture MCP ${name}`,
        display: { kind: "generic", summary: `MCP nowledge-mem/${name}`, detail: args },
        execute: async () => run(args as Record<string, unknown>)
      };
    }
  };
}

await main();
