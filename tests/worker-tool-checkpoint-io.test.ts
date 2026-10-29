import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkerSession } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("settled worker tools checkpoint without rereading history and recover their durable results", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-worker-tool-io-"));
  const execution = { taskId: "checkpoint-io", persistenceRoot: root };
  let worker: WorkerSession | undefined;
  try {
    worker = await WorkerSession.open(execution, "read two files", root, {}, "worker");
    const log = worker.recorder.filePath;
    const originalOpen = fs.open;
    let historyReads = 0;
    const open = context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === log && typeof args[1] === "number" && (args[1] & 3) === constants.O_RDONLY) historyReads++;
      return await originalOpen(...args);
    });
    const success = await worker.executeTool("Read", "read-1", { path: "a.txt" }, "safe", async beforeDispatch => {
      await beforeDispatch();
      return { content: [{ type: "text", text: "first result" }] };
    });
    const failure = await worker.executeTool("Read", "read-2", { path: "b.txt" }, "safe", async beforeDispatch => {
      await beforeDispatch();
      throw new Error("file missing");
    });
    assert.equal(success.isError, undefined);
    assert.equal(failure.isError, true);
    assert.equal(historyReads, 0, "settling a tool must not reread the growing session log");
    open.mock.restore();
    await worker.close();
    worker = undefined;

    worker = await WorkerSession.open({ ...execution, resume: true }, "read two files", root, {}, "worker");
    assert.deepEqual(worker.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId), ["read-1", "read-2"]);
    const events = await readSessionEvents(log);
    assert.deepEqual(events.filter(event => event.type === "tool_result").map(event => [event.toolCallId, event.executionStatus]), [["read-1", "succeeded"], ["read-2", "failed"]]);
  } finally {
    context.mock.restoreAll();
    await worker?.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
