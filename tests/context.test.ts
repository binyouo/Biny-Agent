import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import { estimateMessageTokens } from "../src/agent/context/tokenUsage.js";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { LocalMemory, redactSecrets } from "../src/agent/context/LocalMemory.js";
import { sessionMessageMetadata } from "../src/session/messageTree.js";
import { sessionEventsToTranscript } from "../src/tui/sessionTranscript.js";
import type { HybridMemoryRetriever } from "../src/agent/context/HybridMemoryRetriever.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { memoryDatabaseFileName } from "../src/agent/context/memoryStorage.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { cloneAgentMessages, messageReasoning, messageText } from "../src/agent/modelMessages.js";
import { buildSystemPrompt, refreshRuntimeSystemPrompt, stableSystemPromptForCache, stripTransientTurnContext } from "../src/agent/prompts.js";
import { BINY_AGENT_DIR_ENV, globalAgentDir, legacyProjectStateDirName, projectSessionsDir, projectStateDirName } from "../src/config/paths.js";
import type { AgentConfig } from "../src/config/schema.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { recordNativeTelemetry } from "../src/observability/telemetry.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { maxSessionEventLineBytes, maxSessionEvents, maxSessionFileBytes } from "../src/session/limits.js";
import { replaySession, sessionEventsToConversation } from "../src/session/replay.js";
import {
  deleteSessionFile,
  duplicateSessionFile,
  agentDir,
  ensureAgentDirs,
  listSessionFiles,
  readSessionSnapshot,
  resolveSessionFile,
  sessionFilePath
} from "../src/session/store.js";
import { listSessionSummaries, parseSessionEvents, readSessionEvents, readStoredSessionEvents, repairSessionTailForAppend } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createCheckpointEvidenceTool } from "../src/extensions/checkpointEvidence.js";
import { checkpointClaims } from "../src/session/checkpointClaims.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { appendInputHistory, loadInputHistory } from "../src/tui/inputHistory.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";

function citeCheckpoint(summary: string, source = "m0"): string {
  return summary.split("\n").map((line) => {
    const item = line.replace(/^(?:[-*]|\d+\.)\s+/u, "").replace(/^\[[ xX]\]\s*/u, "").trim();
    if (!/^(?:[-*]|\d+\.)\s+/u.test(line) || /^\((?:none|not recorded|none verified|unknown)\b/iu.test(item)) return line;
    return `${line} <!-- evidence:${source} -->`;
  }).join("\n");
}

class ContextTestModel {
  evidenceClaimId?: string;
  failCompaction = false;
  reportUsage = true;
  summarySource = "m0";
  readonly requests: AgentMessage[][] = [];
  readonly systemPrompts: Array<string | undefined> = [];
  memoryExtractionCalls = 0;
  readonly model: AgentModel = createContextTestModel(this);

  respond(messages: AgentMessage[], systemPrompt?: string): string {
    this.requests.push(cloneAgentMessages(messages));
    this.systemPrompts.push(systemPrompt);
    const prompt = messageText(messages.at(-1) ?? { role: "user", content: "" });
    if (prompt.includes("Extract memories from this conversation:")) {
      this.memoryExtractionCalls += 1;
      return JSON.stringify([{ operation: "add",
          content: "Refresh the workspace snapshot and RepoMap after a successful workspace write before the next turn.",
          durability: "permanent"
         }]);
    }
    if (systemPrompt?.includes("durable context checkpoint")) {
      return citeCheckpoint([
        "## Goal",
        "- Keep context bounded.",
        "",
        "## Constraints & Preferences",
        "- Preserve grounded session facts.",
        "",
        "## Progress",
        "### Done",
        "- [x] Created a structured handoff.",
        "### In Progress",
        "- [ ] Continue the requested change.",
        "### Blocked",
        "- (none)",
        "",
        "## Key Decisions",
        "- **Checkpoint**: Keep a stable compaction boundary.",
        "",
        "## Errors & Fixes",
        "- (none recorded)",
        "",
        "## All User Messages",
        "- Keep context bounded.",
        "",
        "## Next Steps",
        "1. Continue from retained history.",
        "",
        "## Critical Context",
        "- Tests passed."
      ].join("\n"), this.summarySource);
    }
    return "ok";
  }
}

function createContextTestModel(provider: ContextTestModel): AgentModel {
  return {
    provider: "context-test",
    modelId: "context-test",
    async stream(context: ModelStreamContext, options): Promise<AsyncIterable<ModelStreamEvent>> {
      if (provider.failCompaction && context.systemPrompt?.includes("durable context checkpoint")) throw new Error("summary provider unavailable");
      if (provider.evidenceClaimId) {
        const claimId = provider.evidenceClaimId;
        const toolEnabled = context.tools.some((tool) => tool.name === "read_checkpoint_evidence");
        const result = context.messages.at(-1);
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          if (!toolEnabled) {
            yield { type: "text-delta", text: "Evidence tool disabled" };
            yield { type: "finish", reason: "stop" };
          } else if (result?.role === "toolResult") {
            yield { type: "text-delta", text: messageText(result) };
            yield { type: "finish", reason: "stop" };
          } else {
            yield { type: "tool-call", id: `lookup-${claimId}`, name: "read_checkpoint_evidence", arguments: { claimId } };
            yield { type: "finish", reason: "tool-calls" };
          }
        })();
      }
      const text = provider.respond(context.messages, context.systemPrompt);
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "start" as const };
        if (text) yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const, usage: provider.reportUsage ? { inputTokens: 0, outputTokens: 1, totalTokens: 1 } : undefined };
      })();
    }
  };
}

async function main(): Promise<void> {
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-global-"));
  const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = globalRoot;
  try {
    testConversationBoundaryPrompt();
    await testPromptEpochAndCanonicalPrefix();
    await testInstructionHierarchyAndCap();
    await testInstructionLoadingUsesExplicitPaths();
    await testRepoMapExactCandidate();
    await testAutomaticContextRejectsExternalSymlinks();
    await testAutomaticContextSkipsUnreadableOptionalFiles();
    await testAutomaticContextSupportsSymlinkedWorkspaceRoot();
    await testBudgetAndCompaction();
    await testRecallCountsBeforeBudget();
    await testMidTurnToolResultPruning();
    await testActiveRunCompactionPreservesToolBatches();
    await testIncrementalSplitTurnCompaction();
    await testContextPreparationAbortStopsAutoCompaction();
    await testRestoreWithoutPersistedBudgetUsesHistoryEstimate();
    await testSessionReplayAndAgentResume();
    await testCrystalHistoricalMaterial();
    await testCrystalThreadBackfill();
    await testCrystalSemanticDotProduct();
    await testCrystalDormancyWithoutNewAnchors();
    await testCrystalFailedAndCancelledTurns();
    await testCheckpointIsResumeTruthSource();
    await testCheckpointPersistenceFailureStopsSession();
    await testLegacyAgentStateIsIgnored();
    await testFlatSessionMigration();
    await testSessionPathBoundaries();
    await testGlobalSessionsStayProjectScoped();
    await testSessionSummariesSortByUpdatedAt();
    await testSessionReadLimits();
    await testDeleteSessionReplacementRace();
    await testFailedCurrentSessionResumeKeepsRecorderUsable();
    await testTruncatedSessionTailAndDanglingToolRecovery();
    await testTurnStatusPersistence();
    await testMessageMetadataPersistence();
    await testSessionAndToolDisplayRedaction();
    await testMemoryExactDurableContentAndWriter();
    await testMemoryLifecycleAndUsagePersistence();
    await testMemoryMetadataDetailsFromCompletedExtraction();
    await testAutomaticMemoryRecallRequiresEmbedding();
    await testMemoryStorageBoundaries();
    await testMemoryEntryManagementAndCjkSearch();
    await testCredentialAndSymlinkBoundaries();
    await testToolWriteMarksSnapshotAndRepoMapDirty();
  } finally {
    if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
    await rm(globalRoot, { recursive: true, force: true });
  }
}

function testConversationBoundaryPrompt(): void {
  const prompt = buildSystemPrompt({ cwd: "/workspace" });
  assert.match(prompt, /You are Biny\./u);
  assert.doesNotMatch(prompt, /Biny is not human|不代表 Biny 是人类/u);
  assert.match(prompt, /Keep simple answers simple; do not add headings or lists to simple answers/u);
  assert.match(prompt, /simple greeting or casual exchange/u);
  assert.match(prompt, /casual chat gets a short direct reply and no workspace work/u);
  assert.match(prompt, /Available tools:\n\(none\)/u);
  assert.match(prompt, /only the latest user message as the active task/u);
  assert.match(prompt, /smallest sequence that reaches the outcome/u);
  assert.match(prompt, /never narrate retries, tool choices, or intermediate failures/u);
  assert.match(prompt, /reach for it, don't guess/u);
  assert.match(prompt, /recall_memory/u);
  assert.match(prompt, /text-only promise is not action/u);
  assert.match(prompt, /Current working directory: \/workspace/u);
  const parentPrompt = buildSystemPrompt({
    cwd: "/workspace",
    parentThreadPrompt: "PARENT THREAD — source session\nParent first request: inspect the release flow"
  });
  assert.match(parentPrompt, /PARENT THREAD — source session/u);
  assert.match(parentPrompt, /inspect the release flow/u);
  assert.doesNotMatch(prompt, /Search the public web/u);
  const webTool = {
    name: "WebSearch",
    promptSnippet: "Search the public web",
    promptGuidelines: ["Use WebSearch for current public information"]
  };
  assert.match(buildSystemPrompt({ cwd: "/workspace", tools: [webTool] }), /Use WebSearch for current public information/u);
  const zvecTool = {
    name: "mcp_zvec_grep_zvec_grep_search",
    promptSnippet: "Search indexed workspace content by meaning",
    promptGuidelines: ["Use zvec_grep_search for semantic workspace discovery"]
  };
  const zvecPrompt = buildSystemPrompt({ cwd: "/workspace", tools: [zvecTool] });
  assert.match(zvecPrompt, /Search indexed workspace content by meaning/u);
  assert.match(zvecPrompt, /Use zvec_grep_search for semantic workspace discovery/u);
  assert.doesNotMatch(
    buildSystemPrompt({ cwd: "/workspace", tools: [{ name: "custom_tool" }] }),
    /- custom_tool:/u
  );
  const refreshed = refreshRuntimeSystemPrompt(buildSystemPrompt({
    cwd: "/workspace",
    extensionPrompt: "static capability",
    tools: [webTool]
  }), [{
    name: "Bash",
    promptSnippet: "Run a finite command",
    promptGuidelines: ["Use Bash only for finite commands"]
  }]);
  assert.match(refreshed, /static capability/u);
  assert.match(refreshed, /Use Bash/u);
}

async function testPromptEpochAndCanonicalPrefix(): Promise<void> {
  const toolA = { name: "alpha", description: "Alpha", parameters: { type: "object" as const }, execute: async () => ({ content: [] }) };
  const toolB = { name: "beta", description: "Beta", parameters: { type: "object" as const }, execute: async () => ({ content: [] }) };
  const first = buildSystemPrompt({ cwd: "/workspace", extensionPrompt: "project-a", tools: [toolB, toolA] });
  const second = buildSystemPrompt({ cwd: "/workspace", extensionPrompt: "project-b", tools: [toolA, toolB] });
  assert.notEqual(stableSystemPromptForCache(first), stableSystemPromptForCache(second));

  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const memory = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      4_000,
      32 * 1024,
      undefined,
      undefined,
      { keepRecentTokens: 50, maxSummaryTokens: 512 }
    );
    memory.recordToolSchema([toolA]);
    const initialEpoch = memory.getPromptEpoch();
    memory.recordToolSchema([toolB]);
    assert.equal(memory.getPromptEpoch(), initialEpoch + 1);
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(700) },
      { role: "assistant", content: [{ type: "text", text: "old response ".repeat(700) }] },
      { role: "user", content: "recent request" }
    ]);
    const beforeCompaction = memory.getPromptEpoch();
    assert.equal((await memory.compact()).compacted, true);
    assert.equal(memory.getPromptEpoch(), beforeCompaction + 1);
    const state = memory.snapshot();
    const restored = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      4_000,
      32 * 1024
    );
    restored.restore(memory.getHistory(), state);
    assert.equal(restored.getPromptEpoch(), memory.getPromptEpoch());
    assert.equal(restored.snapshot().promptEpochReason, "compaction");
  });
}

async function testInstructionHierarchyAndCap(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "AGENTS.md"), "ignored by override\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "AGENTS.override.md"), "nested override rule\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    await workspace.initialize();
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);

    workspace.observeToolResult("Read", { path: "src/example.ts" }, { path: "src/example.ts", content: "export {};" });
    await workspace.prepareTurn("explain the file");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/AGENTS.override.md"]);
    const memory = new ContextMemory(() => new ContextTestModel().model, workspace, undefined, 8_000, 32 * 1024);
    const prepared = await memory.prepareTurn("explain the file", "base prompt");
    assert.match(prepared.systemPrompt ?? "", /<project_context>/u);
    assert.match(prepared.systemPrompt ?? "", /<project_instructions path="AGENTS\.md">\nroot rule/u);
    assert.match(prepared.systemPrompt ?? "", /<project_instructions path="src\/AGENTS\.override\.md">\nnested override rule/u);

    const capped = new WorkspaceContext(workspaceRoot, [], 10);
    await capped.initialize();
    assert.equal(capped.status().instructionBytes <= 10, true);
  });
}

async function testInstructionLoadingUsesExplicitPaths(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src", "feature"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "AGENTS.md"), "feature rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "entry.ts"), "export const entry = true;\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    await workspace.prepareTurn("inspect src/feature/entry.ts");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/feature/AGENTS.md"]);

    workspace.observeToolResult("Read", { path: "src/feature/entry.ts" }, { path: "src/feature/entry.ts", content: "export const entry = true;" });
    await workspace.prepareTurn("explain the file");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/feature/AGENTS.md"]);
  });
}

async function testRepoMapExactCandidate(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "import { createWorker } from './worker.js';\nexport function startAgent() { return createWorker(); }\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "worker.ts"), "export class Worker {}\nexport function createWorker() { return new Worker(); }\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "tests", "worker.test.ts"), "export function testWorker() {}\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [".biny"], 32 * 1024);
    const turn = await workspace.prepareTurn("startAgent");
    assert.equal(turn.repoMapCandidates[0]?.path, "src/index.ts");
    assert.equal(turn.repoMapCandidates[0]?.symbols.includes("startAgent"), true);
    assert.equal("content" in (turn.repoMapCandidates[0] ?? {}), false);
  });
}

async function testAutomaticContextRejectsExternalSymlinks(): Promise<void> {
  if (process.platform === "win32") return;
  await withTempWorkspace(async (workspaceRoot) => {
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-external-"));
    try {
      await fs.mkdir(path.join(externalRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "EXTERNAL_INSTRUCTION_SECRET\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "entry.ts"), "export const ExternalRepoMapSecret = true;\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "README.md"), "EXTERNAL_README_SECRET\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "package.json"), JSON.stringify({ name: "external-package-secret" }), "utf8");
      await fs.writeFile(path.join(externalRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { externalSecret: true } }), "utf8");
      await fs.writeFile(path.join(externalRoot, "pnpm-lock.yaml"), "external-lock-secret\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "src", "leak.ts"), "export const ExternalSrcTreeSecret = true;\n", "utf8");

      await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "safe workspace rule\n", "utf8");
      await fs.symlink(externalRoot, path.join(workspaceRoot, "linked"), "dir");
      await fs.symlink(path.join(externalRoot, "src"), path.join(workspaceRoot, "src"), "dir");
      for (const fileName of ["README.md", "package.json", "tsconfig.json", "pnpm-lock.yaml"]) {
        await fs.symlink(path.join(externalRoot, fileName), path.join(workspaceRoot, fileName), "file");
      }

      const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
      const turn = await workspace.prepareTurn("inspect linked/entry.ts ExternalRepoMapSecret");
      assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);
      assert.equal(turn.instructions.some((instruction) => instruction.content.includes("EXTERNAL_INSTRUCTION_SECRET")), false);
      assert.equal(turn.repoMapCandidates.some((entry) => entry.symbols.includes("ExternalRepoMapSecret")), false);
      assert.equal(turn.snapshot.context.packageManager, "unknown");
      assert.equal(turn.snapshot.context.packageJson, undefined);
      assert.equal(turn.snapshot.context.tsconfig, undefined);
      assert.equal(turn.snapshot.context.readme, undefined);
      assert.deepEqual(turn.snapshot.context.srcTree, []);
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
}

async function testAutomaticContextSkipsUnreadableOptionalFiles(): Promise<void> {
  if (process.platform === "win32") return;
  await withTempWorkspace(async (workspaceRoot) => {
    const readmePath = path.join(workspaceRoot, "README.md");
    const instructionsPath = path.join(workspaceRoot, "AGENTS.md");
    await fs.writeFile(readmePath, "optional readme\n", "utf8");
    await fs.writeFile(instructionsPath, "optional instructions\n", "utf8");
    await fs.chmod(readmePath, 0);
    await fs.chmod(instructionsPath, 0);
    try {
      const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
      const turn = await workspace.prepareTurn("hi");
      assert.equal(turn.snapshot.context.readme, undefined);
      assert.deepEqual(turn.instructions, []);
    } finally {
      await fs.chmod(readmePath, 0o644);
      await fs.chmod(instructionsPath, 0o644);
    }
  });
}

async function testAutomaticContextSupportsSymlinkedWorkspaceRoot(): Promise<void> {
  if (process.platform === "win32") return;
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "alias root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "alias root readme\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "alias-root" }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const AliasRootSymbol = true;\n", "utf8");
    const aliasRoot = path.join(workspaceRoot, "workspace-link");
    await fs.symlink(workspaceRoot, aliasRoot, "dir");

    const workspace = new WorkspaceContext(aliasRoot, [], 32 * 1024);
    const turn = await workspace.prepareTurn("find AliasRootSymbol in src/index.ts");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);
    assert.equal(turn.instructions[0]?.content, "alias root rule\n");
    assert.equal(turn.snapshot.context.packageJson?.name, "alias-root");
    assert.equal(turn.snapshot.context.tsconfig?.compilerOptions.strict, true);
    assert.equal(turn.snapshot.context.readme, "alias root readme\n");
    assert.equal(turn.snapshot.context.srcTree.includes("[f] src/index.ts"), true);
    assert.equal(turn.repoMapCandidates.some((entry) => entry.symbols.includes("AliasRootSymbol")), true);
  });
}

/**
 * 回合内剪枝：只把较早的 tool result 正文换成占位符，消息条数、角色和 toolCallId 都不动，
 * tool-call / tool-result 的配对不能被破坏。
 */
async function testMidTurnToolResultPruning(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memory = new ContextMemory(() => provider.model, workspace, undefined, 200, 32 * 1024);

    const messages: AgentMessage[] = [{ role: "user", content: "inspect the repo" }];
    const archivedPath = `.biny/tool-results/tool-result-${"a".repeat(64)}.json`;
    for (let index = 0; index < 5; index += 1) {
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${String(index)}`, name: "Read", arguments: { path: `f${String(index)}.ts` } }]
      });
      messages.push({
        role: "toolResult",
        toolCallId: `call-${String(index)}`,
        toolName: "Read",
        content: [{
          type: "text",
          text: index === 0
            ? JSON.stringify({ archived: true, archivePath: archivedPath, preview: "body ".repeat(200) })
            : "body ".repeat(200)
        }]
      });
    }

    const before = estimateMessageTokens(messages);
    const pruned = memory.pruneToolResultsForStep(messages);
    assert.equal(pruned.length, messages.length, "pruning must not drop messages");
    assert.equal(estimateMessageTokens(pruned) < before, true, "pruning must shrink the estimate");

    // 每个 tool-call 仍然有配对的 tool-result，且 toolCallId 一一对应。
    const callIds = pruned.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
      : []);
    const resultIds = pruned.flatMap((message) => message.role === "toolResult"
      ? [message.toolCallId]
      : []);
    assert.deepEqual(callIds, resultIds);

    // 最近的工具结果保持原样：模型当下要用的就是它们。
    const lastResult = pruned.at(-1);
    assert.equal(lastResult?.role, "toolResult");
    assert.equal(String(toolResultValue(lastResult)).startsWith("body "), true);
    // 最早的已被换成可重新读取的归档引用，普通旧结果则保留一个小预览。
    assert.equal(/compacted for this model step/.test(String(toolResultValue(pruned[2]))), true);
    assert.equal(String(toolResultValue(pruned[2])).includes(archivedPath), true);
    assert.equal(/Preview: body/.test(String(toolResultValue(pruned[4]))), true);

    // 预算充裕时不动任何东西，且剪枝是幂等的。
    const roomy = new ContextMemory(() => provider.model, workspace, undefined, 1_000_000, 32 * 1024);
    assert.equal(roomy.pruneToolResultsForStep(messages), messages);
    assert.equal(estimateMessageTokens(memory.pruneToolResultsForStep(pruned)), estimateMessageTokens(pruned));
  });
}

async function testActiveRunCompactionPreservesToolBatches(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memory = new ContextMemory(() => provider.model, workspace, undefined, 4_000, 32 * 1024);
    const messages: AgentMessage[] = [
      { role: "user", content: `old request ${"detail ".repeat(1_600)}` },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "old-call", name: "Read", arguments: { path: "old.ts" } }]
      },
      {
        role: "toolResult",
        toolCallId: "old-call",
        toolName: "Read",
        content: [{ type: "text", text: "old result ".repeat(1_600) }]
      },
      { role: "user", content: "continue with the recent file" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "recent-call", name: "Read", arguments: { path: "recent.ts" } }]
      },
      {
        role: "toolResult",
        toolCallId: "recent-call",
        toolName: "Read",
        content: [{ type: "text", text: "recent result" }]
      }
    ];

    const compacted = await memory.compactRunContext(messages);
    assert.ok(compacted);
    assert.equal(compacted.compactedMessageCount > 0, true);
    assert.equal(compacted.messages.some((message) => message.role === "toolResult" && message.toolCallId === "recent-call"), true);
    const retainedCallIds = compacted.messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
      : []);
    const retainedResultIds = compacted.messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []);
    assert.deepEqual(retainedCallIds, retainedResultIds);
  });
}

async function testIncrementalSplitTurnCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const memory = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      4_000,
      32 * 1024,
      undefined,
      undefined,
      { keepRecentTokens: 50, maxSummaryTokens: 512 }
    );
    const initialHistory: AgentMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      initialHistory.push(
        { role: "user", content: `initial request ${String(index)} ${"detail ".repeat(700)}` },
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: `initial-call-${String(index)}`,
            name: "Read",
            arguments: { path: `src/read-${String(index)}.ts`, detail: "detail ".repeat(700) }
          }]
        },
        {
          role: "toolResult",
          toolCallId: `initial-call-${String(index)}`,
          toolName: "Read",
          content: [{ type: "text", text: `initial result ${String(index)} ${"detail ".repeat(700)}` }]
        }
      );
    }
    memory.replaceHistory(initialHistory);
    assert.equal((await memory.compact()).compacted, true);
    const initialSummaryRequest = provider.requests.at(-1) ?? [];
    const initialStatus = await memory.status();
    assert.equal(
      estimateMessageTokens(initialSummaryRequest) <= initialStatus.budget.maxTokens - (initialStatus.budget.reserveTokens ?? 0),
      true,
      "the compaction request must fit its own input budget"
    );

    const split = await memory.compactRunContext([
      { role: "user", content: "preserve the beginning of this long active turn in the checkpoint" },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "split-call",
          name: "Read",
          arguments: { path: "src/large.ts", detail: "large argument ".repeat(120) }
        }]
      },
      {
        role: "toolResult",
        toolCallId: "split-call",
        toolName: "Read",
        content: [{ type: "text", text: "recent result" }]
      }
    ]);
    assert.ok(split);
    assert.equal(split.compactedMessageCount, 1, "long turns may split only at a safe assistant boundary");
    assert.deepEqual(split.messages.map((message) => message.role), ["assistant", "toolResult"]);
    assert.match(split.summary, /src\/read-0\.ts/u, "incremental summaries must retain the cumulative file list");
    const updatePrompt = messageText(provider.requests.at(-1)?.at(-1) ?? { role: "user", content: "" });
    assert.match(updatePrompt, /<previous-summary>/u);
    assert.match(provider.systemPrompts.at(-1) ?? "", /ends inside a long user turn/u);
  });
}

function toolResultValue(message: AgentMessage | undefined): unknown {
  if (!message || message.role !== "toolResult") return undefined;
  return message.content.find((entry) => entry.type === "text")?.text;
}

async function testRecallCountsBeforeBudget(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const previousRoot = process.env[BINY_AGENT_DIR_ENV];
    process.env[BINY_AGENT_DIR_ENV] = path.join(workspaceRoot, "agent-data");
    const local = new LocalMemory(workspaceRoot, () => new ContextTestModel().model);
    try {
      const written = await local.writeEntry({
        content: "Release verification requires a complete test run. ".repeat(30)
      });
      assert.ok(written.entry);
      const result = await local.search("Release verification", [], { limit: 1 });
      let calls = 0;
      const retriever = {
        retrieve: async () => result,
        recordRecallUsage: async (ids: string[]) => {
          calls += 1;
          await local.recordRecallUsage(ids);
        }
      } as unknown as HybridMemoryRetriever;
      const context = new ContextMemory(
        () => new ContextTestModel().model, new WorkspaceContext(workspaceRoot, [], 32 * 1024),
        local, 120, 32 * 1024, undefined, undefined, {}, undefined, undefined, retriever
      );
      await context.prepareTurn("current task ".repeat(20), "system rule ".repeat(30));
      assert.equal(calls, 1);
      assert.equal((await local.listMemoryEntries()).entries.find((entry) => entry.id === written.entry!.id)?.accessCount, 1);
      assert.notEqual((await context.status()).budget.components?.find((item) => item.id === "stable memory")?.disposition, "included");
      assert.equal((await context.status()).memoryInjectedCount, 0, "被预算排除的命中不能报成已注入");
      assert.deepEqual((await context.status()).memoryInjectedSummaries, [], "被预算排除的记忆不能暴露在界面摘要中");
      const roomy = new ContextMemory(
        () => new ContextTestModel().model, new WorkspaceContext(workspaceRoot, [], 32 * 1024),
        local, 100_000, 32 * 1024, undefined, undefined, {}, undefined, undefined, retriever
      );
      const progress = roomy.prepareTurnProgress("Release verification", "system");
      assert.deepEqual(await progress.next(), { value: "workspace", done: false });
      assert.deepEqual(await progress.next(), { value: "memory", done: false });
      assert.equal(calls, 1, "记忆检索开始前即发布进度，不等检索结束再补发");
      assert.equal((await progress.next()).done, true);
      assert.equal((await roomy.status()).memoryInjectedCount, 1);
      assert.deepEqual((await roomy.status()).memoryInjectedSummaries, result.matches.map((match) => match.excerpt));
      await roomy.prepareTurn("no memory", "system", undefined, [], false);
      assert.equal((await roomy.status()).memoryInjectedCount, 0);
      assert.deepEqual((await roomy.status()).memoryInjectedSummaries, []);
      await context.prepareTurn("no memory", "system", undefined, [], false);
      assert.equal(calls, 2);
    } finally {
      local.close();
      if (previousRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousRoot;
    }
  });
}

async function testBudgetAndCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memory = new ContextMemory(() => provider.model, workspace, undefined, 120, 32 * 1024, undefined, undefined, {
      // 主请求刻意设为极小窗口来验证裁剪；摘要使用独立、能容纳结构化提示词的容量。
      resolveSummaryBudget: () => ({ contextWindow: 8_000, contextWindowIsFallback: false, maxInputTokens: 7_000, maxOutputTokens: 1_000 })
    });
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(40) },
      { role: "assistant", content: [{ type: "text", text: "old response ".repeat(40) }] }
    ]);
    const { messages } = await memory.prepareTurn("current task ".repeat(20), "system rule ".repeat(30));
    assert.equal(estimateMessageTokens(messages) <= 120, true);
    assert.equal(messages.at(-1)?.role, "user");
    assert.equal(messages.at(-1)?.content.includes("current task"), true);
    const preparedStatus = await memory.status();
    assert.equal(
      preparedStatus.budget.usedTokens <= preparedStatus.budget.maxTokens - (preparedStatus.budget.reserveTokens ?? 0),
      true,
      "assembled prompt must leave the configured compaction reserve unused"
    );
    const componentIds = new Set(preparedStatus.budget.components?.map((component) => component.id));
    assert.equal(componentIds.has("task"), true);
    assert.equal(componentIds.has("history"), true);
    assert.equal(componentIds.has("system rules"), true);
    assert.equal(preparedStatus.budget.components?.every((component) => component.requestedTokens >= component.usedTokens), true);
    assert.equal(estimateMessageTokens([{ role: "assistant", content: [{ type: "reasoning", text: "reason ".repeat(20) }] }]) > 4, true);

    // 极小窗口只能验证裁剪，不能要求空摘要成功；压缩成功使用能容纳有效 claim 的窗口。
    const compacting = new ContextMemory(() => provider.model, workspace, undefined, 8_000, 32 * 1024);
    compacting.replaceHistory(Array.from({ length: 8 }, (_, index): AgentMessage => index % 2
      ? { role: "assistant", content: [{ type: "text", text: `message ${String(index)} ${"detail ".repeat(800)}` }] }
      : { role: "user", content: `message ${String(index)} ${"detail ".repeat(800)}` }));
    await compacting.prepareTurn("continue", "system");
    const compactedStatus = await compacting.status();
    assert.equal(compactedStatus.compaction.summaryPresent, true);
    assert.equal(compactedStatus.budget.autoCompacted, true);

    compacting.replaceHistory([{ role: "user", content: "manual compact request" }]);
    const manual = await compacting.compact("retain next steps");
    assert.equal(manual.compacted, true);
  });
}

async function testContextPreparationAbortStopsAutoCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const model: AgentModel = {
      provider: "context-test-abort",
      modelId: "context-test-abort",
      async stream(_context, options) {
        return (async function* () {
          started.resolve(undefined);
          await new Promise<void>((_resolve, reject) => {
            const stop = (): void => {
              aborted.resolve(undefined);
              reject(options?.signal?.reason ?? new Error("aborted"));
            };
            if (options?.signal?.aborted) stop();
            else options?.signal?.addEventListener("abort", stop, { once: true });
          });
          yield { type: "start" as const };
        })();
      }
    };
    const memory = new ContextMemory(
      () => model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      120,
      32 * 1024,
      undefined,
      undefined,
      { resolveSummaryBudget: () => ({ contextWindow: 8_000, contextWindowIsFallback: false, maxInputTokens: 7_000, maxOutputTokens: 1_000 }) }
    );
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(80) },
      { role: "assistant", content: [{ type: "text", text: "old response ".repeat(80) }] }
    ]);

    const controller = new AbortController();
    const pending = memory.prepareTurn("continue", "system", controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await aborted.promise;
    const status = await memory.status();
    assert.equal(status.compaction.summaryPresent, false);
    assert.equal(status.compaction.compactedMessages, 0);
  });
}

async function testRestoreWithoutPersistedBudgetUsesHistoryEstimate(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const fallbackBudget = () => ({
      contextWindow: 131_072,
      contextWindowIsFallback: true,
      maxInputTokens: 120,
      maxOutputTokens: undefined,
      modelAlias: "gateway-model"
    });
    const memory = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      120,
      32 * 1024,
      undefined,
      fallbackBudget
    );
    memory.restore([
      { role: "user", content: "historical request ".repeat(4) },
      { role: "assistant", content: [{ type: "text", text: "historical answer ".repeat(4) }] }
    ]);
    const status = await memory.status();
    assert.equal(status.budget.usedTokens > 0, true);
    assert.equal(status.budget.maxTokens, 120);
    assert.equal(status.budget.contextWindowIsFallback, true);
    assert.equal(memory.snapshot().budget.contextWindowIsFallback, true);
    memory.recordProviderUsage({ inputTokens: 119, outputTokens: 1, totalTokens: 120 });
    assert.equal((await memory.status()).budget.contextWindowIsFallback, true);
    memory.setCheckpoint({
      summary: "## Goal\n- Continue from a restored checkpoint.",
      firstKeptMessageIndex: 1,
      tokensBefore: 119,
      compactedMessages: 1,
      createdAt: "2026-08-02T00:00:00.000Z"
    });
    const checkpointed = await memory.status();
    assert.equal(checkpointed.budget.source, "estimated", "provider usage before a checkpoint is stale");
    assert.equal(checkpointed.budget.contextWindowIsFallback, true);

    const restored = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      120,
      32 * 1024,
      undefined,
      fallbackBudget
    );
    restored.restore(memory.getHistory(), memory.snapshot());
    assert.equal((await restored.status()).budget.contextWindowIsFallback, true);
  });
}

async function testSessionReplayAndAgentResume(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const events: SessionEvent[] = [
      {
        type: "user_message",
        content: "inspect src/index.ts",
        contextUsage: { maxTokens: 24_000, usedTokens: 1_234, omitted: [], autoCompacted: false }
      },
      {
        type: "tool_call",
        tool: "Read",
        args: { path: "src/index.ts" },
        toolCallId: "call-7",
        sequence: 7,
        assistantContent: "I will inspect the entry.",
        reasoningContent: "The entry file is the first target.",
        reasoningProviderOptions: { anthropic: { signature: "signed-entry-reasoning" } }
      },
      { type: "tool_result", tool: "Read", result: { path: "src/index.ts", content: "export {}" }, toolCallId: "call-7", sequence: 7 },
      {
        type: "tool_call",
        tool: "Read",
        args: { path: "src/worker.ts" },
        toolCallId: "call-8",
        sequence: 8,
        assistantContent: "I will inspect the worker.",
        reasoningContent: "The worker is the second target.",
        reasoningProviderOptions: { anthropic: { signature: "signed-worker-reasoning" } }
      },
      { type: "tool_result", tool: "Read", result: { path: "src/worker.ts", content: "export class Worker {}" }, toolCallId: "call-8", sequence: 8 },
      {
        type: "assistant_message",
        content: "The files define the entry and worker.",
        reasoningContent: "Both requested files were inspected.",
        reasoningProviderOptions: { anthropic: { signature: "signed-final-reasoning" } },
        usage: {
          operation: "agent",
          modelAlias: "deepseek-v4-flash",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          inputTokens: 1_234,
          outputTokens: 40,
          totalTokens: 1_274,
          pricingKnown: false
        },
        contextState: {
          summary: "Persisted handoff summary.",
          compactedMessages: 4,
          memoryTopics: ["context"],
          budget: { maxTokens: 24_000, usedTokens: 1_234, omitted: [], autoCompacted: false, source: "provider" }
        }
      }
    ];
    const filePath = sessionFilePath(workspaceRoot, "saved-session");
    await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const replay = await replaySession(filePath);
    assert.equal(replay.messages[1]?.role, "assistant");
    assert.equal(hasToolCall(replay.messages[1], "call-7"), true);
    assert.equal(messageReasoning(replay.messages[1]!), "The entry file is the first target.");
    assert.equal(hasToolResult(replay.messages[2], "call-7"), true);
    assert.equal(hasToolCall(replay.messages[3], "call-8"), true);
    assert.equal(messageReasoning(replay.messages[3]!), "The worker is the second target.");
    assert.equal(messageReasoning(replay.messages[5]!), "Both requested files were inspected.");
    assert.equal(sessionEventsToConversation(events).length, 6);
    assert.equal(replay.contextState?.summary, "Persisted handoff summary.");
    assert.equal(replay.usage[0]?.inputTokens, 1_234);

    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const provider = new ContextTestModel();
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await agent.initialize();
    assert.equal(agent.getInfo().modelLabel, "deepseek-v4-flash");
    assert.equal(agent.getInfo().reasoningLabel, "Off");
    const resumed = await agent.resume("saved-session");
    assert.equal(resumed.sessionId, "saved-session");
    assert.equal(agent.getInfo().sessionId, "saved-session");
    const restoredContext = await agent.contextStatus();
    assert.equal(restoredContext.activePaths.includes("src/index.ts"), true);
    assert.equal(restoredContext.budget.usedTokens, 1_234);
    assert.equal(restoredContext.compaction.summaryPresent, true);
    await agent.runTask("continue the review");
    assert.equal(provider.requests.at(-1)?.some((message) => hasToolCall(message, "call-7")), true);
    assert.equal(provider.requests.at(-1)?.some((message) => messageReasoning(message) === "The worker is the second target."), true);
    const pendingTurn = agent.runTask("review the next change");
    await assert.rejects(agent.compactConversation(), /while agent turn is running/);
    await pendingTurn;
    const savedBeforeSwitch = await fs.readFile(filePath, "utf8");
    const secondFile = sessionFilePath(workspaceRoot, "second-session");
    await fs.writeFile(secondFile, `${JSON.stringify({ type: "user_message", content: "second session" })}\n`, "utf8");
    await agent.resume("second-session");
    const eventsBeforeSwitch = parseSessionEvents(savedBeforeSwitch);
    const eventsAfterSwitch = parseSessionEvents(await fs.readFile(filePath, "utf8"));
    assert.deepEqual(eventsAfterSwitch.slice(0, eventsBeforeSwitch.length), eventsBeforeSwitch);
    assert.equal(
      eventsAfterSwitch.slice(eventsBeforeSwitch.length).every((event) => event.type === "turn_status"),
      true
    );
    await agent.close();
  });
}

async function testCheckpointIsResumeTruthSource(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const firstProvider = new ContextTestModel();
    // 显式证据回查不应在耗尽的输出预算里再次被归档，导致模型循环回查。
    config.context.maxTurnToolResultBytes = 1;
    const firstRecorder = new SessionRecorder(workspaceRoot, "checkpoint-resume");
    const firstAgent = new AgentSession({
      workspaceRoot,
      config,
      model: firstProvider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: firstRecorder
    });
    await firstAgent.initialize();
    await firstAgent.runTask("old checkpoint payload that must not be replayed verbatim");
    firstProvider.failCompaction = true;
    await assert.rejects(firstAgent.compactConversation(), /summary provider unavailable/u);
    const failedReplay = await replaySession(firstRecorder.filePath);
    assert.equal(failedReplay.contextState?.compactionFailure?.kind, "provider_error", "失败后必须先落盘冷却信息");
    assert.equal(failedReplay.messages.length, 2, "失败不能推进压缩边界");
    firstProvider.failCompaction = false;
    assert.match(await firstAgent.compactConversation(), /Compacted 2 messages/u);
    await firstAgent.close();

    const compactedReplay = await replaySession(firstRecorder.filePath);
    assert.equal(compactedReplay.messages.length, 0, "checkpoint boundary must exclude compacted messages on replay");
    assert.equal(compactedReplay.messageTree.length, 2, "compacted messages remain available for audit and branching");
    assert.equal(compactedReplay.contextCheckpoint?.firstKeptMessageIndex, 2);
    assert.match(compactedReplay.contextCheckpoint?.summary ?? "", /## Goal/u);
    assert.equal(compactedReplay.contextCheckpoint?.formatVersion, 1);
    assert.deepEqual(compactedReplay.contextCheckpoint?.state?.goal, ["Keep context bounded."]);
    const goalEvidence = compactedReplay.contextCheckpoint?.evidence?.find((claim) => claim.field === "goal" && claim.itemIndex === 0);
    assert.equal(goalEvidence?.references.every((item) => item.messageIndex !== undefined), true);

    const resumedProvider = new ContextTestModel();
    const registry = new ToolRegistry();
    const resumedAgent = new AgentSession({
      workspaceRoot,
      config,
      model: resumedProvider.model,
      toolRegistry: registry,
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await resumedAgent.initialize();
    const evidenceTool = createCheckpointEvidenceTool((args, signal) => resumedAgent.readCheckpointEvidence(args, signal));
    registry.registerBuiltinTool(evidenceTool);
    await resumedAgent.resume("checkpoint-resume");
    await resumedAgent.runTask("continue only from the durable checkpoint");
    const resumedMessages = resumedProvider.requests.at(-1) ?? [];
    const durableResumedMessages = stripTransientTurnContext(resumedMessages);
    assert.equal(
      durableResumedMessages.some((message) => messageText(message).includes("old checkpoint payload")),
      false,
      "resume must not reintroduce pre-checkpoint messages"
    );
    assert.doesNotMatch(resumedProvider.systemPrompts.at(-1) ?? "", /Conversation handoff summary/u);
    assert.match(
      messageText(resumedMessages[0] ?? { role: "user", content: "" }),
      /<context_checkpoint>[\s\S]*Keep context bounded/u
    );
    // Given 真正落盘并恢复的 checkpoint，When 模型回查，Then 原消息按稳定 ID 返回且工具事件完整。
    const claims = checkpointClaims(compactedReplay.contextCheckpoint!.state!, compactedReplay.contextCheckpoint!.evidence);
    const claim = claims.find((item) => item.field === "goal")!;
    assert.deepEqual(claim.sources, ["user_stated"]);
    assert.equal(claim.verification, "not_verified");
    assert.equal(evidenceTool.schema.safeParse({ claimId: claim.id, sessionId: "another-session" }).success, false);
    assert.equal(evidenceTool.schema.safeParse({ claimId: claim.id, path: "/outside/session.jsonl" }).success, false);
    assert.equal(evidenceTool.schema.safeParse({ claimId: claim.id, offset: -1 }).success, false);
    assert.equal(evidenceTool.schema.safeParse({ claimId: claim.id, length: 16_001 }).success, false);
    const mixedClaims = checkpointClaims(compactedReplay.contextCheckpoint!.state!, [{
      field: "goal", itemIndex: 0, references: [
        { kind: "tool_result", toolCallId: "failed-call" },
        { kind: "checkpoint", checkpointCreatedAt: "2026-09-21T00:00:00.000Z" }
      ]
    }]);
    assert.deepEqual(mixedClaims[0]!.sources, ["tool_result", "inherited"]);
    assert.equal(mixedClaims[0]!.verification, "not_verified", "工具结果和旧摘要不能自动变成事实认证");
    const page = await resumedAgent.readCheckpointEvidence({ claimId: claim.id, length: 10 }) as { content: string; hasMore: boolean };
    assert.equal(page.content.length, 10);
    assert.equal(page.hasMore, true);
    await assert.rejects(resumedAgent.readCheckpointEvidence({ claimId: "0".repeat(64) }), /Claim not found/u);
    await assert.rejects(resumedAgent.readCheckpointEvidence({ claimId: claim.id }, AbortSignal.abort()), /abort/iu);
    resumedProvider.evidenceClaimId = claim.id;
    const lookup = await resumedAgent.runTask("请回查原始证据");
    assert.match(lookup.output, /old checkpoint payload/u);
    const lookupEvents = await readSessionEvents(resumedAgent.getInfo().sessionFile);
    assert.ok(lookupEvents.some((event) => event.type === "tool_call" && event.tool === "read_checkpoint_evidence"));
    assert.ok(lookupEvents.some((event) => event.type === "tool_result" && event.tool === "read_checkpoint_evidence"));
    const disabled = await resumedAgent.runTask("不要使用工具", { capabilitySelection: { tools: "none", skills: "none" } });
    assert.match(disabled.output, /Evidence tool disabled/u);
    // 连续压缩继承同一 claim 后，必须仍指回最初消息，不能把上一次摘要变成原始证据。
    resumedProvider.evidenceClaimId = undefined;
    resumedProvider.summarySource = "p.goal.0";
    for (let generation = 0; generation < 3; generation++) {
      await resumedAgent.runTask(`追加第 ${generation} 轮上下文`);
      await resumedAgent.compactConversation();
      await resumedAgent.resume("checkpoint-resume");
      const inherited = await resumedAgent.readCheckpointEvidence({ claimId: claim.id }) as { content: string; verification: string };
      assert.match(inherited.content, /old checkpoint payload/u);
      assert.equal(inherited.verification, "not_verified");
    }
    const missingCheckpoint = {
      ...compactedReplay.contextCheckpoint!, firstKeptMessageIndex: 1,
      evidence: [{ field: "goal" as const, itemIndex: 0, references: [
        { kind: "message" as const, messageId: "missing-original-message" },
        { kind: "checkpoint" as const, checkpointCreatedAt: "2026-09-21T00:00:00.000Z" }
      ] }]
    };
    const missingEvents: SessionEvent[] = [
      { type: "user_message", content: "remaining session material" },
      { type: "context_checkpoint", reason: "manual", ...missingCheckpoint }
    ];
    await fs.writeFile(sessionFilePath(workspaceRoot, "missing-checkpoint-evidence"), missingEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await resumedAgent.resume("missing-checkpoint-evidence");
    const missingClaim = checkpointClaims(missingCheckpoint.state!, missingCheckpoint.evidence)[0]!;
    const missing = await resumedAgent.readCheckpointEvidence({ claimId: missingClaim.id }) as { content: string; verification: string };
    assert.match(missing.content, /"status":"unavailable"/u);
    assert.match(missing.content, /"status":"inherited_only"/u);
    assert.equal(missing.verification, "not_verified");
    await resumedAgent.close();
  });
}

async function testCheckpointPersistenceFailureStopsSession(): Promise<void> {
  for (const phase of ["before_write", "after_write"] as const) for (const mode of ["manual", "automatic"] as const) {
    await withTempWorkspace(async (workspaceRoot) => {
      await ensureAgentDirs(workspaceRoot);
      class FaultRecorder extends SessionRecorder {
        armed = false;
        override async recordAndFlush(event: SessionEvent): Promise<SessionEvent> {
          if (event.type !== "context_checkpoint" || !this.armed) return await super.recordAndFlush(event);
          this.armed = false;
          if (phase === "before_write") throw new Error("Injected checkpoint write failure");
          await super.recordAndFlush(event);
          throw new Error("Injected ambiguous sync failure");
        }
      }
      const config = testConfig();
      config.context.memory.useMemories = false;
      config.context.memory.generateMemories = false;
      const recorder = new FaultRecorder(workspaceRoot, `fault-${phase}-${mode}`);
      config.context.maxInputTokens = 8_000;
      config.context.compaction.keepRecentTokens = 100;
      const provider = new ContextTestModel();
      // 自动压缩场景不能回报虚构的零 input usage，否则有效锚点会正确抑制估算触发。
      provider.reportUsage = mode !== "automatic";
      const agent = new AgentSession({ workspaceRoot, config, model: provider.model,
        toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder });
      await agent.initialize();
      await agent.runTask("original evidence must remain recoverable ".repeat(mode === "automatic" ? 5_000 : 1));
      recorder.armed = true;
      if (mode === "manual") await assert.rejects(agent.compactConversation(), /Checkpoint persistence failed/u);
      else {
        const failed = await agent.runTask("trigger automatic compaction");
        assert.equal(failed.status, "failed", JSON.stringify((await agent.contextStatus()).compaction));
        assert.match(failed.error ?? "", /Checkpoint persistence failed/u);
      }
      const blocked = await agent.runTask("must not execute");
      assert.equal(blocked.status, "failed");
      assert.match(blocked.error ?? "", /close and reopen/u);
      await assert.rejects(agent.compactConversation(), /close and reopen/u);
      await agent.close();
      const events = await readSessionEvents(recorder.filePath);
      assert.equal(events.some((event) => event.type === "user_message" && event.content === "must not execute"), false);
      assert.equal(events.some((event) => event.type === "assistant_message" && (event.contextState?.compactedMessages ?? 0) > 0), false, "失败后不得通过快照间接提交未确认状态");
      const replay = await replaySession(recorder.filePath);
      assert.equal(replay.contextCheckpoint !== undefined, phase === "after_write");
      if (mode === "manual") assert.equal(replay.messages.length, phase === "before_write" ? 2 : 0);
      const reopened = new AgentSession({ workspaceRoot, config, model: new ContextTestModel().model,
        toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder: new SessionRecorder(workspaceRoot) });
      await reopened.initialize();
      await reopened.resume(recorder.sessionId);
      assert.equal((await reopened.runTask("continue after recovery")).output, "ok");
      await reopened.close();
    });
  }
}

async function testTruncatedSessionTailAndDanglingToolRecovery(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    assert.throws(
      () => parseSessionEvents(JSON.stringify({ type: "user_message", content: 42 })),
      /Invalid session event at line 1.*content/u
    );
    const filePath = sessionFilePath(workspaceRoot, "interrupted-session");
    const events: SessionEvent[] = [
      { type: "user_message", content: "inspect the project" },
      { type: "tool_call", tool: "Read", args: { path: "src/index.ts" }, toolCallId: "dangling-1", sequence: 1 }
    ];
    await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n{"type":"assistant`, "utf8");

    const readable = await readSessionEvents(filePath);
    assert.equal(readable.length, 2);
    const replay = await replaySession(filePath);
    assert.equal(replay.recoveredToolResults.length, 1);
    assert.equal(replay.recoveredToolResults[0]?.toolCallId, "dangling-1");
    assert.equal(replay.messages.some((message) => message.role === "toolResult"), true);

    await repairSessionTailForAppend(filePath);
    const recorder = new SessionRecorder(workspaceRoot, "interrupted-session");
    for (const event of replay.recoveredToolResults) recorder.record(event);
    await recorder.close();
    const repaired = await readSessionEvents(filePath);
    assert.equal(repaired.length, 3);
    assert.equal((await replaySession(filePath)).recoveredToolResults.length, 0);

    const supersededFile = sessionFilePath(workspaceRoot, "superseded-tool-call");
    await fs.writeFile(supersededFile, [
      JSON.stringify({ type: "user_message", content: "first turn" }),
      JSON.stringify({ type: "tool_call", tool: "Read", args: { path: "old.ts" }, toolCallId: "old-call", sequence: 1 }),
      JSON.stringify({ type: "assistant_message", content: "continued without that result" }),
      JSON.stringify({ type: "user_message", content: "later turn" })
    ].join("\n") + "\n", "utf8");
    const supersededReplay = await replaySession(supersededFile);
    assert.equal(supersededReplay.recoveredToolResults.length, 1);
    assert.equal(supersededReplay.recoveredToolResults[0]?.executionStatus, "unknown");
    assert.equal(supersededReplay.messages.some((message) => hasToolResult(message, "old-call")), true);

    const healthyListFile = sessionFilePath(workspaceRoot, "healthy-list-session");
    const corruptListFile = sessionFilePath(workspaceRoot, "corrupt-list-session");
    await fs.writeFile(healthyListFile, `${JSON.stringify({ type: "user_message", content: "healthy list entry" })}\n`, "utf8");
    await fs.writeFile(corruptListFile, "{not-json}\n", "utf8");
    const summaries = await listSessionSummaries(workspaceRoot);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(healthyListFile)), true);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(corruptListFile)), false);
  });
}

async function testMessageMetadataPersistence(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot, "metadata-persistence");
    const user = recorder.record({ type: "user_message", content: "Remember my preference." });
    const answer = recorder.record({ type: "agent_message", metadata: { initial: "preserved", usage: { inputTokens: 3, details: { previous: true } }, nested: { previous: true }, apiKey: "not-a-real-metadata-secret" }, message: { role: "assistant", content: [{ type: "text", text: "Noted." }] } });
    assert.ok("messageId" in answer && answer.messageId);
    assert.ok("messageId" in user && user.messageId);
    recorder.record({ type: "message_metadata", messageId: answer.messageId, metadata: { memoryExtracted: true, memoryExtractedAt: "2026-09-06T00:00:00.000Z", retained: "existing" } });
    recorder.record({ type: "message_metadata", messageId: answer.messageId, metadata: { updated: true, usage: { outputTokens: 4, details: { current: true } }, nested: { current: true } } });
    recorder.record({ type: "message_metadata", messageId: "missing-message", metadata: { memoryExtracted: true } });
    await recorder.close();
    const events = await readSessionEvents(recorder.filePath);
    assert.equal((await fs.readFile(recorder.filePath, "utf8")).includes("not-a-real-metadata-secret"), false);
    assert.deepEqual(sessionMessageMetadata(events, answer.messageId), {
      initial: "preserved", apiKey: "[redacted]", usage: { inputTokens: 3, outputTokens: 4, details: { current: true } }, nested: { current: true },
      memoryExtracted: true, memoryExtractedAt: "2026-09-06T00:00:00.000Z", retained: "existing", updated: true
    });
    assert.deepEqual(sessionMessageMetadata(events, user.messageId), {});
    assert.deepEqual(sessionMessageMetadata(events, "missing-message"), {});
    assert.deepEqual(sessionEventsToConversation(events).map((message) => message.role), ["user", "assistant"]);
    assert.deepEqual(sessionEventsToTranscript(events), sessionEventsToTranscript(events.filter((event) => event.type !== "message_metadata")));
    assert.deepEqual(sessionMessageMetadata([
      { type: "message_metadata", messageId: "future-message", metadata: { memoryExtracted: true } },
      { type: "user_message", messageId: "future-message", content: "A later message" }
    ], "future-message"), {});
    const reopened = new SessionRecorder(workspaceRoot, recorder.sessionId);
    assert.equal(sessionMessageMetadata(parseSessionEvents(reopened.readText()), answer.messageId).memoryExtracted, true);
    await reopened.close();
    assert.throws(() => parseSessionEvents(JSON.stringify({ type: "message_metadata", messageId: "x", metadata: [] })), /Invalid session event/u);
    assert.throws(() => parseSessionEvents(JSON.stringify({ type: "user_message", messageId: "x", content: "test", metadata: [] })), /Invalid session event/u);
    for (const value of [null, false, 0, "", "xy", [5, 6]]) {
      const projected = sessionMessageMetadata([
        { type: "assistant_message", messageId: "usage-test", content: "Answer", metadata: { usage: { inputTokens: 7 } } },
        { type: "message_metadata", messageId: "usage-test", metadata: { usage: value } }
      ], "usage-test");
      assert.deepEqual(projected.usage, { inputTokens: 7, ...Object(value || {}) });
    }
  });
}

async function testTurnStatusPersistence(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const secret = "not-a-real-turn-status-secret";
    const recorder = new SessionRecorder(workspaceRoot, "turn-status-session");
    recorder.record({ type: "user_message", content: "finish the project" });
    recorder.record({ type: "assistant_message", content: "I made partial progress." });
    recorder.record({
      type: "turn_status",
      status: "incomplete",
      stopReason: "hard_step_limit",
      steps: 96,
      summary: `Authorization: Bearer ${secret}`,
      resumable: true,
      blockedReason: undefined,
      requiredAction: `apiKey=${secret}`,
      affectedTodoIds: ["todo-1"]
    });
    await recorder.close();

    const raw = await fs.readFile(recorder.filePath, "utf8");
    assert.equal(raw.includes(secret), false);
    const events = parseSessionEvents(raw);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "turn_status");
    if (terminal?.type !== "turn_status") throw new Error("Expected a persisted turn_status event.");
    assert.equal(terminal.status, "incomplete");
    assert.equal(terminal.stopReason, "hard_step_limit");
    assert.equal(terminal.steps, 96);
    assert.equal(terminal.resumable, true);
    assert.deepEqual(terminal.affectedTodoIds, ["todo-1"]);

    const summary = (await listSessionSummaries(workspaceRoot)).find((item) => item.fileName === "turn-status-session.jsonl");
    assert.equal(summary?.lastTurnStatus?.status, "incomplete");
    assert.equal(summary?.lastTurnStatus?.resumable, true);
    assert.equal(summary?.lastAssistantMessage, "I made partial progress.");

    const replay = await replaySession(recorder.filePath);
    assert.deepEqual(replay.messages.map((message) => message.role), ["user", "assistant"]);
    assert.throws(
      () => parseSessionEvents(JSON.stringify({
        type: "turn_status",
        status: "unknown",
        stopReason: "test",
        steps: -1
      })),
      /Invalid session event at line 1/u
    );
  });
}

async function testSessionAndToolDisplayRedaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const toolCallId = "sk-test-tool-call-12345678";
    const userSecret = "not-a-real-user-bearer-value";
    const argumentSecret = "opaque-argument-value";
    const resultSecret = "opaque-result-value";
    const checkpointSecret = "not-a-real-checkpoint-bearer-value";
    const recorder = new SessionRecorder(workspaceRoot, "redacted-session");
    recorder.record({ type: "user_message", content: `Authorization: Bearer ${userSecret}` });
    recorder.record({
      type: "tool_call",
      tool: "external_probe",
      args: {
        apiKey: argumentSecret,
        webhookSecret: argumentSecret,
        nested: { authorization: `Bearer ${argumentSecret}` },
        safe: "visible"
      },
      toolCallId,
      sequence: 1
    });
    recorder.record({
      type: "tool_result",
      tool: "external_probe",
      result: {
        stdout: `token=${resultSecret}`,
        diffPreview: `+ refresh_token=${resultSecret}`,
        safe: "visible"
      },
      toolCallId,
      sequence: 1
    });
    recorder.record({
      type: "context_checkpoint",
      reason: "manual",
      summary: `## Goal\n- Authorization: Bearer ${checkpointSecret}`,
      formatVersion: 1,
      state: {
        goal: [`Authorization: Bearer ${checkpointSecret}`],
        constraints: [],
        done: [],
        inProgress: [],
        blocked: [],
        decisions: [],
        errorsAndFixes: [],
        userMessages: [],
        nextSteps: [],
        criticalContext: []
      },
      evidence: [{
        field: "goal",
        itemIndex: 0,
        references: [{ kind: "archive", archivePath: `Authorization: Bearer ${checkpointSecret}` }]
      }],
      firstKeptMessageIndex: 1,
      tokensBefore: 1_000,
      compactedMessages: 1,
      createdAt: "2026-08-02T00:00:00.000Z"
    });
    await recorder.close();

    const raw = await fs.readFile(recorder.filePath, "utf8");
    for (const secret of [userSecret, argumentSecret, resultSecret, checkpointSecret]) assert.equal(raw.includes(secret), false);
    assert.match(raw, /\[redacted\]/);
    const events = parseSessionEvents(raw);
    const call = events.find((event): event is Extract<SessionEvent, { type: "tool_call" }> => event.type === "tool_call");
    const result = events.find((event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result");
    const checkpoint = events.find((event): event is Extract<SessionEvent, { type: "context_checkpoint" }> => event.type === "context_checkpoint");
    assert.equal(call?.toolCallId, toolCallId);
    assert.equal((call?.args as { apiKey?: string } | undefined)?.apiKey, "[redacted]");
    assert.equal((call?.args as { webhookSecret?: string } | undefined)?.webhookSecret, "[redacted]");
    assert.equal((result?.result as { safe?: string } | undefined)?.safe, "visible");
    assert.match(checkpoint?.summary ?? "", /\[redacted\]/u);
    assert.match(checkpoint?.state?.goal[0] ?? "", /\[redacted\]/u);
    assert.match(checkpoint?.evidence?.[0]?.references[0]?.archivePath ?? "", /\[redacted\]/u);

    const genericSecret = "opaque-generic-value";
    const generic = await createToolPermissionRequest({
      id: "generic-secret",
      name: "mcp_demo_probe",
      args: { apiKey: genericSecret, nested: { password: genericSecret }, safe: "visible" }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(generic).includes(genericSecret), false);
    assert.match(generic.details, /\[redacted\]/);

    const commandSecret = "not-a-real-command-bearer-value";
    const command = await createToolPermissionRequest({
      id: "command-secret",
      name: "Bash",
      args: { command: `curl -H 'Authorization: Bearer ${commandSecret}' https://example.invalid` }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(command).includes(commandSecret), false);

    const previewSecret = "not-a-real-preview-value";
    const write = await createToolPermissionRequest({
      id: "preview-secret",
      name: "Write",
      args: { path: "safe-preview.txt", content: `apiKey=${previewSecret}\n` }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(write).includes(previewSecret), false);
    assert.match(write.preview ?? "", /\[redacted\]/);

    const defaultHiddenBody = "this file body stays behind ctrl+o";
    const conciseWrite = await createToolPermissionRequest({
      id: "concise-write",
      name: "Write",
      args: { path: "concise.txt", content: defaultHiddenBody }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.match(conciseWrite.details, /File: concise\.txt/u);
    assert.equal(conciseWrite.details.includes(defaultHiddenBody), false);
    assert.match(conciseWrite.preview ?? "", /this file body stays behind ctrl\+o/u);
  });
}

async function testLegacyAgentStateIsIgnored(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const legacyRoot = path.join(workspaceRoot, ".agent");
    await fs.mkdir(path.join(legacyRoot, "sessions"), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, "attachments"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "sessions", "legacy.jsonl"), `${JSON.stringify({ type: "user_message", content: "legacy history" })}\n`, "utf8");
    await fs.writeFile(path.join(legacyRoot, "attachments", "legacy.png"), "legacy image", "utf8");

    await ensureAgentDirs(workspaceRoot);
    await assert.rejects(fs.access(path.join(workspaceRoot, ".biny", "attachments", "legacy.png")));
    assert.equal(await fs.readFile(path.join(legacyRoot, "attachments", "legacy.png"), "utf8"), "legacy image");
    await assert.rejects(resolveSessionFile(workspaceRoot, "legacy"), /Session not found/u);
  });
}

async function testFlatSessionMigration(): Promise<void> {
  // 旧日期分层（YYYY/MM/DD/<id>.jsonl）在首次访问时平铺回项目 session 目录根，文件名不变。
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const sessionsRoot = projectSessionsDir(await fs.realpath(workspaceRoot));
    const sessionId = "2026-08-23-dated";
    const datedDir = path.join(sessionsRoot, "2026", "08", "23");
    const source = path.join(datedDir, `${sessionId}.jsonl`);
    const content = `${JSON.stringify({ type: "user_message", content: "dated session" })}\n`;
    await fs.mkdir(datedDir, { recursive: true });
    await fs.writeFile(source, content, "utf8");

    await ensureAgentDirs(workspaceRoot);
    const target = path.join(sessionsRoot, `${sessionId}.jsonl`);
    await assert.rejects(fs.access(source));
    assert.equal(await fs.readFile(target, "utf8"), content);
    await assert.rejects(fs.access(datedDir));
    assert.deepEqual(await listSessionFiles(workspaceRoot), [`${sessionId}.jsonl`]);
  });

  // 根目录与日期目录里同名但内容不同的 session 无法猜测覆盖顺序，必须报错并两边都保留。
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const sessionsRoot = projectSessionsDir(await fs.realpath(workspaceRoot));
    const sessionId = "2026-08-23-conflict";
    const flat = path.join(sessionsRoot, `${sessionId}.jsonl`);
    const dated = path.join(sessionsRoot, "2026", "08", "23", `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(dated), { recursive: true });
    await fs.writeFile(flat, "flat\n", "utf8");
    await fs.writeFile(dated, "dated\n", "utf8");

    await assert.rejects(ensureAgentDirs(workspaceRoot), /Duplicate session id exists in flat and dated storage/u);
    assert.equal(await fs.readFile(flat, "utf8"), "flat\n");
    assert.equal(await fs.readFile(dated, "utf8"), "dated\n");
  });

  // 旧版纯 24hex 项目目录整体改名成 `<basename>-<hash8>`，目录里的文件保持原名。
  await withTempWorkspace(async (workspaceRoot) => {
    const canonicalWorkspace = await fs.realpath(workspaceRoot);
    const globalSessionsRoot = path.join(globalAgentDir(), "sessions");
    const legacyDir = path.join(globalSessionsRoot, legacyProjectStateDirName(canonicalWorkspace));
    const sessionId = "legacy-24hex-session";
    const content = `${JSON.stringify({ type: "user_message", content: "legacy 24hex session" })}\n`;
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, `${sessionId}.jsonl`), content, "utf8");

    await ensureAgentDirs(workspaceRoot);
    const sessionsRoot = projectSessionsDir(canonicalWorkspace);
    assert.notEqual(path.basename(sessionsRoot), legacyProjectStateDirName(canonicalWorkspace));
    assert.equal(path.basename(sessionsRoot), projectStateDirName(canonicalWorkspace));
    await assert.rejects(fs.access(legacyDir));
    assert.equal(await fs.readFile(path.join(sessionsRoot, `${sessionId}.jsonl`), "utf8"), content);
    assert.deepEqual(await listSessionFiles(workspaceRoot), [`${sessionId}.jsonl`]);
  });
}

async function testSessionPathBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const safeFile = sessionFilePath(workspaceRoot, "2026-07-18-safe");
    const sessionsRoot = projectSessionsDir(await fs.realpath(workspaceRoot));
    assert.equal(path.dirname(safeFile), sessionsRoot);
    await fs.writeFile(safeFile, `${JSON.stringify({ type: "user_message", content: "safe session" })}\n`, "utf8");
    const canonicalSafeFile = await fs.realpath(safeFile);

    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07-18-safe"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07-18-safe.jsonl"), canonicalSafeFile);
    await assert.rejects(resolveSessionFile(workspaceRoot, ".biny/sessions/2026-07-18-safe.jsonl"), /Invalid session reference/u);
    assert.equal(await resolveSessionFile(workspaceRoot, "latest"), canonicalSafeFile);
    assert.match((await readSessionSnapshot(workspaceRoot, "2026-07-18-safe")).bytes.toString("utf8"), /safe session/);
    assert.equal((await readStoredSessionEvents(workspaceRoot, "2026-07-18-safe")).events[0]?.type, "user_message");
    const duplicatePath = await duplicateSessionFile(workspaceRoot, "2026-07-18-safe", "safe-copy");
    assert.equal(await fs.readFile(duplicatePath, "utf8"), await fs.readFile(safeFile, "utf8"));
    await deleteSessionFile(workspaceRoot, "safe-copy");
    await assert.rejects(fs.access(duplicatePath));
    const deleteTombstones = (await fs.readdir(path.dirname(duplicatePath)))
      .filter((fileName) => fileName.startsWith(".session-delete-") && fileName.endsWith(".delete"));
    assert.equal(deleteTombstones.length, 1);
    assert.equal((await fs.stat(path.join(path.dirname(duplicatePath), deleteTombstones[0] ?? "missing"))).size, 0);
    assert.equal((await listSessionFiles(workspaceRoot)).some((fileName) => fileName.endsWith(".delete")), false);

    assert.throws(() => sessionFilePath(workspaceRoot, "../outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "nested/outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "nested\\outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "."), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, ".."), /Invalid session id/);
    await assert.rejects(resolveSessionFile(workspaceRoot, safeFile), /Invalid session reference/);
    await assert.rejects(resolveSessionFile(workspaceRoot, "../outside.jsonl"), /Invalid session reference/);
    await assert.rejects(resolveSessionFile(workspaceRoot, ".biny/sessions/../outside.jsonl"), /Invalid session reference/);

    const sessionsDir = path.dirname(safeFile);
    await fs.mkdir(path.join(sessionsDir, "directory.jsonl"));
    await assert.rejects(resolveSessionFile(workspaceRoot, "directory.jsonl"), /regular \.jsonl file/);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-session-outside-"));
    try {
      const outsideFile = path.join(outsideRoot, "outside.jsonl");
      const outsideContent = '{"type":"user_message"';
      await fs.writeFile(outsideFile, outsideContent, "utf8");
      await fs.symlink(outsideFile, path.join(sessionsDir, "linked.jsonl"));
      await assert.rejects(resolveSessionFile(workspaceRoot, "linked"), /regular \.jsonl file/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "linked"), /regular \.jsonl file/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "linked", "linked-copy"), /regular \.jsonl file/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "linked"), /regular \.jsonl file/);

      const hardlinkedFile = path.join(sessionsDir, "hardlinked.jsonl");
      await fs.link(outsideFile, hardlinkedFile);
      await assert.rejects(resolveSessionFile(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "2026-07-18-safe", "hardlinked"), /EEXIST/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(repairSessionTailForAppend(hardlinkedFile), /single-link regular \.jsonl file/);
      assert.throws(() => new SessionRecorder(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);

      const workspaceAlias = path.join(outsideRoot, "workspace-alias");
      await fs.symlink(workspaceRoot, workspaceAlias);
      assert.match((await readSessionSnapshot(workspaceAlias, "2026-07-18-safe")).bytes.toString("utf8"), /safe session/);

      const pinnedRecorder = new SessionRecorder(workspaceRoot, "pinned-before-parent-swap");
      const originalSessionsRoot = `${sessionsRoot}-original`;
      await fs.rename(sessionsRoot, originalSessionsRoot);
      await fs.symlink(outsideRoot, sessionsRoot);
      assert.throws(
        () => pinnedRecorder.record({ type: "user_message", content: "must not escape" }),
        /changed while it was being opened|ENOENT/
      );
      await pinnedRecorder.close();
      await assert.rejects(fs.access(path.join(outsideRoot, "pinned-before-parent-swap.jsonl")));
      await fs.rm(sessionsRoot, { force: true });
      await fs.rename(originalSessionsRoot, sessionsRoot);

      const config = testConfig();
      config.context.memory.useMemories = false;
      config.context.memory.generateMemories = false;
      const provider = new ContextTestModel();
      const agent = new AgentSession({
        workspaceRoot,
        config,
        model: provider.model,
        toolRegistry: new ToolRegistry(),
        permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
        recorder: new SessionRecorder(workspaceRoot)
      });
      await agent.initialize();
      await assert.rejects(agent.resume("linked.jsonl"), /regular \.jsonl file/);
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);
      await agent.close();

      const outsideSessionsDir = path.dirname(sessionFilePath(workspaceRoot, "outside"));
      await fs.rm(outsideSessionsDir, { recursive: true, force: true });
      await fs.symlink(outsideRoot, outsideSessionsDir);
      await assert.rejects(resolveSessionFile(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "outside", "must-not-copy"), /real directory, not a symbolic link/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(ensureAgentDirs(workspaceRoot), /real directory, not a symbolic link/);
      assert.throws(() => new SessionRecorder(workspaceRoot, "must-not-escape"), /real directory, not a symbolic link/);
      await assert.rejects(fs.access(path.join(outsideRoot, "must-not-escape.jsonl")));

      await fs.rm(outsideSessionsDir, { force: true });
      const runtimeRoot = agentDir(workspaceRoot);
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      await fs.symlink(outsideRoot, runtimeRoot);
      await assert.rejects(ensureAgentDirs(workspaceRoot), /real directory, not a symbolic link/);
      await assert.rejects(fs.access(path.join(outsideRoot, "sessions")));
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testGlobalSessionsStayProjectScoped(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-context-other-"));
    try {
      await Promise.all([ensureAgentDirs(workspaceRoot), ensureAgentDirs(otherWorkspace)]);
      const firstPath = sessionFilePath(workspaceRoot, "shared-id");
      const secondPath = sessionFilePath(otherWorkspace, "shared-id");
      assert.notEqual(path.dirname(firstPath), path.dirname(secondPath));
      await Promise.all([
        fs.writeFile(firstPath, `${JSON.stringify({ type: "user_message", content: "first project" })}\n`, "utf8"),
        fs.writeFile(secondPath, `${JSON.stringify({ type: "user_message", content: "second project" })}\n`, "utf8")
      ]);
      assert.match((await readSessionSnapshot(workspaceRoot, "latest")).bytes.toString("utf8"), /first project/u);
      assert.match((await readSessionSnapshot(otherWorkspace, "latest")).bytes.toString("utf8"), /second project/u);
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true });
    }
  });
}

async function testSessionReadLimits(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const healthyFile = sessionFilePath(workspaceRoot, "bounded-healthy");
    await fs.writeFile(healthyFile, `${JSON.stringify({ type: "user_message", content: "healthy bounded session" })}\n`, "utf8");
    const oversizedFile = sessionFilePath(workspaceRoot, "oversized-session");
    await fs.writeFile(oversizedFile, "", "utf8");
    await fs.truncate(oversizedFile, maxSessionFileBytes + 1);

    // 校验与写入路径保持严格：这些地方发现超限就该停下。
    await assert.rejects(readSessionEvents(oversizedFile), /maximum size/u);
    await assert.rejects(repairSessionTailForAppend(oversizedFile), /maximum size/u);
    // 打开路径改为读尾部并标注截断。超限就整条会话打不开，而用户是在想恢复它的时候才发现，
    // 这个失败模式比只拿到最近历史糟糕得多。
    const oversizedSnapshot = await readSessionSnapshot(workspaceRoot, "oversized-session");
    assert.equal(oversizedSnapshot.truncated, true);
    const oversizedRecorder = new SessionRecorder(workspaceRoot, "oversized-session");
    assert.throws(() => oversizedRecorder.readText(), /maximum size/u);
    await oversizedRecorder.close();

    const summaries = await listSessionSummaries(workspaceRoot);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(healthyFile)), true);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(oversizedFile)), false);

    const oversizedLine = JSON.stringify({ type: "user_message", content: "x".repeat(maxSessionEventLineBytes) });
    assert.throws(() => parseSessionEvents(`${oversizedLine}\n`), /event line 1 exceeds the maximum size/u);
    const eventLine = JSON.stringify({ type: "user_message", content: "bounded event" });
    const tooManyEvents = `${Array.from({ length: maxSessionEvents + 1 }, () => eventLine).join("\n")}\n`;
    assert.throws(() => parseSessionEvents(tooManyEvents), /cannot contain more than/u);
  });
}

async function testDeleteSessionReplacementRace(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const targetPath = sessionFilePath(workspaceRoot, "delete-race");
    const pinnedBackupPath = path.join(path.dirname(targetPath), "delete-race.pinned-backup");
    const originalContent = `${JSON.stringify({ type: "user_message", content: "original target" })}\n`;
    const replacementContent = `${JSON.stringify({ type: "user_message", content: "replacement must survive" })}\n`;
    await fs.writeFile(targetPath, originalContent, "utf8");

    let injected = false;
    await assert.rejects(deleteSessionFile(workspaceRoot, "delete-race", {
      beforeTombstoneMove: async ({ filePath }) => {
        injected = true;
        await fs.rename(filePath, pinnedBackupPath);
        await fs.writeFile(targetPath, replacementContent, "utf8");
      }
    }), /changed during deletion/u);

    assert.equal(injected, true);
    assert.equal(await fs.readFile(pinnedBackupPath, "utf8"), originalContent);
    assert.equal(await fs.readFile(targetPath, "utf8"), replacementContent);
    const tombstones = (await fs.readdir(path.dirname(targetPath)))
      .filter((fileName) => fileName.startsWith(".session-delete-") && fileName.endsWith(".delete"));
    assert.equal(tombstones.length, 1);
    assert.equal(await fs.readFile(path.join(path.dirname(targetPath), tombstones[0] ?? "missing"), "utf8"), replacementContent);

    const lateTargetPath = sessionFilePath(workspaceRoot, "delete-late-race");
    const pinnedAfterVerificationPath = path.join(path.dirname(lateTargetPath), "delete-late-race.pinned-after-verification");
    const lateOriginalContent = `${JSON.stringify({ type: "user_message", content: "late original" })}\n`;
    const lateReplacementContent = `${JSON.stringify({ type: "user_message", content: "late replacement must survive" })}\n`;
    await fs.writeFile(lateTargetPath, lateOriginalContent, "utf8");
    let replacedTombstonePath = "";
    await deleteSessionFile(workspaceRoot, "delete-late-race", {
      afterTombstoneVerified: async ({ tombstonePath }) => {
        replacedTombstonePath = tombstonePath;
        await fs.rename(tombstonePath, pinnedAfterVerificationPath);
        await fs.writeFile(tombstonePath, lateReplacementContent, "utf8");
      }
    });
    await assert.rejects(fs.access(lateTargetPath));
    assert.equal((await fs.stat(pinnedAfterVerificationPath)).size, 0);
    assert.equal(await fs.readFile(replacedTombstonePath, "utf8"), lateReplacementContent);
  });
}

async function testFailedCurrentSessionResumeKeepsRecorderUsable(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const brokenSessionId = "broken-current";
    const brokenFile = sessionFilePath(workspaceRoot, brokenSessionId);
    await fs.writeFile(brokenFile, [
      JSON.stringify({ type: "user_message", content: "valid prefix" }),
      "{not-json}",
      JSON.stringify({ type: "assistant_message", content: "valid suffix" })
    ].join("\n") + "\n", "utf8");
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const provider = new ContextTestModel();
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot, brokenSessionId)
    });
    await agent.initialize();

    await assert.rejects(agent.resume(brokenSessionId), /Invalid JSONL event at line 2/);
    const fallbackSession = agent.getInfo();
    assert.notEqual(fallbackSession.sessionId, brokenSessionId);
    assert.equal((await agent.runTask("continue in a healthy session")).output, "ok");
    await agent.close();
    const fallbackEvents = await readSessionEvents(fallbackSession.sessionFile);
    assert.deepEqual(fallbackEvents.map((event) => event.type), ["user_message", "agent_message", "assistant_message", "turn_status"]);
    assert.equal(fallbackEvents.at(-1)?.type === "turn_status" ? fallbackEvents.at(-1).status : undefined, "completed");
  });
}

async function testCredentialAndSymlinkBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "config.json"), JSON.stringify({ providers: { demo: { apiKey: "test-secret-value" } } }), "utf8");
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "config.json", []), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".env.local", []), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".envrc", []), /ignored by workspace policy/);
    assert.equal(redactSecrets('{"apiKey":"test-secret-value"}'), '{"apiKey":"[redacted]"}');
    await fs.symlink(path.join(workspaceRoot, "config.json"), path.join(workspaceRoot, "config-link.json"));
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "config-link.json", []), /resolves to a location ignored/);
    const criticalWrite = await createToolPermissionRequest({
      id: "critical-write",
      name: "Write",
      args: { path: ".zshrc", content: "export SAFE_TEST=1\n" }
    }, { workspaceRoot, ignore: [], sessionId: "test-session" });
    assert.equal(criticalWrite.riskLevel, "critical");
    assert.equal(criticalWrite.requireFullYes, true);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-outside-"));
    try {
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
      await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(workspaceRoot, "linked-secret.txt"));
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "linked-directory"));
      await fs.symlink(path.join(outsideRoot, "future.txt"), path.join(workspaceRoot, "dangling-secret.txt"));
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "linked-secret.txt", []), /symbolic link/);
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "linked-directory/new.txt", []), /symbolic link/);
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "dangling-secret.txt", []), /dangling symbolic link/);

      await ensureAgentDirs(workspaceRoot);
      const telemetryPath = path.join(agentDir(workspaceRoot), "telemetry.jsonl");
      const telemetryConfig = {
        ...defaultConfig,
        telemetry: { enabled: true, recordInputs: false, recordOutputs: true }
      };
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "start",
        provider: "test",
        modelId: "test",
        input: "must-not-be-recorded"
      });
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "step",
        provider: "test",
        modelId: "test",
        step: 1,
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        output: "visible-output"
      });
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "end",
        provider: "test",
        modelId: "test",
        steps: 1,
        output: "visible-output"
      });
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, {
        type: "request",
        provider: "test",
        modelId: "test",
        metrics: {
          requestId: "request-1",
          provider: "test",
          modelId: "test",
          startedAt: "2026-08-06T00:00:00.000Z",
          durationMs: 120,
          timeToFirstEventMs: 20,
          timeToFirstOutputMs: 40,
          attempts: [{ attempt: 1, durationMs: 100, status: 200, willRetry: false }],
          status: 200,
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          eventCount: 4,
          requestContext: {
            sessionId: "session-1",
            runId: "run-1",
            turnId: "turn-1",
            step: 2,
            operation: "agent",
            relatedToolCallIds: ["call-1"]
          }
        }
      });
      const telemetryEvents = (await fs.readFile(telemetryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(telemetryEvents.map((event) => event.type), ["start", "step", "end", "request"]);
      assert.equal(telemetryEvents[0]?.input, undefined);
      assert.equal(telemetryEvents[1]?.output, '"visible-output"');
      assert.equal(telemetryEvents[3]?.requestId, "request-1");
      assert.equal(telemetryEvents[3]?.durationMs, 120);
      assert.deepEqual(telemetryEvents[3]?.requestContext, {
        sessionId: "session-1",
        runId: "run-1",
        turnId: "turn-1",
        step: 2,
        operation: "agent",
        relatedToolCallIds: ["call-1"]
      });
      await fs.rm(telemetryPath);
      const telemetryVictim = path.join(outsideRoot, "telemetry-victim.txt");
      await fs.writeFile(telemetryVictim, "telemetry-victim-unchanged", "utf8");
      await fs.symlink(telemetryVictim, telemetryPath);
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, { type: "end", provider: "test", modelId: "test", steps: 1 });
      assert.equal(await fs.readFile(telemetryVictim, "utf8"), "telemetry-victim-unchanged");
      await fs.rm(telemetryPath);
      await fs.link(telemetryVictim, telemetryPath);
      await recordNativeTelemetry(telemetryConfig, workspaceRoot, { type: "end", provider: "test", modelId: "test", steps: 1 });
      assert.equal(await fs.readFile(telemetryVictim, "utf8"), "telemetry-victim-unchanged");

      const historyPath = path.join(agentDir(workspaceRoot), "input-history.jsonl");
      const historyVictim = path.join(outsideRoot, "history-victim.txt");
      await fs.writeFile(historyVictim, "history-victim-unchanged", "utf8");
      await fs.symlink(historyVictim, historyPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape"), /single-link regular file/);
      await assert.rejects(loadInputHistory(workspaceRoot), /single-link regular file/);
      assert.equal(await fs.readFile(historyVictim, "utf8"), "history-victim-unchanged");
      await fs.rm(historyPath);
      await fs.link(historyVictim, historyPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape"), /single-link regular file/);
      assert.equal(await fs.readFile(historyVictim, "utf8"), "history-victim-unchanged");
      await fs.rm(historyPath);
      const agentPath = agentDir(workspaceRoot);
      const originalAgentPath = `${agentPath}-original`;
      await fs.rename(agentPath, originalAgentPath);
      await fs.symlink(outsideRoot, agentPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape through parent"), /real directory/);
      await assert.rejects(loadInputHistory(workspaceRoot), /real canonical directory/);
      await assert.rejects(fs.access(path.join(outsideRoot, "input-history.jsonl")));
      await fs.rm(agentPath);
      await fs.rename(originalAgentPath, agentPath);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testMemoryExactDurableContentAndWriter(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const storeProvider = new ContextTestModel();
    const store = new LocalMemory(workspaceRoot, () => storeProvider.model);
    const oldMemoryDir = path.join(workspaceRoot, ".biny", "memory");
    await fs.mkdir(oldMemoryDir, { recursive: true });
    await fs.writeFile(path.join(oldMemoryDir, "old.md"), "This old project-local memory must not be loaded.", "utf8");
    assert.deepEqual((await store.listMemoryEntries()).entries, []);
    const first = await store.writeEntry({
      content: "Refresh src/agent/context/ContextMemory.ts after Write. apiKey=sk-supersecretvalue123.",
      tags: ["context", "refresh"],
      rationale: "Use deterministic SQLite memory."
    });
    assert.equal(first.written, true);
    const duplicate = await store.writeEntry({
      content: "Refresh src/agent/context/ContextMemory.ts after Write. apiKey=sk-supersecretvalue123.",
      tags: ["context", "refresh"],
      rationale: "Use deterministic SQLite memory."
    });
    assert.equal(duplicate.written, false);

    assert.ok(first.path);
    const database = new DatabaseSync(path.join(globalAgentDir(), "memory", memoryDatabaseFileName), { readOnly: true });
    try {
      const row = database.prepare("SELECT content FROM memories WHERE id = ?").get(first.entry?.id) as { content?: string } | undefined;
      assert.equal(row?.content?.includes("sk-supersecretvalue123"), true);
    } finally {
      database.close();
    }
    assert.match(redactSecrets("Authorization: Bearer abcdefghijklmnop"), /\[redacted\]/);
    assert.equal(redactSecrets("aws_secret_access_key=not-a-real-value"), "aws_secret_access_key=[redacted]");
    assert.equal(redactSecrets("-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----"), "[redacted private key]");
    assert.equal((await store.search("context refresh", ["src/agent/context/ContextMemory.ts"])).matches.length > 0, true);
    const abortedLookup = new AbortController();
    abortedLookup.abort();
    await assert.rejects(store.search("context refresh", [], { limit: 3, signal: abortedLookup.signal }), /abort/i);
  });
}

async function testMemoryLifecycleAndUsagePersistence(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const config = testConfig();
    config.context.memory.enabled = true;
    config.context.memory.useMemories = true;
    config.context.memory.generateMemories = true;
    // 自动 ADD：没有可用 semantic embedding 时不写入事实库。
    // 这个夹具不下载本地模型，因此专门验证后台抽取完成但写入 fail-closed。
    config.context.memory.embeddingModel = undefined;
    const provider = new ContextTestModel();
    await ensureAgentDirs(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot, "memory-usage");
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder
    });
    await agent.initialize();
    const extractionMessageIds: Array<string | undefined> = [];
    const localMemory = agent.getLocalMemory();
    const summarize = localMemory.summarizeAndStoreMemories.bind(localMemory);
    localMemory.summarizeAndStoreMemories = async (messages, options) => {
      extractionMessageIds.push(options.messageId);
      return summarize(messages, options);
    };
    // 记忆库现在是单一全局库：同一 agent 目录里先前测试写入的条目会一直保留，
    // 因此这里断言"失败闭合的回合不新增条目"，而不是断言绝对计数为 0。
    const baseline = await agent.getLocalMemory().getOverview();
    await agent.runTask(`Remember this successful context workflow: ${"grounded details ".repeat(20)}`);
    await waitForMemoryExtraction(provider, 1);
    await agent.runTask("Remember that this workflow also applies to the next completed answer.");
    await waitForMemoryExtraction(provider, 2);
    const overview = await agent.getLocalMemory().getOverview();
    await agent.close();
    const recordedEvents = await readSessionEvents(recorder.filePath);
    const assistantIds = recordedEvents.flatMap((event) => event.type === "assistant_message" && event.messageId ? [event.messageId] : []);
    const userIds = recordedEvents.flatMap((event) => event.type === "user_message" && event.messageId ? [event.messageId] : []);
    assert.equal(assistantIds.length, 2);
    assert.equal(new Set(assistantIds).size, 2);
    assert.deepEqual(extractionMessageIds, assistantIds);
    for (const id of assistantIds) {
      const metadata = sessionMessageMetadata(recordedEvents, id);
      assert.equal(metadata.memoryExtracted, true);
      assert.equal(typeof metadata.memoryExtractedAt, "string");
      assert.ok(Number.isFinite(Date.parse(String(metadata.memoryExtractedAt))));
      assert.equal(metadata.createdMemories, undefined);
      assert.equal(metadata.deletedMemories, undefined);
    }
    assert.equal(extractionMessageIds.some((id) => id !== undefined && userIds.includes(id)), false);
    // 有信息量的成功回合会直接尝试写入 active memory，不再经过候选队列；
    // 但语义能力不可用时，按自动记忆的 fail-closed 规则跳过 ADD。
    assert.equal(overview.entryCount, baseline.entryCount);

    const shortProvider = new ContextTestModel();
    const shortAgent = new AgentSession({
      workspaceRoot,
      config,
      model: shortProvider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot, "short-memory-usage")
    });
    await shortAgent.initialize();
    await shortAgent.runTask("hi");
    await waitForMemoryExtraction(shortProvider, 1);
    const afterShortTurn = await shortAgent.getLocalMemory().getOverview();
    await shortAgent.close();
    assert.equal(afterShortTurn.entryCount, overview.entryCount);
  });
}

async function testMemoryMetadataDetailsFromCompletedExtraction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const config = testConfig();
    config.context.memory.enabled = true;
    config.context.memory.generateMemories = true;
    await ensureAgentDirs(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot, "memory-details");
    const agent = new AgentSession({ workspaceRoot, config, model: new ContextTestModel().model, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder });
    await agent.initialize();
    const changes = {
      created: [{ id: "created-memory", content: "The user prefers concise updates." }],
      deleted: [{ id: "deleted-memory", content: "The previous project deadline is obsolete." }]
    };
    const memory = agent.getLocalMemory();
    const written = await memory.writeEntry({
      content: changes.created[0]!.content
    });
    assert.ok(written.entry);
    const termInputs: string[] = [];
    agent.getCrystalService().extract = async (text) => {
      termInputs.push(text);
      return [];
    };
    let callbackFinished = false;
    // 用已落库条目隔离验证抽取完成回调，不依赖下载向量模型。
    memory.summarizeAndStoreMemories = async (_messages, options) => {
      await options.onMemoryWritten?.(written.entry!);
      callbackFinished = true;
      return changes;
    };
    await agent.runTask("Update the remembered preferences.");
    await agent.close();
    assert.equal(callbackFinished, true);
    assert.deepEqual(termInputs, ["Update the remembered preferences."]);
    const events = await readSessionEvents(recorder.filePath);
    const assistant = events.find((event) => event.type === "assistant_message" && event.messageId !== undefined);
    assert.ok(assistant?.type === "assistant_message" && assistant.messageId);
    const metadata = sessionMessageMetadata(events, assistant.messageId);
    assert.equal(metadata.memoryExtracted, true);
    assert.deepEqual(metadata.createdMemories, changes.created.map((entry) => ({ ...entry, type: "created" })));
    assert.deepEqual(metadata.deletedMemories, changes.deleted.map((entry) => ({ ...entry, type: "deleted" })));
  });
}

async function waitForMemoryExtraction(provider: ContextTestModel, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (provider.memoryExtractionCalls < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(provider.memoryExtractionCalls >= count, true, "background memory extraction did not finish");
}

async function testAutomaticMemoryRecallRequiresEmbedding(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const config = testConfig();
    config.context.memory.enabled = true;
    config.context.memory.useMemories = true;
    config.context.memory.generateMemories = false;
    config.context.memory.queryRewrite = false;
    config.context.memory.embeddingModel = undefined;
    const provider = new ContextTestModel();
    await ensureAgentDirs(workspaceRoot);
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot, "configured-memory-recall-limit")
    });
    try {
      await agent.initialize();

      for (let index = 0; index < 4; index += 1) {
        await agent.getLocalMemory().writeEntry({
          content: `The recall-limit-token marker ${String(index)} is available for this retrieval test.`,
          tags: ["recall-limit-token"],
          importance: 3
        });

      }

      await agent.runTask("Find the recall-limit-token markers.");
      const systemPrompt = provider.systemPrompts.at(-1) ?? "";
      assert.doesNotMatch(systemPrompt, /recall-limit-token marker/u, "embedding 不可用时自动召回必须 fail-closed，不注入任何记忆");
    } finally {
      await agent.close();
    }
  });
}

async function testMemoryEntryManagementAndCjkSearch(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const store = new LocalMemory(workspaceRoot, () => provider.model);

    await store.writeEntry({
      content: "使用 wttr.in 获取天气并渲染 Markdown 表格。",
      tags: ["weather"]
    });

    const second = await store.writeEntry({
      content: "wttr.in 请求失败时最多重试三次并按指数退避。",
      tags: ["retry"]
    });

    // 中文查询没有空格分界，必须靠 bigram 命中记忆内容。
    const matches = await store.search("天气怎么获取", []);
    assert.equal(matches.matches.length > 0, true);
    assert.match(matches.matches[0]?.entry.content ?? "", /wttr\.in/u);

    // 记忆库是单一全局库，可能包含同 agent 目录里先前测试写入的条目；
    // 这里只断言本测试写入的两条记忆，避免与其他用例的条目互相耦合。
    const ownEntries = (await store.listMemoryEntries()).entries.filter((entry) => (
      entry.tags.includes("weather") || entry.tags.includes("retry")
    ));
    assert.equal(ownEntries.length, 2);
    assert.equal(ownEntries.some((entry) => entry.content.includes("按指数退避")), true);

    const deleted = await store.deleteEntryById(second.entry!.id);
    assert.equal(deleted.deleted, true);
    const remaining = (await store.listMemoryEntries()).entries.filter((entry) => (
      entry.tags.includes("weather") || entry.tags.includes("retry")
    ));
    assert.equal(remaining.length, 1);
    assert.equal((await store.deleteEntryById(second.entry!.id)).deleted, false);
  });
}

async function testMemoryStorageBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const isolatedAgentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-boundary-agent-"));
    const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
    process.env[BINY_AGENT_DIR_ENV] = isolatedAgentRoot;
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-outside-"));
    const store = new LocalMemory(workspaceRoot, () => new ContextTestModel().model);
    const entry = {
      content: "This sufficiently long test summary must never be written through an unsafe memory link.",
      tags: ["boundary"]
    };
    try {
      const victim = path.join(outsideRoot, "victim.md");
      const victimContent = "outside-memory-must-stay-unchanged";
      await fs.writeFile(victim, victimContent, "utf8");
      const memoryDir = path.join(globalAgentDir(), "memory");
      await fs.mkdir(path.dirname(memoryDir), { recursive: true });

      await fs.symlink(outsideRoot, memoryDir);
      await assert.rejects(store.search("outside-memory", []), /real directory, not a symbolic link/);
      await assert.rejects(store.writeEntry(entry), /real directory, not a symbolic link/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);

      await fs.rm(memoryDir, { force: true });
      await fs.mkdir(memoryDir);
      const databasePath = path.join(memoryDir, memoryDatabaseFileName);
      await fs.symlink(victim, databasePath);
      await assert.rejects(store.listMemoryEntries(), /regular, canonical file/);
      await assert.rejects(store.writeEntry(entry), /regular, canonical file/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);
    } finally {
      if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
      await rm(isolatedAgentRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testToolWriteMarksSnapshotAndRepoMapDirty(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "context-test" }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "existing.ts"), "export const existing = true;\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memoryProvider = new ContextTestModel();
    const memory = new ContextMemory(() => memoryProvider.model, workspace, undefined, 24_000, 32 * 1024);
    await memory.initialize();
    assert.equal((await memory.status()).snapshotDirty, false);

    await fs.writeFile(path.join(workspaceRoot, "src", "new.ts"), "export const created = true;\n", "utf8");
    memory.observeToolResult("Write", { path: "src/new.ts" }, { path: "src/new.ts", bytes: 28 });
    const dirty = await memory.status();
    assert.equal(dirty.snapshotDirty, true);
    assert.equal(dirty.repoMapDirty, true);
    assert.equal(dirty.activePaths.includes("src/new.ts"), true);

    const { messages } = await memory.prepareTurn("review src/new.ts", "system");
    assert.equal(messages.at(-1)?.content, "review src/new.ts");
    const refreshed = await memory.status();
    assert.equal(refreshed.snapshotDirty, false);
    assert.equal(refreshed.repoMapDirty, false);
  });
}

async function testSessionSummariesSortByUpdatedAt(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const older = new SessionRecorder(workspaceRoot, "older-summary");
    older.record({ type: "user_message", content: "older", time: "2026-01-01T00:00:00.000Z" });
    await older.close();

    const newer = new SessionRecorder(workspaceRoot, "newer-summary");
    newer.record({ type: "user_message", content: "newer", time: "2026-01-02T00:00:00.000Z" });
    await newer.close();

    assert.deepEqual(
      (await listSessionSummaries(workspaceRoot)).map((summary) => summary.fileName),
      ["newer-summary.jsonl", "older-summary.jsonl"]
    );
  });
}

function hasToolCall(message: AgentMessage | undefined, toolCallId: string): boolean {
  return Boolean(message?.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === toolCallId));
}

function hasToolResult(message: AgentMessage | undefined, toolCallId: string): boolean {
  return message?.role === "toolResult" && message.toolCallId === toolCallId;
}

async function testCrystalFailedAndCancelledTurns(): Promise<void> {
  for (const status of ["failed", "cancelled"] as const) {
    await withTempWorkspace(async (workspaceRoot) => {
      await ensureAgentDirs(workspaceRoot);
      const config = testConfig();
      config.context.memory.useMemories = false;
      config.context.memory.generateMemories = false;
      const model: AgentModel = { provider: "test", modelId: "terminal-crystal", stream: async () => { throw new Error("Terminal fixture model failure"); } };
      const agent = new AgentSession({ workspaceRoot, config, model, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder: new SessionRecorder(workspaceRoot) });
      await agent.initialize();
      const seen: string[] = [];
      agent.getCrystalService().extract = async (text) => { seen.push(text); return []; };
      const controller = new AbortController();
      if (status === "cancelled") controller.abort();
      const input = `Crystal topic from ${status} turn`;
      try {
        const outcome = await agent.runTask(input, { abortSignal: controller.signal });
        assert.equal(outcome.status, status);
      } finally {
        await agent.close();
      }
      assert.deepEqual(seen, [input]);
    });
  }
}

async function testCrystalSemanticDotProduct(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    config.crystal.semanticScanEnabled = true;
    const agent = new AgentSession({ workspaceRoot, config, model: new ContextTestModel().model, recorder: new SessionRecorder(workspaceRoot), toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }) });
    await agent.initialize();
    const ready = LocalEmbeddingManager.prototype.isReady;
    const createRuntime = LocalEmbeddingManager.prototype.createRuntime;
    let vector = new Float32Array([0.5, 0]);
    const inputs: string[][] = [];
    const models: string[] = [];
    let failEmbedding = false;
    let failedText: string | undefined;
    LocalEmbeddingManager.prototype.isReady = () => true;
    LocalEmbeddingManager.prototype.createRuntime = async (model) => {
      models.push(model);
      return {
      fingerprint: "crystal-dot-test",
      descriptor: { ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "crystal-dot-test", displayName: "test", recommendedThreshold: 0, source: "local" },
      embed: async (request) => {
        inputs.push([...request.texts]);
        if (failEmbedding || request.texts[0] === failedText) throw new Error("Embedding fixture failure");
        return { embeddings: [request.texts[0] === "Unrelated input text" ? vector : new Float32Array([1, 0])], dimensions: 2, fingerprint: "crystal-dot-test", model: { kind: "local", model: "multilingual-e5-small" } };
      }
      };
    };
    try {
      const crystals = agent.getCrystalService();
      const seed = crystals.createSeed("Target seed");
      const orderedSeeds = crystals.storage.listCrystals()
        .filter((item) => item.origin === "seed" && item.stage === "candidate" && !item.dormant && item.slot !== undefined)
        .sort((left, right) => left.slot! - right.slot!);
      const low = await crystals.processAnchor({ threadId: "dot", anchorId: "dot-low", day: "2026-09-06", text: "Unrelated input text", terms: [] });
      assert.equal(low.materialsAdded, 0);
      assert.deepEqual(inputs.map((texts) => texts[0]), ["Unrelated input text", ...orderedSeeds.map((item) => [item.name, ...Object.values(item.checklist).map((field) => field.value)].filter(Boolean).join(" | ").slice(0, 400))]);
      assert.equal(crystals.storage.listMaterials(seed.id).length, 0);
      vector = new Float32Array([0.75, 0]);
      inputs.length = 0;
      const high = await crystals.processAnchor({ threadId: "dot", anchorId: "dot-high", day: "2026-09-06", text: "Unrelated input text", terms: [] });
      assert.ok(high.materialsAdded >= 1);
      assert.equal(crystals.storage.listMaterials(seed.id).length, 1);
      assert.equal(crystals.storage.listMaterials(seed.id)[0]?.source, "auto-semantic");
      assert.deepEqual(inputs, [["Unrelated input text"]]);
      inputs.length = 0;
      await crystals.processAnchor({ threadId: "dot", anchorId: "dot-short", day: "2026-09-06", text: " 1234567 ", terms: [] });
      assert.deepEqual(inputs, []);
      await crystals.processAnchor({ threadId: "dot", anchorId: "dot-direct", day: "2026-09-06", text: "TARGET SEED", terms: [] });
      assert.equal(inputs.some((texts) => texts[0] === seed.name), false);
      assert.equal(crystals.storage.listMaterials(seed.id).find((material) => material.ref.anchorId === "dot-direct")?.source, "auto");
      inputs.length = 0;
      const longText = "  " + "x".repeat(900) + "  ";
      await crystals.processAnchor({ threadId: "dot", anchorId: "dot-long", day: "2026-09-06", text: longText, terms: [] });
      assert.ok(inputs.length > 0);
      assert.deepEqual(inputs, [["x".repeat(800)]]);
      const changed = crystals.storage.getCrystal(seed.id)!;
      changed.checklist.definition = { value: "Updated definition", sources: ["test"] };
      crystals.storage.putCrystal(changed);
      inputs.length = 0;
      await crystals.processAnchor({ threadId: "dot", anchorId: "dot-changed", day: "2026-09-06", text: "Unrelated input text", terms: [] });
      assert.deepEqual(inputs, [["Unrelated input text"], ["Target seed | Updated definition"]]);
      failEmbedding = true;
      inputs.length = 0;
      const beforeFailure = crystals.storage.listMaterials(seed.id);
      await crystals.processAnchor({ threadId: "dot", anchorId: "dot-failed", day: "2026-09-06", text: "Failed semantic source", terms: [] });
      assert.deepEqual(crystals.storage.listMaterials(seed.id), beforeFailure);
      assert.equal(crystals.storage.hasProcessedAnchor("dot-failed"), true);
      assert.deepEqual(inputs, [["Failed semantic source"]]);
      failEmbedding = false;
      const failingCandidate = crystals.storage.getCrystal(seed.id)!;
      failingCandidate.checklist.definition = { value: "Retry candidate", sources: ["test"] };
      crystals.storage.putCrystal(failingCandidate);
      failedText = "Target seed | Retry candidate";
      inputs.length = 0;
      await crystals.processAnchor({ threadId: "dot", anchorId: "dot-candidate-failed", day: "2026-09-06", text: "Unrelated input text", terms: [] });
      assert.deepEqual(crystals.storage.listMaterials(seed.id), beforeFailure);
      assert.deepEqual(inputs, [["Unrelated input text"], [failedText]]);
      const otherSeed = orderedSeeds.find((item) => item.id !== seed.id);
      assert.ok(otherSeed, "fixture must contain another active seed");
      assert.ok(crystals.storage.listMaterials(otherSeed.id).some((material) => material.ref.anchorId === "dot-candidate-failed"));
      failedText = undefined;
      inputs.length = 0;
      await crystals.processAnchor({ threadId: "dot", anchorId: "dot-candidate-recovered", day: "2026-09-06", text: "Unrelated input text", terms: [] });
      assert.deepEqual(inputs, [["Unrelated input text"], ["Target seed | Retry candidate"]]);
      assert.ok(models.length > 0 && models.every((model) => model === "multilingual-e5-small"));
      assert.ok(crystals.storage.listMaterials(seed.id).some((material) => material.ref.anchorId === "dot-candidate-recovered"));
    } finally {
      LocalEmbeddingManager.prototype.isReady = ready;
      LocalEmbeddingManager.prototype.createRuntime = createRuntime;
      await agent.close();
    }
  });
}

async function testCrystalDormancyWithoutNewAnchors(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const recorder = new SessionRecorder(workspaceRoot, "crystal-aging");
    recorder.record({ type: "user_message", messageId: "aging-processed", content: "Already processed topic" });
    const model: AgentModel = { provider: "test", modelId: "aging-test", stream: async () => {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "Done" };
        yield { type: "finish", reason: "stop" };
      })();
    } };
    const agent = new AgentSession({ workspaceRoot, config, model, recorder, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }) });
    await agent.initialize();
    const crystals = agent.getCrystalService();
    crystals.storage.markAnchorProcessed("aging-processed", new Date().toISOString());
    const old = { ...crystals.createSeed("Old candidate"), origin: "nucleus" as const, updatedAt: "2000-01-01T00:00:00.000Z" };
    crystals.storage.putCrystal(old);
    let anchorCalls = 0;
    crystals.extract = async () => { anchorCalls += 1; return []; };
    let dormant = false;
    const maintain = crystals.dormantOldCrystals.bind(crystals);
    crystals.dormantOldCrystals = () => {
      maintain();
      dormant = crystals.storage.getCrystal(old.id)?.dormant ?? false;
    };
    try {
      await agent.runTask("This anchor was already processed.", { recordSessionUserMessage: false });
    } finally {
      await agent.close();
    }
    assert.equal(anchorCalls, 0);
    assert.equal(dormant, true);
  });
}

async function testCrystalThreadBackfill(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const saved = new SessionRecorder(workspaceRoot, "crystal-backfill");
    saved.record({ type: "user_message", messageId: "backfill-old", content: "Old backlog topic", time: "2026-08-01T10:00:00.000Z" });
    saved.record({ type: "agent_message", messageId: "backfill-assistant", message: { role: "assistant", content: [{ type: "text", text: "Assistant must not become a term source" }] } });
    saved.record({ type: "user_message", messageId: "backfill-discarded", parentMessageId: "backfill-assistant", slotId: "backfill-choice", content: "Discarded branch topic" });
    saved.record({ type: "user_message", messageId: "backfill-selected", parentMessageId: "backfill-assistant", slotId: "backfill-choice", content: "Selected backlog topic", time: "2026-08-02T10:00:00.000Z" });
    await saved.close();
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    const model: AgentModel = { provider: "test", modelId: "backfill-test", stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: "Done" };
      yield { type: "finish", reason: "stop" };
    })() };
    const agent = new AgentSession({ workspaceRoot, config, model, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder: new SessionRecorder(workspaceRoot) });
    await agent.initialize();
    const seen: Array<{ text: string; day: string; anchorId: string }> = [];
    let count = 0;
    try {
      await agent.resume("crystal-backfill");
      const crystals = agent.getCrystalService();
      crystals.extract = async () => ["BackfillOnlyTopic"];
      const process = crystals.processAnchor.bind(crystals);
      crystals.processAnchor = async (options) => {
        const result = await process(options);
        if (result.claimed) seen.push({ text: options.text, day: options.day, anchorId: options.anchorId });
        count = crystals.storage.listTerms().find((term) => term.term === "backfillonlytopic")?.count ?? 0;
        return result;
      };
      await agent.runTask("Newest backlog topic");
      await agent.runTask("One more backlog topic");
    } finally {
      await agent.close();
    }
    assert.deepEqual(seen.map((entry) => entry.text), ["Old backlog topic", "Selected backlog topic", "Newest backlog topic", "One more backlog topic"]);
    assert.deepEqual(seen.slice(0, 2).map((entry) => entry.day), ["2026-08-01", "2026-08-02"]);
    assert.equal(count, 4);
    assert.equal(new Set(seen.map((entry) => entry.anchorId)).size, 4);
  });
}

async function testCrystalHistoricalMaterial(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const historical = new SessionRecorder(workspaceRoot, "crystal-history");
    historical.record({ type: "user_message", messageId: "historical-anchor", content: "Historical project evidence for crystal prefill." });
    await historical.close();
    const config = testConfig();
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    let materialPrompt = "";
    const systemPrompts: string[] = [];
    const model: AgentModel = {
      provider: "test",
      modelId: "material-test",
      stream: async (context) => (async function* (): AsyncGenerator<ModelStreamEvent> {
        // 后台称呼抽取与主聊天并发，不能覆盖这里观察的聊天/材料请求。
        if (context.systemPrompt?.startsWith("你是一个称呼抽取器。")) {
          yield { type: "text-delta", text: "[]" };
          yield { type: "finish", reason: "stop" };
          return;
        }
        if (context.systemPrompt?.includes("durable context checkpoint")) {
          yield { type: "text-delta", text: citeCheckpoint([
            "## Goal",
            "- Continue the current project task.",
            "## Constraints & Preferences",
            "- Keep only grounded facts.",
            "## Progress",
            "### Done",
            "- (none verified)",
            "### In Progress",
            "- [ ] Continue from retained evidence.",
            "### Blocked",
            "- (unknown)",
            "## Key Decisions",
            "- (none recorded)",
            "## Errors & Fixes",
            "- (none recorded)",
            "## All User Messages",
            "- Continue after compacting the conversation.",
            "## Next Steps",
            "1. Inspect retained context.",
            "## Critical Context",
            "- Keep evidence references."
          ].join("\n")) };
          yield { type: "finish", reason: "stop" };
          return;
        }
        materialPrompt = context.messages.map(messageText).join("\n");
        systemPrompts.push(context.systemPrompt ?? "");
        yield { type: "text-delta", text: JSON.stringify({ definition: { value: "Historical definition", sources: ["turn:historical-anchor"] } }) };
        yield { type: "finish", reason: "stop" };
      })()
    };
    const currentRecorder = new SessionRecorder(workspaceRoot);
    const agent = new AgentSession({
      workspaceRoot, config, model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: currentRecorder
    });
    await agent.initialize();
    try {
      const crystals = agent.getCrystalService();
      const seed = crystals.createSeed("Historical reference");
      crystals.setType(seed.id, "concept");
      crystals.addMaterial(seed.id, "turn", { threadId: "crystal-history", anchorId: "historical-anchor" });
      const filled = await crystals.prefill(seed.id);
      assert.match(materialPrompt, /Historical project evidence/u);
      assert.equal(filled.checklist.definition?.value, "Historical definition");
      const wrong = crystals.createSeed("Invalid reference");
      crystals.setType(wrong.id, "concept");
      crystals.addMaterial(wrong.id, "turn", { threadId: "crystal-hist", anchorId: "historical-anchor" });
      await assert.rejects(crystals.prefill(wrong.id), /no readable text/u);
      for (const field of ["includes", "excludes", "examples", "source"]) {
        crystals.updateChecklist(seed.id, field, { value: `${field} from historical evidence`, sources: ["turn:historical-anchor"] });
      }
      crystals.confirm(seed.id);
      systemPrompts.length = 0;
      await agent.runTask(`Use @[Historical reference](biny://crystal/${seed.id}) to explain the project.`);
      assert.match(materialPrompt, /Historical definition/u);
      assert.match(materialPrompt, /## Crystal references/u);
      assert.match(materialPrompt, /只有用户可以批准正式化/u);
      systemPrompts.length = 0;
      await agent.runTask("Now explain a completely unrelated topic.");
      assert.ok(systemPrompts.length > 0);
      assert.match(materialPrompt, /Referenced earlier in this thread \(resolve if relevant\):/u);
      assert.match(materialPrompt, new RegExp(`biny://crystal/${seed.id}`, "u"));
      assert.ok(systemPrompts.every((prompt) => !(prompt.match(/<!-- biny-crystal:start -->([\s\S]*?)<!-- biny-crystal:end -->/u)?.[1] ?? "").includes("Historical definition")));
      await currentRecorder.flush();
      const retryTarget = (await readSessionEvents(currentRecorder.filePath)).filter((event) => event.type === "agent_message" && event.message.role === "assistant").at(-1);
      assert.ok(retryTarget?.type === "agent_message" && retryTarget.messageId);
      await agent.runTask(`Later branch uses @[Invalid reference](biny://crystal/${wrong.id}).`);
      systemPrompts.length = 0;
      for await (const event of agent.retry(retryTarget.messageId)) {
        if (event.type === "error") assert.fail(event.message);
      }
      assert.match(materialPrompt, new RegExp(`biny://crystal/${seed.id}`, "u"));
      assert.doesNotMatch(materialPrompt, new RegExp(`biny://crystal/${wrong.id}`, "u"));
      await agent.compactConversation("Keep only a short summary without object references.");
      systemPrompts.length = 0;
      await agent.runTask("Continue after compacting the conversation.");
      assert.match(materialPrompt, new RegExp(`biny://crystal/${seed.id}`, "u"));
      assert.ok(systemPrompts.every((prompt) => !prompt.includes("Checklist:")));
      assert.equal(materialPrompt.includes(`biny://crystal/${seed.id}`), true, "当前回合仍可通过动态 Crystal context 看到已确认卡片");
      const entered = deferred<void>();
      const released = deferred<void>();
      crystals.extract = async () => {
        entered.resolve();
        await released.promise;
        return ["ShutdownEvidence"];
      };
      await agent.runTask("Keep ShutdownEvidence across shutdown.");
      let closed = false;
      const closing = agent.close().then(() => { closed = true; });
      try {
        await entered.promise;
        assert.equal(closed, false);
      } finally {
        released.resolve();
        await closing;
      }
      const reopened = new CrystalStorage();
      await reopened.initialize();
      try {
        assert.ok(reopened.listTerms().some((term) => term.term === "shutdownevidence" && term.count >= 1));
      } finally {
        reopened.close();
      }
    } finally {
      await agent.close();
    }
  });
}

function testConfig(): AgentConfig {
  const config = JSON.parse(JSON.stringify(defaultConfig)) as AgentConfig;
  // 测试只依赖注入的 ContextTestModel，不能被开发机的真实环境变量改变辅助模型选择。
  config.providers.deepseek = { ...config.providers.deepseek!, apiKeyEnv: "BINY_CONTEXT_TEST_UNCONFIGURED_KEY" };
  return config;
}

async function withTempWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-"));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

await main();
