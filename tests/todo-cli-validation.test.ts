import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { promisify } from "node:util";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { defaultConfig } from "../src/config/schema.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TodoStore, type TodoItem } from "../src/session/todoStore.js";

const exec = promisify(execFile);
const cli = path.resolve("src/cli/index.ts");
const initial: TodoItem[] = [{ content: "Keep the existing task", status: "in_progress" }];

test("todo replace rejects a non-list JSON payload without clearing the saved plan", { timeout: 90_000 }, async (context) => {
  const fixture = await createFixture(context);
  const before = await readFile(fixture.todoPath);
  for (const payload of [null, {}, { todo: [] }, { todos: null }, "not a plan", 3, false]) {
    const result = await fixture.run("replace", "--todos", JSON.stringify(payload));
    assert.equal(result.status, 1, `unsupported payload must fail: ${JSON.stringify(payload)}; ${result.stdout}`);
    assert.equal(result.stdout, "", "rejected replacements must not print a success result");
    assert.match(result.stderr, /todo|plan|list|array/i);
    assert.deepEqual(await readFile(fixture.todoPath), before, "rejected input must preserve the original file bytes");
    assert.deepEqual(await fixture.reopen(), initial);
  }
});

test("todo replace rejects invalid item status without reporting a plan that disappears on reopen", { timeout: 90_000 }, async (context) => {
  const fixture = await createFixture(context);
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
    const result = await fixture.run("replace", "--todos", JSON.stringify({ todos }));
    assert.equal(result.status, 1, `invalid item list must fail; ${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /plan|item|content|status/i);
    assert.deepEqual(await readFile(fixture.todoPath), before, "whole-list validation must precede persistence");
    assert.deepEqual(await fixture.reopen(), initial);
  }
});

test("todo replace accepts complete arrays and envelopes, persists their exact replacement, and allows explicit empty lists", { timeout: 90_000 }, async (context) => {
  const fixture = await createFixture(context);
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
    const result = await fixture.run("replace", "--todos", JSON.stringify(input));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { todos: expected });
    assert.deepEqual(await fixture.reopen(), expected, "a fresh store must agree with replacement feedback");
    await fixture.store.refresh();
    assert.deepEqual(fixture.store.list(), expected, "the resident store must observe committed CLI replacements");
    const shown = await fixture.run("show");
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout).todos, expected);
  }
  const boundary = Array.from({ length: 50 }, () => ({ content: "x".repeat(500), status: "pending" as const }));
  const result = await fixture.run("replace", "--todos", JSON.stringify(boundary));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { todos: boundary });
  assert.deepEqual(await fixture.reopen(), boundary);
  await fixture.store.refresh();
  assert.deepEqual(fixture.store.list(), boundary);
  const cleared = await fixture.run("clear", "--yes");
  assert.equal(cleared.status, 0, cleared.stderr);
  await fixture.store.refresh();
  assert.deepEqual(fixture.store.list(), []);
  assert.equal(fixture.store.promptSection(), undefined);
});

test("TodoStore rejects sparse array holes before changing the live or persisted plan", async (context) => {
  const fixture = await createFixture(context);
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
});

for (const unsetAgentDir of [false, true]) {
  for (const failClose of [false, true]) {
    test(`todo fixture restores ${unsetAgentDir ? "absent" : "existing"} environment after recorder setup failure${failClose ? " and close failure" : ""}`, async (context) => {
      const initialAgentDir = process.env.BINY_AGENT_DIR;
      context.after(() => {
        if (initialAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
        else process.env.BINY_AGENT_DIR = initialAgentDir;
      });
      if (unsetAgentDir) delete process.env.BINY_AGENT_DIR;
      const previousAgentDir = process.env.BINY_AGENT_DIR;
      const originalFetch = globalThis.fetch;
      const setupError = new Error("Injected recorder setup failure");
      const closeError = new Error("Injected recorder close failure");
      const observed: { root?: string; recorder?: SessionRecorder } = {};
      const originalRecord = SessionRecorder.prototype.recordAndFlush;
      const originalClose = SessionRecorder.prototype.close;
      const recordMock = context.mock.method(SessionRecorder.prototype, "recordAndFlush", async function (
        this: SessionRecorder, ...args: Parameters<SessionRecorder["recordAndFlush"]>
      ) {
        const globalRoot = process.env.BINY_AGENT_DIR;
        assert.ok(globalRoot);
        observed.root = path.dirname(globalRoot);
        observed.recorder = this;
        assert.equal(globalThis.fetch === originalFetch, false, "fetch guard must precede recorder setup");
        await originalRecord.apply(this, args);
        throw setupError;
      });
      const closeMock = context.mock.method(SessionRecorder.prototype, "close", async function (this: SessionRecorder) {
        await originalClose.call(this);
        if (failClose) throw closeError;
      });

      await assert.rejects(createFixture(context), (error: unknown) => {
        if (failClose) {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause === setupError, true);
          assert.deepEqual(error.errors.map((item: unknown) => item === setupError ? "setup" : item === closeError ? "close" : "unexpected"), ["setup", "close"]);
        } else {
          assert.equal(error === setupError, true, "setup failure must keep its original identity");
        }
        return true;
      });
      assert.equal(recordMock.mock.callCount(), 1);
      assert.equal(closeMock.mock.callCount(), 1, "the real recorder must be closed once after recording fails");
      assert.equal(process.env.BINY_AGENT_DIR, previousAgentDir);
      assert.equal(globalThis.fetch === originalFetch, true);
      assert.ok(observed.root);
      await assert.rejects(access(observed.root), { code: "ENOENT" });
      assert.ok(observed.recorder !== undefined);
      assert.throws(() => observed.recorder!.readText(), /Session recorder is not available/);
    });
  }
}

test("todo fixture finishes cleanup when the real Host close reports an error", { timeout: 90_000 }, async (context) => {
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const closeError = new Error("Injected Host close failure");
  const cleanup = captureFixtureCleanup(context, (error) => error === closeError);
  const fixture = await createFixture(cleanup.context);
  const originalClose = fixture.host.close.bind(fixture.host);
  const closeMock = context.mock.method(fixture.host, "close", async () => {
    await originalClose();
    throw closeError;
  });
  const closing = fixture.close();
  const repeated = fixture.close();
  assert.equal(repeated === closing, true, "concurrent cleanup must share one completion");
  await assert.rejects(closing, (error: unknown) => error === closeError);
  await assert.rejects(repeated, (error: unknown) => error === closeError);
  await assert.rejects(fixture.close(), (error: unknown) => error === closeError);
  assert.equal(closeMock.mock.callCount(), 1);
  assert.equal(process.env.BINY_AGENT_DIR, previousAgentDir);
  assert.equal(globalThis.fetch === originalFetch, true);
  await assert.rejects(access(fixture.root), { code: "ENOENT" });
});

test("todo fixture after hook waits for cleanup that the test already started", { timeout: 90_000 }, async (context) => {
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const observed: { root?: string; closed: boolean } = { closed: false };
  await context.test("start closing without awaiting it in the body", async (child) => {
    const fixture = await createFixture(child);
    observed.root = fixture.root;
    const originalClose = fixture.host.close.bind(fixture.host);
    child.mock.method(fixture.host, "close", async () => {
      await originalClose();
      observed.closed = true;
    });
    void fixture.close();
  });
  assert.equal(observed.closed, true);
  assert.equal(process.env.BINY_AGENT_DIR, previousAgentDir);
  assert.equal(globalThis.fetch === originalFetch, true);
  assert.ok(observed.root);
  await assert.rejects(access(observed.root), { code: "ENOENT" });
});

test("todo fixture rejects and reports even a caught Host-process fetch attempt", { timeout: 90_000 }, async (context) => {
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const cleanup = captureFixtureCleanup(context, /Todo control and persistence must not invoke a provider/);
  const fixture = await createFixture(cleanup.context);
  await assert.rejects(globalThis.fetch("http://todo-fixture.invalid/"), /Todo validation must not make network or model requests/);
  void fixture.close();
  await assert.rejects(cleanup.run, /Todo control and persistence must not invoke a provider/);
  assert.equal(process.env.BINY_AGENT_DIR, previousAgentDir);
  assert.equal(globalThis.fetch === originalFetch, true);
  await assert.rejects(access(fixture.root), { code: "ENOENT" });
});

// Fault cases replace only hook registration, then exercise the actual registered cleanup.
function captureFixtureCleanup(context: TestContext, expectedError: RegExp | ((error: unknown) => boolean)) {
  const holder: { cleanup?: () => Promise<void> } = {};
  const run = async () => {
    assert.ok(holder.cleanup, "fixture must register its cleanup hook");
    await holder.cleanup();
  };
  // Even an earlier assertion failure must still run and await fixture cleanup.
  context.after(async () => { await assert.rejects(run, expectedError); });
  const fixtureContext: Pick<TestContext, "mock" | "after"> = {
    mock: context.mock,
    after(callback) {
      assert.equal(holder.cleanup, undefined, "fixture must register one cleanup hook");
      holder.cleanup = async () => { await callback(context); };
    }
  };
  return { context: fixtureContext, run };
}

async function createFixture(context: Pick<TestContext, "mock" | "after">) {
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const holder: {
    root?: string;
    host?: Awaited<ReturnType<typeof startRuntimeHost>>;
    closePromise?: Promise<void>;
  } = {};
  // This guards the Host test process; CLI subprocesses still use the real RPC path.
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    throw new Error("Todo validation must not make network or model requests.");
  });
  const close = () => {
    holder.closePromise ??= (async () => {
      const errors: unknown[] = [];
      try {
        await holder.host?.close();
      } catch (error) {
        errors.push(error);
      }
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      try {
        if (holder.root) await rm(holder.root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      } finally {
        const requests = fetchMock.mock.callCount();
        fetchMock.mock.restore();
        try {
          assert.equal(requests, 0, "Todo control and persistence must not invoke a provider.");
        } catch (error) {
          errors.push(error);
        }
      }
      throwFixtureErrors(errors, "Todo fixture cleanup failed");
    })();
    return holder.closePromise;
  };
  // Register before acquiring directories or changing the environment. Always report failures,
  // including when the test started close without awaiting or inspecting its result.
  context.after(close);
  try {
    holder.root = await mkdtemp(path.join(os.tmpdir(), "biny-todo-cli-validation-"));
    const root = await realpath(holder.root);
    holder.root = root;
    const workspaceRoot = path.join(root, "workspace");
    const globalRoot = path.join(root, "agent");
    process.env.BINY_AGENT_DIR = globalRoot;
    await mkdir(workspaceRoot);
    await ensureAgentDirs(workspaceRoot);
    const sessionId = "todo-cli-validation";
    const recorder = new SessionRecorder(workspaceRoot, sessionId);
    const recordingErrors: unknown[] = [];
    try {
      await recorder.recordAndFlush({ type: "user_message", content: "Synthetic todo audit" });
    } catch (error) {
      recordingErrors.push(error);
    } finally {
      try {
        await recorder.close();
      } catch (error) {
        recordingErrors.push(error);
      }
    }
    throwFixtureErrors(recordingErrors, "Todo fixture recording and close failed");
    const store = new TodoStore(workspaceRoot, sessionId);
    await store.initialize();
    await store.replace(initial);
    const config = structuredClone(defaultConfig);
    config.defaultModel = "todo-fixture";
    config.toolModel = "todo-fixture";
    config.providers = { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
    config.models = { "todo-fixture": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "todo-fixture" } };
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    config.heartbeat.enabled = false;
    const host = await startRuntimeHost(workspaceRoot, async () => await createInteractiveAgentHost(workspaceRoot, {
      sessionId, configStore: { load: async () => config, save: async () => undefined }
    }), { createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); } });
    holder.host = host;
    return {
      root,
      host,
      store,
      todoPath: path.join(agentDir(workspaceRoot), "todos", `${sessionId}.json`),
      async run(command: string, ...args: string[]) {
        try {
          const result = await exec(process.execPath, [
            "--import", import.meta.resolve("tsx"), cli,
            "todo", command, "--session", sessionId, "--json", ...args
          ], {
            cwd: workspaceRoot,
            env: { ...process.env, BINY_AGENT_DIR: globalRoot, NODE_NO_WARNINGS: "1" },
            encoding: "utf8",
            timeout: 20_000
          });
          return { ...result, status: 0 };
        } catch (error) {
          const result = error as { code?: number | string; stdout: string; stderr: string };
          assert.equal(typeof result.code, "number", String(error));
          return { ...result, status: result.code };
        }
      },
      async reopen() {
        const reloaded = new TodoStore(workspaceRoot, sessionId);
        await reloaded.initialize();
        return reloaded.list();
      },
      close
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Todo fixture setup and cleanup failed", { cause: error });
    }
    throw error;
  }
}

function throwFixtureErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message, { cause: errors[0] });
}
