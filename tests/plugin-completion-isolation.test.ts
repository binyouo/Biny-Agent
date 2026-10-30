import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import type { AgentTurnOutcome } from "../src/agent/types.js";
import type { PluginAfterTurnContext, PluginLifecycleRegistry as Registry } from "../src/extensions/pluginLifecycle.js";

interface FixtureEvent { type: string; content?: string; outcome?: AgentTurnOutcome }
interface FaultOptions {
  readFailure?: boolean; replayFailure?: boolean; projectionFailure?: boolean;
  emptyHistory?: boolean; warningFailure?: boolean;
  reportFailure?: boolean; callbackFailure?: boolean; noHook?: boolean;
  flushFailure?: boolean; terminalFailure?: boolean; terminalReadFailure?: boolean; contribute?: boolean;
}

// Inert source-extraction test, NOT an AgentSession integration test. No runtime
// imports, model, plugin loader, SDK, native bindings, network or session files.
// Execute the actual post-audit completion tail and its enclosing catch; replace
// dependencies with deterministic memory fixtures. Durability is NOT swallowed.
const source = readFileSync(new URL("../src/agent/AgentSession.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("AgentSession.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
  const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `unique actual helper ${name}`);
  return matches[0]!.getText(ast);
}
function uniqueSlice(text: string, start: string, end: string): string {
  assert.equal(text.split(start).length, 2, `unique start ${start}`);
  assert.equal(text.split(end).length, 2, `unique end ${end}`);
  const begin = text.indexOf(start);
  const finish = text.indexOf(end, begin);
  assert.ok(finish > begin);
  return text.slice(begin, finish);
}
const tail = uniqueSlice(source,
  '      if (!retryCommitStarted) recordAssistantAudit();',
  '\n  }\n\n  async runTask(');
assert.ok(tail.includes('} catch (error) {\n      if (retryCommitStarted) throw error;'));
assert.ok(tail.includes('yield { type: "assistant.completed", content, notification };'));
assert.ok(tail.includes('await this.recordTurnOutcome(outcome);'));
assert.equal((tail.match(/yield doneEvent\(outcome\)/gu) ?? []).length, 2);
const waitHelper = uniqueSlice(source, '    const waitForPluginLifecycle = async function*', '\n    const pluginToolSelectionAllowsCalls');
const registrySource = readFileSync(new URL("../src/extensions/pluginLifecycle.ts", import.meta.url), "utf8");
const registryJs = ts.transpileModule(registrySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const registryExports = {};
vm.runInNewContext(registryJs, { exports: registryExports });
const { PluginLifecycleRegistry } = registryExports as { PluginLifecycleRegistry: typeof Registry };
const bindingNames = [
  "retryCommitStarted", "recordAssistantAudit", "outcome", "runPluginLifecycle",
  "pluginToolSelectionAllowsCalls", "pluginLifecycle", "readSessionEvents", "replaySessionEvents",
  "messageText", "input", "turnPersonalization", "callPluginMcpTool", "content", "notification",
  "runOptions", "systemPrompt", "finalMessages", "coordinator", "autoAnalyzeForTurn",
  "finalAssistantReference", "parseTemporalClues", "referenceByMessage", "sessionMessageMetadata",
  "pendingEvents", "errorMessage", "recordNativeTelemetry", "activeModelSettings", "observedSteps",
  "completedStepsBeforeRun", "abortSignal", "turnCancellationReason", "isTimeoutFailure",
  "usageAuditStarted", "stepUsageRecords", "sumSessionUsage", "loopContext", "streamFailureReported", "warmHistoryInstalled"
];
const program = `
${["doneEvent", "nativeTurnOutcome", "failedTurn", "cancelledTurn"].map(declaration).join("\n")}
async function* completionFixture(bindings) {
 const { ${bindingNames.join(", ")} } = bindings;
 ${waitHelper}
 try {
 ${tail}
}
globalThis.fixture = completionFixture;
globalThis.complete = () => nativeTurnOutcome(false, "synthetic answer", "stop", 1);
`;
const compiled = ts.transpileModule(program, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.deepEqual(compiled.diagnostics, [], "extracted tail must parse unchanged");
const context = { AbortSignal } as unknown as {
  AbortSignal: typeof AbortSignal;
  console: { warn: (message: string) => void };
  fixture: (this: object, bindings: object) => AsyncGenerator<FixtureEvent>;
  complete: () => AgentTurnOutcome;
};
vm.runInNewContext(compiled.outputText, context);

async function run(options: FaultOptions = {}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  context.console = { warn: message => {
    warnings.push(message);
    if (options.warningFailure) throw new Error("warning sink failed");
  } };
  const terminals: AgentTurnOutcome[] = [];
  const callbackInputs: PluginAfterTurnContext[] = [];
  const reports: Array<{ phase: string; message: string }> = [];
  const reads: Array<{ phase: string; success: boolean }> = [];
  const memoryTasks = new Set<Promise<unknown>>();
  let failedRead = false;
  const readEvents = async (_path: string, phase = "optional") => {
    calls.push(phase === "terminal" ? "terminal-read" : "read");
    if (options.terminalReadFailure && phase === "terminal") {
      reads.push({ phase, success: false });
      throw new Error("required terminal reread failed");
    }
    if (options.readFailure && !failedRead && phase === "optional") {
      failedRead = true;
      reads.push({ phase, success: false });
      throw new Error("optional history read unavailable");
    }
    reads.push({ phase, success: true });
    return [{ time: "2026-01-01T00:00:00.000Z" }, { time: "2026-01-01T00:00:01.000Z" }];
  };
  const lifecycle = new PluginLifecycleRegistry((_path, phase, error) => {
    reports.push({ phase, message: error instanceof Error ? error.message : String(error) });
    if (options.reportFailure) throw new Error("report failed");
  });
  if (!options.noHook) lifecycle.register({ afterTurn: async input => {
    callbackInputs.push(input);
    if (!input.contributeMemories) return;
    if (options.callbackFailure) throw new Error("callback failed");
    calls.push("sync-fixture");
  } });
  const receiver = {
    options: { workspaceRoot: "synthetic-workspace", config: {} },
    recorder: {
      filePath: "synthetic-session-never-opened", sessionId: "synthetic-session",
      flush: async () => {
        calls.push("flush");
        if (options.flushFailure) throw new Error("required flush failed");
      },
      runtimeContextSnapshot: () => undefined,
      recordWithRuntimeContext: () => { throw new Error("unexpected memory record"); }
    },
    recordTurnOutcome: async (value: AgentTurnOutcome) => {
      calls.push("terminal");
      // Model the separate essential terminal reread, not the optional snapshot.
      // The implementation of ensureTerminalOutcome is outside this extracted tail.
      await readEvents("synthetic-session-never-opened", "terminal");
      if (options.terminalFailure) throw new Error("required terminal persistence failed");
      terminals.push(value);
    },
    turnStore: { clear: async () => calls.push("clear") },
    flushSessionSearchIndex: async () => undefined,
    activePersonalization: { contributeMemories: false },
    pendingMemoryTasks: memoryTasks,
    getEmbeddingRuntime: async () => false,
    enqueueRecipeSuggestions: async () => undefined,
    pendingSkillExtraction: Promise.resolve(),
    enqueueSkillExtraction: async () => undefined,
    recordError: (error: unknown) => calls.push(`error:${error}`)
  };
  const bindings = {
    retryCommitStarted: false, outcome: context.complete(),
    recordAssistantAudit: () => calls.push("audit"),
    runPluginLifecycle: true, pluginToolSelectionAllowsCalls: true, pluginLifecycle: lifecycle,
    readSessionEvents: readEvents,
    replaySessionEvents: () => {
      calls.push("replay");
      if (options.replayFailure) throw new Error("optional replay failed");
      if (options.emptyHistory) return { messageTree: [], messages: [], messageReferences: [] };
      return {
        messageTree: [{ id: "u1", eventIndex: 0 }, { id: "a1", eventIndex: 1 }],
        messages: [{ role: "user", content: "synthetic question" }, { role: "assistant", content: "synthetic answer" }],
        messageReferences: [{ id: "u1" }, { id: "a1" }]
      };
    },
    messageText: (message: { content: string }) => {
      if (options.projectionFailure) throw new Error("optional projection failed");
      return message.content;
    },
    input: "synthetic question", content: "synthetic answer", notification: undefined,
    turnPersonalization: { useMemories: false, contributeMemories: options.contribute !== false },
    callPluginMcpTool: () => { throw new Error("MCP execution forbidden"); },
    runOptions: { source: "fixture" }, systemPrompt: "", finalMessages: [], coordinator: {},
    autoAnalyzeForTurn: false, finalAssistantReference: undefined,
    parseTemporalClues: () => [], referenceByMessage: new WeakMap(),
    sessionMessageMetadata: () => ({}),
    pendingEvents: { drain: function* () {}, waitForEventOr: async <T>(operation: Promise<T>): Promise<T> => await operation },
    errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error), recordNativeTelemetry: async () => undefined,
    activeModelSettings: { model: { provider: "fixture", modelId: "fixture" } },
    observedSteps: 1, completedStepsBeforeRun: 0, abortSignal: { aborted: false },
    turnCancellationReason: () => "interrupted", isTimeoutFailure: () => false,
    // This extracted post-audit tail starts after final warm history is installed.
    warmHistoryInstalled: true,
    usageAuditStarted: true, stepUsageRecords: [], sumSessionUsage: () => undefined,
    loopContext: { messages: [] }, streamFailureReported: false
  };
  const events: FixtureEvent[] = [];
  let thrown: Error | undefined;
  try { for await (const event of context.fixture.call(receiver, bindings)) events.push(event); }
  catch (error) { thrown = error instanceof Error ? error : new Error(String(error)); }
  await Promise.allSettled([...memoryTasks, receiver.pendingSkillExtraction]);
  return { events, terminals, calls, callbackInputs, reports, reads, warnings, thrown };
}
function assertCompleted(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.thrown, undefined);
  assert.equal(result.events.find(event => event.type === "done")?.outcome?.status, "completed");
  assert.equal(result.events.find(event => event.type === "done")?.content, "synthetic answer");
  assert.equal(result.events.filter(event => event.type === "assistant.completed").length, 1);
  assert.equal(result.events.some(event => event.type === "error"), false);
  assert.equal(result.terminals.length, 1);
  assert.equal(result.terminals[0]?.status, "completed");
}
for (const fault of ["readFailure", "replayFailure", "projectionFailure"]) {
  test(`${fault}: optional preparation must not replace completed outcome`, async () => {
    const result = await run({ [fault]: true });
    assert.equal(result.callbackInputs.length, 0);
    assert.deepEqual(result.reads.slice(0, 2), [
      { phase: "optional", success: fault !== "readFailure" },
      { phase: "terminal", success: true }
    ], "the shared read fixture fails once only; essential terminal reread succeeds");
    assertCompleted(result);
  });
}
test("contribution disabled: optional read failure must not replace completion", async () => {
  const result = await run({ contribute: false, readFailure: true });
  assert.deepEqual(result.reads, [{ phase: "optional", success: false }, { phase: "terminal", success: true }]);
  assertCompleted(result);
});
test("no hook bypasses optional read/replay", async () => {
  const result = await run({ noHook: true, contribute: false, readFailure: true, replayFailure: true });
  assertCompleted(result);
  assert.equal(result.calls.includes("read"), false);
  assert.equal(result.calls.includes("replay"), false);
});
test("normal callback receives stable IDs, roles, content and timestamps", async () => {
  const result = await run();
  assertCompleted(result);
  assert.deepEqual(JSON.parse(JSON.stringify(result.callbackInputs[0]?.messages)), [
    { id: "u1", role: "user", content: "synthetic question", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "a1", role: "assistant", content: "synthetic answer", timestamp: "2026-01-01T00:00:01.000Z" }
  ]);
  assert.deepEqual(result.calls.slice(0, 6), ["audit", "flush", "read", "replay", "sync-fixture", "terminal"]);
});
test("contribution disabled callback performs no sync", async () => {
  const result = await run({ contribute: false });
  assertCompleted(result);
  assert.equal(result.callbackInputs.length, 1);
  assert.equal(result.calls.includes("sync-fixture"), false);
});
for (const reportFailure of [false, true]) {
  test(`callback failure isolated, reporter throws=${reportFailure}`, async () => {
    const result = await run({ callbackFailure: true, reportFailure });
    assertCompleted(result);
    assert.deepEqual(result.reports, [{ phase: "afterTurn", message: "callback failed" }]);
  });
}
test("essential flush failure remains fatal before history read", async () => {
  const result = await run({ flushFailure: true, contribute: false });
  assert.equal(result.calls.includes("read"), false);
  assert.equal(result.events.find(event => event.type === "done")?.outcome?.status, "failed");
  assert.equal(result.events.some(event => event.type === "assistant.completed"), false);
  assert.equal(result.terminals[0]?.status, "failed");
});
test("essential terminal persistence failure cannot yield successful done", async () => {
  const result = await run({ terminalFailure: true, contribute: false });
  assert.match(result.thrown?.message ?? "", /required terminal persistence failed/u);
  assert.equal(result.events.some(event => event.type === "done"), false);
  assert.equal(result.terminals.length, 0);
});

test("essential terminal reread failure remains fatal after optional failure", async () => {
  const result = await run({ readFailure: true, terminalReadFailure: true, contribute: false });
  assert.match(result.thrown?.message ?? "", /required terminal reread failed/u);
  assert.equal(result.events.some(event => event.type === "done"), false);
  assert.equal(result.terminals.length, 0);
});

test("empty prepared history still dispatches afterTurn", async () => {
  const result = await run({ emptyHistory: true, contribute: false });
  assertCompleted(result);
  assert.equal(result.callbackInputs.length, 1);
  assert.equal(result.callbackInputs[0]?.messages.length, 0);
  assert.deepEqual(result.warnings, []);
});
test("preparation warning is generic and warning failure cannot change completion", async () => {
  const result = await run({ readFailure: true, warningFailure: true, contribute: false });
  assertCompleted(result);
  assert.deepEqual(result.warnings, ["[biny] Plugin afterTurn history preparation failed; skipping optional sync."]);
  assert.equal(result.callbackInputs.length, 0);
});
