import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import { DurableTaskRunStore, type TaskRunWithAttempts } from "../src/runtime/TaskRunStore.js";

const exec = promisify(execFile);
const cli = path.resolve("src/cli/index.ts");
type Page = { tasks: TaskRunWithAttempts[]; nextCursor?: number; hasMore: boolean };

await test("task list preserves durable pagination through the CLI and client", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-task-pages-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const paths = runtimeHostPaths(root);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  await writeFile(paths.registrationPath, JSON.stringify({
    ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, hostEpoch: "task-page-fixture", token: "synthetic-task-pages-token",
    pid: process.pid, createdAt: new Date().toISOString()
  }), { mode: 0o600 });
  // CLI parsing, Host discovery, taskListCommand, client.taskList and the store
  // are real. Connection/request dispatch is mocked; no Host socket is opened.
  const client = {
    taskList: RuntimeHostClient.prototype.taskList,
    request: async (operation: string, options: Parameters<DurableTaskRunStore["list"]>[0]) => {
      assert.equal(operation, "task.list");
      return tasks.list(options);
    },
    close: async () => undefined
  } as unknown as RuntimeHostClient;
  const connection = t.mock.method(RuntimeHostClient, "connect", async () => client);
  let invocation = 0;
  const run = async (...args: string[]) => await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "task", "list", ...args], {
    cwd: root, env: { ...process.env }, timeout: 15_000, maxBuffer: 2 * 1024 * 1024
  });
  const read = async (...args: string[]): Promise<Page> => {
    const previousArgv = process.argv;
    const previousCwd = process.cwd();
    const output: string[] = [];
    const stdout = t.mock.method(console, "log", (value: string) => { output.push(value); });
    const exit = t.mock.method(process, "exit", (code?: number | string | null): never => { throw new Error(`CLI exited with code ${String(code)}.`); });
    try {
      process.chdir(root);
      process.argv = [process.execPath, cli, "task", "list", ...args, "--json"];
      await import(`${pathToFileURL(cli).href}?task-page-test=${String(++invocation)}`);
      assert.equal(output.length, 1);
      return JSON.parse(output[0]!) as Page;
    } finally {
      stdout.mock.restore();
      exit.mock.restore();
      process.argv = previousArgv;
      process.chdir(previousCwd);
    }
  };
  const ids = (page: Page) => page.tasks.map((task) => task.taskRunId);
  try {
    assert.deepEqual(await read(), { tasks: [], hasMore: false });
    const expected: string[] = [];
    for (let index = 0; index < 1_001; index += 1) {
      const taskRunId = `task-page-${String(index).padStart(4, "0")}`;
      tasks.create({ taskRunId, task: `Task ${String(index)}` });
      expected.push(taskRunId);
    }
    const cancelled = tasks.create({ taskRunId: "cancelled-page-task", task: "Cancelled task" });
    tasks.transition(cancelled.taskRunId, "cancelled");

    await t.test("returned cursor reaches rows beyond the maximum first page without duplicates", async () => {
      const first = await read("--limit", "1000", "--status", "created");
      assert.deepEqual(ids(first), expected.slice(0, 1_000));
      assert.equal(first.hasMore, true);
      assert.equal(typeof first.nextCursor, "number");
      const last = await read("--limit", "1000", "--status", "created", "--cursor", String(first.nextCursor));
      assert.deepEqual(ids(last), expected.slice(1_000));
      assert.equal(last.hasMore, false);
      assert.equal(last.nextCursor, undefined);
      assert.equal(new Set([...ids(first), ...ids(last)]).size, expected.length);
    });

    await t.test("zero, exact-size pages, filtered gaps and terminal cursors", async () => {
      const defaults = await read();
      assert.deepEqual(ids(defaults), expected.slice(0, 100));
      assert.equal(defaults.hasMore, true);
      const one = await read("--cursor", String(defaults.nextCursor), "--limit", "1");
      assert.deepEqual(ids(one), [expected[100]]);
      assert.equal(one.hasMore, true);
      assert.ok(one.nextCursor! > defaults.nextCursor!);
      const zero = await read("--cursor", "0", "--limit", "1000");
      assert.deepEqual(ids(zero), expected.slice(0, 1_000));
      const tail = await read("--cursor", String(zero.nextCursor), "--limit", "2");
      assert.deepEqual(ids(tail), [expected.at(-1), cancelled.taskRunId]);
      assert.equal(tail.hasMore, false, "an exact-size final page must not advertise another page");
      assert.equal(tail.nextCursor, undefined);
      const filtered = await read("--status", "cancelled", "--limit", "1", "--cursor", String(zero.nextCursor));
      assert.deepEqual(ids(filtered), [cancelled.taskRunId]);
      assert.equal(filtered.hasMore, false);
      assert.deepEqual(await read("--cursor", String(Number.MAX_SAFE_INTEGER)), { tasks: [], hasMore: false });
      assert.deepEqual(await read("--status", "failed", "--cursor", "0"), { tasks: [], hasMore: false });
    });

    await t.test("cursor option rejects values that would restart or corrupt the page", async () => {
      assert.match((await run("--help")).stdout, /--cursor <cursor>/u);
      for (const cursor of ["-1", "0.5", "NaN", "Infinity", "9007199254740992", "9007199254740990.5", "invalid", ""]) {
        await assert.rejects(run("--cursor", cursor), (error: unknown) => {
          assert.match((error as { stderr: string }).stderr, /non-negative safe integer/u);
          return true;
        });
      }
    });

    assert.equal(tasks.list({ limit: 1_000 }).tasks.every((task) => task.attempts.length === 0 && task.status === "created"), true,
      "listing must not dispatch or change any task");
    await t.test("continuation applies the current status filter after a task changes", async () => {
      const first = await read("--status", "created", "--limit", "1000");
      tasks.transition(expected.at(-1)!, "cancelled");
      assert.deepEqual(await read("--status", "created", "--cursor", String(first.nextCursor)), { tasks: [], hasMore: false });
      const changed = await read("--status", "cancelled", "--cursor", String(first.nextCursor));
      assert.deepEqual(ids(changed), [expected.at(-1), cancelled.taskRunId]);
      assert.equal(changed.tasks.every((task) => task.status === "cancelled" && task.attempts.length === 0), true);
      assert.equal(changed.hasMore, false);
    });
  } finally {
    connection.mock.restore();
    tasks.close();
    authority.close();
    await rm(paths.registrationPath, { force: true });
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
