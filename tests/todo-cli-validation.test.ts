import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TodoStore, type TodoItem } from "../src/session/todoStore.js";

const cli = path.resolve("src/cli/index.ts");
const initial: TodoItem[] = [{ content: "Keep the existing task", status: "in_progress" }];

test("todo replace rejects a non-list JSON payload without clearing the saved plan", { timeout: 90_000 }, async () => {
  const fixture = await createFixture();
  try {
    const before = await readFile(fixture.todoPath);
    for (const payload of [null, {}, { todo: [] }, { todos: null }, "not a plan", 3, false]) {
      const result = fixture.run("replace", "--todos", JSON.stringify(payload));
      assert.equal(result.status, 1, `unsupported payload must fail: ${JSON.stringify(payload)}; ${result.stdout}`);
      assert.equal(result.stdout, "", "rejected replacements must not print a success result");
      assert.match(result.stderr, /todo|plan|list|array/i);
      assert.deepEqual(await readFile(fixture.todoPath), before, "rejected input must preserve the original file bytes");
      assert.deepEqual(await fixture.reopen(), initial);
    }
  } finally {
    await fixture.close();
  }
});

test("todo replace rejects invalid item status without reporting a plan that disappears on reopen", { timeout: 90_000 }, async () => {
  const fixture = await createFixture();
  try {
    const before = await readFile(fixture.todoPath);
    const invalidItems: unknown[] = [
      { content: "Invalid replacement", status: "done" },
      { content: "Missing status" },
      { content: "Wrong status type", status: null },
      { content: 4, status: "pending" },
      { status: "pending" },
      { content: "", status: "pending" },
      { content: "   ", status: "pending" },
      { content: "x".repeat(501), status: "pending" },
      null, [], false, "not an item"
    ];
    const invalidLists = [
      ...invalidItems.map((item) => [{ content: "Must not partially save", status: "completed" }, item]),
      [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }],
      Array.from({ length: 51 }, () => ({ content: "Too many tasks", status: "pending" }))
    ];
    for (const todos of invalidLists) {
      const result = fixture.run("replace", "--todos", JSON.stringify({ todos }));
      assert.equal(result.status, 1, `invalid item list must fail; ${result.stdout}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /plan|item|content|status/i);
      assert.deepEqual(await readFile(fixture.todoPath), before, "whole-list validation must precede persistence");
      assert.deepEqual(await fixture.reopen(), initial);
    }
  } finally {
    await fixture.close();
  }
});

test("todo replace accepts complete arrays and envelopes, persists their exact replacement, and allows explicit empty lists", { timeout: 90_000 }, async () => {
  const fixture = await createFixture();
  try {
    const plans: Array<{ input: unknown; expected: TodoItem[] }> = [
      {
        input: [
          { content: "  Finished task  ", status: "completed" },
          { content: "Current task", status: "in_progress" },
          { content: "Next task", status: "pending" }
        ],
        expected: [
          { content: "Finished task", status: "completed" },
          { content: "Current task", status: "in_progress" },
          { content: "Next task", status: "pending" }
        ]
      },
      { input: { todos: [{ content: "Only remaining task", status: "pending" }] }, expected: [{ content: "Only remaining task", status: "pending" }] },
      { input: [], expected: [] },
      { input: initial, expected: initial },
      { input: { todos: [] }, expected: [] }
    ];
    for (const { input, expected } of plans) {
      const result = fixture.run("replace", "--todos", JSON.stringify(input));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { todos: expected });
      assert.deepEqual(await fixture.reopen(), expected, "a fresh store must agree with replacement feedback");
      const shown = fixture.run("show");
      assert.equal(shown.status, 0, shown.stderr);
      assert.deepEqual(JSON.parse(shown.stdout).todos, expected);
    }
    const boundary = Array.from({ length: 50 }, () => ({ content: "x".repeat(500), status: "pending" as const }));
    const result = fixture.run("replace", "--todos", JSON.stringify(boundary));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { todos: boundary });
    assert.deepEqual(await fixture.reopen(), boundary);
  } finally {
    await fixture.close();
  }
});

test("TodoStore rejects sparse array holes before changing the live or persisted plan", async () => {
  const fixture = await createFixture();
  try {
    const before = await readFile(fixture.todoPath);
    const promptBefore = fixture.store.promptSection();
    const mixed = new Array<unknown>(2);
    mixed[0] = { content: "Must not partially save", status: "completed" };
    // JSON cannot encode holes, but direct store callers can pass sparse arrays.
    for (const items of [new Array<unknown>(1), mixed]) {
      await assert.rejects(fixture.store.replace(items), TypeError);
      assert.deepEqual(fixture.store.list(), initial);
      assert.equal(fixture.store.promptSection(), promptBefore);
      assert.deepEqual(await readFile(fixture.todoPath), before);
      assert.deepEqual(await fixture.reopen(), initial);
    }
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-todo-cli-validation-"));
  const workspaceRoot = path.join(root, "workspace");
  const globalRoot = path.join(root, "agent");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = globalRoot;
  await mkdir(workspaceRoot);
  await ensureAgentDirs(workspaceRoot);
  const sessionId = "todo-cli-validation";
  const recorder = new SessionRecorder(workspaceRoot, sessionId);
  await recorder.recordAndFlush({ type: "user_message", content: "Synthetic todo audit" });
  await recorder.close();
  const store = new TodoStore(workspaceRoot, sessionId);
  await store.initialize();
  await store.replace(initial);
  return {
    store,
    todoPath: path.join(agentDir(workspaceRoot), "todos", `${sessionId}.json`),
    run(command: string, ...args: string[]) {
      const result = spawnSync(process.execPath, [
        "--import", import.meta.resolve("tsx"), cli,
        "todo", command, "--session", sessionId, "--json", ...args
      ], {
        cwd: workspaceRoot,
        env: { ...process.env, BINY_AGENT_DIR: globalRoot, NODE_NO_WARNINGS: "1" },
        encoding: "utf8",
        timeout: 20_000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return result;
    },
    async reopen() {
      const reloaded = new TodoStore(workspaceRoot, sessionId);
      await reloaded.initialize();
      return reloaded.list();
    },
    async close() {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  };
}
