import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import {
  connectOrSpawnRuntimeHost,
  connectOrSpawnRuntimeHostWithOwnership,
  connectRuntimeHost,
  spawnRuntimeHost
} from "../src/runtime/host/connection.js";
import {
  currentRuntimeHostIdentity,
  ensureRuntimeHostDirectory,
  runtimeHostPaths
} from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import type { HostRegistration } from "../src/runtime/host/types.js";

// Exercise the public discovery/delegation paths without opening sockets or launching a Host.
// Actual hello/subscribe deadlines are covered by runtime-host-handshake-timeout.test.ts.
for (const route of ["connect", "attach", "client-only", "spawn", "spawn-race"] as const) {
  for (const handshakeTimeoutMs of [undefined, 0, 137]) {
    test(`${route} preserves handshakeTimeoutMs=${String(handshakeTimeoutMs)}`, async (context) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-options-"));
      const paths = runtimeHostPaths(root);
      await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
      const configDir = path.join(root, "config");
      const registration: HostRegistration = {
        ...paths,
        ...currentRuntimeHostIdentity({ configDir }),
        protocolVersion: runtimeHostProtocolVersion,
        persistenceRoot: root,
        hostEpoch: randomUUID(),
        token: "synthetic-connection-options-token",
        pid: process.pid,
        createdAt: new Date().toISOString()
      };
      const publishRegistration = (): void => {
        writeFileSync(paths.registrationPath, `${JSON.stringify(registration)}\n`, { mode: 0o600 });
      };
      if (route !== "spawn" && route !== "spawn-race") publishRegistration();
      const connected = {} as RuntimeHostClient;
      const connections: Array<Parameters<typeof RuntimeHostClient.connect>[0]> = [];
      const connect = context.mock.method(RuntimeHostClient, "connect", async (options: Parameters<typeof RuntimeHostClient.connect>[0]) => {
        connections.push(options);
        return connected;
      });
      const spawned = new childProcess.ChildProcess();
      const spawn = context.mock.method(childProcess, "spawn", () => {
        publishRegistration();
        if (route === "spawn-race") throw new Error("Synthetic candidate lost the startup race");
        return spawned;
      });
      syncBuiltinESMExports();
      try {
        const options = { workspaceRoot: root, configDir, handshakeTimeoutMs };
        if (route === "connect") {
          assert.equal(await connectRuntimeHost(root, options), connected);
        } else if (route === "client-only") {
          assert.equal(await connectOrSpawnRuntimeHost(root, options), connected);
        } else if (route === "spawn") {
          const result = await spawnRuntimeHost(root, options);
          assert.equal(result.client, connected);
          assert.equal(result.process, spawned);
        } else {
          const result = await connectOrSpawnRuntimeHostWithOwnership(root, options);
          assert.equal(result?.client, connected);
          assert.equal(result?.spawnedProcess, undefined);
        }
        assert.equal(connections.length, 1);
        assert.equal(connections[0]!.handshakeTimeoutMs, handshakeTimeoutMs,
          "Public wrappers must preserve the caller's timeout, including zero and the default");
        assert.equal(spawn.mock.callCount(), route === "spawn" || route === "spawn-race" ? 1 : 0);
      } finally {
        connect.mock.restore();
        spawn.mock.restore();
        syncBuiltinESMExports();
        await rm(paths.registrationPath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
