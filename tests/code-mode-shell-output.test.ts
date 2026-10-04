/** Host-registered BashOutput and archive pages remain full programmatic Code Mode values. */
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { codeModePolicy } from "../src/agent/codeMode.js";
import { shellOutputBudgetBytes } from "../src/agent/shellOutputProjection.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentToolResult } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { bindManagedProcessLog, readManagedProcessLog } from "../src/runtime/managedProcessLog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readToolResultArchive, resolveToolResultArchivePath, serializeToolResult } from "../src/session/toolResultArchive.js";
import { createToolRegistry, isCodeModeReadTool } from "../src/tools/registry.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-shell-output-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR ??= path.join(root, "agent");
await ensureAgentDirs(root);
const recorders: SessionRecorder[] = [];
const processId = "00000000-0000-4000-8000-000000000051";
const logPath = path.join(root, "managed-output.log");
const logText = `LOG_HEAD\n${"readable 你🙂 log line\n".repeat(4_000)}LOG_TAIL`;
const logFile = await open(logPath, "wx+");
await logFile.writeFile(logText);
const binding = await bindManagedProcessLog(logPath, logFile);
await logFile.close();
const service = new ManagedProcessService({ workspaceRoot: root });
let outputReads = 0;
// A stable exited-process fixture uses the real inode-bound log reader. No shell
// is launched through Code Mode, and no application sandbox policy is changed.
service.outputPath = (id) => { assert.equal(id, processId); return logPath; };
service.status = async (id) => { assert.equal(id, processId); return { processId, pid: 1, command: "exited-output-fixture", cwd: root,
  state: "exited", logPath, startedAt: "2026-10-04T00:00:00Z", exitCode: 0, cleanup: { status: "not_needed" } }; };
service.readOutput = async (id, options, signal) => {
  assert.equal(id, processId); outputReads++;
  return { processId, ...await readManagedProcessLog(binding, options, signal) };
};
const record = (value: unknown): Record<string, any> => value as Record<string, any>;
const details = (result: AgentToolResult) => record(result.details);
const args = { processId, maxBytes: 256 * 1024 };
const logCode = `return await tools.BashOutput(${JSON.stringify(args)});`;
class AskReads extends PermissionManager {
  override evaluate(request: PermissionRequestContext) {
    const evaluation = super.evaluate(request);
    return evaluation.decision === "deny" ? evaluation : { decision: "ask" as const, reason: "Approve this fixture read." };
  }
}
function coordinator(name: string, options?: { denyPaths?: string[]; ask?: () => Promise<{ approved: boolean; scope: "once" }> }) {
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "code_mode";
  config.agent.maxConcurrentTools = 1;
  config.permission.mode = "full-access";
  config.permission.denyPaths.push(...options?.denyPaths ?? []);
  config.context.maxTurnToolResultBytes = 4 * 1024 * 1024;
  config.checkpoints.enabled = false;
  const registry = createToolRegistry({ workspaceRoot: root, ignore: config.workspace.ignore }, undefined, service);
  const recorder = new SessionRecorder(root, name);
  recorders.push(recorder);
  const instance = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, confirmPermission: options?.ask },
    options?.ask ? new AskReads(config.permission) : new PermissionManager(config.permission), () => undefined, () => ({}),
    new Set(["Bash", "BashOutput", "read_tool_result"]));
  return { instance, registry, recorder };
}
let archivePath: string;
let archivedOutput: string;

try {
  await test("actual host registry exposes BashOutput with bounded direct output and full nested Code Mode pages", async () => {
    const { instance, registry, recorder } = coordinator("full-shell-page");
    assert.equal(registry.listEntries().some((entry) => entry.tool.name === "BashOutput" && isCodeModeReadTool(entry)), true);
    assert.equal(registry.listEntries().some((entry) => entry.tool.name === "Bash" && isCodeModeReadTool(entry)), false);
    const directTool = instance.createAgentTools().find((tool) => tool.name === "BashOutput")!;
    const direct = await directTool.execute("direct-shell-page", args);
    assert.equal(direct.isError, false, JSON.stringify(direct.details));
    const excerpt = details(direct);
    assert.equal(excerpt.modelProjection, "shell_excerpt");
    assert.ok(Buffer.byteLength(excerpt.output.content, "utf8") <= shellOutputBudgetBytes);
    assert.ok(excerpt.output.content.startsWith("LOG_HEAD"));
    assert.ok(excerpt.output.content.endsWith("LOG_TAIL"));
    assert.equal(excerpt.output.contentTruncated, true);
    assert.equal(excerpt.output.nextOffset, Buffer.byteLength(logText));
    assert.equal(excerpt.output.hasMore, false);
    assert.doesNotMatch(excerpt.output.content, /\uFFFD/u);
    archivePath = excerpt.archivePath;
    archivedOutput = (await readToolResultArchive(root, archivePath)).output;
    assert.equal(JSON.parse(archivedOutput).output.content, logText);

    const exec = instance.createCodeModeTool();
    assert.match(exec.promptSnippet ?? "", /BashOutput:/u);
    assert.doesNotMatch(exec.promptSnippet ?? "", /(?:^|\n)Bash:/u);
    const nested = await exec.execute("nested-shell-page", { code: logCode });
    assert.equal(nested.isError, false, JSON.stringify(nested.details));
    assert.equal(details(nested).value.output.content, logText, "nested host query must bypass model-only excerpts");
    assert.equal(details(nested).value.output.nextOffset, Buffer.byteLength(logText));
    assert.equal(details(nested).value.modelProjection, undefined);
    assert.deepEqual(details(nested).childCalls, [{ tool: "BashOutput", toolCallId: "nested-shell-page:nested:1" }]);
    const audit = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .find((event) => event.type === "tool_result" && event.toolCallId === "nested-shell-page:nested:1");
    assert.equal(audit.auditOnly, true);
    const childArchive = await readToolResultArchive(root, audit.result.archivePath);
    assert.equal(childArchive.output, serializeToolResult(details(nested).value));

    const unavailable = await exec.execute("bash-remains-unavailable", { code: "return await tools.Bash({command:'printf forbidden-nested-execution'});" });
    assert.equal(unavailable.isError, true);
    assert.deepEqual(details(unavailable).childCalls, [], "Bash must never enter nested execution");
    assert.match(details(unavailable).error, /not available/u);
  });

  await test("read_tool_result nested pages preserve exact requested content and pagination metadata", async () => {
    const { instance } = coordinator("full-archive-page");
    const code = `return await tools.read_tool_result({archivePath:${JSON.stringify(archivePath)},offset:0,length:200000});`;
    const result = await instance.createCodeModeTool().execute("nested-archive-page", { code });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const page = details(result).value;
    assert.equal(page.content, archivedOutput);
    assert.ok(Buffer.byteLength(page.content) > shellOutputBudgetBytes);
    assert.equal(page.offset, 0);
    assert.equal(page.nextOffset, archivedOutput.length);
    assert.equal(page.hasMore, false);
    assert.equal(page.modelProjection, undefined);
    assert.deepEqual(details(result).childCalls, [{ tool: "read_tool_result", toolCallId: "nested-archive-page:nested:1" }]);
  });

  await test("Code Mode host output and final-result byte limits remain independent from shell excerpts", async () => {
    for (const [name, code] of [
      ["shell", logCode],
      ["archive", `return await tools.read_tool_result({archivePath:${JSON.stringify(archivePath)},length:200000});`]
    ] as const) {
      const { instance } = coordinator(`host-byte-limit-${name}`);
      const limited = await instance.createCodeModeTool(undefined, { ...codeModePolicy, maxToolOutputBytes: 16 * 1024 })
        .execute(`host-byte-limit-${name}`, { code });
      assert.equal(limited.isError, true, "a full programmatic page must still hit the Code Mode bridge byte limit");
      assert.match(details(limited).error, /size|byte|limit|large/iu);
      assert.equal(details(limited).childCalls.length, 1);
    }
    const { instance } = coordinator("final-byte-limit");
    const limited = await instance.createCodeModeTool(undefined, { ...codeModePolicy, maxResultBytes: 1_024 })
      .execute("final-byte-limit", { code: logCode });
    assert.equal(limited.isError, true);
    assert.match(details(limited).error, /size|byte|limit|large/iu);
    assert.equal(details(limited).childCalls.length, 1, "host read fits its own independent output budget");
    const reduced = await instance.createCodeModeTool(undefined, { ...codeModePolicy, maxResultBytes: 1_024 })
      .execute("reduced-byte-result", { code: `const page=await tools.BashOutput(${JSON.stringify(args)});return {characters:page.output.content.length};` });
    assert.equal(reduced.isError, false, JSON.stringify(reduced.details));
    assert.deepEqual(details(reduced).value, { characters: logText.length });
  });

  await test("nested queries retain approval, explicit deny paths and restricted archive references", async () => {
    let asks = 0;
    const before = outputReads;
    const denied = coordinator("denied-shell-page", { denyPaths: [logPath] });
    const deniedResult = await denied.instance.createCodeModeTool().execute("denied-shell-page", { code: logCode });
    assert.equal(deniedResult.isError, true);
    assert.match(details(deniedResult).error, /denied by project policy/u);
    assert.equal(outputReads, before, "denied logs must never reach the reader");
    const unapproved = coordinator("unapproved-shell-page", { ask: async () => { asks++; return { approved: false, scope: "once" }; } });
    assert.equal((await unapproved.instance.createCodeModeTool().execute("unapproved-shell-page", { code: logCode })).isError, true);
    assert.equal(asks, 1);
    assert.equal(outputReads, before);
    const unapprovedArchive = coordinator("unapproved-archive-page", { ask: async () => { asks++; return { approved: false, scope: "once" }; } });
    const archiveRefused = await unapprovedArchive.instance.createCodeModeTool().execute("unapproved-archive-page", {
      code: `return await tools.read_tool_result({archivePath:${JSON.stringify(archivePath)}});`
    });
    assert.equal(archiveRefused.isError, true);
    assert.equal(asks, 2, "archive reads must still pass the existing approval gate");
    const { instance } = coordinator("restricted-archive-paths");
    const exec = instance.createCodeModeTool();
    for (const [index, escape] of ["../../outside.txt", ".biny/tool-results/../sessions/private.jsonl", logPath].entries()) {
      const result = await exec.execute(`archive-escape-${index}`, { code: `return await tools.read_tool_result({archivePath:${JSON.stringify(escape)}});` });
      assert.equal(result.isError, true);
      assert.match(details(result).error, /Not an archived tool result reference/u);
    }
    const external = path.join(root, "unrelated.txt");
    await writeFile(external, "not an archived tool result");
    const symlinkReference = `.biny/tool-results/tool-result-${"f".repeat(64)}.json`;
    await symlink(external, resolveToolResultArchivePath(root, symlinkReference));
    const symlinkRead = await exec.execute("archive-symlink", { code: `return await tools.read_tool_result({archivePath:${JSON.stringify(symlinkReference)}});` });
    assert.equal(symlinkRead.isError, true);
    assert.equal(details(symlinkRead).value, undefined);
    assert.equal(await readFile(external, "utf8"), "not an archived tool result");
  });
} finally {
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
