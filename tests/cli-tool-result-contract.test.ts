/** Actual CLI registration and Commander parsing; Host transport is inert, never imported. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Command } from "commander";
import ts from "typescript";

type Register = (program: Command, session: Command, root: string, wrap: (action: () => Promise<void>) => () => Promise<void>) => void;
interface InspectionModule { registerSessionInspectionCommands: Register }
interface ManagementModule { unwrapHostOperationResult: (value: unknown) => unknown }
const commandRoot = path.join(process.cwd(), "src/cli/commands");
const inspectionSource = readFileSync(path.join(commandRoot, "sessionInspection.ts"), "utf8");
const managementSource = readFileSync(path.join(commandRoot, "sessionManagement.ts"), "utf8");
function load<T>(source: string, imports: ReadonlyMap<string, unknown>, bindings: Record<string, unknown> = {}): T {
  const compiled = ts.transpileModule(source, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled.outputText, {
    exports,
    require: (id: string): unknown => {
      assert.ok(imports.has(id), `Unexpected production import: ${id}`);
      return imports.get(id);
    },
    ...bindings
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } });
  return exports as T;
}
const unused = (): never => { throw new Error("Unrelated production capability must not execute."); };
const management = load<ManagementModule>(managementSource, new Map<string, unknown>([
  ["../../extensions/plan.js", { planCommandSchemas: Object.freeze({}) }],
  ["../../runtime/RuntimeHost.js", { connectRuntimeHost: unused, connectOrSpawnRuntimeHost: unused }],
  ["../../session/store.js", { resolveSessionFile: unused, sessionIdFromFile: unused }]
]));

function fixture(options: { value?: unknown; error?: Error; unavailable?: boolean; focusError?: Error; environment?: Record<string, string> } = {}) {
  const stdout: string[] = [];
  const calls: unknown[][] = [];
  const connections: unknown[][] = [];
  const focused: string[] = [];
  let closed = 0;
  const client = {
    persistenceRoot: "/inert/workspace",
    listRuntimeSessions: async () => [{ sessionId: "target-session" }],
    focusSession: async (id: string) => { focused.push(id); if (options.focusError) throw options.focusError; },
    sessionCommand: async (...args: unknown[]) => {
      calls.push(args);
      if (options.error) throw options.error;
      return options.value;
    },
    close: async () => { closed++; }
  };
  const production = load<InspectionModule>(inspectionSource, new Map<string, unknown>([
    ["../../runtime/RuntimeHost.js", { connectRuntimeHost: async (...args: unknown[]) => {
      connections.push(args); return options.unavailable ? undefined : client;
    } }],
    ["../../session/store.js", { resolveSessionFile: unused }],
    ["./sessionManagement.js", management]
  ]), {
    process: Object.freeze({ pid: 12345, env: Object.freeze({ ...options.environment }) }),
    console: Object.freeze({ log: (text: string) => { stdout.push(text); } })
  });
  const program = new Command();
  program.exitOverride();
  production.registerSessionInspectionCommands(program, program.command("session"), "/inert/workspace", action => action);
  const run = (args = ["tool", "call", "fixture_tool", '{"query":"needle"}', "--session", "target-session", "--json"]) =>
    program.parseAsync(args, { from: "user" });
  return { run, stdout, calls, connections, focused, closed: () => closed };
}
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

for (const [label, value] of [
  ["accepted true without a business result", { accepted: true, ticketId: "t1" }],
  ["accepted false business decision", { accepted: false, reason: "not selected", ticketId: "t2" }],
  ["accepted true with a business result", { accepted: true, result: { count: 3 }, ticketId: "t3" }],
  ["ordinary object", { content: "read result", count: 2 }],
  ["null", null],
  ["array", [{ accepted: false }, { accepted: true }]]
] as const) {
  test(`tool call preserves successful ${label}`, async () => {
    const f = fixture({ value });
    try {
      await f.run();
      assert.equal(f.stdout.length, 1);
      assert.deepEqual(JSON.parse(f.stdout[0]!), value);
    } finally {
      assert.equal(f.closed(), 1, "close exactly once even when a result is misinterpreted");
      assert.deepEqual(plain(f.calls), [["ToolCall", { name: "fixture_tool", input: { query: "needle" } }, "target-session", null]]);
      assert.deepEqual(f.focused, ["target-session"]);
      assert.deepEqual(plain(f.connections), [["/inert/workspace", { surface: "cli", clientId: "cli-12345" }]]);
    }
  });
}

for (const message of ["Runtime Host connection closed.", "Cannot start tool while the runtime is busy.", "Permission denied: full confirmation required.", "Tool execution failed."]) {
  test(`tool call retains RPC failure: ${message}`, async () => {
    const error = new Error(message);
    const f = fixture({ error });
    await assert.rejects(f.run(), received => received === error);
    assert.deepEqual(f.stdout, []);
    assert.equal(f.calls.length, 1);
    assert.equal(f.closed(), 1);
  });
}

test("tool call preserves environment session and context forwarding", async () => {
  const f = fixture({ value: { content: "ok" }, environment: { BINY_AGENT_SESSION_ID: "target-session", BINY_AGENT_CONTEXT: "foreground-scope" } });
  await f.run(["tool", "call", "fixture_tool", "--json"]);
  assert.deepEqual(plain(f.calls), [["ToolCall", { name: "fixture_tool", input: {} }, "target-session", "foreground-scope"]]);
  assert.equal(f.closed(), 1);
});

test("malformed JSON never connects or writes output", async () => {
  const f = fixture();
  await assert.rejects(f.run(["tool", "call", "fixture_tool", "{bad", "--session", "target-session"]), /valid JSON/u);
  assert.deepEqual(f.connections, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.stdout, []);
  assert.equal(f.closed(), 0);
});

test("missing session never connects", async () => {
  const f = fixture();
  await assert.rejects(f.run(["tool", "call", "fixture_tool"]), /Specify --session/u);
  assert.deepEqual(f.connections, []);
  assert.deepEqual(f.stdout, []);
});

test("unavailable Host stays a failure without spawning a replacement", async () => {
  const f = fixture({ unavailable: true });
  await assert.rejects(f.run(), /Runtime Host is not running/u);
  assert.equal(f.connections.length, 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.stdout, []);
  assert.equal(f.closed(), 0);
});

test("focus failure closes the connected client before any tool call", async () => {
  const error = new Error("Session unavailable.");
  const f = fixture({ focusError: error });
  await assert.rejects(f.run(), received => received === error);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.stdout, []);
  assert.equal(f.closed(), 1);
});

test("actual Host envelope helper retains acceptance and rejection semantics", () => {
  const result = { goalId: "goal" };
  assert.equal(management.unwrapHostOperationResult({ accepted: true, result, revision: 2 }), result);
  assert.throws(() => management.unwrapHostOperationResult({ accepted: false, reason: "stale revision" }), /stale revision/u);
  assert.throws(() => management.unwrapHostOperationResult({ accepted: false }), /Runtime operation was rejected/u);
});
