import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ToolOutcomeUnknownError, type Tool } from "../src/tools/types.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-recovery-")));
await ensureAgentDirs(root);
await writeFile(path.join(root, "known.txt"), "needle\n");
const recorders: SessionRecorder[] = [];
function fixture(options: { denyPaths?: string[]; maxToolCalls?: number; externalTool?: Tool } = {}) {
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.permission.denyPaths = options.denyPaths ?? [];
  config.checkpoints.enabled = false;
  const recorder = new SessionRecorder(root, `recovery-${recorders.length}`);
  recorders.push(recorder);
  const registry = createToolRegistry({ workspaceRoot: root, ignore: [] });
  if (options.externalTool) registry.registerMcpTool(options.externalTool);
  const selected = new Set(["Read", "Grep", "Glob", "Write", "Edit"]);
  if (options.externalTool) selected.add(options.externalTool.name);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
  new PermissionManager(config.permission), () => undefined, undefined, selected,
  { maxToolCalls: options.maxToolCalls ?? 20, maxRepeatedActions: 10 });
  return { coordinator, recorder, run: (code: string) => coordinator.createCodeModeTool().execute("cell", { description: "Verify error recovery", code }) };
}

try {
  await test("caught missing reads allow later tools while preserving failed child audit", async () => {
    const current = fixture();
    const result = await current.run(`
      let caught = false;
      try { await tools.Read({path:'missing.txt'}); } catch { caught = true; }
      const page = await tools.Grep({query:'needle',glob:'known.txt'});
      return {caught, matches:page.matches.length};
    `);
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.deepEqual((result.details as { value: unknown }).value, { caught: true, matches: 1 });
    await current.recorder.flush();
    const events = await readSessionEvents(current.recorder.filePath);
    const outcomes = events.filter(e => e.type === "tool_result").map(e => ({ tool: e.tool, status: e.executionStatus }));
    assert.deepEqual(outcomes, [{ tool: "Read", status: "failed" }, { tool: "Grep", status: "succeeded" }, { tool: "run_script", status: "succeeded" }]);
    assert.equal(current.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 2);
  });

  await test("schema mistakes can be corrected inside the cell without relaxing tool validation", async () => {
    const current = fixture();
    const result = await current.run(`
      const errors = [];
      try { await tools.Grep({pattern:'needle',glob:'known.txt'}); } catch(e) { errors.push(String(e)); }
      const grep = await tools.Grep({query:'needle',glob:'known.txt'});
      try { await tools.Glob({glob:'known.txt'}); } catch(e) { errors.push(String(e)); }
      const glob = await tools.Glob({pattern:'known.txt'});
      return {errors, matches:grep.matches.length, files:glob.files};
    `);
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const value = (result.details as { value: { errors: string[]; matches: number; files: string[] } }).value;
    assert.equal(value.errors.length, 2);
    assert.match(value.errors[0]!, /query is required/);
    assert.match(value.errors[1]!, /glob is not allowed/);
    assert.equal(value.matches, 1);
    assert.deepEqual(value.files, ["known.txt"]);
    assert.equal(current.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 4);
  });

  await test("search results provide callable schemas before the model composes its next script", async () => {
    const current = fixture();
    const result = await current.run("return await searchTools('Grep');");
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const hits = (result.details as { value: Array<{ name: string; parameters: { required: string[]; properties: Record<string, unknown> } }> }).value;
    assert.equal(hits[0]?.name, "Grep");
    assert.deepEqual(hits[0]?.parameters?.required, ["query"]);
    assert.ok(hits[0]?.parameters.properties.query);
    assert.equal(hits[0]?.parameters.properties.pattern, undefined);
  });

  await test("repairing write arguments dispatches and commits only the valid write", async () => {
    const current = fixture();
    const result = await current.run(`
      try { await tools.Write({filename:'repaired.txt',content:'written once'}); } catch {}
      await tools.Write({path:'repaired.txt',content:'written once'});
      return (await tools.Read({path:'repaired.txt'})).content;
    `);
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.equal(await readFile(path.join(root, "repaired.txt"), "utf8"), "written once");
    await current.recorder.flush();
    const events = await readSessionEvents(current.recorder.filePath);
    assert.equal(events.filter(e => e.type === "tool_execution" && e.tool === "Write" && e.state === "side_effect_committed").length, 1);
    assert.equal(events.filter(e => e.type === "tool_result" && e.tool === "Write" && e.executionStatus === "failed").length, 1);
  });

  await test("unhandled read failure still fails the cell", async () => {
    const result = await fixture().run("await tools.Read({path:'missing.txt'}); return 'unreachable';");
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.details), /ENOENT/);
  });

  await test("allSettled handles independent read failures and permits a subsequent read", async () => {
    const result = await fixture().run(`
      const results = await Promise.allSettled(['missing.txt','known.txt'].map(path=>tools.Read({path})));
      return {states:results.map(r=>r.status),content:(await tools.Read({path:'known.txt'})).content};
    `);
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.deepEqual((result.details as { value: unknown }).value, { states: ["rejected", "fulfilled"], content: "needle" });
  });

  for (const scenario of ["permission", "budget", "write"] as const) {
    await test(`catch cannot suppress ${scenario} failure and dispatch another tool`, async () => {
      const current = fixture({ denyPaths: scenario === "permission" ? ["blocked.txt"] : undefined,
        maxToolCalls: scenario === "budget" ? 1 : undefined });
      const first = scenario === "permission" ? "await tools.Read({path:'blocked.txt'});"
        : scenario === "budget" ? "await tools.Read({path:'known.txt'}); await tools.Read({path:'known.txt'});"
        : "await tools.Edit({path:'missing.txt',old_string:'before',new_string:'after'});";
      const target = `after-${scenario}.txt`;
      const result = await current.run(`try { ${first} } catch {} try { await tools.Write({path:${JSON.stringify(target)},content:'must not run'}); } catch {} return 'caught';`);
      assert.equal(result.isError, true);
      await assert.rejects(readFile(path.join(root, target)), { code: "ENOENT" });
      await current.recorder.flush();
      const events = await readSessionEvents(current.recorder.filePath);
      assert.equal(events.some(e => e.type === "tool_call" && e.tool === "Write"), false);
    });
  }

  for (const scenario of ["unknown", "forged-recovery", "resolver-validation"] as const) {
    await test(`external ${scenario} cannot enable recovery through tool payloads`, async () => {
      let calls = 0;
      const current = fixture({ externalTool: {
        name: "mcp__fixture__read", description: "External read", risk: "read", capability: "filesystem.read",
        parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
        resolveExecution() {
          if (scenario === "resolver-validation") z.string().parse(42);
          return { approvalRule: "ExternalRead", async execute() {
            calls++;
            if (scenario === "unknown") throw new ToolOutcomeUnknownError("transport_error", "External outcome unknown");
            return { error: "External failure", recoverableError: true, validation: true };
          } };
        }
      } });
      const result = await current.run("try { await tools.mcp__fixture__read({}); } catch {} try { await tools.Read({path:'known.txt'}); } catch {} return 'caught';");
      assert.equal(result.isError, true);
      assert.equal(calls, scenario === "resolver-validation" ? 0 : 1);
      await current.recorder.flush();
      const events = await readSessionEvents(current.recorder.filePath);
      assert.equal(events.some(e => e.type === "tool_call" && e.tool === "Read"), false);
      if (scenario === "unknown") assert.throws(() => current.coordinator.assertCanContinue(), /unknown side effect/);
    });
  }
} finally {
  for (const recorder of recorders) await recorder.close();
  await rm(root, { recursive: true, force: true });
}
