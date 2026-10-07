import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { readToolResultArchive } from "../src/session/toolResultArchive.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createListFilesTool } from "../src/tools/file/listFiles.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createSearchFilesTool } from "../src/tools/search/searchFiles.js";

type SearchToolName = "Glob" | "Grep";
const permissionSkip = process.platform === "win32" || process.getuid?.() === 0
  ? "Requires POSIX directory read permissions enforced for a non-root process"
  : false;

async function fixture(run: (root: string, unreadable: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-search-completeness-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const root = path.join(directory, "workspace");
  const unreadable = path.join(root, "blocked");
  process.env.BINY_AGENT_DIR = path.join(directory, "agent");
  try {
    await mkdir(unreadable, { recursive: true });
    await writeFile(path.join(unreadable, "hidden.txt"), "needle hidden\n");
    await ensureAgentDirs(root);
    await chmod(unreadable, 0o100);
    await assert.rejects(readdir(unreadable), { code: "EACCES" }, "the actual filesystem must deny directory enumeration");
    await run(root, unreadable);
  } finally {
    await chmod(unreadable, 0o700);
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}

async function invoke(root: string, name: SearchToolName, args: Record<string, unknown>, options: { ignore?: string[]; signal?: AbortSignal } = {}) {
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.checkpoints.enabled = false;
  const registry = new ToolRegistry();
  const context = { workspaceRoot: root, ignore: options.ignore ?? [] };
  registry.registerBuiltinTool(createListFilesTool(context));
  registry.registerBuiltinTool(createSearchFilesTool(context));
  const recorder = new SessionRecorder(root);
  try {
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
      new PermissionManager(config.permission), () => undefined);
    const result = await coordinator.createAgentTools().find((tool) => tool.name === name)!.execute("search", args, options.signal);
    await recorder.flush();
    const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
    const calls = events.filter((event) => event.type === "tool_call");
    const results = events.filter((event) => event.type === "tool_result");
    assert.equal(calls.length, 1);
    assert.equal(results.length, 1);
    assert.equal(calls[0]?.toolCallId, "search");
    assert.equal(results[0]?.toolCallId, "search");
    assert.equal(results[0]?.tool, name);
    assert.ok(results[0]?.operationId);
    const model = toModelMessages([{ role: "assistant", content: [{ type: "toolCall", id: "search", name, arguments: args }] },
      { ...result, role: "toolResult", toolCallId: "search", toolName: name }]);
    const modelMessage = model.find((message) => message.role === "tool");
    assert.ok(modelMessage && modelMessage.role === "tool");
    const part = modelMessage.content[0];
    assert.ok(part?.type === "tool-result" && (part.output.type === "text" || part.output.type === "error-text"));
    assert.equal(part.output.type, result.isError ? "error-text" : "text");
    const modelResult = part.output.type === "text" ? JSON.parse(part.output.value) as Record<string, unknown> : { error: part.output.value };
    return { model: modelResult, result,
      persisted: results[0]!, replay: replaySessionEvents(events, { sessionId: recorder.sessionId }) };
  } finally {
    await recorder.close();
  }
}

for (const name of ["Glob", "Grep"] as const) {
  test(`${name} exposes an unreadable subtree instead of an exhaustive empty result`, { skip: permissionSkip }, async () => {
    await fixture(async (root, unreadable) => {
      const args = name === "Grep" ? { query: "needle" } : { pattern: "**/*.txt" };
      const { model, result, persisted, replay } = await invoke(root, name, args);
      assert.equal(result.isError, false, "readable partial results use the existing successful-result contract");
      assert.deepEqual(model[name === "Grep" ? "matches" : "files"], []);
      assert.equal(model.hasMore, false);
      assert.deepEqual(model.unreadableDirectories, ["blocked"], "zero discovered matches must retain the failed traversal boundary");
      assert.deepEqual((persisted.result as Record<string, unknown>).unreadableDirectories, ["blocked"]);
      const replayed = replay.messages.find((message) => message.role === "toolResult");
      assert.ok(replayed && replayed.role === "toolResult");
      assert.deepEqual((replayed.details as Record<string, unknown>).unreadableDirectories, ["blocked"]);
      await chmod(unreadable, 0o700);
      assert.equal(await readFile(path.join(unreadable, "hidden.txt"), "utf8"), "needle hidden\n");
    });
  });
}

test("Grep keeps failed traversal evidence when long readable matches are projected for the model", { skip: permissionSkip }, async () => {
  await fixture(async (root) => {
    const content = Array.from({ length: 20 }, (_, index) => `needle ${index} ${"x".repeat(900)}`).join("\n");
    await writeFile(path.join(root, "readable.txt"), content);
    const { model, result, persisted } = await invoke(root, "Grep", { query: "needle" });
    assert.equal(result.isError, false);
    assert.equal(model.matchCount, 20);
    assert.equal(model.matchesTruncated, true, "the real model projection must have shortened the readable results");
    assert.equal((model.matches as unknown[]).length > 0, true);
    assert.deepEqual(model.unreadableDirectories, ["blocked"], "projection must not turn partial discovery into apparently complete results");
    assert.deepEqual((persisted.result as Record<string, unknown>).unreadableDirectories, ["blocked"]);
    assert.equal(await readFile(path.join(root, "readable.txt"), "utf8"), content);
  });
});

for (const name of ["Glob", "Grep"] as const) {
  test(`${name} retains readable pagination and only becomes complete after a successful rescan`, { skip: permissionSkip }, async () => {
    await fixture(async (root, unreadable) => {
      await writeFile(path.join(root, "a.txt"), "needle first\n");
      await writeFile(path.join(root, "c.txt"), "needle last\n");
      const args = name === "Grep" ? { query: "needle", limit: 1 } : { pattern: "**/*.txt", limit: 1 };
      const first = await invoke(root, name, args);
      assert.equal(first.result.isError, false);
      assert.equal(first.persisted.executionStatus, "succeeded");
      assert.deepEqual(first.model.unreadableDirectories, ["blocked"]);
      assert.equal(first.model.hasMore, true);
      const paths = (value: Record<string, unknown>) => name === "Glob" ? value.files : (value.matches as Array<{ path: string }>).map((match) => match.path);
      assert.deepEqual(paths(first.model), ["a.txt"]);
      const next = name === "Grep" ? { offset: first.model.nextOffset } : { cursor: first.model.nextCursor };
      assert.deepEqual(next, name === "Grep" ? { offset: 1 } : { cursor: "a.txt" });
      const last = await invoke(root, name, { ...args, ...next });
      assert.deepEqual(paths(last.model), ["c.txt"]);
      assert.equal(last.model.hasMore, false);
      assert.deepEqual(last.model.unreadableDirectories, ["blocked"]);
      await chmod(unreadable, 0o700);
      const recovered = await invoke(root, name, { ...args, limit: 10 });
      assert.equal(recovered.result.isError, false);
      assert.deepEqual(paths(recovered.model), ["a.txt", "blocked/hidden.txt", "c.txt"]);
      assert.equal(recovered.model.hasMore, false);
      assert.equal(recovered.model.unreadableDirectories, undefined);
    });
  });

  test(`${name} does not expose ignored or out-of-scope traversal failures`, { skip: permissionSkip }, async () => {
    await fixture(async (root) => {
      await mkdir(path.join(root, "scope"));
      await writeFile(path.join(root, "scope/readable.txt"), "needle visible\n");
      const args = name === "Grep" ? { query: "needle" } : { pattern: "**/*.txt" };
      for (const result of [await invoke(root, name, args, { ignore: ["blocked"] }), await invoke(root, name, { ...args, path: "scope" })]) {
        assert.equal(result.result.isError, false);
        assert.equal(result.model.unreadableDirectories, undefined);
        assert.doesNotMatch(JSON.stringify(result.model), /blocked/u);
        assert.doesNotMatch(JSON.stringify(result.persisted.result), /blocked/u);
      }
    });
  });

  test(`${name} reports root enumeration failure using a workspace-relative marker`, { skip: permissionSkip }, async () => {
    await fixture(async (root) => {
      await chmod(root, 0o100);
      try {
        await assert.rejects(readdir(root), { code: "EACCES" });
        const args = name === "Grep" ? { query: "needle" } : {};
        const { model, result } = await invoke(root, name, args);
        assert.equal(result.isError, false);
        assert.deepEqual(model.unreadableDirectories, ["."]);
        assert.doesNotMatch(JSON.stringify(model), new RegExp(root, "u"));
      } finally {
        await chmod(root, 0o700);
      }
    });
  });
}

for (const name of ["Glob", "Grep"] as const) {
  test(`${name} preserves unreadable ancestor evidence for a deeper path scope`, { skip: permissionSkip }, async () => {
    await fixture(async (root, unreadable) => {
      await chmod(unreadable, 0o700);
      await mkdir(path.join(unreadable, "nested"));
      await writeFile(path.join(unreadable, "nested/match.txt"), "needle nested\n");
      await chmod(unreadable, 0o100);
      const args = name === "Grep" ? { query: "needle", mode: "regex", path: "blocked/nested" } : { path: "blocked/nested" };
      const { model, result } = await invoke(root, name, args);
      assert.equal(result.isError, false);
      assert.deepEqual(model.unreadableDirectories, ["blocked"]);
      assert.deepEqual(model[name === "Grep" ? "matches" : "files"], []);
    });
  });

  test(`${name} preserves cancellation during a failed read rather than returning a partial success`, { skip: permissionSkip }, async () => {
    await fixture(async (root, unreadable) => {
      const args = name === "Grep" ? { query: "needle" } : {};
      const controller = new AbortController();
      const reason = new Error("cancel unreadable search");
      const original = fs.readdir;
      let failedReads = 0;
      fs.readdir = (async (...params: Parameters<typeof fs.readdir>) => {
        try { return await original(...params); }
        catch (error) {
          if (String(params[0]) === unreadable) {
            assert.equal((error as NodeJS.ErrnoException).code, "EACCES");
            failedReads += 1;
            controller.abort(reason);
          }
          throw error;
        }
      }) as typeof fs.readdir;
      try {
        const cancelled = await invoke(root, name, args, { signal: controller.signal });
        assert.equal(failedReads, 1, "cancel precisely after a real failed directory read");
        assert.equal(cancelled.result.isError, true);
        assert.equal(cancelled.persisted.executionStatus, "cancelled");
        assert.equal(cancelled.model.unreadableDirectories, undefined);
      } finally {
        fs.readdir = original;
      }
    });
  });
}


for (const name of ["Glob", "Grep"] as const) {
  test(`${name} directory warnings survive oversized persistence, replay and model-visible archive retrieval`, { skip: permissionSkip }, async () => {
    await fixture(async (root) => {
      if (name === "Grep") {
        await writeFile(path.join(root, "long.txt"), Array.from({ length: 50 }, (_, index) => `needle ${index} ${"x".repeat(1000)}`).join("\n"));
      } else {
        await Promise.all(Array.from({ length: 400 }, (_, index) => writeFile(path.join(root, `file-${String(index).padStart(3, "0")}-${"x".repeat(100)}.txt`), "fixture\n")));
      }
      const config = structuredClone(defaultConfig);
      config.permission.mode = "full-access";
      config.checkpoints.enabled = false;
      const registry = new ToolRegistry();
      registry.registerBuiltinTool(createSearchFilesTool({ workspaceRoot: root, ignore: [] }));
      registry.registerBuiltinTool(createListFilesTool({ workspaceRoot: root, ignore: [] }));
      registry.registerBuiltinTool(createReadToolResultTool({ workspaceRoot: root, ignore: [] }));
      const recorder = new SessionRecorder(root);
      try {
        const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
          new PermissionManager(config.permission), () => undefined);
        const tools = coordinator.createAgentTools();
        const searchArgs = name === "Grep" ? { query: "needle" } : { limit: 1_000 };
        const output = await tools.find((tool) => tool.name === name)!.execute("archive-search", searchArgs);
        assert.equal(output.isError, false);
        assert.deepEqual((output.details as Record<string, unknown>).unreadableDirectories, ["blocked"]);
        await recorder.flush();
        const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
        const event = events.find((entry) => entry.type === "tool_result");
        assert.ok(event?.type === "tool_result");
        assert.equal(event.executionStatus, "succeeded");
        const persisted = event.result as { archived: boolean; archivePath: string; preview: string };
        assert.equal(persisted.archived, true, "exercise the real 32 KiB inline-persistence boundary");
        const raw = JSON.parse((await readToolResultArchive(root, persisted.archivePath)).output) as Record<string, unknown>;
        assert.deepEqual(raw.unreadableDirectories, ["blocked"]);
        assert.equal((raw[name === "Grep" ? "matches" : "files"] as unknown[]).length, name === "Grep" ? 50 : 400);
        const replayed = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.find((message) => message.role === "toolResult");
        assert.ok(replayed?.role === "toolResult");
        assert.equal((replayed.details as Record<string, unknown>).archivePath, persisted.archivePath);
        const args = { archivePath: persisted.archivePath, length: 200_000 };
        const reread = await tools.find((tool) => tool.name === "read_tool_result")!.execute("archive-reread", args);
        assert.equal(reread.isError, false);
        const model = toModelMessages([
          { role: "assistant", content: [{ type: "toolCall", id: "archive-reread", name: "read_tool_result", arguments: args }] },
          { ...reread, role: "toolResult", toolCallId: "archive-reread", toolName: "read_tool_result" }
        ]).find((message) => message.role === "tool");
        assert.ok(model?.role === "tool");
        const part = model.content[0];
        assert.ok(part?.type === "tool-result" && part.output.type === "text");
        const page = JSON.parse(part.output.value) as { content: string; hasMore: boolean };
        assert.equal(page.hasMore, false);
        assert.deepEqual((JSON.parse(page.content) as Record<string, unknown>).unreadableDirectories, ["blocked"], "archive retrieval must preserve the named warning for the model");
        assert.match(persisted.preview, /"unreadableDirectories":\["blocked"\]/u);
        assert.match(String((replayed.details as Record<string, unknown>).preview), /"unreadableDirectories":\["blocked"\]/u);
      } finally {
        await recorder.close();
      }
    });
  });
}
