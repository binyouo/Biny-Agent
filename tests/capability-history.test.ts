import assert from "node:assert/strict";
import { recentAutomaticToolNames } from "../src/agent/automaticToolHistory.js";
import type { SessionEvent } from "../src/session/recorder.js";

const events: SessionEvent[] = Array.from({ length: 20 }, (_, index) => ({
  type: "user_message", messageId: `m${index}`, content: `topic ${index}`,
  metadata: { automaticToolSelection: true, capabilitySelection: { tools: [`tool${index}`], skills: [] } }
}));
const active = new Set(events.map((event) => event.type === "user_message" ? event.messageId! : ""));
assert.deepEqual(recentAutomaticToolNames(events, active, "m19"), ["tool18", "tool17", "tool16"], "only three prior active turns, most recent first");
events.push({ type: "message_metadata", messageId: "m18", metadata: { capabilitySelection: { tools: ["replacement"], skills: [] } } });
assert.deepEqual(recentAutomaticToolNames(events, active, "m19"), ["replacement", "tool17", "tool16"], "new selection metadata replaces older selection");
events.push({ type: "message_metadata", messageId: "m18", metadata: { emotionAnalyzed: true } });
assert.equal(recentAutomaticToolNames(events, active, "m19")[0], "replacement", "unrelated metadata does not erase selection");
events.push({ type: "message_metadata", messageId: "m18", metadata: { automaticToolSelection: false } });
assert.deepEqual(recentAutomaticToolNames(events, active, "m19"), ["tool17", "tool16"], "explicit choices do not become automatic retained tools");
active.delete("m17");
assert.deepEqual(recentAutomaticToolNames(events, active, "m19"), ["tool16", "tool15"], "inactive branch must not contribute");
events.push({ type: "user_message", messageId: "audit", content: "internal", auditOnly: true,
  metadata: { automaticToolSelection: true, capabilitySelection: { tools: ["internal"], skills: [] } } });
active.add("audit");
assert.deepEqual(recentAutomaticToolNames(events, active, "m19"), ["tool16", "tool15"], "audit-only rows do not age public turn history");
console.log("capability history tests passed");
