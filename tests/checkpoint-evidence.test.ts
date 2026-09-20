/** 用真实本地日志验证长会话证据分页；耗时仅报告，不以机器速度作为测试门槛。 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { checkpointClaims } from "../src/session/checkpointClaims.js";
import { sessionContextCheckpointFields, type SessionContextCheckpointState, type SessionContextCheckpoint } from "../src/session/metadata.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-evidence-pages-"));
const previous = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
let agent: AgentSession | undefined;
try {
  await ensureAgentDirs(root);
  const state = Object.fromEntries(sessionContextCheckpointFields.map((field) => [field, []])) as unknown as SessionContextCheckpointState;
  state.goal = ["Read the original evidence"];
  const checkpoint: SessionContextCheckpoint = {
    summary: "## Goal\n- Read the original evidence", state,
    evidence: [{ field: "goal", itemIndex: 0, references: [{ kind: "message", role: "user", messageIndex: 0 }] }],
    firstKeptMessageIndex: 2_000, compactedMessages: 2_000, tokensBefore: 600_000, createdAt: new Date().toISOString()
  };
  const events = Array.from({ length: 2_000 }, (_, index) => ({ type: "user_message", content: index === 0 ? "original-evidence ".repeat(4_000) : `message ${index} ${"x".repeat(1_000)}` }));
  const file = sessionFilePath(root, "large-evidence");
  const log = [...events, { type: "context_checkpoint", reason: "manual", ...checkpoint }].map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(file, log);
  const config = structuredClone(defaultConfig);
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  agent = new AgentSession({ workspaceRoot: root, config,
    model: { provider: "fixture", modelId: "fixture", stream: async () => { throw new Error("No model request expected"); } },
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }), toolRegistry: new ToolRegistry(), recorder: new SessionRecorder(root) });
  await agent.initialize();
  await agent.resume("large-evidence");
  const claimId = checkpointClaims(state, checkpoint.evidence)[0]!.id;
  const timings: number[] = [];
  for (let page = 0; page < 4; page++) {
    const start = performance.now();
    const result = await agent.readCheckpointEvidence({ claimId, offset: page * 512, length: 512 }) as { content: string; hasMore: boolean };
    timings.push(Math.round(performance.now() - start));
    assert.equal(result.content.length, 512);
    assert.equal(result.hasMore, true);
  }
  console.log(JSON.stringify({ evidenceMessages: events.length, logBytes: Buffer.byteLength(log), pageMs: timings }));
} finally {
  await agent?.close();
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
  await rm(root, { recursive: true, force: true });
}
