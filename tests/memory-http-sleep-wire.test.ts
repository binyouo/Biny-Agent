/** Sleep REST 对照通过本地 HTTP、Runtime Host 和真实 SQLite 历史验证返回契约。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { defaultConfig } from "../src/config/schema.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-sleep-wire-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  for (const day of [1, 2, 3]) {
    await memory.runMemoryMaintenance({ now: new Date(`2026-09-0${day}T08:00:00.000Z`), trigger: "manual", useLlm: false });
  }
  const storedRuns = (await memory.loadMaintenanceStatus()).sleepRuns ?? [];
  assert.equal(storedRuns.length, 3);
  let findPairs: (signal?: AbortSignal) => Promise<{ pairs: []; examined: number }> = async () => ({ pairs: [], examined: 0 });
  const commands = { agent: {
    getLocalMemory: () => memory,
    getPersonalizationState: async () => ({ memory: { ...defaultConfig.context.memory, sleepTime: "20:00", useLlm: false } }),
    indexMemoryEntry: async () => undefined,
    prepareMemorySynthesis: async () => undefined,
    findMemorySimilarityPairs: async (_entries: unknown, _threshold: unknown, signal?: AbortSignal) => await findPairs(signal)
  } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-sleep-wire", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-sleep-wire-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const base = `http://127.0.0.1:${api.port}/api/memories/sleep`;
  const headers = { authorization: "Bearer test-only-memory-token" };

  const all = await fetch(`${base}/runs`, { headers });
  assert.equal(all.status, 200);
  const allBody = await all.json() as { runs: Array<{ id: string }> };
  assert.deepEqual(allBody.runs.map((run) => run.id), storedRuns.map((run) => run.id).reverse());
  const limited = await fetch(`${base}/runs?limit=2`, { headers });
  assert.equal(limited.status, 200);
  const limitedBody = await limited.json() as { runs: Array<{ id: string }> };
  assert.deepEqual(limitedBody.runs.map((run) => run.id), storedRuns.slice(-2).reverse().map((run) => run.id));

  const archived = await memory.writeEntry({ content: "Archived for Sleep status count." });
  assert.ok(archived.entry);
  await memory.archiveEntry(archived.entry.id, true);
  await memory.runMemoryMaintenance({ now: new Date(2026, 8, 26, 7, 0), trigger: "manual", useLlm: false });
  const NativeDate = Date;
  const fixedNow = new NativeDate(2026, 8, 26, 8, 0);
  class FixedDate extends NativeDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? fixedNow.valueOf() : value instanceof NativeDate ? value.valueOf() : value);
    }
    static override now(): number { return fixedNow.valueOf(); }
  }
  Object.defineProperty(globalThis, "Date", { configurable: true, value: FixedDate });
  try {
    const status = await fetch(`${base}/status`, { headers });
    assert.equal(status.status, 200);
    const statusBody = await status.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(statusBody).sort(), ["archiveCount", "currentRunId", "lastRun", "nextRunDate", "settings", "sleeping"]);
    assert.equal(statusBody.sleeping, false);
    assert.equal(statusBody.currentRunId, null);
    assert.equal(statusBody.nextRunDate, "2026-09-27");
    assert.equal(statusBody.archiveCount, 1);
    assert.equal((statusBody.lastRun as { status: string; trigger: string }).status, "completed");
    assert.equal((statusBody.lastRun as { status: string; trigger: string }).trigger, "manual");
    assert.deepEqual(statusBody.settings, {
      enabled: true, dailyTime: "20:00", temporaryTtlDays: 30, archiveRetentionDays: 30,
      similarityMergeThreshold: 0.95, llmMergeLow: 0.75, llmEnabled: false,
      llmBatchSize: 20, dedupAcrossUserIds: false
    });
  } finally {
    Object.defineProperty(globalThis, "Date", { configurable: true, value: NativeDate });
  }

  const preview = await fetch(`${base}/preview`, { method: "POST", headers });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { success: boolean; report: { examined: number } };
  assert.equal(previewBody.success, true);
  assert.equal(previewBody.report.examined, 0);
  const cancel = await fetch(`${base}/cancel`, { method: "POST", headers });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { success: true });
  const run = await fetch(`${base}/run`, { method: "POST", headers });
  assert.equal(run.status, 200);
  const runBody = await run.json() as { success: boolean; run: { status: string; trigger: string } };
  assert.equal(runBody.success, true);
  assert.equal(runBody.run.status, "completed");
  assert.equal(runBody.run.trigger, "manual");

  // Given a prior run and a failure after this request acquired the Sleep lease,
  // When the read fails, the HTTP result must identify this request's persisted terminal run.
  const storage = (memory as unknown as { storage: { listEntries: typeof memory.listMemoryEntries } }).storage;
  const listEntries = storage.listEntries.bind(storage);
  storage.listEntries = async () => { throw new Error("injected Sleep scan failure"); };
  let failedResponse: Response;
  try {
    failedResponse = await fetch(`${base}/run`, { method: "POST", headers });
  } finally {
    storage.listEntries = listEntries;
  }
  assert.equal(failedResponse.status, 200);
  const failedBody = await failedResponse.json() as { success: boolean; run: { id: string; status: string; error?: string } };
  assert.equal(failedBody.success, true);
  assert.equal(failedBody.run.status, "failed");
  assert.match(failedBody.run.error ?? "", /injected Sleep scan failure/);
  assert.notEqual(failedBody.run.id, runBody.run.id);
  assert.equal((await memory.loadMaintenanceStatus()).lastRun?.id, failedBody.run.id);

  // Given an active scan, cancellation must likewise return the exact cancelled run.
  await memory.writeEntry({ content: "A memory for the cancelled Sleep scan." });
  let scanStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { scanStarted = resolve; });
  findPairs = async (signal) => {
    scanStarted();
    await new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return { pairs: [], examined: 0 };
  };
  const cancelledRequest = fetch(`${base}/run`, { method: "POST", headers });
  await started;
  assert.equal(memory.cancelMaintenance(), true);
  const cancelledResponse = await cancelledRequest;
  assert.equal(cancelledResponse.status, 200);
  const cancelledBody = await cancelledResponse.json() as { success: boolean; run: { id: string; status: string } };
  assert.equal(cancelledBody.success, true);
  assert.equal(cancelledBody.run.status, "cancelled");
  assert.notEqual(cancelledBody.run.id, failedBody.run.id);
  assert.equal((await memory.loadMaintenanceStatus()).lastRun?.id, cancelledBody.run.id);

  // A missing terminal commit must not be presented as an auditable 200 response.
  const guardedStorage = storage as typeof storage & {
    writeMaintenanceStatus: (status: { state: string }, signal?: AbortSignal, owner?: string) => Promise<void>;
    acquireSleepOwner: (id: string, signal?: AbortSignal) => Promise<unknown>;
  };
  const writeStatus = guardedStorage.writeMaintenanceStatus.bind(guardedStorage);
  guardedStorage.writeMaintenanceStatus = async (status, signal, owner) => {
    if (status.state === "idle") throw new Error("injected terminal commit failure");
    await writeStatus(status, signal, owner);
  };
  findPairs = async () => ({ pairs: [], examined: 0 });
  try {
    const uncommitted = await fetch(`${base}/run`, { method: "POST", headers });
    assert.equal(uncommitted.status, 500);
    assert.match((await uncommitted.json() as { error: string }).error, /^Failed to run sleep cycle: injected terminal commit failure$/u);
  } finally {
    guardedStorage.writeMaintenanceStatus = writeStatus;
  }

  const acquireOwner = guardedStorage.acquireSleepOwner.bind(guardedStorage);
  guardedStorage.acquireSleepOwner = async () => { throw new Error("injected Sleep lease refusal"); };
  try {
    const noLease = await fetch(`${base}/run`, { method: "POST", headers });
    assert.equal(noLease.status, 500);
    assert.match((await noLease.json() as { error: string }).error, /^Failed to run sleep cycle: injected Sleep lease refusal$/u);
  } finally {
    guardedStorage.acquireSleepOwner = acquireOwner;
  }

  // A manual request arriving during another owner's run must not inherit that run's result.
  let otherScanStarted: () => void = () => undefined;
  let releaseOtherScan: () => void = () => undefined;
  const otherStarted = new Promise<void>((resolve) => { otherScanStarted = resolve; });
  const otherPaused = new Promise<void>((resolve) => { releaseOtherScan = resolve; });
  const otherRun = memory.runMemoryMaintenance({ trigger: "scheduled", useLlm: false }, {
    indexEntry: async () => undefined,
    findSimilarPairs: async () => {
      otherScanStarted();
      await otherPaused;
      return { pairs: [], examined: 0 };
    }
  });
  try {
    await otherStarted;
    const overlapping = await fetch(`${base}/run`, { method: "POST", headers });
    assert.equal(overlapping.status, 500);
    assert.match((await overlapping.json() as { error: string }).error, /^Failed to run sleep cycle: /u);
  } finally {
    releaseOtherScan();
    await otherRun;
  }
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP Sleep wire tests passed");
