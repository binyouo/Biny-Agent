/** 真实预算丢弃历史后，重试仍须把当前用户与其持久消息身份绑定。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const targetRole of ["user", "assistant"] as const) {
  test(`${targetRole}-target retry with no retained history preserves current-user checkpoint evidence instead of omitted references`, { timeout: 20_000 }, async (t) => {
    const currentInput = targetRole === "assistant" ? "CURRENT_USER_MARKER ".repeat(5_000) : "CURRENT_USER_MARKER";
    const f = await fixture(t);
    await drain(f.agent.prompt("OLDER_USER_MARKER", { emotionAnalysis: false }));
    await drain(f.agent.prompt(currentInput, { emotionAnalysis: false }));
    const before = await f.events();
    const source = before.find(event => event.type === "user_message" && event.content === currentInput);
    assert.ok(source?.type === "user_message" && source.messageId);
    const target = targetRole === "assistant"
      ? before.filter(event => event.type === "agent_message" && event.message.role === "assistant").at(-1)
      : source;
    assert.ok(target && "messageId" in target && target.messageId);
    await drain(f.agent.retry(target.messageId, { emotionAnalysis: false }));
    assert.equal(f.requests.length, 3);
    const actual = f.requests.at(-1)!;
    assert.equal(actual.length, 1, "the real budget selects zero earlier messages, including the oversized assistant retry source");
    assert.equal(actual[0]?.role, "user");
    assert.match(JSON.stringify(actual), /CURRENT_USER_MARKER/u);
    assert.doesNotMatch(JSON.stringify(actual), /OLDER_USER_MARKER|HUGE_PRIOR_ANSWER/u);
    assert.deepEqual((await f.events()).filter(event => event.type === "user_message").map(event => event.content), ["OLDER_USER_MARKER", currentInput], "retry must not duplicate or rewrite canonical user input");

    await f.agent.compactConversation();
    const checkpoint = (await f.events()).filter(event => event.type === "context_checkpoint").at(-1);
    assert.ok(checkpoint?.type === "context_checkpoint", "public compaction must persist its grounded evidence");
    assert.ok(checkpoint.evidence?.length);
    for (const claim of checkpoint.evidence) {
      assert.ok(claim.references.length);
      assert.deepEqual(claim.references.map(reference => ({ role: reference.role, id: reference.messageId, index: reference.messageIndex })),
        [{ role: "user", id: source.messageId, index: 2 }], "current input must never inherit the omitted older user's reference");
    }
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-history-reference-"));
  const previousRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  let agent: AgentSession | undefined = undefined;
  t.after(async () => {
    try { await agent?.close(); }
    finally {
      if (previousRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  const config = structuredClone(defaultConfig);
  config.context.maxInputTokens = 12_000;
  config.context.compaction.enabled = false;
  config.context.compaction.reserveTokens = 256;
  config.context.compaction.keepRecentMessages = 1;
  config.context.compaction.keepRecentTokens = 256;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  const requests: AgentMessage[][] = [];
  const model: AgentModel = {
    provider: "fixture", modelId: "retry-history-reference", runtime: "builtin-llama.cpp", dataResidency: "local",
    async stream(context, options) {
      let text: string;
      if (options?.requestContext?.operation === "compaction") {
        assert.match(JSON.stringify(context.messages), /CURRENT_USER_MARKER/u);
        assert.doesNotMatch(JSON.stringify(context.messages), /OLDER_USER_MARKER|HUGE_PRIOR_ANSWER/u);
        text = [
          "## Goal", "- CURRENT_USER_MARKER. <!-- evidence:m0 -->",
          "## Constraints & Preferences", "- (none recorded)",
          "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
          "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
          "## All User Messages", "- CURRENT_USER_MARKER. <!-- evidence:m0 -->",
          "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
        ].join("\n");
      } else {
        assert.equal(options?.requestContext?.operation, "agent");
        requests.push(structuredClone(context.messages));
        text = requests.length === 1 ? "HUGE_PRIOR_ANSWER ".repeat(10_000) : "answer";
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const recorder = new SessionRecorder(workspace);
  agent = new AgentSession({ workspaceRoot: workspace, config, model, recorder,
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission) });
  await agent.initialize();
  return { agent, requests, async events() { await recorder.flush(); return await readSessionEvents(recorder.filePath); } };
}

async function drain(stream: AsyncIterable<AgentSessionEvent>): Promise<void> {
  let completed = false;
  for await (const event of stream) {
    if (event.type === "error") assert.fail(event.message);
    if (event.type === "done") completed = event.outcome.status === "completed";
  }
  assert.equal(completed, true);
}
