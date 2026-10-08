import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionEvents, readSessionSummary, readStoredSessionEvents } from "../src/session/events.js";
import { clearSessionParseCache } from "../src/session/parseCache.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { measureSessionRead } from "./helpers/sessionReadMetrics.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-summary-reuse-"));
const row = (event: SessionEvent): string => `${JSON.stringify(event)}\n`;
let failures = 0;
async function test(name: string, run: (sessionId: string, file: string) => Promise<void>): Promise<void> {
  clearSessionParseCache();
  const recorder = new SessionRecorder(root);
  recorder.record({ type: "user_message", content: "question", time: "2025-01-01T00:00:00.000Z" });
  await recorder.close();
  try { await run(recorder.sessionId, recorder.filePath); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
try {
  await ensureAgentDirs(root);
  for (const mode of ["standalone", "stored"] as const) {
    await test(`${mode} validated parse avoids duplicate summary bytes`, async (id, file) => {
      await fs.appendFile(file, row({ type: "assistant_message", content: "answer" }) + row({ type: "turn_status", status: "completed", stopReason: "done", steps: 1, affectedTodoIds: ["a"] }));
      const events = mode === "standalone" ? await readSessionEvents(file) : (await readStoredSessionEvents(root, id)).events;
      const before = structuredClone(events);
      const expected = {
        fileName: `${id}.jsonl`,
        firstUserMessage: "question",
        lastAssistantMessage: "answer",
        lastTurnStatus: { type: "turn_status", status: "completed", stopReason: "done", steps: 1, affectedTodoIds: ["a"] },
        eventCount: 3,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z"
      };
      const measured = await measureSessionRead(() => readSessionSummary(root, id));
      assert.deepEqual(measured.value, expected);
      assert.equal(measured.metrics.bytesRead, 0, "exact validated parse must avoid rereading JSONL");
      assert.equal(measured.metrics.parsedRows, 0);
      measured.value!.lastTurnStatus!.affectedTodoIds!.push("mutation");
      assert.deepEqual(events, before, "summary callers cannot mutate the shared parse snapshot");
      assert.deepEqual(await readSessionSummary(root, id), expected, "summary cache must remain isolated");
    });
  }
  await test("streaming and cached summaries agree on queued receipts empty replies and timestamps", async (id, file) => {
    const fixture: SessionEvent[] = [
      { type: "user_message", auditOnly: true, metadata: { queuedDelivery: "queue" }, content: "queued receipt", time: "2025-02-01T00:00:00.000Z" },
      { type: "user_message", auditOnly: true, metadata: { queuedDelivery: "steer" }, content: "steering receipt", time: "2025-02-01T00:01:00.000Z" },
      { type: "user_message", content: "actual question", time: "2025-02-01T00:02:00.000Z" },
      { type: "assistant_message", content: "actual answer", time: "2025-02-01T00:03:00.000Z" },
      { type: "assistant_message", content: "", time: "2025-02-01T00:04:00.000Z" },
      { type: "turn_status", status: "completed", stopReason: "done", steps: 2, time: "2025-02-01T00:05:00.000Z" }
    ];
    const expected = {
      firstUserMessage: "actual question",
      lastAssistantMessage: "actual answer",
      lastTurnStatus: { type: "turn_status", status: "completed", stopReason: "done", steps: 2, time: "2025-02-01T00:05:00.000Z" },
      eventCount: 6,
      createdAt: "2025-02-01T00:00:00.000Z",
      updatedAt: "2025-02-01T00:05:00.000Z"
    };
    await fs.writeFile(file, fixture.map(row).join(""));
    const cold = await measureSessionRead(() => readSessionSummary(root, id));
    assert.deepEqual(cold.value, { fileName: `${id}.jsonl`, ...expected });
    assert.ok(cold.metrics.bytesRead > 0);
    const warmRecorder = new SessionRecorder(root);
    await warmRecorder.close();
    await fs.writeFile(warmRecorder.filePath, fixture.map(row).join(""));
    await readSessionEvents(warmRecorder.filePath);
    const warm = await measureSessionRead(() => readSessionSummary(root, warmRecorder.sessionId));
    assert.deepEqual(warm.value, { fileName: `${warmRecorder.sessionId}.jsonl`, ...expected });
    assert.equal(warm.metrics.bytesRead, 0);
    assert.equal(warm.metrics.parsedRows, 0);
  });
  await test("append and equal-size replacement invalidate both caches", async (id, file) => {
    await readSessionEvents(file); await readSessionSummary(root, id);
    await fs.appendFile(file, row({ type: "assistant_message", content: "old" }));
    const appended = await measureSessionRead(() => readSessionSummary(root, id));
    assert.equal(appended.value?.lastAssistantMessage, "old");
    assert.ok(appended.metrics.bytesRead > 0);
    const refreshed = await measureSessionRead(() => readSessionEvents(file));
    assert.equal(refreshed.metrics.parsedRows, 1, "summary miss must preserve validated append-prefix candidate");
    const old = await fs.readFile(file, "utf8");
    await fs.writeFile(`${file}.new`, old.replace('"old"', '"new"'));
    await fs.rename(`${file}.new`, file);
    const replaced = await measureSessionRead(() => readSessionSummary(root, id));
    assert.equal(replaced.value?.lastAssistantMessage, "new");
    assert.ok(replaced.metrics.bytesRead > 0);
  });
  await test("in-place same-size rewrite and restored mtime invalidates parse", async (id, file) => {
    await readSessionEvents(file);
    const stat = await fs.stat(file);
    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, original.replace("question", "replaced"));
    await fs.utimes(file, stat.atime, stat.mtime);
    assert.equal((await readSessionSummary(root, id))?.firstUserMessage, "replaced");
  });
  await test("append during cache-hit validation retries instead of returning stale summary", async (id, file) => {
    await readSessionEvents(file);
    const originalOpen = fs.open;
    let checks = 0;
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === file) {
        handle.stat = new Proxy(handle.stat, {
          async apply(target, receiver, parameters: unknown[]) {
            checks++;
            // openSessionHandle validates once, then the reader checks before/after lookup.
            if (checks === 3) await fs.appendFile(file, row({ type: "assistant_message", content: "arrived during read" }));
            return await Reflect.apply(target, receiver, parameters);
          }
        });
      }
      return handle;
    };
    try {
      const summary = await readSessionSummary(root, id);
      assert.ok(checks >= 5, "cache hit must retain after-read validation and retry");
      assert.equal(summary?.eventCount, 2);
      assert.equal(summary?.lastAssistantMessage, "arrived during read");
    } finally { fs.open = originalOpen; }
  });
  await test("warm parse still rejects hardlinks and symlinks", async (id, file) => {
    await readSessionEvents(file);
    await fs.link(file, `${file}.link`);
    await assert.rejects(readSessionSummary(root, id));
    await fs.unlink(`${file}.link`);
    await fs.rename(file, `${file}.real`);
    await fs.symlink(`${file}.real`, file);
    await assert.rejects(readSessionSummary(root, id));
  });
  await test("empty parse yields no summary without reading again", async (id, file) => {
    await fs.writeFile(file, ""); await readSessionEvents(file);
    const result = await measureSessionRead(() => readSessionSummary(root, id));
    assert.equal(result.value, undefined);
    assert.equal(result.metrics.bytesRead, 0);
  });
} finally { clearSessionParseCache(); await fs.rm(root, { recursive: true, force: true }); }
assert.equal(failures, 0, `${failures} summary reuse tests failed`);
