import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { spawn as spawnPty, type IPty } from "node-pty";
import { AgentSession } from "../src/agent/AgentSession.js";
import { defaultConfig, configSchema, type AgentConfig } from "../src/config/schema.js";
import { globalConfigDir } from "../src/config/paths.js";
import { loadConfig, saveConfig, saveConfigFile } from "../src/config/loader.js";
import { createNativeModelForConfig } from "../src/llm/nativeFactory.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { runtimeHostPaths, spawnRuntimeHost, type SpawnedRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";

const execFile = promisify(execFileCallback);

await testBuiltCliCompletesToolTask();
await testProviderTransportCrash();
await testRuntimeHostProviderCrash();
await testTuiThroughPty();
console.log("runtime e2e tests passed");

/** 从构建产物启动真实 CLI，覆盖配置加载、模型流、工具执行、落盘与机器输出。 */
async function testBuiltCliCompletesToolTask(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-e2e-built-cli-"));
  const agentDir = path.join(root, "agent");
  const agentRequestBodies: Record<string, unknown>[] = [];
  const server = await startProviderServer(async (request, response) => {
    const body = await readRequestJson(request);
    if (Array.isArray(body.tools)) {
      agentRequestBodies.push(body);
    } else {
      const system = JSON.stringify(body.messages);
      sendProviderText(response, system.includes("skillIds") ? '{"skillIds":[]}' : system.includes('工具名称') ? '{"tools":[]}' : "[]");
      return;
    }
    if (agentRequestBodies.length === 1) {
      sendProviderParts(response, [
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "write-e2e",
                type: "function",
                function: { name: "Write", arguments: JSON.stringify({ path: "result.txt", content: "e2e-ok\n" }) }
              }]
            },
            finish_reason: null
          }]
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
      return;
    }
    sendProviderText(response, "tool-task-complete");
  });
  try {
    await saveConfigFile(agentDir, testConfig(server.endpoint));
    const cli = path.resolve("dist/cli/index.js");
    const result = await execFile(process.execPath, [cli, "run", "--headless", "--json", "Create result.txt with the requested content."], {
      cwd: root,
      env: { ...process.env, BINY_AGENT_DIR: agentDir },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const output = result.stdout.trim().split(/\r?\n/u).at(-1);
    assert.ok(output, `Built CLI did not return JSON. stderr: ${result.stderr}`);
    const machine = JSON.parse(output) as { status?: unknown; sessionFile?: unknown; steps?: unknown };
    assert.equal(machine.status, "completed", JSON.stringify(machine));
    assert.equal(machine.steps, 2);
    assert.equal(agentRequestBodies.length, 2);
    assert.equal(Array.isArray(agentRequestBodies[0]?.messages), true);
    assert.ok(
      agentRequestBodies.some((body) => JSON.stringify(body.messages).includes("write-e2e")),
      JSON.stringify(agentRequestBodies)
    );
    assert.equal(typeof machine.sessionFile, "string");
    const events = await readSessionEvents(machine.sessionFile as string);
    assert.equal(
      await readFile(path.join(root, "result.txt"), "utf8").catch(() => undefined),
      "e2e-ok\n",
      JSON.stringify(events.filter((event) => event.type === "tool_call" || event.type === "tool_result"))
    );
    for (const type of ["user_message", "assistant_message", "tool_call", "tool_result", "turn_status"] as const) {
      assert.ok(events.some((event) => event.type === type), `Session is missing ${type}.`);
    }
    assert.ok(events.some((event) => event.type === "tool_call" && event.tool === "Write" && event.toolCallId === "write-e2e"));
    assert.ok(events.some((event) => event.type === "turn_status" && event.status === "completed"));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testProviderTransportCrash(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-e2e-provider-crash-"));
  const agentDir = path.join(root, "agent");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = agentDir;
  const server = await startProviderServer((_request, response) => {
    response.destroy();
  });
  try {
    const config = testConfig(server.endpoint);
    const authority = await RuntimeEventAuthority.open(root);
    const recorder = new SessionRecorder(root, "provider-crash", undefined, authority.asSink());
    const sessionFilePath = recorder.filePath;
    const agent = new AgentSession({
      workspaceRoot: root,
      config,
      model: createNativeModelForConfig(config),
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager(config.permission),
      recorder,
      runtimeEventSink: authority.asSink()
    });
    try {
      await agent.initialize();
      const outcome = await agent.runTask("exercise a provider transport crash");
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.stopReason, "provider_error");
    } finally {
      await agent.close();
      authority.close();
    }

    const reopened = await RuntimeEventAuthority.open(root);
    const events = reopened.readEvents({ sessionId: "provider-crash" }).events;
    assert.ok(events.some((event) => event.eventType === "session.model_request"));
    assert.equal(events.filter((event) => event.eventType === "session.turn_status").length, 1);
    reopened.close();
    const sessionEvents = await readSessionEvents(sessionFilePath);
    assert.equal(sessionEvents.filter((event) => event.type === "turn_status").length, 1);
    assert.equal(sessionEvents.find((event) => event.type === "turn_status")?.status, "failed");
  } finally {
    await server.close();
    restoreAgentDir(previousAgentDir);
    await rm(root, { recursive: true, force: true });
  }
}

async function testRuntimeHostProviderCrash(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-e2e-host-provider-crash-"));
  const agentDir = path.join(root, "agent");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const configDir = path.join(root, "config");
  const server = await startProviderServer((_request, response) => {
    response.destroy();
  });
  let spawned: SpawnedRuntimeHost | undefined;
  let sessionId: string | undefined;
  try {
    process.env.BINY_AGENT_DIR = agentDir;
    await saveConfig(root, testConfig(server.endpoint), { globalDir: configDir });
    spawned = await spawnRuntimeHost(root, {
      workspaceRoot: root,
      configDir,
      resumeInterrupted: false,
      clientId: "provider-crash-e2e",
      surface: "cli"
    });
    sessionId = spawned.client.getSnapshot().info.sessionId;
    const outcome = await withTimeout(
      spawned.client.submitPrompt("exercise a provider crash through Runtime Host").completion,
      10_000,
      "Runtime Host provider crash completion"
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.stopReason, "provider_error");
    await spawned.client.close();

    const authority = await RuntimeEventAuthority.open(root);
    const events = authority.readEvents({ sessionId }).events;
    assert.equal(events.filter((event) => event.eventType === "session.turn_status").length, 1);
    const terminal = events.find((event) => event.eventType === "session.turn_status");
    assert.equal((terminal?.payload as { status?: unknown } | undefined)?.status, "failed");
    authority.close();
  } finally {
    await spawned?.client.close().catch(() => undefined);
    await stopDetachedHost(root, spawned?.process.pid);
    await server.close();
    restoreAgentDir(previousAgentDir);
    await rm(root, { recursive: true, force: true });
  }
}

async function testTuiThroughPty(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-e2e-tui-pty-"));
  const agentDir = path.join(root, "agent");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = agentDir;
  const server = await startProviderServer((_request, response) => {
    sendProviderText(response, "pty-provider-ok");
  });
  let terminal: IPty | undefined;
  let detachedHostPid: number | undefined;
  try {
    await saveConfigFile(globalConfigDir(), testConfig(server.endpoint));
    assert.equal((await loadConfig(root)).defaultModel, "local-test");
    terminal = spawnPty(
      process.execPath,
      [...process.execArgv, path.resolve("src/cli/index.ts"), "tui"],
      {
        cwd: root,
        cols: 120,
        rows: 40,
        env: {
          ...process.env,
          BINY_AGENT_DIR: agentDir,
          TERM: "xterm-256color",
          COLORTERM: "truecolor"
        }
      }
    );
    let output = "";
    terminal.onData((data) => { output += data; });
    await waitFor(() => output.includes("openai-compatible/local-test"), 30_000, terminal, () => output);
    detachedHostPid = await readDetachedHostPid(root);
    terminal.write("hello from pty\r");
    await waitFor(() => output.includes("pty-provider-ok"), 30_000, terminal, () => output);
    assert.equal(output.includes("Working"), true);
  } finally {
    if (terminal) await stopPty(terminal);
    await stopDetachedHost(root, detachedHostPid);
    await server.close();
    restoreAgentDir(previousAgentDir);
    await rm(root, { recursive: true, force: true });
  }
}

function testConfig(endpoint: string): AgentConfig {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "local-test",
    providers: {
      local: {
        type: "openai-compatible",
        baseUrl: endpoint,
        requiresApiKey: false,
        retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
      }
    },
    models: {
      "local-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "local",
        model: "local-test",
        displayName: "Local E2E Provider",
        contextWindow: 128_000,
        capabilities: { tools: true, reasoning: false, streaming: true }
      }
    },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
}

async function startProviderServer(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void | Promise<void>
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("E2E provider did not bind a TCP port.");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function readRequestJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendProviderParts(
  response: import("node:http").ServerResponse,
  parts: Array<Record<string, unknown> | "[DONE]">
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(parts.map((part) => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
}

function sendProviderText(response: import("node:http").ServerResponse, text: string): void {
  sendProviderParts(response, [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    "[DONE]"
  ]);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, terminal: IPty, getOutput: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (!predicate()) {
    await stopPty(terminal);
    const raw = getOutput();
    const plain = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const diagnostics = plain.split(/\r?\n/).filter((line) => /failed|error|model|startup/i.test(line)).slice(-20);
    throw new Error(`Timed out waiting for PTY output.\n${JSON.stringify(diagnostics.length ? diagnostics : plain.slice(-4000))}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopPty(terminal: IPty): Promise<void> {
  terminal.write("\u0003");
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  terminal.write("\u0003");
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminal.kill();
      resolve();
    }, 5_000);
    terminal.onExit(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readDetachedHostPid(workspaceRoot: string, waitMs = 0): Promise<number | undefined> {
  const registrationPath = runtimeHostPaths(workspaceRoot).registrationPath;
  const deadline = Date.now() + waitMs;
  while (true) {
    const registration = await readFile(registrationPath, "utf8").catch(() => undefined);
    if (registration !== undefined) {
      try {
        const pid = (JSON.parse(registration) as { pid?: unknown }).pid;
        if (typeof pid === "number" && pid > 1 && pid !== process.pid) return pid;
      } catch {
        // Registration may be replaced while the owner is starting.
      }
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

async function stopDetachedHost(workspaceRoot: string, knownPid?: number): Promise<void> {
  const pids = new Set<number>();
  if (knownPid !== undefined) pids.add(knownPid);
  const registeredPid = await readDetachedHostPid(workspaceRoot, 1_000);
  if (registeredPid !== undefined) pids.add(registeredPid);
  const processRoots = new Set([path.resolve(workspaceRoot), await realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot))]);
  const processes = await execFile("ps", ["-axo", "pid=,command="]).catch(() => undefined);
  for (const line of processes?.stdout.split("\n") ?? []) {
    const pidText = line.trim().split(/\s+/, 1)[0];
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    if ([...processRoots].some((root) => line.includes(root))) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      pids.delete(pid);
    }
  }
  if (!pids.size) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The owner may have exited between the liveness probe and the kill.
    }
  }
}

function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previous;
}
