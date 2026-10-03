import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { saveConfigFile } from "../src/config/loader.js";
import { globalConfigDir } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";
import { readSessionEvents } from "../src/session/events.js";
import { BinyTui } from "../src/tui/app.js";

test("cold TUI Host reads Desktop encrypted credentials and persists a reply", {
  skip: process.platform !== "darwin" || !existsSync(fileURLToPath(new URL("../out/main/index.js", import.meta.url))), timeout: 20_000
}, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-tui-cipher-")));
  const fixtureKey = "local-provider-fixture";
  let authenticated = false;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the local provider request. */ }
    authenticated = request.headers.authorization === `Bearer ${fixtureKey}`;
    response.writeHead(authenticated ? 200 : 401, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "credential-reply" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  let host: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
  let app: BinyTui | undefined;
  try {
    await saveConfigFile(globalConfigDir(), {
      ...structuredClone(defaultConfig), defaultModel: "local-test",
      providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: true, retry: { maxAttempts: 1 } } },
      models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "all" },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const setupEntry = path.join(root, "prepare.cjs");
    await writeFile(setupEntry, `
      const { app, safeStorage, BrowserWindow } = require("electron");
      const fs = require("node:fs/promises");
      app.setName("Biny");
      app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        app.setActivationPolicy("prohibited");
        if (!safeStorage.isEncryptionAvailable() || BrowserWindow.getAllWindows().length) throw new Error("Headless cipher unavailable");
        const payload = safeStorage.encryptString(JSON.stringify({ "provider:local:apiKey": ${JSON.stringify(fixtureKey)} }));
        await fs.writeFile(${JSON.stringify(path.join(globalConfigDir(), "credentials.enc"))}, payload.toString("base64"), { mode: 0o600 });
        app.exit(0);
      }).catch(() => app.exit(1));
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(createRequire(import.meta.url)("electron") as string, [setupEntry], { env, timeout: 8_000 });

    // This is the same public election path used by a cold TUI; credentials stay
    // in the owner while the Node client only receives runtime snapshots/events.
    host = await spawnRuntimeHost(root, { workspaceRoot: root, configDir: globalConfigDir(), clientId: "cipher-observer", surface: "cli" });
    const terminal: Terminal = {
      start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
      write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
      moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
      clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
      setTitle: () => undefined, setProgress: () => undefined
    };
    app = new BinyTui(new TUI(terminal), root);
    await app.submit("credential-send-probe");
    assert.notEqual(app.tuiState.sessionId, "", JSON.stringify(app.tuiState.transcript.committed));
    await host.client.focusSession(app.tuiState.sessionId);
    await host.client.waitForIdle(app.tuiState.sessionId);
    const events = await readSessionEvents(app.tuiState.sessionFile);
    assert.ok(authenticated, "Desktop-only credential must reach the local provider through the owner");
    assert.ok(events.some(event => event.type === "user_message" && event.content === "credential-send-probe"));
    assert.ok(events.some(event => event.type === "assistant_message" && event.content.includes("credential-reply")));
    assert.ok(events.some(event => event.type === "turn_status" && event.status === "completed"));
    assert.ok(!JSON.stringify(events).includes(fixtureKey), "Credential must not enter session events");
    assert.deepEqual(app.tuiState.transcript.committed.filter(item => item.kind === "error"), []);
  } finally {
    await app?.exit();
    await host?.client.close();
    if (host) await terminateSpawnedHost(host.process, 5_000);
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
