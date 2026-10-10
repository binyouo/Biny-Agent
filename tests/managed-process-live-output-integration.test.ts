/** Normal CI integration: public service/tool/projection wiring with inert OS substitutes. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mock, test } from "node:test";
import { ManagedProcessService, type ManagedProcessSnapshot } from "../src/runtime/ManagedProcessService.js";
import { createBashOutputTool } from "../src/tools/process/managedProcesses.js";
import { projectSingleToolResultForModel } from "../src/agent/toolResultProjection.js";

await test("BashOutput freezes live state before stat and preserves pending metadata in projection", async () => {
  const processId = "00000000-0000-4000-8000-000000000083";
  const logPath = "/inert-managed-log";
  const snapshot: ManagedProcessSnapshot = { processId, pid: 83, command: "inert", cwd: "/", state: "running",
    logPath, startedAt: "2026-10-10T00:00:00Z", cleanup: { status: "not_needed" } };
  const service = new ManagedProcessService({ workspaceRoot: "/" });
  // Retained record injection avoids launching a child or writing lifecycle/config files.
  (service as unknown as { records: Map<string, unknown> }).records.set(processId, {
    snapshot, logBinding: { path: logPath, device: 1n, inode: 2n }, child: { exitCode: 0 }, stopRequested: false
  });
  let bytes = Buffer.from([0x41, 0xe4, 0xbd]);
  let firstRead = true;
  const order: string[] = [];
  const metadata = () => ({ dev: 1n, ino: 2n, nlink: 1n, size: BigInt(bytes.length), isFile: () => true, isSymbolicLink: () => false });
  mock.method(process, "kill", (_pid: number, signal: number) => { assert.equal(signal, 0); order.push("refresh"); return true; });
  mock.method(fs, "lstat", async () => { order.push("log"); return metadata(); });
  mock.method(fs, "realpath", async () => logPath);
  mock.method(fs, "open", async () => ({
    stat: async () => metadata(),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = bytes.copy(buffer, offset, position, position + length);
      if (firstRead) {
        firstRead = false;
        bytes = Buffer.concat([bytes, Buffer.from([0xa0])]);
        snapshot.state = "exited";
      }
      return { bytesRead, buffer };
    },
    close: async () => undefined
  }));
  try {
    const execution = await createBashOutputTool(service).resolveExecution({ processId, maxBytes: 2 });
    assert.ok(!("isError" in execution));
    const result = await execution.execute({ toolCallId: "inert-live-log", operationId: "inert-operation" });
    assert.ok(result.output);
    assert.equal(result.output.content, "A");
    assert.equal(result.output.totalBytes, 3);
    assert.equal(result.output.nextOffset, 1);
    assert.equal(result.output.pendingUtf8Bytes, 2);
    assert.equal(result.output.hasMore, false);
    assert.equal(order[0], "refresh");
    assert.equal(order.slice(order.indexOf("log")).includes("refresh"), false);
    const projected = await projectSingleToolResultForModel("BashOutput", { processId }, result, { thresholdBytes: 1 }) as typeof result;
    assert.equal(projected.output?.pendingUtf8Bytes, 2);
    assert.equal(projected.output?.nextOffset, 1);
    assert.equal(projected.output?.hasMore, false);
    const next = await service.readOutput(processId, { offset: 1 });
    assert.equal(next.content, "你");
    assert.equal(next.nextOffset, 4);
    assert.equal(next.pendingUtf8Bytes, undefined);
  } finally { mock.restoreAll(); }
});
