/** 固定目录和任务，移除每回合辅助预选；不改变主模型、ToolSearch 或历史恢复。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { wrapLanguageModel } from "ai";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { loadConfig } from "../src/config/loader.js";
import { loadStoredCredentials } from "../src/config/credentials.js";
import { globalConfigDir } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopSafeStorageCredentialStore } from "../src/desktop/electron/main/DesktopSafeStorageCredentialStore.js";
import { createModelForConfig } from "../src/llm/modelFactory.js";
import { resolveToolModelAlias } from "../src/llm/toolModel.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { redactSecrets } from "../src/utils/secrets.js";

const catalogue = [
  { name: "warehouse_available_units", description: "Query available inventory units for a warehouse product SKU", rows: { "SKU-71": { units: 47 }, "SKU-93": { units: 28 } } },
  { name: "orders_shipping_reference", description: "Look up a customer order's carrier tracking reference by order ID", rows: { "ORDER-42": { trackingId: "TRACK-86" } } },
  { name: "carrier_delivery_status", description: "Read delivery status and estimated arrival date by carrier tracking ID", rows: { "TRACK-86": { status: "in_transit", arrival: "2030-04-17" } } },
  ...["calendar", "contacts", "invoices", "projects", "documents", "analytics", "support", "messages", "assets"]
    .flatMap((domain) => ["list", "search", "details", "history", "summary"].map((operation) => ({
      name: `${domain}_${operation}`, description: `${operation} ${domain} records by record ID`, rows: {}
    })))
];
const tasks: Array<{ id: string; turns: Array<{ prompt: string; calls: string[]; answer: string[]; statusAlternatives?: string[] }> }> = [
  { id: "core", turns: [{ prompt: "读取工作区 README.txt，回答其中的校验码。", calls: ["Read:README.txt"], answer: ["VERIFIED-LOCAL-41"] }] },
  { id: "fresh", turns: [{ prompt: "查询 SKU-71 的当前可用库存，只回答数量。", calls: ["warehouse_available_units:SKU-71"], answer: ["47"] }] },
  { id: "history", turns: [
    { prompt: "查询 SKU-71 的当前可用库存，只回答数量。", calls: ["warehouse_available_units:SKU-71"], answer: ["47"] },
    { prompt: "再查 SKU-93 的当前可用库存，只回答数量。", calls: ["warehouse_available_units:SKU-93"], answer: ["28"] }
  ] },
  { id: "dependent", turns: [{ prompt: "查询 ORDER-42 的物流状态和预计送达日期。", calls: ["orders_shipping_reference:ORDER-42", "carrier_delivery_status:TRACK-86"], answer: ["2030-04-17"], statusAlternatives: ["在途", "运输", "途中", "in_transit"] }] }
];
type Request = { role: "main" | "preselect" | "search"; turn: number; startedMs: number; durationMs?: number; usage?: LanguageModelV4Usage; output: unknown[]; failed?: boolean };
type Turn = { task: string; repetition: number; variant: string; turn: number; success: boolean; firstMainRequestMs: number | null; searches: number; totalTokens: number | null; reportedTokens: number; requests: Request[]; calls: string[]; expectedCalls: string[]; outcome: unknown };

export async function run(args: string[]): Promise<void> {
  const [output, repeatArgument = "3", toolModelAlias] = args;
  assert.ok(output && path.isAbsolute(output), "Provide a new absolute output directory.");
  const repeats = Number(repeatArgument);
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
  await mkdir(output, { recursive: false });
  const loaded = await loadStoredCredentials(await loadConfig(process.cwd()), new DesktopSafeStorageCredentialStore(globalConfigDir()));
  const toolAlias = toolModelAlias ?? resolveToolModelAlias(loaded);
  assert.ok(toolAlias, "No configured auxiliary model is available.");
  const config = configSchema.parse({ ...defaultConfig, providers: loaded.providers, models: loaded.models,
    defaultModel: loaded.defaultModel, toolModel: toolAlias, thinking: { ...defaultConfig.thinking, enabled: false },
    agent: { ...defaultConfig.agent, toolExecutionMode: "direct", maxToolCalls: 20 },
    chat: { ...defaultConfig.chat, temperature: 0, maxOutputTokens: 2048, skillExtraction: { ...defaultConfig.chat.skillExtraction, enabled: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  // 后续 session、记忆与技能均隔离；配置凭据只在当前进程中使用。
  process.env.BINY_AGENT_DIR = path.join(output, "state");
  const metadata = { main: config.models[config.defaultModel]?.model, auxiliary: config.models[toolAlias]?.model,
    repeats, catalogue, tasks, temperature: 0, maxSteps: 8, maxToolCalls: 20, timeoutMs: 120_000,
    toolExecutionMode: "direct", skills: "none", cache: "fresh ToolSearch instance per trial; provider cache uncontrolled",
    sourceHashes: Object.fromEntries(await Promise.all([
      new URL(import.meta.url), new URL("../src/agent/capabilityPreselection.ts", import.meta.url),
      new URL("../src/agent/AgentSession.ts", import.meta.url), new URL("../src/tools/toolSearch.ts", import.meta.url)
    ].map(async (file) => [file.pathname, createHash("sha256").update(await readFile(file)).digest("hex")]))),
    models: [config.defaultModel, toolAlias].map((alias) => ({ alias, provider: config.models[alias]!.provider,
      protocol: config.providers[config.models[alias]!.provider]!.type })) };
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify({ main: metadata.main, auxiliary: metadata.auxiliary, repeats, catalogueSize: catalogue.length }));
  const turns: Turn[] = [];
  for (let repetition = 0; repetition < repeats; repetition++) {
    for (const task of tasks) {
      // 交替 AB/BA，避免始终由一个变体承担连接和 Provider 缓存冷启动。
      for (const variant of repetition % 2 ? ["on-demand", "preselect"] : ["preselect", "on-demand"]) {
        const trial = path.join(output, `${task.id}-${repetition}-${variant}`);
        await mkdir(trial);
        await writeFile(path.join(trial, "README.txt"), "校验码：VERIFIED-LOCAL-41\n");
        await ensureAgentDirs(trial);
        let turn = 0;
        let started = 0;
        const requests: Request[] = [];
        const calls: string[] = [];
        const measured = (model: AgentModel, role: Request["role"]): AgentModel => ({ ...model,
          prepareTextRequest: model.prepareTextRequest ? async (signal) => measured(await model.prepareTextRequest!(signal), role) : undefined,
          vercelModel: wrapLanguageModel({ model: model.vercelModel!, middleware: {
            specificationVersion: "v4",
            async wrapStream({ doStream }) {
              const record: Request = { role, turn, startedMs: performance.now() - started, output: [] };
              requests.push(record);
              const begin = performance.now();
              try {
                const result = await doStream();
                return { ...result, stream: result.stream.pipeThrough(new TransformStream({
                  transform(chunk, controller) {
                    if (chunk.type === "finish") { record.usage = chunk.usage; record.durationMs = performance.now() - begin; }
                    if (chunk.type === "text-delta" || chunk.type === "tool-call") record.output.push(chunk);
                    if (chunk.type === "error") { record.failed = true; record.output.push({ error: redactSecrets(chunk.error instanceof Error ? chunk.error.message : String(chunk.error)) }); }
                    controller.enqueue(chunk);
                  },
                  flush() { record.durationMs ??= performance.now() - begin; }
                })) };
              } catch (error) { record.failed = true; record.durationMs = performance.now() - begin; throw error; }
            }
          } })
        });
        const main = measured(createModelForConfig(config), "main");
        const auxiliary = createModelForConfig(config, toolAlias);
        const registry = new ToolRegistry();
        registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: trial, ignore: [] }));
        for (const entry of catalogue) registry.registerMcpTool({
          name: entry.name, description: entry.description, exposure: "deferred", risk: "read",
          parameters: { type: "object", properties: { id: { type: "string", description: "Product SKU, order ID, tracking ID or record ID" } }, required: ["id"], additionalProperties: false },
          schema: z.object({ id: z.string() }),
          resolveExecution: (value) => ({ approvalRule: entry.name, execute: async () => {
            const input = z.object({ id: z.string() }).parse(value);
            calls.push(`${entry.name}:${input.id}`);
            return (entry.rows as Record<string, unknown>)[input.id] ?? { error: "Record not found" };
          } })
        });
        registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries(), () => [{ model: measured(auxiliary, "search"), failureDomain: "fixed-eval-model" }]));
        const recorder = new SessionRecorder(trial);
        const agent = new AgentSession({ workspaceRoot: trial, config, model: main, toolRegistry: registry, recorder,
          permissionManager: new PermissionManager(config.permission),
          selectCapabilities: async (input) => await preselectCapabilities({ ...input, tools: registry.listCatalogDefinitions(), skills: [],
            models: variant === "preselect" ? [{ model: measured(auxiliary, "preselect"), failureDomain: "fixed-eval-model" }] : [] })
        });
        try {
          await agent.initialize();
          for (const expected of task.turns) {
            turn++;
            const previousCalls = calls.length;
            started = performance.now();
            const outcome = await agent.runTask(expected.prompt, { emotionAnalysis: false, maxSteps: 8,
              abortSignal: AbortSignal.timeout(120_000), capabilitySelection: { tools: "auto", skills: "none" },
              confirmPermission: async () => ({ approved: true, scope: "once" }) });
            const current = requests.filter((request) => request.turn === turn);
            const actualCalls = calls.slice(previousCalls);
            const tokenCounts = current.map((request) => request.usage?.inputTokens.total !== undefined && request.usage.outputTokens.total !== undefined
              ? request.usage.inputTokens.total + request.usage.outputTokens.total : undefined);
            const reportedTokens = tokenCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
            const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; tool?: string; executionStatus?: string; result?: { path?: string } });
            if (task.id === "core") for (const event of events) {
              if (event.type === "tool_result" && event.tool === "Read" && event.executionStatus === "succeeded" && event.result?.path) actualCalls.push(`Read:${event.result.path}`);
            }
            const searches = events.filter((event) => event.type === "tool_call" && event.tool === "ToolSearch").length
              - turns.filter((row) => row.task === task.id && row.repetition === repetition && row.variant === variant).reduce((sum, row) => sum + row.searches, 0);
            const result: Turn = { task: task.id, repetition, variant, turn,
              success: outcome.status === "completed" && expected.calls.every((call) => actualCalls.includes(call)) && expected.answer.every((value) => outcome.output.includes(value))
                && (!expected.statusAlternatives || expected.statusAlternatives.some((value) => outcome.output.includes(value))),
              firstMainRequestMs: current.find((request) => request.role === "main")?.startedMs ?? null, searches,
              totalTokens: tokenCounts.every((count) => count !== undefined) ? reportedTokens : null,
              reportedTokens, requests: current, calls: actualCalls, expectedCalls: expected.calls, outcome };
            turns.push(result);
            await writeFile(path.join(trial, `turn-${turn}.json`), JSON.stringify(result, null, 2));
            console.log(JSON.stringify({ ...result, requests: current.map((r) => ({ role: r.role, durationMs: r.durationMs, failed: r.failed })), outcome: outcome.status }));
          }
        } finally { await agent.close(); }
      }
    }
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  const summary = ["preselect", "on-demand"].map((variant) => {
    const rows = turns.filter((row) => row.variant === variant);
    const successes = tasks.flatMap((task) => Array.from({ length: repeats }, (_, repetition) => rows.filter((row) => row.task === task.id && row.repetition === repetition).every((row) => row.success)));
    return { variant, tasks: successes.length, successfulTasks: successes.filter(Boolean).length, turns: rows.length,
      medianFirstMainRequestMs: median(rows.flatMap((row) => row.firstMainRequestMs === null ? [] : [row.firstMainRequestMs])),
      searches: rows.reduce((sum, row) => sum + row.searches, 0),
      totalTokens: rows.every((row) => row.totalTokens !== null) ? rows.reduce((sum, row) => sum + row.totalTokens!, 0) : null,
      reportedTokens: rows.reduce((sum, row) => sum + row.reportedTokens, 0),
      requestsMissingUsage: rows.flatMap((row) => row.requests).filter((request) => !request.usage).length };
  });
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
