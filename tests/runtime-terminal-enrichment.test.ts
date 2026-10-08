import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";

for (const alreadyFinished of [false, true]) test(`canonical stop reason is preserved when alreadyFinished=${alreadyFinished}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-enrichment-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  try {
    authority.startRun({ runId: "run", turnId: "turn", sessionId: "session" });
    const canonical = authority.appendEvent({ eventId: "terminal", sessionId: "session", runId: "run", turnId: "turn", eventType: "session.turn_status", payload: { type: "turn_status", status: "completed", stopReason: "model_stop", steps: 2 } });
    if (alreadyFinished) authority.finishRun({ runId: "run", status: "completed", terminalEventId: canonical.eventId, payload: { stopReason: "model_stop", steps: 2, output: "verified original output" } });
    const before = authority.getRun("run");
    assert.throws(() => authority.finishRun({ runId: "run", status: "completed", terminalEventId: canonical.eventId, payload: { stopReason: "provider_error", steps: 0, output: "rewritten projection" } }), /stop reason|terminal fact/u);
    assert.deepEqual(authority.getRun("run"), before);
  } finally { authority.close(); await rm(root, { recursive: true, force: true }); }
});

test("compatible repeated terminal projection cannot erase an existing output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-payload-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  try {
    authority.startRun({ runId: "run", turnId: "turn", sessionId: "session" });
    const canonical = authority.appendEvent({ eventId: "terminal", sessionId: "session", runId: "run", turnId: "turn", eventType: "session.turn_status", payload: { type: "turn_status", status: "completed", stopReason: "model_stop", steps: 2 } });
    authority.finishRun({ runId: "run", status: "completed", terminalEventId: canonical.eventId, payload: { stopReason: "model_stop", steps: 2, output: "original completed output" } });
    const result = authority.finishRun({ runId: "run", status: "completed", terminalEventId: canonical.eventId, payload: { stopReason: "model_stop", steps: 2 } });
    console.log(JSON.stringify({ canonical: canonical.payload, terminalProjection: result.terminalPayload }));
    assert.equal((result.terminalPayload as { output?: string }).output, "original completed output");
  } finally { authority.close(); await rm(root, { recursive: true, force: true }); }
});

const fullPayload = {
  stopReason: "model_stop", finishReason: "stop", steps: 2, output: "completed original output", error: "original canonical summary",
  projection: { status: "completed", durationMs: 42, stopReason: "model_stop", finishReason: "stop", steps: 2, error: "original canonical summary" }
};

for (const [field, value] of [["finishReason", "length"], ["steps", 0], ["error", "another error"]] as const) {
  for (const repeated of [false, true]) test(`canonical ${field} rejects conflicts on ${repeated ? "repeated" : "first"} projection`, async () => {
    await fixture(async (authority, eventId) => {
      if (repeated) authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload: fullPayload });
      const before = authority.getRun("run"); const events = authority.readEvents({ limit: 1000 });
      assert.throws(() => authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload: { ...fullPayload, [field]: value } }), /different/u);
      assert.deepEqual(authority.getRun("run"), before); assert.deepEqual(authority.readEvents({ limit: 1000 }), events);
    });
  });
}

const clearCases: Array<{ name: string; payload: unknown }> = [
  { name: "whole payload null", payload: null },
  { name: "output null", payload: { output: null } },
  { name: "output empty", payload: { output: "" } },
  { name: "output different", payload: { output: "replacement" } },
  { name: "projection null", payload: { projection: null } },
  { name: "duration null", payload: { projection: { durationMs: null } } },
  { name: "duration zero", payload: { projection: { durationMs: 0 } } },
  { name: "duration conflicting", payload: { projection: { durationMs: 99 } } },
  { name: "projection status conflict", payload: { projection: { status: "cancelled" } } },
  { name: "projection error empty", payload: { projection: { error: "" } } },
  { name: "unknown field", payload: { unexpected: "new evidence" } }
];
for (const { name, payload } of clearCases) test(`repeated projection rejects ${name} without mutating durable evidence`, async () => {
  await fixture(async (authority, eventId) => {
    const before = authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload: fullPayload });
    const events = authority.readEvents({ limit: 1000 });
    assert.throws(() => authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload }), /different|cannot|unsupported|invalid/u);
    assert.deepEqual(authority.getRun("run"), before); assert.deepEqual(authority.readEvents({ limit: 1000 }), events);
  });
});

test("omitted and sparse compatible evidence preserves full projection, timestamp and read-only replay", async () => {
  await fixture(async (authority, eventId, root) => {
    const before = authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload: fullPayload });
    for (const payload of [undefined, {}, { output: undefined }, { stopReason: "model_stop" }, { projection: { durationMs: 42 } }, fullPayload]) {
      assert.deepEqual(authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload, createdAt: "2099-01-01T00:00:00.000Z" }), before);
    }
    assert.deepEqual(authority.finishRun({ runId: "run", status: "completed" }), before);
    const reader = await RuntimeEventAuthority.openReadOnly(root);
    assert.ok(reader);
    try { assert.deepEqual(reader.getRun("run"), before); } finally { reader.close(); }
  });
});

for (const payload of ["opaque", 7, ["opaque"], null, { output: "self-contained terminal" }]) {
  test(`self-contained run.terminal remains immutable for ${JSON.stringify(payload)}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-opaque-"));
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    try {
      authority.startRun({ runId: "run", turnId: "turn", sessionId: "session" });
      const finished = authority.finishRun({ runId: "run", status: "completed", payload });
      assert.deepEqual(authority.finishRun({ runId: "run", status: "completed", terminalEventId: finished.terminalEventId, payload }), finished);
      assert.deepEqual(authority.finishRun({ runId: "run", status: "completed" }), finished);
      assert.throws(() => authority.finishRun({ runId: "run", status: "completed", terminalEventId: finished.terminalEventId, payload: { output: "changed" } }), /terminal fact/u);
      assert.deepEqual(authority.getRun("run"), finished);
    } finally { authority.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("opaque session projection accepts exact replay and no payload but has no generic merge policy", async () => {
  await fixture(async (authority, eventId) => {
    const payload = { custom: { state: "opaque" } };
    const before = authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload });
    assert.deepEqual(authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload }), before);
    assert.deepEqual(authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId }), before);
    assert.throws(() => authority.finishRun({ runId: "run", status: "completed", terminalEventId: eventId, payload: { custom: { state: "changed" } } }), /unsupported/u);
    assert.deepEqual(authority.getRun("run"), before);
  });
});

async function fixture(run: (authority: RuntimeEventAuthority, eventId: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-evidence-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  try {
    authority.startRun({ runId: "run", turnId: "turn", sessionId: "session" });
    const terminal = authority.appendEvent({ eventId: "terminal", sessionId: "session", runId: "run", turnId: "turn", eventType: "session.turn_status", payload: { type: "turn_status", status: "completed", stopReason: "model_stop", finishReason: "stop", steps: 2, summary: "original canonical summary" } });
    await run(authority, terminal.eventId, root);
  } finally { authority.close(); await rm(root, { recursive: true, force: true }); }
}

for (const status of ["completed", "incomplete", "blocked", "cancelled", "aborted", "failed"] as const) {
  test(`actual JSONL reconciliation enriches a ${status} terminal and preserves repeated full projection`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-canonical-terminal-recovery-"));
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const recorder = new SessionRecorder(root, "session");
    try {
      authority.startRun({ runId: "run", turnId: "turn", sessionId: "session" });
      recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
      const stopReason = status === "completed" ? "model_stop" : status === "failed" ? "provider_error" : status;
      const error = status === "completed" ? undefined : "original canonical error";
      const terminal = await recorder.recordAndFlush({ type: "turn_status", status, stopReason, finishReason: "stop", steps: 2, summary: error, resumable: status === "incomplete", blockedReason: status === "blocked" ? "missing_user_input" : undefined });
      await recorder.close();
      const minimum = await authority.reconcileRunFromSession("run");
      assert.equal((minimum?.terminalPayload as { output: string }).output, "");
      assert.equal((minimum?.terminalPayload as { projection: { durationMs: number } }).projection.durationMs, 0);
      const payload = { stopReason, finishReason: "stop", steps: 2, output: "recovered actual output", error,
        projection: { status, durationMs: 42, stopReason, finishReason: "stop", steps: 2, error: error === undefined ? undefined : "normalized display error" } };
      const finished = authority.finishRun({ runId: "run", status, terminalEventId: terminal.runtime!.eventId, payload });
      const stored = finished.terminalPayload as { output: string; error?: string; projection: { durationMs: number; error?: string; resumable?: boolean; blockedReason?: string } };
      assert.equal(stored.output, payload.output); assert.equal(stored.error, error);
      assert.equal(stored.projection.durationMs, 42); assert.equal(stored.projection.error, payload.projection.error);
      assert.equal(stored.projection.resumable, status === "incomplete", "omitted canonical recovery evidence must remain available");
      if (status === "blocked") assert.equal(stored.projection.blockedReason, "missing_user_input");
      assert.deepEqual(authority.finishRun({ runId: "run", status, terminalEventId: terminal.runtime!.eventId, payload }), finished);
      assert.deepEqual(await authority.reconcileRunFromSession("run"), finished);
      const reader = await RuntimeEventAuthority.openReadOnly(root); assert.ok(reader);
      try { assert.deepEqual(reader.getRun("run"), finished); } finally { reader.close(); }
    } finally { await recorder.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("output and timing placeholders can be filled separately without dropping canonical evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-staged-enrichment-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const recorder = new SessionRecorder(root, "session");
  try {
    authority.startRun({ runId: "run", turnId: "turn", sessionId: "session" }); recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
    const terminal = await recorder.recordAndFlush({ type: "turn_status", status: "completed", stopReason: "model_stop", steps: 2 }); await recorder.close();
    await authority.reconcileRunFromSession("run");
    const request = { runId: "run", status: "completed" as const, terminalEventId: terminal.runtime!.eventId };
    authority.finishRun({ ...request, payload: { output: "complete output" } });
    const final = authority.finishRun({ ...request, payload: { projection: { durationMs: 10 } } });
    assert.deepEqual(final.terminalPayload, { output: "complete output", stopReason: "model_stop", steps: 2, projection: { status: "completed", durationMs: 10, stopReason: "model_stop", steps: 2 } });
    assert.deepEqual(authority.finishRun({ ...request, payload: { output: "complete output" } }), final);
    assert.deepEqual(authority.finishRun({ ...request, payload: { projection: { durationMs: 10 } } }), final);
  } finally { await recorder.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});

test("real InteractiveAgentRuntime completion and same-run replay retain full output", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-host-replay-"));
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic"; config.toolModel = "synthetic";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 } } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
  config.checkpoints.enabled = false; config.heartbeat.enabled = false; config.context.memory.enabled = false; config.context.identity.enabled = false;
  const network = t.mock.method(globalThis, "fetch", async () => new Response([
    { choices: [{ index: 0, delta: { content: "actual host output" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }, "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  const host = await createInteractiveAgentHost(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
  try {
    const request = { runId: "host-run", turnId: "host-turn" };
    const outcome = await host.runtime.submitPrompt("return the bounded result", [], request).completion;
    assert.equal(outcome.status, "completed"); assert.equal(outcome.output, "actual host output");
    const stored = host.commands.runtimeAuthority.getRun(request.runId)!;
    assert.deepEqual(host.commands.runtimeAuthority.finishRun({ runId: request.runId, status: "completed", terminalEventId: stored.terminalEventId, payload: stored.terminalPayload }), stored);
    assert.deepEqual(host.commands.runtimeAuthority.finishRun({ runId: request.runId, status: "completed", terminalEventId: stored.terminalEventId, payload: { stopReason: outcome.stopReason } }), stored);
    const requests = network.mock.callCount();
    const replay = await host.runtime.submitPrompt("return the bounded result", [], request).completion;
    assert.equal(replay.output, outcome.output); assert.equal(replay.status, outcome.status); assert.equal(replay.steps, outcome.steps);
    assert.equal(network.mock.callCount(), requests, "replay must not dispatch another provider request");
  } finally { await host.runtime.close(); network.mock.restore(); await rm(root, { recursive: true, force: true }); }
});
