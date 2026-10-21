import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { mkdtemp, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-run-query-"));
try {
  assert.deepEqual(await RuntimeEventAuthority.readLatestSessionRuns(root, ["session-1"]), new Map());
  await assert.rejects(access(path.join(agentDir(root), "runtime.sqlite")));
  let authority = await RuntimeEventAuthority.open(root);
  try {
    authority.startRun({ runId: "old-run", sessionId: "session-1", turnId: "old-turn", createdAt: "2026-08-05T10:00:00.000Z" });
    authority.startRun({ runId: "new-run", sessionId: "session-1", turnId: "new-turn", createdAt: "2026-08-05T11:00:00.000Z" });
    authority.startRun({ runId: "hidden-run", sessionId: "hidden", turnId: "hidden-turn" });
    const before = authority.getRun("new-run");
    const visible = await RuntimeEventAuthority.readLatestSessionRuns(root, ["session-1"]);
    assert.deepEqual([...visible.keys()], ["session-1"]);
    assert.equal(visible.get("session-1")?.runId, "new-run");
    assert.deepEqual(authority.getRun("new-run"), before, "cold reads must not invent terminal outcomes");
    const recorder = new SessionRecorder(root, "session-1");
    recorder.setRuntimeContext({ runId: "new-run", turnId: "new-turn" });
    const terminal = await recorder.recordAndFlush({ type: "turn_status", status: "blocked", stopReason: "blocked", steps: 3, resumable: true, requiredAction: "Choose a deployment target." });
    await recorder.close();
    assert.equal(authority.getRun("new-run")?.status, "admitted", "simulate interrupted projection after JSONL commit");
    authority.close();
    authority = await RuntimeEventAuthority.open(root);
    const repaired = (await RuntimeEventAuthority.readLatestSessionRuns(root, ["session-1"])).get("session-1");
    assert.equal(repaired?.status, "blocked");
    assert.equal(repaired?.terminalEventId, terminal.runtime?.eventId);
    assert.equal((repaired?.terminalPayload as { projection: { requiredAction: string } }).projection.requiredAction, "Choose a deployment target.");
    assert.equal(authority.finishRun({ runId: "new-run", status: "blocked", terminalEventId: terminal.runtime?.eventId }).terminalEventId, terminal.runtime?.eventId);
    assert.throws(() => authority.finishRun({ runId: "new-run", status: "completed" }), /already has terminal status/);
  } finally { authority.close(); }
} finally { await rm(root, { recursive: true, force: true }); }
