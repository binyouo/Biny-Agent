/** Static ESM entry: native SDK loads after explicit enable, in an isolated worker. */
import { parentPort, workerData } from "node:worker_threads";
import * as CuaSdk from "@trycua/cua-driver";
import { z } from "zod";
import { CuaNativeRuntime } from "./cuaNativeRuntime.js";
import { computerActionSchema, windowTargetSchema, cuaVersion } from "./protocol.js";
import type { DriverReply } from "./controller.js";
const port = parentPort;
if (!port) throw new Error("Cua SDK worker requires a parent");
if (workerData === "probe-only") {
  port.postMessage({ sdkVersion: cuaVersion, staticSdkLoaded: typeof CuaSdk.CuaDriver.create === "function", driverStarted: false, permissionsRequested: false });
  port.close();
} else if (workerData === "runtime-probe") {
  // QA-only no-content probe: actually construct Rust runtime and read metadata;
  // no permission requests, list/observe/input calls, Activity or model traffic.
  const runtime = CuaSdk.CuaDriver.create(undefined);
  try { port.postMessage({ driverVersion: (await runtime.metadata()).driverVersion, runtimeCreated: true, permissionsRequested: false, captures: 0, inputs: 0 }); }
  finally { await runtime.shutdown(); if ("uniffiDestroy" in runtime && typeof runtime.uniffiDestroy === "function") runtime.uniffiDestroy(); port.close(); }
} else {
  const driver = new CuaNativeRuntime();
  const jobs = new Map<string, AbortController>();
  const requestSchema = z.object({ id: z.string(), method: z.enum(["start", "stop", "diagnostics", "list", "observe", "act"]), args: z.record(z.unknown()) }).strict();
  const sessionSchema = z.string().min(1).max(240);
  port.on("message", (raw: unknown) => {
    const cancellation = z.object({ cancel: z.string() }).strict().safeParse(raw);
    if (cancellation.success) { jobs.get(cancellation.data.cancel)?.abort(); return; }
    const request = requestSchema.parse(raw); const abort = new AbortController(); jobs.set(request.id, abort);
    const dispatch = async (): Promise<DriverReply> => {
      const args = request.args;
      if (request.method === "diagnostics") return await driver.diagnostics();
      if (request.method === "start") { await driver.start(); return { data: { driverVersion: cuaVersion }, images: [] }; }
      if (request.method === "stop") { for (const [id, job] of jobs) if (id !== request.id) job.abort(); await driver.stop(); return { data: {}, images: [] }; }
      const session = sessionSchema.parse(args.session);
      if (request.method === "list") return await driver.list(session, windowTargetSchema.shape.pid.optional().parse(args.pid), abort.signal);
      if (request.method === "observe") return await driver.observe(session, windowTargetSchema.parse(args.target), abort.signal);
      return await driver.act(session, computerActionSchema.parse(args.action), abort.signal);
    };
    void dispatch().then(result => port.postMessage({ id: request.id, result }), (error: unknown) => port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })).finally(() => jobs.delete(request.id));
  });
}
