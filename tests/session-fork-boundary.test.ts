import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { forkSession } from "../src/session/fork.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";

const messageBoundaries: Array<{ name: string; event: SessionEvent }> = [
  {
    name: "queued user receipt",
    event: { type: "user_message", content: "check the result next", messageId: "queued-user", auditOnly: true, metadata: { queuedDelivery: "queue" } }
  },
  {
    name: "steering user receipt",
    event: { type: "user_message", content: "use the revised input", messageId: "steering-user", auditOnly: true, metadata: { queuedDelivery: "steer" } }
  },
  {
    name: "hosted assistant audit message",
    event: { type: "assistant_message", content: "still working", auditOnly: true }
  },
  {
    name: "later user input",
    event: { type: "user_message", content: "start another request" }
  },
  {
    name: "later assistant message",
    event: { type: "assistant_message", content: "continuing the request" }
  }
];

for (const boundary of messageBoundaries) {
  test(`fork cannot use ${boundary.name} to close an unfinished tool call`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-fork-boundary-"));
    let recorder: SessionRecorder | undefined;
    try {
      await ensureAgentDirs(root);
      recorder = new SessionRecorder(root);
      const events: SessionEvent[] = [
        { type: "user_message", content: "write the requested file" },
        { type: "tool_call", tool: "Write", args: { path: "result.txt", content: "done" }, toolCallId: "write-1", sequence: 1 },
        { type: "tool_execution", tool: "Write", toolCallId: "write-1", sequence: 1, operationId: "write-operation", state: "running" },
        boundary.event,
        { type: "tool_result", tool: "Write", toolCallId: "write-1", sequence: 1, operationId: "write-operation", executionStatus: "succeeded", result: { written: true } },
        { type: "assistant_message", content: "the file is ready" }
      ];
      for (const event of events) await recorder.recordAndFlush(event);
      await recorder.close();
      const original = await readFile(recorder.filePath, "utf8");
      assert.equal((await replaySession(recorder.filePath)).recoveredToolResults.length, 0);

      // The source call completed, but this requested prefix stops before its result.
      const forked = await forkSession(root, recorder.sessionId, { upToEvent: 4 });
      const replayed = await replaySession(forked.filePath);
      assert.equal(replayed.recoveredToolResults.length, 0, "a fork must not invent an unknown tool outcome");
      assert.equal(forked.events, 1, "the cut must move before the unfinished call");
      assert.deepEqual(replayed.messages.map((message) => message.role), ["user"]);

      const completed = await forkSession(root, recorder.sessionId, { upToEvent: 5 });
      assert.equal(completed.events, 5, "the persisted tool result must remain a safe boundary");
      assert.equal((await replaySession(completed.filePath)).recoveredToolResults.length, 0);
      assert.equal(await readFile(recorder.filePath, "utf8"), original, "forking must leave the original session intact");
    } finally {
      await recorder?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
