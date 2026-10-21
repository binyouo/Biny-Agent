import { ensureAgentDirs } from "../src/session/store.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { defaultConfig } from "../src/config/schema.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeToolOptimizations, type ToolOptimization } from "../src/session/toolOptimization.js";
import { findRtk, rtkCommand } from "../src/tools/shell/rtk.js";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/recorder.js";

const record: ToolOptimization = { id: "operation-a", kind: "ptc", estimator: "utf8/3", beforeTokens: 800, afterTokens: 100, savedTokens: 700, toolCalls: 2 };

test("statistics deduplicate replayed and forked receipts and retain negative savings", () => {
  assert.deepEqual(summarizeToolOptimizations([{ optimization: record }, { optimization: record },
    { optimization: { ...record, id: "operation-b", beforeTokens: 20, afterTokens: 50, savedTokens: -30 } }]),
  { runs: 2, beforeTokens: 820, afterTokens: 150, savedTokens: 670, ptcTokens: 670, rtkTokens: 0 });
  assert.equal(summarizeToolOptimizations([{ optimization: { ...record, savedTokens: 999 } }]).runs, 0);
});

test("RTK admits only supported simple foreground commands", () => {
  assert.equal(rtkCommand("git status", "/opt/rtk"), "'/opt/rtk' git status");
  assert.equal(rtkCommand("pnpm test", "/opt/rtk"), "'/opt/rtk' pnpm test");
  for (const command of ['rg "hello world" src', "cat README.md", "cargo test", "docker ps", "npm run build", "git diff '*.ts'"]) {
    assert.ok(rtkCommand(command, "/opt/rtk"), command);
  }
  for (const command of ["rg --json pattern", "rg --files", "cat *.ts", "jest", "rg 'unclosed", "git status | cat", "git status; touch file", "git status && echo done", "git status\nwhoami", "git status $(whoami)", "git status > file", "git diff --numstat", "git status --porcelain", "git status -s", "git diff --output=file", "git commit -m change", "pnpm install", "node script.js"]) {
    assert.equal(rtkCommand(command, "/opt/rtk"), undefined, command);
  }
});

test("historical script children and statistics survive session timeline reconstruction", () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "inspect" },
    { type: "tool_call", tool: "run_script", toolCallId: "parent", args: { code: "return 1" } },
    { type: "tool_call", tool: "Read", toolCallId: "parent:nested:1", parentToolCallId: "parent", args: { path: "x" }, auditOnly: true },
    { type: "tool_result", tool: "Read", toolCallId: "parent:nested:1", result: { content: "raw" }, auditOnly: true },
    { type: "tool_result", tool: "run_script", toolCallId: "parent", result: { value: 1 }, modelResult: { value: 1 }, optimization: record },
    { type: "assistant_message", content: "done" }
  ];
  const turns = buildSessionTimeline(events, []);
  assert.equal(turns[0]?.tools.find(tool => tool.id === "parent:nested:1")?.status, "success");
  assert.equal(turns[0]?.tools.find(tool => tool.id === "parent:nested:1")?.parentToolCallId, "parent");
  assert.deepEqual(turns[0]?.tools.find(tool => tool.id === "parent")?.optimization, record);
  assert.deepEqual(turns[0]?.tools.find(tool => tool.id === "parent")?.modelResult, { value: 1 });
});

test("RTK executes once, preserves failure exit status and reads a per-call receipt", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-rtk-test-"));
  const oldPath = process.env.PATH;
  try {
    const marker = path.join(root, "executions");
    await writeFile(path.join(root, "rtk"), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('rtk 0.29.0'); process.exit(0); }
if (process.argv[2] === 'rewrite') { console.log('rtk ' + process.argv[3]); process.exit(0); }
fs.appendFileSync(${JSON.stringify(marker)}, 'once\\n');
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.env.RTK_DB_PATH);
db.exec('CREATE TABLE commands (input_tokens INTEGER, output_tokens INTEGER)');
db.exec('INSERT INTO commands VALUES (400, 100)'); db.close();
console.error('fixture build failure: missing export'); process.exit(7);
`, { mode: 0o700 });
    process.env.PATH = `${root}${path.delimiter}${oldPath ?? ""}`;
    const tool = createRunCommandTool({ workspaceRoot: root, ignore: [] }, undefined, { rtkEnabled: () => true });
    const execution = await tool.resolveExecution({ command: "pnpm build" });
    const result = await execution.execute({ signal: AbortSignal.timeout(10_000) });
    assert.equal(result.background, false);
    if (result.background) throw new Error("unexpected background");
    assert.equal(result.exitCode, 7);
    assert.match(result.stderr, /missing export/);
    assert.equal(result.rtk?.beforeTokens, 400);
    assert.equal(result.rtk?.afterTokens, 100);
    assert.equal(result.rtk?.command, "pnpm build");
    assert.equal(result.rtk?.originalCommand, "pnpm build");
    assert.ok(Number.isSafeInteger(result.rtk?.durationMs) && result.rtk!.durationMs! >= 0);
    assert.equal(await readFile(marker, "utf8"), "once\n");
    assert.ok(result.executedCommand?.includes("rtk"));
    // A missing statistics database must not replay an already executed command.
    await writeFile(path.join(root, "rtk"), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('rtk 0.29.0'); process.exit(0); }
if (process.argv[2] === 'rewrite') { console.log('rtk ' + process.argv[3]); process.exit(0); }
fs.appendFileSync(${JSON.stringify(marker)}, 'once\\n'); console.log('completed without telemetry');
`, { mode: 0o700 });
    const next = await (await tool.resolveExecution({ command: "pnpm build" })).execute({ signal: AbortSignal.timeout(10_000) });
    assert.equal(await readFile(marker, "utf8"), "once\nonce\n");
    assert.equal(next.background, false);
    if (!next.background) { assert.equal(next.exitCode, 0); assert.match(next.optimizationWarning ?? "", /统计不可用/); }

    await writeFile(path.join(root, "rtk"), `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('rtk 0.29.0'); process.exit(0); }
if (process.argv[2] === 'rewrite') { console.log('rtk ' + process.argv[3]); process.exit(0); }
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.env.RTK_DB_PATH);
db.exec('CREATE TABLE commands (input_tokens INTEGER, output_tokens INTEGER)');
db.exec('INSERT INTO commands VALUES (1000, 500)'); db.close();
console.log('x'.repeat(2000));
`, { mode: 0o700 });
    const registry = new ToolRegistry();
    registry.register(tool);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    config.permission.denyPaths = [];
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root, "rtk-ptc-combination");
    try {
      const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
        new PermissionManager(config.permission), () => {}, () => ({}), new Set(["Bash"]));
      const outer = await coordinator.createCodeModeTool().execute("combined", { description: "combined", code: "const r = await tools.Bash({command:'pnpm build'}); return r.stdout.length;" });
      assert.equal(outer.isError, false);
      assert.equal((outer.details as { value: number }).value, 2001);
      const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const receipts = events.filter(event => event.type === "tool_result").map(event => event.optimization).filter(Boolean);
      assert.equal(receipts.length, 2);
      const child = receipts.find(value => value.kind === "rtk");
      const parent = receipts.find(value => value.kind === "ptc");
      assert.equal(child.savedTokens, 500);
      assert.ok(Number.isSafeInteger(child.durationMs) && child.durationMs >= 0);
      assert.ok(parent.beforeTokens < 1000, "PTC starts from compressed child output, not the original RTK input");
      assert.equal(summarizeToolOptimizations(receipts.map(optimization => ({ optimization }))).savedTokens, 500 + parent.beforeTokens - parent.afterTokens);
      assert.ok(!JSON.stringify(outer).includes("xxxxx"));
    } finally { await recorder.close(); }
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});


test("RTK discovery continues past an incompatible executable", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-rtk-discovery-"));
  const oldPath = process.env.PATH;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "old"));
    await mkdir(path.join(root, "valid"));
    await writeFile(path.join(root, "old", "rtk"), `#!${process.execPath}\nconsole.log('rtk 0.28.0');\n`, { mode: 0o700 });
    await writeFile(path.join(root, "valid", "rtk"), `#!${process.execPath}\nconsole.log('rtk 0.29.0');\n`, { mode: 0o700 });
    process.env.PATH = [path.join(root, "old"), path.join(root, "valid")].join(path.delimiter);
    assert.equal((await findRtk()).path, path.join(root, "valid", "rtk"));
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("statistics projection reuses unchanged history and invalidates on append or rewrite", async () => {
  const { ToolOptimizationIndex } = await import("../src/session/toolOptimizationIndex.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-optimization-index-"));
  const oldRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(root);
    recorder = new SessionRecorder(root, "index-case");
    recorder.record({ type: "tool_result", tool: "Bash", toolCallId: "first", result: {}, optimization: record });
    await recorder.flush();
    const index = new ToolOptimizationIndex();
    const first = await index.read(root, "index-case");
    assert.equal(first.length, 1);
    assert.equal(await index.read(root, "index-case"), first, "unchanged files reuse the projection");
    recorder.record({ type: "tool_result", tool: "Bash", toolCallId: "second", result: {}, optimization: { ...record, id: "second" } });
    await recorder.close();
    assert.equal((await index.read(root, "index-case")).length, 2);
    await writeFile(recorder.filePath, JSON.stringify({ type: "tool_result", tool: "Bash", toolCallId: "replacement", time: new Date().toISOString(), optimization: { ...record, id: "replacement" } }) + "\n");
    const rewritten = await index.read(root, "index-case");
    assert.equal(rewritten.length, 1);
    assert.equal(rewritten[0]?.optimization.id, "replacement");
    await rm(recorder.filePath);
    await assert.rejects(index.read(root, "index-case"));
  } finally {
    await recorder?.close();
    if (oldRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
});
