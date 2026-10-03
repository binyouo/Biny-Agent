import assert from "node:assert/strict";
import type { AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { ContextStatus } from "../src/agent/context/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { createInitialTuiState, tuiReducer } from "../src/tui/reducer.js";

function fixture(compact: (hint?: string, signal?: AbortSignal) => Promise<string>, contextStatus?: () => Promise<ContextStatus>) {
  const context: ContextStatus = {
    loadedInstructions: [], instructionBytes: 0, instructionCapBytes: 1_000,
    snapshotRefreshedAt: undefined, snapshotDirty: false,
    repoMapRefreshedAt: undefined, repoMapDirty: false, repoMapEntries: 0,
    activePaths: [], recentActivity: { paths: [], summaries: [] },
    compaction: { summaryPresent: false, compactedMessages: 0, lastCompactedAt: undefined },
    budget: { maxTokens: 4_000, usedTokens: 10, omitted: [], autoCompacted: false, source: "estimated", measuredAt: undefined },
    memoryEnabled: false, memoryInjectedSummaries: []
  };
  const info: AgentSessionInfo = {
    workspaceRoot: "/tmp/compact-runtime", sessionId: "compact-session",
    sessionFile: "/tmp/compact-runtime/session.jsonl", provider: "test",
    modelLabel: "test/model", reasoningLabel: "Off", modelAlias: "test", thinking: "off"
  };
  const services = {
    agent: {
      getInfo: () => info,
      getPermissionMode: () => "ask",
      contextStatus: contextStatus ?? (async () => context),
      compactConversation: compact
    },
    close: async () => undefined
  } as unknown as CommandRuntime;
  const runtime = new InteractiveAgentRuntime(services);
  const events: AgentHostEvent[] = [];
  runtime.subscribe((update) => { if (update.event) events.push(update.event); });
  return { runtime, services, events, context };
}

async function successfulLifecycle(): Promise<void> {
  const f = fixture(async () => "Authorization: Bearer compact-success-secret");
  try {
    const result = await f.runtime.compactConversation("Authorization: Bearer compact-hint-secret");
    assert.match(result, /\[redacted\]/u);
    assert.deepEqual(f.events.map((event) => event.type), ["compact.started", "compact.completed"]);
    assert.equal(f.events[0]?.runId, f.events[1]?.runId);
    assert.equal(f.events[0]?.sessionId, "compact-session");
    assert.doesNotMatch(JSON.stringify(f.events), /compact-(?:success|hint)-secret/u);
    assert.deepEqual(f.runtime.getSnapshot().state, { kind: "idle" });
  } finally { await f.runtime.close(); }
}

async function failedLifecycle(): Promise<void> {
  const failure = new Error("summary rejected; Authorization: Bearer compact-failure-secret");
  const f = fixture(async () => { throw failure; });
  try {
    await assert.rejects(f.runtime.compactConversation(), (error) => error === failure);
    assert.deepEqual(f.events.map((event) => event.type), ["compact.started", "compact.failed"]);
    const terminal = f.events.at(-1);
    assert.equal(terminal?.runId, f.events[0]?.runId);
    assert.equal(terminal?.type === "compact.failed" && terminal.cancelled, false);
    assert.match(terminal?.type === "compact.failed" ? terminal.error : "", /\[redacted\]/u);
    assert.doesNotMatch(JSON.stringify(f.events), /compact-failure-secret/u);
    assert.deepEqual(f.runtime.getSnapshot().state, { kind: "idle" });
  } finally { await f.runtime.close(); }
}

async function statusFailureTerminates(): Promise<void> {
  const f = fixture(async () => "done", async () => { throw new Error("status unavailable"); });
  try {
    await assert.rejects(f.runtime.compactConversation(), /status unavailable/u);
    assert.deepEqual(f.events.map((event) => event.type), ["compact.started", "compact.failed"]);
    assert.deepEqual(f.runtime.getSnapshot().state, { kind: "idle" });
  } finally { await f.runtime.close(); }
}

async function cancellationTerminates(): Promise<void> {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = fixture(async (_hint, signal) => {
    entered();
    return await new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("controlled cancellation")), { once: true });
    });
  });
  const pending = f.runtime.compactConversation();
  const rejected = assert.rejects(pending, /controlled cancellation/u);
  try {
    await started;
    assert.deepEqual(f.runtime.getSnapshot().state, { kind: "maintenance", operation: "compact" });
    f.runtime.cancelCurrentRun("cancelled");
    await rejected;
    assert.deepEqual(f.events.map((event) => event.type), ["compact.started", "compact.failed"]);
    const terminal = f.events.at(-1);
    assert.equal(terminal?.type === "compact.failed" && terminal.cancelled, true);
    assert.deepEqual(f.runtime.getSnapshot().state, { kind: "idle" });
  } finally { await f.runtime.close(); }
}

async function commandReportsStateChange(): Promise<void> {
  for (const change of ["none", "count", "timestamp"] as const) {
    const f = fixture(async (hint) => {
      assert.equal(hint, "keep unfinished work");
      if (change === "count") f.context.compaction.compactedMessages += 2;
      if (change === "timestamp") f.context.compaction.lastCompactedAt = "2026-10-02T00:00:00.000Z";
      return "相同的返回文案";
    });
    try {
      const result = await executeRuntimeCommand(f.runtime, f.services, "/compact keep unfinished work", "desktop");
      assert.equal(result?.content, "相同的返回文案");
      assert.deepEqual(result?.compaction, { outcome: change === "none" ? "unchanged" : "compacted" });
      assert.deepEqual(f.runtime.getSnapshot().state, { kind: "idle" });
    } finally { await f.runtime.close(); }
  }
}

function tuiKeepsCommandErrorAsTheSingleDisplay(): void {
  const state = createInitialTuiState("/tmp/compact-runtime");
  assert.equal(tuiReducer(state, {
    type: "compact.failed", sessionId: "compact-session", runId: "compact-run",
    timestamp: "2026-10-02T00:00:00.000Z", error: "summary rejected", cancelled: false
  }), state);
}

tuiKeepsCommandErrorAsTheSingleDisplay();
const results = await Promise.allSettled([
  successfulLifecycle(), failedLifecycle(), statusFailureTerminates(), cancellationTerminates(), commandReportsStateChange()
]);
const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as Error] : []);
if (failures.length) throw new AggregateError(failures, "Compact runtime regression failures");
console.log("compact runtime tests passed");
