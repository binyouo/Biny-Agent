import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, realpath, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, AgentUsage, ModelStreamEvent } from "../src/agent/core/types.js";
import { estimateContextBreakdown, estimateMessageTokens } from "../src/agent/context/tokenUsage.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { summarizeUsage } from "../src/observability/usage.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

// Real session/storage integration, with only the external model replaced.
// Kept separate from the source-only accounting fixture.
test("automatic compaction repair usage survives disk replay and cold reopen", { timeout: 20_000 }, async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-active-compaction-usage-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  let agent: AgentSession | undefined;
  try {
    process.env.BINY_AGENT_DIR = path.join(workspace, "global");
    const config = structuredClone(defaultConfig);
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    config.context.identity.enabled = false;
    config.context.maxInputTokens = 32_768;
    config.context.compaction.enabled = true;
    config.context.compaction.reserveTokens = 16_384;
    config.context.compaction.keepRecentTokens = 256;
    config.context.compaction.maxSummaryTokens = 1_024;
    config.heartbeat.enabled = false;
    config.crystal.passiveEnabled = false;
    configSchema.parse(config);
    const threshold = config.context.maxInputTokens - config.context.compaction.reserveTokens;
    let summaries = 0;
    let answers = 0;
    const attempts: AgentUsage[] = [
      { inputTokens: 11, outputTokens: 3, totalTokens: 14, cacheReadTokens: 2 },
      { inputTokens: 23, outputTokens: 7, totalTokens: 30, cacheReadTokens: 5 }
    ];
    const model: AgentModel = testModel({
      provider: "fixture", modelId: "active-compaction-usage", supportsTools: false, vercelOptions: { maxRetries: 0 },
      async stream(context) {
        const summary = context.systemPrompt?.includes("durable context checkpoint") === true;
        const attempt = summary ? ++summaries : ++answers;
        if (summary) assert.ok(attempt <= 2, "one bounded repair, no repeated compaction");
        if (!summary && attempt === 2) {
          assert.equal(context.tools.length, 0, "the text-only fixture must not add a Code Mode tool schema");
          const tokens = Object.values(estimateContextBreakdown({ ...context, toolSources: new Map() })).reduce((total, value) => total + value, 0);
          assert.ok(tokens < threshold, `the compacted final request must fit below the threshold: ${tokens} < ${threshold}`);
        }
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: summary ? checkpointText() : "Seed answer." };
          yield { type: "finish", reason: summary && attempt === 1 ? "length" : "stop",
            // No fabricated seed anchor: the next preparation must use its estimated size.
            usage: summary ? attempts[attempt - 1] : attempt === 1 ? undefined : { inputTokens: 4, outputTokens: 1, totalTokens: 5, cacheReadTokens: 0 } };
        })();
      }
    });
    const createAgent = () => new AgentSession({ workspaceRoot: workspace, config, model,
      toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(workspace) });
    await ensureAgentDirs(workspace);
    agent = createAgent();
    await agent.initialize();
    const info = agent.getInfo();
    assert.equal((await agent.runTask("Preserve the original request. ".repeat(2_000), { emotionAnalysis: false })).status, "completed");
    assert.equal(summaries, 0, "the seed has no older history to compact");
    // Cold restore reads the complete canonical user, not the seed request's
    // 35%-budget truncation. The large removable user, not the new task or the
    // retained final assistant, supplies the compaction pressure.
    await agent.close();
    agent = undefined;
    await rm(info.sessionFile.replace(/\.jsonl$/u, ".snap.json"), { force: true });
    agent = createAgent();
    await agent.initialize();
    const seed = await agent.resume(info.sessionId);
    assert.ok(estimateMessageTokens(seed.messages) > threshold, "canonical seed history alone exceeds the threshold");
    assert.equal(summaries, 0, "seed restore must not issue a summary");
    assert.equal(answers, 1, "seed restore must not issue another answer");
    assert.equal((await agent.runTask("Continue preserving the request.", { emotionAnalysis: false })).status, "completed");
    assert.equal(summaries, 2, "automatic preparation really issued an initial summary and repair");
    const live = agent.usageSummary();
    assert.equal(live.totalTokens, 49);
    await agent.close();
    agent = undefined;
    const replay = await replaySession(info.sessionFile);
    assert.ok(replay.events.some(event => event.type === "context_checkpoint" && event.reason === "threshold"));
    const compacted = replay.usage.filter(record => record.operation === "compaction");
    assert.equal(compacted.length, 2);
    assert.equal(summarizeUsage(compacted).totalTokens, 44);
    assert.deepEqual(counts(summarizeUsage(replay.usage)), counts(live));
    assert.ok(replay.events.every(event => event.type !== "user_message" || !event.preparationUsage?.some(record => record.operation === "compaction")), "preparation is not counted a second time on the already-recorded user message");
    await rm(info.sessionFile.replace(/\.jsonl$/u, ".snap.json"), { force: true });
    agent = createAgent();
    await agent.initialize();
    await agent.resume(info.sessionId);
    assert.deepEqual(counts(agent.usageSummary()), counts(live));
    assert.equal(summaries, 2, "reopen must not issue another summary");
    assert.equal(answers, 2);
  } finally {
    try { await agent?.close(); }
    finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

function counts(usage: AgentUsage): AgentUsage {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
    cacheMissTokens: usage.cacheMissTokens, reasoningTokens: usage.reasoningTokens };
}
function checkpointText(): string {
  return [
    "## Goal", "- Preserve the original request. <!-- evidence:m0 -->",
    "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
    "## All User Messages", "- Preserve the original request. <!-- evidence:m0 -->",
    "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
  ].join("\n");
}
