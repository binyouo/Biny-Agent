import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { agentDir } from "../src/session/store.js";
import {
  createBashOutputTool,
  createKillShellTool
} from "../src/tools/process/managedProcesses.js";
import { createRunCommandTool, runShellCommand } from "../src/tools/shell/runCommand.js";
import type { RunnableToolExecution, ToolExecution } from "../src/tools/types.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-managed-process-"));
  try {
    const serverScript = path.join(workspaceRoot, "managed-http.cjs");
    await writeFile(serverScript, [
      "const http = require('node:http');",
      "const port = Number(process.argv[2]);",
      "const server = http.createServer((request, response) => {",
      "  if (request.url === '/health') { response.writeHead(200); response.end('ready'); return; }",
      "  response.writeHead(404); response.end('missing');",
      "});",
      "server.listen(port, '127.0.0.1', () => console.log(`READY ${process.pid}`));",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));"
    ].join("\n"), "utf8");

    await testManagedHttpProcessOutlivesFiniteCommandTimeout(workspaceRoot, serverScript);
    await testTcpAndLogReadiness(workspaceRoot, serverScript);
    await testRuntimeCloseCleansProcessGroup(workspaceRoot, serverScript);
    await testAbortedStartCleansProcess(workspaceRoot, serverScript);
    await testManagedCwdRejectsSymlinkEscape(workspaceRoot);
    await testCanonicalAbsoluteCwdUnderSymlinkWorkspaceRoot();
    await testProcessStorageRejectsSymlink();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testProcessStorageRejectsSymlink(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-managed-process-storage-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-managed-process-storage-outside-"));
  await mkdir(agentDir(root), { recursive: true });
  await symlink(outside, path.join(agentDir(root), "processes"), "dir");
  const service = new ManagedProcessService({ workspaceRoot: root, persistenceRoot: root });
  try {
    await assert.rejects(service.initialize(), /real directory, not a symbolic link/i);
    assert.deepEqual(await service.close(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testCanonicalAbsoluteCwdUnderSymlinkWorkspaceRoot(): Promise<void> {
  if (process.platform === "win32") return;
  const parent = await mkdtemp(path.join(os.tmpdir(), "biny-managed-process-root-link-"));
  const canonicalRoot = path.join(parent, "canonical-workspace");
  const linkedRoot = path.join(parent, "linked-workspace");
  await mkdir(canonicalRoot);
  await symlink(canonicalRoot, linkedRoot, "dir");
  const service = new ManagedProcessService({
    workspaceRoot: linkedRoot,
    persistenceRoot: linkedRoot,
    terminationGraceMs: 200,
    killSettleMs: 200
  });
  try {
    const resolvedRoot = await realpath(linkedRoot);
    const start = runnable(createRunCommandTool({ workspaceRoot: linkedRoot, ignore: [] }, undefined, {}, service).resolveExecution({
      command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      background: true
    }));
    const result = await start.execute({ toolCallId: "start-canonical-cwd" });
    assert.equal(result.background, true);
    if (!result.background) throw new Error("Expected a background Bash result.");
    const started = result.process;
    assert.equal(started.cwd, resolvedRoot);
    assert.equal(started.state, "running");
    assert.equal((await service.stop(started.processId, "canonical cwd regression test")).state, "stopped");
  } finally {
    await service.close();
    await rm(parent, { recursive: true, force: true });
  }
}

async function testManagedCwdRejectsSymlinkEscape(workspaceRoot: string): Promise<void> {
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-managed-process-outside-"));
  const linkPath = path.join(workspaceRoot, "escaped-cwd");
  const service = new ManagedProcessService({ workspaceRoot, persistenceRoot: workspaceRoot });
  try {
    await symlink(outside, linkPath, "dir");
    await assert.rejects(
      service.start({ command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, cwd: "escaped-cwd" }),
      /must not escape the workspace through a symbolic link/i
    );
    assert.deepEqual(await service.list(), []);
  } finally {
    await service.close();
    await rm(linkPath, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testManagedHttpProcessOutlivesFiniteCommandTimeout(workspaceRoot: string, serverScript: string): Promise<void> {
  const service = new ManagedProcessService({
    workspaceRoot,
    persistenceRoot: workspaceRoot,
    terminationGraceMs: 200,
    killSettleMs: 200
  });
  const port = await unusedPort();
  const url = `http://127.0.0.1:${String(port)}/health`;
  const start = runnable(createRunCommandTool({ workspaceRoot, ignore: [] }, undefined, {}, service).resolveExecution({
    command: nodeCommand(serverScript, port),
    background: true,
    url,
    readiness: { type: "http", url, expectedStatus: 200, timeoutMs: 5_000, intervalMs: 25 }
  }));

  try {
    const startResult = await start.execute({ toolCallId: "start-http" });
    assert.equal(startResult.background, true);
    if (!startResult.background) throw new Error("Expected a background Bash result.");
    const started = startResult.process;
    assert.equal(started.state, "running");
    assert.equal(started.url, url);
    assert.equal(started.readiness?.status, "ready");
    assert.equal(started.readiness?.passed, true);
    assert.equal(started.readiness?.httpStatus, 200);
    assert.equal(started.cleanup.status, "pending");
    assert.equal(isManagedProcessAlive(started.pid), true);

    const finiteCommand = await runShellCommand(workspaceRoot, `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 500)"`, {
      timeoutMs: 40,
      terminationGraceMs: 40,
      killSettleMs: 40
    });
    assert.equal(finiteCommand.exitCode, 124);
    await delay(120);

    const status = await runnable(createBashOutputTool(service).resolveExecution({ processId: started.processId, maxBytes: 8_192 }))
      .execute({ toolCallId: "status-http" });
    assert.equal(status.process?.state, "running", "managed servers must not inherit Bash's deadline");
    assert.equal((await fetch(url)).status, 200);

    const firstPage = await runnable(createBashOutputTool(service).resolveExecution({ processId: started.processId, maxBytes: 16 }))
      .execute({ toolCallId: "page-http-1" });
    assert.equal(firstPage.output?.startOffset, 0);
    assert.equal(firstPage.output?.nextOffset, 16);
    assert.equal(firstPage.output?.hasMore, true);
    const nextPage = await runnable(createBashOutputTool(service).resolveExecution({
      processId: started.processId,
      offset: firstPage.output?.nextOffset,
      maxBytes: 16
    })).execute({ toolCallId: "page-http-2" });
    assert.equal(nextPage.output?.startOffset, 16);

    const outputResult = await runnable(createBashOutputTool(service).resolveExecution({
      processId: started.processId,
      fromEnd: true,
      maxBytes: 8_192
    })).execute({ toolCallId: "read-http" });
    const output = outputResult.output;
    assert.ok(output);
    assert.match(output.content, /READY \d+/);
    assert.equal(output.nextOffset, output.totalBytes);
    assert.equal(output.hasMore, false);

    const listed = await runnable(createBashOutputTool(service).resolveExecution({ includeExited: false }))
      .execute({ toolCallId: "list-http" });
    assert.equal(listed.processes?.some((process) => process.processId === started.processId), true);

    const stopped = await runnable(createKillShellTool(service).resolveExecution({
      processId: started.processId,
      reason: "managed process regression test"
    })).execute({ toolCallId: "stop-http" });
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.cleanup.status, "stopped");
    assert.equal(await waitFor(() => !isManagedProcessAlive(started.pid), 1_000), true);

    const lifecycle = await readFile(path.join(agentDir(workspaceRoot), "processes", "lifecycle.jsonl"), "utf8");
    assert.match(lifecycle, /"event":"started"/);
    assert.match(lifecycle, /"event":"stopped"/);
  } finally {
    await service.close();
  }
}

async function testTcpAndLogReadiness(workspaceRoot: string, serverScript: string): Promise<void> {
  const service = new ManagedProcessService({
    workspaceRoot,
    persistenceRoot: workspaceRoot,
    terminationGraceMs: 200,
    killSettleMs: 200
  });
  try {
    const logPort = await unusedPort();
    const logReady = await service.start({
      command: nodeCommand(serverScript, logPort),
      readiness: { type: "log", pattern: "READY \\d+", regex: true, timeoutMs: 5_000, intervalMs: 25 }
    });
    assert.equal(logReady.readiness?.status, "ready");
    assert.match(logReady.readiness?.message ?? "", /matched/);
    assert.equal((await service.stop(logReady.processId)).cleanup.status, "stopped");

    const tcpPort = await unusedPort();
    const tcpReady = await service.start({
      command: nodeCommand(serverScript, tcpPort),
      readiness: { type: "tcp", host: "127.0.0.1", port: tcpPort, timeoutMs: 5_000, intervalMs: 25 }
    });
    assert.equal(tcpReady.readiness?.status, "ready");
    assert.match(tcpReady.readiness?.message ?? "", new RegExp(`:${String(tcpPort)}`));
    assert.equal((await service.stop(tcpReady.processId)).cleanup.status, "stopped");

    const notReadyPort = await unusedPort();
    const notReady = await service.start({
      command: nodeCommand(serverScript, notReadyPort),
      readiness: {
        type: "http",
        url: `http://127.0.0.1:${String(notReadyPort)}/health`,
        expectedStatus: 204,
        timeoutMs: 100,
        intervalMs: 20
      }
    });
    assert.equal(notReady.state, "running");
    assert.equal(notReady.readiness?.status, "timed_out", "a spawned process is not ready merely because it is still alive");
    assert.equal(notReady.readiness?.passed, false);
    assert.equal((await service.stop(notReady.processId)).cleanup.status, "stopped");
  } finally {
    await service.close();
  }
}

async function testRuntimeCloseCleansProcessGroup(workspaceRoot: string, serverScript: string): Promise<void> {
  const service = new ManagedProcessService({
    workspaceRoot,
    persistenceRoot: workspaceRoot,
    terminationGraceMs: 200,
    killSettleMs: 200
  });
  const port = await unusedPort();
  const started = await service.start({
    command: nodeCommand(serverScript, port),
    readiness: { type: "http", url: `http://127.0.0.1:${String(port)}/health`, timeoutMs: 5_000, intervalMs: 25 }
  });
  const output = await service.readOutput(started.processId, { fromEnd: true, maxBytes: 8_192 });
  const serverPid = Number(output.content.match(/READY (\d+)/)?.[1]);
  assert.equal(Number.isSafeInteger(serverPid), true);
  assert.equal(isPidAlive(serverPid), true);

  const cleanup = await service.close();
  assert.equal(cleanup.some((result) => result.status === "stopped" && result.reason === "runtime close"), true);
  assert.equal(await waitFor(() => !isManagedProcessAlive(started.pid), 1_000), true);
  assert.equal(await waitFor(() => !isPidAlive(serverPid), 1_000), true, "runtime close must clean descendants, not only the shell");
  assert.equal((await service.status(started.processId)).state, "stopped");
}

async function testAbortedStartCleansProcess(workspaceRoot: string, serverScript: string): Promise<void> {
  const service = new ManagedProcessService({
    workspaceRoot,
    persistenceRoot: workspaceRoot,
    terminationGraceMs: 200,
    killSettleMs: 200
  });
  try {
    const port = await unusedPort();
    const controller = new AbortController();
    const pending = service.start({
      command: nodeCommand(serverScript, port),
      signal: controller.signal,
      readiness: { type: "http", url: `http://127.0.0.1:${String(port)}/health`, timeoutMs: 5_000, intervalMs: 25 }
    });
    setImmediate(() => controller.abort());
    await assert.rejects(pending);
    // start 被取消后 Runtime 仍持有记录，但必须主动回收进程，不能留下孤儿服务。
    const [record] = await service.list();
    assert.ok(record);
    assert.equal(await waitFor(() => !isManagedProcessAlive(record.pid), 1_000), true);
    assert.equal((await service.status(record.processId)).state, "stopped");
  } finally {
    await service.close();
  }
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}

function nodeCommand(scriptPath: string, port: number): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} ${String(port)}`;
}

async function unusedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function isManagedProcessAlive(pid: number): boolean {
  if (process.platform === "win32") return isPidAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return predicate();
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
