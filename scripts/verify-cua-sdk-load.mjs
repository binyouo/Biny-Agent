/** Verify static SDK loading or metadata-only runtime creation; never capture/input/request grants. */
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import path from "node:path";
const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])) : new URL("../out/main/cuaWorker.js", import.meta.url);
const mode = process.argv.includes("--runtime") ? "runtime-probe" : "probe-only";
const worker = new Worker(entry, { workerData: mode });
try {
  const result = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  assert.deepEqual(result, mode === "runtime-probe" ? { driverVersion: "0.30.4", runtimeCreated: true, permissionsRequested: false, captures: 0, inputs: 0 } : { sdkVersion: "0.30.4", staticSdkLoaded: true, driverStarted: false, permissionsRequested: false });
  console.log(JSON.stringify({ entry: entry.pathname, ...result }));
} finally { await worker.terminate(); }
