/** Existing deterministic archive names must never stand in for unverified bytes. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { archiveToolResult, readToolResultArchive, resolveToolResultArchivePath, type ArchiveToolResultOptions } from "../src/session/toolResultArchive.js";
import { maxSessionEventLineBytes } from "../src/session/limits.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";

for (const outputSize of [40_000, maxSessionEventLineBytes + 1024]) {
test(`partial archive retry preserves evidence or explicitly fails oversized persistence (${String(outputSize)} bytes)`, async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-partial-archive-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(directory, "agent-state");
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    config.context.maxTurnToolResultBytes = 1024;
    config.checkpoints.enabled = false;
    const registry = new ToolRegistry();
    const completeOutput = "complete-result-" + "x".repeat(outputSize);
    registry.registerBuiltinTool({
      name: "large_fixture", description: "Return synthetic large text", parameters: { type: "object", properties: {} }, schema: z.object({}), risk: "read",
      resolveExecution: () => ({ accesses: [], approvalRule: "large_fixture", execute: async () => ({ output: completeOutput }) })
    });
    registry.registerBuiltinTool(createReadToolResultTool({ workspaceRoot: root, ignore: [] }));
    recorder = new SessionRecorder(root, "partial-archive");
    await recorder.recordAndFlush({ type: "user_message", content: "read synthetic result" });
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    const originalWrite = fs.writeFile;
    let archiveAttempts = 0;
    let partialPath: string | undefined;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (typeof args[0] === "string" && /tool-result-[a-f0-9]{64}\.json$/u.test(args[0])) {
        archiveAttempts += 1;
        if (!partialPath) {
          partialPath = args[0];
          assert.equal(typeof args[1], "string");
          await originalWrite(args[0], String(args[1]).slice(0, 40), args[2]);
          throw Object.assign(new Error("synthetic partial-write EIO"), { code: "EIO" });
        }
      }
      return originalWrite(...args);
    });
    const tools = coordinator.createAgentTools();
    const execution = tools.find((tool) => tool.name === "large_fixture")!.execute("large-call", {});
    if (outputSize > maxSessionEventLineBytes) {
      await assert.rejects(execution, /Session event exceeds the maximum size/u);
      await coordinator.waitForIdle();
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      assert.equal(archiveAttempts, 2);
      assert.equal(events.some((event) => event.type === "tool_result" && event.toolCallId === "large-call"), false, "a failed persistence attempt must not store a false archive reference");
      assert.ok(partialPath);
      assert.equal((await fs.stat(partialPath)).size, 40);
      return;
    }
    const immediate = await execution;
    await coordinator.waitForIdle();
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "large-call");
    assert.ok(persisted?.type === "tool_result");
    const stored = persisted.result as Record<string, unknown>;
    assert.equal(archiveAttempts, 2, "model budget and persistence use the same deterministic archive name");
    assert.ok(partialPath);
    assert.equal(immediate.isError, false);
    assert.equal(JSON.stringify(immediate.details).includes(completeOutput), true, "initial failure fallback still keeps output in memory");
    const replay = replaySessionEvents(events, { sessionId: recorder.sessionId });
    const replayed = replay.messages.find((message) => message.role === "toolResult" && message.toolCallId === "large-call");
    assert.ok(replayed?.role === "toolResult");
    const reread = typeof stored.archivePath === "string" ? await tools.find((tool) => tool.name === "read_tool_result")!.execute("reread", { archivePath: stored.archivePath }) : undefined;
    assert.equal((await fs.stat(partialPath)).size, 40, "existing partial bytes are retained untouched");
    assert.equal(JSON.stringify(replayed.details).includes(completeOutput), true, "fallback must preserve full output across replay");
    assert.equal(reread, undefined, "a known-invalid archive must not be returned as available");
    if (stored.archived === true && typeof stored.archivePath === "string") {
      const archive = await readToolResultArchive(root, stored.archivePath);
      assert.equal(JSON.parse(archive.output).output, completeOutput);
    } else {
      assert.equal(JSON.stringify(stored).includes(completeOutput), true, "failed archival must persist the recoverable full result");
    }
  } finally {
    await recorder?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

}

async function archiveFixture(run: (options: ArchiveToolResultOptions, archivePath: string, target: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-existing-archive-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try {
    const options: ArchiveToolResultOptions = { workspaceRoot: root, sessionId: "existing-session", toolCallId: "existing-call", sequence: 1, tool: "fixture", result: { text: "complete original 😀" } };
    const archive = await archiveToolResult(options);
    await run(options, archive.archivePath, resolveToolResultArchivePath(root, archive.archivePath));
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const invalid of ["", "{\"version\":", "[]", "{\"tool\":\"fixture\",\"archivedAt\":\"date\"}"]) {
  test(`reject incomplete/malformed existing archive ${JSON.stringify(invalid)}`, async () => {
    await archiveFixture(async (options, _reference, target) => {
      await fs.writeFile(target, invalid);
      await assert.rejects(archiveToolResult(options));
      assert.equal(await fs.readFile(target, "utf8"), invalid, "invalid existing bytes are never removed or overwritten");
    });
  });
}

for (const [field, value] of [
  ["version", 2], ["sessionId", "another-session"], ["toolCallId", "another-call"], ["sequence", 2], ["tool", "another-tool"], ["output", "another payload"]
] as const) {
  test(`reject same-name existing archive with mismatched ${field}`, async () => {
    await archiveFixture(async (options, _reference, target) => {
      const envelope = JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
      envelope[field] = value;
      const bytes = JSON.stringify(envelope) + "\n";
      await fs.writeFile(target, bytes);
      await assert.rejects(archiveToolResult(options), /does not match the requested call and output/u);
      assert.equal(await fs.readFile(target, "utf8"), bytes);
    });
  });
}

test("valid immutable retry accepts its original archival timestamp without rewriting", async () => {
  await archiveFixture(async (options, reference, target) => {
    const envelope = JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
    envelope.archivedAt = "2001-01-01T00:00:00.000Z";
    const bytes = JSON.stringify(envelope) + "\n";
    await fs.writeFile(target, bytes);
    const before = await fs.stat(target);
    const reused = await archiveToolResult(options);
    const after = await fs.stat(target);
    assert.equal(reused.archivePath, reference);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await fs.readFile(target, "utf8"), bytes);
    assert.equal((await readToolResultArchive(options.workspaceRoot, reused.archivePath)).output, envelope.output);
  });
});

test("existing archive reuse retains the reader's 64 MiB size rejection", async () => {
  await archiveFixture(async (options, _reference, target) => {
    const oversized = 64 * 1024 * 1024 + 1;
    await fs.truncate(target, oversized);
    await assert.rejects(archiveToolResult(options), /exceeding.*read limit/u);
    assert.equal((await fs.stat(target)).size, oversized);
  });
});

test("existing symlink and non-regular archive targets are rejected without replacement", async () => {
  await archiveFixture(async (options, _reference, target) => {
    const preserved = path.join(options.workspaceRoot, "preserved.txt");
    await fs.writeFile(preserved, "unrelated synthetic content");
    await fs.rm(target);
    await fs.symlink(preserved, target);
    await assert.rejects(archiveToolResult(options));
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(preserved, "utf8"), "unrelated synthetic content");
    await fs.rm(target);
    await fs.mkdir(target);
    await assert.rejects(archiveToolResult(options), /not a regular file/u);
    assert.equal((await fs.lstat(target)).isDirectory(), true);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a concurrent partial creation is rejected until its writer finishes and then valid reuse succeeds", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-concurrent-archive-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  const ready = deferred();
  const release = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    const options: ArchiveToolResultOptions = { workspaceRoot: root, sessionId: "concurrent", toolCallId: "same-call", sequence: 1, tool: "fixture", result: "complete content" };
    const originalWrite = fs.writeFile;
    let held = false;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (!held && typeof args[0] === "string" && /tool-result-[a-f0-9]{64}\.json$/u.test(args[0])) {
        held = true;
        assert.equal(typeof args[1], "string");
        const content = String(args[1]);
        const handle = await fs.open(args[0], "wx", 0o600);
        try {
          await handle.write(content.slice(0, 40));
          ready.resolve();
          await release.promise;
          await handle.write(content.slice(40));
        } finally { await handle.close(); }
        return;
      }
      return originalWrite(...args);
    });
    pending = archiveToolResult(options);
    await ready.promise;
    try { await assert.rejects(archiveToolResult(options), /JSON|Unterminated|Unexpected/u); }
    finally { release.resolve(); await pending; }
    const reused = await archiveToolResult(options);
    assert.equal((await readToolResultArchive(root, reused.archivePath)).output, "complete content");
  } finally {
    release.resolve();
    await pending?.catch(() => undefined);
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
