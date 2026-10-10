/** A successful archive call must not remove its own reference in its pruning pass. */
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
import { archiveToolResult, readToolResultArchive, resolveToolResultArchivePath, pruneToolResultArchives } from "../src/session/toolResultArchive.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";
import { ToolRegistry } from "../src/tools/registry.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("reusing a valid old archive must not prune that same reference before returning it", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-archive-self-prune-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  const written = deferred();
  const release = deferred();
  let other: Promise<unknown> | undefined;
  try {
    const original = { workspaceRoot: root, sessionId: "retention", toolCallId: "old-valid-call", sequence: 1, tool: "fixture", result: "original result" };
    const first = await archiveToolResult(original);
    const oldPath = resolveToolResultArchivePath(root, first.archivePath);
    await fs.utimes(oldPath, new Date("2000-01-01"), new Date("2000-01-01"));
    // All entries are genuine archives, at the documented retention threshold.
    for (let index = 0; index < 511; index += 1) {
      await archiveToolResult({ ...original, toolCallId: `history-${String(index)}`, sequence: index + 2, result: `history ${String(index)}` });
    }
    assert.equal((await readToolResultArchive(root, first.archivePath)).output, "original result");
    const originalWrite = fs.writeFile;
    let held = false;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      await originalWrite(...args);
      if (!held && typeof args[0] === "string" && /tool-result-[a-f0-9]{64}\.json$/u.test(args[0])) {
        held = true;
        written.resolve();
        await release.promise;
      }
    });
    other = archiveToolResult({ ...original, toolCallId: "concurrent-new-call", sequence: 1000, result: "concurrent result" });
    await written.promise;
    const reused = await archiveToolResult(original);
    assert.equal(reused.archivePath, first.archivePath);
    const existsAfterReuse = await fs.stat(oldPath).then(() => true, () => false);
    assert.equal(existsAfterReuse, true, "the current archival operation must not delete its own successful result reference");
    assert.equal((await readToolResultArchive(root, reused.archivePath)).output, "original result");
  } finally {
    release.resolve();
    await other?.catch(() => undefined);
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clock-skewed older archive mtimes cannot cause a just-persisted public tool result to delete itself", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-archive-skew-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  let recorder: SessionRecorder | undefined;
  try {
    // Valid old archives can have mtimes ahead of the current clock after restore or clock correction.
    // Change only these synthetic file timestamps; never change the system clock.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 512; index += 1) {
      const history = await archiveToolResult({ workspaceRoot: root, sessionId: "history", toolCallId: `old-${String(index)}`, sequence: index + 1, tool: "fixture", result: `history ${String(index)}` });
      await fs.utimes(resolveToolResultArchivePath(root, history.archivePath), future, future);
    }
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    config.context.maxTurnToolResultBytes = 1024;
    config.checkpoints.enabled = false;
    const output = "new complete result " + "x".repeat(40000);
    const registry = new ToolRegistry();
    registry.registerBuiltinTool({ name: "large_fixture", description: "Return synthetic output", parameters: { type: "object", properties: {} }, schema: z.object({}), risk: "read", resolveExecution: () => ({ accesses: [], approvalRule: "large_fixture", execute: async () => ({ output }) }) });
    registry.registerBuiltinTool(createReadToolResultTool({ workspaceRoot: root, ignore: [] }));
    recorder = new SessionRecorder(root, "new-current-session");
    await recorder.recordAndFlush({ type: "user_message", content: "read new synthetic output" });
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    const tools = coordinator.createAgentTools();
    const immediate = await tools.find((tool) => tool.name === "large_fixture")!.execute("new-current-call", {});
    await coordinator.waitForIdle();
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    const stored = events.find((event) => event.type === "tool_result" && event.toolCallId === "new-current-call");
    assert.ok(stored?.type === "tool_result");
    const details = stored.result as Record<string, unknown>;
    assert.equal(immediate.isError, false);
    assert.equal(stored.executionStatus, "succeeded");
    assert.equal(details.archived, true);
    assert.equal(typeof details.archivePath, "string");
    const target = resolveToolResultArchivePath(root, String(details.archivePath));
    const exists = await fs.stat(target).then(() => true, () => false);
    const replayed = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.find((message) => message.role === "toolResult" && message.toolCallId === "new-current-call");
    assert.ok(replayed?.role === "toolResult");
    const reread = await tools.find((tool) => tool.name === "read_tool_result")!.execute("retrieve-current", { archivePath: details.archivePath });
    assert.equal(exists, true, "pruning must not delete the new archive that this successful tool result references");
    assert.equal(reread.isError, false);
    assert.equal(JSON.parse((await readToolResultArchive(root, String(details.archivePath))).output).output, output);
    assert.equal((await fs.readdir(path.dirname(target))).length, 512);
    assert.equal(JSON.stringify(replayed.details).includes(output), false, "durable history keeps its valid archive reference rather than inlining the full output");
  } finally {
    await recorder?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const archiveName = (index: number) => `tool-result-${index.toString(16).padStart(64, "0")}.json`;

async function pruningFixture(count: number, run: (root: string, directory: string, names: string[]) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-prune-current-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try {
    const created = await archiveToolResult({ workspaceRoot: root, sessionId: "setup", toolCallId: "setup", sequence: 1, tool: "fixture", result: "setup" });
    const target = resolveToolResultArchivePath(root, created.archivePath);
    const directory = path.dirname(target);
    await fs.rm(target);
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = archiveName(index);
      names.push(name);
      await fs.writeFile(path.join(directory, name), JSON.stringify({ version: 1, archivedAt: "2000-01-01T00:00:00.000Z", sessionId: "fixture", toolCallId: `fixture-${String(index)}`, sequence: index, tool: "fixture", output: `retained ${String(index)}` }));
      const stamp = new Date(1_000_000 + index * 1000);
      await fs.utimes(path.join(directory, name), stamp, stamp);
    }
    await run(root, directory, names);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const count of [0, 1, 513]) {
  test(`standalone pruning preserves the original behavior for ${String(count)} files`, async () => {
    await pruningFixture(count, async (root, directory, names) => {
      await pruneToolResultArchives(root);
      assert.deepEqual((await fs.readdir(directory)).sort(), names.slice(Math.max(0, count - 512)).sort());
    });
  });
}

for (const retain of [0, 1]) {
  test(`standalone explicit retain=${String(retain)} keeps its original semantics`, async () => {
    await pruningFixture(4, async (root, directory, names) => {
      await pruneToolResultArchives(root, retain);
      assert.deepEqual((await fs.readdir(directory)).sort(), names.slice(4 - retain).sort());
    });
  });
}

test("protected current archive consumes one existing slot and keeps its bytes, inode and modification time", async () => {
  await pruningFixture(513, async (root, directory, names) => {
    const protectedName = names[0]!;
    const target = path.join(directory, protectedName);
    const before = await fs.stat(target);
    const bytes = await fs.readFile(target);
    await pruneToolResultArchives(root, 512, protectedName);
    const after = await fs.stat(target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.deepEqual((await fs.readdir(directory)).sort(), [protectedName, ...names.slice(2)].sort());
    assert.equal((await fs.readdir(directory)).length, 512);
  });
});

test("an absent protected name does not consume a retention slot", async () => {
  await pruningFixture(513, async (root, directory, names) => {
    await pruneToolResultArchives(root, 512, archiveName(9999));
    assert.deepEqual((await fs.readdir(directory)).sort(), names.slice(1).sort());
    assert.equal((await fs.readdir(directory)).length, 512);
  });
});

test("equal mtimes preserve the original relative candidate ordering without refreshing timestamps", async () => {
  await pruningFixture(513, async (root, directory) => {
    const stamp = new Date("2000-01-01T00:00:00.000Z");
    for (const name of await fs.readdir(directory)) await fs.utimes(path.join(directory, name), stamp, stamp);
    const ordering = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const protectedName = ordering.at(-1)!;
    await pruneToolResultArchives(root, 512, protectedName);
    assert.deepEqual((await fs.readdir(directory)).sort(), [...ordering.slice(0, 511), protectedName].sort());
    for (const name of await fs.readdir(directory)) assert.equal((await fs.stat(path.join(directory, name))).mtimeMs, stamp.getTime());
  });
});

test("malformed names, directories and symlinks remain outside the pruning candidates", async () => {
  await pruningFixture(3, async (root, directory, names) => {
    await fs.writeFile(path.join(directory, "tool-result-invalid.json"), "malformed name");
    await fs.writeFile(path.join(directory, "unrelated.txt"), "unrelated");
    await fs.mkdir(path.join(directory, archiveName(40)));
    const linked = path.join(root, "linked-original.txt");
    await fs.writeFile(linked, "original");
    await fs.symlink(linked, path.join(directory, archiveName(41)));
    // JSON validity is not part of the existing name/stat-based pruning policy.
    await fs.writeFile(path.join(directory, names[0]!), "{");
    await fs.utimes(path.join(directory, names[0]!), new Date(0), new Date(0));
    await pruneToolResultArchives(root, 1, names[2]!);
    const remaining = await fs.readdir(directory);
    assert.equal(remaining.length, 5);
    assert.ok(remaining.includes(names[2]!));
    assert.equal(remaining.includes(names[0]!), false);
    assert.equal(remaining.includes(names[1]!), false);
    assert.equal((await fs.lstat(path.join(directory, archiveName(41)))).isSymbolicLink(), true);
    assert.equal(await fs.readFile(linked, "utf8"), "original");
  });
});

test("protection applies to this pass only; later ordinary retention may expire the reference", async () => {
  await pruningFixture(3, async (root, directory, names) => {
    await pruneToolResultArchives(root, 2, names[0]!);
    assert.deepEqual((await fs.readdir(directory)).sort(), [names[0], names[2]].sort());
    const latest = archiveName(3);
    await fs.writeFile(path.join(directory, latest), "latest ordinary candidate");
    await pruneToolResultArchives(root, 2);
    assert.deepEqual((await fs.readdir(directory)).sort(), [names[2], latest].sort());
  });
});
