import { parentPort, workerData } from "node:worker_threads";
import { SessionSearchStore } from "./searchIndexStore.js";

const port = parentPort!;
const store = new SessionSearchStore((workerData as { agentRoot: string }).agentRoot);
let active: { id: number; controller: AbortController } | undefined;

port.on("message", (message: { type: "index" | "cancel" | "close"; id: number; sessionId: string; filePath: string }) => {
  if (message.type === "cancel") {
    if (active?.id === message.id) active.controller.abort(new Error("Session history indexing cancelled."));
    return;
  }
  if (message.type === "close") {
    store.close();
    port.close();
    return;
  }
  const controller = new AbortController();
  active = { id: message.id, controller };
  void store.indexSessionFile(message.sessionId, message.filePath, controller.signal).then(count => {
    port.postMessage({ id: message.id, count });
  }, (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    port.postMessage({ id: message.id, error: {
      name: failure.name, message: failure.message,
      code: "code" in failure && typeof failure.code === "string" ? failure.code : undefined
    } });
  }).finally(() => { active = undefined; });
});
