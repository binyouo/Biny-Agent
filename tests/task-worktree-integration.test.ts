import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { WorktreeManager } from "../src/runtime/host/worktree.js";

const exec = promisify(execFile);

test("an isolated task runs verification in its committed checkout and retains its worktree", { timeout: 20_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-task-worktree-")));
  const git = async (...args: string[]) => await exec("git", args, { cwd: root });
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async () => {
    modelRequests += 1;
    const delta = modelRequests === 1
      ? { tool_calls: [{ index: 0, id: "write-result", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "created.txt", content: "created in worktree\n" }) } }] }
      : { content: "candidate ready" };
    const finish = modelRequests === 1 ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic";
  config.providers = { local: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } };
  config.permission.mode = "full-access";
  config.permission.denyPaths = [];
  config.sandbox.mode = "off";
  config.checkpoints.enabled = false;
  config.extensions.subagent.enabled = true;
  config.heartbeat.enabled = false;
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  let commands: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
  let retained: string | undefined;
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(path.join(root, "artifact.txt"), "committed\n");
    await writeFile(path.join(root, "check.cjs"), `const fs = require("node:fs"); if (process.cwd() === ${JSON.stringify(root)} || fs.existsSync("uncommitted.txt") || fs.readFileSync("artifact.txt", "utf8") !== "committed\\n" || fs.readFileSync("created.txt", "utf8") !== "created in worktree\\n") process.exit(1);\n`);
    await git("add", "artifact.txt", "check.cjs");
    await git("commit", "-m", "fixture");
    await writeFile(path.join(root, "uncommitted.txt"), "local only\n");
    commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    const task = commands.taskRuns.create({ sessionId: commands.agent.getInfo().sessionId, task: {
      prompt: "inspect the candidate", isolation: "worktree",
      verification: { objective: "verify isolated checkout", artifactPaths: ["created.txt"], allowedRepairPaths: ["created.txt"], maxAttempts: 1,
        checks: [{ id: "check", command: "node check.cjs", definitionPaths: ["check.cjs"], timeoutMs: 8000 }] }
    } });
    const result = await (await commands.startTaskRun(task.taskRunId)).completion;
    assert.equal(result.status, "completed");
    const records = await new WorktreeManager(root, root).status();
    const record = records.find(candidate => candidate.taskRunId === task.taskRunId);
    assert.ok(record?.exists);
    retained = record.worktreePath;
    assert.notEqual(retained, root);
    assert.equal(await readFile(path.join(retained, "created.txt"), "utf8"), "created in worktree\n");
    await assert.rejects(access(path.join(root, "created.txt")));
    assert.ok(modelRequests >= 2);
  } finally {
    await commands?.close();
    if (retained) await git("worktree", "remove", "--force", retained);
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
