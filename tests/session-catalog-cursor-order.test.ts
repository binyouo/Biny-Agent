import assert from "node:assert/strict";
import { buildSessionTree, querySessionCatalogItems, type SessionCatalogItem } from "../src/session/catalog.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const decomposed = "cafe\u0301";
const composed = "caf\u00e9";

function item(id: string, updatedAt = timestamp, extra: Partial<SessionCatalogItem> = {}): SessionCatalogItem {
  return {
    id,
    fileName: `${id}.jsonl`,
    rootSessionId: id,
    hasChildren: false,
    summary: { fileName: `${id}.jsonl`, firstUserMessage: "", lastAssistantMessage: "", createdAt: timestamp, updatedAt, eventCount: 1 },
    ...extra
  };
}

function paginate(input: SessionCatalogItem[], limit: number): string[] {
  const sorted = buildSessionTree(input).map((node) => node.session);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber <= input.length; pageNumber++) {
    const page = querySessionCatalogItems(sorted, { limit, cursor });
    assert.equal(page.revisionChanged, false);
    ids.push(...page.items.map((entry) => entry.id));
    cursor = page.nextCursor;
    if (cursor === undefined) return ids;
  }
  throw new Error("Catalog pagination did not terminate.");
}

// Opaque custom IDs can be distinct strings even when locale collation considers them equal.
// This is an in-memory ordering regression, not a filesystem normalization assertion.
assert.notEqual(decomposed, composed);
assert.equal(decomposed.localeCompare(composed), 0);
for (const reverse of [false, true]) {
  const pair = [item(decomposed), item(composed)];
  if (reverse) pair.reverse();
  assert.deepEqual(paginate(pair, 1), [composed, decomposed]);
  for (const limit of [1, 2, 3, 4, 5, 50]) {
    const input = [item("z"), ...pair, item("b"), item("a")];
    if (reverse) input.reverse();
    assert.deepEqual(paginate(input, limit), ["z", composed, decomposed, "b", "a"]);
  }
}

const ascii = ["z", "b", "a", "20261010-120000-000-abcdef01", "00000000-0000-4000-8000-000000000001"];
for (const limit of [1, 2, 50]) {
  assert.deepEqual(paginate(ascii.map((id) => item(id)), limit), [...ascii].sort((left, right) => right.localeCompare(left)));
  assert.deepEqual(paginate([
    item(decomposed, "2026-01-02T00:00:00.000Z"), item(composed), item("z", "2025-12-31T00:00:00.000Z")
  ], limit), [decomposed, composed, "z"]);
}

const siblings = [item("root"), item(decomposed, timestamp, { parentSessionId: "root" }), item(composed, timestamp, { parentSessionId: "root" })];
for (const input of [siblings, [...siblings].reverse()]) {
  const children = buildSessionTree(input)[0]!.children.map((node) => node.session);
  assert.deepEqual(children.map((child) => child.id), [composed, decomposed]);
  const first = querySessionCatalogItems(children, { limit: 1, parentSessionId: "root" });
  assert.ok(first.nextCursor);
  const second = querySessionCatalogItems(children, { limit: 1, parentSessionId: "root", cursor: first.nextCursor });
  assert.deepEqual(second.items.map((child) => child.id), [decomposed]);
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.revisionChanged, false);
}

// Invalid dates retain the existing zero-time fallback and still need a total ID order.
assert.deepEqual(paginate([item(decomposed, "invalid"), item(composed, "also invalid")], 1), [composed, decomposed]);

// Cycle recovery uses the same ordering when choosing which node to promote to a root.
const cycle = [item(decomposed, timestamp, { parentSessionId: composed }), item(composed, timestamp, { parentSessionId: decomposed })];
for (const input of [cycle, [...cycle].reverse()]) {
  const tree = buildSessionTree(input);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.session.id, composed);
  assert.deepEqual(tree[0]?.children.map((node) => node.session.id), [decomposed]);
}

console.log("session catalog cursor ordering tests passed");
