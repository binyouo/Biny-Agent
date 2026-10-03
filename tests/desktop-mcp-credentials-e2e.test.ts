import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { saveConfigFile } from "../src/config/loader.js";
import { globalConfigDir } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";
import { readSessionEvents } from "../src/session/events.js";

test("built Desktop Host reloads encrypted MCP authentication and continues a persisted session", {
  skip: process.platform !== "darwin", timeout: 30_000
}, async () => {
  assert.ok(existsSync(fileURLToPath(new URL("../out/main/index.js", import.meta.url))), "Build Desktop before running this regression");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-desktop-mcp-")));
  const account = "mcp:fixture:headers:Authorization";
  const credential = "Bearer local-mcp-fixture";
  let mcpAuthenticated = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url !== "/mcp") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        { choices: [{ index: 0, delta: { content: "local-continued-reply" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
      return;
    }
    if (request.headers.authorization !== credential) { response.writeHead(401).end(); return; }
    mcpAuthenticated = true;
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local-mcp", version: "1" } }
      : { tools: [] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let host: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
  try {
    await saveConfigFile(globalConfigDir(), {
      ...structuredClone(defaultConfig), defaultModel: "fixture",
      agent: { ...defaultConfig.agent, toolExecutionMode: "code_mode" },
      providers: { fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "fixture", contextWindow: 128_000, capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none" },
      extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false }, mcp: {
        secured: { enabled: true, type: "http", url: `http://127.0.0.1:${address.port}/mcp`, transportProtocol: "streamable-http", credentialRefs: { headers: { Authorization: account } } }
      } },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      checkpoints: { enabled: false },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const setupEntry = path.join(root, "prepare.cjs");
    await writeFile(setupEntry, `
      const { app, safeStorage, BrowserWindow } = require("electron");
      const fs = require("node:fs/promises");
      app.setName("Biny"); app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        app.setActivationPolicy("prohibited");
        if (!safeStorage.isEncryptionAvailable() || BrowserWindow.getAllWindows().length) throw new Error("Headless cipher unavailable");
        const payload = safeStorage.encryptString(JSON.stringify({ ${JSON.stringify(account)}: ${JSON.stringify(credential)} }));
        await fs.writeFile(${JSON.stringify(path.join(globalConfigDir(), "credentials.enc"))}, payload.toString("base64"), { mode: 0o600 });
        app.exit(0);
      }).catch(() => app.exit(1));
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(createRequire(import.meta.url)("electron") as string, [setupEntry], { env, timeout: 8_000 });
    const selection = { tools: "all" as const, skills: "none" as const };
    host = await spawnRuntimeHost(root, { workspaceRoot: root, configDir: globalConfigDir(), clientId: "mcp-observer", surface: "cli" });
    const session = await host.client.startDraft();
    assert.equal((await host.client.mcpReconnect("secured")).connected, true);
    const first = host.client.submitPrompt("First local message", [], undefined, undefined, selection);
    await first.completion;
    await host.client.close();
    await terminateSpawnedHost(host.process, 5_000);
    host = undefined;

    // A fresh Electron owner must reload both authentication and the same session.
    host = await spawnRuntimeHost(root, { workspaceRoot: root, configDir: globalConfigDir(), sessionId: session.sessionId, clientId: "mcp-restarted-observer", surface: "cli" });
    await host.client.focusSession(session.sessionId);
    assert.equal((await host.client.mcpReconnect("secured")).connected, true);
    await host.client.submitPrompt("Continue the local session", [], undefined, undefined, selection).completion;
    const events = await readSessionEvents(session.sessionFile);
    assert.equal(events.filter(event => event.type === "turn_status" && event.status === "completed").length, 2);
    assert.equal(events.filter(event => event.type === "assistant_message" && event.content.includes("local-continued-reply")).length, 2);
    assert.equal(events.filter(event => event.type === "error").length, 0);
    assert.equal(mcpAuthenticated, true);
    assert.ok(!JSON.stringify(events).includes(credential));
    assert.ok(!(await readFile(path.join(globalConfigDir(), "config.json"), "utf8")).includes(credential));
  } finally {
    await host?.client.close();
    if (host) await terminateSpawnedHost(host.process, 5_000);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
