import assert from "node:assert/strict";
import type { AgentMessage } from "../../src/agent/core/types.js";

export function assertRestoredConversation(actual: AgentMessage[], canonical: AgentMessage[]): void {
  assert.equal(actual.length, canonical.length);
  for (const [index, expected] of canonical.entries()) {
    const restored = actual[index]!;
    if (expected.role !== "user" || !expected.emotionSnapshot) {
      assert.deepEqual(restored, expected);
      continue;
    }
    assert.equal(restored.role, "user");
    if (restored.role !== "user") assert.fail("restored message must retain its role");
    assert.equal(typeof expected.content, "string");
    assert.equal(typeof restored.content, "string");
    assert.equal(restored.originalContent, expected.content, "the original user text remains intact");
    assert.ok(String(restored.content).startsWith("<biny_emotion_history>\n"));
    assert.ok(String(restored.content).includes(expected.emotionSnapshot), "the persisted mood survives checkpoint recovery");
    assert.ok(String(restored.content).endsWith(`</biny_emotion_history>\n\n${String(expected.content)}`));
    const { originalContent, ...message } = restored;
    assert.deepEqual({ ...message, content: originalContent }, expected,
      "emotion projection must not change message identity, timestamps or canonical facts");
  }
}
