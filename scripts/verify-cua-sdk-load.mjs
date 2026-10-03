/** Verify static SDK loading or metadata-only runtime creation; never capture/input/request grants. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const input = process.argv.slice(2).find(value => !value.startsWith("--"));
const entry = input ? pathToFileURL(path.resolve(input)) : new URL("../out/main/cuaProcess.js", import.meta.url);
const mode = process.argv.includes("--runtime") ? "runtime-probe" : "probe-only";
const child = fork(fileURLToPath(entry), [`--${mode}`], { execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
const exited = new Promise(resolve => child.once("exit", resolve));
const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
try {
  const result = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`SDK probe exited before reply: ${code}`))); });
  assert.deepEqual(result, mode === "runtime-probe" ? { driverVersion: "0.30.4", runtimeCreated: true, permissionsRequested: false, captures: 0, inputs: 0 } : { sdkVersion: "0.30.4", staticSdkLoaded: true, driverStarted: false, permissionsRequested: false });
  console.log(JSON.stringify({ entry: entry.pathname, ...result }));
} finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; clearTimeout(timer); }
