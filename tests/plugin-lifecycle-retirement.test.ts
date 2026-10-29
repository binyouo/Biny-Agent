import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import type { PluginLifecycleRegistry, PluginAfterTurnContext } from "../src/extensions/pluginLifecycle.js";

// Only actual source declarations run in isolated VMs. Dynamic `any` bindings are
// confined to these extracted seams; no Agent, plugin loader or real tool runs.
const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function compile(source: string, env: Record<string, any> = {}): Record<string, any> {
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.deepEqual(result.diagnostics, []);
  vm.runInNewContext(result.outputText, env);
  return env;
}
const Registry = compile(read("src/extensions/pluginLifecycle.ts"), { exports: {}, AbortController, AbortSignal, structuredClone }).exports.PluginLifecycleRegistry as typeof PluginLifecycleRegistry;
const Queue = compile(read("src/agent/core/EventQueue.ts"), { exports: {} }).exports.EventQueue;
const source = read("src/agent/AgentSession.ts");
function slice(start: string, end: string): string {
  assert.equal(source.split(start).length, 2, start);
  assert.equal(source.split(end).length, 2, end);
  return source.slice(source.indexOf(start), source.indexOf(end));
}
const helper = slice("    const waitForPluginLifecycle = async function*", "\n    const pluginToolSelectionAllowsCalls");
const caller = slice("    const callPluginMcpTool: PluginMcpToolCaller", "\n    const waitForPluginLifecycle");
function deferred() {
  let resolve!: (value?: any) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<any>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { for (let i = 0; i < 50; i++) await Promise.resolve(); }
function observed<T>(promise: Promise<T>) {
  const state: { settled: boolean; result?: T; error?: unknown } = { settled: false };
  const done = promise.then(result => { state.result = result; state.settled = true; }, error => { state.error = error; state.settled = true; });
  return { state, done };
}
function context(signal?: AbortSignal): PluginAfterTurnContext {
  return { workspaceRoot: "/inert", sessionId: "s", userMessage: "hello", useMemories: true, contributeMemories: true, signal,
    outcome: { status: "completed", stopReason: "model_stop", steps: 1, output: "answer", affectedTodoIds: ["a"] },
    messages: [{ id: "m", role: "user", content: "original" }] };
}
function bridge(signal: AbortSignal, discovery: (...args: any[]) => any, execute: (...args: any[]) => any): any {
  return compile(`function make(){${caller}\nreturn callPluginMcpTool;} globalThis.make=make;`, {
    abortSignal: signal, runOptions: {}, AbortSignal, randomUUID: () => "inert",
    coordinator: { executePluginMcpTool: execute }
  }).make.call({ options: { prepareToolDiscovery: discovery } });
}

for (const phase of ["beforeTurn", "afterTurn"] as const) {
  test(`${phase}: pre-abort does not admit a callback`, async () => {
    const c = new AbortController(); c.abort(); let calls = 0;
    const r = new Registry(); r.register({ [phase]: () => { calls++; } });
    await r[phase](context(c.signal)); assert.equal(calls, 0);
  });
  test(`${phase}: abort retires wait, observes late rejection, removes listeners`, async () => {
    const c = new AbortController(), gate = deferred(), errors: unknown[] = [];
    let adds = 0, removes = 0;
    const add = c.signal.addEventListener.bind(c.signal), remove = c.signal.removeEventListener.bind(c.signal);
    c.signal.addEventListener = (...a: Parameters<AbortSignal["addEventListener"]>) => { adds++; add(...a); };
    c.signal.removeEventListener = (...a: Parameters<AbortSignal["removeEventListener"]>) => { removes++; remove(...a); };
    const r = new Registry((...e) => errors.push(e)); r.register({ [phase]: () => gate.promise });
    const p = observed<unknown>(r[phase](context(c.signal))); await flush(); c.abort(); await flush();
    try { assert.equal(p.state.settled, true, "signal must retire an uncooperative callback wait"); assert.equal(adds, removes); }
    finally { gate.reject(Error("late")); await p.done; await flush(); }
    assert.equal(errors.length, 0, "late rejection cannot report into the next turn");
  });
  test(`${phase}: successful callback revokes retained capability`, async () => {
    let retained: any, calls = 0; const r = new Registry();
    r.register({ [phase]: (input: any) => { retained = input.callMcpTool; return phase === "beforeTurn" ? "valid" : undefined; } });
    await r[phase](context(), async () => { calls++; });
    await assert.rejects(retained("s", "t", {}, new AbortController().signal)); assert.equal(calls, 0);
  });
  test(`${phase}: caller signal cannot replace cancellation; admitted work must drain`, async () => {
    const c = new AbortController(), tool = deferred(); let seen: AbortSignal | undefined;
    const r = new Registry(); r.register({ [phase]: (input: any) => input.callMcpTool("s", "t", {}, new AbortController().signal) });
    const p = observed<unknown>(r[phase](context(c.signal), async (_s, _t, _a, signal) => { seen = signal; await tool.promise; }));
    await flush(); assert.ok(seen); c.abort(); await flush();
    try { assert.equal(seen.aborted, true); assert.equal(p.state.settled, false, "deadline must not release running tools"); }
    finally { tool.resolve(); await p.done; }
  });
  test(`${phase}: discovery finishing after retirement cannot dispatch`, async () => {
    const c = new AbortController(), discovery = deferred(); let dispatches = 0;
    const raw = bridge(c.signal, () => discovery.promise, async () => { dispatches++; return { isError: false }; });
    const r = new Registry(); r.register({ [phase]: (input: any) => input.callMcpTool("s", "t", {}) });
    const p = observed<unknown>(r[phase](context(c.signal), raw)); await flush(); c.abort(); await flush();
    assert.equal(p.state.settled, false, "discovery authority still needs draining"); discovery.resolve(); await p.done;
    assert.equal(dispatches, 0);
  });
  test(`${phase}: display events drain while admitted work remains pending`, async () => {
    const c = new AbortController(), tool = deferred(), queue = new Queue();
    const r = new Registry(); r.register({ [phase]: (input: any) => input.callMcpTool("s", "t", {}) });
    const p = r[phase](context(c.signal), () => tool.promise);
    const wait = compile(`${helper}\nglobalThis.wait=waitForPluginLifecycle;`, { pendingEvents: queue }).wait;
    const iterator = wait(p), first = iterator.next(); await flush(); c.abort(); queue.push({ type: "audit" });
    assert.equal((await first).value.type, "audit"); const next = observed(iterator.next()); await flush();
    try { assert.equal(next.state.settled, false); } finally { tool.resolve(); await next.done; }
  });
  for (const order of ["resolve-abort", "abort-resolve"] as const) test(`${phase}: ${order} in one tick discards revoked result`, async () => {
    const c = new AbortController(), gate = deferred(); const r = new Registry(); r.register({ [phase]: () => gate.promise });
    const p = r[phase](context(c.signal)); await flush();
    if (order === "resolve-abort") { gate.resolve("stale"); c.abort(); } else { c.abort(); gate.resolve("stale"); }
    const result = await p; if (phase === "beforeTurn") assert.equal(result?.length, 0);
  });
  test(`${phase}: unawaited admitted work drains after normal callback completion`, async () => {
    const tool = deferred(), callback = deferred(); const r = new Registry(); let admitted = false;
    r.register({ [phase]: async (input: any) => { void input.callMcpTool("s", "t", {}); await callback.promise; } });
    const p = observed<unknown>(r[phase](context(), async () => { admitted = true; await tool.promise; }));
    await flush(); assert.equal(admitted, true); callback.resolve(); await flush();
    try { assert.equal(p.state.settled, false); } finally { tool.resolve(); await p.done; }
  });
  test(`${phase}: missing handler and synchronous failure remain isolated`, async () => {
    const errors: unknown[] = []; const r = new Registry((...e) => errors.push(e));
    r.register({ [phase === "beforeTurn" ? "afterTurn" : "beforeTurn"]: () => { throw Error("wrong phase"); } });
    await r[phase](context()); assert.equal(errors.length, 0);
    r.register({ [phase]: () => { throw Error("expected"); } }); await r[phase](context()); assert.equal(errors.length, 1);
  });
  test(`${phase}: simultaneous callbacks have independent context fields`, async () => {
    const r = new Registry(); const seen: string[] = [];
    r.register({ [phase]: (input: any) => { input.userMessage = "changed"; } });
    r.register({ [phase]: (input: any) => { seen.push(input.userMessage); } });
    await r[phase](context()); assert.deepEqual(seen, ["hello"]);
  });
}

test("late callback cannot mutate completed outcome or subsequent scope", async () => {
  const c = new AbortController(), gate = deferred(), original = context(c.signal); let retained: any, calls = 0;
  const r = new Registry(); r.register({ afterTurn: async input => { retained = input.callMcpTool; await gate.promise; input.outcome.status = "failed"; input.outcome.affectedTodoIds!.push("late"); } });
  const p = observed(r.afterTurn(original, async () => { calls++; })); await flush(); c.abort(); await flush();
  try { assert.equal(p.state.settled, true); }
  finally { gate.resolve(); await p.done; }
  await r.beforeTurn(context()); await assert.rejects(retained("s", "t", {}));
  assert.equal(calls, 0); assert.equal(original.outcome.status, "completed"); assert.deepEqual(original.outcome.affectedTodoIds, ["a"]);
});

test("actual before-hook wiring emits cancelled terminal, preserving history and avoiding model seam", async () => {
  const block = slice("    const pluginToolSelectionAllowsCalls", "    if (this.activeConfig.agent.toolExecutionMode === \"code_mode\" && runOptions.capabilitySelection?.tools !== \"none\"");
  const c = new AbortController(); c.abort(); const records: any[] = []; let models = 0;
  const r = new Registry(); r.register({ beforeTurn: () => undefined });
  const env = compile(`async function* fixture(){${helper}\n${block}\nmodel();}globalThis.fixture=fixture;`, {
    pendingEvents: new Queue(), runOptions: {}, runPluginLifecycle: true, pluginLifecycle: r, input: "hi", turnPersonalization: context(), abortSignal: c.signal,
    callPluginMcpTool: undefined, systemPrompt: "", messages: [{ role: "user", content: "new" }], messageReferences: ["new"], completedStepsBeforeRun: 2,
    cancelledTurn: (error: string, steps: number) => ({ status: "cancelled", error, steps }), turnCancellationReason: () => "user", doneEvent: (outcome: any) => ({ type: "done", outcome }), model: () => models++
  });
  const owner = { options: { workspaceRoot: "/inert" }, recorder: { sessionId: "s" }, recordError: () => undefined,
    recordCancelledTurn: async (...args: any[]) => { records.push(args); }, contextMemory: { getHistory: () => [{ role: "assistant", content: "old" }] }, contextMessageReferences: ["old"] };
  const events = []; for await (const event of env.fixture.call(owner)) events.push(event);
  assert.equal(models, 0); assert.equal(records[0]?.[0].status, "cancelled"); assert.deepEqual(Array.from(records[0][2]), ["old", "new"]); assert.equal(events.at(-1)?.type, "done");
});

for (const reason of ["turn cancel", "deadline"] as const) test(`actual after-hook wiring: ${reason} retires callback but preserves completed outcome`, async () => {
  const start = "        if (pluginMessages !== undefined) {", end = "      if (content &&";
  const block = slice(start, end), turn = new AbortController(), deadline = new AbortController(), gate = deferred();
  const r = new Registry(); r.register({ afterTurn: () => gate.promise });
  const env = compile(`async function* fixture(){${helper}\nif(true){${block}\nyield {type:'assistant.completed',outcome};}globalThis.fixture=fixture;`, {
    pendingEvents: new Queue(), pluginMessages: [], pluginLifecycle: r, input: "hi", turnPersonalization: context(), outcome: context().outcome,
    abortSignal: turn.signal, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: (ms: number) => { assert.equal(ms, 10_000); return deadline.signal; } }, callPluginMcpTool: undefined
  });
  const iterator = env.fixture.call({ options: { workspaceRoot: "/inert" }, recorder: { sessionId: "s" } });
  const p = observed<any>(iterator.next()); await flush(); (reason === "turn cancel" ? turn : deadline).abort(); await flush();
  try { assert.equal(p.state.settled, true); assert.equal(p.state.result.value.outcome.status, "completed"); }
  finally { gate.resolve(); await p.done; }
});

test("afterTurn simultaneous callbacks cannot rewrite each other's outcome or messages", async () => {
  const r = new Registry(), original = context(); const seen: unknown[] = [];
  r.register({ afterTurn: input => { input.outcome.status = "failed"; input.outcome.affectedTodoIds!.push("changed"); input.messages[0]!.content = "changed"; } });
  r.register({ afterTurn: input => { seen.push(input.outcome.status, [...input.outcome.affectedTodoIds!], input.messages[0]!.content); } });
  await r.afterTurn(original); assert.deepEqual(seen, ["completed", ["a"], "original"]); assert.equal(original.outcome.status, "completed");
});
for (const phase of ["beforeTurn", "afterTurn"] as const) test(`${phase}: listener cleanup also occurs on normal and missing-handler settlement`, async () => {
  for (const missing of [false, true]) {
    const c = new AbortController(); let adds = 0, removes = 0;
    const add = c.signal.addEventListener.bind(c.signal), remove = c.signal.removeEventListener.bind(c.signal);
    c.signal.addEventListener = (...a: Parameters<AbortSignal["addEventListener"]>) => { adds++; add(...a); };
    c.signal.removeEventListener = (...a: Parameters<AbortSignal["removeEventListener"]>) => { removes++; remove(...a); };
    const r = new Registry(); r.register({ [missing ? (phase === "beforeTurn" ? "afterTurn" : "beforeTurn") : phase]: () => undefined });
    await r[phase](context(c.signal)); assert.equal(adds, removes); c.abort();
  }
});
for (const reason of ["turn cancel", "deadline"] as const) test(`actual after-hook wiring: ${reason} cannot release an admitted tool`, async () => {
  const block = slice("        if (pluginMessages !== undefined) {", "      if (content &&"), turn = new AbortController(), deadline = new AbortController(), tool = deferred();
  let seen: AbortSignal | undefined; const r = new Registry(); r.register({ afterTurn: input => input.callMcpTool!("s", "t", {}).then(() => undefined) });
  const env = compile(`async function* fixture(){${helper}\nif(true){${block}\nyield {type:'assistant.completed',outcome};}globalThis.fixture=fixture;`, {
    pendingEvents: new Queue(), pluginMessages: [], pluginLifecycle: r, input: "hi", turnPersonalization: context(), outcome: context().outcome,
    abortSignal: turn.signal, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: () => deadline.signal },
    callPluginMcpTool: async (_s: string, _t: string, _a: unknown, signal: AbortSignal) => { seen = signal; await tool.promise; }
  });
  const iterator = env.fixture.call({ options: { workspaceRoot: "/inert" }, recorder: { sessionId: "s" } });
  const p = observed<any>(iterator.next()); await flush(); assert.ok(seen); (reason === "turn cancel" ? turn : deadline).abort(); await flush();
  try { assert.equal(seen.aborted, true); assert.equal(p.state.settled, false); }
  finally { tool.resolve(); await p.done; }
  assert.equal(p.state.result.value.outcome.status, "completed");
});
