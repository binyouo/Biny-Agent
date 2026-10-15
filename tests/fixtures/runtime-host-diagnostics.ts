import { Worker } from "node:worker_threads";
import { runRuntimeHostProcess } from "../../src/runtime/hostProcess.js";

process.on("message", (message) => {
  if (message === "diagnostic-error") {
    process.stderr.emit("error", Object.assign(new Error("Diagnostic IO failure"), { code: "EIO" }));
    return;
  }
  if (message !== "diagnostic") return;
  const worker = new Worker('console.error("Host worker diagnostic after launcher disconnect");', { eval: true });
  worker.once("exit", () => { setImmediate(() => process.send?.("diagnostic-complete")); });
});
await runRuntimeHostProcess();
