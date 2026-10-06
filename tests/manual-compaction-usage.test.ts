import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, AgentStopReason, AgentUsage, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { summarizeUsage } from "../src/observability/usage.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { sessionFileFingerprint } from "../src/session/parseCache.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { writeSessionSnapshot } from "../src/session/sessionSnapshot.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

interface Attempt { usage?: AgentUsage; reason?: AgentStopReason; text?: string; error?: Error }
const first: AgentUsage = { inputTokens: 11, outputTokens: 3, totalTokens: 14, cacheReadTokens: 2, cacheWriteTokens: 1, cacheMissTokens: 9, reasoningTokens: 1 };
const second: AgentUsage = { inputTokens: 23, outputTokens: 7, totalTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 2, cacheMissTokens: 18, reasoningTokens: 2 };

for (const ending of ["repaired", "rejected"] as const) {
  test(`manual compaction retains both measured attempts when ${ending}, through replay and reopen`, async () => {
    const f = await fixture([{ usage: first, reason: "length" }, { usage: second, reason: ending === "repaired" ? "stop" : "length" }]);
    try {
      await f.seed();
      const before = f.agent.usageSummary();
      if (ending === "repaired") await f.agent.compactConversation();
      else await assert.rejects(f.agent.compactConversation(), /output_truncated/u);
      assert.equal(f.attempts, 2);
      const live = f.agent.usageSummary();
      assert.equal(live.inputTokens - before.inputTokens, 34);
      const replay = await replaySession(f.file);
      const compacted = replay.usage.filter(record => record.operation === "compaction");
      assert.equal(compacted.length, 1, "manual compaction keeps one persisted aggregate");
      assert.deepEqual(tokenCounts(compacted[0]!), { inputTokens: 34, outputTokens: 10, totalTokens: 44, cacheReadTokens: 7, cacheWriteTokens: 3, cacheMissTokens: 27, reasoningTokens: 3 });
      assert.equal(compacted[0]?.latestRequestInputTokens, 23);
      assert.equal(compacted[0]?.reportedCacheUsage?.latestRequestCacheReadTokens, 5);
      assert.equal(replay.modelRequests.filter(request => request.requestContext?.operation === "compaction").length, 2, "metrics are not a second usage ledger");
      assert.deepEqual(tokenCounts(summarizeUsage(replay.usage)), tokenCounts(live));
      for (const snapshot of [false, true]) {
        await f.reopen(snapshot);
        assert.deepEqual(tokenCounts(f.agent.usageSummary()), tokenCounts(live), "cold and snapshot reopen count each attempt exactly once");
      }
    } finally { await f.close(); }
  });
}

test("a repair request that fails before usage retains the first completed measurement", async () => {
  const f = await fixture([{ usage: first, reason: "length" }, { error: new Error("synthetic repair failure") }]);
  try {
    await f.seed();
    await assert.rejects(f.agent.compactConversation(), /synthetic repair failure/u);
    const replay = await replaySession(f.file);
    assert.equal(f.attempts, 2);
    assert.deepEqual(tokenCounts(replay.usage.find(record => record.operation === "compaction")!), tokenCounts(first));
    assert.deepEqual(tokenCounts(summarizeUsage(replay.usage)), tokenCounts(f.agent.usageSummary()));
  } finally { await f.close(); }
});

test("unknown counts stay incomplete when a measured-zero repair follows", async () => {
  const f = await fixture([{ usage: {}, reason: "length" }, { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }, reason: "stop" }]);
  try {
    await f.seed();
    await f.agent.compactConversation();
    const replay = await replaySession(f.file);
    const usage = replay.usage.find(record => record.operation === "compaction")!;
    assert.equal(usage.inputTokens, 0, "retain the actual reported zero");
    assert.equal(usage.cacheReadTokens, undefined, "retain the legacy aggregate eligibility rule");
    assert.equal(usage.reportedCacheUsage?.inputTokens, 0);
    assert.equal(usage.reportedCacheUsage?.cacheReadTokens, 0);
    assert.equal(usage.reportedCacheUsage?.inputTokensComplete, false);
    assert.equal(usage.reportedCacheUsage?.cacheReadTokensComplete, false);
    assert.equal(usage.reportedCacheUsage?.latestRequestInputTokens, 0);
    assert.equal(summarizeUsage([usage]).reportedCacheUsage?.sessionCacheHitRate, undefined);
  } finally { await f.close(); }
});

test("single measured-zero compaction and no-request compaction keep their existing shapes", async () => {
  const f = await fixture([{ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 } }]);
  try {
    await f.agent.compactConversation();
    assert.equal(f.attempts, 0);
    assert.equal((await replaySession(f.file)).usage.length, 0);
    await f.seed();
    await f.agent.compactConversation();
    const usage = (await replaySession(f.file)).usage.find(record => record.operation === "compaction")!;
    assert.equal(f.attempts, 1);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.cacheReadTokens, 0);
    assert.equal(usage.reportedCacheUsage?.inputTokensComplete, true);
    assert.equal(usage.reportedCacheUsage?.cacheReadTokensComplete, true);
  } finally { await f.close(); }
});

test("manual compaction excludes concurrent related usage, whether already persisted or still pending", async () => {
  const f = await fixture([{ usage: first, reason: "length" }, { usage: second }]);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.seed();
    f.beforeAttempt = async attempt => { if (attempt === 2) { entered(); await gate; } };
    const compacting = f.agent.compactConversation();
    await started;
    await assert.rejects(f.agent.compactConversation(), /conversation compaction.*running/u);
    f.agent.observeModelUsage({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }, "memory");
    const sequence = f.agent.recordHostedToolCall("fixture", {}, "unrelated");
    f.agent.recordHostedToolResult("fixture", "done", "unrelated", sequence);
    f.agent.observeModelUsage({ inputTokens: 200, outputTokens: 20, totalTokens: 220 }, "subagent");
    release();
    await compacting;
    const live = f.agent.usageSummary();
    await f.agent.close();
    const replay = await replaySession(f.file);
    assert.equal(replay.usage.filter(record => record.operation === "compaction").length, 1);
    assert.equal(replay.usage.find(record => record.operation === "compaction")?.inputTokens, 34);
    assert.equal(replay.usage.filter(record => record.operation === "memory").length, 1);
    assert.equal(replay.usage.filter(record => record.operation === "subagent").length, 1);
    assert.deepEqual(tokenCounts(summarizeUsage(replay.usage)), tokenCounts(live));
  } finally { release(); await f.close(); }
});

test("real SDK compatible-provider streams retain final usage from both manual summary requests", async () => {
  const f = await fixture([]);
  let calls = 0;
  try {
    await f.seed();
    const before = f.agent.usageSummary();
    f.model.vercelModel = createVercelLanguageModel({
      providerAlias: "usage-fixture", providerType: "deepseek", authMode: "api-key", api: "chat_completions",
      modelId: "fixture", supportsReasoning: true, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {},
      fetcher: async () => {
        const usage = [first, second][calls++];
        assert.ok(usage, "exactly one bounded repair is allowed");
        const wire = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
          prompt_tokens_details: { cached_tokens: usage.cacheReadTokens }, prompt_cache_hit_tokens: usage.cacheReadTokens,
          prompt_cache_miss_tokens: usage.cacheMissTokens };
        const chunks = [
          { choices: [{ index: 0, delta: { content: checkpointText() }, finish_reason: null }] },
          { choices: [], usage: { ...wire, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          { choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "length" : "stop" }], usage: wire }
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" }
        });
      }
    });
    await f.agent.compactConversation();
    assert.equal(calls, 2);
    const live = f.agent.usageSummary();
    assert.equal(live.totalTokens - before.totalTokens, 44, "intermediate cumulative snapshots must not be added");
    const replay = await replaySession(f.file);
    assert.equal(replay.usage.find(record => record.operation === "compaction")?.totalTokens, 44);
    assert.equal(replay.usage.find(record => record.operation === "compaction")?.cacheMissTokens, 27);
    assert.deepEqual(tokenCounts(summarizeUsage(replay.usage)), tokenCounts(live));
  } finally { await f.close(); }
});

function tokenCounts(usage: AgentUsage): AgentUsage {
  return Object.fromEntries(["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "cacheMissTokens", "reasoningTokens"]
    .map(key => [key, usage[key as keyof AgentUsage]]));
}

async function fixture(responses: Attempt[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-manual-usage-"));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.compaction.enabled = false;
  config.context.compaction.keepRecentMessages = 2;
  config.context.compaction.keepRecentTokens = 2_000;
  config.heartbeat.enabled = false;
  config.crystal.passiveEnabled = false;
  const model: AgentModel = {
    provider: "fixture", modelId: "manual-usage",
    async stream(context) {
      const summary = context.systemPrompt?.includes("durable context checkpoint") === true;
      const response = summary ? responses[f.attempts++] : { text: "Seed answer.", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      assert.ok(response, "no unexpected model request");
      if (summary) await f.beforeAttempt?.(f.attempts);
      if (response.error) throw response.error;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: response.text ?? checkpointText() };
        yield { type: "finish", reason: response.reason ?? "stop", usage: response.usage };
      })();
    }
  };
  const createAgent = () => new AgentSession({ workspaceRoot: root, config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(root) });
  const initial = createAgent();
  const info = initial.getInfo();
  const f = {
    agent: initial, model, file: info.sessionFile, attempts: 0,
    beforeAttempt: undefined as ((attempt: number) => Promise<void>) | undefined,
    async seed() { assert.equal((await f.agent.runTask("Preserve the request.", { emotionAnalysis: false })).status, "completed"); },
    async reopen(snapshot: boolean) {
      await f.agent.close();
      if (snapshot) await writeSessionSnapshot(f.file, sessionFileFingerprint(await stat(f.file)), await replaySession(f.file));
      else await rm(f.file.replace(/\.jsonl$/u, ".snap.json"), { force: true });
      f.agent = createAgent();
      await f.agent.initialize();
      const replay = await f.agent.resume(info.sessionId);
      assert.equal(replay.events.length === 0, snapshot, "exercise the intended restore route");
    },
    async close() { await f.agent.close(); await rm(root, { recursive: true, force: true }); }
  };
  await initial.initialize();
  return f;
}

function checkpointText(): string {
  return [
    "## Goal", "- Preserve the request. <!-- evidence:m0 -->",
    "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
    "## All User Messages", "- Preserve the request. <!-- evidence:m0 -->",
    "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
  ].join("\n");
}
