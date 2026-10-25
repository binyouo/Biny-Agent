import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Extract only the actual read methods: importing their modules also imports
// RuntimeAuthority, WorkerSession and verification execution infrastructure.
// SQL is real; materialization, mailbox and receipt helpers are inert fixtures.
interface Options { order?: "asc" | "desc"; status?: string; sessionId?: string; cursor?: number; limit?: number }
interface Message { id: string; direction: "worker" | "parent"; content: string; delivered?: boolean }
interface Task {
  taskRunId: string; sessionId?: string; status: string; workspaceId: string;
  task: { communication: boolean; notifyParent?: boolean }; terminalEventId?: string;
  attempts: Array<{ attemptId: string; artifacts: { output?: string; communication: { messages: Message[] } }; failure?: { message: string }; verification?: { status: string } }>;
}
interface Page { tasks: Task[]; nextCursor?: number; hasMore: boolean }
interface Notice { id: string; taskRunId: string; attemptId: string; content: string; messageIds: string[]; terminal: boolean }
interface Store {
  database: DatabaseSync; authority: { workspaceId: string }; assertOpen(): void;
  requireWithAttempts(id: string): Task; list(options?: Options): Page;
  hasMessageReceipt(id: string, message: string): boolean;
}
interface Channel { tasks: Store; sessionId: string; notifications(maxCharacters?: number, receivingSessionId?: string): Notice[] }

const sourceRoot = process.env.BINY_TASK_QUERY_SOURCE_ROOT === undefined ? new URL("../", import.meta.url)
  : pathToFileURL(resolve(process.env.BINY_TASK_QUERY_SOURCE_ROOT) + sep);
const storeSource = ts.createSourceFile("TaskRunStore.ts", readFileSync(new URL("src/runtime/TaskRunStore.ts", sourceRoot), "utf8"), ts.ScriptTarget.Latest, true);
const communicationSource = ts.createSourceFile("TaskCommunication.ts", readFileSync(new URL("src/runtime/TaskCommunication.ts", sourceRoot), "utf8"), ts.ScriptTarget.Latest, true);
function method(source: ts.SourceFile, className: string, name: string): string {
  const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(declaration);
  const member = declaration.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  assert.ok(member?.body);
  return member.getText(source);
}
function compile<T>(source: string, bindings: Record<string, unknown>): T {
  const result = ts.transpileModule(source, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
  const context = createContext({ ...bindings }, { codeGeneration: { strings: false, wasm: false } });
  context.targetMethod = runInContext(result.outputText, context, { timeout: 1000 });
  assert.equal(typeof context.targetMethod, "function");
  // Do not return the VM function directly: every invocation, including nested
  // list/terminal calls, must remain inside a timed runInContext boundary.
  return function (this: unknown, ...args: unknown[]): unknown {
    context.receiver = this;
    context.argumentsList = args;
    try { return runInContext("targetMethod.apply(receiver, argumentsList)", context, { timeout: 1000 }); }
    finally { delete context.receiver; delete context.argumentsList; }
  } as T;
}
const list = compile<Store["list"]>(`({ ${method(storeSource, "DurableTaskRunStore", "list")} }).list`, {
  toString: (value: unknown) => { assert.equal(typeof value, "string"); return value; },
  toInteger: (value: unknown) => { assert.equal(Number.isSafeInteger(value), true); return value; }
});
const terminal = storeSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "isTaskRunTerminal");
assert.ok(terminal);
const isTaskRunTerminal = compile<(status: string) => boolean>(terminal.getText(storeSource).replace(/^export /u, "") + "\nisTaskRunTerminal;", {});
const notifications = compile<Channel["notifications"]>(`({ ${method(communicationSource, "TaskCommunication", "notifications")} }).notifications`, {
  isTaskRunTerminal,
  mailbox: (task: Task) => task.attempts.at(-1)!.artifacts.communication,
  artifacts: (task: Task) => task.attempts.at(-1)!.artifacts,
  redactSecrets: (value: string) => value // Fixture strings contain no secrets; redaction is outside this query test.
});

function task(index: number, sessionId: string | undefined = "other", reports = 0): Task {
  return { taskRunId: `task-${index}`, sessionId, workspaceId: "workspace", status: "running",
    task: { communication: true }, attempts: [{ attemptId: `attempt-${index}`, artifacts: { communication: {
      messages: Array.from({ length: reports }, (_, n) => ({ id: `report-${index}-${n}`, direction: "worker", content: `Synthetic report ${index}/${n}` }))
    } } }] };
}
function fixture(rows: Task[]) {
  assert.ok(rows.length <= 250);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE task_runs (task_run_id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT,
      parent_run_id TEXT, status TEXT, task_json TEXT, created_at TEXT, updated_at TEXT, terminal_event_id TEXT, revision INTEGER)`);
    const insert = database.prepare("INSERT INTO task_runs VALUES (?, ?, ?, NULL, ?, '{}', 'fixture', 'fixture', NULL, 0)");
    for (const row of rows) insert.run(row.taskRunId, row.workspaceId, row.sessionId ?? null, row.status);
    const byId = new Map(rows.map(row => [row.taskRunId, row]));
    const materialized: string[] = [];
    const receipts = new Set<string>();
    const store: Store = { database, authority: { workspaceId: "workspace" }, assertOpen() {}, list,
      requireWithAttempts(id) { materialized.push(id); const value = byId.get(id); assert.ok(value); return value; },
      hasMessageReceipt(id, message) { return receipts.has(`${id}:${message}`); }
    };
    const snapshot = () => JSON.stringify(database.prepare("SELECT rowid, * FROM task_runs ORDER BY rowid").all());
    const before = snapshot();
    return { store, materialized, receipts, snapshot,
      close() { try { assert.equal(snapshot(), before, "read methods must not mutate SQLite rows"); } finally { database.close(); } }
    };
  } catch (error) { database.close(); throw error; }
}
function normalize<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function compare(rows: Task[], receivingSessionId = "owner", budget = 6000, receipts: string[] = []) {
  const f = fixture(rows);
  try {
    for (const receipt of receipts) f.receipts.add(receipt);
    const channel: Channel = { tasks: f.store, sessionId: "owner", notifications };
    // The prior caller omitted sessionId. Ignoring only that option reproduces
    // its workspace-wide list while executing the same SQL/method implementation.
    f.store.list = function (options = {}) { const { sessionId: _sessionId, ...unfiltered } = options; return list.call(this, unfiltered); };
    const baseline = normalize(channel.notifications(budget, receivingSessionId));
    const before = [...f.materialized];
    f.materialized.length = 0;
    f.store.list = list;
    const candidate = normalize(channel.notifications(budget, receivingSessionId));
    const after = [...f.materialized];
    assert.deepEqual(candidate, baseline);
    assert.equal(channel.sessionId, "owner", "receiving override must not rebind the channel");
    assert.equal(after.every(id => rows.find(row => row.taskRunId === id)?.sessionId === receivingSessionId), true,
      "no unrelated task may reach requireWithAttempts");
    return { baseline, candidate, before, after };
  } finally { f.close(); }
}

test("notifications avoid unrelated materialization when no task belongs to the receiver", () => {
  const result = compare(Array.from({ length: 250 }, (_, index) => task(index)));
  assert.deepEqual(result.candidate, []);
  assert.equal(result.before.length, 250);
  assert.equal(result.after.length, 0);
});

test("low-density reports retain exact ordering across former workspace page boundaries", () => {
  const rows = Array.from({ length: 250 }, (_, index) => task(index));
  rows[101] = task(101, "owner", 1); rows[220] = task(220, "owner", 1);
  const result = compare(rows);
  assert.deepEqual(result.candidate.map(notice => notice.id), ["report-101-0", "report-220-0"]);
  assert.equal(result.before.length, 250);
  assert.deepEqual(result.after, ["task-101", "task-220"]);
  const empty = compare(rows, "owner", 6000, ["task-101:report-101-0", "task-220:report-220-0"]);
  assert.deepEqual(empty.candidate, []);
  assert.equal(empty.after.length, 2);
});

test("limit-filled early stop avoids foreign rows but need not reduce total materialization", () => {
  const rows = Array.from({ length: 250 }, (_, index) => task(index, index === 0 || index >= 100 ? "owner" : "other", index === 0 ? 5 : 0));
  const result = compare(rows);
  assert.equal(result.candidate.length, 4);
  assert.equal(result.before.length, 100);
  assert.equal(result.after.length, 100);
  assert.equal(result.before.filter(id => rows.find(row => row.taskRunId === id)?.sessionId !== "owner").length, 99);
  assert.deepEqual(result.after.slice(0, 3), ["task-0", "task-100", "task-101"]);
});

test("explicit receiving session and notification budgets retain existing output", () => {
  const rows = [task(0, "owner", 1), task(1, "resumed", 2), task(2, "resumed", 1)];
  rows[2]!.status = "completed";
  rows[2]!.attempts[0]!.artifacts.output = "Synthetic completion";
  for (const budget of [0, 511, 512, 900, 6000]) {
    const result = compare(rows, "resumed", budget);
    assert.ok(result.candidate.every(notice => notice.taskRunId !== "task-0"));
    assert.ok(result.candidate.reduce((sum, notice) => sum + notice.content.length, 0) <= budget);
  }
  assert.equal(compare(rows, "resumed").candidate.at(-1)?.terminal, true);
  rows[2]!.task.notifyParent = false;
  assert.equal(compare(rows, "resumed").candidate.some(notice => notice.terminal), false);
  rows[1]!.task.communication = false; rows[2]!.attempts = [];
  assert.deepEqual(compare(rows, "resumed").candidate, []);
});

test("list retains workspace, default, status, order, cursor and limit contracts", () => {
  const rows = Array.from({ length: 205 }, (_, index) => task(index, index % 2 ? "owner" : "other"));
  rows[2]!.sessionId = ""; rows[3]!.sessionId = undefined;
  rows[4]!.workspaceId = "foreign-workspace";
  for (const row of rows) if (Number(row.taskRunId.slice(5)) % 3 === 0) row.status = "completed";
  const f = fixture(rows);
  try {
    for (const sessionId of [undefined, "owner", "other", "", "missing", "owner' OR 1=1 --"]) {
      for (const order of ["asc", "desc"] as const) for (const status of [undefined, "completed"]) {
        const expected = rows.filter(row => row.workspaceId === "workspace" && (sessionId === undefined || row.sessionId === sessionId) && (status === undefined || row.status === status));
        if (order === "desc") expected.reverse();
        const seen: Task[] = []; let cursor: number | undefined;
        for (let pages = 0; pages < 50; pages++) {
          const page = f.store.list({ sessionId, order, status, cursor, limit: 7 });
          seen.push(...page.tasks);
          if (!page.hasMore) { assert.equal(page.nextCursor, undefined); break; }
          assert.ok(page.nextCursor !== undefined);
          if (cursor !== undefined) assert.ok(order === "desc" ? page.nextCursor < cursor : page.nextCursor > cursor);
          cursor = page.nextCursor;
          assert.ok(pages < 49, "bounded traversal must finish");
        }
        assert.deepEqual(seen, expected);
      }
    }
    const defaults = f.store.list();
    assert.equal(defaults.tasks.length, 100); assert.equal(defaults.hasMore, true);
    assert.deepEqual(normalize(f.store.list({ sessionId: undefined })), normalize(defaults));
    assert.equal(f.store.list({ limit: 204 }).hasMore, false, "exact-size final page has no continuation");
    assert.equal(f.store.list({ cursor: Number.MAX_SAFE_INTEGER }).tasks.length, 0);
    assert.equal(f.store.list({ order: "desc", cursor: 0 }).tasks.length, 0);
    for (const limit of [0, -1, 1.5, 1001, NaN]) assert.throws(() => f.store.list({ limit }), /page size/);
    assert.throws(() => f.store.list({ order: "invalid" as "asc" }), /order must/);
  } finally { f.close(); }
});
