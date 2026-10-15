import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfigFile } from "../src/config/loader.js";
import { spawnRuntimeHost, type RuntimeHostClient } from "../src/runtime/RuntimeHost.js";
import { terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";

for (const closeReader of [false, true]) {
  test(`detached Host indexes a completed turn with stderr reader ${closeReader ? "closed" : "open"}`, { timeout: 25_000, concurrency: false }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-stderr-")));
    const agentDir = path.join(root, "agent");
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = agentDir;
    const marker = "stderr-worker-probe";
    const answer = "stderr-worker-indexed-answer";
    let response: ServerResponse | undefined;
    const provider = createServer(async (request, reply) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (body.includes(marker) && response === undefined) {
        response = reply;
        return;
      }
      reply.writeHead(200, { "content-type": "text/event-stream" });
      reply.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "[]" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    let child: ChildProcess | undefined;
    let client: RuntimeHostClient | undefined;
    const index = new SessionSearchIndex(agentDir);
    const failurePath = path.join(root, "host-uncaught.json");
    let stderr = "";
    let stopped = false;
    let testFailed = false;
    const cleanupErrors: unknown[] = [];
    let phase = "setup";
    try {
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      assert.ok(address && typeof address !== "string");
      await saveConfigFile(agentDir, {
        ...structuredClone(defaultConfig),
        defaultModel: "local-test",
        providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
        models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
        chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "all" },
        thinking: { ...defaultConfig.thinking, enabled: false },
        heartbeat: { ...defaultConfig.heartbeat, enabled: false },
        crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
        context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
      });
      // Observe fatal errors without handling them or changing Node's exit behavior.
      await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
      const entryPath = path.join(root, "host-entry.ts");
      const hostModule = pathToFileURL(path.resolve("src/runtime/hostProcess.ts")).href;
      await writeFile(entryPath, [
        'import { writeFileSync } from "node:fs";',
        `import { runRuntimeHostProcess } from ${JSON.stringify(hostModule)};`,
        'process.on("uncaughtExceptionMonitor", (error: NodeJS.ErrnoException) => {',
        '  try {',
        `    writeFileSync(${JSON.stringify(failurePath)}, JSON.stringify({ name: error.name, code: error.code, syscall: error.syscall }));`,
        '  } catch { /* Keep the original fatal error. */ }',
        '});',
        'await runRuntimeHostProcess(process.argv.slice(2));',
        ""
      ].join("\n"));
      phase = "start real detached Host";
      const spawned = await spawnRuntimeHost(root, {
        workspaceRoot: root, configDir: agentDir, entryPath,
        clientId: "stderr-observer", surface: "cli"
      });
      child = spawned.process;
      client = spawned.client;
      assert.ok(child.pid && child.pid !== process.pid);
      assert.ok(child.stderr);
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const epoch = client.hostInfo?.hostEpoch;
      assert.ok(epoch);
      const exited = new Promise<never>((_resolve, reject) => {
        child!.once("exit", (code, signal) => reject(new Error(`Host exited: code=${String(code)}, signal=${String(signal)}`)));
      });
      void exited.catch(() => undefined);
      const bounded = async <T>(work: Promise<T>, label: string, allowExit = false): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([work, ...(allowExit ? [] : [exited]), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
          })]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const waitFor = async (condition: () => boolean): Promise<void> => {
        while (!condition()) {
          if (stopped) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      };
      if (closeReader) {
        phase = "close real stderr read end";
        const closed = once(child.stderr, "close");
        child.stderr.destroy();
        await bounded(closed, phase);
        assert.equal(child.stderr.closed, true);
      }
      // IPC stays connected, so only stderr lifetime changes in this regression.
      assert.equal(child.connected, true);
      phase = "submit completed turn through Host";
      const admitted = await bounded(client.submitRun(marker), phase);
      assert.equal(admitted.accepted, true);
      await bounded(waitFor(() => response !== undefined), "provider request");
      response!.writeHead(200, { "content-type": "text/event-stream" });
      response!.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      phase = "wait for real search Worker index";
      // This reader never indexes. A durable hit must come from the Host's
      // completed-turn path and real SessionSearchWorker.
      await bounded(waitFor(() => index.search(answer).some(hit => hit.role === "assistant")), phase);
      phase = "query same live Host after indexing";
      const sessions = await bounded(client.listRuntimeSessions(), phase);
      assert.ok(sessions.length > 0);
      assert.equal(client.hostInfo?.hostEpoch, epoch);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      if (!closeReader) {
        await bounded(waitFor(() => /SQLite is an experimental feature/u.test(stderr)), "worker stderr reaches open reader");
        assert.match(stderr, /SQLite is an experimental feature/u);
      }
      phase = "normal Host shutdown after indexing";
      const normalExit = once(child, "exit");
      assert.equal(child.kill("SIGTERM"), true);
      const [code, signal] = await bounded(normalExit, phase, true);
      assert.equal(code, 0);
      assert.equal(signal, null);
    } catch (error) {
      testFailed = true;
      try {
        const uncaught = await readFile(failurePath, "utf8").catch(() => "unavailable");
        console.error({ phase, hostPid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode, uncaught });
      } catch { /* Diagnostics must not replace the regression failure. */ }
      throw error;
    } finally {
      stopped = true;
      const cleanup = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action(); } catch (error) { cleanupErrors.push(error); }
      };
      await cleanup(async () => client?.close());
      await cleanup(async () => { if (child) await terminateSpawnedHost(child, 5_000); });
      await cleanup(async () => index.close());
      await cleanup(async () => {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      });
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await cleanup(async () => rm(root, { recursive: true, force: true }));
      if (testFailed && cleanupErrors.length) {
        try { console.error("Host stderr regression cleanup errors:", cleanupErrors); } catch { /* Keep original failure. */ }
      }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Host stderr regression cleanup failed");
  });
}
