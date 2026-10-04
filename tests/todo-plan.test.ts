import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TodoStore, maxTodoItems, type TodoItem } from "../src/session/todoStore.js";
import { createTodoTool } from "../src/tools/todo.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-todo-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    await testReplaceAndPrompt(workspaceRoot);
    await testConstraints(workspaceRoot);
    await testSurvivesReload(workspaceRoot);
    await testSwitchesSessionTruthSource(workspaceRoot);
    await testToolRoundTrip(workspaceRoot);
    await testDetachedSnapshots(workspaceRoot);
    await testConcurrentPersistWritesCompleteFile(workspaceRoot);
    await testFailedPersistencePreservesPlan(workspaceRoot);
    await testPendingRenameKeepsCommittedPlan(workspaceRoot);
    await testCleanupCannotReorderPublishedPlans(workspaceRoot);
    await testCleanupFailureKeepsCommittedPlan(workspaceRoot);
    await testConcurrentRenamesStaySerialized(workspaceRoot);
    await testFailedConcurrentWriteKeepsSuccessfulPlan(workspaceRoot);
    console.log("todo plan tests passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testReplaceAndPrompt(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-a");
  await store.initialize();
  assert.equal(store.promptSection(), undefined, "an empty plan must not take up prompt space");

  await store.replace([
    { content: "read the failing test", status: "completed" },
    { content: "fix the parser", status: "in_progress" },
    { content: "run the suite", status: "pending" }
  ]);
  const prompt = store.promptSection() ?? "";
  assert.equal(prompt.includes("1. [x] read the failing test"), true);
  assert.equal(prompt.includes("2. [>] fix the parser"), true);
  assert.equal(prompt.includes("3. [ ] run the suite"), true);
}

async function testConstraints(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-b");
  await store.initialize();
  // 同时两项 in_progress 说明模型没在收敛注意力，直接拒绝并把原因说清楚。
  await assert.rejects(store.replace([
    { content: "a", status: "in_progress" },
    { content: "b", status: "in_progress" }
  ]), /one plan item/);
  await assert.rejects(store.replace([{ content: "   ", status: "pending" }]), /non-empty/);
  await assert.rejects(store.replace(
    Array.from({ length: maxTodoItems + 1 }, (_, index) => ({ content: `item ${String(index)}`, status: "pending" as const }))
  ), /at most/);
  // 被拒的写入不能留下痕迹。
  assert.deepEqual(store.list(), []);
}

/** 恢复会话后计划要还在 —— 否则它挡不住「压缩之后忘了还有第 3 步」。 */
async function testSurvivesReload(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-c");
  await store.initialize();
  await store.replace([{ content: "persisted item", status: "pending" }]);

  const reopened = new TodoStore(workspaceRoot, "plan-c");
  await reopened.initialize();
  assert.deepEqual(reopened.list(), [{ content: "persisted item", status: "pending" }]);

  // 别的会话看不到这份清单。
  const other = new TodoStore(workspaceRoot, "plan-d");
  await other.initialize();
  assert.deepEqual(other.list(), []);
}

/** resume 会复用同一个 runtime；切换 session 后读写都必须跟随恢复的 session。 */
async function testSwitchesSessionTruthSource(workspaceRoot: string): Promise<void> {
  const original = new TodoStore(workspaceRoot, "plan-resume-source");
  await original.initialize();
  await original.replace([{ content: "source item", status: "pending" }]);

  const resumed = new TodoStore(workspaceRoot, "plan-resume-target");
  await resumed.initialize();
  await resumed.replace([{ content: "target item", status: "in_progress" }]);

  const runtimeStore = new TodoStore(workspaceRoot, "runtime-draft");
  await runtimeStore.initialize();
  await runtimeStore.replace([{ content: "draft item", status: "pending" }]);

  await runtimeStore.useSession("plan-resume-target");
  assert.deepEqual(runtimeStore.list(), [{ content: "target item", status: "in_progress" }]);
  await runtimeStore.replace([{ content: "target item", status: "completed" }]);

  await runtimeStore.useSession("plan-resume-source");
  assert.deepEqual(runtimeStore.list(), [{ content: "source item", status: "pending" }]);

  const targetReloaded = new TodoStore(workspaceRoot, "plan-resume-target");
  await targetReloaded.initialize();
  assert.deepEqual(targetReloaded.list(), [{ content: "target item", status: "completed" }]);

  const draftReloaded = new TodoStore(workspaceRoot, "runtime-draft");
  await draftReloaded.initialize();
  assert.deepEqual(draftReloaded.list(), [{ content: "draft item", status: "pending" }]);
}

async function testToolRoundTrip(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-e");
  await store.initialize();
  const tool = createTodoTool(store);
  const execution = await tool.resolveExecution({
    todos: [
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" }
    ]
  });
  if (!("execute" in execution)) throw new Error("TodoWrite did not resolve to a runnable execution.");
  const result = await execution.execute({ toolCallId: "todo-test" });
  assert.equal(result.remaining, 1);
  assert.equal(result.todos.length, 2);
  assert.equal(store.promptSection()?.includes("step two"), true);
}

async function testDetachedSnapshots(workspaceRoot: string): Promise<void> {
  const sessionId = "plan-detached-snapshots";
  const store = new TodoStore(workspaceRoot, sessionId);
  await store.initialize();
  const input: TodoItem[] = [{ content: "  saved snapshot  ", status: "pending" }];
  const update = store.replace(input);
  input[0]!.content = "mutated input";
  const result = await update;
  assert.deepEqual(result, [{ content: "saved snapshot", status: "pending" }]);
  result[0]!.content = "mutated result";
  store.list()[0]!.status = "completed";
  await assertPlanState(workspaceRoot, sessionId, store, [{ content: "saved snapshot", status: "pending" }]);
}

/** 并发 persist 共用固定临时名会互相截断；随机临时名下落盘的必须是一份完整清单。 */
async function testConcurrentPersistWritesCompleteFile(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-concurrent");
  await store.initialize();
  const versions: TodoItem[][] = [
    [{ content: "first version", status: "pending" }],
    [{ content: "second version", status: "completed" }]
  ];
  const results = await Promise.all(versions.map((items) => store.replace(items)));
  assert.deepEqual(results, versions, "concurrent callers must receive their own committed snapshots");

  const reloaded = new TodoStore(workspaceRoot, "plan-concurrent");
  await reloaded.initialize();
  const items = reloaded.list();
  assert.deepEqual(store.list(), items, "live and persisted plans must agree after concurrent commits");
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item);
  assert.equal(
    item.content === "first version" && item.status === "pending"
      || item.content === "second version" && item.status === "completed",
    true,
    "the persisted plan must be one complete version, not an interleaved mix"
  );
}

/** Failed writes must agree across the tool, live prompt, disk, and resumed session. */
async function testFailedPersistencePreservesPlan(workspaceRoot: string): Promise<void> {
  for (const failure of ["write", "rename", "abort"] as const) {
    const sessionId = `plan-failed-${failure}`;
    const store = new TodoStore(workspaceRoot, sessionId);
    const previous: TodoItem[] = [{ content: "last saved plan", status: "pending" }];
    const next: TodoItem[] = [{ content: "unsaved completion", status: "completed" }];
    await store.initialize();
    await store.replace(previous);
    const target = todoPath(workspaceRoot, sessionId);
    const originalWrite = fs.writeFile;
    const originalRename = fs.rename;
    const error = failure === "abort"
      ? new DOMException("injected interrupted write", "AbortError")
      : Object.assign(new Error(`injected ${failure} EIO`), { code: "EIO" });
    let injected = false;
    try {
      fs.writeFile = async (file, data, options) => {
        if (String(file).startsWith(`${target}.`) && failure !== "rename") {
          injected = true;
          await originalWrite(file, "partial write", options);
          throw error;
        }
        return originalWrite(file, data, options);
      };
      fs.rename = async (from, to) => {
        if (String(to) === target && failure === "rename") {
          injected = true;
          throw error;
        }
        return originalRename(from, to);
      };
      await assert.rejects(executeTodo(store, next), (caught: unknown) => caught === error);
      assert.equal(injected, true);
      await assertPlanState(workspaceRoot, sessionId, store, previous);
      assert.equal(store.promptSection()?.includes("unsaved completion"), false);
      assert.deepEqual(await temporaryFiles(target), [], "failed writes must clean up partial temporary files");
    } finally {
      fs.writeFile = originalWrite;
      fs.rename = originalRename;
    }
    const recovered = await executeTodo(store, next);
    assert.deepEqual(recovered, { todos: next, remaining: 0 }, "a failed update must not prevent retry");
    await assertPlanState(workspaceRoot, sessionId, store, next);
  }
}

async function testPendingRenameKeepsCommittedPlan(workspaceRoot: string): Promise<void> {
  const sessionId = "plan-pending-rename";
  const store = new TodoStore(workspaceRoot, sessionId);
  const previous: TodoItem[] = [{ content: "committed plan", status: "pending" }];
  const next: TodoItem[] = [{ content: "next plan", status: "completed" }];
  await store.initialize();
  await store.replace(previous);
  const target = todoPath(workspaceRoot, sessionId);
  const entered = deferred();
  const release = deferred();
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (String(to) === target) {
      entered.resolve();
      await release.promise;
    }
    return originalRename(from, to);
  };
  const update = executeTodo(store, next);
  try {
    await entered.promise;
    await assertPlanState(workspaceRoot, sessionId, store, previous);
    release.resolve();
    assert.deepEqual(await update, { todos: next, remaining: 0 });
    await assertPlanState(workspaceRoot, sessionId, store, next);
  } finally {
    release.resolve();
    await update.catch(() => undefined);
    fs.rename = originalRename;
  }
}

/** Cleanup is not the commit boundary: delayed A cleanup must never republish A over B. */
async function testCleanupCannotReorderPublishedPlans(workspaceRoot: string): Promise<void> {
  const sessionId = "plan-cleanup-order";
  const store = new TodoStore(workspaceRoot, sessionId);
  const first: TodoItem[] = [{ content: "first saved version", status: "pending" }];
  const second: TodoItem[] = [{ content: "second saved version", status: "completed" }];
  await store.initialize();
  const target = todoPath(workspaceRoot, sessionId);
  const entered = deferred();
  const release = deferred();
  const originalRm = fs.rm;
  let delayed = false;
  fs.rm = async (file, options) => {
    if (!delayed && String(file).startsWith(`${target}.`)) {
      delayed = true;
      entered.resolve();
      await release.promise;
    }
    return originalRm(file, options);
  };
  const firstUpdate = executeTodo(store, first);
  try {
    await entered.promise;
    await assertPlanState(workspaceRoot, sessionId, store, first);
    assert.deepEqual(await executeTodo(store, second), { todos: second, remaining: 0 });
    await assertPlanState(workspaceRoot, sessionId, store, second);
    release.resolve();
    assert.deepEqual(await firstUpdate, { todos: first, remaining: 1 }, "each tool result must describe its own saved snapshot");
    await assertPlanState(workspaceRoot, sessionId, store, second);
    assert.deepEqual(await temporaryFiles(target), []);
  } finally {
    release.resolve();
    await firstUpdate.catch(() => undefined);
    fs.rm = originalRm;
  }
}

async function testCleanupFailureKeepsCommittedPlan(workspaceRoot: string): Promise<void> {
  const sessionId = "plan-cleanup-failure";
  const store = new TodoStore(workspaceRoot, sessionId);
  await store.initialize();
  const target = todoPath(workspaceRoot, sessionId);
  const originalRm = fs.rm;
  let injected = false;
  fs.rm = async (file, options) => {
    if (String(file).startsWith(`${target}.`)) {
      injected = true;
      throw Object.assign(new Error("injected cleanup EIO"), { code: "EIO" });
    }
    return originalRm(file, options);
  };
  try {
    const next: TodoItem[] = [{ content: "saved despite cleanup failure", status: "completed" }];
    assert.deepEqual(await executeTodo(store, next), { todos: next, remaining: 0 });
    assert.equal(injected, true);
    await assertPlanState(workspaceRoot, sessionId, store, next);
  } finally {
    fs.rm = originalRm;
  }
}

/** Serialize the rename/publication boundary, even while another snapshot is ready to commit. */
async function testConcurrentRenamesStaySerialized(workspaceRoot: string): Promise<void> {
  const sessionId = "plan-rename-order";
  const store = new TodoStore(workspaceRoot, sessionId);
  const first: TodoItem[] = [{ content: "slow first snapshot", status: "pending" }];
  const second: TodoItem[] = [{ content: "fast second snapshot", status: "completed" }];
  await store.initialize();
  const target = todoPath(workspaceRoot, sessionId);
  const entered = deferred();
  const secondWritten = deferred();
  const release = deferred();
  const originalRename = fs.rename;
  const originalWrite = fs.writeFile;
  let renames = 0;
  fs.writeFile = async (file, data, options) => {
    await originalWrite(file, data, options);
    if (String(file).startsWith(`${target}.`) && String(data).includes("fast second snapshot")) {
      secondWritten.resolve();
    }
  };
  fs.rename = async (from, to) => {
    if (String(to) === target && ++renames === 1) {
      // The disk commit may finish before its promise resumes; hold that exact boundary.
      await originalRename(from, to);
      entered.resolve();
      await release.promise;
      return;
    }
    return originalRename(from, to);
  };
  const firstUpdate = executeTodo(store, first);
  let secondUpdate: ReturnType<typeof executeTodo> | undefined;
  try {
    await entered.promise;
    secondUpdate = executeTodo(store, second);
    await secondWritten.promise;
    await setImmediate();
    assert.equal(renames, 1, "a pending rename must hold the next commit until its snapshot is published");
    assert.deepEqual(store.list(), []);
    release.resolve();
    assert.deepEqual(await firstUpdate, { todos: first, remaining: 1 });
    assert.deepEqual(await secondUpdate, { todos: second, remaining: 0 });
    assert.equal(renames, 2);
    await assertPlanState(workspaceRoot, sessionId, store, second);
  } finally {
    release.resolve();
    await Promise.allSettled([firstUpdate, secondUpdate]);
    fs.rename = originalRename;
    fs.writeFile = originalWrite;
  }
}

async function testFailedConcurrentWriteKeepsSuccessfulPlan(workspaceRoot: string): Promise<void> {
  for (const failFirst of [true, false]) {
    const sessionId = `plan-concurrent-failure-${String(failFirst)}`;
    const store = new TodoStore(workspaceRoot, sessionId);
    const first: TodoItem[] = [{ content: "first concurrent plan", status: "pending" }];
    const second: TodoItem[] = [{ content: "second concurrent plan", status: "completed" }];
    await store.initialize();
    const target = todoPath(workspaceRoot, sessionId);
    const entered = deferred();
    const release = deferred();
    const originalRename = fs.rename;
    let renames = 0;
    const error = Object.assign(new Error("injected concurrent rename EIO"), { code: "EIO" });
    fs.rename = async (from, to) => {
      if (String(to) === target) {
        const isFirst = ++renames === 1;
        if (isFirst) {
          entered.resolve();
          await release.promise;
        }
        if (isFirst === failFirst) throw error;
      }
      return originalRename(from, to);
    };
    const firstUpdate = executeTodo(store, first);
    const firstResult = failFirst ? assert.rejects(firstUpdate, (caught: unknown) => caught === error) : firstUpdate;
    try {
      await entered.promise;
      const secondUpdate = executeTodo(store, second);
      const secondResult = failFirst ? secondUpdate : assert.rejects(secondUpdate, (caught: unknown) => caught === error);
      release.resolve();
      await Promise.all([firstResult, secondResult]);
      await assertPlanState(workspaceRoot, sessionId, store, failFirst ? second : first);
      assert.deepEqual(await temporaryFiles(target), []);
    } finally {
      release.resolve();
      await firstResult.catch(() => undefined);
      fs.rename = originalRename;
    }
  }
}

function todoPath(workspaceRoot: string, sessionId: string): string {
  return path.join(agentDir(workspaceRoot), "todos", `${sessionId}.json`);
}

async function temporaryFiles(target: string): Promise<string[]> {
  return (await fs.readdir(path.dirname(target))).filter((name) => name.startsWith(`${path.basename(target)}.`) && name.endsWith(".tmp"));
}

async function assertPlanState(workspaceRoot: string, sessionId: string, store: TodoStore, expected: TodoItem[]): Promise<void> {
  assert.deepEqual(store.list(), expected, "the live plan must match the last committed snapshot");
  assert.deepEqual(JSON.parse(await fs.readFile(todoPath(workspaceRoot, sessionId), "utf8")).items, expected);
  const reloaded = new TodoStore(workspaceRoot, sessionId);
  await reloaded.initialize();
  assert.deepEqual(reloaded.list(), expected);
  assert.equal(store.promptSection(), reloaded.promptSection(), "live and resumed prompts must agree");
}

async function executeTodo(store: TodoStore, todos: TodoItem[]) {
  const execution = await createTodoTool(store).resolveExecution({ todos });
  if (!("execute" in execution)) throw new Error("TodoWrite did not resolve to a runnable execution.");
  return execution.execute({ toolCallId: "todo-persistence-test", operationId: "todo-persistence-test" });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

await main();
