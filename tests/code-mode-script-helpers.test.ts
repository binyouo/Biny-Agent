import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";
import { createWebFetchTool } from "../src/tools/web/fetch.js";
import { executeCodeModeCell } from "../src/agent/codeMode.js";

test("TypeScript compiles without host access and captures selected stdout", async () => {
  const result = await executeCodeModeCell({ language: "typescript", parentToolCallId: "typescript", tools: [], isCurrent: () => false,
    code: 'interface Row { value: number }; const rows: Row[] = [{value: 3}, {value: 7}]; console.log("sum", rows.reduce((sum: number, row: Row) => sum + row.value, 0)); return typeof process;' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value, "undefined");
  assert.equal(result.stdout, "sum 10\n");
  const invalid = await executeCodeModeCell({ language: "typescript", parentToolCallId: "invalid", tools: [], isCurrent: () => false,
    code: 'import fs from "node:fs"; return fs.readFileSync("/etc/passwd");' });
  assert.equal(invalid.ok, false);
});

test("script helpers execute real Shell and HTTP tools and preserve admission boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-script-helpers-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let recorder: SessionRecorder | undefined;
  let requests = 0;
  const html = "<!doctype html><html><body><h1>Raw response</h1></body></html>";
  const server = createServer((req, res) => {
    requests++;
    res.writeHead(200, { "content-type": req.url === "/html" ? "text/html" : "application/json" });
    res.end(req.url === "/html" ? html : '{"answer":42}');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/value`;
    await ensureAgentDirs(root);
    recorder = new SessionRecorder(root, "helpers");
    const registry = new ToolRegistry();
    registry.registerBuiltinTool(createRunCommandTool({ workspaceRoot: root, ignore: [] }));
    registry.registerBuiltinTool(createWebFetchTool({ ...defaultConfig.web.fetch, allowPrivateNetwork: true }, { enabled: false }));
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => {}, () => ({}), new Set(["Bash", "WebFetch"]));
    const result = await coordinator.createCodeModeTool().execute("helpers", { language: "typescript",
      code: `const body: {answer:number} = await (await fetch(${JSON.stringify(url)})).json(); const out = await sh("printf hello"); console.log(body.answer); return {answer:body.answer,out};` });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.deepEqual((result.details as { value: unknown }).value, { answer: 42, out: "hello" });
    assert.equal((result.details as { stdout: string }).stdout, "42\n");
    assert.equal(requests, 1);
    const restricted = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => {}, () => ({}), new Set(["Bash"]), undefined, undefined, new Set(["Bash"]));
    const denied = await restricted.createCodeModeTool().execute("denied-fetch", { code: `return await fetch(${JSON.stringify(url)});` });
    assert.equal(denied.isError, true);
    assert.equal(requests, 1, "helper cannot invoke an unselected network tool");
    const blocked = createWebFetchTool(undefined, { enabled: false });
    await assert.rejects((await blocked.resolveExecution({ url, raw: true })).execute({ signal: AbortSignal.timeout(2000) }), /private|local|blocked|not allowed|internal/i);
    assert.equal(requests, 1);
    const raw = await coordinator.createCodeModeTool().execute("raw-html", { code: `return await (await fetch(${JSON.stringify(url.replace("/value", "/html"))})).text();` });
    assert.equal(raw.isError, false);
    assert.equal((raw.details as { value: string }).value, html);
    const shellFailure = await coordinator.createCodeModeTool().execute("shell-failure", { code: 'return await sh("exit 7");' });
    assert.equal(shellFailure.isError, true);
    assert.match(JSON.stringify(shellFailure.details), /7/);
  } finally {
    await recorder?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
