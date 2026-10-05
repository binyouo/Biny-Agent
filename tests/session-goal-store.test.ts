import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { agentDir } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-goal-store-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
try {
  // Given a new authority, When it migrates, Then session goals have their own durable domain.
  assert.ok(authority.databaseHandle().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_goals'").get(), "authority must migrate the session goal table");
  const sourcePlan = authority.databaseHandle().prepare("EXPLAIN QUERY PLAN SELECT run_id FROM agent_runs WHERE workspace_id = ? AND session_id = ? AND continuation_source = ? ORDER BY rowid DESC LIMIT 1")
    .all(authority.workspaceId, "session", "goal:identity:1") as Array<{ detail: string }>;
  assert.ok(sourcePlan.some(row => row.detail.includes("continuation_source=?")), "long-running goals must find their continuation source without scanning all workspace runs");
  const { SessionGoalStore } = await import("../src/runtime/SessionGoalStore.js");
  let store = await SessionGoalStore.open(root, authority);
  const evidence = { summary: "All requested results checked", requirements: [{ requirement: "expected output", evidence: "run:test-output exited 0" }] };
  let changes = 0;
  const unsubscribe = store.subscribe(() => { changes += 1; });

  assert.throws(() => store.set("session-a", "  "), /objective/u);
  assert.throws(() => store.set("", "deliver"), /session/u);
  assert.throws(() => store.set("session-a", "deliver", { tokenBudget: 0 }), /budget/u);
  assert.throws(() => store.set("too-long", "x".repeat(20_001)), /20.?000|length|long/u);
  const maximum = store.set("maximum-length", "x".repeat(20_000));
  assert.equal(maximum.objective.length, 20_000, "the complete allowed objective must be retained without truncation");
  store.clear("maximum-length", maximum);
  const initial = store.set("session-a", "  Deliver all requested artifacts  ");
  assert.equal(initial.objective, "Deliver all requested artifacts");
  assert.equal(initial.status, "active");
  assert.equal(initial.tokenBudget, undefined);
  assert.equal(initial.tokensUsed, 0);
  assert.equal(initial.usageKnown, true);
  assert.equal(initial.generation, 1);
  assert.equal(store.get("session-b"), undefined);
  assert.deepEqual(store.list({ status: "active" }).map((goal) => goal.sessionId), ["session-a"]);
  assert.equal(store.set("session-a", initial.objective).revision, initial.revision, "the same objective must be idempotent");

  const paused = store.pause("session-a", initial);
  assert.equal(paused.status, "paused");
  assert.equal(paused.generation, initial.generation);
  assert.throws(() => store.complete("session-a", initial, evidence), /revision|changed/u);
  assert.throws(() => store.complete("session-b", initial, evidence), /goal|session/u);
  assert.throws(() => store.complete("session-a", paused, evidence), /active/u);
  const resumed = store.resume("session-a", paused);
  assert.equal(resumed.generation, initial.generation + 1);
  const edited = store.set("session-a", "Deliver artifacts and pass the full required checks", { expected: resumed });
  assert.equal(edited.goalId, initial.goalId);
  assert.equal(edited.generation, resumed.generation + 1);
  assert.throws(() => store.complete("session-a", resumed, evidence), /revision|changed/u);
  assert.throws(() => store.complete("session-a", edited, { summary: "done", requirements: [] }), /evidence|requirement/u);
  const blocked = store.block("session-a", edited, { summary: "Required input unavailable", requirements: [{ requirement: "required input", evidence: "input file is absent" }] });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.generation, edited.generation);
  assert.equal(store.resume("session-a", blocked).status, "active", "a session goal block is explicitly recoverable");
  const completed = store.complete("session-a", store.get("session-a")!, evidence);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.evidence, evidence);
  assert.throws(() => store.resume("session-a", completed), /completed/u);
  const replacement = store.set("session-a", "A new explicit objective");
  assert.notEqual(replacement.goalId, initial.goalId);
  assert.throws(() => store.clear("session-a", completed), /goal|changed/u);
  store.clear("session-a", replacement);
  assert.equal(store.get("session-a"), undefined);
  const afterClear = store.set("session-a", "Continue with the latest objective");
  assert.throws(() => store.block("session-a", replacement, evidence), /goal|changed/u);
  assert.equal(store.get("session-a")!.goalId, afterClear.goalId);

  const stopped = store.set("no-progress", "Produce a verified artifact");
  const stopEvidence = { summary: "自动续跑仅产生文字，已暂停以避免空转。", requirements: [{ requirement: "工作工具活动", evidence: "run:no-work has no work tool call." }] };
  const automaticPause = store.pause("no-progress", stopped, stopEvidence);
  assert.deepEqual(automaticPause.evidence, stopEvidence, "Automatic pause must persist a user-visible reason.");
  assert.equal(automaticPause.generation, stopped.generation);
  const pauseEvent = authority.readEvents({ sessionId: "no-progress" }).events.at(-1)!;
  assert.equal(pauseEvent.eventType, "session_goal.paused");
  assert.deepEqual((pauseEvent.payload as { goal: { evidence: unknown } }).goal.evidence, stopEvidence,
    "The pause reason must be part of the authoritative state event.");
  assert.throws(() => store.pause("no-progress", stopped, stopEvidence), /revision|changed/u);
  assert.equal(store.resume("no-progress", automaticPause).evidence, undefined, "Explicit resume clears the previous stop reason.");

  // Given a budgeted goal, When provider usage arrives twice, Then charged usage is counted once.
  const budgeted = store.set("session-budget", "Finish within the explicit token budget", { tokenBudget: 100 });
  const usage = { goalId: budgeted.goalId, usageId: "request-one", inputTokens: 50, cachedInputTokens: 20, outputTokens: 30, timeUsedMs: 1250 };
  const counted = store.recordUsage("session-budget", usage)!;
  assert.equal(counted.tokensUsed, 60);
  assert.equal(counted.timeUsedMs, 1250);
  assert.equal(counted.usageKnown, true);
  assert.equal(counted.generation, budgeted.generation, "usage must not authorize another generation");
  assert.equal(store.recordUsage("session-budget", usage)!.tokensUsed, 60);
  assert.throws(() => store.recordUsage("session-budget", { ...usage, outputTokens: 31 }), /usage|fact/u);
  assert.throws(() => store.recordUsage("session-budget", { ...usage, usageId: "invalid-cache", cachedInputTokens: 51 }), /cached/u);
  assert.equal(store.recordUsage("session-a", usage), undefined, "usage cannot be attributed across sessions");
  const exhausted = store.recordUsage("session-budget", { ...usage, usageId: "request-two", inputTokens: 30, cachedInputTokens: 0, outputTokens: 10, timeUsedMs: 100 })!;
  assert.equal(exhausted.tokensUsed, 100);
  assert.equal(exhausted.status, "budget_limited");
  assert.throws(() => store.resume("session-budget", exhausted), /budget/u);
  const raised = store.set("session-budget", exhausted.objective, { tokenBudget: 150, expected: exhausted });
  assert.equal(store.resume("session-budget", raised).status, "active");

  const unknown = store.set("session-unknown", "A bounded objective", { tokenBudget: 100 });
  const uncertain = store.recordUsage("session-unknown", { goalId: unknown.goalId, usageId: "missing-usage", inputTokens: 10 })!;
  assert.equal(uncertain.usageKnown, false);
  assert.equal(uncertain.status, "blocked", "unknown usage cannot silently consume an explicit budget");
  assert.match(uncertain.evidence!.summary, /usage/u);
  assert.throws(() => store.resume("session-unknown", uncertain), /usage/u);
  const unlimited = store.set("session-unlimited", "An unbudgeted objective");
  assert.equal(store.recordUsage("session-unlimited", { goalId: unlimited.goalId, usageId: "unknown" })!.status, "active");
  assert.equal(store.get("session-unlimited")!.usageKnown, false);

  await Promise.resolve();
  assert.ok(changes > 0, "durable changes notify the owning store subscribers");
  unsubscribe();
  const expectedUsage = store.get("session-budget")!;
  const expectedPause = store.pause("no-progress", store.get("no-progress")!, stopEvidence);
  store.close();
  authority.close();
  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  store = await SessionGoalStore.open(root, authority);
  assert.deepEqual(store.get("session-budget"), expectedUsage);
  assert.deepEqual(store.get("no-progress"), expectedPause, "The stop reason must survive reopening the database.");
  assert.equal(store.recordUsage("session-budget", usage)!.tokensUsed, 100, "usage deduplication survives reopen");
  assert.ok(authority.readEvents({ sessionId: "session-budget" }).events.some((event) => event.eventType === "session_goal.usage"));

  const otherWorkspace = await RuntimeEventAuthority.open(root, { workspaceId: "other-workspace", backfillLegacySessions: false });
  const otherStore = await SessionGoalStore.open(root, otherWorkspace);
  assert.equal(otherStore.get("session-budget"), undefined);
  const isolated = otherStore.set("session-budget", "An isolated workspace objective");
  assert.equal(isolated.workspaceId, "other-workspace");
  assert.equal(store.get("session-budget")!.goalId, expectedUsage.goalId);
  otherStore.close(); otherWorkspace.close();

  // Given schema 11 data, When the authority upgrades, Then session objectives are created only explicitly.
  const graphs = await GoalGraphStore.open(root, authority);
  graphs.close(); store.close(); authority.close();
  const database = new DatabaseSync(path.join(agentDir(root), "runtime.sqlite"));
  database.exec("DROP TABLE session_goal_usage; DROP TABLE session_goals; DROP INDEX agent_runs_continuation_source_idx; PRAGMA user_version = 11;");
  database.close();
  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  store = await SessionGoalStore.open(root, authority);
  const migratedGraphs = await GoalGraphStore.open(root, authority);
  assert.deepEqual(store.list(), [], "schema migration must not create automatically runnable session goals");
  const upgradedPlan = authority.databaseHandle().prepare("EXPLAIN QUERY PLAN SELECT run_id FROM agent_runs WHERE workspace_id = ? AND session_id = ? AND continuation_source = ? ORDER BY rowid DESC LIMIT 1")
    .all(authority.workspaceId, "session", "goal:identity:1") as Array<{ detail: string }>;
  assert.ok(upgradedPlan.some(row => row.detail.includes("continuation_source=?")), "schema 11 upgrades must install the continuation source index");
  store.set("migrated-session", "A new explicit session objective");
  migratedGraphs.close(); store.close();
  console.log("session goal store tests passed");
} finally {
  authority.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
