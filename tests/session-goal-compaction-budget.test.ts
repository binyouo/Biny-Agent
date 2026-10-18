import assert from "node:assert/strict";
import { projectMessageSentAt } from "../src/agent/modelMessages.js";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read product files as data. Only the named methods and callbacks below execute,
// against explicit in-memory doubles. No product imports, constructors, SDK,
// providers, Host, Recorder, SQLite, checkpoint persistence or child processes.
const root = new URL("../", import.meta.url);
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(path, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const memorySource = source("src/agent/context/ContextMemory.ts");
const agentSource = source("src/agent/AgentSession.ts");
const adapterSource = source("src/agent/core/vercelModelAdapter.ts");
function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(child: ts.Node): void {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}
function method(file: ts.SourceFile, className: string, name: string): string {
  const owners = file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.equal(owners.length, 1);
  const matches = owners[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!.getText(file);
}
function arrow(file: ts.SourceFile, name: string, optional = false): string | undefined {
  const matches = descendants(file, node => ts.isPropertyAssignment(node) && node.name.getText(file) === name) as ts.PropertyAssignment[];
  if (optional && matches.length === 0) return undefined;
  assert.equal(matches.length, 1, name);
  assert.ok(ts.isArrowFunction(matches[0]!.initializer));
  return matches[0]!.initializer.getText(file);
}
const adapterFunctions = adapterSource.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "modelMessages");
assert.equal(adapterFunctions.length, 1);
const adapterFunction = adapterFunctions[0]!.getText(adapterSource).replace(/^export /u, "");
const isolated = stripTypeScriptTypes(`
class MemoryBoundary {
${["createSummary", "compactMessages", "compactClosedRunContext"].map(name => method(memorySource, "ContextMemory", name)).join("\n")}
}
class AgentBoundary {
${["sessionGoalBudgetStopped", "sideModelRequestContext"].map(name => method(agentSource, "AgentSession", name)).join("\n")}
}
function createGuard() { return ${arrow(agentSource, "canRequestSummary", true) ?? "undefined"}; }
function createTransform(bindings) {
  const { projectForModelRequest, activeRequestContext, abortSignal, applyRunContextCompaction, emitUpdate, completedStepsBeforeRun, observedSteps, runBudget } = bindings;
  let softLimitWarningInjected = false;
  return ${arrow(agentSource, "transformContext")};
}
${adapterFunction}
({ memory: MemoryBoundary.prototype, agent: AgentBoundary.prototype, createGuard, createTransform, modelMessages });
`, { mode: "strip" });

type Mode = "automatic" | "manual" | "overflow";
type Scenario = "exhausted" | "unknown" | "usage-failure" | "sufficient" | "no-goal" | "replaced" | "cleared";
interface RequestContext { sessionId?: string; sessionGoalId?: string; operation?: string }
interface Goal { goalId: string; status: string; tokenBudget?: number; tokensUsed: number; usageKnown: boolean; revision: number }
interface SummaryResult { text: string; finishReason: string; usage: { inputTokens: number; cacheReadTokens: number; outputTokens: number } }
interface Metrics { requestContext: RequestContext; usage: SummaryResult["usage"] }
interface GenerationOptions { requestContext: RequestContext; onRequestMetrics(metrics: Metrics): Promise<void> }
interface CompactionResult { compacted: boolean; summary?: string; compactedMessageCount?: number; retainedMessageCount?: number; tokensBefore?: number }
interface Memory {
  history: string[];
  summary?: string;
  checkpoint?: unknown;
  compactionFailure?: unknown;
  compactionOptions: { canRequestSummary?: () => boolean; now(): number; onFailure(): Promise<void>; resolveSummaryBudget?: () => unknown; configurationIdentity?: () => string };
  compactedMessages: number;
  createSummary(plan: unknown, hint: string | undefined, maxTokens: number, model: unknown, mode: Mode, key: string, signal?: AbortSignal): Promise<unknown>;
  compactMessages(messages: string[], hint: string | undefined, signal: AbortSignal | undefined, mode: Mode): Promise<CompactionResult>;
  compactClosedRunContext(messages: string[], signal: AbortSignal | undefined, mode: "automatic" | "overflow"): Promise<CompactionResult | undefined>;
  getModel(): unknown;
  currentBudget(): { maxInputTokens: number; contextWindow: number; maxOutputTokens: number };
  currentCheckpointMessage(): undefined;
  inputBudget(): number;
  compactionLimits(): { keepRecentTokens: number; keepRecentMessages: number; maxSummaryTokens: number };
  getModelRequestContext(): RequestContext | undefined;
  onModelRequest(metrics: Metrics): Promise<void>;
  onUsage(): Promise<void>;
  replaceHistory(messages: string[]): void;
  getHistory(): string[];
  refreshEstimatedBudget(): void;
  advancePromptEpoch(): void;
  projectCompactionCheckpoint(messages: string[]): string[];
  shouldCompactRunContext(): boolean;
  compactRunContextIfNeeded(context: { messages: string[] }, signal?: AbortSignal): Promise<CompactionResult | undefined>;
}
interface Agent {
  activeOperation: string;
  runSessionGoalId?: string;
  sessionGoalUsageFailure?: Error;
  options: { sessionGoals: { get(): Goal | undefined } };
  recorder: { sessionId: string; runtimeContextSnapshot(): { runId: string; turnId: string } };
  contextMemory: Memory & { getPromptEpoch(): number; getPromptEpochReason(): string; getPromptEpochCreatedAt(): string };
  sessionGoalBudgetStopped(): boolean;
  sideModelRequestContext(): RequestContext | undefined;
}
interface TransformBindings {
  projectForModelRequest(messages: string[]): Promise<string[]>;
  activeRequestContext: { messages: string[] };
  abortSignal: AbortSignal;
  applyRunContextCompaction(context: { messages: string[] }): Promise<void>;
  emitUpdate(): void;
  completedStepsBeforeRun: number;
  observedSteps: number;
  runBudget: { softStepLimit: number };
}
interface AdapterState {
  config: { transformContext(messages: string[]): Promise<unknown[]>; onRequestContext(): Promise<void> };
  context: { messages: string[]; tools: [] };
  vercelModel?: object;
  signal: AbortSignal;
}
interface Extracted {
  memory: Memory;
  agent: Agent;
  createGuard(this: Agent): (() => boolean) | undefined;
  createTransform(this: Agent, bindings: TransformBindings): (messages: string[]) => Promise<unknown[]>;
  modelMessages(state: AdapterState): Promise<unknown[]>;
}
class FakeSummaryError extends Error {
  readonly kind: string;
  constructor(kind: string) { super(`Compaction summary rejected: ${kind}`); this.kind = kind; }
}
function fixture(scenario: Scenario, operation = "agent turn", firstFinish = "length", firstText = "valid") {
  const counts = { summaries: 0, usage: 0, failure: 0, fallback: 0, history: 0, epoch: 0, applied: 0, telemetry: 0, provider: 0 };
  const controller = new AbortController();
  const budgetError = new Error("usage accounting failed");
  const cancelError = new Error("cancel compaction");
  const control = { cancelAfterFirst: false, firstDenied: false, afterProjection: undefined as (() => void) | undefined };
  let goal: Goal | undefined = scenario === "no-goal" ? undefined : { goalId: "goal-a", status: "active", tokenBudget: scenario === "sufficient" ? 100 : 5, tokensUsed: 0, usageKnown: true, revision: 0 };
  const contexts: RequestContext[] = [];
  const model = { provider: "inert", modelId: "summary" };
  const extracted = runInNewContext(isolated, {
    CompactionSummaryError: FakeSummaryError,
    buildCompactionSystemPrompt: () => "summary instructions",
    previousCheckpointSources: () => ({ text: "", catalog: new Map() }),
    estimateTokens: () => 1,
    buildCompactionDataPrompt: () => "inert transcript",
    stripTransientTurnContext: (messages: string[]) => messages,
    boundedCompactionTranscript: () => ({ text: "inert transcript", catalog: new Map([["m0", {}]]) }),
    generateNativeText: async (_model: unknown, _messages: unknown, options: GenerationOptions): Promise<SummaryResult> => {
      counts.summaries += 1;
      contexts.push(options.requestContext);
      const result = { text: counts.summaries === 1 ? firstText : "valid", finishReason: counts.summaries === 1 ? firstFinish : "stop", usage: { inputTokens: 4, cacheReadTokens: 0, outputTokens: 1 } };
      // Model settlement double: the real native text helper awaits this observer
      // before returning the completed summary to createSummary.
      await options.onRequestMetrics({ requestContext: options.requestContext, usage: result.usage });
      if (control.cancelAfterFirst) controller.abort(cancelError);
      return result;
    },
    cleanModelSummary: (value: string) => value === "invalid" ? "" : value,
    truncateStructuredSummary: (value: string) => value,
    redactSecrets: (value: string) => value,
    checkpointFromCitedSummary: (value: string) => value === "uncited" ? undefined : ({ summary: value, state: {}, evidence: [{}] }),
    appendFileOperationSummary: (value: string) => value,
    fileOperationClaims: (_summary: unknown, state: unknown) => ({ state, evidence: [] }),
    deterministicSummary: () => { counts.fallback += 1; return "fallback"; },
    checkpointStateFromSummary: () => ({}),
    groundDeterministicCheckpoint: () => ({ state: {}, evidence: [{}] }),
    estimateMessageTokens: (messages: unknown[]) => messages.length * 100,
    prepareCompaction: (messages: string[]) => ({ compacted: messages.slice(0, 2), retained: messages.slice(2), splitTurn: false }),
    createHash: () => ({ update: () => ({ digest: () => "inert-fingerprint" }) }),
    noCompaction: (summary: string | undefined) => ({ compacted: false, summary }),
    compactionCheckpointMessage: () => "checkpoint",
    cloneCheckpointState: (value: unknown) => value,
    cloneDraftClaimEvidence: (value: unknown) => value,
    compactionPromptVersion: 4,
    projectMessageSentAt,
    toModelMessages: (messages: unknown[]) => messages
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Extracted;
  const memory = Object.assign(Object.create(extracted.memory) as Memory, {
    history: ["old-a", "old-b", "recent"], summary: "previous", compactedMessages: 0,
    compactionFailure: { inputFingerprint: "older", kind: "provider_error", retryAfter: 0 },
    compactionOptions: { now: () => 100, onFailure: async () => { counts.failure += 1; } },
    getModel: () => model,
    currentBudget: () => ({ maxInputTokens: 10_000, contextWindow: 12_000, maxOutputTokens: 100 }),
    currentCheckpointMessage: () => undefined,
    inputBudget: () => 10_000,
    compactionLimits: () => ({ keepRecentTokens: 1, keepRecentMessages: 1, maxSummaryTokens: 100 }),
    getModelRequestContext: () => agent.sideModelRequestContext(),
    onModelRequest: async (metrics: Metrics) => {
      if (metrics.requestContext.sessionGoalId === goal?.goalId && goal) {
        if (scenario === "usage-failure") agent.sessionGoalUsageFailure = budgetError;
        else if (scenario === "unknown") { goal.usageKnown = false; goal.status = "blocked"; }
        else { goal.tokensUsed += 5; if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) goal.status = "budget_limited"; }
      }
      if (scenario === "cleared") goal = undefined;
      if (scenario === "replaced") goal = { goalId: "goal-b", status: "budget_limited", tokenBudget: 1, tokensUsed: 1, usageKnown: true, revision: 0 };
    },
    onUsage: async () => { counts.usage += 1; },
    replaceHistory: (messages: string[]) => { counts.history += 1; memory.history = messages; },
    getHistory: () => memory.history,
    refreshEstimatedBudget: () => undefined,
    advancePromptEpoch: () => { counts.epoch += 1; },
    projectCompactionCheckpoint: (messages: string[]) => messages,
    shouldCompactRunContext: () => true,
    compactRunContextIfNeeded: async (context: { messages: string[] }, signal?: AbortSignal) => await memory.compactClosedRunContext(context.messages, signal, "automatic"),
    getPromptEpoch: () => 0, getPromptEpochReason: () => "initial", getPromptEpochCreatedAt: () => "initial"
  });
  const agent: Agent = Object.assign(Object.create(extracted.agent) as Agent, {
    activeOperation: operation, runSessionGoalId: goal?.goalId,
    options: { sessionGoals: { get: () => goal } },
    recorder: { sessionId: "session-a", runtimeContextSnapshot: () => ({ runId: "run-a", turnId: "turn-a" }) },
    contextMemory: memory
  });
  const guard = extracted.createGuard.call(agent);
  memory.compactionOptions.canRequestSummary = guard === undefined ? undefined : () => !control.firstDenied && guard();
  const transform = extracted.createTransform.call(agent, {
    projectForModelRequest: async (messages: string[]) => { control.afterProjection?.(); return messages; },
    activeRequestContext: { messages: memory.history }, abortSignal: controller.signal,
    applyRunContextCompaction: async () => { counts.applied += 1; }, emitUpdate: () => undefined,
    completedStepsBeforeRun: 2, observedSteps: 0, runBudget: { softStepLimit: 1 }
  });
  async function beforeProvider(direct: boolean): Promise<void> {
    await extracted.modelMessages({
      config: { transformContext: transform, onRequestContext: async () => { counts.telemetry += 1; } },
      context: { messages: memory.history, tools: [] }, signal: controller.signal,
      vercelModel: direct ? {} : undefined
    });
    // Explicit fake admission boundary, not an SDK/provider invocation.
    counts.provider += 1;
  }
  return { memory, agent, counts, contexts, control, controller, budgetError, cancelError, goal: () => goal, beforeProvider };
}

for (const mode of ["automatic", "overflow"] as const) {
  for (const scenario of ["exhausted", "unknown", "usage-failure"] as const) {
    test(`${mode}: ${scenario} stops repair and retains history without failure or fallback`, { timeout: 5_000 }, async () => {
      const f = fixture(scenario);
      const history = [...f.memory.history];
      const failure = f.memory.compactionFailure;
      const result = await f.memory.compactClosedRunContext(f.memory.history, f.controller.signal, mode);
      assert.equal(result, undefined);
      assert.equal(f.counts.summaries, 1);
      assert.equal(f.counts.usage, 1);
      assert.equal(f.counts.failure, 0);
      assert.equal(f.counts.fallback, 0);
      assert.equal(f.counts.history, 0);
      assert.equal(f.counts.epoch, 0);
      assert.deepEqual(f.memory.history, history);
      assert.equal(f.memory.summary, "previous");
      assert.equal(f.memory.compactionFailure, failure);
      assert.equal(f.contexts[0]?.sessionGoalId, "goal-a");
    });
  }
}
for (const text of ["invalid", "uncited"]) {
  test(`budget stops supported ${text} repair`, { timeout: 5_000 }, async () => {
    const f = fixture("exhausted", "agent turn", "stop", text);
    assert.equal(await f.memory.compactClosedRunContext(f.memory.history, f.controller.signal, "automatic"), undefined);
    assert.equal(f.counts.summaries, 1);
  });
}
for (const scenario of ["sufficient", "no-goal", "replaced", "cleared"] as const) {
  test(`${scenario}: existing repair remains available`, { timeout: 5_000 }, async () => {
    const f = fixture(scenario);
    const result = await f.memory.compactClosedRunContext(f.memory.history, f.controller.signal, "automatic");
    assert.equal(result?.compacted, true);
    assert.equal(f.counts.summaries, 2);
    assert.equal(f.counts.failure, 0);
    assert.equal(f.counts.history, 1);
    if (scenario === "sufficient") assert.equal(f.goal()?.tokensUsed, 10);
  });
}
test("manual compaction policy remains unchanged", { timeout: 5_000 }, async () => {
  const f = fixture("exhausted", "conversation compaction");
  f.agent.runSessionGoalId = undefined;
  const result = await f.memory.compactMessages(f.memory.history, undefined, f.controller.signal, "manual");
  assert.equal(result.compacted, true);
  assert.equal(f.counts.summaries, 2);
});
test("a valid first summary remains usable at the budget boundary", { timeout: 5_000 }, async () => {
  const f = fixture("exhausted", "agent turn", "stop");
  const result = await f.memory.compactClosedRunContext(f.memory.history, f.controller.signal, "automatic");
  assert.equal(result?.compacted, true);
  assert.equal(f.counts.summaries, 1);
  assert.equal(f.counts.history, 1);
  assert.equal(f.goal()?.tokensUsed, 5);
});
test("cancellation takes priority over denied repair", { timeout: 5_000 }, async () => {
  const f = fixture("exhausted");
  f.control.cancelAfterFirst = true;
  await assert.rejects(f.memory.compactClosedRunContext(f.memory.history, f.controller.signal, "overflow"), error => error === f.cancelError);
  assert.equal(f.counts.summaries, 1);
  assert.equal(f.counts.failure, 0);
  assert.equal(f.counts.fallback, 0);
});
test("already stopped active goal does not start a summary", { timeout: 5_000 }, async () => {
  const f = fixture("exhausted");
  f.goal()!.status = "budget_limited";
  assert.equal(await f.memory.compactClosedRunContext(f.memory.history, f.controller.signal, "automatic"), undefined);
  assert.equal(f.counts.summaries, 0);
});
for (const direct of [true, false]) {
  for (const scenario of ["exhausted", "unknown", "usage-failure"] as const) {
    for (const finish of ["stop", "length"]) {
      test(`${direct ? "direct" : "injected"} preprocessing: ${scenario}/${finish} blocks the prepared main request`, { timeout: 5_000 }, async () => {
        const f = fixture(scenario, "agent turn", finish);
        const history = [...f.memory.history];
        const failure = f.memory.compactionFailure;
        await assert.rejects(f.beforeProvider(direct), error => scenario === "usage-failure" ? error === f.budgetError : /goal budget stopped/u.test(String(error)));
        assert.equal(f.counts.summaries, 1);
        assert.equal(f.counts.usage, 1);
        assert.equal(f.counts.failure, 0);
        assert.equal(f.counts.fallback, 0);
        assert.equal(f.counts.provider, 0);
        assert.equal(f.counts.telemetry, 0);
        assert.equal(f.counts.applied, finish === "stop" ? 1 : 0);
        assert.equal(f.goal()?.tokensUsed, scenario === "exhausted" ? 5 : 0);
        assert.equal(f.goal()?.status, scenario === "exhausted" ? "budget_limited" : scenario === "unknown" ? "blocked" : "active");
        assert.equal(f.goal()?.usageKnown, scenario !== "unknown", "pre-provider denial must not create phantom unknown usage");
        assert.equal(f.counts.history, finish === "stop" ? 1 : 0);
        assert.equal(f.counts.epoch, finish === "stop" ? 1 : 0);
        assert.deepEqual(f.memory.history, finish === "stop" ? ["recent"] : history);
        assert.equal(f.memory.summary, finish === "stop" ? "valid" : "previous");
        assert.equal(f.memory.compactionFailure, finish === "stop" ? undefined : failure);
      });
    }
  }
  test(`${direct ? "direct" : "injected"} preprocessing: sufficient budget admits main request`, { timeout: 5_000 }, async () => {
    const f = fixture("sufficient");
    await f.beforeProvider(direct);
    assert.equal(f.counts.summaries, 2);
    assert.equal(f.counts.usage, 2);
    assert.equal(f.counts.failure, 0);
    assert.equal(f.counts.fallback, 0);
    assert.equal(f.counts.provider, 1);
    assert.equal(f.counts.telemetry, direct ? 1 : 0);
    assert.equal(f.goal()?.status, "active");
    assert.equal(f.goal()?.usageKnown, true);
  });
}
