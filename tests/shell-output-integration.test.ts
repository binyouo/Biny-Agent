/** Production shell/coordinator integration under an isolated fixture policy; restrictive defaults are tested separately. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { shellOutputBudgetBytes } from "../src/agent/shellOutputProjection.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { projectSingleToolResultForModel, projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import type { AgentToolResultMessage } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { archiveToolResult, readToolResultArchive, serializeToolResult } from "../src/session/toolResultArchive.js";
import { createReadToolResultTool, type ReadToolResultResult } from "../src/tools/file/readToolResult.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createRunCommandTool, runShellCommand, type RunCommandToolResult } from "../src/tools/shell/runCommand.js";

const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "biny-shell-output-integration-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR ??= path.join(suiteRoot, "agent");
const recorders: SessionRecorder[] = [];
const secret = "sk-shellfixture1234567890";
const stdout = `STDOUT_HEAD\n${secret}\n${"你🙂 out line\n".repeat(4_000)}STDOUT_TAIL`;
const stderr = `STDERR_HEAD\n${"é🚀 error line\n".repeat(3_000)}STDERR_TAIL`;
const script = `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const record = (value: unknown): Record<string, any> => value as Record<string, any>;

async function fixture(name: string, turnBudget = 4 * 1024 * 1024, restrictive = false) {
  const workspaceRoot = path.join(suiteRoot, name);
  await mkdir(workspaceRoot);
  await ensureAgentDirs(workspaceRoot);
  await writeFile(path.join(workspaceRoot, "output.cjs"), script);
  const command = `${shellQuote(process.execPath)} output.cjs`;
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  // Isolated application fixture policy for printing known local test data only.
  // Executor/OS enforcement and production defaults are unchanged; the restrictive
  // default policy is exercised below and must still refuse unsupported Linux use.
  if (!restrictive) config.permission.denyPaths = [];
  config.checkpoints.enabled = false;
  config.context.maxTurnToolResultBytes = turnBudget;
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createRunCommandTool({ workspaceRoot, ignore: config.workspace.ignore }, config.sandbox));
  registry.registerBuiltinTool(createReadToolResultTool({ workspaceRoot, ignore: config.workspace.ignore }));
  const recorder = new SessionRecorder(workspaceRoot, name);
  recorders.push(recorder);
  const events: AgentSessionEvent[] = [];
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), (event) => events.push(event));
  const tool = (name: string) => {
    const found = coordinator.createAgentTools().find((candidate) => candidate.name === name);
    assert.ok(found);
    return found;
  };
  return { workspaceRoot, command, recorder, events, coordinator, tool };
}

function boundedStreams(value: Record<string, any>): void {
  const bytes = Buffer.byteLength(value.stdout ?? "", "utf8") + Buffer.byteLength(value.stderr ?? "", "utf8");
  assert.ok(bytes <= shellOutputBudgetBytes, `stdout + stderr exceeded shared 12 KiB: ${bytes}`);
  assert.doesNotMatch(`${value.stdout ?? ""}${value.stderr ?? ""}`, /\uFFFD/u);
}
async function storedEvents(recorder: SessionRecorder): Promise<SessionEvent[]> {
  await recorder.flush();
  return (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

try {
  await test("production Bash still refuses unsupported Linux sandbox restrictions before shell capture", {
    skip: process.platform !== "linux"
  }, async () => {
    const f = await fixture("linux-sandbox-denial", undefined, true);
    const result = await f.tool("Bash").execute("linux-sandbox-denied", { command: f.command });
    assert.equal(result.isError, true);
    assert.match(record(result.details).error, /Cannot enforce command sandbox restrictions on linux; command was not started/u);
    assert.equal(record(result.details).stdoutBytes, 0);
    assert.equal(record(result.details).stderrBytes, 0);
  });

  await test("real Bash stdout and stderr share one coordinator model budget while UI and one archive retain the original", async () => {
    const f = await fixture("shell-full");
    const result = await f.tool("Bash").execute("shell-full-call", { command: f.command });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const model = record(result.details);
    boundedStreams(model);
    assert.equal(model.modelProjection, "shell_excerpt");
    for (const stream of ["stdout", "stderr"] as const) {
      assert.ok(model[stream].startsWith(`${stream.toUpperCase()}_HEAD`));
      assert.ok(model[stream].endsWith(`${stream.toUpperCase()}_TAIL`));
      assert.equal(model[`${stream}CaptureTruncated`], false);
      assert.equal(model[`${stream}CaptureOmittedBytes`], 0);
      assert.equal(model[`${stream}ProjectionTruncated`], true);
      assert.ok(model[`${stream}ProjectionOmittedBytes`] > 0);
      assert.equal(model[`${stream}TruncationDirection`], "head_and_tail");
      assert.equal(model[`${stream}RetainedBytes`], Buffer.byteLength(model[stream], "utf8"));
    }
    assert.equal(serializeToolResult(model).includes(secret), false);
    const completed = f.events.find((event) => event.type === "tool.completed" && event.toolCallId === "shell-full-call");
    assert.ok(completed?.type === "tool.completed");
    const original = record(completed.result);
    assert.equal(original.stdout, stdout, "UI event must retain exact captured stdout");
    assert.equal(original.stderr, stderr, "UI event must retain exact captured stderr");
    assert.equal(original.stdoutTruncated, false);
    assert.equal(original.stderrTruncated, false);
    assert.equal(original.modelProjection, undefined);
    assert.equal(original.archivePath, undefined);
    const expected = serializeToolResult(original);
    assert.equal(expected.includes(secret), false, "archive contract uses existing redaction");
    const archived = await readToolResultArchive(f.workspaceRoot, model.archivePath);
    assert.equal(archived.output, expected, "archive is exactly serializeToolResult(original), not an excerpt");
    assert.equal(JSON.parse(archived.output).stdout.includes("[redacted]"), true);
    const events = await storedEvents(f.recorder);
    const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "shell-full-call");
    assert.ok(persisted?.type === "tool_result");
    assert.equal(record(persisted.result).archivePath, model.archivePath);
    assert.equal(record(persisted.result).archived, true);
    assert.equal((await readdir(path.join(agentDir(f.workspaceRoot), "tool-results"))).length, 1,
      "projection and inline-persistence archiving must deduplicate the same execution");

    const reader = f.tool("read_tool_result");
    let rebuilt = "";
    let offset = 0;
    let pages = 0;
    for (;;) {
      const pageResult = await reader.execute(`page-${pages++}`, { archivePath: model.archivePath, offset, length: 1_007 });
      assert.equal(pageResult.isError, false);
      const page = pageResult.details as ReadToolResultResult;
      assert.equal(page.offset, offset);
      assert.equal(page.nextOffset, offset + page.content.length);
      assert.doesNotMatch(page.content, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
      rebuilt += page.content;
      offset = page.nextOffset;
      if (!page.hasMore) break;
      assert.ok(page.content.length > 0, "pagination must make progress");
      assert.ok(pages <= expected.length, "pagination must terminate");
    }
    assert.ok(pages > 2);
    assert.equal(rebuilt, expected);
    assert.equal(offset, expected.length);
    const replay = replaySessionEvents(events, { sessionId: f.recorder.sessionId });
    const projectedAgain = await projectToolResultsForModel(replay.messages);
    const resumed = projectedAgain.find((message): message is AgentToolResultMessage => message.role === "toolResult" && message.toolCallId === "shell-full-call");
    assert.ok(resumed);
    assert.equal(record(resumed.details).archivePath, model.archivePath);
  });

  await test("projection, turn-budget and persistence paths share one archive and explicit rereads still work", async () => {
    const f = await fixture("low-budget-archive", 256);
    const result = await f.tool("Bash").execute("low-budget-archive-call", { command: f.command });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const model = record(result.details);
    assert.equal(model.archived, true);
    assert.equal(typeof model.archivePath, "string");
    assert.ok(Buffer.byteLength(serializeToolResult(model)) < 4 * 1024);
    const completed = f.events.find((event) => event.type === "tool.completed" && event.toolCallId === "low-budget-archive-call");
    assert.ok(completed?.type === "tool.completed");
    const archived = await readToolResultArchive(f.workspaceRoot, model.archivePath);
    assert.equal(archived.output, serializeToolResult(completed.result));
    const events = await storedEvents(f.recorder);
    const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "low-budget-archive-call");
    assert.ok(persisted?.type === "tool_result");
    assert.equal(record(persisted.result).archivePath, model.archivePath);
    assert.equal((await readdir(path.join(agentDir(f.workspaceRoot), "tool-results"))).length, 1);
    const reread = await f.tool("read_tool_result").execute("low-budget-reread", { archivePath: model.archivePath, length: 16_000 });
    assert.equal(reread.isError, false);
    assert.equal(record(reread.details).content, archived.output.slice(0, record(reread.details).nextOffset));
    assert.ok(record(reread.details).content.length > 256, "explicit pages bypass the exhausted turn budget");
    assert.equal(record(reread.details).archived, undefined, "archive reads must not return another budget envelope");
  });

  await test("capture loss remains distinct from model-only omission and cannot be recovered from the archive", async () => {
    const f = await fixture("capture-loss");
    const captured = await runShellCommand(f.workspaceRoot, f.command, { captureFullOutput: true, maxCapturedOutputBytes: 20 * 1024 });
    assert.equal(captured.status, "completed");
    assert.equal(captured.stdoutTruncated, true);
    assert.equal(captured.stderrTruncated, true);
    assert.equal(captured.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(captured.stderrBytes, Buffer.byteLength(stderr));
    const original: RunCommandToolResult = { ...captured, background: false };
    const projected = record(await projectSingleToolResultForModel("Bash", { command: f.command }, original, {
      toolCallId: "capture-loss-call", sequence: 1,
      archiveResult: async ({ result, output }) => archiveToolResult({ workspaceRoot: f.workspaceRoot,
        sessionId: f.recorder.sessionId, toolCallId: "capture-loss-call", sequence: 1, tool: "Bash", result, output })
    }));
    boundedStreams(projected);
    for (const stream of ["stdout", "stderr"] as const) {
      assert.equal(projected[`${stream}CaptureTruncated`], true);
      assert.equal(projected[`${stream}CaptureOmittedBytes`], captured[`${stream}Bytes`] - captured[`${stream}RetainedBytes`]);
      assert.equal(projected[`${stream}ProjectionTruncated`], true);
      assert.ok(projected[`${stream}ProjectionOmittedBytes`] > 0);
    }
    assert.match(projected.summary, /cannot recover.*lost/u);
    const archived = await readToolResultArchive(f.workspaceRoot, projected.archivePath);
    assert.equal(archived.output, serializeToolResult(original));
    assert.equal(JSON.parse(archived.output).stdout, captured.stdout);
    assert.equal(archived.output.includes("STDOUT_HEAD"), false);
    assert.equal(archived.output.includes("STDOUT_TAIL"), true);
  });

  await test("low turn budget plus archive failure stays bounded and preserves a durable original on replay", async () => {
    const f = await fixture("archive-failure", 256);
    // A regular file where an archive directory belongs causes a real write failure,
    // even when this test is run as root. The recorder is already safely open.
    const archiveDirectory = path.join(agentDir(f.workspaceRoot), "tool-results");
    await rm(archiveDirectory, { recursive: true });
    await writeFile(archiveDirectory, "archive storage deliberately unavailable");
    const result = await f.tool("Bash").execute("archive-failure-call", { command: f.command });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const model = record(result.details);
    assert.equal(model.archived, false);
    assert.equal(model.archiveAvailable, false);
    assert.equal(model.archivePath, undefined);
    assert.equal(typeof model.archiveError, "string");
    assert.equal(model.result.archiveAvailable, false);
    assert.equal(model.result.archivePath, undefined);
    boundedStreams(model.result);
    assert.ok(Buffer.byteLength(serializeToolResult(model)) < 20 * 1024, "failure must not reinsert unbounded raw output");
    assert.match(model.summary, /read_tool_result is unavailable/u);
    assert.doesNotMatch(serializeToolResult(model), /full result archived/u);
    const completed = f.events.find((event) => event.type === "tool.completed" && event.toolCallId === "archive-failure-call");
    assert.ok(completed?.type === "tool.completed");
    assert.equal(record(completed.result).stdout, stdout);
    const events = await storedEvents(f.recorder);
    const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "archive-failure-call");
    assert.ok(persisted?.type === "tool_result");
    const durable = record(persisted.result);
    assert.equal(durable.archivePath, undefined);
    assert.equal(typeof durable.archiveError, "string");
    assert.equal(serializeToolResult(durable.result), serializeToolResult(completed.result), "failed persistence retains original redacted result");
    const replay = replaySessionEvents(events, { sessionId: f.recorder.sessionId });
    const projected = await projectToolResultsForModel(replay.messages, { archiveResult: async () => { throw new Error("archive still unavailable"); } });
    const resumed = projected.find((message): message is AgentToolResultMessage => message.role === "toolResult" && message.toolCallId === "archive-failure-call");
    assert.ok(resumed);
    boundedStreams(record(resumed.details));
    assert.equal(record(resumed.details).archivePath, undefined);
    assert.equal(record(resumed.details).archiveAvailable, false);
    assert.ok(record(resumed.details).stdout.startsWith("STDOUT_HEAD"), "replay must preserve bounded useful evidence");
    assert.ok(Buffer.byteLength(serializeToolResult(resumed.details)) < 20 * 1024);
    const again = await projectToolResultsForModel(projected);
    assert.deepEqual(again, projected, "replaying an excerpt must not reinterpret projection loss as capture loss");
  });
} finally {
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(suiteRoot, { recursive: true, force: true });
}
