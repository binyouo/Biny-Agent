import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { acpConfigSchema } from "../src/acp/config.js";
import { loadSubagentDefinitions } from "../src/extensions/agents.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";

test("named ACP worker uses its own model, persists a child result and never resolves a native model", { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-external-worker-")));
  const config = structuredClone(defaultConfig);
  config.providers.external = { type: "acp", acp: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] }) };
  config.models.external = { provider: "external", model: "test" };
  config.defaultModel = "external";
  config.extensions.subagent.enabled = true;
  config.permission.mode = "full-access";
  config.permission.denyPaths = [];
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  config.heartbeat.enabled = false;
  config.checkpoints.enabled = false;
  await mkdir(path.join(root, ".biny/agents"), { recursive: true });
  await writeFile(path.join(root, ".biny/agents/coder.md"), "---\nname: coder\ndescription: External coder\nruntime: acp\nmodel: external\n---\nReport the result.");
  let runtime: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
  try {
    const definitions = await loadSubagentDefinitions({ workspaceRoot: root, projectPaths: [".biny/agents"], globalRoot: path.join(root, "empty") });
    assert.equal((definitions[0] as unknown as { runtime: string }).runtime, "acp");
    runtime = await createCommandRuntime(root, { configStore: { load: async () => configSchema.parse(config), save: async () => undefined } });
    const record = runtime.taskRuns.create({ sessionId: runtime.agent.getInfo().sessionId, task: { prompt: "finite inspection", agent: "coder", communication: true } });
    const result = await (await runtime.startTaskRun(record.taskRunId)).completion;
    assert.equal(result.status, "completed");
    const stored = runtime.taskRuns.get(record.taskRunId)!;
    assert.equal(stored.status, "completed");
    assert.match(JSON.stringify(stored.attempts.at(-1)?.artifacts), /Reply 1/);
    const requests = await readFile(path.join(root, "requests.jsonl"), "utf8");
    assert.match(requests, /finite inspection/);
    assert.match(requests, /Report the result/);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

// CLI fixtures speak the real stdout protocols; no model API or user credentials are used.
for (const kind of ["codex", "claude-code"] as const) {
  test(`${kind} worker passes its model and stdin task, and requires a successful terminal event`, { timeout: 10000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-cli-worker-")));
    const previousPath = process.env.PATH;
    try {
      const executable = path.join(root, kind === "codex" ? "codex" : "claude");
      await writeFile(executable, `#!${process.execPath}\n` + `
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), prompt, injected: process.env.BINY_SECRET_TEST }));
  if (prompt.includes('crash-fixture')) process.exit(7);
  if (prompt.includes('denied-fixture')) {
    console.log(JSON.stringify(process.argv.includes('exec') ? { type: 'turn.failed', error: { message: 'denied' } } : { type: 'result', subtype: 'success', is_error: false, result: 'not done', permission_denials: [{}] }));
    return;
  }
  if (prompt.includes('missing-terminal')) { console.log(JSON.stringify({ type: 'system' })); return; }
  if (process.argv.includes('exec')) {
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'pwd', aggregated_output: 'workspace', exit_code: 1, status: 'failed' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'CLI result' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }));
  } else {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'pwd' } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'workspace', is_error: true }] } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CLI result' }));
  }
});\n`, { mode: 0o700 });
      process.env.PATH = `${root}${path.delimiter}${previousPath}`;
      process.env.BINY_SECRET_TEST = "must-not-inherit";
      const { runSubagentTask } = await import("../src/extensions/subagent.js");
      const { ToolRegistry } = await import("../src/tools/registry.js");
      const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] },
        extensions: { ...defaultConfig.extensions, subagent: { enabled: true, runtime: kind, model: "test-model" } } });
      const options = { workspaceRoot: root, config, toolRegistry: new ToolRegistry(), getModelSettings: () => { throw new Error("native model must not be resolved"); } };
      assert.equal(await runSubagentTask(options, "finite task", undefined, "workspace", undefined, { taskId: "cli-worker", persistenceRoot: root }), "CLI result");
      const { readSessionEvents } = await import("../src/session/events.js");
      const { sessionFilePath } = await import("../src/session/store.js");
      const { workerSessionId } = await import("../src/runtime/WorkerSession.js");
      const events = await readSessionEvents(sessionFilePath(root, workerSessionId("cli-worker")));
      assert.ok(events.some(event => event.type === "tool_call"));
      assert.ok(events.some(event => event.type === "tool_result" && event.executionStatus === "failed" && JSON.stringify(event.result).includes("workspace")), "a failed external tool stays failed even when the worker subsequently completes");
      const invocation = JSON.parse(await readFile(path.join(root, "invocation.json"), "utf8"));
      assert.ok(invocation.args.includes("test-model"));
      assert.match(invocation.prompt, /finite task/);
      assert.equal(invocation.injected, undefined);
      assert.ok(!invocation.args.some((arg: string) => arg.includes("dangerously")));
      await assert.rejects(runSubagentTask(options, "missing-terminal", undefined, "workspace"), /terminal/);
      await assert.rejects(runSubagentTask(options, "crash-fixture", undefined, "workspace"), /code 7/);
      await assert.rejects(runSubagentTask(options, "denied-fixture", undefined, "workspace"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed turn|permission_denied/);
        if (kind === "codex") assert.notEqual(error.name, "SubagentTaskIncompleteError", "provider failure must remain failed, not incomplete");
        return true;
      });
    } finally {
      process.env.PATH = previousPath;
      delete process.env.BINY_SECRET_TEST;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("external worker admission rejects restrictions before launching a process", async () => {
  const { prepareSubagentTask } = await import("../src/extensions/subagent.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const base = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] },
    extensions: { ...defaultConfig.extensions, subagent: { enabled: true, runtime: "codex", model: "test-model" } } });
  for (const [change, expected] of [
    [(c: typeof base) => { c.permission.mode = "ask"; }, /full-access/],
    [(c: typeof base) => { c.permission.denyPaths = ["secret"]; }, /denyPaths/],
    [(c: typeof base) => { c.sandbox.allowNetwork = false; }, /sandbox/],
    [(c: typeof base) => { c.extensions.subagent.maxSteps = 2; }, /budgets/],
    [(c: typeof base) => { c.extensions.subagent.maxCostUsd = 1; }, /budgets/]
  ] as const) {
    const config = structuredClone(base); change(config);
    await assert.rejects(prepareSubagentTask({ workspaceRoot: os.tmpdir(), config, toolRegistry: new ToolRegistry(), getModelSettings: () => { throw new Error("native"); } }, "task", "workspace"), expected);
  }
  await assert.rejects(prepareSubagentTask({ workspaceRoot: os.tmpdir(), config: base, toolRegistry: new ToolRegistry(), getModelSettings: () => { throw new Error("native"); } }, "task", "workspace", undefined,
    { taskId: "old", persistenceRoot: os.tmpdir(), resume: true }), /not replayed/);
});

test("closing a running external worker kills its process before releasing the worker", { timeout: 8000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-cli-cancel-")));
  const previousPath = process.env.PATH;
  try {
    await writeFile(path.join(root, "codex"), `#!${process.execPath}\nrequire('node:fs').writeFileSync('pid', String(process.pid));process.on('SIGTERM', () => {});setInterval(() => {}, 1000);`, { mode: 0o700 });
    process.env.PATH = `${root}${path.delimiter}${previousPath}`;
    const { prepareSubagentTask } = await import("../src/extensions/subagent.js");
    const { ToolRegistry } = await import("../src/tools/registry.js");
    const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] },
      extensions: { ...defaultConfig.extensions, subagent: { enabled: true, runtime: "codex", model: "test-model", inactivityTimeoutMs: 5000 } } });
    const worker = await prepareSubagentTask({ workspaceRoot: root, config, toolRegistry: new ToolRegistry(), getModelSettings: () => { throw new Error("native"); } }, "task", "workspace");
    const result = worker.run().then(() => "completed", () => "cancelled");
    let pid: number | undefined;
    const deadline = Date.now() + 2000;
    while (!pid && Date.now() < deadline) {
      try { pid = Number(await readFile(path.join(root, "pid"), "utf8")); }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(pid, "process must start within the bounded fixture deadline");
    const start = Date.now();
    await worker.close();
    assert.ok(Date.now() - start < 2000, "close must cancel the process, not wait for inactivity timeout");
    assert.equal(await result, "cancelled");
    assert.throws(() => process.kill(pid!, 0), /ESRCH/);
  } finally { process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
});
