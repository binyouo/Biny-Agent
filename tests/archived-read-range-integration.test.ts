/** CI integration regressions for actual Read ranges in both Coordinator envelopes. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentMessage, AgentToolResultMessage } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { serializeToolResult } from "../src/session/toolResultArchive.js";
import { createReadFileTool, type ReadFileArgs } from "../src/tools/file/readFile.js";
import { createReadToolResultTool, type ReadToolResultResult } from "../src/tools/file/readToolResult.js";
import { ToolRegistry } from "../src/tools/registry.js";

// Same isolated agent-directory/recorder lifecycle as read-projection-archive-reference.test.ts.
const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "biny-archived-read-range-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(suiteRoot, "agent");
const recorders: SessionRecorder[] = [];

async function fixture(name: string, budget = 4 * 1024 * 1024) {
  const workspaceRoot = path.join(suiteRoot, name);
  await mkdir(workspaceRoot);
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.checkpoints.enabled = false;
  config.context.maxTurnToolResultBytes = budget;
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createReadFileTool({ workspaceRoot, ignore: config.workspace.ignore }));
  registry.registerBuiltinTool(createReadToolResultTool({ workspaceRoot, ignore: config.workspace.ignore }));
  const recorder = new SessionRecorder(workspaceRoot, name);
  recorders.push(recorder);
  const events: AgentSessionEvent[] = [];
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), (event) => { events.push(event); });
  const tool = (name: string) => {
    const result = coordinator.createAgentTools().find((candidate) => candidate.name === name);
    assert.ok(result);
    return result;
  };
  const original = (id: string) => {
    const event = events.find((entry) => entry.type === "tool.completed" && entry.toolCallId === id);
    assert.ok(event?.type === "tool.completed");
    return event.result;
  };
  return { workspaceRoot, recorder, tool, original };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null);
  return value as Record<string, unknown>;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(serializeToolResult(value), "utf8");
}

function messagesFor(id: string, args: ReadFileArgs, value: unknown): AgentMessage[] {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: "Read", arguments: { ...args } }] },
    { role: "toolResult", toolCallId: id, toolName: "Read", content: [{ type: "text", text: serializeToolResult(value) }], details: value }
  ];
}

function resultFor(messages: AgentMessage[], id: string): AgentToolResultMessage {
  const message = messages.find((entry): entry is AgentToolResultMessage => entry.role === "toolResult" && entry.toolCallId === id);
  assert.ok(message);
  return message;
}

const noArchiveRewrite = {
  archiveResult: async () => { throw new Error("disjoint pages and owned archive references must not be rearchived"); }
};

try {
  await test("turn-budget Read preserves disjoint pages, charges envelopes, and reuses a truly covered archive", async () => {
    const f = await fixture("budget", 1024);
    const lines = Array.from({ length: 100 }, (_, index) => index === 0 ? "a".repeat(600) : index === 99 ? "z".repeat(600) : "middle");
    const file = path.join(f.workspaceRoot, "notes.txt");
    await writeFile(file, lines.join("\n"));
    const farArgs = { path: "notes.txt", startLine: 100, lineCount: 1 };
    const firstArgs = { path: "notes.txt", startLine: 1, lineCount: 1 };
    const far = await f.tool("Read").execute("far", farArgs);
    const first = await f.tool("Read").execute("first", firstArgs);
    assert.equal(far.isError, false);
    assert.equal(first.isError, false);
    assert.equal(record(far.details).archived, undefined);
    assert.equal(record(far.details).content, lines[99]);
    assert.ok(bytes(far.details) < 1024);
    assert.ok(bytes(f.original("first")) > 1024 - bytes(far.details));
    const envelope = record(first.details);
    assert.equal(envelope.archived, true);
    assert.equal(envelope.startLine, 1);
    assert.equal(envelope.endLine, 1);
    assert.equal(envelope.turnBudgetBytes, 1024);
    assert.equal(envelope.resultBytes, bytes(f.original("first")));
    assert.equal(envelope.producedResultBytes, bytes(f.original("far")) + bytes(f.original("first")));
    assert.ok(bytes(far.details) + bytes(envelope) > 1024, "the serialized envelope, including bounds, consumes the remaining budget");

    const messages: AgentMessage[] = [{ role: "user", content: "Inspect separate pages" },
      ...messagesFor("far", farArgs, far.details), ...messagesFor("first", firstArgs, first.details)];
    const before = structuredClone(messages);
    assert.deepEqual(await projectToolResultsForModel(messages, noArchiveRewrite), before);
    assert.deepEqual(messages, before);

    // Change only the covered page so this is semantic coverage, not exact-result deduplication.
    lines[0] = "b".repeat(600);
    await writeFile(file, lines.join("\n"));
    const next = await f.tool("Read").execute("next", firstArgs);
    assert.equal(next.isError, false);
    assert.equal(record(next.details).archived, true);
    assert.equal(record(next.details).preview, undefined, "prior serialized envelope bytes leave no preview allowance");
    assert.equal(record(next.details).startLine, 1);
    assert.equal(record(next.details).endLine, 1);
    const filesBefore = await readdir(path.join(agentDir(f.workspaceRoot), "tool-results"));
    const covered = await projectToolResultsForModel([...messages, ...messagesFor("next", firstArgs, next.details)], noArchiveRewrite);
    assert.deepEqual(resultFor(covered, "far"), resultFor(before, "far"));
    const replacement = record(resultFor(covered, "first").details);
    assert.equal(replacement.reason, "read_covered");
    assert.equal(replacement.archivePath, envelope.archivePath);
    assert.equal(replacement.archiveError, undefined);
    assert.deepEqual(await readdir(path.join(agentDir(f.workspaceRoot), "tool-results")), filesBefore);
    const restored = await f.tool("read_tool_result").execute("recover-first", { archivePath: envelope.archivePath });
    assert.equal(restored.isError, false);
    assert.equal((restored.details as ReadToolResultResult).hasMore, false);
    assert.equal((restored.details as ReadToolResultResult).content, serializeToolResult(f.original("first")));
    assert.equal(record(JSON.parse((restored.details as ReadToolResultResult).content)).content, "a".repeat(600));
    assert.deepEqual(await readFile(file), Buffer.from(lines.join("\n")));
  });

  await test("large persisted Read replays its actual default-start page without covering a disjoint page", async () => {
    const f = await fixture("persistence");
    const lines = Array.from({ length: 100 }, (_, index) => index < 20 ? "p".repeat(3000) : `line ${index + 1}`);
    const content = lines.join("\n");
    const file = path.join(f.workspaceRoot, "notes.txt");
    await writeFile(file, content);
    const far = await f.tool("Read").execute("far", { path: "notes.txt", startLine: 100, lineCount: 1 });
    const first = await f.tool("Read").execute("first", { path: "notes.txt", lineCount: 20 });
    assert.equal(far.isError, false);
    assert.equal(first.isError, false);
    const original = f.original("first");
    assert.ok(bytes(original) > 32 * 1024, "exercise persistence outlining, independently of the ample turn budget");
    assert.equal(record(original).content, lines.slice(0, 20).join("\n"));
    await f.recorder.flush();
    const events = await readSessionEvents(f.recorder.filePath);
    const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "first");
    assert.ok(persisted?.type === "tool_result");
    assert.equal(persisted.executionStatus, "succeeded");
    const envelope = record(persisted.result);
    assert.equal(envelope.archived, true);
    assert.equal(envelope.startLine, 1);
    assert.equal(envelope.endLine, 20);
    assert.equal(envelope.resultBytes, bytes(original));
    assert.match(String(envelope.summary), /inline persistence limit/u);
    const replay = replaySessionEvents(events, { sessionId: f.recorder.sessionId });
    const messages: AgentMessage[] = [{ role: "user", content: "Inspect separate pages" }, ...replay.messages];
    assert.equal(messages.filter((message) => message.role === "assistant").length, 2, "sequential executions must replay as distinct steps");
    assert.deepEqual(resultFor(messages, "first").details, persisted.result);
    assert.equal(record(resultFor(messages, "far").details).content, "line 100");
    const before = structuredClone(messages);
    assert.deepEqual(await projectToolResultsForModel(messages, noArchiveRewrite), before);
    assert.deepEqual(messages, before);
    const restored = await f.tool("read_tool_result").execute("recover-large", { archivePath: envelope.archivePath, length: 200_000 });
    assert.equal(restored.isError, false);
    assert.equal((restored.details as ReadToolResultResult).hasMore, false);
    assert.equal((restored.details as ReadToolResultResult).content, serializeToolResult(original));
    assert.deepEqual(await readFile(file), Buffer.from(content));
  });
} finally {
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(suiteRoot, { recursive: true, force: true });
}
