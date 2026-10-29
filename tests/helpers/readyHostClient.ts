import type { RuntimeHostClient } from "../../src/runtime/host/client.js";

/** 执行测试明确等待执行域；连接生命周期测试直接使用 connect。 */
export async function readyHostClient<T extends RuntimeHostClient | { client: RuntimeHostClient } | undefined>(connected: T): Promise<T> {
  const client = connected && "client" in connected ? connected.client : connected;
  try {
    await client?.waitForReady();
  } catch (error) {
    try { await client?.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], "Host readiness and client cleanup failed."); }
    throw error;
  }
  return connected;
}
