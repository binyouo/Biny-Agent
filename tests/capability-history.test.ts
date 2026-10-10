import assert from "node:assert/strict";
import { accumulatedAutomaticToolNames } from "../src/agent/automaticToolHistory.js";
import type { SessionEvent } from "../src/session/recorder.js";

const events: SessionEvent[] = Array.from({ length: 6 }, (_, index) => ({
  type: "user_message", messageId: `m${index}`, content: `topic ${index}`,
  metadata: { automaticToolSelection: true, capabilitySelection: { tools: [`tool${index}`], skills: [] } }
}));
const active = new Set(["m0", "m1", "m2", "m3", "m4", "m5"]);
assert.deepEqual(accumulatedAutomaticToolNames(events, active, "m5"), ["tool0", "tool1", "tool2", "tool3", "tool4"], "retain all prior active turns in first-selection order, not a three-turn window");
events.push({ type: "message_metadata", messageId: "m4", metadata: { capabilitySelection: { tools: ["replacement", "tool0"], skills: [] }, automaticToolFreshSelection: [] } });
assert.deepEqual(accumulatedAutomaticToolNames(events, active, "m5"), ["tool0", "tool1", "tool2", "tool3", "replacement"], "saved cumulative choices remain valid even when older metadata marks them inherited");
events.push({ type: "message_metadata", messageId: "m4", metadata: { emotionAnalyzed: true } });
assert.equal(accumulatedAutomaticToolNames(events, active, "m5").at(-1), "replacement", "unrelated metadata does not erase selection");
events.push({ type: "message_metadata", messageId: "m4", metadata: { automaticToolSelection: false } });
assert.deepEqual(accumulatedAutomaticToolNames(events, active, "m5"), ["tool0", "tool1", "tool2", "tool3"], "explicit choices do not become automatic retained tools");
active.delete("m1");
assert.deepEqual(accumulatedAutomaticToolNames(events, active, "m5"), ["tool0", "tool2", "tool3"], "inactive branch must not contribute");
events.push({ type: "user_message", messageId: "audit", content: "internal", auditOnly: true,
  metadata: { automaticToolSelection: true, capabilitySelection: { tools: ["internal"], skills: [] } } });
active.add("audit");
assert.deepEqual(accumulatedAutomaticToolNames(events, active, "m5"), ["tool0", "tool2", "tool3"], "audit-only rows do not contribute automatic selections");
console.log("capability history tests passed");
