import assert from "node:assert/strict";
import test from "node:test";
import { recordMask, maskingOverview, maskingDetail, resetMaskRecordsForTest } from "../src/privacy/record.js";

const segments = [{ path: "messages.0.content", original: "password=example", masked: "password={{PASSWORD_abcdefgh}}", segments: [{ kind: "password", original: "example", masked: "{{PASSWORD_abcdefgh}}", start: 9, end: 16 }] }];
test("small records remain available beyond 100 requests", () => {
  resetMaskRecordsForTest();
  const first = recordMask({ provider: "fixture", model: "fixture", segments })!;
  for (let i = 1; i < 150; i++) recordMask({ provider: "fixture", model: "fixture", segments });
  assert.equal(maskingOverview().records.length, 150);
  assert.equal(maskingOverview().summary.total, 150);
  assert.ok(maskingDetail(first.id));
  resetMaskRecordsForTest();
});
test("retention counts metadata and evicts oldest records when the memory budget fills", () => {
  resetMaskRecordsForTest();
  const first = recordMask({ provider: "fixture", model: "fixture", segments })!;
  let latest = first;
  for (let i = 0; i < 50; i++) latest = recordMask({ provider: "fixture", model: "m".repeat(100_000), segments })!;
  assert.equal(maskingDetail(first.id), undefined);
  assert.ok(maskingDetail(latest.id));
  assert.ok(maskingOverview().records.length > 0);
  resetMaskRecordsForTest();
});
