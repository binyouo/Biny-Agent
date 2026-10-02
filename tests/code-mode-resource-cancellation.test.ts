/** Cooperative resource cancellation must settle safely; a pending read remains unknown. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mock } from "node:test";
import os from "node:os";
import path from "node:path";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { createSkillResourceTool, loadSkills } from "../src/extensions/skills.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-resource-cancellation-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
await ensureAgentDirs(root);
const skillDir = path.join(root, "skills", "cancel-fixture");
await fs.mkdir(skillDir, { recursive: true });
await fs.mkdir(path.join(root, "global"));
await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: cancel-fixture\ndescription: Disposable cancellation fixture\n---\nFixture\n");
const resourcePath = path.join(skillDir, "reference.txt");
await fs.writeFile(resourcePath, "ordinary temporary resource text");
const bundle = await loadSkills({ workspaceRoot: root, projectPaths: ["skills"], globalRoot: path.join(root, "global") });
const args = { skill: "cancel-fixture", path: "reference.txt" };
const code = `return await tools.read_skill_resource(${JSON.stringify(args)});`;
const recorders: SessionRecorder[] = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

try {
  for (const mode of ["direct", "code_mode"] as const) {
    for (const cooperative of [true, false]) {
      const registry = new ToolRegistry();
      registry.registerHostReadQuery(createSkillResourceTool(bundle), "read_skill_resource");
      const config = structuredClone(defaultConfig);
      config.agent.toolExecutionMode = mode;
      config.agent.maxConcurrentTools = 1;
      config.permission = { mode: "full-access", allowTools: [], allowPaths: [], denyPaths: [], criticalAlwaysAsk: true };
      config.checkpoints.enabled = false;
      config.context.memory.enabled = false;
      const recorder = new SessionRecorder(root, `resource-cancel-${mode}-${String(cooperative)}`);
      recorders.push(recorder);
      let quarantines = 0;
      const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
        quarantineExternalTool: () => { quarantines++; } }, new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["read_skill_resource"]));
      const tool = mode === "direct" ? coordinator.createAgentTools()[0]! : coordinator.createCodeModeTool();
      const controller = new AbortController(); const entered = deferred(); const release = deferred(); const closed = deferred();
      const originalOpen = fs.open;
      let reads = 0;
      mock.method(fs, "open", async (...openArgs: Parameters<typeof fs.open>) => {
        const file = await originalOpen(...openArgs);
        if (String(openArgs[0]) !== resourcePath) return file;
        const read = file.read.bind(file); const close = file.close.bind(file);
        mock.method(file, "close", async () => { await close(); closed.resolve(); });
        mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads++; entered.resolve();
          if (!cooperative) await release.promise;
          const result = await read(buffer, offset, length, position);
          if (cooperative) controller.abort();
          return result;
        });
        return file;
      });
      try {
        const id = `mid-read-${mode}-${String(cooperative)}`;
        const pending = tool.execute(id, mode === "direct" ? args : { code }, controller.signal);
        await entered.promise;
        if (!cooperative) controller.abort();
        const result = await pending;
        assert.equal(result.isError, true);
        const outcome = result.details as { executionStatus?: string; status?: string };
        assert.equal(mode === "direct" ? outcome.status : outcome.executionStatus, cooperative ? "cancelled" : "unknown");
        const events = (await fs.readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const childId = mode === "direct" ? id : `${id}:nested:1`;
        assert.equal(events.find((event) => event.type === "tool_result" && event.toolCallId === childId)?.executionStatus, cooperative ? "cancelled" : "unknown");
        if (cooperative) {
          await closed.promise;
          assert.equal(quarantines, 0);
          assert.doesNotThrow(() => coordinator.assertCanContinue());
          mock.restoreAll();
          const later = await tool.execute(`later-${mode}`, mode === "direct" ? args : { code });
          assert.equal(later.isError, false, JSON.stringify(later.details));
        } else {
          assert.ok(quarantines > 0, "a descriptor still held by an unresolved read must be quarantined");
          assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
          const blocked = await tool.execute(`blocked-replay-${mode}`, mode === "direct" ? args : { code });
          assert.equal(blocked.isError, true);
          assert.equal(reads, 1, "no replay or overlapping read may start while the previous result is unknown");
          release.resolve(); await closed.promise;
          await coordinator.waitForIdle();
        }
      } finally { release.resolve(); mock.restoreAll(); }
    }
  }
} finally {
  mock.restoreAll();
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
  await fs.rm(root, { recursive: true, force: true });
}
console.log("code mode resource cancellation tests passed");
