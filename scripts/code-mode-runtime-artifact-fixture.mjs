/** Plain-Node behavioral probe. Every application import is compiled artifact code. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire, register } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  assert.ok(process.argv[index + 1], `${name} requires a value`);
  return process.argv[index + 1];
}

const root = path.resolve(argument("--artifact-root", process.cwd()));
const modulePath = path.resolve(argument("--module", path.join(root, "dist/agent/codeMode.js")));
const results = [];
const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-artifact-runtime-"));
// Even the source checkout fixture must never read or create real user state.
process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
process.env.HOME = path.join(temporary, "home");
process.env.XDG_CONFIG_HOME = path.join(temporary, "config");
delete process.env.BINY_RUNTIME_HOST_ENTRY;

if (process.argv.includes("--deny-external-runtime")) {
  const source = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'run' || specifier.startsWith('run/') || specifier === '@ai-sdk/code-mode' || specifier.startsWith('@ai-sdk/code-mode/')) {
      throw new Error('Artifact attempted external SDK/run resolution: ' + specifier);
    }
    return nextResolve(specifier, context);
  }`;
  register(`data:text/javascript,${encodeURIComponent(source)}`, import.meta.url);
}

try {
  const artifact = await import(pathToFileURL(modulePath).href);
  const executeCodeModeCell = artifact.executeCodeModeCell
    ?? Object.values(artifact).find(value => typeof value === "function" && value.name === "executeCodeModeCell");
  const codeModePolicy = artifact.codeModePolicy
    ?? Object.values(artifact).find(value => value?.hostCallTimeoutMs === 300_000 && value?.maxCellDurationMs === 600_000);
  assert.equal(typeof executeCodeModeCell, "function", "Artifact must expose its compiled cell adapter");
  assert.ok(codeModePolicy, "Artifact must expose its bounded cell policy");
  const policy = { ...codeModePolicy, timeoutMs: 100, hostCallTimeoutMs: 1_000, maxCellDurationMs: 3_000 };
  const value = details => ({ content: [], details });
  const cell = (code, tools = [], extras = {}) => executeCodeModeCell({ code, tools, parentToolCallId: "artifact-fixture",
    isCurrent: () => true, executionPolicy: policy, ...extras });

  if (process.argv.includes("--expect-fail-closed")) {
    let calls = 0;
    const result = await cell("return await tools.Read({});", [{ name: "Read", parameters: { type: "object" },
      execute: async () => { calls++; return value("unreachable"); } }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /execution-time protection is unavailable/u);
    assert.equal(calls, 0, "Unavailable runtime must fail before any host dispatch");
    assert.deepEqual(result.childCalls, []);
    console.log(JSON.stringify({ status: "passed", mode: "fail-closed", modulePath }));
  } else {
    await fixture("compiled adapter completes a plain cell", async () => {
      const result = await cell("return 42;");
      assert.equal(result.ok, true, result.error);
      assert.equal(result.value, 42);
    });

    await fixture("compiled guest cannot access host process, filesystem or network globals", async () => {
      const result = await cell("return [typeof process, typeof require, typeof fetch, typeof Buffer];");
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.value, ["undefined", "undefined", "undefined", "undefined"]);
    });

    await fixture("host wait exceeds VM budget and invokes each child once", async () => {
      let calls = 0;
      const read = { name: "Read", description: "Delayed artifact fixture", parameters: { type: "object" },
        async execute() { const order = ++calls; await delay(250); return value(order); } };
      const result = await cell("const first = await tools.Read({}); return first + await tools.Read({});", [read]);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.value, 3);
      assert.equal(calls, 2);
      assert.equal(result.childCalls.length, 2);
    });

    for (const pendingHost of [false, true]) {
      await fixture(`CPU is bounded${pendingHost ? " with a pending host" : ""}`, async () => {
        let aborted = false;
        const read = { name: "Read", parameters: { type: "object" }, async execute(_id, _args, signal) {
          await abortedBy(signal); aborted = true; throw signal.reason;
        } };
        const ready = { name: "Glob", parameters: { type: "object" }, execute: async () => value(true) };
        const started = performance.now();
        const result = await cell(pendingHost
          ? "await Promise.race([tools.Read({}), tools.Glob({})]); while(true){}" : "while(true){}", pendingHost ? [read, ready] : []);
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /100ms|execution|interrupt|budget/iu);
        assert.ok(performance.now() - started < 2_000, "CPU must stop before the 3000ms whole-cell watchdog");
        assert.equal(result.outcomeUnknown, undefined);
        if (pendingHost) assert.equal(aborted, true);
      });
    }

    await fixture("small CPU slices accumulate across legitimate host waits", async () => {
      const slice = "let sum = 0; for (let i = 0; i < 200000; i++) sum += i;";
      assert.equal((await cell(`${slice} return sum;`)).ok, true);
      let calls = 0;
      const read = { name: "Read", parameters: { type: "object" }, async execute() { calls++; await delay(10); return value(true); } };
      const result = await cell(`for (let j = 0; j < 100; j++) { ${slice} await tools.Read({}); } return 1;`, [read]);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /100ms|execution|interrupt|budget/iu);
      assert.ok(calls >= 2 && calls < 32, `Cumulative CPU must expire before the bridge-count limit; observed ${calls} calls`);
    });

    await fixture("host deadline cancels and does not admit or replay another child", async () => {
      let calls = 0;
      let aborted = false;
      const read = { name: "Read", parameters: { type: "object" }, async execute(_id, _args, signal) {
        calls++; await abortedBy(signal); aborted = true; throw signal.reason;
      } };
      const result = await cell("try { await tools.Read({}); } catch {} return await tools.Read({});", [read],
        { executionPolicy: { ...policy, hostCallTimeoutMs: 150 } });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /host\/approval deadline/u);
      assert.equal(result.outcomeUnknown, undefined);
      assert.equal(aborted, true);
      assert.equal(calls, 1);
    });

    await fixture("parent cancellation reaches the real host operation", async () => {
      const started = deferred();
      const controller = new AbortController();
      let calls = 0;
      let aborted = false;
      const read = { name: "Read", parameters: { type: "object" }, async execute(_id, _args, signal) {
        calls++; started.resolve(); await abortedBy(signal); aborted = true; throw signal.reason;
      } };
      const pending = cell("return await tools.Read({});", [read], { signal: controller.signal });
      await started.promise;
      controller.abort(new Error("artifact parent cancellation"));
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(aborted, true);
      assert.equal(result.outcomeUnknown, undefined);
      assert.equal(calls, 1);
    });

    await fixture("ignored abort preserves unknown outcome and actual settlement", async () => {
      const held = deferred();
      const started = deferred();
      let calls = 0;
      let unsettled = [];
      const read = { name: "Read", parameters: { type: "object" }, async execute() {
        calls++; started.resolve(); return held.promise;
      } };
      const pending = cell("try { await tools.Read({}); } catch {} return await tools.Read({});", [read],
        { executionPolicy: { ...policy, hostCallTimeoutMs: 150 }, onUnsettled: operations => { unsettled = operations; } });
      try {
        await started.promise;
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.outcomeUnknown, true);
        assert.match(result.error, /unknown.*Do not replay/u);
        assert.equal(unsettled.length, 1);
        assert.equal(calls, 1);
        let settled = false;
        unsettled[0].settlement.finally(() => { settled = true; });
        await delay(20);
        assert.equal(settled, false, "Abort must not fabricate host settlement");
        held.resolve(value("late"));
        await Promise.allSettled(unsettled.map(operation => operation.settlement));
        assert.equal(settled, true);
        assert.equal(calls, 1, "Late settlement cannot replay the cell");
      } finally { held.resolve(value("cleanup")); await pending; }
    });

    await fixture("idle guest remains bounded by whole-cell deadline", async () => {
      const result = await cell("return await new Promise(() => {});", [],
        { executionPolicy: { ...policy, maxCellDurationMs: 250 } });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /whole-cell deadline|250ms/u);
      assert.deepEqual(result.childCalls, []);
    });

    await fixture("unawaited bridge is rejected before dispatch", async () => {
      let calls = 0;
      const read = { name: "Read", parameters: { type: "object" }, execute: async () => { calls++; return value("unreachable"); } };
      const result = await cell("tools.Read({}); return 'detached';", [read]);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /unawaited|detached/iu);
      assert.equal(calls, 0);
    });

    await fixture("serialization and policy restrictions still fail closed", async () => {
      const result = await cell("return 'x'.repeat(1000);", [], { executionPolicy: { ...policy, maxResultBytes: 128 } });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /size|byte|limit|large/iu);
      for (const key of ["timeoutMs", "hostCallTimeoutMs", "maxCellDurationMs", "maxResultBytes"]) {
        await assert.rejects(cell("return 1;", [], { executionPolicy: { ...policy, [key]: codeModePolicy[key] + 1 } }),
          new RegExp(`Invalid Code Mode limit: ${key}`, "u"));
      }
    });

    if (!process.argv.includes("--adapter-only")) {
      await fixture("compiled approval gate exceeds VM budget, audits once and blocks late approval", async () => {
        const compiled = relative => import(pathToFileURL(path.join(root, "dist", relative)).href);
        const [{ ToolExecutionCoordinator }, { defaultConfig }, { PermissionManager }, { SessionRecorder }, { ensureAgentDirs }, { ToolRegistry }] = await Promise.all([
          compiled("agent/toolExecutionCoordinator.js"), compiled("config/schema.js"), compiled("permission/PermissionManager.js"),
          compiled("session/recorder.js"), compiled("session/store.js"), compiled("tools/registry.js")]);
        const requireFrom = createRequire(path.join(root, "package.json"));
        const { z } = requireFrom("zod");
        const workspace = path.join(temporary, "approval-workspace");
        await mkdir(workspace, { recursive: true });
        await ensureAgentDirs(workspace);
        const recorder = new SessionRecorder(workspace, "artifact-approval");
        const registry = new ToolRegistry();
        let calls = 0;
        let approvals = 0;
        registry.register({ name: "search_history", description: "Fixture history", risk: "read", capability: "memory.read",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
          schema: z.object({ query: z.string() }), resolveExecution: () => ({ approvalRule: "search_history", execute: async () => { calls++; return { hits: [] }; } }) });
        const config = structuredClone(defaultConfig);
        config.agent.toolExecutionMode = "code_mode";
        config.permission.mode = "ask";
        config.permission.allowTools = [];
        const coordinator = approvalDelay => new ToolExecutionCoordinator({ workspaceRoot: workspace, config, recorder, toolRegistry: registry,
          confirmPermission: async () => { approvals++; await delay(approvalDelay); return { approved: true, scope: "once" }; } },
        new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["search_history"]));
        try {
          const approved = coordinator(250);
          const result = await approved.createCodeModeTool(undefined, policy).execute("artifact-approved", {
            code: "return (await tools.search_history({query:'fixture'})).hits.length;" });
          assert.equal(result.isError, false, JSON.stringify(result.details));
          assert.equal(result.details.value, 0);
          assert.equal(approvals, 1);
          assert.equal(calls, 1);
          await approved.waitForIdle();
          await recorder.flush();
          const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
          assert.equal(events.filter(event => event.type === "tool_call" && event.toolCallId === "artifact-approved:nested:1").length, 1);
          assert.equal(events.filter(event => event.type === "tool_result" && event.toolCallId === "artifact-approved:nested:1" && event.auditOnly).length, 1);
          const late = coordinator(300);
          const timedOut = await late.createCodeModeTool(undefined, { ...policy, hostCallTimeoutMs: 150 }).execute("artifact-approval-deadline", {
            code: "return await tools.search_history({query:'late'});" });
          assert.equal(timedOut.isError, true);
          assert.match(timedOut.details.error, /host\/approval deadline/u);
          await delay(350);
          await late.waitForIdle();
          assert.equal(approvals, 2);
          assert.equal(calls, 1, "Late permission cannot dispatch the cancelled child");
        } finally { await recorder.close(); }
      });
    }

    console.log(JSON.stringify({ status: "passed", mode: "compiled-artifact", modulePath,
      externalRuntimeResolutionDenied: process.argv.includes("--deny-external-runtime"), fixtures: results }));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }

async function fixture(name, operation) {
  const started = performance.now();
  try { await operation(); }
  catch (error) { throw new Error(`Compiled artifact fixture failed: ${name}`, { cause: error }); }
  results.push({ name, elapsedMs: Math.round(performance.now() - started) });
}

function abortedBy(signal) {
  assert.ok(signal, "A real host operation must receive its cancellation signal");
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, { once: true });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
