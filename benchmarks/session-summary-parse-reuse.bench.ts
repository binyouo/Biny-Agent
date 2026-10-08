import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessionSummaries, readSessionEvents, readSessionSummary } from "../src/session/events.js";
import { clearSessionParseCache } from "../src/session/parseCache.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { measureSessionRead } from "../tests/helpers/sessionReadMetrics.js";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-summary-bench-"));
try {
  await ensureAgentDirs(root);
  for (const operation of ["summary", "list"] as const) {
    for (const count of [20, 20_000]) {
      const runs = [];
      for (let repeat = 0; repeat < 7; repeat++) {
        clearSessionParseCache();
        const workspace = await fs.mkdtemp(path.join(root, "project-"));
        await ensureAgentDirs(workspace);
        const recorder = new SessionRecorder(workspace); await recorder.close();
        const events = Array.from({ length: count }, (_, i) => ({ type: i % 2 ? "assistant_message" : "user_message", content: `message ${i} ` + "history benchmark ".repeat(16) }));
        await fs.writeFile(recorder.filePath, events.map(event => JSON.stringify(event) + "\n").join(""));
        await readSessionEvents(recorder.filePath);
        const result = await measureSessionRead(async () => operation === "summary"
          ? await readSessionSummary(workspace, recorder.sessionId)
          : (await listSessionSummaries(workspace))[0]);
        assert.equal(result.value?.eventCount, count);
        runs.push(result.metrics);
      }
      console.log(JSON.stringify({ operation, events: count, runs }));
    }
  }
} finally { clearSessionParseCache(); await fs.rm(root, { recursive: true, force: true }); }
