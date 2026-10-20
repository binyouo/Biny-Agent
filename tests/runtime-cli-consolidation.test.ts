/** Real Host, shell CLI and persistence; the model endpoint stays local. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";

for (const executionMode of ["direct", "code_mode"] as const) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-cli-consolidation-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const removed = ["recall_memory", "save_memory", "search_history", "skill_lookup", "skill_search", "skill_install", "TaskMessage", "TaskContinue"];
  const cli = path.resolve("src/cli/index.ts");
  const loader = createRequire(import.meta.url).resolve("tsx");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const biny = [process.execPath, "--import", loader, cli].map(quote).join(" ");
  const skillDir = path.join(root, ".agents", "skills", "live-skill");
  const skillText = "---\nname: live-skill\ndescription: live activation fixture\n---\n\nActivated fixture content\n";
  const command = `mkdir -p ${quote(skillDir)} && printf %s ${quote(skillText)} > ${quote(path.join(skillDir, "SKILL.md"))} && ${biny} memory add 'cli-live-marker' --json && ${biny} memory list --json && ${biny} history search 'history-live-marker' --json && ${biny} skill list --query "live activation" --json`;
  let modelSteps = 0;
  let mainSchemaChecked = false;
  let catalog: string[] = [];
  const failures: unknown[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let delta: Record<string, unknown>;
      let reason = "stop";
      if (!Array.isArray(body.tools)) delta = { content: '{"tools":[]}' };
      else {
        const names = body.tools.map((entry: { function: { name: string } }) => entry.function.name);
        for (const name of removed) assert.ok(!names.includes(name), `${name} must not be declared`);
        mainSchemaChecked = true;
        const step = modelSteps++;
        if (step === 0) {
          const name = executionMode === "direct" ? "Bash" : "run_script";
          assert.ok(names.includes(name));
          const args = name === "Bash" ? { command } : { description: "Run fixture workflow", code: `const result = await tools.Bash(${JSON.stringify({ command })}); return result.stdout.match(/cli-live-marker|history-live-marker|live-skill/g);` };
          delta = { tool_calls: [{ index: 0, id: "cli-live", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
          reason = "tool_calls";
        } else if (step === 1) {
          const result = JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "tool"));
          if (executionMode === "code_mode") assert.doesNotMatch(result, /stdout|stderr/u, "raw child command envelope must not reach the provider");
          assert.match(result, /cli-live-marker/u, `active-turn CLI write must reach the next model step: ${result}`);
          assert.match(result, /history-live-marker/u, "current user text must already be indexed by the CLI");
          assert.match(result, /live-skill/u, "CLI installed-skill search sees newly written metadata");
          assert.doesNotMatch(result, /Session is busy|isError.*true/u);
          const name = executionMode === "direct" ? "ToolSearch" : "run_script";
          const args = name === "ToolSearch" ? { query: "Skill" } : { description: "Run fixture workflow", code: "return await searchTools('Skill');" };
          delta = { tool_calls: [{ index: 0, id: "discover-skill", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
          reason = "tool_calls";
        } else if (step === 2) {
          assert.ok(names.includes("Skill"));
          delta = { tool_calls: [{ index: 0, id: "load-skill", type: "function", function: { name: "Skill", arguments: JSON.stringify({ skill: "live-skill" }) } }] };
          reason = "tool_calls";
        } else {
          assert.match(JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "tool")), /Activated fixture content/u);
          delta = { content: "Completed." };
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: reason }] }]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) { failures.push(error); response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
  let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
  try {
    await saveConfig(root, configSchema.parse({
      ...defaultConfig, defaultModel: "fixture", thinking: { ...defaultConfig.thinking, enabled: false },
      agent: { ...defaultConfig.agent, toolExecutionMode: executionMode },
      permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [], criticalAlwaysAsk: false },
      providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "local", model: "fixture", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true } }
    }));
    host = await startRuntimeHost(root, async (resourceRegistry) => {
      const entry = await createInteractiveAgentHost(root, { resourceRegistry });
      catalog = entry.commands.listTools().map((tool) => tool.name);
      return entry;
    });
    for (const name of removed) assert.ok(!catalog.includes(name), `${name} must be absent from the runtime catalog`);
    client = await connectRuntimeHost(root, { surface: "cli", clientId: "cli-consolidation" });
    assert.ok(client);
    const optimizations: unknown[] = [];
    const stop = client.subscribe(update => {
      if (update.event?.type === "tool.completed" && update.event.tool === "run_script") {
        optimizations.push(update.event.optimization);
        assert.ok(update.event.modelResult, "Host transports the exact script result projection");
      }
    });
    const outcome = await client.submitPrompt("history-live-marker: save the local marker using CLI").completion;
    stop();
    assert.equal(optimizations.length, executionMode === "code_mode" ? 2 : 0);
    assert.ok(optimizations.every(value => value && typeof value === "object" && "kind" in value && value.kind === "ptc"));
    assert.equal(outcome.status, "completed", JSON.stringify({ outcome, failures: failures.map(String) }));
    assert.deepEqual(failures, []);
    assert.ok(mainSchemaChecked);
    assert.equal(modelSteps, 4);
    const list = await client.memory<{ entries: { content: string }[] }>("list", { limit: 10 });
    assert.ok(list.entries.some((entry) => entry.content === "cli-live-marker"));
    const snapshot = client.getSnapshot();
    const events = await readFile(snapshot.info.sessionFile, "utf8");
    assert.match(events, /"tool":"Bash"/u);
  } finally {
    await client?.close();
    await host?.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
console.log("Runtime CLI consolidation passed in direct and Code Mode");
