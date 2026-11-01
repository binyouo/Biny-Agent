import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredToolOptimizationOverview, ToolOptimizationScope } from "./toolOptimizationStore.js";

export async function refreshToolOptimizationSnapshot(file: string, scope: ToolOptimizationScope): Promise<StoredToolOptimizationOverview> {
  const source = import.meta.url.endsWith(".ts");
  const bundledChunk = path.basename(path.dirname(fileURLToPath(import.meta.url))) === "chunks";
  const entry = new URL(source ? "./toolOptimizationWorker.ts" : bundledChunk ? "../toolOptimizationWorker.js" : "./toolOptimizationWorker.js", import.meta.url);
  const url = source ? new URL(`data:text/javascript,${encodeURIComponent(
    `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(entry.href)});`
  )}`) : entry;
  const worker = new Worker(url, { workerData: { file, scope }, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
  return await new Promise((resolve, reject) => {
    let overview: StoredToolOptimizationOverview | undefined;
    let error: Error | undefined;
    const deadline = setTimeout(() => {
      error = new Error("Token savings indexing timed out.");
      void worker.terminate();
    }, 120_000);
    worker.on("message", (reply: { overview?: StoredToolOptimizationOverview; error?: string }) => {
      overview = reply.overview;
      if (reply.error) error = new Error(reply.error);
    });
    worker.once("error", failure => { error = failure; });
    // 收到结果后仍等线程和数据库真正关闭，避免退出或测试清理后继续写入。
    worker.once("exit", code => {
      clearTimeout(deadline);
      if (error) reject(error);
      else if (code !== 0 || !overview) reject(new Error(`Token savings worker exited (${String(code)}).`));
      else resolve(overview);
    });
  });
}
