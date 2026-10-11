import assert from "node:assert/strict";
import { activeSessionMessageIds } from "../src/session/messageTree.js";
import type { SessionEvent } from "../src/session/recorder.js";

// 小图穷举可达路径作 oracle，覆盖向前引用、环、缺失节点以及冲突的版本选择。
let seed = 41;
const random = (limit: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % limit;
};
for (let run = 0; run < 300; run += 1) {
  const nodes = Array.from({ length: 30 }, (_, index) => ({ id: String(index), parent: String(random(33)) }));
  const selections = Array.from({ length: random(4) }, () => String(random(33)));
  const events = [
    ...nodes.map((node) => ({ type: "user_message", timestamp: "2026-09-11T00:00:00Z", content: "message", messageId: node.id, parentMessageId: node.parent })),
    ...selections.map((id, index) => ({ type: "message_version_selected", timestamp: "2026-09-11T00:00:00Z", slotId: String(index), messageId: id }))
  ] as SessionEvent[];
  let cyclic = false;
  const paths = nodes.map((leaf) => {
    const ids = new Set<string>();
    let current: typeof leaf | undefined = leaf;
    while (current && !ids.has(current.id)) {
      ids.add(current.id);
      current = nodes.find((node) => node.id === current?.parent);
    }
    if (current) cyclic = true;
    return ids;
  });
  // Invalid slot markers, unknown IDs and cycles retain the historical oracle.
  // Only valid acyclic choices intentionally gain newest-first precedence.
  const valid = !cyclic && selections.every((id, index) =>
    id === String(index) && nodes.some((node) => node.id === id));
  let candidates = paths;
  if (valid) {
    for (const id of [...selections].reverse()) {
      const compatible = candidates.filter((ids) => ids.has(id));
      if (compatible.length) candidates = compatible;
    }
  } else candidates = paths.filter((ids) => selections.every((id) => ids.has(id)));
  const expected = candidates.at(-1) ?? paths.at(-1)!;
  assert.deepEqual(activeSessionMessageIds(events), expected);
}
const longHistory = Array.from({ length: 20_000 }, (_, index) => ({
  type: "user_message", timestamp: "2026-09-11T00:00:00Z", content: "message", messageId: String(index), parentMessageId: index ? String(index - 1) : undefined
})) as SessionEvent[];
assert.equal(activeSessionMessageIds(longHistory).size, 20_000);
longHistory.push({ type: "message_version_selected", timestamp: "2026-09-11T00:00:00Z", slotId: "0", messageId: "0" } as SessionEvent);
assert.equal(activeSessionMessageIds(longHistory).size, 20_000);
console.log("message tree tests passed");
