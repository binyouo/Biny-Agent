import type { RuntimeHostClient } from "../../src/runtime/host/client.js";

export function isRuntimeHostTakeoverReady(
  client: Pick<RuntimeHostClient, "hostInfo" | "getFocusedSessionId" | "runtimeSnapshots">,
  previousEpoch: string
): boolean {
  const epoch = client.hostInfo?.hostEpoch;
  if (!epoch || epoch === previousEpoch) return false;
  const focusedSessionId = client.getFocusedSessionId();
  return client.runtimeSnapshots().some((session) => session.sessionId === focusedSessionId);
}
