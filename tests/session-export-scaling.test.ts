/** Supported public exports retain provenance without quadratic pending-history work. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { SessionEvent } from "../src/session/recorder.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-export-scaling-")));
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const { maxSessionEvents, maxSessionFileBytes, maxSessionHistoryBytes } = await import("../src/session/limits.js");
const { createSessionFile, ensureAgentDirs } = await import("../src/session/store.js");
const { exportSessionClaudeCode } = await import("../src/session/transfer.js");
const workspace = path.join(root, "workspace");
await mkdir(workspace);
await ensureAgentDirs(workspace);
after(async () => { await rm(root, { recursive: true, force: true }); });

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function checkBoundedExport(label: string, events: SessionEvent[], expectedResults: string[] | "unresolved") {
  assert.equal(events.length, maxSessionEvents, "fixture exercises the supported event cap");
  const raw = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  assert.ok(Buffer.byteLength(raw) < maxSessionFileBytes && Buffer.byteLength(raw) < maxSessionHistoryBytes);
  const source = await createSessionFile(workspace, label, Buffer.from(raw));
  const cold = await exportSessionClaudeCode(workspace, label);
  const expectedHash = hash(cold.content);
  // Deterministically catch the former repeated pending-array filters. The guard
  // counts callback visits, not host-dependent elapsed time, and restores the
  // native method before validation. No production hook or alternate exporter.
  const filter = Array.prototype.filter;
  let filterVisits = 0;
  Array.prototype.filter = function <T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T[] {
    return filter.call(this, (value: T, index: number, array: T[]) => {
      assert.ok(++filterVisits <= events.length * 8, `${label}: public export exceeded its linear array-filter visit budget`);
      return predicate.call(thisArg, value, index, array);
    });
  };
  let warm;
  try { warm = await exportSessionClaudeCode(workspace, label); }
  finally { Array.prototype.filter = filter; }
  assert.equal(hash(warm.content), expectedHash, "generated identities and complete output stay deterministic");
  assert.equal(hash(await readFile(source)), hash(raw), "public export never rewrites source bytes");
  const calls = new Set<string>();
  const resultIds: string[] = [];
  for (const row of warm.content.trim().split("\n")) {
    const line = JSON.parse(row) as { message: { content: string | Array<{ type: string; id: string; tool_use_id: string }> } };
    if (!Array.isArray(line.message.content)) continue;
    for (const block of line.message.content) {
      if (block.type === "tool_use") {
        assert.ok(!calls.has(block.id), "generated and unique explicit call identities cannot collide");
        calls.add(block.id);
      }
      if (block.type === "tool_result") resultIds.push(block.tool_use_id);
    }
  }
  assert.equal(resultIds.length, events.filter((event) => event.type === "tool_result").length);
  if (expectedResults === "unresolved") assert.ok(resultIds.every((id) => id === ""), "old uncertainty remains a provenance competitor");
  else assert.deepEqual(resultIds, expectedResults, "proven completions keep their exact invocation identity");
  // This guards the reproduced filter regression; the indexed algorithm's
  // amortized bound and real public-export timings are reviewed separately.
}

test("50,000-event unresolved same-tool history retains all uncertain competitors with bounded work", async () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "Synthetic performance fixture" },
    { type: "tool_call", tool: "Read", args: {} },
    { type: "tool_call", tool: "Read", args: {} }
  ];
  for (let index = 0; index < 24_998; index++) {
    events.push({ type: "tool_call", tool: "Read", args: { path: `synthetic-${index}.txt` } },
      { type: "tool_result", tool: "Read", result: "synthetic result", executionStatus: "succeeded" });
  }
  events.push({ type: "assistant_message", content: "Synthetic complete" });
  await checkBoundedExport("unresolved", events, "unresolved");
});

test("50,000-event interrupted history keeps cross-boundary uncertainty with bounded work", async () => {
  const events: SessionEvent[] = [{ type: "user_message", content: "Synthetic performance fixture" }];
  for (let index = 0; index < 16_666; index++) {
    events.push({ type: "tool_call", tool: "Read", args: { path: `synthetic-${index}.txt` } },
      { type: "turn_interrupted", reason: "interrupted", content: "Synthetic interruption" },
      { type: "tool_result", tool: "Read", result: "synthetic result", executionStatus: "succeeded" });
  }
  events.push({ type: "assistant_message", content: "Synthetic complete" });
  await checkBoundedExport("interrupted", events, "unresolved");
});

for (const identity of ["explicit", "sequence"] as const) {
  test(`50,000-event pending ${identity} batch removes only proven completions with bounded work`, async () => {
    const events: SessionEvent[] = [{ type: "user_message", content: "Synthetic pending batch" }];
    const results: SessionEvent[] = [];
    const expected: string[] = [];
    for (let index = 0; index < 24_999; index++) {
      const fields = identity === "explicit" ? { toolCallId: `explicit_${index}` } : { sequence: index - 12_000.5 };
      events.push({ type: "tool_call", tool: index % 2 ? "Read" : "Bash", args: { index }, ...fields });
      results.push({ type: "tool_result", tool: index % 2 ? "Read" : "Bash", result: String(index), ...fields });
      expected.push(identity === "explicit" ? `explicit_${index}` : `call_${index + 1}`);
    }
    // Reverse completion order also exercises removal away from each group's head.
    events.push(...results.reverse(), { type: "assistant_message", content: "Synthetic complete" });
    await checkBoundedExport(`batch-${identity}`, events, expected.reverse());
  });
}
