import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Socket, Server } from "node:net";
import type { TestContext } from "node:test";
import type { CommandRuntime } from "../../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime, type AgentRunOutcome } from "../../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent, AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../../src/runtime/agentEvents.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../../src/runtime/host/lifecycle.js";
import { RuntimeHostServer } from "../../src/runtime/host/server.js";
import { BoundedHostSocketWriter, runtimeHostMaxBufferedSocketBytes } from "../../src/runtime/host/socket-writer.js";
import { encodeHostFrame, runtimeHostMaxFrameBytes, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../../src/runtime/host/protocol.js";
import type { HostRegistration } from "../../src/runtime/host/types.js";

// This fixture is imported only by normal-CI tests. No models, shell subprocesses,
// schedulers, maintenance, package installers or everyday data roots are used.
export const replaySessionId = "aggregate-replay-session";
export const replayTimestamp = "2026-10-14T00:00:00.000Z";
export const replayPayloadBytes = 1024 * 1024;

export interface ReplayResult {
  replayed: boolean;
  sequence: number;
  hostEpoch: string;
  snapshot: InteractiveRuntimeSnapshot;
}
export interface ReplayConnection {
  socket: Socket;
  writer: BoundedHostSocketWriter;
  authenticated: boolean;
  subscribed: boolean;
  sessionFilter?: ReadonlySet<string>;
  clientId: string;
  surface: "cli";
  keepAlive: boolean;
  negotiatedCapabilities: readonly string[];
}
export interface ReplayInternals {
  server: Server;
  history: Array<{ sequence: number; update: AgentRuntimeUpdate }>;
  connections: Set<ReplayConnection>;
  pendingRequests: number;
  publish(update: AgentRuntimeUpdate): void;
  broadcastCompletion(runId: string, outcome: AgentRunOutcome): void;
  handleFrame(connection: ReplayConnection, frame: HostRequestFrame): Promise<void>;
  execute(connection: ReplayConnection, frame: HostRequestFrame): Promise<unknown>;
  subscribeConnection(connection: ReplayConnection, afterSequence: number | undefined,
    afterHostEpoch: string | undefined, sessionFilter: ReadonlySet<string> | undefined): ReplayResult | Promise<ReplayResult>;
}

export function bashReplayEvents(count = 32): AgentHostEvent[] {
  return Array.from({ length: count }, (_, index): AgentHostEvent => {
    const prefix = `bash-output-${String(index).padStart(2, "0")}:`;
    const stdout = prefix + String.fromCharCode(65 + index % 26).repeat(replayPayloadBytes - prefix.length);
    return { type: "tool.completed", tool: "Bash", toolCallId: `bash-${String(index).padStart(2, "0")}`,
      sessionId: replaySessionId, runId: "aggregate-replay-run", timestamp: replayTimestamp,
      result: { background: false, status: "completed", sandbox: "off", stdout, stderr: "",
        stdoutBytes: replayPayloadBytes, stdoutRetainedBytes: replayPayloadBytes,
        stdoutCaptureOmittedBytes: 0, stdoutTruncated: false, stderrBytes: 0, stderrRetainedBytes: 0,
        stderrCaptureOmittedBytes: 0, stderrTruncated: false, exitCode: 0 },
      executionStatus: "succeeded", durationMs: index + 1 };
  });
}
export function terminalReplayEvent(runId = "aggregate-replay-run", sessionId = replaySessionId): AgentHostEvent {
  return { type: "run.completed", sessionId, runId, timestamp: replayTimestamp,
    durationMs: 32, notification: `Completed ${runId}` };
}
export function assertExactEvents(actual: AgentHostEvent[], expected: AgentHostEvent[]): void {
  assert.equal(actual.length, expected.length, "all retained events must be delivered exactly once");
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(JSON.stringify(actual[index]), JSON.stringify(expected[index]),
      `raw event ${index} must retain its exact ID, output bytes and metadata`);
  }
}
export function assertLegalAggregate(frames: HostFrame[], large: boolean): void {
  const sizes = frames.map((frame) => Buffer.byteLength(encodeHostFrame(frame)));
  assert.ok(sizes.every((size) => size < runtimeHostMaxFrameBytes), "every replay frame is individually legal");
  assert.equal(runtimeHostMaxFrameBytes, 8 * 1024 * 1024);
  assert.equal(runtimeHostMaxBufferedSocketBytes, 16 * 1024 * 1024, "the product buffer cap must not be raised");
  if (large) assert.ok(sizes.reduce((sum, size) => sum + size, 0) > runtimeHostMaxBufferedSocketBytes);
}

export async function createReplayFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-replay-flow-")));
  const priorAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const configDir = path.join(root, "config");
  const paths = runtimeHostPaths(root);
  const registration: HostRegistration = {
    ...paths, ...currentRuntimeHostIdentity({ configDir }), protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, hostEpoch: randomUUID(), token: "synthetic-aggregate-replay-token",
    pid: process.pid, createdAt: replayTimestamp
  };
  const servers: RuntimeHostServer[] = [];
  let closePromise: Promise<void> | undefined;
  const fixture = { root, configDir, registration,
    async start(listen = false) {
      const commands = { agent: {
        getInfo: () => ({ sessionId: replaySessionId, sessionFile: path.join(root, "session.jsonl"), workspaceRoot: root,
          provider: "test", modelAlias: "test", modelLabel: "Test", reasoningLabel: "Off", thinking: "off", skills: [] }),
        getPermissionMode: () => "ask",
        getPersonalizationState: async () => ({ memory: { enabled: false, sleepEnabled: false } }),
        memoryEmbeddingStatus: async () => ({ activeModel: undefined, needsRebuild: false, pendingEntries: 0 })
      }, close: async () => undefined } as unknown as CommandRuntime;
      const runtime = new InteractiveAgentRuntime(commands);
      const server = new RuntimeHostServer(runtime, commands, registration, { close: async () => undefined });
      servers.push(server);
      // Deterministic transport tests need no journal I/O; the Unix test initializes
      // the actual journal and Host exactly as the Bash event-budget integration does.
      if (listen) {
        await server.initialize();
        await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
        await server.listen();
        await writeFile(paths.registrationPath, JSON.stringify(registration), { mode: 0o600 });
      }
      const internals = server as unknown as ReplayInternals;
      return { runtime, server, internals,
        emit(event: AgentHostEvent) { (runtime as unknown as { emit(event: AgentHostEvent): void }).emit(event); },
        frames(): HostFrame[] {
          return internals.history.map(({ sequence, update }) => ({ kind: "event", hostEpoch: registration.hostEpoch, sequence, update }));
        }
      };
    },
    async close() {
      closePromise ??= (async () => {
        try { await Promise.all(servers.map(async (server) => await server.close())); }
        finally {
          if (priorAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
          else process.env.BINY_AGENT_DIR = priorAgentDir;
          await rm(paths.registrationPath, { force: true });
          await rm(root, { recursive: true, force: true });
        }
      })();
      await closePromise;
    }
  };
  // Register before start() or any assertion so setup failures restore isolation.
  t.after(async () => await fixture.close());
  return fixture;
}
