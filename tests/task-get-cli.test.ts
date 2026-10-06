import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";

await test("task get reports missing records through CLI stderr and exit status instead of successful undefined output", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-task-get-cli-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const paths = runtimeHostPaths(root);
  const source = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  const preload = path.join(root, "task-read-transport.mjs");
  try {
    tasks.create({ taskRunId: "existing-task", sessionId: "cold-owner", task: { prompt: "Read persisted progress" } });
    const attempt = tasks.createAttempt("existing-task", { attemptId: "existing-attempt", runId: "existing-run", turnId: "existing-turn" });
    tasks.transition("existing-task", "running", { attemptId: attempt.attemptId, artifacts: { output: "Saved progress" } });
    const beforeTasks = tasks.list({ limit: 100 });
    const beforeEvents = authority.readEvents({ limit: 100 });
    const beforeDataVersion = authority.databaseHandle().prepare("PRAGMA data_version").get();
    await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
    await writeFile(paths.registrationPath, JSON.stringify({
      ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion,
      persistenceRoot: root, hostEpoch: "task-get-cli-fixture", token: "synthetic-task-get-token",
      pid: process.pid, createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    // 保留真实 CLI、Host 发现、taskGet 和只读存储；替换连接、握手和 Host 请求分派。
    await writeFile(preload, `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { RuntimeHostClient } from ${source("src/runtime/host/client.ts")};
import { RuntimeEventAuthority } from ${source("src/runtime/RuntimeAuthority.ts")};
import { DurableTaskRunStore } from ${source("src/runtime/TaskRunStore.ts")};
const authority = await RuntimeEventAuthority.openReadOnly(process.cwd());
assert.ok(authority);
const tasks = await DurableTaskRunStore.open(process.cwd(), authority);
let requests = 0;
let closed = 0;
mock.method(childProcess, "spawn", () => { throw new Error("CLI read must not start a Runtime Host."); });
syncBuiltinESMExports();
mock.method(globalThis, "fetch", () => { throw new Error("CLI read must not use the network."); });
mock.method(RuntimeHostClient, "connect", async () => ({
  taskGet: RuntimeHostClient.prototype.taskGet,
  async request(operation, payload) {
    requests++;
    assert.equal(operation, "task.get");
    assert.equal(typeof payload.taskRunId, "string");
    const task = tasks.get(payload.taskRunId);
    return task === undefined ? undefined : JSON.parse(JSON.stringify(task));
  },
  async close() { closed++; tasks.close(); authority.close(); }
}));
process.once("exit", () => {
  assert.equal(requests, 1);
  assert.equal(closed, 1);
});
`);
    const run = (...args: string[]) => spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preload).href,
      path.resolve("src/cli/index.ts"), "task", "get", ...args
    ], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 15_000 });

    for (const json of [true, false]) {
      await t.test(`missing task in ${json ? "JSON" : "text"} mode exits 1 with no stdout`, () => {
        const result = run("missing-task", ...(json ? ["--json"] : []));
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1, `stdout: ${result.stdout}; stderr: ${result.stderr}`);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "TaskRun missing-task does not exist.\n");
      });
      await t.test(`existing task in ${json ? "JSON" : "text"} mode keeps its record and succeeds`, () => {
        const result = run("existing-task", ...(json ? ["--json"] : []));
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        const task = JSON.parse(result.stdout) as { taskRunId: string; status: string; attempts: { attemptId: string; artifacts: unknown }[] };
        assert.equal(task.taskRunId, "existing-task");
        assert.equal(task.status, "running");
        assert.equal(task.attempts.length, 1);
        assert.equal(task.attempts[0]!.attemptId, "existing-attempt");
        assert.deepEqual(task.attempts[0]!.artifacts, { output: "Saved progress" });
        assert.equal(result.stdout, `${JSON.stringify(beforeTasks.tasks[0], null, json ? undefined : 2)}\n`);
      });
    }
    assert.deepEqual(tasks.list({ limit: 100 }), beforeTasks, "queries must preserve task status and attempts");
    assert.deepEqual(authority.readEvents({ limit: 100 }), beforeEvents, "queries must not append runtime events");
    assert.deepEqual(authority.databaseHandle().prepare("PRAGMA data_version").get(), beforeDataVersion,
      "CLI subprocesses must not commit database writes");
  } finally {
    tasks.close();
    authority.close();
    await rm(paths.registrationPath, { force: true });
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
