import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { createInteractiveAgentHost, type SubmittedAgentRun } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost, type RuntimeHostFactory } from "../src/runtime/RuntimeHost.js";

const cli = path.resolve("src/cli/index.ts");

test("inspection CLI targets the existing session and preserves Host compaction admission", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-inspection-cli-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const requests = new EventEmitter();
  const provider = createServer((request, _response) => { request.resume(); requests.emit("model"); });
  let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
  let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
  let running: SubmittedAgentRun | undefined;
  try {
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address(); assert.ok(address && typeof address !== "string");
    const config = configSchema.parse({ ...defaultConfig,
      // Permit the fixture's Bash lifecycle commands; sandbox denial has separate coverage.
      permission: { ...defaultConfig.permission, denyPaths: [] },
      defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "fixture", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all" },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: false }, skills: [] },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
    });
    const configStore = createFileConfigStore(root, { globalDir: process.env.BINY_AGENT_DIR, credentialStore: new EnvironmentCredentialStore() });
    await configStore.save(config);
    const factory: RuntimeHostFactory = async (sessionId, options) => await createInteractiveAgentHost(root, {
      sessionId, configStore, resourceRegistry: options?.resourceRegistry
    });
    host = await startRuntimeHost(root, registry => factory("inspection", { fresh: true, resourceRegistry: registry }), { createRuntime: factory });
    client = await connectRuntimeHost(root, { clientId: "inspection-observer", surface: "cli" }); assert.ok(client);
    const usage = await run(root, ["session", "usage", "--session", "inspection", "--json"]);
    assert.equal(usage.code, 0, usage.stderr);
    assert.equal(JSON.parse(usage.stdout).summary.calls, 0);
    assert.equal(JSON.parse(usage.stdout).summary.totalTokens, 0);
    const tools = await run(root, ["tool", "list", "--session", "inspection", "--json"]);
    assert.equal(tools.code, 0, tools.stderr);
    const names = (JSON.parse(tools.stdout) as Array<{ name: string }>).map(tool => tool.name);
    assert.ok(names.includes("Read")); assert.ok(names.includes("Bash"));
    const written = await run(root, ["tool", "call", "Write", JSON.stringify({ path: "cli-tool.txt", content: "Written through the Host" }), "--session", "inspection", "--json"]);
    assert.equal(written.code, 0, written.stderr);
    assert.equal(await readFile(path.join(root, "cli-tool.txt"), "utf8"), "Written through the Host");
    const read = await run(root, ["tool", "call", "Read", JSON.stringify({ path: "cli-tool.txt" }), "--session", "inspection", "--json"]);
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /Written through the Host/u);
    const invalidTool = await run(root, ["tool", "call", "MissingTool", "{}", "--session", "inspection", "--json"]);
    assert.equal(invalidTool.code, 1);
    assert.equal(invalidTool.stdout, "");
    const outside = await run(root, ["tool", "call", "Read", JSON.stringify({ path: "../outside.txt" }), "--session", "inspection", "--json"]);
    assert.equal(outside.code, 1);
    assert.equal(outside.stdout, "");
    await client.focusSession("inspection");
    await client.setPermissionMode("read-only");
    const denied = await run(root, ["tool", "call", "Write", '{"path":"denied.txt","content":"must not write"}', "--session", "inspection", "--json"]);
    assert.equal(denied.code, 1);
    assert.equal(denied.stdout, "");
    await assert.rejects(readFile(path.join(root, "denied.txt")), { code: "ENOENT" });
    await client.setPermissionMode("full-access");
    const compacted = await run(root, ["session", "compact", "--session", "inspection", "--json"]);
    assert.equal(compacted.code, 0, compacted.stderr);
    assert.equal(JSON.parse(compacted.stdout).summary, "Conversation is already within the compaction threshold.");
    const unknown = await run(root, ["session", "usage", "--session", "missing", "--json"]);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stdout, "");
    assert.deepEqual((await client.listRuntimeSessions()).map(item => item.sessionId), ["inspection"]);
    await client.focusSession("inspection");
    const nextRequest = once(requests, "model", { signal: AbortSignal.timeout(10_000) });
    running = client.submitPrompt("Keep this model request open.");
    void running.completion.catch(() => {});
    await nextRequest;
    const busy = await run(root, ["session", "compact", "--session", "inspection", "--json"]);
    assert.equal(busy.code, 1);
    assert.notEqual(busy.stderr, "");
    const busyTool = await run(root, ["tool", "call", "Write", '{"path":"busy.txt","content":"must not write"}', "--session", "inspection", "--json"]);
    assert.equal(busyTool.code, 1);
    assert.equal(busyTool.stdout, "");
    client.cancelCurrentRun("cancelled");
    await running.completion;
    const created = await run(root, ["session", "create", "--json"]);
    assert.equal(created.code, 0, created.stderr);
    const createdId = JSON.parse(created.stdout).sessionId;
    assert.notEqual(createdId, "inspection");
    assert.ok((await client.listRuntimeSessions()).some(item => item.sessionId === createdId));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const nestedCommand = [process.execPath, ...process.execArgv, cli, "tool", "call", "Write", '{"path":"nested.txt","content":"must not write"}', "--session", "inspection", "--json"].map(quote).join(" ");
    const nested = await run(root, ["tool", "call", "Bash", JSON.stringify({ command: nestedCommand }), "--session", "inspection", "--json"]);
    assert.equal(nested.code, 1, nested.stdout);
    await assert.rejects(readFile(path.join(root, "nested.txt")), { code: "ENOENT" });
    const processScript = 'require("fs").writeFileSync("tool-ready.json",JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)';
    const toolProcess = spawn(process.execPath, [...process.execArgv, cli, "tool", "call", "Bash", JSON.stringify({ command: `${quote(process.execPath)} -e ${quote(processScript)}` }), "--session", "inspection", "--json"], {
      cwd: root, env: process.env, stdio: "ignore", signal: AbortSignal.timeout(20_000)
    });
    const toolExited = new Promise<void>((resolve, reject) => { toolProcess.once("error", reject); toolProcess.once("close", () => resolve()); });
    try {
      const deadline = AbortSignal.timeout(10_000);
      let pid: number | undefined;
      while (pid === undefined) {
        deadline.throwIfAborted();
        try { pid = JSON.parse(await readFile(path.join(root, "tool-ready.json"), "utf8")).pid; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (pid === undefined) await delay(20, undefined, { signal: deadline });
      }
      toolProcess.kill("SIGINT");
      await toolExited;
      await client.focusSession("inspection");
      await client.waitForIdle();
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    } finally {
      toolProcess.kill("SIGTERM");
      await toolExited;
    }
  } finally {
    client?.cancelCurrentRun("cancelled");
    await running?.completion.catch(() => {});
    await client?.close(); await host?.close();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

async function run(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...process.execArgv, cli, ...args], { cwd, env: process.env, signal: AbortSignal.timeout(20_000) });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}
