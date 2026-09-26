/** preload 的读取并发预算：同参共享在途请求，不跨请求缓存结果或失败。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopReadRequest } from "../src/desktop/readRequests.js";

test("相同读取共享在途工作，不同参数隔离，完成后重新读取", async () => {
  const completions: Array<(value: unknown) => void> = [];
  const calls: unknown[][] = [];
  const read = createDesktopReadRequest((...args) => {
    calls.push(args);
    return new Promise((resolve) => completions.push(resolve));
  });
  const first = read("bootstrap");
  const duplicate = read("bootstrap");
  const other = read("catalog", "p2");
  assert.equal(calls.length, 2);
  completions[0]!({ ready: true }); completions[1]!([]);
  assert.deepEqual(await first, await duplicate); await other;
  const fresh = read("bootstrap");
  assert.equal(calls.length, 3);
  completions[2]!("fresh"); assert.equal(await fresh, "fresh");
});

test("失败释放在途请求，下一次可以成功", async () => {
  let calls = 0;
  const read = createDesktopReadRequest(async () => {
    if (++calls === 1) throw new Error("offline");
    return "ready";
  });
  const results = await Promise.allSettled([read("bootstrap"), read("bootstrap")]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(calls, 1);
  assert.equal(await read("bootstrap"), "ready");
});
