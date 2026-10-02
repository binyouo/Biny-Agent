/** Defensive read boundaries use only disposable local text files, never launched processes. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mock } from "node:test";
import os from "node:os";
import path from "node:path";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { createSkillResourceTool, loadSkills } from "../src/extensions/skills.js";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { bindManagedProcessLog, readManagedProcessLog, type ManagedProcessLogBinding } from "../src/runtime/managedProcessLog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createBashOutputTool } from "../src/tools/process/managedProcesses.js";
import type { RunnableToolExecution, ToolExecution } from "../src/tools/types.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-query-read-boundaries-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const workspaceRoot = path.join(root, "workspace");
await fs.mkdir(workspaceRoot);
await ensureAgentDirs(workspaceRoot);
const recorders: SessionRecorder[] = [];
let fixtureCount = 0;
async function logFixture(content = "0123456789"): Promise<ManagedProcessLogBinding> {
  const logPath = path.join(root, `log-${String(++fixtureCount)}.txt`);
  const file = await fs.open(logPath, "wx+");
  try { await file.writeFile(content); return await bindManagedProcessLog(logPath, file); }
  finally { await file.close(); }
}
function runnable<T>(execution: ToolExecution<T>): RunnableToolExecution<T> {
  assert.ok(!("isError" in execution), "fixture must resolve to a runnable read");
  return execution;
}
function makeCoordinator(registry: ToolRegistry, denyPaths: string[] = [], manager?: PermissionManager,
  confirmPermission?: (request: { targetPath?: string }) => Promise<{ approved: boolean; scope: "once" }>): ToolExecutionCoordinator {
  const config = structuredClone(defaultConfig);
  config.permission = { mode: "full-access", allowTools: [], allowPaths: [], denyPaths, criticalAlwaysAsk: true };
  config.agent.maxConcurrentTools = 1;
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  const recorder = new SessionRecorder(workspaceRoot, `read-boundary-${String(recorders.length)}`);
  recorders.push(recorder);
  return new ToolExecutionCoordinator({ workspaceRoot, config, recorder, toolRegistry: registry, confirmPermission },
    manager ?? new PermissionManager(config.permission), () => undefined, () => ({}));
}
class AskResourcePermission extends PermissionManager {
  override evaluate(request: PermissionRequestContext) {
    const result = super.evaluate(request);
    return result.decision === "deny" ? result : { decision: "ask" as const, reason: "Review this exact fixture resource." };
  }
}

try {
  const log = await logFixture();
  assert.deepEqual(await readManagedProcessLog(log, { maxBytes: 4 }), {
    logPath: log.path, content: "0123", startOffset: 0, nextOffset: 4, totalBytes: 10, omittedBefore: false, hasMore: true
  });
  assert.equal((await readManagedProcessLog(log, { offset: 4, maxBytes: 4 })).content, "4567");
  assert.equal((await readManagedProcessLog(log, { fromEnd: true, maxBytes: 3 })).content, "789");
  await fs.appendFile(log.path, "abc");
  assert.equal((await readManagedProcessLog(log, { offset: 10 })).content, "abc", "normal appends keep log identity");
  assert.equal((await readManagedProcessLog(log, { offset: 100 })).content, "");
  for (const options of [{ maxBytes: 262145 }, { maxBytes: 0 }, { offset: -1 }, { offset: Number.NaN }]) {
    await assert.rejects(readManagedProcessLog(log, options), RangeError);
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readManagedProcessLog(log, {}, aborted.signal), { name: "AbortError" });

  for (const replacement of ["regular", "symlink", "directory", "hardlink"] as const) {
    const original = await logFixture();
    const fixture = path.join(root, `fixture-${replacement}.txt`);
    await fs.writeFile(fixture, "fixture only");
    if (replacement === "hardlink") await fs.link(original.path, `${original.path}.extra`);
    else {
      await fs.rename(original.path, `${original.path}.original`);
      if (replacement === "regular") await fs.writeFile(original.path, "replacement fixture");
      if (replacement === "symlink") await fs.symlink(fixture, original.path);
      if (replacement === "directory") await fs.mkdir(original.path);
    }
    await assert.rejects(readManagedProcessLog(original), /original single-link regular file/u);
  }

  // Deterministic safe file-only races, before open and after read, cannot return replacement bytes.
  for (const stage of ["before-open", "after-read"] as const) {
    const original = await logFixture();
    const realOpen = fs.open;
    const realReadFile = fs.readFile;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) !== original.path) return await realOpen(...args);
      if (stage === "before-open") {
        await fs.rename(original.path, `${original.path}.old`);
        await fs.writeFile(original.path, "different temporary fixture");
      }
      const handle = await realOpen(...args);
      if (stage === "after-read") {
        const read = handle.read.bind(handle);
        mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, length, position);
          await fs.rename(original.path, `${original.path}.old`);
          await fs.writeFile(original.path, "different temporary fixture");
          return result;
        });
      }
      return handle;
    });
    try { await assert.rejects(readManagedProcessLog(original), /original|descriptor/u); }
    finally { mock.restoreAll(); }
    assert.equal(await realReadFile(original.path, "utf8"), "different temporary fixture");
  }

  const globalRoot = path.join(root, "global-skills");
  const skillDir = path.join(globalRoot, "fixture-resource");
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: fixture-resource\ndescription: Temporary boundary fixture\n---\nFixture body\n");
  const resourcePath = path.join(skillDir, "references", "guide.txt");
  await fs.writeFile(resourcePath, "resource fixture");
  const bundle = await loadSkills({ workspaceRoot, projectPaths: [], globalRoot });
  const resourceTool = createSkillResourceTool(bundle);
  const args = { skill: "fixture-resource", path: "references/guide.txt" };
  assert.equal((await runnable(await resourceTool.resolveExecution(args)).execute({ toolCallId: "ordinary", operationId: "ordinary" }) as { content: string }).content, "resource fixture");
  for (const resource of ["../guide.txt", resourcePath]) {
    assert.ok("isError" in await resourceTool.resolveExecution({ ...args, path: resource }));
  }
  const outsideFixture = path.join(root, "outside-skill-fixture.txt");
  await fs.writeFile(outsideFixture, "outside fixture");
  await fs.symlink(outsideFixture, path.join(skillDir, "references", "linked.txt"));
  assert.ok("isError" in await resourceTool.resolveExecution({ ...args, path: "references/linked.txt" }));
  await fs.symlink(root, path.join(skillDir, "linked-directory"), "dir");
  assert.ok("isError" in await resourceTool.resolveExecution({ ...args, path: "linked-directory/outside-skill-fixture.txt" }));
  await fs.writeFile(path.join(skillDir, "references", "binary.txt"), "fixture\0bytes");
  await assert.rejects(runnable(await resourceTool.resolveExecution({ ...args, path: "references/binary.txt" })).execute({ toolCallId: "binary", operationId: "binary" }), /binary/u);
  await fs.writeFile(path.join(skillDir, "references", "large.txt"), "x".repeat(512 * 1024 + 1));
  assert.ok("isError" in await resourceTool.resolveExecution({ ...args, path: "references/large.txt" }));
  const stale = runnable(await resourceTool.resolveExecution(args));
  await fs.writeFile(resourcePath, "changed temporary fixture");
  await assert.rejects(stale.execute({ toolCallId: "stale", operationId: "stale" }), /changed after the tool call was prepared/u);
  // A newly prepared ordinary read remains compatible after normal edits.
  assert.equal((await runnable(await resourceTool.resolveExecution(args)).execute({ toolCallId: "fresh", operationId: "fresh" }) as { content: string }).content, "changed temporary fixture");

  const resourceRegistry = new ToolRegistry(); resourceRegistry.registerUserTool(resourceTool);
  for (const denied of [resourcePath, `${path.dirname(resourcePath)}/`, "guide.txt"]) {
    const result = await makeCoordinator(resourceRegistry, [denied]).createAgentTools()[0]!.execute(`denied-${denied}`, args);
    assert.equal((result.details as { status: string }).status, "denied", "denyPaths must see the resolved global resource target");
  }
  // Force the usual serialized permission gate to verify the prepared resource is still the approved one.
  const approved = makeCoordinator(resourceRegistry, [], new AskResourcePermission({ denyPaths: [] }), async (request) => {
    assert.equal(request.targetPath, resourcePath);
    return { approved: true, scope: "once" };
  });
  assert.equal((await approved.createAgentTools()[0]!.execute("approved-resource", args)).isError, false);
  const changedApproval = makeCoordinator(resourceRegistry, [], new AskResourcePermission({ denyPaths: [] }), async (request) => {
    assert.equal(request.targetPath, resourcePath);
    await fs.writeFile(resourcePath, "changed during approval fixture");
    return { approved: true, scope: "once" };
  });
  const changedResult = await changedApproval.createAgentTools()[0]!.execute("changed-resource-approval", args);
  assert.equal(changedResult.isError, true);
  assert.match(JSON.stringify(changedResult.details), /changed after the tool call was prepared/u);

  const fixtureService = new ManagedProcessService({ workspaceRoot: root });
  const processId = "00000000-0000-4000-8000-000000000001";
  let outputReads = 0;
  fixtureService.outputPath = () => log.path;
  fixtureService.status = async () => ({ processId, pid: 1, command: "fixture-never-launched", cwd: root, state: "exited", logPath: log.path,
    startedAt: "2026-10-02T00:00:00Z", cleanup: { status: "not_needed" } });
  fixtureService.readOutput = async (id, options, signal) => { outputReads++; return { processId: id, ...await readManagedProcessLog(log, options, signal) }; };
  const logRegistry = new ToolRegistry(); logRegistry.registerBuiltinTool(createBashOutputTool(fixtureService));
  const deniedLog = await makeCoordinator(logRegistry, [log.path]).createAgentTools()[0]!.execute("denied-log", { processId });
  assert.equal((deniedLog.details as { status: string }).status, "denied");
  assert.equal(outputReads, 0, "denial must precede reading log bytes");
  const allowedLog = await makeCoordinator(logRegistry).createAgentTools()[0]!.execute("allowed-log", { processId, maxBytes: 4 });
  assert.equal(allowedLog.isError, false);
  assert.equal((allowedLog.details as { output: { content: string } }).output.content, "0123");
  assert.equal((await makeCoordinator(logRegistry, [log.path]).createAgentTools()[0]!.execute("list-no-log-read", {})).isError, false);
  assert.equal(outputReads, 1, "listing never reads a log or changes its permissions");
} finally {
  mock.restoreAll();
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await fs.rm(root, { recursive: true, force: true });
}
console.log("query read boundary tests passed");
