/** A latched bridge failure is terminal even when its message is empty. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { executeCodeModeCell } from "../src/agent/codeMode.js";
import type { AgentTool } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

function readTool(execute: AgentTool["execute"]): AgentTool {
  return { name: "Read", description: "Disposable host read", parameters: { type: "object" }, execute };
}

for (const returnOnly of [true, false]) {
  await test(`production empty discovery failure remains terminal with ${returnOnly ? "a plain return" : "a later child request"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-failure-presence-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    await ensureAgentDirs(root);
    const registry = new ToolRegistry();
    let calls = 0;
    let preparations = 0;
    registry.registerBuiltinTool({
      name: "Read", description: "Fixture read", risk: "read", capability: "filesystem.read",
      parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
      resolveExecution: () => ({ approvalRule: "Read", async execute() { calls++; return { data: "later" }; } })
    });
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    config.checkpoints.enabled = false;
    config.context.memory.enabled = false;
    const recorder = new SessionRecorder(root, `failure-presence-${String(returnOnly)}`);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
      prepareToolDiscovery: async () => { preparations++; throw new Error(""); } },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["Read"]));
    try {
      const result = await coordinator.createCodeModeTool().execute("empty-discovery", {
        code: `try { await tools.mcp__missing__read({}); } catch {} ${returnOnly ? "return 'caught';" : "return await tools.Read({});"}`
      });
      assert.equal(result.isError, true, "the existence of a bridge failure cannot depend on message truthiness");
      const details = result.details as { ok: boolean; error: string; executionStatus: string; childCalls: unknown[] };
      assert.equal(details.ok, false);
      assert.equal(details.executionStatus, "failed");
      assert.equal(details.error, "", "failure classification preserves the original empty message");
      assert.equal(preparations, 1);
      assert.equal(calls, 0, "the fatal bridge latch prevents another child dispatch");
      assert.deepEqual(details.childCalls, []);
      assert.equal(coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 0);
      await recorder.flush();
      const results = (await readFile(recorder.filePath, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line)).filter((event) => event.type === "tool_result");
      assert.equal(results.length, 1);
      assert.equal(results[0].executionStatus, "failed");
      assert.doesNotThrow(() => coordinator.assertCanContinue(), "a settled known failure is not an unknown side effect");
      const later = await coordinator.createCodeModeTool().execute("fresh-cell", { code: "return (await tools.Read({})).data;" });
      assert.equal(later.isError, false, JSON.stringify(later.details));
      assert.equal((later.details as { value: unknown }).value, "later");
      assert.equal(calls, 1, "the latch belongs only to the failed cell");
      assert.equal(preparations, 1, "a known local tool does not repeat failed discovery");
    } finally {
      await coordinator.waitForIdle();
      await recorder.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [name, failure] of [["empty Error", new Error("")], ["empty thrown string", ""], ["nonempty Error", new Error("Fixture failure")]] as const) {
  for (const bridge of ["target", "prepare", "search"] as const) {
    await test(`${bridge}: ${name} blocks another bridge after the guest catches it`, async () => {
      let calls = 0;
      let failures = 0;
      let unsettled = 0;
      const read = readTool(async () => {
        calls++;
        if (bridge === "target" && calls === 1) { failures++; throw failure; }
        return { content: [], details: "later" };
      });
      const first = bridge === "target" ? "tools.Read({})" : bridge === "prepare" ? "tools.mcp__missing__read({})" : "searchTools('read')";
      const result = await executeCodeModeCell({
        code: `try { await ${first}; } catch {} return await tools.Read({});`,
        parentToolCallId: `${bridge}-${name}`, tools: [read], isCurrent: () => true,
        prepareTools: bridge === "prepare" ? async () => { failures++; throw failure; } : undefined,
        searchTools: bridge === "search" ? async () => { failures++; throw failure; } : undefined,
        onUnsettled: () => { unsettled++; }
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, failure instanceof Error ? failure.message : failure);
      assert.equal(failures, 1);
      assert.equal(calls, bridge === "target" ? 1 : 0);
      assert.equal(result.childCalls.length, bridge === "target" ? 1 : 0);
      assert.equal(result.outcomeUnknown, undefined);
      assert.equal(unsettled, 0);
    });
  }
}

await test("an empty bridge failure remains recorded when the guest returns without another request", async () => {
  const result = await executeCodeModeCell({ code: "try { await tools.Read({}); } catch {} return 'caught';",
    parentToolCallId: "empty-final-result", tools: [readTool(async () => { throw new Error(""); })], isCurrent: () => true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "");
  assert.equal(result.childCalls.length, 1);
});

await test("successful empty-string output does not create a failure latch", async () => {
  let calls = 0;
  const result = await executeCodeModeCell({ code: "const first = await tools.Read({}); const second = await tools.Read({}); return [first, second];",
    parentToolCallId: "empty-success", tools: [readTool(async () => { calls++; return { content: [], details: "" }; })], isCurrent: () => true });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, ["", ""]);
  assert.equal(calls, 2);
  assert.equal(result.childCalls.length, 2);
});
