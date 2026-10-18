import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { TodoStore, type TodoItem } from "../src/session/todoStore.js";

const exec = promisify(execFile);
const cli = path.resolve("src/cli/index.ts");

test("todo show returns the resolved owner for default, alias, prefix, filename, and exact selectors", { timeout: 90_000 }, async context => {
  const fixture = await createFixture(context);
  await fixture.seed("unrelated-session", [{ content: "Other plan", status: "completed" }], "2025-01-01T00:00:00Z");
  const sessionId = "todo-owner-session";
  const todos: TodoItem[] = [
    { content: "Current task", status: "in_progress" },
    { content: "Next task", status: "pending" }
  ];
  await fixture.seed(sessionId, todos, "2025-01-02T00:00:00Z");

  for (const selector of [undefined, "latest", "lat", "todo-owner", `${sessionId}.jsonl`, sessionId]) {
    await context.test(`selector ${String(selector)}`, async () => {
      assert.deepEqual(await fixture.show(selector), { sessionId, todos },
        "the returned identity must belong to the displayed plan");
    });
  }

  await fixture.seed("empty-plan-session", [], "2025-01-03T00:00:00Z");
  assert.deepEqual(await fixture.show(), { sessionId: "empty-plan-session", todos: [] },
    "empty lists must retain their resolved owner");
});

test("the session ID returned by todo show still selects its plan after latest changes", { timeout: 90_000 }, async context => {
  const fixture = await createFixture(context);
  const originalId = "original-plan-session";
  const originalTodos: TodoItem[] = [{ content: "Original plan", status: "pending" }];
  await fixture.seed(originalId, originalTodos, "2025-01-01T00:00:00Z");
  const shown = await fixture.show();
  assert.deepEqual(shown.todos, originalTodos);

  const newerId = "newer-plan-session";
  const newerTodos: TodoItem[] = [{ content: "Newer plan", status: "completed" }];
  await fixture.seed(newerId, newerTodos, "2025-01-02T00:00:00Z");
  assert.deepEqual((await fixture.show()).todos, newerTodos, "the fixture must move latest to the newer session");
  assert.deepEqual(await fixture.show(shown.sessionId), { sessionId: originalId, todos: originalTodos },
    "a returned identity must remain bound to the original plan after another session becomes latest");
});

async function createFixture(context: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-todo-show-owner-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  });
  const root = await realpath(temporary);
  const workspaceRoot = path.join(root, "workspace");
  const globalRoot = path.join(root, "agent");
  process.env.BINY_AGENT_DIR = globalRoot;
  await mkdir(workspaceRoot);
  await ensureAgentDirs(workspaceRoot);

  return {
    async seed(sessionId: string, todos: TodoItem[], modifiedAt: string) {
      const recorder = new SessionRecorder(workspaceRoot, sessionId);
      try {
        await recorder.recordAndFlush({ type: "user_message", content: `Plan fixture for ${sessionId}` });
      } finally {
        await recorder.close();
      }
      const store = new TodoStore(workspaceRoot, sessionId);
      await store.initialize();
      await store.replace(todos);
      const modified = new Date(modifiedAt);
      await utimes(recorder.filePath, modified, modified);
    },
    async show(session?: string) {
      const { stdout } = await exec(process.execPath, [
        "--import", import.meta.resolve("tsx"), cli, "todo", "show", "--json",
        ...(session === undefined ? [] : ["--session", session])
      ], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BINY_AGENT_DIR: globalRoot,
          BINY_AGENT_CONTEXT: "",
          BINY_AGENT_SESSION_ID: "",
          NODE_NO_WARNINGS: "1"
        },
        encoding: "utf8",
        timeout: 20_000
      });
      const result: unknown = JSON.parse(stdout);
      assert.ok(typeof result === "object" && result !== null);
      assert.ok("sessionId" in result && typeof result.sessionId === "string");
      assert.ok("todos" in result && Array.isArray(result.todos));
      return { sessionId: result.sessionId, todos: result.todos as unknown[] };
    }
  };
}
