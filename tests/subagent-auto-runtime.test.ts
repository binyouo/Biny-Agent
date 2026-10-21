import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { loadSubagentDefinitions } from "../src/extensions/agents.js";
import { prepareSubagentTask } from "../src/extensions/subagent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { sessionFilePath } from "../src/session/store.js";
import type { AgentModel } from "../src/agent/core/types.js";

test("automatic workers choose executable Claude before native, persist that choice, and never replay a failed CLI through native", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-auto-worker-"));
  const previousPath = process.env.PATH;
  let nativeCalls = 0;
  try {
    process.env.PATH = root;
    const config = configSchema.parse({ ...defaultConfig,
      permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, enabled: false }, identity: { ...defaultConfig.context.identity, enabled: false } },
      extensions: { ...defaultConfig.extensions, subagent: { enabled: true, runtime: "auto" } } });
    await mkdir(path.join(root, ".biny/agents"), { recursive: true });
    const definition = path.join(root, ".biny/agents/coder.md");
    await writeFile(definition, "---\nname: coder\ndescription: Code worker\nruntime: auto\n---\nDo the task.");
    const model: AgentModel = testModel({ provider: "fixture", modelId: "native", supportsTools: true,
      async stream() { nativeCalls++; return (async function* () { yield { type: "text-delta" as const, text: "native result" }; yield { type: "finish" as const, reason: "stop" as const }; })(); } });
    const options = { workspaceRoot: root, config, toolRegistry: new ToolRegistry(), loadAgentDefinitions: () => loadSubagentDefinitions({ workspaceRoot: root, projectPaths: [".biny/agents"], globalRoot: path.join(root, "empty") }), getModelSettings: () => ({ model, contextWindow: undefined }) };
    const run = async (id: string, task = "task") => {
      const worker = await prepareSubagentTask(options, task, "workspace", "coder", { taskId: id, persistenceRoot: root });
      try { return await worker.run(); } finally { await worker.close(); }
    };
    await writeFile(path.join(root, "codex"), `#!${process.execPath}\nprocess.exit(99);\n`, { mode: 0o755 });
    assert.match(await run("absent"), /native result/);
    const executable = path.join(root, "claude");
    await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs'); let text = ''; process.stdin.on('data', d => text += d); process.stdin.on('end', () => { fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'result',subtype:text.includes('fail')?'error_during_execution':'success',is_error:text.includes('fail'),result:'claude result'})); });\n`, { mode: 0o644 });
    assert.match(await run("non-executable"), /native result/);
    await chmod(executable, 0o755);
    assert.equal(await run("installed"), "claude result");
    assert.equal(nativeCalls, 2);
    assert.ok(!JSON.parse(await readFile(path.join(root, "args.json"), "utf8")).includes("--model"));
    const events = await readFile(sessionFilePath(root, workerSessionId("installed")), "utf8");
    assert.match(events, /claude-code/);
    assert.match(events, /CLI default/);
    assert.match(events, /claude result/);
    await assert.rejects(run("failed", "fail"));
    assert.equal(nativeCalls, 2, "a CLI failure must not trigger a second execution");
    const worker = await prepareSubagentTask(options, "task", "workspace", "coder");
    await rm(executable);
    try { await assert.rejects(worker.run()); } finally { await worker.close(); }
    assert.equal(nativeCalls, 2, "a vanished CLI must not silently change the admitted runtime");
    await writeFile(definition, `---\nname: coder\ndescription: Code worker\nmodel: ${config.defaultModel}\n---\nDo the task.`);
    await writeFile(executable, `#!${process.execPath}\nprocess.exit(99);\n`, { mode: 0o755 });
    assert.match(await run("explicit-model"), /native result/);
    assert.equal(nativeCalls, 3);
    config.permission.denyPaths = [".env"];
    await writeFile(definition, "---\nname: coder\ndescription: Code worker\nruntime: auto\n---\nDo the task.");
    await assert.rejects(run("restricted"), /cannot enforce/);
    assert.equal(nativeCalls, 3, "automatic selection cannot bypass permission restrictions");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
