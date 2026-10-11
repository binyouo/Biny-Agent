import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createSessionUsage, sumSessionUsage, summarizeUsage } from "../src/observability/usage.js";
import { usageSnapshot } from "../src/session/metadata.js";
import { replaySessionEvents } from "../src/session/replay.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { ensureAgentDirs } from "../src/session/store.js";

// The audit-failure fixture isolates only recorder failures. Shared usage and
// branch/replay behavior comes from real modules so new internal helpers stay wired.
const root = new URL("../", import.meta.url);
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(path, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(child: ts.Node): void {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}
function exactlyOne(nodes: ts.Node[], label: string): ts.Node {
  assert.equal(nodes.length, 1, label);
  return nodes[0]!;
}
const agent = source("src/agent/AgentSession.ts");
const agentClass = exactlyOne(agent.statements.filter(node => ts.isClassDeclaration(node)
  && node.name?.text === "AgentSession"), "AgentSession");
assert.ok(ts.isClassDeclaration(agentClass));
const classMembers = agentClass.members;
function method(name: string): ts.MethodDeclaration {
  const node = exactlyOne(classMembers.filter(member => ts.isMethodDeclaration(member)
    && ts.isIdentifier(member.name) && member.name.text === name), name);
  assert.ok(ts.isMethodDeclaration(node) && node.body);
  return node;
}
const loop = method("runTurnLoop");
function variable(name: string): ts.VariableStatement[] {
  return descendants(loop, node => ts.isVariableStatement(node) && node.declarationList.declarations.some(
    item => ts.isIdentifier(item.name) && item.name.text === name)) as ts.VariableStatement[];
}
const audit = exactlyOne(variable("recordAssistantAudit"), "actual audit closure");
const total = exactlyOne(variable("usageRecord"), "actual step aggregation");
const flags = variable("usageAuditStarted");
assert.ok(flags.length === 0 || flags.length === 1, "baseline or candidate local guard");
const catchNode = exactlyOne(descendants(loop, node => ts.isCatchClause(node)
  && node.block.statements.some(statement => ts.isIfStatement(statement)
    && statement.expression.getText(agent) === "retryCommitStarted")), "terminal catch");
assert.ok(ts.isCatchClause(catchNode));
const retryGuard = catchNode.block.statements[0]!;
assert.ok(ts.isIfStatement(retryGuard) && retryGuard.expression.getText(agent) === "retryCommitStarted"
  && ts.isThrowStatement(retryGuard.thenStatement), "retry commit retains first-priority throw");
const errorCall = exactlyOne(catchNode.block.statements.filter(statement => ts.isExpressionStatement(statement)
  && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(agent) === "this.recordError"), "actual catch accounting");
const code = [
  `class AccountingFixture {
    ${method("recordError").getText(agent)}
    ${method("takeRelatedUsage").getText(agent)}
    async settle(mode, stepUsageRecords, retryCommitStarted = false) {
      ${flags.map(node => node.getText(agent)).join("\n")}
      const content = "done";
      const finalContextStatus = {};
      const lastStepReasoningOutput = "";
      const stepReasoningBlocks = undefined;
      const finalAssistantReference = undefined;
      const pendingRetryReply = undefined;
      const runOptions = {};
      const retryCursor = undefined;
      const lastUserMessageReference = undefined;
      ${total.getText(agent)}
      ${audit.getText(agent)}
      try {
        if (mode !== "provider-failure") await recordAssistantAudit();
        if (mode !== "success") throw new Error("inert later failure");
      } catch (error) {
        ${retryGuard.getText(agent)}
        const message = "inert later failure";
        ${errorCall.getText(agent)}
      }
    }
  }
  ({ fixture: AccountingFixture.prototype });`
].join("\n");

interface Counts {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheMissTokens?: number;
}
interface Projection {
  version: 1; inputTokens?: number; cacheReadTokens?: number;
  inputTokensComplete?: boolean; cacheReadTokensComplete?: boolean;
  latestRequestRecorded?: true; latestRequestInputTokens?: number; latestRequestCacheReadTokens?: number;
  latestCacheHitRate?: number; sessionCacheHitRate?: number;
}
interface Usage extends Counts {
  operation: string; modelAlias: string; provider: string; model: string; pricingKnown: boolean;
  costUsd?: number; time?: string; reportedCacheUsage?: Projection;
  latestRequestInputTokens?: number; latestRequestCacheReadTokens?: number;
}
interface Summary extends Counts {
  calls: number; pricingKnown: boolean; costUsd?: number; latestCacheHitRate?: number; reportedCacheUsage?: Projection;
}
interface Event {
  type: string; usage?: Usage; relatedUsage?: Usage[]; preparationUsage?: Usage[]; content?: string;
  messageId?: string; parentMessageId?: string; slotId?: string; auditOnly?: boolean;
  message?: { role: string; content: string | unknown[]; usage?: Counts };
  runtime?: { runId: string; eventId: string; eventSeq: number }; metrics?: { usage: Counts };
}
interface ModelInfo {
  modelAlias: string; provider: string; model: string;
  pricing?: { inputPerMillionTokens?: number; outputPerMillionTokens?: number; cacheReadPerMillionTokens?: number };
}
interface Extracted {
  createSessionUsage(counts: Counts, operation: string, info: ModelInfo, time: string): Usage;
  sumSessionUsage(records: Usage[]): Usage;
  summarizeUsage(records: Usage[]): Summary;
  sessionUsage(events: Event[]): Usage[];
  fixture: { settle(mode: "success" | "provider-failure" | "terminal-failure", records: Usage[], retryCommitStarted?: boolean): Promise<void> };
}
// The timeout bounds VM setup only; later extracted function calls are not timed by it.
const accountingFixture = runInNewContext(stripTypeScriptTypes(code, { mode: "strip" }), {
  Error, sumSessionUsage, usageSnapshot
}, {
  timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
}) as Pick<Extracted, "fixture">;
const extracted: Extracted = {
  ...accountingFixture,
  createSessionUsage: createSessionUsage as Extracted["createSessionUsage"],
  sumSessionUsage: sumSessionUsage as Extracted["sumSessionUsage"],
  summarizeUsage: summarizeUsage as Extracted["summarizeUsage"],
  sessionUsage: events => replaySessionEvents(events as SessionEvent[]).usage,
};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function usage(counts: Counts, operation = "agent", priced = true): Usage {
  return extracted.createSessionUsage(counts, operation, {
    modelAlias: "fixture", provider: "fixture", model: "fixture",
    pricing: priced ? { inputPerMillionTokens: 2, outputPerMillionTokens: 4, cacheReadPerMillionTokens: 0.5 } : undefined
  }, "2026-10-11T00:00:00.000Z");
}
function fixture(related: Usage[] = [], auditFailure?: "before-append" | "after-append") {
  const events: Event[] = [];
  const write = (event: Event): void => {
    if (event.type === "assistant_message" && auditFailure === "before-append") throw new Error("inert sink refused");
    events.push(json(event));
    if (event.type === "assistant_message" && auditFailure === "after-append") throw new Error("inert sink uncertain");
  };
  const state = Object.assign(Object.create(extracted.fixture) as Extracted["fixture"], {
    unpersistedRelatedUsage: [...related],
    recorder: { record: write, recordAndFlush: async (event: Event) => { write(event); } },
    checkpointPersistenceError: undefined, contextMemory: { snapshot: () => ({}) }
  });
  return { state, events, restored: () => extracted.sessionUsage(events) };
}
const first = () => usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 });
const second = () => usage({ inputTokens: 200, outputTokens: 30, totalTokens: 230, cacheReadTokens: 100 });

test("completed tool-step usage survives a later provider failure, disk replay and cold Agent reopen", { timeout: 20_000 }, async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-failed-step-usage-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(workspace, "global");
  await ensureAgentDirs(workspace);
  const config = configSchema.parse({
    ...defaultConfig, defaultModel: "fixture",
    agent: { ...defaultConfig.agent, toolExecutionMode: "direct" },
    providers: { fixture: { type: "openai", apiKey: "fixture-placeholder" } },
    models: { fixture: { provider: "fixture", model: "fixture", contextWindow: 1_000_000,
      pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 4, cacheReadPerMillionTokens: 0.5 } } },
    context: { ...defaultConfig.context,
      emotion: { ...defaultConfig.context.emotion, enabled: false },
      identity: { ...defaultConfig.context.identity, enabled: false },
      compaction: { ...defaultConfig.context.compaction, enabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  let requests = 0;
  const model: AgentModel = {
    provider: "fixture", modelId: "fixture", supportsTools: true, vercelOptions: { maxRetries: 0 },
    async stream() {
      requests++;
      if (requests !== 1) throw new Error("fixture provider unavailable");
      return (async function* () {
        yield { type: "tool-call" as const, id: "read-fixture", name: "Read", arguments: { path: "fixture.txt" } };
        yield { type: "finish" as const, reason: "tool-calls" as const,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 } };
      })();
    }
  };
  const createAgent = () => {
    const registry = new ToolRegistry();
    registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: workspace, ignore: [] }));
    return new AgentSession({ workspaceRoot: workspace, config, model, toolRegistry: registry,
      permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(workspace) });
  };
  let agent = createAgent();
  try {
    await writeFile(path.join(workspace, "fixture.txt"), "persisted tool evidence");
    await agent.initialize();
    const info = agent.getInfo();
    const outcome = await agent.runTask("Read fixture.txt and summarize it.", { emotionAnalysis: false });
    assert.equal(outcome.status, "failed");
    assert.equal(requests, 2);
    const checkUsage = (summary: ReturnType<AgentSession["usageSummary"]>) => {
      assert.equal(summary.inputTokens, 100);
      assert.equal(summary.outputTokens, 20);
      assert.equal(summary.totalTokens, 120);
      assert.equal(summary.cacheReadTokens, 80);
      assert.equal(summary.costUsd, 0.00016);
    };
    checkUsage(agent.usageSummary());
    await agent.close();
    const replay = await replaySession(info.sessionFile);
    assert.equal(replay.usage.filter(record => record.operation === "agent").length, 1);
    checkUsage(summarizeUsage(replay.usage));
    assert.ok(replay.events.some(event => event.type === "tool_result"), "the first step executed a real file tool");
    assert.ok(replay.events.some(event => event.type === "error" && event.relatedUsage?.[0]?.totalTokens === 120));
    await rm(info.sessionFile.replace(/\.jsonl$/u, ".snap.json"), { force: true });
    agent = createAgent();
    await agent.initialize();
    await agent.resume(info.sessionId);
    checkUsage(agent.usageSummary());
    assert.equal(requests, 2, "restoring usage must not replay model requests");
  } finally {
    await agent.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("successful steps retain one aggregate and later terminal failure does not settle twice", async () => {
  for (const mode of ["success", "terminal-failure"] as const) {
    const f = fixture();
    const records = [first(), second()];
    await f.state.settle(mode, records);
    assert.equal(f.restored().length, 1);
    assert.deepEqual(json(f.restored()), json([extracted.sumSessionUsage(records)]));
    assert.equal(extracted.summarizeUsage(f.restored()).totalTokens, 350);
  }
});

test("a later provider failure preserves already completed step counts and historical cost", async () => {
  for (const records of [[first()], [first(), second()]]) {
    const f = fixture();
    await f.state.settle("provider-failure", records);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0]?.type, "error");
    assert.deepEqual(json(f.restored()), json([extracted.sumSessionUsage(records)]));
    assert.equal(extracted.summarizeUsage(f.restored()).costUsd, extracted.summarizeUsage(records).costUsd);
    assert.deepEqual(json(records), json(records.length === 1 ? [first()] : [first(), second()]), "settlement does not mutate live records");
  }
});

test("no completed step creates no agent usage; explicit zero remains a reported zero", async () => {
  const empty = fixture();
  await empty.state.settle("provider-failure", []);
  assert.equal(empty.restored().length, 0);
  assert.equal(empty.events[0]?.relatedUsage, undefined);
  const zero = fixture();
  await zero.state.settle("provider-failure", [usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 })]);
  assert.equal(zero.restored().length, 1);
  assert.equal(zero.restored()[0]?.totalTokens, 0);
  assert.equal(zero.restored()[0]?.pricingKnown, true);
  assert.equal(zero.restored()[0]?.costUsd, 0);
});

test("unknown measurements and prices preserve the existing aggregate contract", async () => {
  for (const records of [[usage({})], [first(), usage({})], [first(), usage({ outputTokens: 3 }, "agent", false)]]) {
    const f = fixture();
    await f.state.settle("provider-failure", records);
    assert.deepEqual(json(f.restored()), json([extracted.sumSessionUsage(records)]));
    assert.equal(f.restored()[0]?.pricingKnown, false);
    assert.equal(f.restored()[0]?.costUsd, undefined);
    assert.equal(f.restored()[0]?.reportedCacheUsage?.inputTokensComplete, false);
    assert.equal(f.restored()[0]?.reportedCacheUsage?.latestRequestInputTokens, undefined);
  }
});

test("agent then related ordering matches normal replay and related usage drains once", async () => {
  const related = [usage({ inputTokens: 40, outputTokens: 2, totalTokens: 42, cacheReadTokens: 10 }, "memory"),
    usage({ inputTokens: 10, outputTokens: 1, totalTokens: 11, cacheReadTokens: 0 }, "subagent")];
  const failed = fixture(related);
  const success = fixture(related);
  await failed.state.settle("provider-failure", [first(), second()]);
  await success.state.settle("success", [first(), second()]);
  assert.deepEqual(json(failed.restored()), json(success.restored()));
  assert.deepEqual(json(failed.restored().map(record => record.operation)), ["agent", "memory", "subagent"]);
  assert.equal(extracted.summarizeUsage(failed.restored()).latestCacheHitRate, 0);
  assert.equal(extracted.summarizeUsage(failed.restored()).reportedCacheUsage?.latestCacheHitRate, 0);
  await failed.state.settle("provider-failure", []);
  assert.equal(failed.restored().length, 3);
});

test("an attempted audit or owned retry commit never gets a second catch settlement", async () => {
  for (const boundary of ["before-append", "after-append"] as const) {
    const f = fixture([], boundary);
    await f.state.settle("terminal-failure", [first()]);
    assert.equal(f.restored().length, boundary === "after-append" ? 1 : 0,
      "uncertain persistence is not repaired by another write");
    assert.ok(f.events.filter(event => event.type === "error").every(event => event.relatedUsage === undefined));
  }
  const retry = fixture();
  await assert.rejects(retry.state.settle("provider-failure", [first()], true), /inert later failure/u);
  assert.equal(retry.events.length, 0, "existing retry commit recovery remains the sole owner");
});

test("canonical/request evidence is not counted twice and active branch filtering stays unchanged", async () => {
  const f = fixture();
  await f.state.settle("provider-failure", [first()]);
  const rootEvent: Event = { type: "user_message", messageId: "root", content: "request", runtime: { runId: "run-a", eventId: "root-event", eventSeq: 1 } };
  const step: Event = { type: "agent_message", messageId: "step", parentMessageId: "root", runtime: { runId: "run-a", eventId: "step-event", eventSeq: 2 },
    message: { role: "assistant", content: [], usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } };
  const request: Event = { type: "model_request", runtime: { runId: "run-a", eventId: "request-event", eventSeq: 3 }, metrics: { usage: step.message!.usage! } };
  const error: Event = { ...f.events[0]!, runtime: { runId: "run-a", eventId: "error-event", eventSeq: 4 } };
  const original = [rootEvent, step, request, error];
  assert.equal(extracted.summarizeUsage(extracted.sessionUsage(original)).totalTokens, 120);
  const replacement: Event = { type: "agent_message", messageId: "replacement", parentMessageId: "root", slotId: "step",
    runtime: { runId: "run-b", eventId: "replacement-event", eventSeq: 5 }, message: { role: "assistant", content: [] } };
  // The old run still owns the active root, so its error remains under current rules.
  const selected = [...original, replacement, { type: "message_version_selected", messageId: "replacement", slotId: "step" }];
  assert.equal(extracted.sessionUsage(selected).length, 1);
  const alternateRoot: Event = { type: "user_message", messageId: "other-root", content: "other", runtime: { runId: "run-c", eventId: "alternate-event", eventSeq: 5 } };
  assert.equal(extracted.sessionUsage([...original, alternateRoot]).length, 0,
    "this change does not create an all-physical-branches billing ledger");
});
