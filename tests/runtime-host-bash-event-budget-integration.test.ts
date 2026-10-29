import { readyHostClient } from "./helpers/readyHostClient.js";
import { createHostTestStores } from "./helpers/hostStores.js";
import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Socket } from "node:net";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent, AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostJournalFile, runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import type { HostRegistration } from "../src/runtime/host/types.js";
import { agentDir } from "../src/session/store.js";

// CI-only integration. The normal test suite may run real Host/socket/journal
// behavior here. Local isolated validation never imports or executes this file.
// Results are synthetic; no shell, model, embedding or background scheduler runs.
test("real Host delivers large Bash terminal events live and from an unchanged raw journal", { timeout: 20_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-bash-wire-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const configDir = path.join(root, "config");
  const paths = runtimeHostPaths(root);
  const sessionId = "bash-wire-session";
  const registration: HostRegistration = {
    ...paths, ...currentRuntimeHostIdentity({ configDir }),
    protocolVersion: runtimeHostProtocolVersion, persistenceRoot: root,
    hostEpoch: randomUUID(), token: "synthetic-bash-wire-fixture-token", pid: process.pid,
    createdAt: "2026-10-12T00:00:00.000Z"
  };
  const clients: RuntimeHostClient[] = [];
  let server: RuntimeHostServer | undefined;
  const createServer = async () => {
    const commands = {
      ...await createHostTestStores(root),
      agent: {
        getInfo: () => ({ sessionId, sessionFile: path.join(root, "session.jsonl"), workspaceRoot: root,
          provider: "test", modelAlias: "test", modelLabel: "Test", reasoningLabel: "Off", thinking: "off", skills: [] }),
        getPermissionMode: () => "ask",
        getPersonalizationState: async () => ({ memory: { enabled: false, sleepEnabled: false } }),
        memoryEmbeddingStatus: async () => ({ activeModel: undefined, needsRebuild: false, pendingEntries: 0 })
      },
      close: async () => undefined
    } as unknown as CommandRuntime;
    const runtime = new InteractiveAgentRuntime(commands);
    server = new RuntimeHostServer(runtime, commands, registration, { close: async () => undefined }, async () => { throw new Error("Unexpected session runtime creation in this fixture."); });
    // Do not start schedulers/maintenance. This fixture only needs the Host kernel.
    await server.initialize();
    await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
    await server.listen();
    await writeFile(paths.registrationPath, JSON.stringify(registration), { mode: 0o600 });
    return runtime;
  };
  const connect = async () => {
    const client = await readyHostClient(await RuntimeHostClient.connect({ registration, configDir, handshakeTimeoutMs: 5_000 }));

    clients.push(client);
    return client;
  };
  const rawResult = (stdout: string, failed = false) => ({
    background: false, status: failed ? "failed" : "completed", sandbox: "off",
    stdout, stderr: "", stdoutBytes: Buffer.byteLength(stdout), stdoutRetainedBytes: Buffer.byteLength(stdout),
    stdoutCaptureOmittedBytes: 0, stdoutTruncated: false, stderrBytes: 0, stderrRetainedBytes: 0,
    stderrCaptureOmittedBytes: 0, stderrTruncated: false, exitCode: failed ? 2 : 0,
    ...(failed ? { error: "Command exited with code 2." } : {})
  });
  const rawEvents: AgentHostEvent[] = [
    { type: "tool.completed", tool: "Bash", toolCallId: "large", sessionId, runId: "run", timestamp: registration.createdAt,
      result: rawResult("x".repeat(8 * 1024 * 1024)), executionStatus: "succeeded", durationMs: 17 },
    { type: "tool.failed", tool: "Bash", toolCallId: "escaped", sessionId, runId: "run", timestamp: registration.createdAt,
      result: rawResult("\0".repeat(2 * 1024 * 1024), true), error: "Command exited with code 2.", executionStatus: "failed", durationMs: 18 }
  ];
  function assertResults(updates: AgentRuntimeUpdate[]): void {
    const results = updates.flatMap((update) => update.event?.type === "tool.completed" || update.event?.type === "tool.failed" ? [update.event] : []);
    assert.equal(results.length, 2);
    for (const event of results) {
      const value = event.result as Record<string, unknown>;
      assert.equal(value.transportProjection, "shell_excerpt");
      assert.equal(typeof value.stdout, "string");
      assert.match(String(value.stdout), /UTF-8 bytes omitted/u);
      assert.equal(value.stdoutCaptureTruncated, false);
      assert.equal(value.stdoutCaptureOmittedBytes, 0);
      assert.equal(value.archivePath, undefined, "transport must not invent an archive");
      assert.ok(Buffer.byteLength(String(value.stdout ?? "")) + Buffer.byteLength(String(value.stderr ?? "")) <= 12 * 1024);
    }
    assert.equal((results[1]!.result as Record<string, unknown>).exitCode, 2);
    assert.equal(results[1]!.executionStatus, "failed");
  }
  try {
    const runtime = await createServer();
    const client = await connect();
    const initialSocket = (client as unknown as { socket: Socket }).socket;
    const updates: AgentRuntimeUpdate[] = [];
    client.subscribe((update) => updates.push(update));
    for (const event of rawEvents) (runtime as unknown as { emit(event: AgentHostEvent): void }).emit(event);
    // This response follows the emitted frames on the same ordered connection.
    assert.equal((await client.listRuntimeSessions())[0]?.sessionId, sessionId);
    assertResults(updates);
    assert.equal(initialSocket.destroyed, false);
    assert.equal((client as unknown as { socket: Socket }).socket, initialSocket);
    await client.close();
    await server!.close();
    server = undefined;
    const journalPath = path.join(agentDir(root), "runs", runtimeHostJournalFile);
    const journalBefore = await readFile(journalPath, "utf8");
    const retained = journalBefore.trim().split("\n").map((line) => JSON.parse(line) as { update: AgentRuntimeUpdate });
    const retainedEvents = retained.flatMap((entry) => entry.update.event ? [entry.update.event] : []);
    assert.deepEqual(retainedEvents, rawEvents, "journal must keep complete original stream/capture facts");

    // Restart reads raw rows written before projection, just as an older Host's
    // journal would. Fixing only publication would leave this handshake poisoned.
    await createServer();
    const reconnected = await connect();
    const replayed: AgentRuntimeUpdate[] = [];
    reconnected.subscribe((update) => replayed.push(update));
    assertResults(replayed);
    assert.equal((await reconnected.listRuntimeSessions())[0]?.sessionId, sessionId);
    assert.equal(await readFile(journalPath, "utf8"), journalBefore, "replay projection must not rewrite durable events");
  } finally {
    await Promise.all(clients.map(async (client) => await client.close()));
    await server?.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(paths.registrationPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
