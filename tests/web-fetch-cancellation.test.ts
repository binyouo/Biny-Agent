import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createWebFetchTool } from "../src/tools/web/fetch.js";

for (const action of ["cancel", "timeout"] as const) {
  test(`WebFetch ${action} stops while DNS is pending, and late DNS cannot dispatch a request`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected HTTP request"); });
    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    let finishDns!: (addresses: string[]) => void;
    const controller = new AbortController();
    const tool = createWebFetchTool({ timeoutMs: 100, maxBytes: 1000, maxRedirects: 2, allowPrivateNetwork: false }, { enabled: false }, {
      resolveHostname: async () => {
        entered();
        return await new Promise<string[]>((resolve) => { finishDns = resolve; });
      }
    });
    const execution = await tool.resolveExecution({ url: "https://example.com/" });
    assert.ok("execute" in execution);
    let failure: unknown;
    const result = execution.execute({ toolCallId: "cancel-fetch", signal: controller.signal }).catch((error: unknown) => { failure = error; });
    try {
      await resolving;
      if (action === "cancel") controller.abort(new Error("user cancelled"));
      else context.mock.timers.tick(100);
      // DNS 和超时均由测试控制；这里只清空当前事件循环的 Promise 回调。
      await setImmediate();
      assert.ok(failure instanceof Error, `${action} must settle before DNS completes`);
      assert.match(failure.message, action === "cancel" ? /cancel/iu : /timed out/iu);
    } finally {
      controller.abort();
      finishDns(["8.8.8.8"]);
      await result;
    }
    assert.equal(fetch.mock.callCount(), 0);
  });
}
