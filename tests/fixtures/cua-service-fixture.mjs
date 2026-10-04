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
    : request.method === "observe" ? { pid: request.args.target.pid, window_id: Number(request.args.target.windowId), capture_id: "fixture-capture", screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true }
    : request.method === "act" ? { effect: "confirmed" }
    : { apps: [], hostInstance: process.pid };
  process.send({ id: request.id, result: { data, images: request.method === "observe" ? [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }] : [] } }, () => { if (stopping) process.disconnect(); });
});
