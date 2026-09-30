/** Synthetic worker protocol fixture; no SDK, native runtime or desktop access. */
import { parentPort, threadId } from "node:worker_threads";
const jobs = new Map();
parentPort.on("message", request => {
  if (request.cancel) { const job = jobs.get(request.cancel); if (job) { parentPort.postMessage({ id: job.id, error: "fixture SDK signal aborted" }); jobs.delete(job.id); } return; }
  if (request.method === "act") { jobs.set(request.id, request); parentPort.postMessage({ id: "fixture-notification", result: { data: { admitted: true }, images: [] } }); return; }
  if (request.method === "stop") { for (const job of jobs.values()) parentPort.postMessage({ id: job.id, error: "fixture stopped" }); jobs.clear(); }
  parentPort.postMessage({ id: request.id, result: { data: { method: request.method, hostInstance: threadId }, images: [] } });
});
