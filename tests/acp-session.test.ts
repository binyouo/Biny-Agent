import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ensureAgentDirs } from "../src/session/store.js";

test("ACP public session sends two turns to one real child and durably records the external replies", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-"));
  await ensureAgentDirs(root);
  const config = configSchema.parse({ ...defaultConfig,
    defaultModel: "external", providers: { external: { type: "acp", acp: {
      command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")]
    } } }, models: { external: { provider: "external", model: "default" } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false }
  });
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, permissionManager: new PermissionManager(), toolRegistry: new ToolRegistry(), model: new ModelRuntime(config).createModelSettings().model });
  try {
    await agent.initialize();
    assert.equal((await agent.runTask("hello")).output, "Reply 1");
    assert.equal((await agent.runTask("again")).output, "Reply 2");
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    assert.equal(events.filter((e) => e.type === "user_message").length, 2);
    assert.equal(events.filter((e) => e.type === "turn_status" && e.status === "completed").length, 2);
    assert.ok(events.some((e) => e.type === "assistant_message" && e.content === "Reply 2"));
    const target = events.find((event) => event.type === "user_message")!;
    assert.ok("messageId" in target && target.messageId);
    const beforeRetry = await readFile(recorder.filePath, "utf8");
    await assert.rejects(async () => { for await (const event of agent.retry(target.messageId!)) void event; }, /ACP.*重放/u);
    assert.equal(await readFile(recorder.filePath, "utf8"), beforeRetry, "unsupported retry must not change the active message branch");

    const refused = await agent.runTask("refusal-fixture");
    assert.equal(refused.status, "incomplete");
    assert.equal(refused.stopReason, "content_filter");
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP Runtime permission decisions persist one external tool result, restore sessions and never dispatch Biny tools", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-runtime-"));
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
    providers: { external: { type: "acp", acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } } },
    models: { external: { provider: "external", model: "default" } },
    permission: { ...defaultConfig.permission, mode: "ask" },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false },
    extensions: { ...defaultConfig.extensions, skills: [] }
  });
  const open = () => createCommandRuntime(root, { sessionId: "acp-runtime-session", resourceBoot: "blocking",
    configStore: { load: async () => structuredClone(config), save: async () => { throw new Error("No configuration writes"); } } });
  let runtime: Awaited<ReturnType<typeof open>> | undefined;
  try {
    runtime = await open();
    const denied = await runtime.agent.runTask("permission-fixture", { confirmPermission: async () => ({ approved: false }) });
    assert.equal(denied.status, "blocked");
    await assert.rejects(readFile(path.join(root, "effect.txt")), { code: "ENOENT" });
    assert.equal((await runtime.agent.runTask("permission-fixture", { confirmPermission: async () => ({ approved: true }) })).status, "completed");
    assert.equal(await readFile(path.join(root, "effect.txt"), "utf8"), "one external write");
    await runtime.close();
    runtime = await open();
    assert.equal((await runtime.agent.runTask("after restart", { promptContext: "explicit Biny context" })).output, "Reply 1");
    const requests = (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "session/load").length, 1);
    const prompts = requests.filter((r) => r.method === "session/prompt");
    assert.equal(prompts.length, 3, "recovery must not replay previous prompts");
    assert.deepEqual(prompts.at(-1).params.prompt, [{ type: "text", text: "explicit Biny context" }, { type: "text", text: "after restart" }]);
    const events = await readSessionEvents(runtime.agent.getInfo().sessionFile);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    assert.equal(toolCalls.length, 2);
    assert.equal(new Set(toolCalls.map((e) => e.toolCallId)).size, 2, "agent-local IDs must not collide across turns");
    assert.equal(events.filter((e) => e.type === "tool_result").length, 2);
    const sessionFile = runtime.agent.getInfo().sessionFile;
    await runtime.close();
    for (const name of await readdir(path.dirname(sessionFile))) {
      if (name.startsWith(path.basename(sessionFile)) && name.endsWith(".acp.json")) await rm(path.join(path.dirname(sessionFile), name));
    }
    runtime = await open();
    const missing = await runtime.agent.runTask("do not silently start over");
    assert.equal(missing.status, "failed", "a missing binding must not erase the external conversation while local history remains");
    assert.match(missing.error ?? "", /关联.*缺失/u);

  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP cancellation and process exit produce durable terminal outcomes", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-outcome-"));
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
    providers: { external: { type: "acp", acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } } },
    models: { external: { provider: "external", model: "default" } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false } });
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, permissionManager: new PermissionManager(), toolRegistry: new ToolRegistry(), model: new ModelRuntime(config).createModelSettings().model });
  try {
    await agent.initialize();
    const controller = new AbortController();
    let status;
    for await (const event of agent.prompt("wait-fixture", { abortSignal: controller.signal })) {
      if (event.type === "assistant.delta") controller.abort();
      if (event.type === "done") status = event.outcome.status;
    }
    assert.equal(status, "cancelled");
    assert.equal((await agent.runTask("crash-fixture")).status, "failed");
    const events = await readSessionEvents(recorder.filePath);
    assert.deepEqual(events.filter((e) => e.type === "turn_status").map((e) => e.status), ["cancelled", "failed"]);
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
});

test("changing the saved model selects the external execution engine on the very next runtime turn", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-switch-"));
  let config = configSchema.parse({ ...defaultConfig, defaultModel: "api-model",
    providers: { api: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false }, external: {
      type: "acp", acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } } },
    models: { "api-model": { provider: "api", model: "fixture" }, external: { provider: "external", model: "default" } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false } });
  let runtime: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
  try {
    runtime = await createCommandRuntime(root, { resourceBoot: "blocking", configStore: {
      load: async () => structuredClone(config), save: async () => { throw new Error("No configuration writes"); }
    } });
    config = { ...config, defaultModel: "external" };
    const outcome = await runtime.agent.runTask("new engine");
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(outcome.output, "Reply 1");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
