import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read the integration test as text. Never import it or any product module.
// Only these three test-only functions execute with inert client, clock and run fixtures.
const parsed = ts.createSourceFile("user-input-host.test.ts",
  readFileSync(new URL("./user-input-host.test.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["diagnosticText", "summarizeMockRequest", "submitAndWaitForQuestion"];
const source = names.map(name => {
  const matches = parsed.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!.getText(parsed);
}).join("\n") + "\n({ wait: submitAndWaitForQuestion, summarize: summarizeMockRequest });";

interface Outcome { status: string; stopReason: string; steps: number; error?: string; output?: string }
interface Run { runId: string; messageId: string; completion: Promise<Outcome> }
interface Event { type: string; sessionId: string; runId: string; update?: { customKind?: string }; error?: string }
interface Update { event?: Event }
interface Client {
  subscribe(listener: (update: Update) => void): () => void;
  submitPrompt(input: string, attachments: [], ids: { runId: string }): Run;
  getSnapshot(): { state: { kind: string } };
}
interface MockRequest {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name: string } }>;
}
interface Api {
  wait(client: Client, session: string, phase: string, input: string, summary: () => unknown): Promise<Run>;
  summarize(body: MockRequest): unknown;
}
const question = (runId = "run", sessionId = "session"): Update => ({
  event: { type: "tool.progress", sessionId, runId, update: { customKind: "user_input" } }
});
function fixture(options: { replay?: Update; duringSubmit?: Update | Update[]; submitError?: Error; subscribeError?: Error } = {}) {
  let done!: (outcome: Outcome) => void;
  let failed!: (error: Error) => void;
  const completion = new Promise<Outcome>((resolve, reject) => { done = resolve; failed = reject; });
  let listener: ((update: Update) => void) | undefined;
  let callback: (() => void) | undefined;
  let disposals = 0;
  let clears = 0;
  let submissions = 0;
  const deadlines: number[] = [];
  const token = {};
  const api = runInNewContext(stripTypeScriptTypes(source, { mode: "strip" }), {
    Error,
    randomUUID: () => "run",
    // Redaction is an inert fixture, not a claim to test the product redactor.
    redactSecrets: (text: string) => text.replaceAll("fake-secret", "[redacted]"),
    setTimeout: (fn: () => void, ms: number) => { callback = fn; deadlines.push(ms); return token; },
    clearTimeout: (value: unknown) => { assert.equal(value, token); callback = undefined; clears++; }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Api;
  const run: Run = { runId: "run", messageId: "message", completion };
  const client: Client = {
    subscribe(fn) {
      if (options.subscribeError) throw options.subscribeError;
      listener = fn;
      if (options.replay) fn(options.replay);
      return () => { disposals++; listener = undefined; };
    },
    submitPrompt(_input, _attachments, ids) {
      assert.ok(listener, "subscribe before submit");
      assert.equal(ids.runId, "run");
      submissions++;
      if (options.submitError) throw options.submitError;
      if (options.duringSubmit) {
        for (const update of Array.isArray(options.duringSubmit) ? options.duringSubmit : [options.duringSubmit]) listener?.(update);
      }
      return run;
    },
    getSnapshot: () => ({ state: { kind: "runs" } })
  };
  const summary = { providerRequests: 2, modelCalls: 2, providerBranch: "question-tool-calls" };
  return {
    api, client, run, done, failed, deadlines, summary,
    start: (phase = "initial-question") => api.wait(client, "session", phase, "never-print-this-prompt", () => summary),
    emit: (update: Update) => listener?.(update),
    timeout: () => { assert.ok(callback); callback(); },
    state: () => ({ disposals, clears, submissions, listening: !!listener, timer: !!callback })
  };
}
const terminal = (status: string): Outcome => ({
  status, stopReason: status === "completed" ? "model_stop" : "provider_error",
  steps: 2, error: status === "failed" ? "inert provider failure" : undefined,
  output: "never-print-model-output"
});
function cleaned(f: ReturnType<typeof fixture>, disposals = 1): void {
  assert.deepEqual(f.deadlines, [10_000]);
  assert.equal(f.state().disposals, disposals);
  assert.equal(f.state().clears, 1);
  assert.equal(f.state().listening, false);
  assert.equal(f.state().timer, false);
}

for (const status of ["failed", "completed", "blocked", "incomplete", "aborted", "cancelled"]) {
  test(`early fulfilled ${status} is diagnostic failure, never an ignored completion`, async () => {
    const f = fixture();
    f.done(terminal(status)); // Already settled before observer registration.
    const pending = f.start("custom-text-question");
    await assert.rejects(pending, error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /custom-text-question: Run ended before question/);
      assert.ok(error.message.includes(`"status":"${status}"`));
      assert.equal(error.message.includes("never-print-model-output"), false);
      if (status === "failed") assert.match(error.message, /inert provider failure/);
      return true;
    });
    cleaned(f);
  });
}

test("already rejected completion retains a bounded redacted cause", async () => {
  const f = fixture();
  f.failed(new Error("fake-secret " + "x".repeat(500)));
  await assert.rejects(f.start(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Run rejected before question/);
    assert.match(error.message, /\[redacted\]/);
    assert.equal(error.message.includes("fake-secret"), false);
    assert.equal(error.message.includes("x".repeat(241)), false);
    return true;
  });
  cleaned(f);
});

for (const timing of ["later", "subscribe-replay", "submit-sync"] as const) {
  test(`question resolves before completion with ${timing} delivery`, async () => {
    const f = fixture(timing === "subscribe-replay" ? { replay: question() }
      : timing === "submit-sync" ? { duringSubmit: question() } : {});
    const pending = f.start();
    if (timing === "later") f.emit(question());
    assert.equal(await pending, f.run);
    cleaned(f);
    // The observer remains attached to handle later rejection, without changing the settled result.
    f.failed(new Error("later cancellation"));
    await Promise.resolve();
    cleaned(f);
  });
}

test("wrong run, wrong session and unrelated progress cannot satisfy readiness", async () => {
  const f = fixture({ replay: question("old-run") });
  const pending = f.start();
  let ready = false;
  void pending.then(() => { ready = true; });
  f.emit(question("run", "other-session"));
  f.emit({ event: { type: "run.failed", sessionId: "other-session", runId: "run" } });
  f.emit({ event: { type: "tool.progress", sessionId: "session", runId: "run", update: { customKind: "other" } } });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(f.state().listening, true);
  f.emit(question());
  assert.equal(await pending, f.run);
  cleaned(f);
});

test("question then terminal within submit returns the question handle", async () => {
  const f = fixture({ duringSubmit: [
    question(),
    { event: { type: "run.completed", sessionId: "session", runId: "run" } }
  ] });
  assert.equal(await f.start(), f.run);
  cleaned(f);
  f.done(terminal("completed"));
  await Promise.resolve();
  cleaned(f);
});

for (const status of ["failed", "completed", "blocked", "incomplete", "aborted", "cancelled"]) {
  test(`matching ${status} event fails without needing a completion frame`, async () => {
    const f = fixture();
    const pending = f.start();
    f.emit({ event: { type: `run.${status}`, sessionId: "session", runId: "run" } });
    await assert.rejects(pending, /Terminal event before question/);
    cleaned(f);
  });
}

for (const timing of ["subscribe-replay", "submit-sync"] as const) {
  test(`terminal ${timing} cleans up and handles any admitted completion`, async () => {
    const update: Update = { event: { type: "run.failed", sessionId: "session", runId: "run" } };
    const f = fixture(timing === "subscribe-replay" ? { replay: update } : { duringSubmit: update });
    await assert.rejects(f.start(), /Terminal event before question/);
    cleaned(f);
    assert.equal(f.state().submissions, timing === "subscribe-replay" ? 0 : 1);
    if (timing === "submit-sync") {
      f.failed(new Error("admitted completion failed"));
      await Promise.resolve();
      cleaned(f);
    }
  });
}

for (const operation of ["submit", "subscribe"] as const) {
  test(`synchronous ${operation} error cleans all acquired resources`, async () => {
    const error = new Error("inert synchronous failure");
    const f = fixture(operation === "submit" ? { submitError: error } : { subscribeError: error });
    await assert.rejects(f.start(), /Unable to subscribe or submit question run.*inert synchronous failure/);
    cleaned(f, operation === "submit" ? 1 : 0);
    assert.equal(f.state().submissions, operation === "submit" ? 1 : 0);
  });
}

test("replayed question cannot mask a synchronous submit failure", async () => {
  const f = fixture({ replay: question(), submitError: new Error("submit failed") });
  await assert.rejects(f.start(), /submit failed/);
  cleaned(f);
});

test("timeout stays 10000ms and reports bounded event/provider summary with phase", async () => {
  const f = fixture();
  const pending = f.start("cancel-question");
  for (let i = 0; i < 30; i++) f.emit({ event: {
    type: "run.failed", sessionId: "session", runId: "old-run",
    error: "fake-secret " + "y".repeat(500)
  } });
  f.timeout();
  await assert.rejects(pending, error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /cancel-question: No question within 10 seconds/);
    assert.match(error.message, /"providerRequests":2/);
    assert.match(error.message, /"providerBranch":"question-tool-calls"/);
    assert.match(error.message, /"state":"runs"/);
    assert.equal((error.message.match(/"type":"run.failed"/g) ?? []).length, 12);
    assert.equal(error.message.includes("fake-secret"), false);
    assert.equal(error.message.includes("y".repeat(241)), false);
    assert.equal(error.message.includes("never-print-this-prompt"), false);
    return true;
  });
  cleaned(f);
  f.done(terminal("failed"));
  await Promise.resolve();
  cleaned(f);
});

test("mock request summary omits message bodies and bounds tool names and identifiers", () => {
  const f = fixture();
  const summary = JSON.parse(JSON.stringify(f.api.summarize({
    messages: [{ role: "r".repeat(100), content: "never-print-this-prompt", tool_call_id: "i".repeat(200) }],
    tools: Array.from({ length: 50 }, () => ({ function: { name: "n".repeat(200) } }))
  }))) as { tools: string[]; toolCount: number; lastRole: string; lastToolCallId: string };
  assert.equal(summary.tools.length, 24);
  assert.equal(summary.toolCount, 50);
  assert.ok(summary.tools.every(name => name.length === 80));
  assert.equal(summary.lastRole.length, 32);
  assert.equal(summary.lastToolCallId.length, 80);
  assert.equal(JSON.stringify(summary).includes("never-print-this-prompt"), false);
});

test("a failing diagnostic callback cannot swallow a timeout", async () => {
  const f = fixture();
  const pending = f.api.wait(f.client, "session", "initial-question", "unused",
    () => { throw new Error("unavailable diagnostics"); });
  f.timeout();
  await assert.rejects(pending, /"provider":\{"unavailable":true\}/);
  cleaned(f);
});
