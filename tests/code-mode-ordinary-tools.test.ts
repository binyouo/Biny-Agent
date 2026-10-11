import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { codeModePolicy } from "../src/agent/codeMode.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, AgentToolResult, ModelStreamEvent } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createToolRegistry } from "../src/tools/registry.js";
import type { EditingMode } from "../src/tools/file/editingMode.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-ordinary-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
await ensureAgentDirs(root);
const recorders: SessionRecorder[] = [];

function fixture(options: { selected?: string[]; ask?: () => Promise<{ approved: boolean; scope: "once" }>; onEvent?: (event: AgentSessionEvent) => void; concurrency?: number; processes?: ManagedProcessService } = {}) {
  const config = structuredClone(defaultConfig);
  config.permission.mode = options.ask ? "ask" : "full-access";
  config.permission.denyPaths = [];
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  config.agent.maxConcurrentTools = options.concurrency ?? 1;
  const registry = createToolRegistry({ workspaceRoot: root, ignore: [] }, undefined, options.processes);
  const recorder = new SessionRecorder(root, `ordinary-${recorders.length}`);
  recorders.push(recorder);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, confirmPermission: options.ask },
    new PermissionManager(config.permission), options.onEvent ?? (() => undefined), undefined, new Set(options.selected ?? ["Read", "Write", "Edit", "Bash", "ToolSearch"]),
    { maxToolCalls: 20, maxRepeatedActions: 10 });
  const call = async (mode: "direct" | "code_mode", name: string, args: Record<string, unknown>, editing: EditingMode = "replace", signal?: AbortSignal): Promise<AgentToolResult> => {
    const id = `${mode}-${name}-${recorders.length}`;
    return mode === "direct"
      ? await coordinator.createAgentTools({ mode: editing }).find((tool) => tool.name === name)!.execute(id, args, signal)
      : await coordinator.createCodeModeTool({ mode: editing }).execute(id, { code: `return await tools.${name}(${JSON.stringify(args)});` }, signal);
  };
  return { config, registry, recorder, coordinator, call };
}

try {
  await test("script Write and Edit use real file commits and persisted child events, matching direct calls", { timeout: 15_000 }, async () => {
    for (const mode of ["direct", "code_mode"] as const) {
      const current = fixture();
      const file = `${mode}.txt`;
      const created = await current.call(mode, "Write", { path: file, content: "before\n" });
      assert.equal(created.isError, false, JSON.stringify(created.details));
      const edited = await current.call(mode, "Edit", { path: file, old_string: "before", new_string: "after" });
      assert.equal(edited.isError, false, JSON.stringify(edited.details));
      assert.equal(await readFile(path.join(root, file), "utf8"), "after\n");
      const events = await readSessionEvents(current.recorder.filePath);
      for (const name of ["Write", "Edit"]) {
        const commits = events.filter((event) => event.type === "tool_execution" && event.tool === name && event.state === "side_effect_committed");
        assert.equal(commits.length, 1);
        assert.ok(events.some((event) => event.type === "tool_result" && event.tool === name && event.operationId && event.auditOnly === (mode === "code_mode")));
      }
      assert.equal(current.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 2);
    }
  });
  await test("script Patch keeps both editing grants and rejects a revoked Edit while approval is pending", { timeout: 15_000 }, async () => {
    const current = fixture();
    const operation = { type: "create_file", path: "patch.txt", diff: "+patched\n" };
    const result = await current.call("code_mode", "apply_patch", { operation }, "patch");
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.equal(await readFile(path.join(root, "patch.txt"), "utf8"), "patched");
    const restricted = fixture({ selected: ["Write"] });
    const unavailable = await restricted.call("code_mode", "apply_patch", { operation: { ...operation, path: "restricted.txt" } }, "patch");
    assert.equal(unavailable.isError, true);
    await assert.rejects(readFile(path.join(root, "restricted.txt")), { code: "ENOENT" });
    const revoked = fixture({ ask: async () => {
      revoked.registry.unregister("Edit");
      return { approved: true, scope: "once" };
    } });
    const denied = await revoked.call("code_mode", "apply_patch", { operation: { ...operation, path: "revoked.txt" } }, "patch");
    assert.equal(denied.isError, true);
    await assert.rejects(readFile(path.join(root, "revoked.txt")), { code: "ENOENT" });
  });
  await test("script Patch discovery presents the routed schema without a model-supplied dispatch id", { timeout: 15_000 }, async () => {
    const current = fixture();
    const result = await current.coordinator.createCodeModeTool({ mode: "patch" }).execute("patch-discovery", { code:
      "return {matches:await searchTools('apply_patch'),schema:await describeTool('apply_patch')};" });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const value = (result.details as { value: { matches: { name: string }[]; schema: { promptGuidelines?: string[]; parameters: { required: string[]; properties: Record<string, unknown> } } } }).value;
    assert.deepEqual(value.matches.map((tool) => tool.name), ["apply_patch"]);
    assert.deepEqual(value.schema.parameters.required, ["operation"]);
    assert.equal(Object.hasOwn(value.schema.parameters.properties, "callId"), false);
    assert.match(value.schema.promptGuidelines?.join("\n") ?? "", /Read before updating/u);
  });
  await test("script Bash executes commands and cancellation kills the process while preserving unknown effects", { timeout: 15_000 }, async () => {
    const current = fixture();
    const command = "printf 'shell output'";
    const result = await current.call("code_mode", "Bash", { command });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.equal((result.details as { value: { stdout: string; exitCode: number } }).value.stdout, "shell output");
    assert.equal((result.details as { value: { exitCode: number } }).value.exitCode, 0);
    for (const mode of ["direct", "code_mode"] as const) {
      const controller = new AbortController();
      let childPid: number | undefined;
      const cancelled = fixture({ onEvent: (event) => {
        const match = event.type === "tool.progress" && event.tool === "Bash" ? /READY:(\d+)/u.exec(event.update.text) : null;
        if (match) {
          childPid = Number(match[1]);
          controller.abort();
        }
      } });
      const output = await cancelled.call(mode, "Bash", { command: "printf 'READY:%s\\n' \"$$\"; exec sleep 30", timeoutMs: 5_000 }, "replace", controller.signal);
      assert.ok(childPid);
      assert.equal(output.isError, true);
      await cancelled.coordinator.waitForIdle();
      const events = await readSessionEvents(cancelled.recorder.filePath);
      assert.throws(() => process.kill(childPid!, 0), { code: "ESRCH" });
      assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "Bash" && event.executionStatus === "unknown"));
      const next = await cancelled.call("code_mode", "Write", { path: "after-unknown.txt", content: "must not run" });
      assert.equal(next.isError, true);
      await assert.rejects(readFile(path.join(root, "after-unknown.txt")), { code: "ENOENT" });
    }
  });
  await test("script discovery exposes ordinary query schemas and executes WidgetReadme", { timeout: 15_000 }, async () => {
    const current = fixture({ selected: ["WebFetch", "WidgetReadme", "ChromeRelayListTabs"] });
    const result = await current.coordinator.createCodeModeTool().execute("ordinary-queries", { code: `
      const names = ['WebFetch', 'WidgetReadme', 'ChromeRelayListTabs'];
      const schemas = await Promise.all(names.map(name => describeTool(name)));
      const readme = await tools.WidgetReadme({});
      return {schemas, readme};
    ` });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const value = (result.details as { value: { schemas: unknown[]; readme: unknown } }).value;
    assert.equal(value.schemas.filter(Boolean).length, 3);
    assert.match(JSON.stringify(value.readme), /widget/iu);
  });
  await test("script background Bash chains its real process id into output and process-group cleanup", { timeout: 15_000 }, async () => {
    const processes = new ManagedProcessService({ workspaceRoot: root });
    const current = fixture({ processes, selected: ["Bash", "BashOutput", "KillShell"] });
    try {
      const result = await current.coordinator.createCodeModeTool().execute("background-chain", { code: `
        const started = await tools.Bash({command:'printf BACKGROUND_READY; exec sleep 30',background:true,readiness:{type:'log',pattern:'BACKGROUND_READY',timeoutMs:5000}});
        const processId = started.process.processId;
        const output = await tools.BashOutput({processId});
        const stopped = await tools.KillShell({processId});
        return {pid:started.process.pid,output:output.output.content,state:stopped.state,cleanup:stopped.cleanup.status};
      ` });
      assert.equal(result.isError, false, JSON.stringify(result.details));
      const value = (result.details as { value: { pid: number; output: string; state: string; cleanup: string } }).value;
      assert.match(value.output, /\nBACKGROUND_READY$/u);
      assert.equal(value.state, "stopped");
      assert.equal(value.cleanup, "stopped");
      assert.throws(() => process.kill(value.pid, 0), { code: "ESRCH" });
    } finally { await processes.close(); }
  });
  await test("script Read and Edit retain Hashline anchors and reject a reused stale anchor", { timeout: 15_000 }, async () => {
    const current = fixture();
    await writeFile(path.join(root, "hashline.txt"), "original\nuntouched\n");
    const result = await current.coordinator.createCodeModeTool({ mode: "hashline" }).execute("hashline-edit", { code: `
      const read = await tools.Read({path:'hashline.txt'});
      const pos = read.content.split(':')[0];
      await tools.Edit({operation:'update',path:'hashline.txt',edits:[{op:'replace',pos,lines:['changed']}]});
      await tools.Edit({operation:'update',path:'hashline.txt',edits:[{op:'replace',pos,lines:['stale overwrite']}]});
    ` });
    assert.equal(result.isError, true);
    assert.equal((result.details as { childCalls: unknown[] }).childCalls.length, 3);
    assert.equal(await readFile(path.join(root, "hashline.txt"), "utf8"), "changed\nuntouched\n");
  });
  await test("script Bash can reduce full stdout but still enforces the bridge output limit", { timeout: 15_000 }, async () => {
    await writeFile(path.join(root, "stdout.cjs"), "process.stdout.write('x'.repeat(20000));");
    const command = `'${process.execPath.replaceAll("'", "'\\''")}' stdout.cjs`;
    const current = fixture();
    const code = `const result = await tools.Bash(${JSON.stringify({ command })}); return result.stdout.length;`;
    const reduced = await current.coordinator.createCodeModeTool().execute("shell-reduced", { code });
    assert.equal(reduced.isError, false, JSON.stringify(reduced.details));
    assert.equal((reduced.details as { value: number }).value, 20_000);
    const limited = await fixture().coordinator.createCodeModeTool(undefined, { ...codeModePolicy, maxToolOutputBytes: 1024 }).execute("shell-limited", { code });
    assert.equal(limited.isError, true);
    assert.match((limited.details as { error: string }).error, /size|byte|limit|large/iu);
  });
  await test("direct and script file and shell calls cannot perform effects after permission denial", { timeout: 15_000 }, async () => {
    for (const mode of ["direct", "code_mode"] as const) {
      for (const name of ["Write", "Edit", "apply_patch", "Bash"] as const) {
        const file = `denied-${mode}-${name}.txt`;
        await writeFile(path.join(root, file), "unchanged");
        let approvals = 0;
        const current = fixture({ ask: async () => { approvals++; return { approved: false, scope: "once" }; } });
        const args = name === "Write" ? { path: file, content: "changed" }
          : name === "Edit" ? { path: file, old_string: "unchanged", new_string: "changed" }
          : name === "apply_patch" ? { callId: `${mode}-${name}-${recorders.length}`, operation: { type: "update_file", path: file, diff: "@@\n-unchanged\n+changed" } }
          : { command: `printf changed > ${file}` };
        const result = await current.call(mode, name, args, name === "apply_patch" ? "patch" : "replace");
        assert.equal(result.isError, true);
        assert.equal(approvals, 1, JSON.stringify(result.details));
        assert.equal(await readFile(path.join(root, file), "utf8"), "unchanged");
        const events = await readSessionEvents(current.recorder.filePath);
        assert.equal(events.some((event) => event.type === "tool_execution" && event.state === "admitted"), false);
      }
    }
  });
  await test("script selection and control boundaries reject unselected Bash, hidden tools, session controls and recursive exec", { timeout: 15_000 }, async () => {
    const current = fixture({ selected: ["Read", "Write", "AskUserQuestion", "GoalUpdate", "Skill", "Task", "PlanUpdate", "exec"] });
    let effects = 0;
    for (const name of ["AskUserQuestion", "GoalUpdate", "Skill", "Task", "PlanUpdate", "exec"]) {
      current.registry.register({ name, description: "Fixture control", risk: "read", parameters: { type: "object", properties: {} },
        resolveExecution: () => ({ approvalRule: name, async execute() { effects++; return {}; } }) });
    }
    current.registry.get("Write").exposure = "hidden";
    for (const name of ["Bash", "Write", "AskUserQuestion", "GoalUpdate", "Skill", "Task", "PlanUpdate", "exec"]) {
      const result = await current.call("code_mode", name, name === "Bash" ? { command: "printf forbidden > unselected.txt" } : {});
      assert.equal(result.isError, true);
      assert.deepEqual((result.details as { childCalls: unknown[] }).childCalls, []);
    }
    assert.equal(effects, 0);
    await assert.rejects(readFile(path.join(root, "unselected.txt")), { code: "ENOENT" });
  });
  await test("script edits reject stale approval previews and conflicting concurrent replacements without overwriting", { timeout: 15_000 }, async () => {
    for (const mode of ["direct", "code_mode"] as const) {
      const file = `stale-${mode}.txt`;
      await writeFile(path.join(root, file), "base");
      const current = fixture({ ask: async () => {
        await writeFile(path.join(root, file), "external edit");
        return { approved: true, scope: "once" };
      } });
      const result = await current.call(mode, "Edit", { path: file, old_string: "base", new_string: "agent edit" });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.details), /changed after the permission preview/u);
      assert.equal(await readFile(path.join(root, file), "utf8"), "external edit");
    }
    await writeFile(path.join(root, "conflict.txt"), "base");
    const current = fixture({ concurrency: 4 });
    await current.coordinator.createCodeModeTool().execute("conflicting-edits", { code: `
      return await Promise.allSettled(['first', 'second'].map(new_string => tools.Edit({path:'conflict.txt',old_string:'base',new_string})));
    ` });
    const events = await readSessionEvents(current.recorder.filePath);
    assert.equal(events.filter((event) => event.type === "tool_execution" && event.tool === "Edit" && event.state === "side_effect_committed").length, 1);
    assert.ok(["first", "second"].includes(await readFile(path.join(root, "conflict.txt"), "utf8")));
    assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "Edit" && event.executionStatus === "failed").length, 1);
  });
  await test("AgentSession keeps ordinary tools alongside exec and persists a partial write once without replaying it", { timeout: 20_000 }, async () => {
    const current = fixture();
    let steps = 0;
    const model: AgentModel = { provider: "fixture", modelId: "ordinary-code-mode", supportsTools: true,
      async stream(context) {
        steps++;
        assert.ok(context.tools.some((tool) => tool.name === "Write"));
        assert.ok(context.tools.some((tool) => tool.name === "exec"));
        let response: ModelStreamEvent[];
        if (steps === 1) response = [
          { type: "tool-call", id: "partial-write", name: "exec", arguments: { code: "await tools.Write({path:'partial.txt',content:'committed once'}); throw new Error('stop after commit');" } },
          { type: "finish", reason: "tool-calls" }
        ];
        else {
          assert.equal(steps, 2);
          const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "partial-write");
          assert.ok(result && result.role === "toolResult" && result.isError);
          assert.match(JSON.stringify(result), /stop after commit/u);
          response = [{ type: "text-delta", text: "The first write completed; the script then failed." }, { type: "finish", reason: "stop" }];
        }
        return (async function* () { yield* response; })();
      }
    };
    const agent = new AgentSession({ workspaceRoot: root, config: current.config, model, toolRegistry: current.registry,
      permissionManager: new PermissionManager(current.config.permission), recorder: current.recorder });
    try {
      await agent.initialize();
      const outcome = await agent.runTask("Write the fixture once", { capabilitySelection: { tools: ["Write", "Edit", "Read", "Bash"], skills: "none" }, emotionAnalysis: false });
      assert.equal(outcome.status, "completed", outcome.error);
      assert.equal(steps, 2);
      assert.equal(await readFile(path.join(root, "partial.txt"), "utf8"), "committed once");
      const events = await readSessionEvents(current.recorder.filePath);
      assert.equal(events.filter((event) => event.type === "tool_execution" && event.tool === "Write" && event.state === "side_effect_committed").length, 1);
      const replay = replaySessionEvents(events, { sessionId: current.recorder.sessionId });
      assert.equal(replay.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "partial-write").length, 1);
      assert.equal(replay.messages.some((message) => message.role === "toolResult" && message.toolCallId.includes(":nested:")), false);
    } finally { await agent.close(); }
  });
} finally {
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
