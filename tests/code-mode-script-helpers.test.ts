import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { createManagedProcessTools } from "../src/tools/process/managedProcesses.js";

test("script inputs reject a missing title before dispatch; published examples discover and read real files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-script-contract-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "script-contract");
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: root, ignore: [] }));
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries()));
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => {});
  try {
    const tool = coordinator.createCodeModeTool();
    const invalid = await tool.execute("missing-title", { code: "return await tools.Read({path:'missing.txt'});" });
    assert.equal(invalid.isError, true);
    assert.deepEqual((invalid.details as { childCalls: unknown[] }).childCalls, []);
    assert.match(JSON.stringify(invalid.details), /description/u);

    await writeFile(path.join(root, "README.md"), "hello\nworld");
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}');
    const examples = [...tool.description.matchAll(/```javascript\n([\s\S]*?)```/gu)].map(match => match[1]!);
    assert.equal(examples.length, 2, "publish discovery and execution as separate examples");
    const discovery = await tool.execute("example-discover", { description: "发现读取工具", code: examples[0] });
    assert.equal(discovery.isError, false, JSON.stringify(discovery.details));
    const matches = (discovery.details as { value: Array<{ name: string; parameters: { required: string[] }; outputSchema: unknown }> }).value;
    assert.equal(Array.isArray(matches), true);
    assert.equal(matches[0]?.name, "Read");
    assert.deepEqual(matches[0]?.parameters.required, ["path"]);
    assert.ok(matches[0]?.outputSchema);
    const execution = await tool.execute("example-execute", { description: "读取两个文件", code: examples[1] });
    assert.equal(execution.isError, false, JSON.stringify(execution.details));
    assert.deepEqual((execution.details as { value: unknown }).value, [
      { path: "README.md", content: "hello\nworld", hasMore: false },
      { path: "package.json", content: '{"name":"demo"}', hasMore: false }
    ]);
  } finally {
    await coordinator.waitForIdle();
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed process discovery exposes ProcessStatus without an old-name alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-process-contract-"));
  const service = new ManagedProcessService({ workspaceRoot: root });
  try {
    const registry = new ToolRegistry();
    for (const tool of createManagedProcessTools(service)) registry.registerBuiltinTool(tool);
    assert.equal(registry.listEntries().some(entry => entry.tool.name === "BashOutput"), false);
    const tool = registry.listEntries().find(entry => entry.tool.name === "ProcessStatus")?.tool;
    assert.ok(tool);
    const execution = await tool.resolveExecution(tool.schema.parse({}));
    assert.ok(!("isError" in execution));
    assert.deepEqual(await execution.execute({ toolCallId: "list-processes" }), { processes: [], process: undefined, output: undefined });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    // This isolated fixture exercises unrestricted helper execution; restrictions are tested below.
    config.permission.denyPaths = [];
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => {}, () => ({}), new Set(["Bash", "WebFetch"]));
    const result = await coordinator.createCodeModeTool().execute("helpers", { description: "helpers", language: "typescript",
      code: `const body: {answer:number} = await (await fetch(${JSON.stringify(url)})).json(); const out = await sh("printf hello"); console.log(body.answer); return {answer:body.answer,out};` });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.deepEqual((result.details as { value: unknown }).value, { answer: 42, out: "hello" });
    assert.equal((result.details as { stdout: string }).stdout, "42\n");
    assert.equal(requests, 1);
    const restricted = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => {}, () => ({}), new Set(["Bash"]), undefined, undefined, new Set(["Bash"]));
    const denied = await restricted.createCodeModeTool().execute("denied-fetch", { description: "denied-fetch", code: `return await fetch(${JSON.stringify(url)});` });
    assert.equal(denied.isError, true);
    assert.equal(requests, 1, "helper cannot invoke an unselected network tool");
    const blocked = createWebFetchTool(undefined, { enabled: false });
    await assert.rejects((await blocked.resolveExecution({ url, raw: true })).execute({ signal: AbortSignal.timeout(2000) }), /private|local|blocked|not allowed|internal/i);
    assert.equal(requests, 1);
    const raw = await coordinator.createCodeModeTool().execute("raw-html", { description: "raw-html", code: `return await (await fetch(${JSON.stringify(url.replace("/value", "/html"))})).text();` });
    assert.equal(raw.isError, false);
    assert.equal((raw.details as { value: string }).value, html);
    const shellFailure = await coordinator.createCodeModeTool().execute("shell-failure", { description: "shell-failure", code: 'return await sh("exit 7");' });
    assert.equal(shellFailure.isError, true);
    assert.match(JSON.stringify(shellFailure.details), /7/);
    const restrictedConfig = structuredClone(config);
    restrictedConfig.permission.denyPaths = ["restricted-marker"];
    const sandboxed = new ToolExecutionCoordinator({ workspaceRoot: root, config: restrictedConfig, recorder, toolRegistry: registry },
      new PermissionManager(restrictedConfig.permission), () => {}, () => ({}), new Set(["Bash"]));
    const sandboxDenied = await sandboxed.createCodeModeTool().execute("sandbox-denied-shell", { description: "sandbox-denied-shell",
      code: 'return await sh("echo forbidden > restricted-marker");'
    });
    assert.equal(sandboxDenied.isError, true, "nested helpers must retain explicit path restrictions");
    const sandboxDetails = JSON.stringify(sandboxDenied.details);
    if (process.platform === "darwin") assert.match(sandboxDetails, /Operation not permitted|Permission denied/i);
    else assert.match(sandboxDetails, /Cannot enforce command sandbox restrictions.*command was not started/u);
    await assert.rejects(access(path.join(root, "restricted-marker")), { code: "ENOENT" });
    assert.equal(requests, 2, "restricted shell must not cause extra HTTP requests");
  } finally {
    await recorder?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
