/**
 * Optional real-SDK/AgentSession benchmark with a synthetic direct V4 model.
 * Node 24, existing dependencies, no provider/network use or real user data:
 *   node --expose-gc --import tsx scripts/bench-event-queue-session.mjs 10000
 * Add a checkout root after the count for a pristine-main comparison. Repeat
 * 100, 1000 and 10000 in fresh processes; report ranges as well as medians.
 * Four-character chunks yield one setImmediate each. Times are accelerated
 * fixture processing, not API/user latency. GC is outside processing timing.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const count = Number(process.argv[2] ?? 10_000);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 30_000);
const collectGarbage = (() => {
  const gc = globalThis.gc;
  assert.ok(gc, "Run this optional benchmark with --expose-gc.");
  return gc;
})();
const root = path.resolve(process.argv[3] ?? fileURLToPath(new URL("../", import.meta.url)));
const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-event-queue-session-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
const previousFetch = globalThis.fetch;
process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
globalThis.fetch = async () => { throw new Error("Network is forbidden in this synthetic benchmark."); };
function gate() {
  /** @type {() => void} */
  let resolve = () => undefined;
  /** @type {Promise<void>} */
  const promise = new Promise(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}
const started = gate();
const begin = gate();
const drained = gate();
const finish = gate();
/** @type {import("../src/agent/AgentSession.js").AgentSession | undefined} */
let agent;
/** @type {Promise<void> | undefined} */
let running;
/** @type {{ outcome?: import("../src/agent/types.js").AgentTurnOutcome }} */
const result = {};
let observed = 0;
let requests = 0;
async function memory() {
  await nextTurn();
  collectGarbage();
  collectGarbage();
  return process.memoryUsage();
}
try {
  // Deferred application imports are intentional: isolate BINY_AGENT_DIR before
  // modules initialize, and load exactly the requested candidate/baseline tree.
  /** @param {string} file */
  const load = file => import(pathToFileURL(path.join(root, "src", file)).href);
  /** @type {typeof import("../src/agent/AgentSession.js")} */
  const { AgentSession } = await load("agent/AgentSession.ts");
  /** @type {typeof import("../src/config/schema.js")} */
  const { defaultConfig } = await load("config/schema.ts");
  /** @type {typeof import("../src/permission/PermissionManager.js")} */
  const { PermissionManager } = await load("permission/PermissionManager.ts");
  /** @type {typeof import("../src/session/recorder.js")} */
  const { SessionRecorder } = await load("session/recorder.ts");
  /** @type {typeof import("../src/session/store.js")} */
  const { ensureAgentDirs } = await load("session/store.ts");
  /** @type {typeof import("../src/tools/registry.js")} */
  const { ToolRegistry } = await load("tools/registry.ts");
  await ensureAgentDirs(temporary);
  const config = structuredClone(defaultConfig);
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.compaction.enabled = false;
  config.heartbeat.enabled = false;
  config.crystal.passiveEnabled = false;
  /** @type {import("@ai-sdk/provider").LanguageModelV4} */
  const vercelModel = {
    specificationVersion: "v4", provider: "synthetic", modelId: "synthetic", supportedUrls: {},
    doGenerate: async () => { throw new Error("Unexpected non-streaming request."); },
    doStream: async () => {
      requests += 1;
      return { stream: new ReadableStream({ async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "text" });
        started.resolve();
        await begin.promise;
        for (let index = 0; index < count; index += 1) {
          controller.enqueue({ type: "text-delta", id: "text", delta: "text" });
          await nextTurn();
        }
        await finish.promise;
        controller.enqueue({ type: "text-end", id: "text" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: count, text: count, reasoning: 0 }
        } });
        controller.close();
      } }) };
    }
  };
  const model = { provider: "synthetic", modelId: "synthetic", vercelModel,
    stream: async () => { throw new Error("The compatibility adapter must not be used."); } };
  agent = new AgentSession({ workspaceRoot: temporary, config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(temporary) });
  await agent.initialize();
  running = (async () => {
    for await (const event of agent.prompt("Synthetic text fixture", { emotionAnalysis: false })) {
      if (event.type === "assistant.delta" && ++observed === count) drained.resolve();
      if (event.type === "done") result.outcome = event.outcome;
    }
  })();
  const prematureCompletion = running.then(() => { throw new Error("Stream ended before its measurement boundary."); });
  await Promise.race([started.promise, prematureCompletion]);
  const before = await memory();
  const startTime = performance.now();
  begin.resolve();
  await Promise.race([drained.promise, prematureCompletion]);
  const loopMs = performance.now() - startTime;
  const retained = await memory();
  finish.resolve();
  await running;
  assert.equal(requests, 1);
  assert.equal(observed, count);
  assert.ok(result.outcome);
  assert.equal(result.outcome.status, "completed");
  assert.equal(result.outcome.output, "text".repeat(count));
  const after = await memory();
  console.log(JSON.stringify({ count, sourceRoot: root, node: process.version, v8: process.versions.v8,
    observed, requests, outputCharacters: result.outcome.output.length, loopMs,
    heapBefore: before.heapUsed, heapRetained: retained.heapUsed, heapDelta: retained.heapUsed - before.heapUsed,
    heapAfter: after.heapUsed, rssBefore: before.rss, rssRetained: retained.rss, rssAfter: after.rss,
    peakRssKiB: process.resourceUsage().maxRSS }));
} finally {
  begin.resolve();
  finish.resolve();
  try { await running; } finally {
    try { await agent?.close(); } finally {
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
