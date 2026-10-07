/** File text can quote an archive reference without owning that archive. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentMessage, AgentToolResultMessage } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { projectSingleToolResultForModel, projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { archiveToolResult, readToolResultArchive, serializeToolResult } from "../src/session/toolResultArchive.js";
import { createReadFileTool, type ReadFileResult } from "../src/tools/file/readFile.js";
import { createReadToolResultTool, type ReadToolResultResult } from "../src/tools/file/readToolResult.js";
import { ToolRegistry } from "../src/tools/registry.js";

const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "biny-read-projection-reference-"));
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
  const archive = async (toolCallId: string, result: unknown, sequence = 1) => archiveToolResult({
    workspaceRoot, sessionId: recorder.sessionId, toolCallId, sequence, tool: "Read", result
  });
  return { workspaceRoot, recorder, events, tool, archive };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null);
  return value as Record<string, unknown>;
}

function readResult(content: string, endLine: number): ReadFileResult {
  return { path: "notes.txt", content, startLine: 1, endLine, hasMore: false, nextStartLine: undefined };
}

function messagesFor(id: string, value: unknown): AgentMessage[] {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: "Read", arguments: { path: "notes.txt" } }] },
    { role: "toolResult", toolCallId: id, toolName: "Read", content: [{ type: "text", text: serializeToolResult(value) }], details: value }
  ];
}

try {
  await test("large Read quoting an unrelated archive recovers its own complete page through persisted tool results", async () => {
    const f = await fixture("quoted-reference");
    const unrelated = await f.archive("unrelated", "unrelated prior output");
    const content = `Example: ${JSON.stringify({ archived: true, archivePath: unrelated.archivePath })}\n${"a".repeat(6_000)}\nMIDDLE_EVIDENCE 中文 😀\n${"z".repeat(6_000)}`;
    await writeFile(path.join(f.workspaceRoot, "notes.txt"), content);
    const result = await f.tool("Read").execute("read-notes", { path: "notes.txt" });
    assert.equal(result.isError, false);
    const projected = record(result.details);
    assert.equal(projected.contentTruncated, true);
    assert.equal(projected.hasMore, false, "projection loss is distinct from source pagination");
    assert.equal(projected.nextStartLine, undefined);
    assert.ok(!String(projected.content).includes("MIDDLE_EVIDENCE"));
    assert.notEqual(projected.archivePath, unrelated.archivePath, "quoted file content must not supply this result's archive identity");
    assert.equal(projected.archived, true);
    const completed = f.events.find((event) => event.type === "tool.completed" && event.toolCallId === "read-notes");
    assert.ok(completed?.type === "tool.completed");
    assert.equal(typeof record(completed.result).durationMs, "number");
    const expected = { ...readResult(content, 4), durationMs: record(completed.result).durationMs, truncated: false };
    const expectedOutput = serializeToolResult(expected);
    assert.equal(serializeToolResult(completed.result), expectedOutput);
    const archivedOutput = (await readToolResultArchive(f.workspaceRoot, String(projected.archivePath))).output;
    assert.equal(archivedOutput, expectedOutput);
    assert.equal((await readToolResultArchive(f.workspaceRoot, unrelated.archivePath)).output, "unrelated prior output");
    assert.equal((await readdir(path.join(agentDir(f.workspaceRoot), "tool-results"))).length, 2);

    let restored = "";
    let offset = 0;
    for (let pageNumber = 0; ; pageNumber += 1) {
      const result = await f.tool("read_tool_result").execute(`recover-${pageNumber}`, { archivePath: projected.archivePath, offset, length: 1_007 });
      assert.equal(result.isError, false);
      const page = result.details as ReadToolResultResult;
      assert.equal(page.offset, offset);
      assert.ok(page.content.isWellFormed());
      restored += page.content;
      assert.equal(page.nextOffset, offset + page.content.length);
      offset = page.nextOffset;
      if (!page.hasMore) break;
      assert.ok(page.content.length > 0);
      assert.ok(pageNumber < expectedOutput.length);
    }
    assert.equal(restored, expectedOutput);
    await f.recorder.flush();
    const events = await readSessionEvents(f.recorder.filePath);
    const persisted = events.filter((event) => event.type === "tool_result" && event.toolCallId === "read-notes");
    assert.equal(persisted.length, 1);
    assert.ok(persisted[0]?.type === "tool_result");
    assert.equal(persisted[0].executionStatus, "succeeded");
    assert.equal(serializeToolResult(persisted[0].result), expectedOutput);
    const replay = replaySessionEvents(events, { sessionId: f.recorder.sessionId });
    const projectedReplay = await projectToolResultsForModel(replay.messages, {
      keepRecentResults: 0,
      archiveResult: async (request) => f.archive(request.message.toolCallId, request.result, request.sequence)
    });
    const replayed = projectedReplay.find((message): message is AgentToolResultMessage => message.role === "toolResult" && message.toolCallId === "read-notes");
    assert.ok(replayed);
    assert.equal((await readToolResultArchive(f.workspaceRoot, String(record(replayed.details).archivePath))).output, expectedOutput);
    assert.deepEqual(await readFile(path.join(f.workspaceRoot, "notes.txt")), Buffer.from(content), "reading, projection and replay never mutate the file");
  });

  await test("covering Read archives the older page instead of following a quoted missing reference", async () => {
    const f = await fixture("covered-reference");
    const quoted = `.biny/tool-results/tool-result-${"f".repeat(64)}.json`;
    await writeFile(path.join(f.workspaceRoot, "notes.txt"), `reference: ${quoted}\nold evidence`);
    const previous = await f.tool("Read").execute("previous", { path: "notes.txt" });
    assert.equal(previous.isError, false);
    await writeFile(path.join(f.workspaceRoot, "notes.txt"), "new evidence\nsecond line\nthird line");
    const current = await f.tool("Read").execute("current", { path: "notes.txt" });
    assert.equal(current.isError, false);
    const messages: AgentMessage[] = [
      { role: "user", content: "Inspect both versions" },
      ...messagesFor("previous", previous.details), ...messagesFor("current", current.details)
    ];
    const before = structuredClone(messages);
    const projected = await projectToolResultsForModel(messages, {
      archiveResult: async (request) => f.archive(request.message.toolCallId, request.result, request.sequence)
    });
    const replacement = projected[2];
    assert.ok(replacement?.role === "toolResult");
    const details = record(replacement.details);
    assert.equal(details.reason, "read_covered");
    assert.notEqual(details.archivePath, quoted);
    assert.equal((await readToolResultArchive(f.workspaceRoot, String(details.archivePath))).output, serializeToolResult(previous.details));
    assert.deepEqual(projected[4], before[4], "the covering read remains available");
    assert.deepEqual(messages, before, "projection does not mutate the original messages");
  });

  await test("real turn-budget Read envelopes retain their owned archive without another archive write", async () => {
    const f = await fixture("trusted-envelope", 256);
    await writeFile(path.join(f.workspaceRoot, "notes.txt"), "retained evidence\n".repeat(20));
    const result = await f.tool("Read").execute("budgeted-read", { path: "notes.txt" });
    assert.equal(result.isError, false);
    const envelope = record(result.details);
    assert.equal(envelope.archived, true);
    assert.equal(typeof envelope.archivePath, "string");
    const filesBefore = await readdir(path.join(agentDir(f.workspaceRoot), "tool-results"));
    const options = { archiveResult: async () => { throw new Error("an existing owned archive must not be rewritten"); } };
    assert.deepEqual(await projectSingleToolResultForModel("Read", { path: "notes.txt" }, envelope, options), envelope);
    const messages: AgentMessage[] = [{ role: "user", content: "Read notes" }, ...messagesFor("budgeted-read", envelope)];
    assert.deepEqual(await projectToolResultsForModel(messages, { ...options, keepRecentResults: 0 }), messages);
    assert.deepEqual(await readdir(path.join(agentDir(f.workspaceRoot), "tool-results")), filesBefore);
    await writeFile(path.join(f.workspaceRoot, "notes.txt"), "updated evidence\n".repeat(20));
    const next = await f.tool("Read").execute("next-budgeted-read", { path: "notes.txt" });
    assert.equal(next.isError, false);
    assert.equal(record(next.details).archived, true);
    const covered = await projectToolResultsForModel([...messages, ...messagesFor("next-budgeted-read", next.details)], options);
    assert.ok(covered[2]?.role === "toolResult");
    assert.equal(record(covered[2].details).reason, "read_covered");
    assert.equal(record(covered[2].details).archivePath, envelope.archivePath,
      "replacement of a real archived Read must reuse its owned reference without rearchiving");
    assert.equal(record(covered[2].details).archiveError, undefined);
    const recovered = await f.tool("read_tool_result").execute("budgeted-recover", { archivePath: envelope.archivePath });
    assert.equal(recovered.isError, false);
    const original = JSON.parse((recovered.details as ReadToolResultResult).content) as ReadFileResult;
    assert.equal(original.content, "retained evidence\n".repeat(19) + "retained evidence");
    assert.equal(original.endLine, 20);
  });

  await test("Read archive write failure retains the original page instead of claiming a quoted archive is available", async () => {
    const f = await fixture("archive-failure");
    const quoted = `.biny/tool-results/tool-result-${"e".repeat(64)}.json`;
    const content = `${quoted}\n${"x".repeat(6_000)}\nMIDDLE_EVIDENCE\n${"y".repeat(6_000)}`;
    await writeFile(path.join(f.workspaceRoot, "notes.txt"), content);
    const archiveDirectory = path.join(agentDir(f.workspaceRoot), "tool-results");
    await rm(archiveDirectory, { recursive: true });
    await writeFile(archiveDirectory, "archive storage unavailable");
    const result = await f.tool("Read").execute("failed-archive-read", { path: "notes.txt" });
    assert.equal(result.isError, false, "archive failure must not change successful Read execution");
    const projected = record(result.details);
    assert.equal(projected.archived, false);
    assert.equal(projected.archivePath, undefined);
    assert.equal(typeof projected.archiveError, "string");
    assert.equal(record(projected.result).content, content);
    assert.match(String(projected.summary), /read_tool_result is unavailable/u);
    await f.recorder.flush();
    const events = await readSessionEvents(f.recorder.filePath);
    const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "failed-archive-read");
    assert.ok(persisted?.type === "tool_result");
    assert.equal(record(persisted.result).content, content);
    assert.equal(persisted.executionStatus, "succeeded");
    assert.deepEqual(await readFile(path.join(f.workspaceRoot, "notes.txt")), Buffer.from(content));
  });

} finally {
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(suiteRoot, { recursive: true, force: true });
}
