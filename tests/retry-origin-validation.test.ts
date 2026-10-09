import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/AgentSession.js";
import { defaultConfig, configSchema } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { resolveRetryScope, type RetryOrigin } from "../src/session/retryOrigin.js";
import { agentDir } from "../src/session/store.js";
import { writeSessionSnapshot } from "../src/session/sessionSnapshot.js";
import { TurnStore, type InterruptedTurn } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

// Use a genuine public retry, with IDs allocated by production, as the origin fixture.
test("strict checkpoint retry origin rejects corrupt identities and cannot poison a generic snapshot", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-validation-"));
  const marker = path.join(root, "capture.json");
  const originalRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    await mkdir(path.join(root, "tmp"));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/retry-origin-worker.ts", import.meta.url)),
        "capture", root, "retry-origin", "older-originaltools", "partial", marker], { env: {
        PATH: process.env.PATH, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"), XDG_DATA_HOME: path.join(root, "data"), TMPDIR: path.join(root, "tmp"),
        BINY_AGENT_DIR: process.env.BINY_AGENT_DIR, BINY_TEST_PROCESS: "1", TZ: "UTC"
      }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", value => { output += String(value); }); child.stderr.on("data", value => { output += String(value); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(output)); }, 30_000);
      child.once("error", reject); child.once("close", (_code, signal) => { clearTimeout(timer); if (signal === "SIGKILL") resolve(); else reject(new Error(output)); });
    });
    const captured = JSON.parse(await readFile(marker, "utf8")) as { checkpoint: string; finalPath: string; log: string };
    const saved = JSON.parse(captured.checkpoint) as { version: number; turn: InterruptedTurn };
    const origin = saved.turn.retryOrigin!;
    const facts = await readSessionEvents(captured.finalPath);
    const store = new TurnStore(root, "retry-origin");
    const scoped = replaySessionEvents(facts, { sessionId: "retry-origin", retryOrigin: origin });
    assert.ok(scoped.retrySourceEvents);
    const snapshotPath = captured.finalPath.replace(/\.jsonl$/u, ".snap.json");
    await writeSessionSnapshot(captured.finalPath, { size: Buffer.byteLength(captured.log), mtimeMs: 1 }, scoped);
    await assert.rejects(readFile(snapshotPath), { code: "ENOENT" });
    const mutations: Array<[string, (value: RetryOrigin) => void]> = [
      ["version", value => { (value as { version: number }).version = 2; }],
      ["source", value => { (value as { source: string }).source = "import"; }],
      ["extra", value => { Object.assign(value, { arbitrary: "authority" }); }],
      ["owner", value => { value.ownerTurnId = "unowned"; }],
      ["session", value => { value.sessionId = "another-session"; }],
      ["source user", value => { value.sourceUserMessageId = value.targetMessageId; }],
      ["target", value => { value.targetMessageId = value.sourceUserMessageId; }],
      ["role", value => { value.targetRole = "user"; }],
      ["base", value => { value.baseParentMessageId = value.targetMessageId; }],
      ["slot", value => { value.targetSlotId = value.targetMessageId; }],
      ["reply", value => { value.replyToMessageId = value.targetMessageId; }],
      ["output", value => { value.finalMessageId = value.targetMessageId; }],
      ["admission witness", value => { value.admissionHighWater.eventId = "missing"; }],
      ["admission sequence", value => { value.admissionHighWater.eventSeq += 1; }],
      ["target witness", value => { value.targetRuntime.eventId = "missing"; }],
      ["reused turn", value => { value.ownerTurnId = value.targetRuntime.turnId!; }],
      ["post-execution admission", value => { value.admissionHighWater = saved.turn.runtimeHighWater!; }]
    ];
    let requests = 0;
    const config = configSchema.parse({ ...defaultConfig, activity: { ...defaultConfig.activity, enabled: false },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } } });
    const turnPath = path.join(agentDir(root), "turns", "retry-origin.json");
    for (const [name, mutate] of mutations) {
      const changed = structuredClone(saved); mutate(changed.turn.retryOrigin!);
      await writeFile(turnPath, JSON.stringify(changed));
      assert.throws(() => resolveRetryScope(facts, changed.turn.retryOrigin!, changed.turn), name);
      const session = new AgentSession({ workspaceRoot: root, recorder: new SessionRecorder(root), config,
        permissionManager: new PermissionManager(config.permission), toolRegistry: new ToolRegistry(), model: {
          provider: "synthetic", modelId: "must-not-dispatch", supportsTools: true,
          stream: async () => { requests += 1; throw new Error("unexpected provider"); }
        } });
      try { await session.initialize(); await assert.rejects(session.resume("retry-origin"), name); }
      finally { await session.close(); }
    }
    assert.equal(requests, 0);
    await writeFile(turnPath, captured.checkpoint);
    assert.ok((await store.load())?.retryOrigin);
    for (const version of [2, 3, 4]) {
      const legacy = structuredClone(saved); legacy.version = version; delete legacy.turn.retryOrigin; delete legacy.turn.retryWindow; delete legacy.turn.retryCommit;
      await writeFile(turnPath, JSON.stringify(legacy)); assert.equal((await store.load())?.retryOrigin, undefined);
      legacy.turn.retryOrigin = origin; await writeFile(turnPath, JSON.stringify(legacy)); await assert.rejects(store.load());
    }
  } finally {
    if (originalRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = originalRoot;
    await rm(root, { recursive: true, force: true });
  }
});
