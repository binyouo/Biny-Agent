import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig, type HookConfig, type HooksConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolAccesses } from "../src/tools/access.js";
import { HookRunner } from "../src/tools/hooks.js";
import { ToolRegistry } from "../src/tools/registry.js";

const context = { tool: "hook_probe", path: "artifact.txt" };
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const hook = (command: string, timeoutMs = 5_000): HookConfig => ({ command, tools: [], extensions: [], timeoutMs });
const hooks = (overrides: Partial<HooksConfig>): HooksConfig => ({ beforeTool: [], afterTool: [], ...overrides });

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-hooks-cancellation-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try {
    await run(root);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function waitingHook(root: string): Promise<{ command: string; readyPath: string }> {
  const readyPath = path.join(root, "hook-ready");
  const script = path.join(root, "waiting-hook.mjs");
  await writeFile(script, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
    "setInterval(() => undefined, 1000);"
  ].join("\n"));
  return { command: `${shellQuote(process.execPath)} ${shellQuote(script)}`, readyPath };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Hook did not reach its ready boundary: ${filePath}`);
}

for (const reason of [undefined, new Error("stop before hooks"), "stop before hooks"]) {
  await test(`an already-aborted hook run preserves ${reason === undefined ? "the default" : typeof reason} abort reason`, async () => {
    await withWorkspace(async (root) => {
      const controller = new AbortController();
      controller.abort(reason);
      const runner = new HookRunner(root, hooks({ beforeTool: [hook("printf unexpected > started")] }));
      await assert.rejects(runner.run("beforeTool", context, controller.signal), (error) => error === controller.signal.reason);
      await assert.rejects(access(path.join(root, "started")), { code: "ENOENT" });
    });
  });
}

for (const event of ["beforeTool", "afterTool"] as const) {
  await test(`${event} cancellation during a real shell propagates and stops the hook sequence`, async () => {
    await withWorkspace(async (root) => {
      const { command, readyPath } = await waitingHook(root);
      const controller = new AbortController();
      const reason = new Error(`cancel ${event}`);
      const runner = new HookRunner(root, hooks({ [event]: [hook(command), hook("printf unexpected > later-hook")] }));
      const run = runner.run(event, context, controller.signal);
      const rejected = assert.rejects(run, (error) => error === reason);
      try {
        await waitForFile(readyPath);
      } finally {
        controller.abort(reason);
      }
      await rejected;
      await assert.rejects(access(path.join(root, "later-hook")), { code: "ENOENT" });
    });
  });
}

await test("ordinary failures retain their result and do not change multi-hook ordering", async () => {
  await withWorkspace(async (root) => {
    const runner = new HookRunner(root, hooks({ beforeTool: [
      hook("printf first >> order; printf first"),
      hook("printf second >> order; printf 'ordinary failure' >&2; exit 3"),
      hook("printf third >> order; printf third")
    ] }));
    const outcomes = await runner.run("beforeTool", context);
    assert.deepEqual(outcomes.map(({ exitCode, output }) => ({ exitCode, output })), [
      { exitCode: 0, output: "first" },
      { exitCode: 3, output: "ordinary failure" },
      { exitCode: 0, output: "third" }
    ]);
    assert.equal(await readFile(path.join(root, "order"), "utf8"), "firstsecondthird");
  });
});

await test("a real hook timeout remains exit 124 with its timeout diagnostic", async () => {
  await withWorkspace(async (root) => {
    const { command } = await waitingHook(root);
    const runner = new HookRunner(root, hooks({ beforeTool: [hook(command, 200)] }));
    const [outcome] = await runner.run("beforeTool", context);
    assert.equal(outcome?.exitCode, 124);
    assert.match(outcome?.output ?? "", /timed out after 200ms/u);
  });
});

await test("late abort leaves an already-settled successful hook result unchanged", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    const runner = new HookRunner(root, hooks({ afterTool: [hook("printf settled")] }));
    const outcomes = await runner.run("afterTool", context, controller.signal);
    controller.abort("late cancellation");
    assert.deepEqual(outcomes, [{ command: "printf settled", exitCode: 0, output: "settled" }]);
  });
});

for (const event of ["beforeTool", "afterTool"] as const) {
  await test(`the production coordinator preserves the ${event === "beforeTool" ? "cancelled pre-tool" : "successful external-tool"} outcome`, async () => {
    await withWorkspace(async (root) => {
      const { command, readyPath } = await waitingHook(root);
      const config = structuredClone(defaultConfig);
      config.permission.mode = "full-access";
      config.permission.denyPaths = [];
      config.diagnostics.enabled = false;
      config.hooks[event] = [hook(command), hook("printf unexpected > later-hook")];
      await ensureAgentDirs(root);
      const recorder = new SessionRecorder(root, `cancel-${event}`);
      const registry = new ToolRegistry();
      let executed = 0;
      registry.registerPluginTool({
        name: context.tool,
        description: "Hook cancellation regression probe",
        risk: "write",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        schema: { parse: (value) => value },
        resolveExecution: () => ({
          approvalRule: context.tool,
          accesses: ToolAccesses.writeTree(root),
          retrySafety: "unsafe",
          async execute() {
            executed += 1;
            await writeFile(path.join(root, "operation-committed"), "committed");
            return { status: "completed", exitCode: 0, output: "committed" };
          }
        })
      });
      const coordinator = new ToolExecutionCoordinator(
        { workspaceRoot: root, config, recorder, toolRegistry: registry },
        new PermissionManager(config.permission), () => {}
      );
      const controller = new AbortController();
      const reason = new Error(`stop in ${event}`);
      try {
        const tool = coordinator.createAgentTools().find((entry) => entry.name === context.tool);
        assert.ok(tool);
        const pending = tool.execute(`call-${event}`, {}, controller.signal);
        try {
          await waitForFile(readyPath);
        } finally {
          controller.abort(reason);
        }
        const response = await pending;
        await coordinator.waitForIdle();
        await recorder.flush();
        const result = response.details as Record<string, unknown>;
        const events = await readSessionEvents(recorder.filePath);
        const resultEvent = events.find((entry) => entry.type === "tool_result");
        assert.equal(resultEvent?.type, "tool_result");
        if (resultEvent?.type !== "tool_result") assert.fail("Missing durable result");
        if (event === "beforeTool") {
          assert.equal(executed, 0);
          assert.equal(response.isError, true);
          assert.equal(result.status, "cancelled", "a cancelled hook must not invent a hook denial");
          assert.match(String(result.error), /was aborted: stop in beforeTool/u);
          assert.equal(resultEvent.executionStatus, "cancelled");
          assert.equal(events.some((entry) => entry.type === "tool_execution" && entry.state === "admitted"), false);
          await assert.rejects(access(path.join(root, "operation-committed")), { code: "ENOENT" });
        } else {
          assert.equal(executed, 1);
          assert.equal(response.isError, false);
          assert.equal(result.status, "completed");
          assert.equal(result.exitCode, 0);
          assert.equal(result.output, "committed");
          assert.equal(resultEvent.executionStatus, "succeeded", "afterTool cancellation cannot erase a confirmed external side effect");
          assert.equal(await readFile(path.join(root, "operation-committed"), "utf8"), "committed");
        }
        assert.equal(Object.hasOwn(result, "hooks"), false, "cancellation must not fabricate hook failure results");
        await assert.rejects(access(path.join(root, "later-hook")), { code: "ENOENT" });
      } finally {
        controller.abort(reason);
        await coordinator.waitForIdle();
        await recorder.close();
      }
    });
  });
}
