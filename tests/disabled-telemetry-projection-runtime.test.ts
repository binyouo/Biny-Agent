import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("real model runs avoid disabled telemetry projections at short and long histories without changing telemetry consent", { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch;
  const originalRoot = process.env.BINY_AGENT_DIR;
  const inspector = new Session();
  inspector.connect();
  await inspector.post("Profiler.enable");
  const observations: Array<{ historyMessages: number; enabled: boolean; recordInputs: boolean; modelMessages: number; projectionCalls: number[] }> = [];
  globalThis.fetch = async () => { throw new Error("external network forbidden"); };
  try {
    for (const historyMessages of [0, 200]) for (const [enabled, recordInputs] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "telemetry-evidence-")));
      process.env.BINY_AGENT_DIR = path.join(root, "state");
      const config = structuredClone(defaultConfig);
      config.context.maxInputTokens = 1_000_000;
      config.context.memory.useMemories = false;
      config.context.memory.generateMemories = false;
      config.context.identity.enabled = false;
      config.crystal.passiveEnabled = false;
      config.crystal.semanticScanEnabled = false;
      config.activity.enabled = false;
      config.heartbeat.enabled = false;
      config.diagnostics.enabled = false;
      config.telemetry = { enabled, recordInputs, recordOutputs: false };
      await ensureAgentDirs(root);
      const recorder = new SessionRecorder(root);
      for (let index = 0; index < historyMessages; index += 1) await recorder.recordAndFlush({
        type: index % 2 === 0 ? "user_message" : "assistant_message", content: `Message ${index}: ${"bounded history ".repeat(128)}`
      });
      let modelCalls = 0;
      let modelMessages = 0;
      const agent = new AgentSession({ workspaceRoot: root, config, recorder, toolRegistry: new ToolRegistry(),
        permissionManager: new PermissionManager(config.permission),
        model: { provider: "fixture", modelId: "review", runtime: "builtin-llama.cpp", dataResidency: "local",
          stream: async context => {
            modelCalls += 1;
            modelMessages = context.messages.length;
            assert.ok(modelMessages >= historyMessages + 1);
            return (async function* () { yield { type: "text-delta" as const, text: "fixture answer" }; yield { type: "finish" as const, reason: "stop" as const }; })();
          }
        }
      });
      try {
        await agent.initialize();
        if (historyMessages > 0) await agent.resume(recorder.sessionId);
        await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
        let completed = false;
        for await (const event of agent.prompt("Respond with the fixture answer", { emotionAnalysis: false })) if (event.type === "done") { assert.equal(event.outcome.status, "completed", JSON.stringify(event.outcome)); completed = true; }
        const coverage = await inspector.post("Profiler.takePreciseCoverage");
        await inspector.post("Profiler.stopPreciseCoverage");
        assert.equal(completed, true);
        assert.equal(modelCalls, 1);
        const functions = coverage.result.filter(script => /\/src\/agent\/prompts\.ts/.test(script.url)).flatMap(script => script.functions);
        const projectionCalls = ["systemPromptForTelemetry", "messagesForTelemetry"].map(name => functions.filter(fn => fn.functionName === name).reduce((sum, fn) => sum + fn.ranges[0]!.count, 0));
        observations.push({ historyMessages, enabled, recordInputs, modelMessages, projectionCalls });
        const telemetryFile = path.join(agentDir(root), "telemetry.jsonl");
        if (!enabled) await assert.rejects(readFile(telemetryFile), { code: "ENOENT" });
        else {
          const events = (await readFile(telemetryFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
          const starts = events.filter(event => event.type === "start");
          assert.equal(starts.length, 1);
          assert.equal(typeof starts[0].input, recordInputs ? "string" : "undefined");
          if (recordInputs) { assert.match(starts[0].input, /^\{"systemPrompt":/); assert.ok(starts[0].input.length <= 8000); }
          assert.ok(events.some(event => event.type === "end"));
        }
      } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
    }
    console.log(JSON.stringify({ pr: 209, observations }));
    for (const row of observations) assert.deepEqual(row.projectionCalls, row.enabled && row.recordInputs ? [1, 1] : [0, 0]);
  } finally {
    await inspector.post("Profiler.disable"); inspector.disconnect(); globalThis.fetch = originalFetch;
    if (originalRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = originalRoot;
  }
});
