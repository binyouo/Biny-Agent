import assert from "node:assert/strict";
import test from "node:test";
import { privacyFlowNodes } from "../src/desktop/renderer/src/components/settings/privacyFlowData.js";
import type { DesktopMaskRecordSummary } from "../src/desktop/protocol.js";

function record(sessionId: string | undefined, provider: string, count: number): DesktopMaskRecordSummary {
  return { id: "fixture", time: "2026-10-28T12:00:00Z", model: "fixture", operation: "agent", sessionId, provider, count, uniqueValues: count, kinds: { SECRET: count } };
}

test("privacy flow aggregates repeated sessions and providers from the same request counts", () => {
  const flow = privacyFlowNodes([record("session-a", "provider-a", 10), record("session-a", "provider-b", 4), record("session-b", "provider-a", 3)]);
  assert.deepEqual(flow.sessions.map(({ id, count }) => ({ id, count })), [{ id: "session-a", count: 14 }, { id: "session-b", count: 3 }]);
  assert.deepEqual(flow.providers.map(({ id, count }) => ({ id, count })), [{ id: "provider-a", count: 13 }, { id: "provider-b", count: 4 }]);
});

test("privacy flow keeps three leading endpoints and conserves counts in the remainder", () => {
  const records = [record("one", "a", 9), record("two", "b", 7), record("three", "c", 5), record("four", "d", 3), record("five", "e", 1)];
  const flow = privacyFlowNodes(records);
  for (const nodes of [flow.sessions, flow.providers]) {
    assert.equal(nodes.length, 4);
    assert.equal(nodes.reduce((sum, node) => sum + node.count, 0), 25);
    assert.deepEqual(nodes[3], { id: "", label: "另外 2 项", count: 4 });
  }
});

test("privacy flow never invents traffic or session identities", () => {
  assert.deepEqual(privacyFlowNodes([]), { sessions: [], providers: [] });
  const flow = privacyFlowNodes([record(undefined, "fixture", 2)]);
  assert.deepEqual(flow.sessions, [{ id: "", label: "辅助请求", count: 2 }]);
});
