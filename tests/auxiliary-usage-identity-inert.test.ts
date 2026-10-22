import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentModel, AgentUsage, ModelRequestMetrics } from "../src/agent/core/types.js";
import type { AgentConfig, ModelAliasConfig } from "../src/config/schema.js";
import type { SessionEvent, SessionUsage } from "../src/session/recorder.js";
import { createSessionUsage, summarizeUsage } from "../src/observability/usage.js";
import { normalizeMemoryOriginAnchors } from "../src/agent/context/memoryFormat.js";
import { redactSecrets } from "../src/utils/redaction.js";

// Only source-selected declarations are evaluated. No AgentSession, native helper,
// Provider, Host, SQLite, vector owner, or process lifecycle is imported or started.
// External provider/storage adapters are inert; costs and replay use product helpers.
const root = process.env.BINY_AUXILIARY_USAGE_SOURCE_ROOT ?? path.resolve(import.meta.dirname, "..");
const parse = (file: string) => ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
const session = parse("src/agent/AgentSession.ts");
const memory = parse("src/agent/context/LocalMemory.ts");
const registry = parse("src/llm/ModelRegistry.ts");
const runtime = parse("src/llm/ModelRuntime.ts");
const manager = parse("src/llm/ModelManager.ts");
const providers = parse("src/llm/ProviderRuntime.ts");
const factory = parse("src/llm/modelFactory.ts");
const selection = parse("src/llm/toolModel.ts");
const emotion = parse("src/agent/context/emotionAnalysis.ts");
const diary = parse("src/agent/context/chatDiary.ts");
const context = parse("src/agent/context/ContextMemory.ts");
const native = parse("src/llm/nativeJson.ts");
const extraction = parse("src/agent/context/memoryExtraction.ts");
const replay = parse("src/session/replay.ts");
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
function cls(source: ts.SourceFile, name: string) {
  return one(source.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name), name);
}
function method(source: ts.SourceFile, name: string, member: string) {
  return one(cls(source, name).members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === member), `${name}.${member}`);
}
function fn(source: ts.SourceFile, name: string) {
  return one(source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name), name);
}
function variable(source: ts.SourceFile, name: string) {
  return one(source.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === name)), name);
}
const constructor = one(cls(session, "AgentSession").members.filter(ts.isConstructorDeclaration), "session constructor");
const statements = constructor.body!.statements;
const variables = ["getModel", "currentModel", "onUsage", "onModelRequest", "providerCredentials", "auxiliaryModel", "memoryModel"];
const wiring = statements.filter(statement => ts.isVariableStatement(statement)
  ? statement.declarationList.declarations.some(declaration => variables.includes(declaration.name.getText(session)))
  : ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && ["this.toolModel", "this.memoryModelFor", "this.localMemory"].includes(statement.expression.left.getText(session)));
assert.equal(wiring.length, variables.length + 3, "exact production memory wiring");
const memoryMethods = ["summarizeAndStoreMemories", "findSemanticMemoryEntries", "cleanupTemporaryMemories"];
const memoryConstructor = one(cls(memory, "LocalMemory").members.filter(ts.isConstructorDeclaration), "memory constructor");
const sessionMethods = ["recordModelUsage", "takeRelatedUsage", "usageSummary", "analyzeContextEmotion", "refreshDailyDiary"];
if (cls(session, "AgentSession").members.some(node => node.name?.getText(session) === "usageModelInfo")) sessionMethods.push("usageModelInfo");
function nested(source: ts.SourceFile, scope: ts.Node, name: string): ts.VariableStatement {
  const found: ts.VariableStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === name)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope); return one(found, name);
}
function property(scope: ts.Node, source: ts.SourceFile, name: string): ts.PropertyAssignment {
  const found: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope); return one(found, name);
}
const rewrite = property(constructor, session, "rewriteQuery").initializer;
const summaryNames = ["summaryModels", "summaryBudgets", "resolveSummaryModel"];
if (statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(session) === "currentSummaryModel"))) summaryNames.push("currentSummaryModel");
const summaryWiring = statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => summaryNames.includes(declaration.name.getText(session))));
const compaction = nested(session, constructor, "contextCompactionOptions");
const summaryFunction = method(context, "ContextMemory", "createSummary");
const generateSummary = nested(context, summaryFunction, "generateSummary");
const summaryIdentity = summaryFunction.body!.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(context) === "usageModel"));
const summaryIdentityHook = cls(context, "ContextMemory").members.some(member => member.name?.getText(context) === "createSummary")
  && compaction.getText(session).includes("getUsageModelInfo:") ? property(compaction, session, "getUsageModelInfo").initializer : undefined;
const declarations: Array<{ source: ts.SourceFile; node: ts.Node }> = [
  { source: runtime, node: method(runtime, "ModelRuntime", "resolve") },
  ...["modelRuntimeInfo", "modelRuntimeInfoFromRuntime", "formatModelLabel", "formatReasoningLabel"].map(name => ({ source: manager, node: fn(manager, name) })),
  ...wiring.map(node => ({ source: session, node })),
  ...summaryWiring.map(node => ({ source: session, node })),
  { source: session, node: rewrite }, { source: context, node: generateSummary },
  ...(summaryIdentity ? [{ source: context, node: summaryIdentity }] : []),
  ...(summaryIdentityHook ? [{ source: session, node: summaryIdentityHook }] : []),
  ...["analyzeContextEmotion", "normalizeMessages"].map(name => ({ source: emotion, node: fn(emotion, name) })),
  ...["refreshChatDailyDiary", "truncateForPrompt", "renderDeterministicDailySummary"].map(name => ({ source: diary, node: fn(diary, name) })),
  { source: native, node: fn(native, "nativeJsonMessages") },
  ...sessionMethods.map(name => ({ source: session, node: method(session, "AgentSession", name) })),
  { source: memory, node: memoryConstructor },
  ...memoryMethods.map(name => ({ source: memory, node: method(memory, "LocalMemory", name) })),
  { source: memory, node: fn(memory, "formatMemoryExtractionMessages") },
  ...["resolveMemoryModelAlias", "resolveToolModelAlias", "toolModelAliases"].map(name => ({ source: selection, node: fn(selection, name) })),
  { source: selection, node: variable(selection, "toolModelPreferences") },
  ...["resolve", "isAvailable"].map(name => ({ source: registry, node: method(registry, "ModelRegistry", name) })),
  ...["createModelSettings", "forModel", "require"].map(name => ({ source: providers, node: method(providers, "ProviderRegistry", name) })),
  { source: session, node: fn(session, "modelIdentifier") },
  ...["createModelForConfig", "createModelSettings"].map(name => ({ source: factory, node: fn(factory, name) })),
  { source: native, node: fn(native, "reportVercelMetrics") },
  { source: extraction, node: fn(extraction, "parseMemoryOperations") },
  { source: replay, node: fn(replay, "sessionUsage") }
];
const allowedCalls = new Set([
  "modelRuntimeInfoFromRuntime", "runtime.resolve", "this.models.resolve", "this.models.isAvailable", "reference.trim",
  "effectiveThinkingSelection", "formatModelLabel", "formatReasoningLabel", "model.startsWith", "thinking[0]?.toUpperCase", "thinking.slice",
  "new ModelRuntime(config).resolve", "onUsage", "now().toISOString", "this.require", "this.get", "provider.resolveModel",
  "createHash", 'createHash("sha256").update', 'createHash("sha256").update(source).digest',
  'createHash("sha256").update(JSON.stringify([alias, this.activeConfig.providers, this.activeConfig.models, this.activeConfig.context.maxInputTokens])).digest',
  'createHash("sha256").update(`${options.model.provider}\\0${options.model.modelId}`).digest',
  "summaryModels.get", "summaryModels.clear", "summaryModels.set", "summaryBudgets.set", "modelContextBudget", "currentSummaryModel", "console.warn", "errorMessage",
  "recorder.flush", "recorder.runtimeContextSnapshot", "analyzeContextEmotion", "this.toolModel", "this.recentEmotionMessages", "recorder.recordWithRuntimeContext",
  "refreshChatDailyDiary", "options.getModel", "options.getUsageModelInfo", "options.getUsageModelInfo?.", "options.getMessages", "normalizeMessages",
  "options.onUsage", "options.onUsage?.", "autoEmotionResultSchema.safeParse", "now", "options.storage.readBase", "options.storage.readContext", "options.storage.writeContext", "options.onUpdated", "options.onUpdated?.",
  "Math.min", "Array.from", "backfillDailyChatDiaryEntries", "readDailyMemoryNote", "readDailyMemorySection", "nativeJsonMessages", "truncateForPrompt",
  "renderDeterministicDailySummary", "upsertDailyMemorySection", "this.compactionOptions.getUsageModelInfo", "this.compactionOptions.getUsageModelInfo?.",
  "toolModelAliases", "redactSecrets", "options.modelManager?.getModel", "options.modelManager?.getInfo", "this.recordModelUsage", "this.recordModelRequest",
  "createProviderCredentialPersistence", "getModel", "currentModel", "createModelForConfig", "auxiliaryModel",
  "resolveToolModelAlias", "resolveMemoryModelAlias", "this.memoryModelFor", "this.indexMemoryEntry", "this.removeMemoryEmbeddingEntries",
  "this.memoryEmbeddingService.findSimilarInScope", "this.sideModelRequestContext", "this.usageModelInfo", "this.auxiliaryUsageModels.set", "this.auxiliaryUsageModels.get",
  "this.options.modelManager?.getModel", "this.options.modelManager?.getInfo", "modelRuntimeInfo", "this.options.modelManager?.listModels",
  "this.options.modelManager?.listModels().find", "modelIdentifier", "createSessionUsage", "new Date().toISOString", "this.modelRequestRecords.at",
  "this.usageRecords.push", "this.unpersistedRelatedUsage.push", "this.unpersistedRelatedUsage.splice", "summarizeUsage",
  "options.signal?.throwIfAborted", "messages.slice", "messages.slice(-4).filter", "normalizeMemoryOriginAnchors", "this.getToolModel",
  "this.getUsageModelInfo", "this.getUsageModelInfo?.", "generateNativeText", "formatMemoryExtractionMessages", "originAnchors.map", "originAnchors.map((anchor) =>\n            `- messageId: ${anchor.messageId}; sentAt: ${anchor.sentAt}; timeZone: ${anchor.timeZone}`\n          ).join",
  "this.getModelRequestContext", "this.onUsage", "parseMemoryOperations", "operations.filter", "proposal.content.trim", "sanitizeMemoryEntryInput",
  "this.writeAutoEntry", "retainedIds.add", "(result.updated ? updated : created).push", "options.onMemoryWritten", "options.onMemoryWritten?.",
  "deleted.push", "this.deleteMemoryByDescription", "this.cleanupTemporaryMemories", "this.findSimilarEntries", "signal?.throwIfAborted",
  "candidates?.filter", "scoped.map", "this.recordRecallUsage", "this.findSemanticMemoryEntries", "retainedIds.has", "date.getFullYear", "date.getMonth",
  "date.getDate", "date.toLocaleTimeString", "temporary.map", "JSON.stringify", "formatDate", "new Date(entry.createdAt)",
  "response.text.match", "JSON.parse", "Array.isArray", "temporary.find", "this.deleteEntryById", "registry.resolve", "registry.isAvailable",
  "providerOrder.indexOf", "Object.hasOwn", "toolModelPreferences[type]!.indexOf", "Object.keys", "Object.keys(config.models).flatMap",
  'Object.keys(config.models).flatMap((alias) => {\n    const model = registry.resolve(alias);\n    return model && config.providers[model.providerAlias]?.type !== "acp" && registry.isAvailable(model) ? [model] : [];\n  }).sort',
  "priority", "candidates.map", "this.providers.get", "this.providers.get(resolved.providerAlias)?.isConfigured", "provider?.resolveModel",
  "aliasOrReference.toLowerCase", "aliasOrReference.indexOf", "aliasOrReference.slice", "Object.entries", "Object.entries(this.config.models).find",
  "this.catalogs.get", "this.catalogs.get(providerAlias)?.find", "catalogEntryToModel", "catalogModelAlias", "entries.find", "this.forModel", "registry.createModelSettings", "registry.forModel",
  "provider.createModelSettings", "createModelSettings", "createProxyAwareFetch", "new ProviderRegistry(config, [], undefined, undefined, fetcher, credentials).createModelSettings",
  "options.onRequestMetrics", "randomUUID", "new Date(startedAtMs).toISOString", "Math.max", "Date.now", "String",
  "response.trim", "text.match", "parse", "operations.push", "text.includes", "events.flatMap"
]);
const allowedNew = new Set(["Error", "LocalMemory", "MemoryStorage", "Date", "Set", "Map", "WeakMap", "ModelRegistry", "ProviderRegistry", "ModelRuntime"]);
const unexpectedCalls = new Set<string>();
for (const { source, node } of declarations) {
  const audit = (current: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(current) && current.kind !== ts.SyntaxKind.ImportKeyword, "no imports inside extracted code");
    if (ts.isCallExpression(current) && !allowedCalls.has(current.expression.getText(source)) && !(ts.isPropertyAccessExpression(current.expression) && ["join", "padStart", "filter", "map", "slice", "trim", "match", "includes"].includes(current.expression.name.text))) unexpectedCalls.add(current.expression.getText(source));
    if (ts.isNewExpression(current)) assert.ok(allowedNew.has(current.expression.getText(source)), `Unexpected constructor: ${current.expression.getText(source)}`);
    ts.forEachChild(current, audit);
  };
  audit(node);
}
assert.deepEqual([...unexpectedCalls], [], "unexpected extracted calls");
const text = (source: ts.SourceFile, node: ts.Node) => node.getText(source).replace(/^export /u, "");
const functions = declarations.filter(({ node }) => ts.isFunctionDeclaration(node) || ts.isVariableStatement(node) && !wiring.includes(node as ts.Statement) && !summaryWiring.includes(node as ts.Statement) && node !== generateSummary && node !== summaryIdentity)
  .map(({ source, node }) => text(source, node)).join("\n");
const code = ts.transpileModule(`
${functions}
class ModelRegistry {
  catalogs = new Map();
  constructor(config) { this.config = config; this.providers = new ProviderRegistry(config); }
  ${["resolve", "isAvailable"].map(name => text(registry, method(registry, "ModelRegistry", name))).join("\n")}
}
class ModelRuntime {
  constructor(config) { this.models = new ModelRegistry(config); }
  ${text(runtime, method(runtime, "ModelRuntime", "resolve"))}
}
class ProviderRegistry {
  constructor(config) { this.config = config; }
  get(id) { return providerAdapter(this.config, id); }
  ${["createModelSettings", "forModel", "require"].map(name => text(providers, method(providers, "ProviderRegistry", name))).join("\n")}
}
class LocalMemory {
  ${text(memory, memoryConstructor)}
  ${memoryMethods.map(name => text(memory, method(memory, "LocalMemory", name))).join("\n")}
}
class InertSession {
  constructor(options) {
    this.options = options; this.activeConfig = options.config; this.usageRecords = []; this.modelRequestRecords = [];
    this.unpersistedRelatedUsage = []; this.auxiliaryUsageModels = new WeakMap(); this.activeOperation = "agent turn";
    this.memoryEmbeddingService = { findSimilarInScope: async () => [] };
    const persistenceRoot = "/inert";
    ${wiring.map(node => text(session, node)).join("\n")}
    this.rewriteQuery = ${text(session, rewrite)};
    ${summaryWiring.map(node => text(session, node)).join("\n")}
    this.resolveSummaryModel = resolveSummaryModel;
    this.summaryHarness = { onUsage, onModelRequest, getModelRequestContext: () => this.sideModelRequestContext(),
      compactionOptions: { getUsageModelInfo: ${summaryIdentityHook ? text(session, summaryIdentityHook) : "undefined"} } };
  }
  async summary() {
    const summaryModel = this.resolveSummaryModel();
    return await (async function() {
      ${summaryIdentity ? text(context, summaryIdentity) : ""}
      const signal = undefined, prompt = "Synthetic summary material.", outputTokens = 100;
      ${text(context, generateSummary)}
      return await generateSummary("Summarize.");
    }).call(this.summaryHarness);
  }
  sideModelRequestContext() { return { sessionId: "session-a", runId: "run-a", turnId: "turn-a" }; }
  recordModelRequest(metrics) { this.modelRequestRecords.push(metrics); }
  ${sessionMethods.map(name => text(session, method(session, "AgentSession", name))).join("\n")}
}
({ InertSession, sessionUsage, reportVercelMetrics });`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

interface Harness {
  localMemory: { summarizeAndStoreMemories(messages: unknown[], options: unknown): Promise<unknown> };
  usageRecords: SessionUsage[];
  modelRequestRecords: ModelRequestMetrics[];
  activeConfig: AgentConfig;
  recorder: unknown;
  recentEmotionMessages: () => Promise<unknown[]>;
  rewriteQuery(query: string): Promise<string>;
  summary(): Promise<unknown>;
  analyzeContextEmotion(sessionId: string, signal: AbortSignal): Promise<unknown>;
  refreshDailyDiary(dateKey: string): Promise<unknown>;
  memoryModelFor(field: string): AgentModel;
  toolModel(): AgentModel | undefined;
  takeRelatedUsage(): SessionUsage[] | undefined;
  usageSummary(): ReturnType<typeof summarizeUsage>;
  recordModelUsage(usage: AgentUsage, operation: "memory", alias?: string): SessionUsage;
}
const usage: AgentUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
function fixture(options: { alias?: string; sameId?: boolean; unpriced?: boolean; unavailable?: boolean; sameAdapter?: boolean; catalogPrice?: boolean; noManager?: boolean; emptyConfig?: boolean } = {}) {
  const chat: AgentModel = { provider: "chat-provider", modelId: "chat-wire" };
  const auxiliary: AgentModel = options.sameAdapter ? chat : { provider: "memory-provider", modelId: options.sameId ? "chat-wire" : "memory-wire" };
  if (options.sameId || options.sameAdapter) auxiliary.provider = chat.provider;
  const config = {
    defaultModel: "chat", toolModel: undefined,
    providers: { chatProvider: { type: chat.provider }, memoryProvider: { type: auxiliary.provider } },
    models: {
      chat: { provider: "chatProvider", model: chat.modelId, pricing: { inputPerMillionTokens: 100, outputPerMillionTokens: 200 } },
      memory: { provider: options.sameId || options.sameAdapter ? "chatProvider" : "memoryProvider", model: auxiliary.modelId,
        pricing: options.unpriced || options.catalogPrice ? undefined : { inputPerMillionTokens: 1, outputPerMillionTokens: 2 } }
    },
    activity: { enabled: false },
    context: { compaction: { summaryModel: options.alias }, memory: { memoryModel: options.alias, maxRecalled: 3 } }
  } as unknown as AgentConfig;
  if (options.emptyConfig) {
    config.defaultModel = "unconfigured-default"; config.providers = {}; config.models = {};
  }
  let currentAlias = "chat";
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const called: AgentModel[] = [];
  let selected!: () => void;
  const modelSelected = new Promise<void>(resolve => { selected = resolve; });
  type Metrics = (model: AgentModel, options: unknown, start: number, usage: AgentUsage, failure: undefined, finish: string) => Promise<void>;
  const providerAdapter = (candidate: AgentConfig, id: string) => ({
    resolveModel: (model: ModelAliasConfig) => options.catalogPrice && model === candidate.models.memory
      ? { ...model, pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 } } : model,
    isConfigured: () => !options.unavailable,
    createModelSettings: (_config: AgentConfig, model: ModelAliasConfig) => {
      selected();
      return { model: model.model === candidate.models.chat!.model && model.provider === candidate.models.chat!.provider && !options.catalogPrice ? chat : auxiliary, contextWindow: 8_192 };
    },
    id
  });
  const bindings = runInNewContext(code, {
    providerAdapter, createHash, createSessionUsage, effectiveThinkingSelection: () => "off",
    modelContextBudget: () => ({ contextWindow: 8192, maxInputTokens: 4096 }), errorMessage: String,
    console: { warn: () => undefined },
    recentMessageLimit: 10, recentMessageMaxChars: 150, autoEmotionSystemPrompt: "Analyze.",
    autoEmotionResultSchema: z.object({ mood: z.string(), valence: z.number(), reason: z.string() }).strict(),
    dailyDiaryMaxSourceChars: 24000, dailyDiaryMaxOutputTokens: 800, dailyDiaryModelTimeoutMs: 30000,
    backfillDailyChatDiaryEntries: async () => 0,
    readDailyMemoryNote: async () => "Synthetic completed turn.",
    readDailyMemorySection: (_note: string, section: string) => section === "聊天摘要" ? "Synthetic completed turn." : undefined,
    upsertDailyMemorySection: async () => undefined,
    DailyMemorySectionConflictError: class extends Error {}, summarizeUsage, normalizeMemoryOriginAnchors, redactSecrets, parse: JSON.parse,
    memoryExtractionPrompt: "Extract important memories.", memoryTimeAnchorInstruction: "Keep dates.", memoryModelTimeoutMs: 30_000,
    MemoryStorage: class { constructor() {} },
    createProxyAwareFetch: () => () => { throw new Error("Network is forbidden"); },
    createProviderCredentialPersistence: () => { throw new Error("Credential access is forbidden"); },
    randomUUID: () => "request-one",
    generateNativeText: async (model: AgentModel, _messages: unknown, generationOptions: unknown) => {
      called.push(model);
      await pending;
      const prepared = await model.prepareTextRequest?.() ?? model;
      await metrics(prepared, generationOptions, 0, usage, undefined, "stop");
      return { text: '["NO_MEMORY"]', usage };
    }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as {
    InertSession: new (options: unknown) => Harness;
    sessionUsage: (events: SessionEvent[]) => SessionUsage[];
    reportVercelMetrics: Metrics;
  };
  const metrics = bindings.reportVercelMetrics;
  const modelManager = {
    getModel: () => currentAlias === "chat" ? chat : auxiliary,
    getInfo: () => ({ modelAlias: currentAlias, provider: currentAlias === "chat" ? chat.provider : auxiliary.provider,
      modelLabel: config.models[currentAlias]!.model, pricing: config.models[currentAlias]!.pricing }),
    listModels: () => []
  };
  const agent = new bindings.InertSession({ config, model: chat, ...(options.noManager ? {} : { modelManager }) });
  agent.recorder = { sessionId: "session-a", filePath: "/inert/session", flush: async () => undefined,
    runtimeContextSnapshot: () => ({ runId: "run-a", turnId: "turn-a" }) };
  agent.recentEmotionMessages = async () => [{ role: "user", text: "Synthetic emotion." }];
  return { agent, called, config, chat, auxiliary, modelSelected, replay: bindings.sessionUsage,
    defer() { pending = new Promise<void>(resolve => { release = resolve; }); },
    release() { release?.(); },
    switchChat() { currentAlias = "memory"; },
    extract: () => agent.localMemory.summarizeAndStoreMemories([
      { role: "user", content: "A synthetic message." }, { role: "assistant", content: [{ type: "text", text: "Done." }] }
    ], { sessionId: "session-a", turnId: "turn-a", runId: "run-a", externalContext: false, excludeExternalContext: false })
  };
}
function assertBill(f: ReturnType<typeof fixture>, alias: string, cost: number | undefined, operation = "memory") {
  assert.equal(f.called.length, 1);
  assert.equal(f.agent.modelRequestRecords.length, 1);
  const metric = f.agent.modelRequestRecords[0]!;
  assert.equal(metric.modelId, f.called[0]!.modelId);
  assert.equal(metric.provider, f.called[0]!.provider);
  if (metric.requestContext?.sessionId !== undefined) assert.equal(metric.requestContext.sessionId, "session-a");
  assert.equal(f.agent.usageRecords.length, 1);
  const record = f.agent.usageRecords[0]!;
  assert.deepEqual({ modelAlias: record.modelAlias, model: record.model, provider: record.provider, costUsd: record.costUsd }, {
    modelAlias: alias, model: f.called[0]!.modelId, provider: f.called[0]!.provider, costUsd: cost
  });
  assert.equal(record.operation, operation);
  assert.equal(record.inputTokens, 100); assert.equal(record.outputTokens, 10); assert.equal(record.totalTokens, 110);
  assert.equal(record.pricingKnown, cost !== undefined);
  assert.equal(record.costUsd, cost);
  assert.equal(f.agent.usageSummary().costUsd, cost);
  const relatedUsage = f.agent.takeRelatedUsage();
  assert.equal(relatedUsage?.length, 1);
  assert.equal(f.agent.takeRelatedUsage(), undefined, "drain cannot duplicate settled usage");
  const stored = JSON.parse(JSON.stringify([{ type: "assistant_message", content: "", relatedUsage }])) as SessionEvent[];
  const restored = f.replay(stored);
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(f.agent.usageRecords)));
  assert.equal(summarizeUsage(restored).costUsd, cost);
}

test("dedicated memory model identity, cost and related-usage replay stay together", async () => {
  const f = fixture({ alias: "memory" }); await f.extract(); assertBill(f, "memory", 0.00012);
});
test("same provider/model IDs retain the explicitly selected alias and its price", async () => {
  const f = fixture({ alias: "memory", sameId: true }); await f.extract(); assertBill(f, "memory", 0.00012);
});
test("unpriced auxiliary usage never borrows chat pricing", async () => {
  const f = fixture({ alias: "memory", unpriced: true }); await f.extract(); assertBill(f, "memory", undefined);
});
test("same-model selection and automatic injected fallback preserve chat attribution", async () => {
  for (const options of [{ alias: "chat" }, { unavailable: true }]) {
    const f = fixture(options); await f.extract(); assertBill(f, "chat", 0.012);
  }
});
test("explicit unavailable memory model does not silently request the chat model", async () => {
  const f = fixture({ alias: "memory", unavailable: true }); await f.extract();
  assert.equal(f.called.length, 0); assert.equal(f.agent.usageRecords.length, 0);
});
test("settled usage keeps its request-time identity and price after model/config change", async () => {
  const f = fixture({ alias: "memory", sameAdapter: true }); f.defer();
  const extraction = f.extract();
  assert.equal(f.called.length, 1);
  f.switchChat();
  f.config.models.memory!.pricing!.inputPerMillionTokens = 700;
  f.config.models.memory!.pricing!.outputPerMillionTokens = 900;
  f.agent.memoryModelFor("memoryModel");
  f.release(); await extraction; assertBill(f, "memory", 0.00012);
});

test("explicit alias accounting keeps unknown pricing unknown", () => {
  const f = fixture({ unpriced: true });
  const record = f.agent.recordModelUsage(usage, "memory", "memory");
  assert.equal(record.modelAlias, "memory"); assert.equal(record.costUsd, undefined); assert.equal(record.pricingKnown, false);
});
test("refreshed root-turn configuration supplies auxiliary identity and pricing", async () => {
  const f = fixture({ alias: "memory" });
  f.agent.activeConfig = structuredClone(f.config);
  f.agent.activeConfig.models.memory!.model = "refreshed-memory-wire";
  f.agent.activeConfig.models.memory!.pricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 4 };
  f.auxiliary.modelId = "refreshed-memory-wire";
  await f.extract(); assertBill(f, "memory", 0.00034);
});

test("duplicate wire IDs retain resolved catalog-only pricing for the chosen alias", async () => {
  const f = fixture({ alias: "memory", sameId: true, catalogPrice: true });
  await f.extract(); assertBill(f, "memory", 0.00012);
});
test("current-model and injected fallback do not inherit a newer configuration's wire identity or price", async () => {
  for (const options of [{ alias: "chat" }, { unavailable: true }]) {
    const f = fixture(options);
    f.agent.activeConfig = structuredClone(f.config);
    f.agent.activeConfig.models.chat!.model = "not-the-running-adapter";
    f.agent.activeConfig.models.chat!.pricing = { inputPerMillionTokens: 999, outputPerMillionTokens: 999 };
    await f.extract(); assertBill(f, "chat", 0.012);
  }
});

for (const helper of ["rewrite", "emotion", "diary", "summary"] as const) {
  test(helper + " request boundary retains selected-model identity and pricing", async () => {
    const f = fixture({ alias: "memory" });
    f.config.toolModel = "memory";
    f.defer();
    const request = helper === "rewrite" ? f.agent.rewriteQuery("Find synthetic fact")
      : helper === "emotion" ? f.agent.analyzeContextEmotion("session-a", new AbortController().signal)
      : helper === "diary" ? f.agent.refreshDailyDiary("2026-10-22") : f.agent.summary();
    await f.modelSelected;
    // Helpers may await synthetic message/file reads before dispatch; the snapshot
    // already belongs to their selected model, not to the later active config.
    f.config.models.memory!.pricing!.inputPerMillionTokens = 999;
    f.config.context.memory.memoryModel = "chat";
    f.agent.memoryModelFor("memoryModel");
    f.release(); await request;
    assertBill(f, "memory", 0.00012, helper === "summary" ? "compaction" : "memory");
  });
}
test("invalid summary override falls back to the actual current model", async () => {
  const f = fixture({ alias: "missing" }); await f.agent.summary(); assertBill(f, "chat", 0.012, "compaction");
});

test("prepared replacement adapters cannot erase the original selected alias", async () => {
  const f = fixture({ alias: "memory" });
  f.auxiliary.prepareTextRequest = async () => ({ provider: f.auxiliary.provider, modelId: f.auxiliary.modelId });
  Object.freeze(f.auxiliary);
  await f.extract(); assertBill(f, "memory", 0.00012);
});
test("cached summary selection restores its own identity after a shared adapter is reused", async () => {
  const f = fixture({ alias: "memory", sameAdapter: true });
  await f.agent.summary();
  f.config.context.memory.memoryModel = "chat";
  f.agent.memoryModelFor("memoryModel");
  await f.agent.summary();
  assert.equal(f.called.length, 2);
  assert.deepEqual(Array.from(f.agent.usageRecords, record => record.modelAlias), ["memory", "memory"]);
  assert.equal(f.agent.usageSummary().costUsd, 0.00024);
  const related = f.agent.takeRelatedUsage();
  assert.equal(related?.length, 2); assert.equal(f.agent.takeRelatedUsage(), undefined);
});

test("managerless injected fallback remains usable without a configured default", async () => {
  const f = fixture({ noManager: true, emptyConfig: true });
  assert.equal(f.agent.toolModel(), f.chat, "the selection-only crystal consumer must remain usable");
  assert.equal(f.called.length, 0);
  await f.extract(); assertBill(f, "chat-provider/chat-wire", undefined);
});
test("managerless injected fallback retains matching configured metadata", async () => {
  const f = fixture({ alias: "chat", noManager: true });
  await f.extract(); assertBill(f, "chat", 0.012);
});
test("managerless injected fallback never borrows a different default model's price", async () => {
  const f = fixture({ alias: "chat", noManager: true });
  f.config.models.chat!.model = "different-default-wire";
  await f.extract(); assertBill(f, "chat-provider/chat-wire", undefined);
});
test("managerless injected fallback keeps provider connections distinct", async () => {
  const f = fixture({ alias: "chat", noManager: true });
  f.chat.providerAlias = "other-connection";
  await f.extract(); assertBill(f, "other-connection/chat-wire", undefined);
});
test("exact auxiliary selection does not need managerless default metadata", async () => {
  const f = fixture({ alias: "memory", noManager: true });
  f.config.defaultModel = "unconfigured-default";
  await f.extract(); assertBill(f, "memory", 0.00012);
});
test("managerless current summary retains exact default catalog pricing", async () => {
  const f = fixture({ noManager: true, sameId: true, catalogPrice: true });
  f.config.defaultModel = "memory";
  await f.agent.summary(); assertBill(f, "memory", 0.00012, "compaction");
});
