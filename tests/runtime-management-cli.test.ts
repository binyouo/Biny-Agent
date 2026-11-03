import { readyHostClient } from "./helpers/readyHostClient.js";
import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
/** Foreground CLI management reaches the owning Host without a second session writer. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, realpath, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";

for (const executionMode of ["direct", "code_mode"] as const) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-management-cli-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const loader = createRequire(import.meta.url).resolve("tsx");
  const biny = [process.execPath, "--import", loader, path.resolve("src/cli/index.ts")].map(quote).join(" ");
  const todos = [{ content: "Finish CLI management", status: "in_progress" }];
  const scopeFile = path.join(root, "scope.json");
  const saveScope = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(scopeFile)}, JSON.stringify({scope:process.env.BINY_AGENT_CONTEXT,sessionId:process.env.BINY_AGENT_SESSION_ID}))`].map(quote).join(" ");
  const command = `${saveScope} && ${biny} todo replace --todos ${quote(JSON.stringify(todos))} --json && ${biny} todo show --json`;
  const removed = ["recall_memory", "save_memory", "search_history", "skill_lookup", "skill_search", "skill_install", "TaskMessage", "TaskContinue", "GoalGet", "GoalUpdate", "PlanDraft", "PlanStart", "PlanStatus", "PlanUpdate", "TodoWrite", "TaskCancel"];
  let steps = 0;
  let phase: "todo" | "plan" | "task" | "supervision" = "todo";
  let planSteps = 0;
  let planId = "";
  let supervisionSteps = 0;
  let taskSteps = 0;
  let ownedTaskId = "";
  let foreignTaskId = "";
  let runtime: Awaited<ReturnType<typeof createInteractiveAgentHost>> | undefined;
  function shellResult(body: { messages: Array<{ role: string; content: string }> }): { stdout: string; stderr: string; exitCode: number } {
    const message = body.messages.findLast(entry => entry.role === "tool");
    assert.ok(message);
    let value = JSON.parse(message.content);
    if (Array.isArray(value)) value = JSON.parse(value.map((part: { text?: string }) => part.text ?? "").join(""));
    return value.ok === false ? { stdout: "", stderr: String(value.error), exitCode: 1 } : value.value ?? value;
  }
  const failures: unknown[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let delta: Record<string, unknown>;
      let reason = "stop";
      if (!Array.isArray(body.tools)) delta = { content: '{"tools":[]}' };
      else if (phase === "task") {
        if (taskSteps > 0) {
          const result = shellResult(body);
          if (taskSteps === 1) {
            assert.equal(result.exitCode, 1);
            assert.match(result.stderr, /another session/u);
            assert.equal(runtime!.commands.taskRuns.get(foreignTaskId)!.status, "created");
          } else {
            assert.equal(result.exitCode, 0, result.stderr);
            assert.equal(JSON.parse(result.stdout).status, "cancelled");
          }
        }
        if (taskSteps < 2) {
          const command = `${biny} task cancel ${quote(taskSteps === 0 ? foreignTaskId : ownedTaskId)} --json`;
          const name = executionMode === "direct" ? "Bash" : "run_script";
          const args = name === "Bash" ? { command } : { description: "Run fixture workflow", code: `return await tools.Bash(${JSON.stringify({ command })});` };
          delta = { tool_calls: [{ index: 0, id: `task-cli-${taskSteps}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
          reason = "tool_calls";
        } else delta = { content: "owned task cancelled" };
        taskSteps++;
      }
      else if (phase === "plan") {
        let planCommand: string | undefined;
        if (planSteps === 0) planCommand = `${biny} plan draft --input ${quote(JSON.stringify({ objective: "Inspect and report", nodes: [{ key: "read", task: "Read source", acceptance: ["Cite source"] }, { key: "report", task: "Report findings", acceptance: ["Cite evidence"], dependencies: ["read"] }] }))} --json`;
        else if (planSteps === 1) {
          const result = shellResult(body);
          assert.equal(result.exitCode, 0, result.stderr);
          planId = JSON.parse(result.stdout).graphId;
          assert.ok(planId);
          planCommand = `${biny} plan update --input ${quote(JSON.stringify({ graphId: planId, action: "stop" }))} --json`;
        } else if (planSteps === 2) {
          const result = shellResult(body);
          assert.equal(result.exitCode, 1, JSON.stringify(result));
          assert.match(result.stderr, /PlanStatus must be called/u);
          planCommand = `${biny} plan status ${quote(planId)} --json`;
        } else if (planSteps === 3) {
          const result = shellResult(body);
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(JSON.parse(result.stdout).status, "draft");
          assert.equal(runtime!.commands.taskRuns.list().tasks.length, 0, "draft and inspection must never dispatch workers");
          planCommand = `${biny} plan update --input ${quote(JSON.stringify({ graphId: planId, action: "stop" }))} --json`;
        } else {
          const result = shellResult(body);
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(JSON.parse(result.stdout).status, "cancelled");
        }
        planSteps++;
        if (planCommand) {
          const name = executionMode === "direct" ? "Bash" : "run_script";
          const args = name === "Bash" ? { command: planCommand } : { description: "Run fixture workflow", code: `return await tools.Bash(${JSON.stringify({ command: planCommand })});` };
          delta = { tool_calls: [{ index: 0, id: `plan-cli-${planSteps}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
          reason = "tool_calls";
        } else delta = { content: "plan cancelled" };
      } else if (phase === "supervision") {
        if (supervisionSteps++ === 0) {
          const name = executionMode === "direct" ? "Bash" : "run_script";
          const args = name === "Bash" ? { command: "touch supervisor-must-not-write" } : { description: "Run fixture workflow", code: "return await tools.Bash({command:'touch supervisor-must-not-write'});" };
          delta = { tool_calls: [{ index: 0, id: "supervisor-shell", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
          reason = "tool_calls";
        } else {
          assert.match(JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "tool")), /Plan supervision/u);
          delta = { content: "unsafe command refused" };
        }
      } else {
        if (steps++ === 0) {
          const name = executionMode === "direct" ? "Bash" : "run_script";
          const args = name === "Bash" ? { command } : { description: "Run fixture workflow", code: `return await tools.Bash(${JSON.stringify({ command })});` };
          delta = { tool_calls: [{ index: 0, id: "manage-cli", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
          reason = "tool_calls";
        } else {
          const result = shellResult(body);
          assert.equal(result.exitCode, 0, result.stderr);
          const shown: unknown = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "null");
          assert.deepEqual(shown, { sessionId: runtime!.commands.agent.getInfo().sessionId, todos });
          const output = JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "tool"));
          assert.match(output, /Finish CLI management/u);
          assert.doesNotMatch(output, /Session is busy|isError.*true|error:/iu);
          assert.match(JSON.stringify(body.messages.filter((message: { role: string }) => message.role === "system")), /Finish CLI management/u);
          delta = { content: "done" };
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { failures.push(error); response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  await saveConfig(root, configSchema.parse({
    ...defaultConfig, defaultModel: "fixture", thinking: { ...defaultConfig.thinking, enabled: false },
    agent: { ...defaultConfig.agent, toolExecutionMode: executionMode },
    permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [], criticalAlwaysAsk: false },
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { fixture: { provider: "local", model: "fixture", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true } }
  }));
  let catalog: string[] = [];
  const host = await startRuntimeHost(root, async resourceRegistry => {
    runtime = await createInteractiveAgentHost(root, { resourceRegistry });
    catalog = runtime.commands.listTools().map(tool => tool.name);
    return runtime;
  }, { createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); } });
  try {
    const client = await readyHostClient(await connectRuntimeHost(root, { surface: "cli", clientId: "management-fixture" }));

    assert.ok(client);
    try {
      const outcome = await client.submitPrompt("Use CLI to maintain the Todo list").completion;
      assert.equal(outcome.status, "completed", JSON.stringify({ outcome, failures: failures.map(String) }));
      assert.deepEqual(failures, []);
      assert.equal(steps, 2);
      for (const name of removed) assert.ok(!catalog.includes(name), `${name} must not be registered in the model catalog`);
      const captured = JSON.parse(await readFile(scopeFile, "utf8"));
      await assert.rejects(client.sessionCommand("TodoWrite", { todos: [] }, captured.sessionId, captured.scope), /expired|another run/u);
      await assert.rejects(client.sessionCommand("TodoWrite", { todos: [] }, "foreign-session", captured.scope), /expired|another run/u);
      phase = "plan";
      assert.equal((await client.submitPrompt("Draft and inspect a plan without executing workers").completion).status, "completed", failures.map(String).join("\n"));
      assert.equal(planSteps, 5);
      assert.equal(runtime!.commands.graphs.inspectGraph(planId).status, "cancelled");
      phase = "task";
      ownedTaskId = runtime!.commands.taskRuns.create({ sessionId: runtime!.commands.agent.getInfo().sessionId, task: { prompt: "Owned unstarted task" } }).taskRunId;
      foreignTaskId = runtime!.commands.taskRuns.create({ sessionId: "another-session", task: { prompt: "Foreign unstarted task" } }).taskRunId;
      assert.equal((await client.submitPrompt("Cancel only this session's task through CLI").completion).status, "completed", failures.map(String).join("\n"));
      assert.equal(taskSteps, 3);
      assert.equal(runtime!.commands.taskRuns.get(ownedTaskId)!.status, "cancelled");
      assert.equal(runtime!.commands.taskRuns.get(foreignTaskId)!.status, "created");
      phase = "supervision";
      assert.equal((await runtime!.runtime.submitSupervisionTurn!("Inspect the plan", { runId: "supervision-boundary", turnId: "supervision-boundary" }).completion).status, "completed");
      await assert.rejects(access(path.join(root, "supervisor-must-not-write")), { code: "ENOENT" });
      assert.deepEqual(failures, []);
    } finally { await client.close(); }
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
console.log("runtime management CLI tests passed");
