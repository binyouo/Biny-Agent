import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { TaskClosureResult } from "../src/runtime/TaskClosure.js";

test("a returned Worker keeps the runtime resident until its background verification settles", { timeout: 15_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-background-verification-")));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"candidate ready"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
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
  config.workspace.ignore.push(".verification-state");
  await mkdir(path.join(root, ".verification-state"));
  await writeFile(path.join(root, "artifact.txt"), "candidate\n");
  await writeFile(path.join(root, "check.cjs"), "const fs=require('node:fs');fs.writeFileSync('.verification-state/started','yes');const deadline=Date.now()+5000;setInterval(()=>{if(fs.existsSync('.verification-state/release'))process.exit(0);if(Date.now()>deadline)process.exit(1)},5);\n");
  const commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
  let completion: Promise<TaskClosureResult> | undefined;
  try {
    const task = commands.taskRuns.create({ sessionId: commands.agent.getInfo().sessionId, task: {
      prompt: "inspect the candidate", communication: true,
      verification: { objective: "run the original check", artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1,
        checks: [{ id: "check", command: "node check.cjs", definitionPaths: ["check.cjs"], timeoutMs: 8000 }] }
    } });
    completion = (await commands.startTaskRun(task.taskRunId)).completion;
    await waitForFile(path.join(root, ".verification-state/started"));
    assert.equal(commands.taskRuns.get(task.taskRunId)?.status, "verifying");
    assert.ok(commands.subagents?.listSnapshots().every((worker) => worker.status === "completed"));
    assert.equal(commands.hasBackgroundWork(), true, "verification remains active after the child model has returned");
    await writeFile(path.join(root, ".verification-state/release"), "yes");
    assert.equal((await completion).status, "completed");
    assert.equal(commands.hasBackgroundWork(), false, "settled task history does not keep the runtime resident");
  } finally {
    await writeFile(path.join(root, ".verification-state/release"), "yes");
    await completion;
    await commands.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(file: string): Promise<void> {
  // 真实子进程通过文件报告已启动；最多等待五秒，不以固定等待时间判定成功。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("verification process did not reach its gate");
}

// A model-issued follow-up must keep the same explicit parent-cancellation boundary as Task.
test("a continued child preserves scope and is cancelled with the requesting parent run", { timeout: 10_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-followup-cancellation-")));
  const originalFetch = globalThis.fetch;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  globalThis.fetch = async (_request, options) => await new Promise<Response>((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    entered();
  });
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic";
  config.providers = { local: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } };
  config.extensions.subagent.enabled = true; config.checkpoints.enabled = false;
  config.heartbeat.enabled = false; config.context.memory.enabled = false; config.context.identity.enabled = false;
  const commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
  const parent = new AbortController();
  try {
    const sessionId = commands.agent.getInfo().sessionId;
    commands.taskRuns.create({ taskRunId: "source", sessionId, task: { prompt: "finite inspection", communication: true, constraints: ["preserve src/a.ts"] } });
    const sourceAttempt = commands.taskRuns.createAttempt("source"); commands.taskRuns.transition("source", "queued");
    commands.taskRuns.transition("source", "running", { attemptId: sourceAttempt.attemptId });
    commands.taskRuns.transition("source", "completed", { attemptId: sourceAttempt.attemptId, artifacts: { output: "prior evidence" } });
    const followup = await commands.continueTaskRun("source", "inspect one more boundary", "followup", parent.signal);
    const id = String(followup.taskRunId);
    const definition = commands.taskRuns.get(id)!.task as { constraints: string[]; prompt: string };
    assert.deepEqual(definition.constraints, ["preserve src/a.ts"]); assert.match(definition.prompt, /prior evidence/);
    await started;
    parent.abort(new Error("requesting parent stopped"));
    assert.ok(["cancelled", "aborted"].includes(commands.taskRuns.get(id)!.status));
    assert.equal(commands.taskRuns.get("source")?.status, "completed");
    assert.equal(commands.taskRuns.get("source")?.attempts.length, 1);
  } finally {
    parent.abort(); await commands.close(); globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
