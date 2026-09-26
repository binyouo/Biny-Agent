/** Sleep REST 在执行端异常时保留各入口的公开错误响应。 */
import assert from "node:assert/strict";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";

type Client = Parameters<typeof startMemoryHttpServer>[0];
let failedAction = "";
const client = {
  memory: async (action: string) => {
    if (action === failedAction) throw new Error("sleep storage unavailable");
    throw new Error(`Unexpected action: ${action}`);
  },
  cancelMemorySleep: async () => { throw new Error("sleep owner unavailable"); }
} as unknown as Client;

const api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
try {
  const base = `http://127.0.0.1:${api.port}/api/memories/sleep`;
  const headers = { authorization: "Bearer test-only-memory-token" };
  const cases = [
    { route: "preview", action: "sleep-preview", body: { success: false, error: "Failed to preview: sleep storage unavailable" } },
    { route: "run", action: "sleep-run-now", body: { error: "Failed to run sleep cycle: sleep storage unavailable" } },
    { route: "cancel", action: "", body: { error: "Failed to cancel sleep cycle: sleep owner unavailable" } }
  ];
  for (const sample of cases) {
    failedAction = sample.action;
    const response = await fetch(`${base}/${sample.route}`, { method: "POST", headers });
    assert.equal(response.status, 500, sample.route);
    assert.deepEqual(await response.json(), sample.body, sample.route);
  }
} finally {
  await api.close();
}

console.log("memory HTTP Sleep errors tests passed");
