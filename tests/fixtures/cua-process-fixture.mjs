/** Synthetic child-process protocol fixture; no SDK, native runtime or desktop access. */
if (!process.send) throw new Error("fixture requires process IPC");
const jobs = new Map();
let ignoreStop = false;
const reply = (request, data = {}) => process.send({ id: request.id, result: { data: { method: request.method, hostInstance: process.pid, parentPid: process.ppid, runAsNode: process.env.ELECTRON_RUN_AS_NODE, ...data }, images: [] } });
process.on("SIGTERM", () => { if (!ignoreStop) process.exit(0); });
process.on("message", request => {
  if (request.cancel) {
    const job = jobs.get(request.cancel);
    if (job && job.args.action?.key !== "IgnoreCancel" && job.args.action?.key !== "HangStop") {
      process.send({ id: job.id, error: "fixture SDK signal aborted" }); jobs.delete(job.id);
    }
    return;
  }
  if (request.method === "act") {
    if (request.args.action.key === "HangStop") ignoreStop = true;
    jobs.set(request.id, request);
    process.send({ id: "fixture-notification", result: { data: { admitted: true }, images: [] } });
    return;
  }
  if (request.method === "list" && request.args.pid === 101) { process.exit(17); return; }
  if (request.method === "list" && request.args.pid === 102) { process.send({ invalid: true }); return; }
  if (request.method === "list" && request.args.pid === 103) { reply(request, { oversized: "x".repeat(2 * 1024 * 1024) }); return; }
  if (request.method === "list" && request.args.pid === 104) { jobs.set(request.id, request); return; }
  if (request.method === "list" && request.args.pid === 106) { for (const job of jobs.values()) reply(job, { released: true }); jobs.clear(); }
  if (request.method === "stop") {
    if (ignoreStop) return;
    for (const job of jobs.values()) process.send({ id: job.id, error: "fixture stopped" }); jobs.clear();
    process.send({ id: request.id, result: { data: {}, images: [] } }, () => { process.disconnect(); process.exit(0); });
    return;
  }
  reply(request);
});
