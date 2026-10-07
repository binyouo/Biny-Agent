import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage } from "../src/agent/core/types.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readToolResultArchive } from "../src/session/toolResultArchive.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createSearchFilesTool } from "../src/tools/search/searchFiles.js";

const permissionSkip = process.platform === "win32" || process.getuid?.() === 0
  ? "Requires POSIX file read permissions enforced for a non-root process"
  : false;

async function fixture(run: (root: string, blocked: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-grep-unreadable-")));
  const root = path.join(directory, "workspace");
  const blocked = path.join(root, "a-unreadable.txt");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(directory, "agent");
  try {
    await mkdir(root);
    await ensureAgentDirs(root);
    await writeFile(blocked, "needle hidden\n", { mode: 0o600 });
    await run(root, blocked);
  } finally {
    await chmod(blocked, 0o600);
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}

async function blockFile(file: string): Promise<void> {
  await chmod(file, 0o000);
  await assert.rejects(readFile(file), { code: "EACCES" }, "the actual process must be unable to read the fixture");
}

function setup(root: string, ignore: string[] = []) {
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.checkpoints.enabled = false;
  const registry = new ToolRegistry();
  const context = { workspaceRoot: root, ignore };
  registry.registerBuiltinTool(createSearchFilesTool(context));
  registry.registerBuiltinTool(createReadToolResultTool(context));
  const recorder = new SessionRecorder(root);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), () => undefined);
  return { recorder, tools: coordinator.createAgentTools() };
}

async function eventsFor(recorder: SessionRecorder): Promise<SessionEvent[]> {
  await recorder.flush();
  return (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
}

function modelValue(messages: AgentMessage[]): Record<string, unknown> {
  const message = toModelMessages(messages).find((entry) => entry.role === "tool");
  assert.ok(message?.role === "tool");
  const part = message.content[0];
  assert.ok(part?.type === "tool-result" && part.output.type === "text");
  return JSON.parse(part.output.value) as Record<string, unknown>;
}

test("Grep file and directory warnings both survive oversized persistence, replay and archive retrieval without exposing secrets", { skip: permissionSkip }, async () => {
  await fixture(async (root, blocked) => {
    await blockFile(blocked);
    const syntheticSecret = "sk-fixture-only-never-a-real-credential";
    const content = Array.from({ length: 50 }, (_, index) => `needle ${index} ${syntheticSecret} ${"x".repeat(1000)}`).join("\n");
    await writeFile(path.join(root, "z-long.txt"), content);
    const blockedDirectory = path.join(root, "blocked-directory");
    await mkdir(blockedDirectory);
    await writeFile(path.join(blockedDirectory, "hidden.txt"), "needle hidden directory\n");
    await chmod(blockedDirectory, 0o100);
    const { recorder, tools } = setup(root);
    try {
      const searchArgs = { query: "needle" };
      const immediate = await tools.find((tool) => tool.name === "Grep")!.execute("search", searchArgs);
      assert.equal(immediate.isError, false);
      const immediateModel = modelValue([
        { role: "assistant", content: [{ type: "toolCall", id: "search", name: "Grep", arguments: searchArgs }] },
        { ...immediate, role: "toolResult", toolCallId: "search", toolName: "Grep" }
      ]);
      assert.equal(immediateModel.matchesTruncated, true, "exercise the actual search projection");
      const events = await eventsFor(recorder);
      assert.equal(events.filter((event) => event.type === "tool_call").length, 1);
      assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
      const event = events.find((entry) => entry.type === "tool_result");
      assert.ok(event?.type === "tool_result");
      assert.equal(event.executionStatus, "succeeded");
      assert.equal(event.toolCallId, "search");
      assert.equal(event.tool, "Grep");
      const persisted = event.result as { archived: boolean; archivePath: string; preview: string; resultBytes: number };
      assert.equal(persisted.archived, true);
      assert.ok(persisted.resultBytes > 32 * 1024, "cross the real inline-persistence boundary");
      const archive = await readToolResultArchive(root, persisted.archivePath);
      const raw = JSON.parse(archive.output) as Record<string, unknown>;
      assert.equal((raw.matches as unknown[]).length, 50);
      const replay = replaySessionEvents(events, { sessionId: recorder.sessionId });
      const replayModel = modelValue(replay.messages);
      assert.equal(replayModel.archivePath, persisted.archivePath);
      const args = { archivePath: persisted.archivePath, length: 200_000 };
      const reread = await tools.find((tool) => tool.name === "read_tool_result")!.execute("reread", args);
      assert.equal(reread.isError, false);
      const page = modelValue([
        { role: "assistant", content: [{ type: "toolCall", id: "reread", name: "read_tool_result", arguments: args }] },
        { ...reread, role: "toolResult", toolCallId: "reread", toolName: "read_tool_result" }
      ]);
      assert.equal(page.hasMore, false);
      const recovered = JSON.parse(String(page.content)) as Record<string, unknown>;
      for (const value of [archive.output, JSON.stringify(events), JSON.stringify(immediateModel), JSON.stringify(replayModel), String(page.content)]) {
        assert.ok(!value.includes(syntheticSecret), "all persisted and model-visible forms must still redact secret-like text");
        assert.match(value, /\[redacted\]/u);
      }
      assert.deepEqual({
        immediate: (immediate.details as Record<string, unknown>).unreadableFiles,
        projected: immediateModel.unreadableFiles,
        archive: raw.unreadableFiles,
        retrieved: recovered.unreadableFiles
      }, {
        immediate: ["a-unreadable.txt"], projected: ["a-unreadable.txt"],
        archive: ["a-unreadable.txt"], retrieved: ["a-unreadable.txt"]
      }, "the named warning must survive object and serialized-text boundaries");
      assert.deepEqual({
        immediate: (immediate.details as Record<string, unknown>).unreadableDirectories,
        projected: immediateModel.unreadableDirectories,
        archive: raw.unreadableDirectories,
        retrieved: recovered.unreadableDirectories
      }, {
        immediate: ["blocked-directory"], projected: ["blocked-directory"],
        archive: ["blocked-directory"], retrieved: ["blocked-directory"]
      }, "adding file diagnostics must not drop directory traversal evidence");
      assert.match(persisted.preview, /"unreadableDirectories":\["blocked-directory"\]/u);
      assert.match(persisted.preview, /"unreadableFiles":\["a-unreadable.txt"\]/u);
      assert.match(String(replayModel.preview), /"unreadableFiles":\["a-unreadable.txt"\]/u);
      assert.equal(Object.hasOwn(raw, "skippedFiles"), false, "new results have one output field, without an old-name alias");
      assert.equal(await readFile(path.join(root, "z-long.txt"), "utf8"), content);
    } finally {
      await chmod(blockedDirectory, 0o700);
      await recorder.close();
    }
  });
});

test("inline Grep keeps unreadable-file evidence for empty and paginated results until a successful rescan", { skip: permissionSkip }, async () => {
  await fixture(async (root, blocked) => {
    await blockFile(blocked);
    const { recorder, tools } = setup(root);
    try {
      const search = tools.find((tool) => tool.name === "Grep")!;
      for (const [id, offset, expectedLines, hasMore] of [
        ["empty", 0, [], false], ["first", 0, [1], true], ["last", 1, [2], false]
      ] as const) {
        if (id === "first") await writeFile(path.join(root, "z-readable.txt"), "needle first\nneedle last\n");
        const args = { query: "needle", limit: 1, offset };
        const result = await search.execute(id, args);
        assert.equal(result.isError, false);
        const events = await eventsFor(recorder);
        const event = events.find((entry) => entry.type === "tool_result" && entry.toolCallId === id);
        assert.ok(event?.type === "tool_result");
        const stored = event.result as Record<string, unknown>;
        assert.equal(stored.archived, undefined, "small results must stay inline");
        const replayed = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.find((entry) => entry.role === "toolResult" && entry.toolCallId === id);
        assert.ok(replayed?.role === "toolResult");
        const call: AgentMessage = { role: "assistant", content: [{ type: "toolCall", id, name: "Grep", arguments: args }] };
        for (const value of [stored,
          modelValue([call, { ...result, role: "toolResult", toolCallId: id, toolName: "Grep" }]),
          modelValue([call, replayed])]) {
          assert.deepEqual(value.unreadableFiles, ["a-unreadable.txt"]);
          assert.equal(Object.hasOwn(value, "skippedFiles"), false);
          assert.deepEqual((value.matches as Array<{ line: number }>).map((match) => match.line), expectedLines);
          assert.equal(value.hasMore, hasMore);
          assert.equal(value.nextOffset, hasMore ? 1 : undefined);
        }
      }
      await chmod(blocked, 0o600);
      const recovered = await search.execute("recovered", { query: "needle", limit: 10 });
      const value = recovered.details as Record<string, unknown>;
      assert.equal(recovered.isError, false);
      assert.equal(value.unreadableFiles, undefined);
      assert.deepEqual((value.matches as Array<{ path: string }>).map((match) => match.path), ["a-unreadable.txt", "z-readable.txt", "z-readable.txt"]);
      assert.equal(value.hasMore, false);
    } finally { await recorder.close(); }
  });
});

for (const large of [false, true]) {
  test(`Grep with fully readable files has no warning in ${large ? "archived" : "inline"} results and replay`, async () => {
    await fixture(async (root) => {
      if (large) await writeFile(path.join(root, "z-long.txt"), Array.from({ length: 40 }, (_, index) => `needle ${index} ${"x".repeat(1000)}`).join("\n"));
      const { recorder, tools } = setup(root);
      try {
        const args = { query: "needle" };
        const result = await tools.find((tool) => tool.name === "Grep")!.execute("readable", args);
        assert.equal(result.isError, false);
        const events = await eventsFor(recorder);
        const event = events.find((entry) => entry.type === "tool_result");
        assert.ok(event?.type === "tool_result");
        const stored = event.result as Record<string, unknown>;
        assert.equal(stored.archived, large ? true : undefined);
        const values = [stored, modelValue([
          { role: "assistant", content: [{ type: "toolCall", id: "readable", name: "Grep", arguments: args }] },
          { ...result, role: "toolResult", toolCallId: "readable", toolName: "Grep" }
        ]), modelValue(replaySessionEvents(events, { sessionId: recorder.sessionId }).messages)];
        if (large) {
          const readArgs = { archivePath: String(stored.archivePath), length: 200_000 };
          const read = await tools.find((tool) => tool.name === "read_tool_result")!.execute("readable-reread", readArgs);
          assert.equal(read.isError, false);
          const page = modelValue([
            { role: "assistant", content: [{ type: "toolCall", id: "readable-reread", name: "read_tool_result", arguments: readArgs }] },
            { ...read, role: "toolResult", toolCallId: "readable-reread", toolName: "read_tool_result" }
          ]);
          assert.equal(page.hasMore, false);
          const raw = JSON.parse(String(page.content)) as Record<string, unknown>;
          assert.equal((raw.matches as unknown[]).length, 41);
          values.push(raw);
        } else assert.equal((stored.matches as unknown[]).length, 1);
        for (const value of values) {
          assert.equal(value.unreadableFiles, undefined);
          assert.equal(value.skippedFiles, undefined);
          assert.doesNotMatch(JSON.stringify(value), /unreadableFiles|skippedFiles/u);
        }
      } finally { await recorder.close(); }
    });
  });
}

test("Grep does not report ignored or out-of-scope unreadable files", { skip: permissionSkip }, async () => {
  await fixture(async (root, blocked) => {
    await blockFile(blocked);
    await mkdir(path.join(root, "visible"));
    await writeFile(path.join(root, "visible", "readable.txt"), "needle visible\n");
    for (const item of [
      { args: { query: "needle" }, ignore: ["a-unreadable.txt"] },
      { args: { query: "needle", path: "visible" }, ignore: [] },
      { args: { query: "needle", glob: "visible/**/*.txt" }, ignore: [] }
    ]) {
      const { recorder, tools } = setup(root, item.ignore);
      try {
        const result = await tools.find((tool) => tool.name === "Grep")!.execute("scoped", item.args);
        assert.equal(result.isError, false);
        const events = await eventsFor(recorder);
        const value = modelValue(replaySessionEvents(events, { sessionId: recorder.sessionId }).messages);
        assert.equal(value.unreadableFiles, undefined);
        assert.deepEqual((value.matches as Array<{ path: string }>).map((match) => match.path), ["visible/readable.txt"]);
        assert.doesNotMatch(JSON.stringify(value), /a-unreadable/u);
      } finally { await recorder.close(); }
    }
  });
});
