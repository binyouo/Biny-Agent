/**
 * Real Host/public plan lifecycle, killed after the completed-report transaction
 * and before Graph projection. No production hooks; the expected SIGKILL is joined.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, renameSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost, connectRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { GraphRecord } from "../src/runtime/GoalGraphStore.js";
import type { TaskRunWithAttempts } from "../src/runtime/TaskRunStore.js";
import { readTaskDefinition } from "../src/runtime/taskVerification.js";

const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const biny = [process.execPath, "--import", createRequire(import.meta.url).resolve("tsx"), path.resolve("src/cli/index.ts")].map(shellQuote).join(" ");
const reportA = "Observation in source.txt: source fact.";
type Client = Awaited<ReturnType<typeof connectRuntimeHost>>;
type Host = Awaited<ReturnType<typeof startRuntimeHost>>;
interface Boundary {
  sessionId: string;
  graphId: string;
  taskRunId: string;
  completedTask: TaskRunWithAttempts;
  graph: GraphRecord;
  firstReports: number;
}

if (process.argv[2] === "paused-report-crash-child") {
  await crashChild(process.argv[3]!, process.argv[4]!);
} else {
  test("public graph resume reconciles a report committed before a paused Host crash", { timeout: 45_000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-paused-report-host-")));
    const originalFetch = globalThis.fetch;
    const originalAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, ".agent-test");
    let host: Host | undefined;
    let client: Client | undefined;
    let commands: CommandRuntime | undefined;
    try {
      await writeFile(path.join(root, "source.txt"), "source fact");
      const boundary = await reachAndKill(root, path.join(root, ".completed-boundary.json"));
      assert.equal(boundary.firstReports, 1);
      assert.equal(boundary.completedTask.status, "completed");
      assert.equal(boundary.graph.status, "paused");
      assert.deepEqual(boundary.graph.nodes.map((node) => node.status), ["running", "pending"]);
      assert.equal((boundary.completedTask.attempts[0]?.artifacts as { output?: unknown }).output, reportA);
      let repeatedA = 0;
      let secondReports = 0;
      globalThis.fetch = (async (_input, init): Promise<Response> => {
        const body = parseBody(init);
        const system = textContent(body.messages[0]?.content);
        if (system.includes("tool search assistant")) return streamText('{"tools":[]}');
        if (system.includes("选择需要的工具")) return streamText('{"tools":[]}');
        if (system.includes("选择需要的技能")) return streamText('{"skillIds":[]}');
        if (system.includes("focused, bounded worker inside Biny")) {
          const packet = body.messages.map((message) => textContent(message.content)).join("\n");
          if (!packet.includes("synthesize-report")) {
            repeatedA += 1;
            throw new Error("Restart must not execute the completed first report Worker.");
          }
          assert.match(packet, /Observation in source.txt: source fact/u);
          const last = body.messages.at(-1)!;
          if (last.role !== "tool") return streamToolCall("read-after-restart", "Read", { path: "source.txt" });
          assert.match(textContent(last.content), /source fact/u);
          secondReports += 1;
          return streamText("Conclusion from persisted upstream report and source.txt: source fact.");
        }
        // No plan mutations are needed to prove dependency release. The actual
        // supervisor turn may observe the settled report; final graph disposition
        // remains its responsibility and is not asserted as completed here.
        return streamText("The two report nodes are available for review.");
      }) as typeof fetch;
      const configuration = config();
      host = await startRuntimeHost(root, async () => {
        commands = await createCommandRuntime(root, {
          sessionId: boundary.sessionId,
          configStore: { load: async () => configuration, save: async () => undefined }
        });
        const runtime = new InteractiveAgentRuntime(commands);
        await runtime.resumeSession(boundary.sessionId);
        return { commands, runtime };
      });
      client = await connectRuntimeHost(root, { clientId: "paused-report-recovered", surface: "cli" });
      const paused = await client.graphInspect(boundary.graphId) as GraphRecord;
      assert.equal(paused.status, "paused");
      assert.deepEqual(paused.nodes, boundary.graph.nodes, "restart preserves paused node metadata");
      assert.equal(repeatedA, 0);
      assert.equal(secondReports, 0);
      assert.deepEqual(jsonValue(commands!.taskRuns.get(boundary.taskRunId)), boundary.completedTask);
      const resumed = await client.graphResume(boundary.graphId);
      assert.equal(resumed.accepted, true, JSON.stringify(resumed));
      let observed = await client.graphInspect(boundary.graphId) as GraphRecord;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !observed.nodes.every((node) => node.status === "completed")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        observed = await client.graphInspect(boundary.graphId) as GraphRecord;
      }
      assert.deepEqual(observed.nodes.map((node) => node.status), ["completed", "completed"],
        "successful public resume must reconcile A and release B; startup/setup errors are separate failures");
      await client.waitForIdle();
      assert.equal(repeatedA, 0);
      assert.equal(secondReports, 1);
      assert.deepEqual(jsonValue(commands!.taskRuns.get(boundary.taskRunId)), boundary.completedTask,
        "reconciliation preserves every JSON-representable task/attempt field, including output");
      const secondTask = commands!.taskRuns.get(observed.nodes[1]!.taskRunId!)!;
      assert.equal(secondTask.attempts.length, 1);
      assert.equal(secondTask.status, "completed");
      const listed = (await client.planList(boundary.sessionId)).find((plan) => plan.graphId === boundary.graphId)!;
      assert.deepEqual(listed.nodes.map((node) => node.status), ["completed", "completed"]);
      assert.deepEqual(listed.pendingApprovals, []);
      assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "source fact");
    } finally {
      // Keep the fixture provider installed while owned runtime work drains.
      try {
        try {
          await client?.close();
        } finally {
          if (host) await host.close(); else await commands?.close();
        }
      } finally {
        globalThis.fetch = originalFetch;
        if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
        else process.env.BINY_AGENT_DIR = originalAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}

async function crashChild(root: string, marker: string): Promise<void> {
  process.env.BINY_AGENT_DIR = path.join(root, ".agent-test");
  let commands: CommandRuntime | undefined;
  let sessionId: string | undefined;
  let graphId = "";
  let drafted = false;
  let firstReports = 0;
  globalThis.fetch = (async (_input, init): Promise<Response> => {
    const body = parseBody(init);
    const system = textContent(body.messages[0]?.content);
    const last = body.messages.at(-1)!;
    const names = (body.tools ?? []).map((tool) => tool.function?.name);
    if (system.includes("tool search assistant")) return streamText('{"tools":["PlanDraft"]}');
    if (system.includes("选择需要的工具")) return streamText('{"tools":[]}');
    if (system.includes("选择需要的技能")) return streamText('{"skillIds":[]}');
    if (system.includes("focused, bounded worker inside Biny")) {
      const packet = body.messages.map((message) => textContent(message.content)).join("\n");
      assert.ok(!packet.includes("synthesize-report"), "B cannot start before paused A is projected");
      if (last.role !== "tool") return streamToolCall("read-before-crash", "Read", { path: "source.txt" });
      assert.match(textContent(last.content), /source fact/u);
      const paused = await client.graphPause(graphId);
      assert.equal(paused.accepted, true, JSON.stringify(paused));
      firstReports += 1;
      return streamText(reportA);
    }
    if (!drafted) {
      if (!names.includes("Bash")) return streamToolCall("find-draft", "ToolSearch", { query: "PlanDraft" });
      drafted = true;
      return streamToolCall("draft-plan", "PlanDraft", {
        objective: "Read source evidence, then synthesize its report",
        nodes: [
          { key: "inspect", task: "Inspect source.txt and return observations", acceptance: ["Cite source.txt"] },
          { key: "synthesize", task: "synthesize-report: interpret upstream observations", acceptance: ["Cite upstream observations"], dependencies: ["inspect"] }
        ]
      });
    }
    return streamText("The report plan draft is ready.");
  }) as typeof fetch;
  const configuration = config();
  await startRuntimeHost(root, async () => {
    commands = await createCommandRuntime(root, { configStore: { load: async () => configuration, save: async () => undefined } });
    sessionId = commands.agent.getInfo().sessionId;
    const taskRuns = commands.taskRuns;
    const transition = taskRuns.transition.bind(taskRuns);
    taskRuns.transition = (...args: Parameters<typeof taskRuns.transition>) => {
      const result = transition(...args);
      const [taskRunId, status] = args;
      const task = taskRuns.get(taskRunId);
      if (status === "completed" && graphId && task?.status === "completed" && readTaskDefinition(task.task).reportOnly) {
        const graph = commands!.graphs.inspectGraph(graphId);
        assert.equal(graph.status, "paused");
        assert.equal(graph.nodes[0]?.taskRunId, taskRunId);
        assert.equal(graph.nodes[0]?.status, "running");
        const boundary: Boundary = { sessionId: sessionId!, graphId, taskRunId, completedTask: task, graph, firstReports };
        // Atomic marker publication follows the original durable transaction.
        // Synchronously park before returning to completeReport: Graph projection
        // cannot run, and no graceful shutdown can repair the missing projection.
        writeFileSync(marker + ".tmp", JSON.stringify(boundary));
        renameSync(marker + ".tmp", marker);
        const gate = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(gate, 0, 0);
        throw new Error("The committed crash boundary unexpectedly resumed.");
      }
      return result;
    };
    return { commands, runtime: new InteractiveAgentRuntime(commands) };
  });
  const client = await connectRuntimeHost(root, { clientId: "paused-report-original", surface: "cli" });
  assert.equal((await client.submitPrompt("请规划一个先读取 source.txt 再综合上游报告的后台只读分析任务，先保存草稿。").completion).status, "completed");
  const draft = (await client.planList(sessionId!))[0]!;
  graphId = draft.graphId;
  assert.equal(draft.status, "draft");
  assert.equal(commands!.taskRuns.list().tasks.length, 0);
  await client.startPlanDraft(sessionId!, graphId, draft.revision);
  await new Promise<never>(() => undefined);
}

async function reachAndKill(root: string, marker: string): Promise<Boundary> {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url),
    "paused-report-crash-child", root, marker], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Child exited before committed boundary: " + stderr);
      try {
        const boundary = JSON.parse(await readFile(marker, "utf8")) as Boundary;
        kill(child);
        await closed;
        return boundary;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Child did not reach the committed report boundary: " + stderr);
  } finally {
    kill(child);
    await closed;
  }
}

function kill(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

interface ProviderBody {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}
function parseBody(init: RequestInit | undefined): ProviderBody {
  return JSON.parse(String(init?.body ?? "{}")) as ProviderBody;
}
function jsonValue(value: unknown): unknown {
  // The crash marker is JSON; compare the same representation on both sides.
  return JSON.parse(JSON.stringify(value)) as unknown;
}
function config(): AgentConfig {
  return {
    ...defaultConfig, agent: { ...defaultConfig.agent, toolExecutionMode: "direct" },
    defaultModel: "plan-crash-test",
    providers: { test: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key" } },
    models: { "plan-crash-test": { ...defaultConfig.models["deepseek-v4-flash"], provider: "test", model: "plan-crash-test", displayName: "Plan Crash Test" } },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false, denyPaths: [] },
    checkpoints: { enabled: false },
    extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true, maxSteps: 4 } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  };
}
function streamToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  if (name === "PlanDraft") {
    name = "Bash";
    args = { command: biny + " plan draft --input " + shellQuote(JSON.stringify(args)) + " --json" };
  }
  return stream([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ]);
}
function streamText(content: string): Response {
  return stream([{ choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
}
function stream(parts: unknown[]): Response {
  return new Response(parts.map((part) => "data: " + JSON.stringify(part) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}
function textContent(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as { stdout?: string; exitCode?: number };
      if (typeof parsed.stdout === "string") { assert.equal(parsed.exitCode, 0, value); return parsed.stdout.trim(); }
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    return value;
  }
  if (!Array.isArray(value)) return "";
  return value.map((part: unknown) => typeof part === "object" && part !== null && "text" in part ? String(part.text) : "").join("");
}
