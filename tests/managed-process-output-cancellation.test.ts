/** Cancellation races use only retained temporary log files and mocked handle methods. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { bindManagedProcessLog, readManagedProcessLog, type ManagedProcessLogBinding } from "../src/runtime/managedProcessLog.js";
import { createBashOutputTool } from "../src/tools/process/managedProcesses.js";

function publicRead(binding: ManagedProcessLogBinding, signal?: AbortSignal) {
  const processId = "00000000-0000-4000-8000-000000000082";
  const service = new ManagedProcessService({ workspaceRoot: path.dirname(binding.path) });
  service.outputPath = (id) => { assert.equal(id, processId); return binding.path; };
  service.status = async (id) => {
    assert.equal(id, processId);
    return { processId, pid: 1, command: "retained-log-fixture-never-launched", cwd: path.dirname(binding.path),
      state: "exited", logPath: binding.path, startedAt: "2026-10-05T00:00:00Z", exitCode: 0,
      cleanup: { status: "not_needed" } };
  };
  service.readOutput = async (id, options, readSignal) => {
    assert.equal(id, processId);
    assert.equal(readSignal, signal);
    return { processId, ...await readManagedProcessLog(binding, options, readSignal) };
  };
  const execution = createBashOutputTool(service).resolveExecution({ processId });
  assert.ok(!("isError" in execution));
  return execution.execute({ toolCallId: "retained-output-cancellation", signal });
}

for (const stage of ["after-read", "final-validation", "close"] as const) {
  await test(`managed output canceled during ${stage} never returns a successful page`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-output-abort-")));
    const logPath = path.join(root, "fixture.log");
    const writer = await fs.open(logPath, "wx+");
    await writer.writeFile("retained output");
    const binding = await bindManagedProcessLog(logPath, writer);
    await writer.close();
    const controller = new AbortController();
    const reason = new Error(`synthetic cancel during ${stage}`);
    const realOpen = fs.open;
    let closed = 0;
    let reads = 0;
    try {
      mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]) !== logPath) return handle;
        const read = handle.read.bind(handle);
        mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads++;
          const result = await read(buffer, offset, length, position);
          if (stage === "after-read") controller.abort(reason);
          return result;
        });
        const stat = handle.stat.bind(handle);
        let stats = 0;
        mock.method(handle, "stat", async (...statArgs: Parameters<typeof handle.stat>) => {
          const result = await stat(...statArgs);
          if (++stats === 2 && stage === "final-validation") controller.abort(reason);
          return result;
        });
        const close = handle.close.bind(handle);
        mock.method(handle, "close", async () => {
          await close();
          closed++;
          if (stage === "close") controller.abort(reason);
        });
        return handle;
      });
      await assert.rejects(publicRead(binding, controller.signal), (error) => error === reason,
        "the exact cancellation reason must survive handle release");
      assert.equal(reads, 1);
      assert.equal(closed, 1);
    } finally {
      mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

await test("already canceled output read never opens the retained log", async () => {
  const controller = new AbortController();
  const reason = new Error("already canceled");
  controller.abort(reason);
  const opening = mock.method(fs, "open", async () => { throw new Error("unreachable open"); });
  try {
    await assert.rejects(readManagedProcessLog({ path: "/unreachable", device: 0n, inode: 0n }, {}, controller.signal),
      (error) => error === reason);
    assert.equal(opening.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

for (const failure of ["read", "validation", "close"] as const) {
  await test(`a ${failure} error remains primary if cancellation arrives during cleanup`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-output-error-")));
    const logPath = path.join(root, "fixture.log");
    const writer = await fs.open(logPath, "wx+");
    await writer.writeFile("retained output");
    const binding = await bindManagedProcessLog(logPath, writer);
    await writer.close();
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation");
    const originalError = new Error(`synthetic ${failure} error`);
    const realOpen = fs.open;
    let closed = 0;
    try {
      mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]) !== logPath) return handle;
        if (failure === "read") mock.method(handle, "read", async () => { throw originalError; });
        const stat = handle.stat.bind(handle);
        let stats = 0;
        mock.method(handle, "stat", async (...statArgs: Parameters<typeof handle.stat>) => {
          if (++stats === 2 && failure === "validation") throw originalError;
          return await stat(...statArgs);
        });
        const close = handle.close.bind(handle);
        mock.method(handle, "close", async () => {
          await close();
          closed++;
          controller.abort(reason);
          if (failure === "close") throw originalError;
        });
        return handle;
      });
      await assert.rejects(publicRead(binding, controller.signal), (error) => error === originalError);
      assert.equal(closed, 1);
    } finally {
      mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

await test("ordinary output succeeds and cancellation after settlement cannot retract its page", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-output-settled-")));
  const logPath = path.join(root, "fixture.log");
  const writer = await fs.open(logPath, "wx+");
  await writer.writeFile("retained output");
  const binding = await bindManagedProcessLog(logPath, writer);
  await writer.close();
  try {
    assert.equal((await publicRead(binding)).output?.content, "retained output");
    const controller = new AbortController();
    const promise = publicRead(binding, controller.signal);
    const result = await promise;
    assert.equal(result.output?.content, "retained output");
    assert.equal(result.output?.nextOffset, Buffer.byteLength("retained output"));
    controller.abort(new Error("after successful settlement"));
    assert.equal(await promise, result);
    assert.equal(result.output?.content, "retained output");
    await assert.rejects(publicRead(binding, controller.signal), (error) => error === controller.signal.reason);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
