import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only selected accounting bodies execute. AgentSession, Recorder, SDK, storage,
// and model modules are read as source or not loaded at all.
const root = new URL("../", import.meta.url);
const source = (file: string) => ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const agent = source("src/agent/AgentSession.ts");
const replay = source("src/session/replay.ts");
const usageSource = source("src/observability/usage.ts");
const metadataSource = source("src/session/metadata.ts");
function nodes(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node): void => { if (predicate(child)) found.push(child); ts.forEachChild(child, visit); };
  visit(node);
  return found;
}
function one(found: ts.Node[], label: string): ts.Node { assert.equal(found.length, 1, label); return found[0]!; }
const agentClass = one(agent.statements.filter(n => ts.isClassDeclaration(n) && n.name?.text === "AgentSession"), "AgentSession");
assert.ok(ts.isClassDeclaration(agentClass));
const members = agentClass.members;
function method(name: string): ts.MethodDeclaration {
  const result = one(members.filter(n => ts.isMethodDeclaration(n) && n.name.getText(agent) === name), name);
  assert.ok(ts.isMethodDeclaration(result) && result.body);
  return result;
}
const loop = method("runTurnLoop");
function variable(name: string): ts.Node {
  return one(nodes(loop, n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(agent) === name)), name);
}
const terminalCatch = one(nodes(loop, n => ts.isCatchClause(n) && n.block.statements.some(s => ts.isIfStatement(s) && s.expression.getText(agent) === "retryCommitStarted")), "terminal catch");
assert.ok(ts.isCatchClause(terminalCatch));
const errorCall = one(terminalCatch.block.statements.filter(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(agent) === "this.recordError"), "failure accounting");
const sessionUsage = one(replay.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === "sessionUsage"), "pure replay usage projection");
function pureFunction(file: ts.SourceFile, name: string): string {
  return one(file.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name), name).getText(file).replace(/^export /u, "");
}
const pureHelpers = [
  ...["usageSnapshot", "readReportedCacheUsage", "reportedCacheTokenValue"].map(name => pureFunction(metadataSource, name)),
  ...["createSessionUsage", "calculateUsageCost", "calculateCacheHitRate", "summarizeUsage",
    "foldReportedCacheCounts", "projectedCacheRate", "weightedProjectedCacheRate", "sumReportedCacheUsage",
    "summarizeReportedCacheUsage", "sumSessionUsage", "sumDefined"].map(name => pureFunction(usageSource, name))
].join("\n");
const code = `
  ${pureHelpers}
  ${pureFunction(agent, "modelIdentifier")}
  ${sessionUsage.getText(replay).replace(/^export /u, "")}
  class Accounting {
    ${["usageModelInfo", "recordModelUsage", "takeRelatedUsage", "recordError", "recordHostedToolResult"].map(name => method(name).getText(agent)).join("\n")}
    async settle(mode, stepUsageRecords) {
      ${variable("usageAuditStarted").getText(agent)}
      const content = "done", finalContextStatus = {}, lastStepReasoningOutput = "";
      const stepReasoningBlocks = undefined, finalAssistantReference = undefined;
      const pendingRetryReply = undefined, runOptions = {}, retryCursor = undefined;
      const lastUserMessageReference = undefined, retryCommitStarted = false;
      ${variable("usageRecord").getText(agent)}
      ${variable("recordAssistantAudit").getText(agent)}
      if (mode === "success") await recordAssistantAudit();
      else { const message = mode; ${errorCall.getText(agent)} }
    }
  }
  ({ prototype: Accounting.prototype, sessionUsage, createSessionUsage, sumSessionUsage, summarizeUsage });
`;
type UsageOperation = "agent" | "plan" | "compaction" | "memory" | "subagent";
interface Counts {
  inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number;
  cacheWriteTokens?: number; cacheMissTokens?: number; reasoningTokens?: number;
}
interface SessionUsage extends Counts {
  operation: UsageOperation; modelAlias: string; provider: string; model: string;
  pricingKnown: boolean; costUsd?: number; time: string;
}
interface Summary extends Counts {
  costUsd?: number;
  reportedCacheUsage?: { inputTokensComplete?: boolean };
}
interface Event { type: string; usage?: SessionUsage; relatedUsage?: SessionUsage[]; preparationUsage?: SessionUsage[] }
interface Accounting {
  activeOperation?: string;
  usageRecords: SessionUsage[];
  recordModelUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number }, operation: UsageOperation): SessionUsage;
  takeRelatedUsage(): SessionUsage[] | undefined;
  recordHostedToolResult(tool: string, result: unknown, id: string, sequence: number): void;
  settle(mode: "success" | "failure" | "cancelled", records: SessionUsage[]): Promise<void>;
}
// This timeout applies only to VM setup; no asynchronous provider or process is created.
const extracted = runInNewContext(stripTypeScriptTypes(code, { mode: "strip" }), {}, {
  timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
}) as {
  prototype: Accounting;
  sessionUsage(events: Event[]): SessionUsage[];
  createSessionUsage(counts: Counts, operation: UsageOperation, model: { modelAlias: string; provider: string; model: string }): SessionUsage;
  sumSessionUsage(records: SessionUsage[]): SessionUsage;
  summarizeUsage(records: SessionUsage[]): Summary;
};
const { createSessionUsage, sumSessionUsage, summarizeUsage } = extracted;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture(operation: string | undefined = "agent turn") {
  const events: Event[] = [{ type: "user_message", preparationUsage: [] }];
  const pricing = { inputPerMillionTokens: 2, outputPerMillionTokens: 4, cacheReadPerMillionTokens: 0.5 };
  const info = { modelAlias: "fixture", provider: "fixture", modelLabel: "fixture", pricing };
  const state: Accounting = Object.assign(Object.create(extracted.prototype) as Accounting, {
    activeOperation: operation, usageRecords: [], unpersistedRelatedUsage: [], modelRequestRecords: [],
    options: { modelManager: { getModel: () => ({ provider: "fixture", modelId: "fixture" }), getInfo: () => info, listModels: () => [] },
      config: { models: { fixture: { provider: "fixture", model: "fixture", pricing } }, providers: { fixture: { type: "fixture" } } } },
    recorder: { record: (event: Event) => { events.push(json(event)); } },
    contextMemory: { snapshot: () => ({}) }
  });
  return { state, events, restored: () => extracted.sessionUsage(events) };
}
const first = { inputTokens: 11, outputTokens: 3, totalTokens: 14, cacheReadTokens: 2 };
const second = { inputTokens: 23, outputTokens: 7, totalTokens: 30, cacheReadTokens: 5 };
function assertTotals(records: SessionUsage[], live: SessionUsage[]): void {
  const restored = summarizeUsage(records), expected = summarizeUsage(live);
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "cacheMissTokens", "reasoningTokens"] as const) assert.equal(restored[field], expected[field], field);
  if (expected.costUsd === undefined) assert.equal(restored.costUsd, undefined);
  else { assert.notEqual(restored.costUsd, undefined); assert.ok(Math.abs(restored.costUsd! - expected.costUsd) < 1e-12); }
}

for (const ending of ["success", "failure", "cancelled"] as const) {
  test(`active compaction measurements survive ${ending} accounting exactly once`, async () => {
    const f = fixture();
    f.state.recordModelUsage(first, "compaction");
    f.state.recordModelUsage(second, "compaction");
    const step = f.state.recordModelUsage({ inputTokens: 4, outputTokens: 1, totalTokens: 5, cacheReadTokens: 0 }, "agent");
    await f.state.settle(ending, [step]);
    assert.equal(f.restored().filter(r => r.operation === "compaction").length, 2);
    assertTotals(f.restored(), f.state.usageRecords);
    assert.equal(f.state.takeRelatedUsage(), undefined);
    assert.deepEqual(f.events[0]?.preparationUsage, [], "already-recorded user preparation is not rewritten");
  });
}

test("earlier tool-result drain owns compaction and related usage, not the final audit", async () => {
  const f = fixture();
  for (const operation of ["compaction", "memory", "subagent"] as const) f.state.recordModelUsage(first, operation);
  f.state.recordHostedToolResult("inert", "done", "call", 1);
  await f.state.settle("success", []);
  assert.equal(f.events[1]?.relatedUsage?.length, 3);
  assert.equal(f.events[2]?.relatedUsage, undefined);
  assert.equal(f.state.takeRelatedUsage(), undefined, "close/new-session fallback has nothing to repeat");
  assertTotals(f.restored(), f.state.usageRecords);
});

test("manual compaction keeps its separate aggregate and zero/unknown remain distinct", async () => {
  const manual = fixture("conversation compaction");
  manual.state.recordModelUsage(first, "compaction");
  manual.state.recordModelUsage(second, "compaction");
  assert.equal(manual.state.takeRelatedUsage(), undefined);
  manual.events.push({ type: "assistant_message", usage: sumSessionUsage(manual.state.usageRecords) });
  assertTotals(manual.restored(), manual.state.usageRecords);
  const idle = fixture();
  idle.state.activeOperation = undefined;
  idle.state.recordModelUsage(first, "compaction");
  assert.equal(idle.state.takeRelatedUsage(), undefined, "retry preflight remains outside this scoped fix");
  const active = fixture();
  active.state.recordModelUsage({}, "compaction");
  active.state.recordModelUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }, "compaction");
  await active.state.settle("success", []);
  assert.equal(active.restored()[0]?.inputTokens, undefined);
  assert.equal(active.restored()[1]?.inputTokens, 0);
  assert.equal(summarizeUsage(active.restored()).reportedCacheUsage?.inputTokensComplete, false);
  const noop = fixture();
  await noop.state.settle("success", []);
  assert.equal(noop.restored().length, 0);
});

test("source wiring records user preparation before active-turn compaction and excludes request metrics", () => {
  const turn = method("runTurn");
  const preparation = one(nodes(turn, n => ts.isCallExpression(n) && n.expression.getText(agent) === "this.prepareContext"), "active-turn preparation");
  const enclosingTry = one(nodes(turn, n => ts.isTryStatement(n) && n.tryBlock.statements.some(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(agent) === "prepared"))), "preparation try");
  assert.ok(ts.isTryStatement(enclosingTry));
  assert.ok(enclosingTry.tryBlock.statements.some(s => s.end < preparation.pos && ts.isExpressionStatement(s) && s.expression.getText(agent) === "recordUserMessage()"));
  assert.match(variableText(turn, "createUserMessage"), /preparationUsage: this\.usageRecords\.slice\(usageBeforePreparation\)/u);
  assert.match(variableText(turn, "recordUserMessage"), /if \(userMessageRecorded\) return userMessageReference/u);
  const f = fixture();
  f.events.push({ type: "model_request", usage: createSessionUsage(first, "compaction", { modelAlias: "fixture", provider: "fixture", model: "fixture" }) });
  assert.equal(f.restored().length, 0, "metrics do not become a second accounting ledger");
});
function variableText(scope: ts.Node, name: string): string {
  return one(nodes(scope, n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(agent) === name)), name).getText(agent);
}
