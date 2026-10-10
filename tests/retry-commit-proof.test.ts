import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readSessionEvents, readSessionEventsForBackfill } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { TurnStore, type InterruptedTurn } from "../src/session/turnStore.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";

test("retry reply commit validates loaded phase and physical facts before any append", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-commit-proof-"));
  const marker = path.join(root, "capture.json");
  const originalRoot = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  await mkdir(path.join(root, "tmp"));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/retry-origin-worker.ts", import.meta.url)),
        "capture", root, "retry-origin", "older-originaltools", "audit", marker], { env: {
        PATH: process.env.PATH, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_DATA_HOME: path.join(root, "data"), TMPDIR: path.join(root, "tmp"), BINY_AGENT_DIR: process.env.BINY_AGENT_DIR, BINY_TEST_PROCESS: "1", TZ: "UTC"
      }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", value => { output += String(value); }); child.stderr.on("data", value => { output += String(value); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(output)); }, 30_000);
      child.once("error", reject); child.once("close", (_code, signal) => { clearTimeout(timer); if (signal === "SIGKILL") resolve(); else reject(new Error(output)); });
    });
    const capture = JSON.parse(await readFile(marker, "utf8")) as { log: string; finalPath: string; checkpoint: string };
    const baseline = JSON.parse(capture.checkpoint) as { version: number; turn: InterruptedTurn };
    assert.ok(baseline.turn.retryCommit && baseline.turn.retryWindow && baseline.turn.retryOrigin);
    const checkpoint = path.join(agentDir(root), "turns", "retry-origin.json");
    const mutants: Array<[string, (turn: InterruptedTurn) => void]> = [
      ["phase version", turn => { Object.assign(turn.retryCommit!, { version: 2 }); }],
      ["phase unknown field", turn => { Object.assign(turn.retryCommit!, { unknown: true }); }],
      ["phase body unknown field", turn => { Object.assign(turn.retryCommit!.message.content[0]!, { unknown: true }); }],
      ["phase usage type", turn => { Object.assign(turn.retryCommit!.message, { usage: { inputTokens: "invalid" } }); }],
      ["phase role", turn => { Object.assign(turn.retryCommit!.message, { role: "user" }); }],
      ["phase tool call", turn => { turn.retryCommit!.message.content.push({ type: "toolCall", id: "invented", name: "write", arguments: {} }); }],
      ["phase body", turn => { turn.retryCommit!.message.content = [{ type: "text", text: "different body" }]; turn.retryCommit!.outcome.output = "different body"; }],
      ["phase parent", turn => { turn.retryCommit!.parentMessageId = turn.retryOrigin!.sourceUserMessageId; }],
      ["phase run", turn => { turn.retryCommit!.runId = "another-run"; }],
      ["phase reply", turn => { turn.retryCommit!.replyMessageId = "another-reply"; }],
      ["phase outcome", turn => { turn.retryCommit!.outcome.status = "completed"; turn.retryCommit!.outcome.stopReason = "blocked"; }],
      ["phase high-water", turn => { turn.retryCommit!.runtimeHighWater.eventId = "absent"; }],
      ["window unknown field", turn => { Object.assign(turn.retryWindow!, { unknown: true }); }],
      ["window reused reply", turn => { turn.retryWindow!.replyMessageId = turn.retryOrigin!.targetMessageId; turn.retryCommit!.replyMessageId = turn.retryOrigin!.targetMessageId; }],
      ["window witness", turn => { turn.retryWindow!.admissionHighWater.eventId = "missing"; }],
      ["origin source", turn => { Object.assign(turn.retryOrigin!, { source: "imported" }); }]
    ];
    const reset = async () => { await writeFile(capture.finalPath, capture.log); await writeFile(checkpoint, capture.checkpoint); };
    for (const [label, mutate] of mutants) {
      await reset(); const altered = structuredClone(baseline); mutate(altered.turn); await writeFile(checkpoint, JSON.stringify(altered));
      const recorder = new SessionRecorder(root, "retry-origin", capture.finalPath); recorder.repairTailForAppend();
      recorder.setRuntimeContext({ runId: "recovery", turnId: baseline.turn.turnId! });
      try {
        const source = await readSessionEventsForBackfill(capture.finalPath, 0);
        await assert.rejects(recorder.commitRetryReply({ ownerTurnId: baseline.turn.turnId!, replyMessageId: baseline.turn.retryWindow!.replyMessageId,
          expectedRuntimeHighWater: baseline.turn.runtimeHighWater!, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } }), label);
        assert.equal(await readFile(capture.finalPath, "utf8"), capture.log, label);
      } finally { await recorder.close(); }
    }
    for (const label of ["new-input", "new-selection", "conflicting-terminal", "changed-invocation", "replaced-inode", "bad-proof"] as const) {
      await reset(); const recorder = new SessionRecorder(root, "retry-origin", capture.finalPath); recorder.repairTailForAppend();
      recorder.setRuntimeContext({ runId: "recovery", turnId: baseline.turn.turnId! });
      try {
        const source = await readSessionEventsForBackfill(capture.finalPath, 0);
        const proof = { ownerTurnId: baseline.turn.turnId!, replyMessageId: baseline.turn.retryWindow!.replyMessageId,
          expectedRuntimeHighWater: baseline.turn.runtimeHighWater!, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } };
        if (label === "new-input") await recorder.recordAndFlush({ type: "user_message", content: "NEW_INTENT" }, { runId: "new", turnId: "new" });
        if (label === "new-selection") await recorder.recordAndFlush({ type: "message_version_selected", messageId: baseline.turn.retryOrigin!.targetMessageId, slotId: baseline.turn.retryOrigin!.targetSlotId }, undefined);
        if (label === "conflicting-terminal") await recorder.recordAndFlush({ type: "turn_status", status: "cancelled", stopReason: "cancelled", steps: 1 },
          { runId: baseline.turn.retryCommit!.runId, turnId: baseline.turn.turnId! });
        if (label === "replaced-inode") { await rename(capture.finalPath, `${capture.finalPath}.old`); await writeFile(capture.finalPath, capture.log); }
        if (label === "bad-proof") proof.sourcePrefix.sha256 = "0".repeat(64);
        const before = await readFile(capture.finalPath, "utf8");
        const pending = recorder.commitRetryReply(proof);
        if (label === "changed-invocation") recorder.setRuntimeContext({ runId: "another", turnId: baseline.turn.turnId! });
        await assert.rejects(pending, label); assert.equal(await readFile(capture.finalPath, "utf8"), before, label);
      } finally { await recorder.close(); }
    }
    for (const label of ["owner", "run", "parent", "slot", "body"] as const) {
      await reset();
      const events = capture.log.trimEnd().split("\n").map(line => JSON.parse(line));
      const audit = events.find(event => event.type === "assistant_message" && event.messageId === baseline.turn.retryWindow!.replyMessageId);
      assert.ok(audit);
      if (label === "owner") audit.runtime.turnId = "unrelated-owner";
      if (label === "run") audit.runtime.runId = "unrelated-run";
      if (label === "parent") audit.parentMessageId = "unrelated-parent";
      if (label === "slot") audit.slotId = "unrelated-slot";
      if (label === "body") audit.content = "different body";
      const changed = events.map(event => JSON.stringify(event)).join("\n") + "\n";
      await writeFile(capture.finalPath, changed);
      const bound = new SessionRecorder(root, "retry-origin", capture.finalPath); bound.repairTailForAppend();
      bound.setRuntimeContext({ runId: "recovery", turnId: baseline.turn.turnId! });
      try {
        const source = await readSessionEventsForBackfill(capture.finalPath, 0);
        await assert.rejects(bound.commitRetryReply({ ownerTurnId: baseline.turn.turnId!, replyMessageId: baseline.turn.retryWindow!.replyMessageId,
          expectedRuntimeHighWater: baseline.turn.runtimeHighWater!, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } }), label);
        assert.equal(await readFile(capture.finalPath, "utf8"), changed, "same-ID conflicting audit must reject without a second audit");
      } finally { await bound.close(); }
    }
    for (const between of ["checkpoint-replaced", "new-input"] as const) {
      await reset();
      const lines = capture.log.trimEnd().split("\n");
      const witness = lines.findIndex(line => JSON.parse(line).runtime?.eventId === baseline.turn.runtimeHighWater!.eventId);
      await writeFile(capture.finalPath, lines.slice(0, witness + 1).join("\n") + "\n");
      const staged = new SessionRecorder(root, "retry-origin", capture.finalPath); staged.repairTailForAppend();
      staged.setRuntimeContext({ runId: "recovery", turnId: baseline.turn.turnId! });
      try {
        const source = await readSessionEventsForBackfill(capture.finalPath, 0);
        const input: Parameters<SessionRecorder["commitRetryReply"]>[0] = { ownerTurnId: baseline.turn.turnId!, replyMessageId: baseline.turn.retryWindow!.replyMessageId,
          expectedRuntimeHighWater: baseline.turn.runtimeHighWater!, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } };
        await staged.commitRetryReply({ ...input, stage: "reply" });
        const first = await readSessionEvents(capture.finalPath);
        assert.equal(first.filter(event => event.type === "assistant_message" && event.messageId === input.replyMessageId).length, 0);
        assert.equal(first.filter(event => event.type === "turn_status" && event.runtime?.runId === baseline.turn.retryCommit!.runId).length, 0);
        if (between === "checkpoint-replaced") {
          const changed = structuredClone(baseline); changed.turn.retryWindow!.replyMessageId = "replacement-window";
          changed.turn.retryCommit!.replyMessageId = "replacement-window"; await writeFile(checkpoint, JSON.stringify(changed));
        } else await staged.recordAndFlush({ type: "user_message", content: "NEWER_INTENT_BETWEEN_STAGES" }, { runId: "newer-run", turnId: "newer-turn" });
        const before = await readFile(capture.finalPath, "utf8");
        await assert.rejects(staged.commitRetryReply({ ...input, stage: "terminal" }), between);
        assert.equal(await readFile(capture.finalPath, "utf8"), before, "second stage must revalidate before audit/terminal append");
      } finally { await staged.close(); }
    }
    // Exact existing final: repeat finish never duplicates the reply, selection or original run terminal.
    await reset(); const recorder = new SessionRecorder(root, "retry-origin", capture.finalPath); recorder.repairTailForAppend();
    recorder.setRuntimeContext({ runId: "recovery", turnId: baseline.turn.turnId! });
    try {
      const source = await readSessionEventsForBackfill(capture.finalPath, 0);
      const input: Parameters<SessionRecorder["commitRetryReply"]>[0] = { ownerTurnId: baseline.turn.turnId!, replyMessageId: baseline.turn.retryWindow!.replyMessageId,
        expectedRuntimeHighWater: baseline.turn.runtimeHighWater!, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } };
      const first = recorder.commitRetryReply(input); input.sourcePrefix.sha256 = "0".repeat(64); await first;
      const after = await readSessionEventsForBackfill(capture.finalPath, 0);
      await recorder.commitRetryReply({ ...input, sourcePrefix: { byteLength: after.byteLength, sha256: after.contentHash } });
      const facts = await readSessionEvents(capture.finalPath);
      assert.equal(facts.filter(event => event.type === "agent_message" && event.messageId === input.replyMessageId).length, 1);
      assert.equal(facts.filter(event => event.type === "message_version_selected" && event.messageId === input.replyMessageId).length, 1);
      const audits = facts.filter(event => event.type === "assistant_message" && event.messageId === input.replyMessageId);
      assert.equal(audits.length, 1);
      const originalAudit = capture.log.trimEnd().split("\n").map(line => JSON.parse(line)).find(event => event.type === "assistant_message" && event.messageId === input.replyMessageId);
      assert.deepEqual(audits[0], originalAudit, "matching rich audit is retained byte-for-field, not replaced with a minimal form");
      assert.equal(facts.filter(event => event.type === "turn_status" && event.runtime?.runId === baseline.turn.retryCommit!.runId).length, 1);
      assert.ok(await new TurnStore(root, "retry-origin").load());
    } finally { await recorder.close(); }
    await reset();
    const nativeLines = capture.log.trimEnd().split("\n");
    const beforeAudit = nativeLines.findIndex(line => { const event = JSON.parse(line); return event.type === "assistant_message" && event.messageId === baseline.turn.retryWindow!.replyMessageId; });
    assert.ok(beforeAudit > 0); await writeFile(capture.finalPath, nativeLines.slice(0, beforeAudit).join("\n") + "\n");
    const unrelatedRecorder = new SessionRecorder(root, "retry-origin", capture.finalPath); unrelatedRecorder.repairTailForAppend();
    unrelatedRecorder.setRuntimeContext({ runId: "recovery", turnId: baseline.turn.turnId! });
    try {
      await unrelatedRecorder.recordAndFlush({ type: "assistant_message", messageId: "different-id-same-text",
        content: baseline.turn.retryCommit!.outcome.output });
      const source = await readSessionEventsForBackfill(capture.finalPath, 0);
      await unrelatedRecorder.commitRetryReply({ ownerTurnId: baseline.turn.turnId!, replyMessageId: baseline.turn.retryWindow!.replyMessageId,
        expectedRuntimeHighWater: baseline.turn.runtimeHighWater!, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } });
      const facts = await readSessionEvents(capture.finalPath);
      assert.equal(facts.filter(event => event.type === "assistant_message" && event.messageId === "different-id-same-text").length, 1);
      assert.equal(facts.filter(event => event.type === "assistant_message" && event.messageId === baseline.turn.retryWindow!.replyMessageId).length, 1,
        "different-ID same text cannot stand in for the phase's actual reply audit");
    } finally { await unrelatedRecorder.close(); }
    // A saved, not-yet-canonical reply is still new data: ordinary redaction is
    // mandatory, and repeat validation compares its normalized physical form.
    const secret = "sk-test-secret-123456789012345678901234567890";
    const sourceLines = capture.log.trimEnd().split("\n");
    const witnessIndex = sourceLines.findIndex(line => JSON.parse(line).runtime?.eventId === baseline.turn.runtimeHighWater!.eventId);
    assert.ok(witnessIndex >= 0);
    const prefix = sourceLines.slice(0, witnessIndex + 1).join("\n") + "\n";
    const pending = structuredClone(baseline);
    pending.turn.retryCommit!.message.content = [{ type: "text", text: secret },
      { type: "reasoning", text: secret, providerMetadata: { signature: "fixture-signature" } }];
    pending.turn.retryCommit!.outcome.output = secret;
    await writeFile(capture.finalPath, prefix); await writeFile(checkpoint, JSON.stringify(pending));
    const normalRecorder = new SessionRecorder(root, "retry-origin", capture.finalPath); normalRecorder.repairTailForAppend();
    normalRecorder.setRuntimeContext({ runId: "recovery", turnId: baseline.turn.turnId! });
    try {
      const source = await readSessionEventsForBackfill(capture.finalPath, 0);
      const input: Parameters<SessionRecorder["commitRetryReply"]>[0] = { ownerTurnId: baseline.turn.turnId!, replyMessageId: baseline.turn.retryWindow!.replyMessageId,
        expectedRuntimeHighWater: baseline.turn.runtimeHighWater!, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } };
      await normalRecorder.commitRetryReply(input);
      await normalRecorder.commitRetryReply(input);
      assert.ok(!(await readFile(capture.finalPath, "utf8")).includes(secret));
      const redactedFacts = await readSessionEvents(capture.finalPath);
      assert.equal(redactedFacts.filter(event => event.type === "assistant_message" && event.messageId === input.replyMessageId).length, 1);
      const answer = redactedFacts.find(event => event.type === "agent_message" && event.messageId === input.replyMessageId);
      assert.ok(answer?.type === "agent_message" && answer.message.role === "assistant");
      assert.ok(answer.message.content.some(part => part.type === "text" && part.text.includes("[redacted]")));
      const reasoning = answer.message.content.find(part => part.type === "reasoning");
      assert.equal(reasoning?.type === "reasoning" ? reasoning.providerMetadata : undefined, undefined);
    } finally { await normalRecorder.close(); }
  } finally { if (originalRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = originalRoot; await rm(root, { recursive: true, force: true }); }
});

test("record-only sink notification is not a durable flush boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-record-only-control-"));
  await ensureAgentDirs(root);
  let recordReturned = false, flushAwaited = false;
  const observations: Array<{ recordReturned: boolean; flushAwaited: boolean; visibleBytes: number }> = [];
  let file = "";
  const recorder = new SessionRecorder(root, undefined, undefined, { appendSessionEvent() {
    observations.push({ recordReturned, flushAwaited, visibleBytes: readFileSync(file).byteLength });
  } });
  file = recorder.filePath;
  try {
    recorder.record({ type: "user_message", content: "record-only durable-boundary control" }); recordReturned = true;
    assert.equal(observations.length, 1); assert.equal(observations[0]?.recordReturned, false);
    assert.equal(observations[0]?.flushAwaited, false);
    await recorder.flush(); flushAwaited = true;
    assert.equal((await readSessionEvents(file)).length, 1);
    // visibleBytes is intentionally not a durability assertion: kernel visibility
    // and synchronous callback completion do not establish an fsync receipt.
  } finally { await recorder.close(); await rm(root, { recursive: true, force: true }); }
});
