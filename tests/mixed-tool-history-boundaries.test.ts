import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import type { AgentMessage } from "../src/agent/core/types.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";

// Additional Green coverage; the separately published Red regression stays frozen.
function batch(suffix: string): AgentMessage[] {
  return [
    { role: "assistant", content: [
      { type: "toolCall", id: `patch-${suffix}`, name: "apply_patch", arguments: { marker: `patch-${suffix}` } },
      { type: "toolCall", id: `read-${suffix}`, name: "Read", arguments: { path: `${suffix}.txt` } }
    ] },
    { role: "toolResult", toolCallId: `patch-${suffix}`, toolName: "apply_patch", content: [{ type: "text", text: `patch-output-${suffix}` }] },
    { role: "toolResult", toolCallId: `read-${suffix}`, toolName: "Read", content: [{ type: "text", text: `read-output-${suffix}` }] }
  ];
}

function projectedBatch(suffix: string, nativePatch: boolean): ModelMessage[] {
  const assistant: ModelMessage = { role: "assistant", content: [
    nativePatch
      ? { type: "tool-call", toolCallId: `patch-${suffix}`, toolName: "apply_patch", input: { marker: `patch-${suffix}` } }
      : { type: "text", text: `Historical file patch request: ${JSON.stringify({ marker: `patch-${suffix}` })}` },
    { type: "tool-call", toolCallId: `read-${suffix}`, toolName: "Read", input: { path: `${suffix}.txt` } }
  ] };
  const read: ModelMessage = { role: "tool", content: [{
    type: "tool-result", toolCallId: `read-${suffix}`, toolName: "Read", output: { type: "text", value: `read-output-${suffix}` }
  }] };
  const patch: ModelMessage = nativePatch
    ? { role: "tool", content: [{ type: "tool-result", toolCallId: `patch-${suffix}`, toolName: "apply_patch", output: { type: "json", value: { status: "completed", output: `patch-output-${suffix}` } } }] }
    : { role: "assistant", content: [{ type: "text", text: `Historical file patch result (completed): patch-output-${suffix}` }] };
  return nativePatch ? [assistant, patch, read] : [assistant, read, patch];
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

for (const nativePatch of [false, true]) {
  test(`mixed result batch flushes at EOF; native=${String(nativePatch)}`, () => {
    const canonical = batch("eof");
    const before = JSON.stringify(canonical);
    freeze(canonical);
    assert.deepEqual(toModelMessages(canonical, nativePatch), projectedBatch("eof", nativePatch));
    assert.equal(JSON.stringify(canonical), before);
  });

  test(`patch notes do not move across assistant/user or batch boundaries; native=${String(nativePatch)}`, () => {
    const canonical: AgentMessage[] = [
      { role: "user", content: "FIRST-REQUEST" }, ...batch("first"),
      { role: "assistant", content: [{ type: "text", text: "FIRST-FINAL" }] },
      { role: "user", content: "SECOND-REQUEST" }, ...batch("second"),
      { role: "assistant", content: [{ type: "text", text: "SECOND-FINAL" }] },
      { role: "user", content: "LATEST-REQUEST" }
    ];
    const before = JSON.stringify(canonical);
    freeze(canonical);
    assert.deepEqual(toModelMessages(canonical, nativePatch), [
      { role: "user", content: "FIRST-REQUEST" }, ...projectedBatch("first", nativePatch),
      { role: "assistant", content: [{ type: "text", text: "FIRST-FINAL" }] },
      { role: "user", content: "SECOND-REQUEST" }, ...projectedBatch("second", nativePatch),
      { role: "assistant", content: [{ type: "text", text: "SECOND-FINAL" }] },
      { role: "user", content: "LATEST-REQUEST" }
    ]);
    assert.equal(JSON.stringify(canonical), before);
  });
}
