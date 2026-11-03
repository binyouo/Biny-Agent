import { parentPort, workerData } from "node:worker_threads";
import { ToolOptimizationStore, type ToolOptimizationScope } from "./toolOptimizationStore.js";

const { file, scope } = workerData as { file: string; scope: ToolOptimizationScope };
const store = new ToolOptimizationStore(file);
try {
  parentPort!.postMessage({ overview: await store.refresh(scope) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  store.close();
  parentPort!.close();
}
