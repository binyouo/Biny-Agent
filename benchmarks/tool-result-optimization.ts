import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { wrapLanguageModel } from "ai";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { loadConfig } from "../src/config/loader.js";
import { loadStoredCredentials } from "../src/config/credentials.js";
import { globalConfigDir } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopSafeStorageCredentialStore } from "../src/desktop/electron/main/DesktopSafeStorageCredentialStore.js";
import { createModelForConfig } from "../src/llm/modelFactory.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { summarizeToolOptimizations } from "../src/session/toolOptimization.js";
import { redactSecrets } from "../src/utils/secrets.js";

const tasks = [
  { id: "search", files: { "records.jsonl": Array.from({ length: 120 }, (_, i) => JSON.stringify({ id: `R-${i}`, region: i === 47 ? "north" : "south", state: i === 47 ? "failed" : "ok", note: "synthetic record for selection and output filtering" })).join("\n") },
    prompt: 'Read records.jsonl. Find the record with region north and state failed. Reply only with JSON {"id":"..."}.', expected: { id: "R-47" } },
  { id: "logs", files: { "events.jsonl": Array.from({ length: 120 }, (_, i) => JSON.stringify({ sequence: i, level: i % 10 === 0 ? "error" : "info", service: "worker", message: "synthetic diagnostic event with no private information" })).join("\n") },
    prompt: 'Read events.jsonl. Count error-level events and sum their sequence numbers. Reply only with JSON {"count":number,"sum":number}.', expected: { count: 12, sum: 660 } },
  { id: "aggregate", files: { "east.jsonl": Array.from({ length: 80 }, () => JSON.stringify({ units: 3, region: "east", note: "synthetic stock row" })).join("\n"), "west.jsonl": Array.from({ length: 80 }, () => JSON.stringify({ units: 7, region: "west", note: "synthetic stock row" })).join("\n") },
    prompt: 'Read east.jsonl and west.jsonl. Compute total units in each file and their grand total. Reply only with JSON {"east":number,"west":number,"total":number}.', expected: { east: 240, west: 560, total: 800 } }
];

export async function run(args: string[]): Promise<void> {
  const [output] = args;
  assert.ok(output && path.isAbsolute(output), "Provide a new absolute output directory.");
  await mkdir(output, { recursive: false });
  const loaded = await loadStoredCredentials(await loadConfig(process.cwd()), new DesktopSafeStorageCredentialStore(globalConfigDir()));
  const config = configSchema.parse({ ...defaultConfig, providers: loaded.providers, models: loaded.models, defaultModel: loaded.defaultModel,
    thinking: { ...defaultConfig.thinking, enabled: false },
    agent: { ...defaultConfig.agent, maxToolCalls: 12 },
    chat: { ...defaultConfig.chat, temperature: 0, maxOutputTokens: 1024, skillExtraction: { ...defaultConfig.chat.skillExtraction, enabled: false } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  process.env.BINY_AGENT_DIR = path.join(output, "state");
  const manifest = { model: config.models[config.defaultModel]?.model, provider: config.models[config.defaultModel]?.provider,
    tasks, repetitions: 1, maxSteps: 6, maxToolCalls: 12, timeoutMs: 120_000, maxOutputTokens: 1024,
    memory: false, skills: false, toolset: ["Read"], providerCache: "uncontrolled", scope: "PTC optional selection; RTK command execution is verified separately",
    sources: Object.fromEntries(await Promise.all(["src/agent/toolExecutionCoordinator.ts", "src/agent/codeMode.ts", "benchmarks/tool-result-optimization.ts"].map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")]))) };
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ model: manifest.model, tasks: tasks.length }));
  const results: unknown[] = [];
  for (const [taskIndex, task] of tasks.entries()) {
    for (const variant of taskIndex % 2 ? ["code_mode", "direct"] as const : ["direct", "code_mode"] as const) {
      const trial = path.join(output, `${task.id}-${variant}`);
      await mkdir(trial);
      for (const [file, contents] of Object.entries(task.files)) await writeFile(path.join(trial, file), contents);
      await ensureAgentDirs(trial);
      const trialConfig = structuredClone(config);
      trialConfig.agent.toolExecutionMode = variant;
      const requests: Array<{ usage?: LanguageModelV4Usage; output: unknown[] }> = [];
      let contextBytes = 0;
      const measured = (model: AgentModel): AgentModel => ({ ...model,
        prepareTextRequest: model.prepareTextRequest ? async signal => measured(await model.prepareTextRequest!(signal)) : undefined,
        vercelModel: wrapLanguageModel({ model: model.vercelModel!, middleware: {
          specificationVersion: "v4",
          async wrapStream({ doStream, params }) {
            contextBytes += Buffer.byteLength(JSON.stringify(params.prompt));
            const request: typeof requests[number] = { output: [] };
            requests.push(request);
            const stream = await doStream();
            return { ...stream, stream: stream.stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
              if (chunk.type === "finish") request.usage = chunk.usage;
              if (chunk.type === "text-delta" || chunk.type === "tool-call") request.output.push(chunk);
              if (chunk.type === "error") request.output.push({ error: redactSecrets(String(chunk.error)) });
              controller.enqueue(chunk);
            } })) };
          }
        } })
      });
      const registry = new ToolRegistry();
      registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: trial, ignore: [] }));
      const recorder = new SessionRecorder(trial);
      const agent = new AgentSession({ workspaceRoot: trial, config: trialConfig, model: measured(createModelForConfig(trialConfig)),
        toolRegistry: registry, recorder, permissionManager: new PermissionManager(trialConfig.permission) });
      const started = performance.now();
      try {
        await agent.initialize();
        const outcome = await agent.runTask(task.prompt, { emotionAnalysis: false, maxSteps: 6, abortSignal: AbortSignal.timeout(120_000),
          capabilitySelection: { tools: "auto", skills: "none" }, confirmPermission: async () => ({ approved: true, scope: "once" }) });
        await recorder.flush();
        const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as SessionEvent);
        let answer: unknown;
        try { answer = JSON.parse(outcome.output.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "").trim()); } catch { /* verifier records invalid JSON as a failure */ }
        const readFiles = events.flatMap(event => event.type === "tool_call" && event.tool === "Read" && typeof (event.args as { path?: unknown } | undefined)?.path === "string" ? [path.basename((event.args as { path: string }).path)] : []);
        const success = Object.keys(task.files).every(file => readFiles.includes(file)) && outcome.status === "completed" && JSON.stringify(answer && Object.fromEntries(Object.entries(answer).sort())) === JSON.stringify(Object.fromEntries(Object.entries(task.expected).sort()));
        const tokens = requests.map(request => request.usage?.inputTokens.total !== undefined && request.usage.outputTokens.total !== undefined ? request.usage.inputTokens.total + request.usage.outputTokens.total : undefined);
        const calls = events.filter(event => event.type === "tool_call").map(event => event.tool);
        const result = { task: task.id, variant, success, calls, readFiles, scripts: calls.filter(call => call === "run_script").length,
          totalTokens: tokens.every(value => value !== undefined) ? tokens.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null,
          contextBytes, durationMs: Math.round(performance.now() - started), optimization: summarizeToolOptimizations(events.filter(event => event.type === "tool_result")), outcome, requests };
        results.push(result);
        await writeFile(path.join(trial, "result.json"), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ task: result.task, variant, success, scripts: result.scripts, tokens: result.totalTokens, durationMs: result.durationMs }));
      } catch (error) {
        const result = { task: task.id, variant, success: false, error: redactSecrets(error instanceof Error ? error.message : String(error)), requests };
        results.push(result);
        await writeFile(path.join(trial, "result.json"), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ task: task.id, variant, success: false, error: result.error }));
      } finally { await agent.close(); }
      await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
    }
  }
}
