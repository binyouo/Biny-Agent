/** 会话事件缓冲：草稿首发时未选中会话的头部事件先暂存，选中后原序回放或按文档覆盖作废。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionEventBuffer } from "../src/desktop/renderer/src/app/sessionEventBuffer.js";

test("缓冲按会话隔离，回放保持原序且只回放一次", () => {
  const buffer = createSessionEventBuffer<string>();
  buffer.hold("session-a", "a1");
  buffer.hold("session-b", "b1");
  buffer.hold("session-a", "a2");
  assert.deepEqual(buffer.take("session-a"), ["a1", "a2"]);
  assert.deepEqual(buffer.take("session-a"), [], "取出即清空，不会重复回放");
  assert.deepEqual(buffer.take("session-b"), ["b1"]);
  assert.deepEqual(buffer.take("session-c"), []);
});

test("同一会话超过上限时丢弃最旧的头部事件", () => {
  const buffer = createSessionEventBuffer<string>(3);
  for (const event of ["e1", "e2", "e3", "e4"]) buffer.hold("session", event);
  assert.deepEqual(buffer.take("session"), ["e2", "e3", "e4"]);
});

test("discard 为 true 时清空缓冲但不回放：文档已带完整 liveEvents，缓冲是子集", () => {
  const buffer = createSessionEventBuffer<string>();
  buffer.hold("session", "head");
  assert.deepEqual(buffer.take("session", true), []);
  assert.deepEqual(buffer.take("session"), []);
});
