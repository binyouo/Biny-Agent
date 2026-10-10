import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as configBoundary from "../src/config/loader.js";
import * as hostBoundary from "../src/runtime/RuntimeHost.js";
import { fixtureCleanup } from "./helpers/fixture-cleanup.js";

const workerFlag = "--fixture-cleanup-worker";
const modes = ["config", "start", "connect", "body", "body-and-close"] as const;
type Mode = typeof modes[number];

async function setupWorker(mode: Mode, receipt: string): Promise<void> {
  const original = Object.assign(new Error(`Synthetic fixture ${mode} failure`), { code: "FIXTURE_INITIALIZATION_FAILURE" });
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const counts = { provider: 0, connections: 0, host: 0, client: 0, socketCalls: 0 };
  const events: string[] = [];
  let root = "";
  let providerHandle: ReturnType<typeof setInterval> | undefined;
  let hostHandle: ReturnType<typeof setInterval> | undefined;
  let clientHandle: ReturnType<typeof setInterval> | undefined;
  // A referenced timer models the provider's open handle without binding any socket.
  mock.method(http, "createServer", () => ({
    listen: (_port: number, _address: string, ready: () => void) => {
      events.push("provider-open");
      providerHandle = setInterval(() => {}, 1_000);
      queueMicrotask(ready);
    },
    address: () => ({ port: 12345 }),
    closeAllConnections: () => { counts.connections += 1; },
    close: (closed: () => void) => {
      counts.provider += 1; events.push("provider-close");
      clearInterval(providerHandle); closed();
    }
  }) as unknown as http.Server);
  // The test must stay socket-free, even if a mocked import stops matching.
  mock.method(net.Server.prototype, "listen", () => { counts.socketCalls += 1; throw new Error("Unexpected socket listener"); });
  mock.module("../src/config/loader.js", { namedExports: {
    ...configBoundary,
    saveConfig: async (...args: Parameters<typeof configBoundary.saveConfig>) => {
      root = args[0];
      if (mode === "config") throw original;
      await configBoundary.saveConfig(...args);
    }
  } });
  mock.module("../src/runtime/RuntimeHost.js", { namedExports: {
    ...hostBoundary,
    startRuntimeHost: async () => {
      if (mode === "start") throw original;
      events.push("host-open"); hostHandle = setInterval(() => {}, 1_000);
      return { close: async () => {
        counts.host += 1; events.push("host-close"); clearInterval(hostHandle);
        if (mode === "body-and-close") throw new Error("Synthetic cleanup failure");
      } };
    },
    connectRuntimeHost: async () => {
      if (mode === "connect") throw original;
      events.push("client-open"); clientHandle = setInterval(() => {}, 1_000);
      return {
        getSnapshot: () => { throw original; },
        close: async () => { counts.client += 1; events.push("client-close"); clearInterval(clientHandle); }
      };
    }
  } });
  process.once("beforeExit", () => {
    writeFileSync(receipt, JSON.stringify({ counts, events, rootRemoved: !!root && !existsSync(root),
      environmentRestored: process.env.BINY_AGENT_DIR === previousAgentDir,
      expectedError: { message: original.message, code: original.code } }));
  });
}

if (process.argv[2] === workerFlag) {
  await setupWorker(process.argv[4] as Mode, process.argv[5]!);
  await import(`./${process.argv[3]!}.test.js`);
} else {
  test("fixture cleanup is LIFO and explicit disposal is once-only", async () => {
    let after!: () => Promise<void>;
    const events: string[] = [];
    const cleanup = fixtureCleanup({ after: (fn) => { after = fn as () => Promise<void>; } });
    cleanup(() => { events.push("root"); });
    cleanup(() => { events.push("provider"); });
    const closeClient = cleanup(() => { events.push("old-client"); });
    await closeClient();
    cleanup(() => { events.push("new-client"); });
    await after();
    await closeClient();
    assert.deepEqual(events, ["old-client", "new-client", "provider", "root"]);
  });

  test("fixture cleanup continues after a disposer fails and retains that exact error", async () => {
    let after!: () => Promise<void>;
    const cleanup = fixtureCleanup({ after: (fn) => { after = fn as () => Promise<void>; } });
    const error = new Error("Synthetic teardown failure");
    let closes = 0;
    cleanup(() => { closes += 1; });
    const failedClose = cleanup(() => { closes += 1; throw error; });
    await assert.rejects(after(), (actual: unknown) => actual instanceof AggregateError && actual.errors[0] === error);
    await failedClose();
    assert.equal(closes, 2);
  });

  for (const suite of ["subagent-communication-e2e", "subagent-foreground-communication"]) {
    for (const mode of modes) {
      test(`${suite} releases setup resources and preserves ${mode} failure`, { timeout: 12_000 }, async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-fixture-cleanup-proof-"));
        try {
          const receipt = path.join(temporary, "receipt.json");
          const env: NodeJS.ProcessEnv = { ...process.env, BINY_AGENT_DIR: path.join(temporary, "agent") };
          delete env.NODE_TEST_CONTEXT;
          await assert.rejects(promisify(execFile)(process.execPath, [
            "--experimental-test-module-mocks", "--test-reporter=tap", ...process.execArgv,
            fileURLToPath(import.meta.url), workerFlag, suite, mode, receipt
          ], { env, timeout: 8_000, killSignal: "SIGKILL" }), (failure: unknown) => {
            const result = failure as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string };
            assert.equal(result.code, 1, "the fixture must fail normally rather than reach the child deadline");
            assert.equal(result.killed, false);
            assert.match(result.stdout ?? "", new RegExp(`Synthetic fixture ${mode} failure`));
            assert.match(result.stdout ?? "", /FIXTURE_INITIALIZATION_FAILURE/);
            assert.doesNotMatch(result.stdout ?? "", /testTimeoutFailure|cancelledByParent/);
            return true;
          });
          const result = JSON.parse(await readFile(receipt, "utf8"));
          assert.deepEqual(result.counts, { provider: 1, connections: 1,
            host: ["connect", "body", "body-and-close"].includes(mode) ? 1 : 0,
            client: mode.startsWith("body") ? 1 : 0, socketCalls: 0 });
          assert.equal(result.rootRemoved, true);
          assert.equal(result.environmentRestored, true);
          assert.deepEqual(result.events, ["provider-open",
            ...(["connect", "body", "body-and-close"].includes(mode) ? ["host-open"] : []),
            ...(mode.startsWith("body") ? ["client-open", "client-close"] : []),
            ...(["connect", "body", "body-and-close"].includes(mode) ? ["host-close"] : []), "provider-close"]);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      });
    }
  }
}
