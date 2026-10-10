import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import type { SessionEvent } from "../src/session/recorder.js";
import type { RuntimeHighWater } from "../src/session/runtimeEvent.js";
import type { InterruptedTurn } from "../src/session/turnStore.js";

const cases = [
  ["latest-text", "admission"], ["older-originaltools", "dispatch"],
  ["latest-text", "partial"], ["older-text", "partial"], ["primer-latest-originaltools", "partial"],
  ["multistep-older-originaltools", "partial"], ["ordinary-originaltools", "partial"], ["unsafe-older-originaltools", "partial"],
  ["no-metrics-originaltools", "partial"], ["no-metrics-originaltools", "final"], ["tool-calls-phase-originaltools", "final"], ["incomplete-phase-originaltools", "final"], ["empty-phase-originaltools", "final"], ["runtime-originaltools", "final"], ["latest-originaltools", "audit"], ["latest-originaltools", "phase-no-audit"], ["incomplete-phase-originaltools", "phase-no-audit"], ["latest-originaltools", "final"], ["older-originaltools", "final"],
  ["older-originaltools", "selection"], ["older-originaltools", "terminal"], ["older-originaltools", "clear"]
] as const;
for (const [scenario, boundary] of cases) test(`retry origin: ${boundary.startsWith("phase-") || scenario.includes("no-metrics") ? "recorded-prefix" : "SIGKILL"} ${scenario} at ${boundary}`, { timeout: 40_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-origin-"));
  const marker = path.join(root, "capture.json");
  await mkdir(path.join(root, "tmp"));
  try {
    const captured = await worker("capture", root, scenario, boundary, marker);
    assert.equal(captured.signal, "SIGKILL", captured.output);
    if (boundary === "phase-no-audit") {
      // Distinct recorded-prefix fixture: retain the durable phase, but cut at
      // its precommit witness before either rich audit or canonical reply.
      const captured = JSON.parse(await readFile(marker, "utf8")) as { log: string; finalPath: string; checkpoint: string };
      const saved = JSON.parse(captured.checkpoint) as { turn: InterruptedTurn };
      const lines = captured.log.trimEnd().split("\n");
      const witness = lines.findIndex(line => JSON.parse(line).runtime?.eventId === saved.turn.retryCommit!.runtimeHighWater.eventId);
      assert.ok(witness >= 0); captured.log = lines.slice(0, witness + 1).join("\n") + "\n";
      await writeFile(captured.finalPath, captured.log); await writeFile(marker, JSON.stringify(captured));
    }
    if (scenario.includes("no-metrics")) {
      // Data-only compatibility fixture for best-effort metrics loss: remove
      // metrics, preserve every domain fact/ID, and rebind contiguous witnesses.
      const captured = JSON.parse(await readFile(marker, "utf8")) as { log: string; finalPath: string; checkpoint: string; checkpointPath: string };
      const original = captured.log.trimEnd().split("\n").map(line => JSON.parse(line) as SessionEvent);
      const kept = original.filter(event => event.type !== "model_request");
      const renumbered = kept.map((event, index) => ({ ...event, runtime: event.runtime ? { ...event.runtime, eventSeq: index + 1 } : undefined }));
      const mapWitness = (witness: RuntimeHighWater) => {
        const index = kept.findLastIndex(event => (event.runtime?.eventSeq ?? Infinity) <= witness.eventSeq);
        assert.ok(index >= 0); return renumbered[index]!.runtime!;
      };
      const saved = JSON.parse(captured.checkpoint) as { version: number; turn: InterruptedTurn };
      saved.turn.runtimeHighWater = mapWitness(saved.turn.runtimeHighWater!);
      const origin = saved.turn.retryOrigin!; origin.targetRuntime = mapWitness(origin.targetRuntime); origin.admissionHighWater = mapWitness(origin.admissionHighWater);
      saved.turn.retryWindow!.admissionHighWater = mapWitness(saved.turn.retryWindow!.admissionHighWater);
      if (saved.turn.retryCommit) saved.turn.retryCommit.runtimeHighWater = saved.turn.runtimeHighWater;
      captured.log = renumbered.map(event => JSON.stringify(event)).join("\n") + "\n"; captured.checkpoint = JSON.stringify(saved);
      await writeFile(captured.finalPath, captured.log); await writeFile(captured.checkpointPath, captured.checkpoint); await writeFile(marker, JSON.stringify(captured));
    }
    const recovered = await worker("recover", root, scenario, boundary, marker);
    assert.equal(recovered.code, 0, recovered.output);
    const report = JSON.parse(await readFile(`${marker}.result`, "utf8")) as {
      cold: AgentMessage[]; firstRequests: Array<{ messages: AgentMessage[]; step?: number }>;
      requests: Array<{ phase: string; messages: AgentMessage[] }>; events: AgentSessionEvent[]; error?: string;
      checkpoint?: InterruptedTurn; firstOutcome?: { status: string }; facts: SessionEvent[]; canonical: AgentMessage[]; owner?: string;
    };
    const outcome = report.events.findLast(event => event.type === "done");
    if (scenario.includes("unsafe")) {
      assert.equal(outcome?.outcome.blockedReason, "unsafe_action_required");
      assert.equal(report.firstRequests.length, 0);
      assert.ok(report.checkpoint?.retryOrigin);
      return;
    }
    if (boundary === "terminal" || boundary === "clear") assert.match(report.error ?? "", /no interrupted turn/u);
    else { assert.equal(report.error, undefined); assert.equal(outcome?.outcome.status, "completed"); }
    assert.equal(report.firstRequests.length, ["phase-no-audit", "audit", "final", "selection", "terminal", "clear"].includes(boundary) ? 0 : 1);
    if (boundary === "terminal") assert.ok(report.checkpoint?.retryCommit, "durable terminal dominates a stale retained phase");
    else assert.equal(report.checkpoint, undefined);
    const expected = [...scenario.includes("originaltools") ? ["original"] : [],
      ...boundary === "partial" ? [
        ...Array.from({ length: scenario.includes("multistep") ? 2 : scenario.includes("primer") ? 1 : 0 }, (_, index) => `primer-${index}`), "fast", "slow"
      ] : ["phase-no-audit", "audit", "final", "selection", "terminal", "clear"].includes(boundary) ? ["retry"] : []];
    for (const messages of [...report.firstRequests.map(request => request.messages), report.canonical,
      ...report.requests.filter(request => request.phase === "next").map(request => request.messages)]) assertPairs(messages, expected);
    if (scenario.includes("incomplete-phase") || scenario.includes("empty-phase") || scenario.includes("tool-calls-phase")) {
      assert.equal(report.firstOutcome?.status, "incomplete");
      assert.equal(report.facts.filter(event => event.type === "agent_message" && event.messageId === "next-window-reply").length, 1);
    }
    if (!scenario.includes("ordinary")) {
      assert.equal(report.facts.filter(event => event.type === "user_message").length, 1);
      const finals = report.facts.filter(event => event.type === "agent_message" && event.messageId === "reserved-retry-final");
      assert.equal(finals.length, 1);
      assert.equal(report.facts.filter(event => event.type === "assistant_message" && event.messageId === "reserved-retry-final").length, 1);
      assert.equal(report.facts.filter(event => event.type === "message_version_selected" && event.messageId === "reserved-retry-final").length, 1);
    }
    if (scenario.includes("multistep")) assert.equal(report.firstRequests[0]?.step, 4, "continuation preserves prior step accounting");
  } finally { await rm(root, { recursive: true, force: true }); }
});
function assertPairs(messages: AgentMessage[], expected: string[]): void {
  const calls: string[] = [], results: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") calls.push(part.id);
    if (message.role === "toolResult") { assert.ok(calls.includes(message.toolCallId)); results.push(message.toolCallId); }
  }
  assert.deepEqual(calls, expected); assert.deepEqual(results.toSorted(), expected.toSorted());
}
async function worker(mode: string, root: string, scenario: string, boundary: string, marker: string) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/retry-origin-worker.ts", import.meta.url)),
      mode, root, "retry-origin", scenario, boundary, marker], { env: {
      PATH: process.env.PATH, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: path.join(root, "tmp"),
      BINY_AGENT_DIR: path.join(root, "agent"), BINY_TEST_PROCESS: "1", TZ: "UTC", NO_COLOR: "1"
    }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Timed out: ${output}`)); }, 30_000);
    child.stdout.on("data", value => { output += String(value); }); child.stderr.on("data", value => { output += String(value); });
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}
