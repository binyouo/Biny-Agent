/** Static ESM child entry: the native SDK never loads in the application process. */
import * as CuaSdk from "@trycua/cua-driver";
import { z } from "zod";
import { CuaNativeRuntime } from "./cuaNativeRuntime.js";
import { computerActionSchema, windowTargetSchema, cuaVersion } from "./protocol.js";
import type { DriverReply } from "./controller.js";

if (!process.send) throw new Error("Cua SDK process requires parent IPC");
const maxIpcBytes = 2 * 1024 * 1024;
const send = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
  if (!process.connected) { reject(new Error("Cua parent disconnected")); return; }
  process.send!(value as Record<string, unknown>, error => error ? reject(error) : resolve());
});
const close = async (value: unknown): Promise<void> => {
  await send(value); process.disconnect(); process.exit(0);
};
if (process.argv.includes("--probe-only")) {
  await close({ sdkVersion: cuaVersion, staticSdkLoaded: typeof CuaSdk.CuaDriver.create === "function", driverStarted: false, permissionsRequested: false });
} else if (process.argv.includes("--runtime-probe")) {
  const runtime = CuaSdk.CuaDriver.create(undefined);
  let value: Record<string, unknown>;
  try { value = { driverVersion: (await runtime.metadata()).driverVersion, runtimeCreated: true, permissionsRequested: false, captures: 0, inputs: 0 }; }
  finally { await runtime.shutdown(); if ("uniffiDestroy" in runtime && typeof runtime.uniffiDestroy === "function") runtime.uniffiDestroy(); }
  await close(value);
} else {
  const driver = new CuaNativeRuntime();
  const jobs = new Map<string, AbortController>();
  let closing = false;
  const requestSchema = z.object({ id: z.string().max(240), method: z.enum(["start", "stop", "diagnostics", "list", "observe", "act"]), args: z.record(z.unknown()) }).strict();
  const cancellationSchema = z.object({ cancel: z.string().max(240) }).strict();
  const sessionSchema = z.string().min(1).max(240);
  process.once("disconnect", () => {
    closing = true; for (const job of jobs.values()) job.abort();
    const timer = setTimeout(() => process.exit(1), 2_000);
    void driver.stop().finally(() => { clearTimeout(timer); process.exit(0); });
  });
  process.on("message", (raw: unknown) => {
    if (closing) return;
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > maxIpcBytes) { process.exit(1); return; }
    const cancellation = cancellationSchema.safeParse(raw);
    if (cancellation.success) { jobs.get(cancellation.data.cancel)?.abort(); return; }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || jobs.size >= 32 || jobs.has(parsed.data.id)) { process.exit(1); return; }
    const request = parsed.data; const abort = new AbortController(); jobs.set(request.id, abort);
    const dispatch = async (): Promise<DriverReply> => {
      const args = request.args;
      if (request.method === "diagnostics") return await driver.diagnostics();
      if (request.method === "start") { await driver.start(); return { data: { driverVersion: cuaVersion }, images: [] }; }
      if (request.method === "stop") { closing = true; for (const [id, job] of jobs) if (id !== request.id) job.abort(); await driver.stop(); return { data: {}, images: [] }; }
      const session = sessionSchema.parse(args.session);
      if (request.method === "list") return await driver.list(session, windowTargetSchema.shape.pid.optional().parse(args.pid), abort.signal);
      if (request.method === "observe") return await driver.observe(session, windowTargetSchema.parse(args.target), abort.signal);
      return await driver.act(session, computerActionSchema.parse(args.action), abort.signal);
    };
    const reply = async (value: unknown) => {
      if (!process.connected) return;
      const bounded = Buffer.byteLength(JSON.stringify(value), "utf8") <= maxIpcBytes ? value : { id: request.id, error: "SDK process response exceeded IPC budget; outcome may be unknown" };
      await send(bounded);
      if (request.method === "stop") { process.disconnect(); process.exit(0); }
    };
    void dispatch().then(result => reply({ id: request.id, result }), (error: unknown) => reply({ id: request.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 16_384) })).catch(() => process.exit(1)).finally(() => jobs.delete(request.id));
  });
}
