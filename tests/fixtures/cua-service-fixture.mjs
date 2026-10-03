import { appendFileSync } from "node:fs";

let started = false;
process.on("message", request => {
  if (request.cancel) return;
  appendFileSync(process.env.BINY_CUA_FIXTURE_LOG, `${JSON.stringify({ method: request.method, pid: process.pid })}\n`);
  if (request.method === "start") started = true;
  const stopping = request.method === "stop" || request.method === "shutdown";
  if (stopping) started = false;
  const data = request.method === "diagnostics"
    ? { sdkLoaded: true, runtimeReady: started, driverVersion: "0.30.4", permissions: { accessibility: "granted", screenRecording: "granted" } }
    : { apps: [], hostInstance: process.pid };
  process.send({ id: request.id, result: { data, images: [] } }, () => { if (stopping) process.disconnect(); });
});
