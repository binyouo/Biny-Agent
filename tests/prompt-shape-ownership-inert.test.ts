import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Evaluate only selected source declarations and completion-boundary statements.
// No AgentSession/Host construction, provider calls, memory storage, SQLite,
// vector/native lifecycle, timers, or network are imported or started here.
const root = process.env.BINY_PROMPT_USAGE_SOURCE_ROOT ?? path.resolve(import.meta.dirname, "..");
const parse = (file: string) => ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
const session = parse("src/agent/AgentSession.ts");
const memory = parse("src/agent/context/LocalMemory.ts");
const native = parse("src/llm/nativeJson.ts");
const adapter = parse("src/agent/core/vercelModelAdapter.ts");
const loop = parse("src/agent/core/vercelAgentLoop.ts");
const prompt = parse("src/llm/promptCache.ts");
const prompts = parse("src/agent/prompts.ts");
const metadata = parse("src/session/metadata.ts");
const usage = parse("src/observability/usage.ts");
const utils = parse("src/agent/core/vercelAgentUtils.ts");
const errors = parse("src/llm/modelErrors.ts");
const schema = parse("src/tools/schema.ts");
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
function cls(file: ts.SourceFile, name: string) {
  return one(file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name), name);
}
function method(file: ts.SourceFile, owner: string, name: string) {
  return one(cls(file, owner).members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(file) === name), name);
}
function fn(file: ts.SourceFile, name: string) {
  return one(file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name), name);
}
function namedVariable(node: ts.Node, file: ts.SourceFile, name: string): node is ts.VariableStatement {
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(file) === name);
}
function nested<T extends ts.Node>(scope: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node): void => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(scope); return result;
}
const text = (file: ts.SourceFile, node: ts.Node) => node.getText(file).replace(/^export /u, "");
const constructor = one(cls(session, "AgentSession").members.filter(ts.isConstructorDeclaration), "constructor");
const callbackWiring = ["onUsage", "onModelRequest"].map(name => text(session,
  one(constructor.body!.statements.filter(node => namedVariable(node, session, name)), name))).join("\n");
const runTurn = method(session, "AgentSession", "runTurnLoop");
const persistProperty = one(nested(runTurn, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node)
  && node.name.getText(session) === "persistStep"), "persistStep");
assert.ok(ts.isArrowFunction(persistProperty.initializer) && ts.isBlock(persistProperty.initializer.body));
const persist = persistProperty.initializer;
assert.ok(ts.isBlock(persist.body));
// Keep the actual identity snapshot, storage await, and usage append. All unrelated
// message/tool/persistence operations are intentionally outside this inert slice.
const persistStatements = persist.body.statements.filter(node => namedVariable(node, session, "promptShape")
  || namedVariable(node, session, "usage") || node.getText(session) === "await this.recorder.flush();"
  || node.getText(session).startsWith("stepUsageRecords.push(this.recordModelUsage("));
assert.ok(persistStatements.length === 3 || persistStatements.length === 4);
const foregroundVariables = runTurn.body!.statements.filter(node => namedVariable(node, session, "foregroundRequest")
  || namedVariable(node, session, "onForegroundRequest"));
const foregroundObservers = nested(runTurn, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node)
  && node.name.getText(session) === "onRequestMetrics"
  && (node.initializer.getText(session) === "onForegroundRequest"
    || node.initializer.getText(session) === "(metrics) => this.recordModelRequest(metrics)"));
assert.equal(foregroundObservers.length, 2, "both initial and continuation model options");
const attemptWrapper = one(nested(fn(loop, "streamModelStep"), (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node)
  && node.name.getText(loop) === "wrapStream"), "physical attempt middleware");
const memoryMethod = method(memory, "LocalMemory", "summarizeAndStoreMemories");
const memoryTry = one(nested(memoryMethod, (node): node is ts.TryStatement => ts.isTryStatement(node)
  && node.tryBlock.statements.some(statement => statement.getText(memory).includes("const response = await generateNativeText"))), "memory request try");
const parseIndex = memoryTry.tryBlock.statements.findIndex(node => node.getText(memory).startsWith("operations = parseMemoryOperations"));
assert.ok(parseIndex > 0);
const memoryCompletion = memoryTry.tryBlock.statements.slice(0, parseIndex).map(node => text(memory, node)).join("\n");
const nativeTry = one(fn(native, "consumeVercelText").body!.statements.filter(ts.isTryStatement), "native request try");
const nativeReturn = one(nativeTry.tryBlock.statements.filter(ts.isReturnStatement), "native return");
const nativeReport = nativeTry.tryBlock.statements[nativeTry.tryBlock.statements.indexOf(nativeReturn) - 1]!;
assert.ok(nativeReport.getText(native).startsWith("await reportVercelMetrics("));
const sessionMethods = ["recordModelRequest", "recordModelUsage", "observeModelUsage", "usageSummary", "usageReport"];
if (cls(session, "AgentSession").members.some(node => node.name?.getText(session) === "usageModelInfo")) sessionMethods.push("usageModelInfo");
const pure = [
  ...[prompt, errors].flatMap(file => file.statements.filter(node => ts.isVariableStatement(node)
    || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)).map(node => text(file, node))),
  ...["dynamicPromptStart", "dateAwarenessStart"].map(name => text(prompts, one(prompts.statements.filter(node => namedVariable(node, prompts, name)), name))),
  text(prompts, fn(prompts, "stableSystemPromptForCache")),
  ...[metadata, usage].flatMap(file => file.statements.filter(ts.isFunctionDeclaration).map(node => text(file, node))),
  ...["beginDirectModelRequest", "recordDirectModelRequest", "recordDirectModelFailure", "fromVercelUsage", "fromVercelFinishReason"].map(name => text(adapter, fn(adapter, name))),
  ...["completeStep", "turnContext", "assistantFromStep", "updateStepReasoningMetadata", "attachStreamedReasoningMetadata", "toolResultMessage", "retryableEmptySuccessfulResponse"].map(name => text(loop, fn(loop, name))),
  ...["isRecord", "providerMetadata", "stringify", "errorMessage"].map(name => text(utils, fn(utils, name))),
  ...["normalizeToolParameters", "normalizeSchemaNode"].map(name => text(schema, fn(schema, name))),
  text(native, fn(native, "reportVercelMetrics")), text(session, fn(session, "modelIdentifier")),
  text(memory, fn(memory, "formatMemoryExtractionMessages"))
].join("\n");
const code = `${pure}
class InertAccounting {
  wire() { ${callbackWiring} return { onUsage, onModelRequest }; }
  openRun() {
    const stepUsageRecords = [];
    ${foregroundVariables.map(node => text(session, node)).join("\n")}
    return {
      initial: ${text(session, foregroundObservers[0]!.initializer)},
      continuation: ${text(session, foregroundObservers[1]!.initializer)},
      persist: async (${persist.parameters.map(node => text(session, node)).join(", ")}) => {
        ${persistStatements.map(node => text(session, node)).join("\n")}
      }
    };
  }
  ${sessionMethods.map(name => text(session, method(session, "AgentSession", name))).join("\n")}
}
async function memoryCompletion() {
  const recentMessages = [{ role: 'user', content: 'Synthetic prior turn.' }, { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }];
  const originAnchors = undefined, options = {};
  ${memoryCompletion}
}
async function generateNativeText(model, messages, options) {
  const startedAtMs = 0, usage = memoryUsage, text = '["NO_MEMORY"]', finishReason = 'stop';
  ${[nativeReport, nativeReturn].map(node => text(native, node)).join("\n")}
}
function physicalAttempt(state) { return ${text(loop, attemptWrapper.initializer)}; }
({ InertAccounting, memoryCompletion, beginDirectModelRequest, recordDirectModelRequest,
   recordDirectModelFailure, completeStep, turnContext, physicalAttempt, LocalPromptProjectionCache });`;
const emitted = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
assert.doesNotMatch(emitted, /\b(?:require|import|process|fetch|setTimeout|setInterval)\s*[.(]/u);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { holdOperation?: string; telemetryThrows?: boolean; shapeDuration?: number } = {}) {
  const entered = deferred(), gate = deferred();
  const trace: string[] = [], records: any[] = [];
  let shapeClock = 0;
  const bindings = runInNewContext(emitted, {
    createHash, randomUUID, TransformStream, performance: { now: () => { shapeClock += options.shapeDuration ?? 0; return shapeClock; } },
    memoryUsage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cacheReadTokens: 0 },
    // External SDK error guards see ordinary Errors, never a provider exception.
    APICallError: { isInstance: () => false }, RetryError: { isInstance: () => false },
    redactSecrets: (value: unknown) => value,
    memoryExtractionPrompt: "Inert memory extraction.", memoryTimeAnchorInstruction: "Inert time anchor.", memoryModelTimeoutMs: 30000,
    recordSessionGoalRequestUsage: () => undefined,
    recordNativeTelemetry: async (_config: unknown, _root: unknown, event: any) => {
      const operation = event.metrics.requestContext.operation;
      trace.push(`${operation}:metrics-pushed`);
      if (options.holdOperation === operation) { entered.resolve(); await gate.promise; }
      if (options.telemetryThrows) throw new Error("Inert telemetry failure");
      trace.push(`${operation}:telemetry-settled`);
    }
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const model = { provider: "fixture-provider", modelId: "fixture-model" };
  const info = { modelAlias: "fixture", provider: model.provider, model: model.modelId, modelLabel: model.modelId };
  const state = Object.assign(new bindings.InertAccounting(), {
    activeOperation: "agent turn", modelRequestRecords: [], usageRecords: [], unpersistedRelatedUsage: [],
    options: { workspaceRoot: "/inert", config: { telemetry: { enabled: true }, defaultModel: "fixture",
      models: { fixture: { provider: "fixture", model: model.modelId } }, providers: { fixture: { type: model.provider } } },
      modelManager: { getModel: () => model, getInfo: () => info, listModels: () => [] } },
    recorder: { sessionId: "fixture-session", recordWithRuntimeContext: (event: any) => { records.push(event); }, flush: async () => undefined }
  });
  const wire = state.wire();
  const memoryState = { getToolModel: () => model, getUsageModelInfo: () => info,
    getModelRequestContext: () => ({ sessionId: "fixture-session", runId: "prior-run", turnId: "prior-turn" }),
    onModelRequest: wire.onModelRequest, onUsage: wire.onUsage };
  function run(withTool = false) {
    const callbacks = state.openRun();
    const tools = withTool ? [{ name: "FixtureTool", description: "Inert tool metadata.", parameters: { type: "object", properties: {} } }] : [];
    const loopState: any = { model, tools, context: { systemPrompt: "Stable foreground instruction.", tools,
      messages: [{ role: "user", content: "Synthetic foreground turn." }] },
      directAttempts: [], currentReasoning: new Map(), toolResults: new Map(), newMessages: [], completedSteps: 0,
      promptProjectionCache: new bindings.LocalPromptProjectionCache(),
      modelOptions: { requestContext: { sessionId: "fixture-session", runId: "run", turnId: "turn", operation: "agent",
        promptEpoch: 0, promptEpochReason: "initial", promptEpochCreatedAt: "2026-10-22T00:00:00Z" }, onRequestMetrics: callbacks.initial } };
    function begin(callId: string, continuation = false) {
      loopState.modelOptions.onRequestMetrics = continuation ? callbacks.continuation : callbacks.initial;
      bindings.beginDirectModelRequest(loopState, callId);
      return loopState.directCall.promptShape;
    }
    async function complete(callId: string, absentUsage = false) {
      const toolCalls = tools.map(tool => ({ type: "tool-call", toolCallId: `${callId}-tool`, toolName: tool.name, input: {} }));
      for (const call of toolCalls) loopState.toolResults.set(call.toolCallId, { content: [{ type: "text", text: "Inert external tool result." }] });
      const event = { callId, finishReason: withTool ? "tool-calls" : "stop", content: [{ type: "text", text: "Done." }, ...toolCalls], toolCalls, toolResults: [],
        performance: { responseTimeMs: 1, timeToFirstOutputMs: 1 }, usage: { inputTokens: absentUsage ? undefined : 1000,
          outputTokens: absentUsage ? undefined : 10, inputTokenDetails: { cacheReadTokens: absentUsage ? undefined : 1000 }, outputTokenDetails: {} } };
      await bindings.recordDirectModelRequest(loopState, event);
      const step = bindings.completeStep(loopState, event);
      return bindings.turnContext(loopState, step);
    }
    async function foreground(callId: string, continuation = false) {
      const shape = begin(callId, continuation);
      await callbacks.persist(await complete(callId));
      trace.push("agent:usage-appended");
      return shape;
    }
    return { callbacks, loopState, begin, complete, foreground, attempt: bindings.physicalAttempt(loopState),
      fail: (error: Error) => bindings.recordDirectModelFailure(loopState, error) };
  }
  return { state, records, trace, entered, gate, run,
    memory: async () => { await bindings.memoryCompletion.call(memoryState); trace.push("memory:usage-appended"); } };
}
function assertShape(record: any, shape: any) {
  assert.ok(shape, "shape is produced by beginDirectModelRequest, not invented by this fixture");
  assert.equal(record.promptEpochId, shape.epochId);
  assert.equal(record.stablePrefixHash, shape.stablePrefixHash);
}
function assertUnshaped(record: any) {
  assert.equal(record.promptEpochId, undefined);
  assert.equal(record.stablePrefixHash, undefined);
}
async function overlapScenario(overlap: boolean) {
  const f = fixture({ holdOperation: overlap ? "memory" : undefined });
  const seed = await f.run().foreground("prior-run");
  f.trace.length = 0;
  let shape;
  if (overlap) {
    const pending = f.memory(); await f.entered.promise;
    shape = await f.run().foreground("current-run");
    f.gate.resolve(); await pending;
  } else { await f.memory(); shape = await f.run().foreground("current-run"); }
  assert.equal(shape.epochId, seed.epochId);
  const metrics = f.state.modelRequestRecords;
  assert.equal(metrics.find((record: any) => record.requestContext.operation === "memory").promptShape, undefined);
  assert.equal(new Set(metrics.map((record: any) => record.requestId)).size, 3);
  assert.equal(f.records.length, 3);
  const summary = f.state.usageSummary();
  assert.equal(summary.calls, 3); assert.equal(summary.inputTokens, 3000); assert.equal(summary.cacheReadTokens, 2000);
  assert.equal(summary.reportedCacheUsage.sessionCacheHitRate, 2 / 3);
  return { f, shape, summary };
}

test("sequential memory control retains foreground epochs and unshaped helper usage", async () => {
  const { f, shape, summary } = await overlapScenario(false);
  assertUnshaped(f.state.usageRecords.find((record: any) => record.operation === "memory"));
  assert.equal(summary.reportedCacheUsage.epochCacheHitRates[shape.epochId], 1);
  assert.ok(f.state.usageReport().includes(`${shape.epochId}=100%`));
});

test("delayed background memory telemetry cannot borrow the next foreground epoch", async () => {
  const { f, shape, summary } = await overlapScenario(true);
  assert.deepEqual(f.trace, ["memory:metrics-pushed", "agent:metrics-pushed", "agent:telemetry-settled",
    "agent:usage-appended", "memory:telemetry-settled", "memory:usage-appended"]);
  assertUnshaped(f.state.usageRecords.find((record: any) => record.operation === "memory"));
  assert.equal(summary.reportedCacheUsage.epochCacheHitRates[shape.epochId], 1);
  assert.ok(f.state.usageReport().includes(`${shape.epochId}=100%`));
});

test("helper metrics between foreground metrics and persist cannot erase its epoch", async () => {
  const f = fixture({ holdOperation: "agent" }), run = f.run();
  const shape = run.begin("foreground");
  const pending = run.complete("foreground"); await f.entered.promise;
  await f.memory(); f.gate.resolve();
  await run.callbacks.persist(await pending);
  assertUnshaped(f.state.usageRecords[0]); assertShape(f.state.usageRecords[1], shape);
});

test("initial and continuation callbacks retain distinct real prompt epochs", async () => {
  const f = fixture(), run = f.run();
  const first = await run.foreground("first");
  run.loopState.modelOptions.requestContext.promptEpoch = 1;
  run.loopState.context.systemPrompt = "Changed foreground instruction.";
  const next = await run.foreground("next", true);
  assert.notEqual(first.epochId, next.epochId);
  assertShape(f.state.usageRecords[0], first); assertShape(f.state.usageRecords[1], next);
});

test("real budget-skipped diagnostics replace the earlier tuple with no shape", async () => {
  const f = fixture({ shapeDuration: 6 }), run = f.run();
  const first = await run.foreground("full");
  const next = await run.foreground("skipped", true);
  assert.equal(next, undefined);
  assert.equal(f.state.modelRequestRecords[1].promptShapeStatus, "skipped_due_to_budget");
  assertShape(f.state.usageRecords[0], first); assertUnshaped(f.state.usageRecords[1]);
});

test("missing usage remains an unknown counted request with its own diagnostics", async () => {
  const f = fixture(), run = f.run();
  const shape = run.begin("unknown");
  await run.callbacks.persist(await run.complete("unknown", true));
  assertShape(f.state.usageRecords[0], shape);
  assert.equal(f.state.usageSummary().calls, 1);
  assert.equal(f.state.usageRecords[0].inputTokens, undefined);
});

test("tool-bearing completeStep retains call identity and both known and unknown usage", async () => {
  for (const absentUsage of [false, true]) {
    const f = fixture(), run = f.run(true);
    const shape = run.begin("tool-step"); const context = await run.complete("tool-step", absentUsage);
    assert.equal(context.requestId, "tool-step");
    assert.equal(context.toolResults.length, 1);
    assert.equal(context.toolResults[0].toolCallId, "tool-step-tool");
    assert.equal(context.toolResults[0].content[0].text, "Inert external tool result.");
    assert.equal(run.loopState.lastStep.hadToolCalls, true); assert.equal(run.loopState.lastStep.error, undefined);
    await run.callbacks.persist(context);
    assertShape(f.state.usageRecords[0], shape);
    assert.equal(f.state.usageRecords[0].inputTokens, absentUsage ? undefined : 1000);
    assert.equal(f.state.usageSummary().calls, 1);
  }
});

test("failed request has no usage; next successful step cannot inherit its epoch", async () => {
  const f = fixture(), run = f.run();
  const failed = run.begin("failed"); await run.fail(new Error("Inert provider failure"));
  assert.equal(f.state.usageRecords.length, 0);
  run.loopState.modelOptions.requestContext.promptEpoch = 1;
  const shape = await run.foreground("success", true);
  assert.notEqual(shape.epochId, failed.epochId); assertShape(f.state.usageRecords[0], shape);
});

test("telemetry observer failure after capture does not discard completed request diagnostics", async () => {
  const f = fixture({ telemetryThrows: true });
  const shape = await f.run().foreground("observer-failure");
  assertShape(f.state.usageRecords[0], shape);
});

test("physical retry attempts retain the single logical call's real diagnostics", async () => {
  const f = fixture(), run = f.run();
  const shape = run.begin("retried-call");
  // Exercise the actual SDK middleware twice, not SDK scheduling or a provider.
  await assert.rejects(run.attempt({ doStream: async () => { throw new Error("Inert transport failure"); } }));
  const result = await run.attempt({ doStream: async () => ({ stream: new ReadableStream({
    start(controller) { controller.enqueue({ type: "finish" }); controller.close(); }
  }) }) });
  const reader = result.stream.getReader();
  while (!(await reader.read()).done) { /* Drain the inert completion marker. */ }
  await run.callbacks.persist(await run.complete("retried-call"));
  assertShape(f.state.usageRecords[0], shape);
  const metrics = f.state.modelRequestRecords[0];
  assert.equal(metrics.requestId, "retried-call"); assert.equal(metrics.attempts.length, 2);
  assert.equal(metrics.attempts[0].willRetry, true); assert.equal(metrics.attempts[1].willRetry, false);
  assert.equal(f.state.usageRecords.length, 1);
});

test("missing callback, missing identity, and mismatched identity never use global diagnostics", async () => {
  for (const kind of ["callback", "identity", "mismatch"]) {
    const f = fixture(), run = f.run();
    await run.foreground("seed"); run.begin("later", true);
    if (kind === "callback") run.loopState.modelOptions.onRequestMetrics = undefined;
    const context = await run.complete("later");
    if (kind === "identity") delete context.requestId;
    if (kind === "mismatch") context.requestId = "unrelated-request";
    await run.callbacks.persist(context);
    assertUnshaped(f.state.usageRecords[1]);
  }
});

test("storage-await overlap retains the foreground request's diagnostics", async () => {
  const f = fixture(), run = f.run(), entered = deferred(), gate = deferred();
  const shape = run.begin("foreground"); const context = await run.complete("foreground");
  f.state.recorder.flush = async () => { entered.resolve(); await gate.promise; };
  const pending = run.callbacks.persist(context); await entered.promise;
  // The real background native producer completes while storage is awaiting;
  // the serial foreground loop is not advanced to fabricate a shape callback.
  await f.memory(); gate.resolve(); await pending;
  assertShape(f.state.usageRecords.at(-1), shape);
});

test("subagent aggregate and every unowned helper usage stay unshaped without overlap", async () => {
  const f = fixture(); await f.run().foreground("seed");
  // Emotion/diary/query-rewrite callbacks also report under memory, not new operation labels.
  for (const operation of ["subagent", "memory", "vision", "compaction"]) {
    f.state.observeModelUsage({ inputTokens: 2000, outputTokens: 20, totalTokens: 2020 }, operation, "fixture");
    assertUnshaped(f.state.usageRecords.at(-1));
  }
  assert.equal(f.state.usageSummary().calls, 5);
});
